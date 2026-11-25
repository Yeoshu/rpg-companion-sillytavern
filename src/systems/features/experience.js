/**
 * Experience
 *
 * Grants EXP (from quests and encounters) and resolves level-ups. Each level
 * raises the character point budget; points are spent on the character sheet
 * (features/sheet.js, ui/sheetEditor.js).
 * All numbers come from src/systems/mechanics/progression.js; nothing here
 * asks the model for anything.
 *
 * Level and EXP are saved per chat (see persistence.js).
 * Anything that changes them triggers `rpg:progressionChanged` on document.
 */

import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../../../../popup.js';
import { getCombatSettings, sheetPoints } from './sheet.js';
import { allStepsDone, diffQuests, normalizeQuest, normalizeQuests } from '../mechanics/quests.js';
import { getContext } from '../../../../../../extensions.js';
import { extensionSettings } from '../../core/state.js';
import { saveSettings, saveChatData } from '../../core/persistence.js';
import { i18n } from '../../core/i18n.js';
import {
    normalizeProgression, expToNextLevel, addExp, questReward, enemyReward
} from '../mechanics/progression.js';

function t(key, fallback) {
    return i18n.getTranslation(key) || fallback;
}

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

export function getProgression() {
    return normalizeProgression(extensionSettings.progression);
}

/** Current level, EXP, bar size and unspent character points (may be negative: over budget). */
export function getProgressState() {
    const level = Math.max(1, Math.floor(extensionSettings.level) || 1);
    return {
        level,
        exp: Math.max(0, Math.floor(extensionSettings.exp) || 0),
        next: expToNextLevel(level, getProgression()),
        points: sheetPoints().unspent
    };
}

function changed() {
    saveSettings();
    saveChatData();
    $(document).trigger('rpg:progressionChanged');
}

/**
 * Adds EXP, levelling up as many times as it covers.
 * @param {number} amount
 * @param {string} [source] - shown in the notification
 */
export function grantExp(amount, source = '') {
    amount = Math.max(0, Math.floor(Number(amount) || 0));
    if (!amount) return null;

    const before = getProgressState();
    const result = addExp(before, amount, getProgression());
    extensionSettings.level = result.level;
    extensionSettings.exp = result.exp;
    changed();

    toastr.success(source ? escapeHtml(source) : '', `+${amount} ${t('progression.exp', 'EXP')}`, { timeOut: 4000 });
    if (result.levelsGained) {
        const pointsText = result.pointsGained
            ? t('progression.pointsGained', '+{points} character points to spend').replace('{points}', result.pointsGained)
            : '';
        toastr.success(pointsText, `⬆ ${t('progression.levelUp', 'Level {level}!').replace('{level}', result.level)}`, { timeOut: 8000 });
    }
    return result;
}

/** Sets EXP directly (manual edit). Levels up if it reaches the bar. */
export function setExp(value) {
    const state = getProgressState();
    const target = Math.max(0, Math.floor(Number(value) || 0));
    if (target >= state.next) {
        extensionSettings.exp = 0;
        grantExp(target, '');
        return;
    }
    extensionSettings.exp = target;
    changed();
}

/* ---------------------------------------------------------------------------
   Sources
   --------------------------------------------------------------------------- */

/**
 * Awards EXP for a completed quest.
 * @param {'main'|'side'} kind
 * @param {string} title
 */
export function completeQuest(kind, title) {
    markQuestResolved(title, 'completed');
    const amount = questReward(kind, getProgressState().level, getProgression());
    const label = kind === 'main' ? t('progression.mainQuestDone', 'Main quest complete') : t('progression.sideQuestDone', 'Side quest complete');
    return grantExp(amount, title ? `${label}: ${title}` : label);
}

