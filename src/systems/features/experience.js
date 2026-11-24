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
import { sheetPoints } from './sheet.js';
import { TIERS } from '../mechanics/combat/catalog.js';
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
    markQuestResolved(title);
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
        const tier = TIERS[enemy.tier] || TIERS.standard;
        return { name: String(enemy.name || '?'), level, tier: enemy.tier || 'standard', exp: Math.max(1, Math.round(enemyReward(level, playerLevel, settings) * tier.hp)) };
    });
    return { total: rows.reduce((sum, row) => sum + row.exp, 0), enemies: rows };
}

/* ---------------------------------------------------------------------------
   Quests dropped by the tracker AI
   --------------------------------------------------------------------------- */

const MAX_RESOLVED = 200;

function questTitle(quest) {
    while (quest && typeof quest === 'object' && quest.value !== undefined) quest = quest.value;
    const title = typeof quest === 'string' ? quest.trim() : '';
    return title && title.toLowerCase() !== 'none' ? title : '';
}

function questKey(title) {
    return String(title || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Remembers (per chat) that a quest has been dealt with, so the same quest
 * isn't asked about again on swipes or regenerations.
 */
export function markQuestResolved(title) {
    const key = questKey(title);
    if (!key) return;
    const list = Array.isArray(extensionSettings.resolvedQuests) ? extensionSettings.resolvedQuests : [];
    if (!list.includes(key)) list.push(key);
    extensionSettings.resolvedQuests = list.slice(-MAX_RESOLVED);
}

function isQuestResolved(title) {
    return Array.isArray(extensionSettings.resolvedQuests) && extensionSettings.resolvedQuests.includes(questKey(title));
}

/** The current quests as plain titles: { main: string, optional: string[] }. */
export function snapshotQuests() {
    const quests = extensionSettings.quests || {};
    return {
        main: questTitle(quests.main),
        optional: (Array.isArray(quests.optional) ? quests.optional : []).map(questTitle).filter(Boolean)
    };
}

/**
 * Quests present in `before` but missing from `after` (in either list),
 * skipping any already completed, removed or answered in this chat.
 * @returns {{ title: string, kind: 'main'|'side' }[]}
 */
export function findDroppedQuests(before, after) {
    const remaining = new Set([after.main, ...after.optional].filter(Boolean).map(questKey));
    const dropped = [];
    const seen = new Set();
    const consider = (title, kind) => {
        const key = questKey(title);
        if (!key || remaining.has(key) || seen.has(key) || isQuestResolved(title)) return;
        seen.add(key);
        dropped.push({ title, kind });
    };
    consider(before.main, 'main');
    before.optional.forEach(title => consider(title, 'side'));
    return dropped;
}

/**
 * Call after a new tracker update has been applied, with the quests from
 * before it. If the AI removed any quests, asks whether they were completed
 * and awards EXP for the ones that were. Doesn't block the caller.
 */
export function reviewDroppedQuests(before) {
    if (!extensionSettings.enabled || extensionSettings.askAboutDroppedQuests === false || !before) return;
    const dropped = findDroppedQuests(before, snapshotQuests());
    if (!dropped.length) return;
    // Mark first so an overlapping update (swipe, regenerate) doesn't ask twice.
    dropped.forEach(quest => markQuestResolved(quest.title));
    saveChatData();
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
                            ${escapeHtml(quest.title)}
                            <small>${range(quest.kind)} ${escapeHtml(t('progression.ofBar', 'of the EXP bar'))}</small>
                        </span>
                    </label>`).join('')}
            </div>
        </div>
    `);
    // A single quest is most likely the one just finished: pre-tick it.
    if (dropped.length === 1) $dialog.find('input').prop('checked', true);

    const result = await callGenericPopup($dialog, POPUP_TYPE.CONFIRM, '', {
        okButton: t('progression.awardExp', 'Award EXP'),
        cancelButton: t('progression.notCompleted', 'Not completed')
    });
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;

    $dialog.find('input:checked').each(function () {
        const quest = dropped[Number($(this).data('quest'))];
        if (quest) completeQuest(quest.kind, quest.title);
    });
}
