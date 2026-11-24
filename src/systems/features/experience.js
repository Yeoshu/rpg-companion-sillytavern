/**
 * Experience
 *
 * Grants EXP (from quests and encounters), resolves level-ups, and lets the
 * player spend the character points they earn on attributes and skills.
 * All numbers come from src/systems/mechanics/progression.js; nothing here
 * asks the model for anything.
 *
 * Level, EXP and unspent points are saved per chat (see persistence.js).
 * Anything that changes them triggers `rpg:progressionChanged` on document.
 */

import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../../../../popup.js';
import { extensionSettings } from '../../core/state.js';
import { saveSettings, saveChatData } from '../../core/persistence.js';
import { i18n } from '../../core/i18n.js';
import {
    normalizeProgression, expToNextLevel, addExp, questReward, enemyReward
} from '../mechanics/progression.js';
import { attributeRoll, formatTarget, formatModifier } from '../mechanics/rules.js';
import { getAttributes, getSkills, setSkillLevel } from '../mechanics/character.js';

function t(key, fallback) {
    return i18n.getTranslation(key) || fallback;
}

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

export function getProgression() {
    return normalizeProgression(extensionSettings.progression);
}

/** Current level, EXP, bar size and unspent points. */
export function getProgressState() {
    const level = Math.max(1, Math.floor(extensionSettings.level) || 1);
    return {
        level,
        exp: Math.max(0, Math.floor(extensionSettings.exp) || 0),
        next: expToNextLevel(level, getProgression()),
        points: Math.max(0, Math.floor(extensionSettings.characterPoints) || 0)
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
    extensionSettings.characterPoints = result.points;
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

/** Sets unspent character points directly (manual edit). */
export function setCharacterPoints(value) {
    extensionSettings.characterPoints = Math.max(0, Math.floor(Number(value) || 0));
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
 * @param {object[]} enemies - combat enemies ({name, hp, level})
 * @param {string} result - 'victory' | 'defeat' | 'fled' | 'interrupted'
 * @returns {{ total: number, enemies: {name: string, level: number, exp: number}[] }}
 */
export function encounterRewards(enemies, result) {
    const playerLevel = getProgressState().level;
    const settings = getProgression();
    const beaten = (enemies || []).filter(enemy => enemy && (result === 'victory' || Number(enemy.hp) <= 0));
    const rows = beaten.map(enemy => {
        const level = Math.max(1, Math.round(Number(enemy.level)) || playerLevel);
        return { name: String(enemy.name || '?'), level, exp: enemyReward(level, playerLevel, settings) };
    });
    return { total: rows.reduce((sum, row) => sum + row.exp, 0), enemies: rows };
}

/* ---------------------------------------------------------------------------
   Spending character points
   --------------------------------------------------------------------------- */

/**
 * Opens the dialog to spend character points on attributes and skills.
 * Only points added in this dialog can be taken back; existing values can
 * still be edited directly on the sheet.
 */
export async function openSpendPointsDialog() {
    const settings = getProgression();
    const pool = getProgressState().points;
    const attributes = getAttributes();
    const skills = getSkills();
    const added = { attr: {}, skill: {} };
    const spent = () =>
        Object.values(added.attr).reduce((s, n) => s + n * settings.attributeCost, 0)
        + Object.values(added.skill).reduce((s, n) => s + n * settings.skillCost, 0);

    const row = (type, id, name, cost) => `
        <div class="rpg-cp-row" data-type="${type}" data-id="${escapeHtml(id)}" data-cost="${cost}">
            <span class="rpg-cp-name">${escapeHtml(name)}</span>
            <span class="rpg-cp-value"></span>
            <span class="rpg-cp-controls">
                <button type="button" class="menu_button rpg-cp-btn" data-delta="-1" aria-label="−"><i class="fa-solid fa-minus"></i></button>
                <button type="button" class="menu_button rpg-cp-btn" data-delta="1" aria-label="+"><i class="fa-solid fa-plus"></i></button>
            </span>
        </div>`;

    const $dialog = $(`
        <div class="rpg-cp-dialog">
            <h3><i class="fa-solid fa-arrow-up-right-dots"></i> ${escapeHtml(t('progression.spendTitle', 'Spend character points'))}</h3>
            <div class="rpg-cp-pool"></div>
            <div class="rpg-cp-group">
                <div class="rpg-cp-group-title">${escapeHtml(t('progression.attributes', 'Attributes'))} <small>${settings.attributeCost} ${escapeHtml(t('progression.cpEach', 'CP each'))}</small></div>
                ${attributes.map(a => row('attr', a.id, a.name, settings.attributeCost)).join('')}
            </div>
            ${skills.length ? `
            <div class="rpg-cp-group">
                <div class="rpg-cp-group-title">${escapeHtml(t('progression.skills', 'Skills'))} <small>${settings.skillCost} ${escapeHtml(t('progression.cpEach', 'CP each'))}</small></div>
                ${skills.map(s => row('skill', s.key, s.name, settings.skillCost)).join('')}
            </div>` : ''}
        </div>
    `);

    const refresh = () => {
        const remaining = pool - spent();
        $dialog.find('.rpg-cp-pool').html(
            `<strong>${remaining}</strong> / ${pool} ${escapeHtml(t('progression.cpLeft', 'character points left'))}`
        );
        $dialog.find('.rpg-cp-row').each(function () {
            const $row = $(this);
            const type = $row.data('type');
            const id = String($row.data('id'));
            const cost = Number($row.data('cost'));
            const extra = added[type][id] || 0;
            let text;
            if (type === 'attr') {
                const base = attributes.find(a => a.id === id).value;
                text = `${base + extra} <small>(${formatTarget(attributeRoll(base + extra))})</small>`;
            } else {
                const base = skills.find(s => s.key === id).level;
                text = formatModifier(base + extra);
            }
            $row.toggleClass('rpg-cp-changed', extra > 0);
            $row.find('.rpg-cp-value').html(text);
            $row.find('[data-delta="-1"]').prop('disabled', extra <= 0);
            $row.find('[data-delta="1"]').prop('disabled', remaining < cost);
        });
    };

    $dialog.on('click', '.rpg-cp-btn', function () {
        const $row = $(this).closest('.rpg-cp-row');
        const type = $row.data('type');
        const id = String($row.data('id'));
        const delta = Number($(this).data('delta'));
        const next = (added[type][id] || 0) + delta;
        if (next < 0 || (delta > 0 && pool - spent() < Number($row.data('cost')))) return;
        added[type][id] = next;
        refresh();
    });
    refresh();

    const result = await callGenericPopup($dialog, POPUP_TYPE.CONFIRM, '', {
        okButton: t('progression.apply', 'Apply'),
        cancelButton: t('global.cancel', 'Cancel')
    });
    if (result !== POPUP_RESULT.AFFIRMATIVE || spent() === 0) return false;

    for (const [id, n] of Object.entries(added.attr)) {
        if (!n) continue;
        const current = attributes.find(a => a.id === id).value;
        extensionSettings.classicStats[id] = current + n;
    }
    for (const [key, n] of Object.entries(added.skill)) {
        if (!n) continue;
        const skill = skills.find(s => s.key === key);
        setSkillLevel(skill.name, skill.level + n);
    }
    extensionSettings.characterPoints = pool - spent();
    changed();
    return true;
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