/**
 * Works out EXP for the enemies of a finished encounter.
 * Enemies count as defeated when their HP is 0 or below; on a victory every
 * enemy counts (they were beaten even if they surrendered or ran).
 * @param {object[]} enemies - combat enemies ({name, hp, level, tier})
 * @param {string} result - 'victory' | 'defeat' | 'fled' | 'interrupted'
 * @returns {{ total: number, enemies: {name: string, level: number, exp: number}[] }}
 */
export function encounterRewards(enemies, result) {
    const playerLevel = getProgressState().level;
    const settings = getProgression();
    const beaten = (enemies || []).filter(enemy => enemy && (result === 'victory' || Number(enemy.hp) <= 0));
    const rows = beaten.map(enemy => {
        const level = Math.max(1, Math.round(Number(enemy.level)) || playerLevel);
        // Tougher tiers are worth more (minion ×0.5 … boss ×2, the tier's HP multiplier).
        const tiers = getCombatSettings().tiers;
        const tier = tiers[enemy.tier] || tiers.standard;
        return { name: String(enemy.name || '?'), level, tier: enemy.tier || 'standard', exp: Math.max(1, Math.round(enemyReward(level, playerLevel, settings) * tier.hp)) };
    });
    return { total: rows.reduce((sum, row) => sum + row.exp, 0), enemies: rows };
}

/* ---------------------------------------------------------------------------
   Quests dropped by the tracker AI
   --------------------------------------------------------------------------- */

const MAX_RESOLVED = 200;
const MAX_HISTORY = 50;

function questKey(title) {
    return String(title || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Plain name of a quest in any stored shape. */
export function questName(quest) {
    return normalizeQuest(quest)?.name || '';
}

/**
 * Remembers (per chat) that a quest has been dealt with, so the same quest
 * isn't asked about again on swipes or regenerations. With an outcome
 * ('completed' / 'abandoned') it's also listed in the tracker prompt for a
 * while, so the AI doesn't create it again.
 */
export function markQuestResolved(title, outcome = null) {
    const key = questKey(title);
    if (!key) return;
    const list = Array.isArray(extensionSettings.resolvedQuests) ? extensionSettings.resolvedQuests : [];
    if (!list.includes(key)) list.push(key);
    extensionSettings.resolvedQuests = list.slice(-MAX_RESOLVED);
    if (outcome) recordQuestOutcome(title, outcome);
}

/** Adds (or updates) a finished quest in this chat's quest history. */
export function recordQuestOutcome(title, outcome) {
    const name = String(title || '').trim();
    if (!name) return;
    const history = (Array.isArray(extensionSettings.questHistory) ? extensionSettings.questHistory : [])
        .filter(h => questKey(h.name) !== questKey(name));
    let at = 0;
    try {
        at = getContext()?.chat?.length || 0;
    } catch { /* no chat */ }
    history.push({ name, outcome, at });
    extensionSettings.questHistory = history.slice(-MAX_HISTORY);
}

function isQuestResolved(title) {
    return Array.isArray(extensionSettings.resolvedQuests) && extensionSettings.resolvedQuests.includes(questKey(title));
}

/** The current quests (normalized copies), for comparing before/after an update. */
export function snapshotQuests() {
    return JSON.parse(JSON.stringify(normalizeQuests(extensionSettings.quests)));
}

/**
 * Quests present in `before` but missing (by name) from `after`, skipping any
 * already completed, removed or answered in this chat.
 * @returns {{ title: string, kind: 'main'|'side', quest: object, likelyDone: boolean }[]}
 */
export function findDroppedQuests(before, after) {
    const seen = new Set();
    return diffQuests(before, after).dropped
        .filter(({ quest }) => {
            const key = questKey(quest.name);
            if (seen.has(key) || isQuestResolved(quest.name)) return false;
            seen.add(key);
            return true;
        })
        .map(({ kind, quest }) => ({ title: quest.name, kind, quest, likelyDone: allStepsDone(quest) }));
}

/**
 * Call after a new tracker update has been applied, with the quests from
 * before it. Quests the AI marked completed, and quests it dropped, are
 * offered in one dialog (completed ones pre-ticked) and EXP is awarded for
 * the ticked ones. Doesn't block the caller.
 */
export function reviewDroppedQuests(before) {
    const justCompleted = (extensionSettings.questsJustCompleted || []).map(({ kind, quest }) => ({ title: quest.name, kind, quest, likelyDone: true, markedDone: true }));
    extensionSettings.questsJustCompleted = [];
    if (!extensionSettings.enabled || !before) return;
    const ask = extensionSettings.askAboutDroppedQuests !== false;
    const dropped = [
        ...justCompleted.filter(q => !isQuestResolved(q.title)),
        ...findDroppedQuests(before, snapshotQuests()).filter(q => !justCompleted.some(c => questKey(c.title) === questKey(q.title)))
    ];
    if (!dropped.length) return;
    // Mark first so an overlapping update (swipe, regenerate) doesn't ask twice.
    dropped.forEach(quest => markQuestResolved(quest.title, quest.markedDone ? 'completed' : 'abandoned'));
    saveChatData();
    if (!ask) {
        // Not asking: quests the AI marked completed still count as completed.
        dropped.filter(q => q.markedDone).forEach(q => completeQuest(q.kind, q.title));
        return;
    }
    setTimeout(() => askAboutDroppedQuests(dropped).catch(error => {
        console.error('[RPG Companion] Quest review failed:', error);
    }), 0);
}

async function askAboutDroppedQuests(dropped) {
    const settings = getProgression();
    const range = (kind) => kind === 'main'
        ? `${settings.mainQuestMin}–${settings.mainQuestMax}%`
        : `${settings.sideQuestMin}–${settings.sideQuestMax}%`;

    const $dialog = $(`
        <div class="rpg-quest-review">
            <h3><i class="fa-solid fa-scroll"></i> ${escapeHtml(t('progression.droppedTitle', 'Quests removed by the tracker'))}</h3>
            <p>${escapeHtml(t('progression.droppedQuestion', 'Were any of these completed? Completed quests give EXP.'))}</p>
            <div class="rpg-quest-review-list">
                ${dropped.map((quest, i) => `
                    <label class="checkbox_label">
                        <input type="checkbox" data-quest="${i}">
                        <span>
                            <span class="rpg-quest-review-kind">${escapeHtml(quest.kind === 'main' ? t('progression.mainQuest', 'Main') : t('progression.sideQuest', 'Side'))}</span>
                            ${escapeHtml(quest.title)}${quest.markedDone ? ` <em>(${escapeHtml(t('progression.markedDone', 'marked completed'))})</em>` : ''}
                            <small>${range(quest.kind)} ${escapeHtml(t('progression.ofBar', 'of the EXP bar'))}</small>
                        </span>
                    </label>`).join('')}
            </div>
        </div>
    `);
    // Pre-tick quests the AI marked completed or whose steps were all done;
    // a single dropped quest is most likely the one just finished.
    dropped.forEach((quest, i) => {
        if (quest.likelyDone || dropped.length === 1) $dialog.find(`[data-quest="${i}"]`).prop('checked', true);
    });

    const result = await callGenericPopup($dialog, POPUP_TYPE.CONFIRM, '', {
        okButton: t('progression.awardExp', 'Award EXP'),
        cancelButton: t('progression.notCompleted', 'Not completed')
    });
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        dropped.forEach(quest => recordQuestOutcome(quest.title, 'abandoned'));
        saveChatData();
        return;
    }

    $dialog.find('input:checked').each(function () {
        const quest = dropped[Number($(this).data('quest'))];
        if (quest) completeQuest(quest.kind, quest.title);
    });
    $dialog.find('input:not(:checked)').each(function () {
        const quest = dropped[Number($(this).data('quest'))];
        if (quest) recordQuestOutcome(quest.title, 'abandoned');
    });
    saveChatData();
}
