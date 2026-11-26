/**
 * Quests Rendering Module
 * Handles UI rendering for quests system (main and optional quests)
 */

import { extensionSettings, $questsContainer, committedTrackerData, lastGeneratedData } from '../../core/state.js';
import { saveSettings, saveChatData } from '../../core/persistence.js';
import { isItemLocked, setItemLock } from '../generation/lockManager.js';
import { i18n } from '../../core/i18n.js';
import { completeQuest, markQuestResolved } from '../features/experience.js';
import { normalizeQuest, normalizeQuests, toStored } from '../mechanics/quests.js';

/**
 * Syncs the current extensionSettings.quests to committedTrackerData.userStats
 * This ensures quest changes made via UI are reflected in the data sent to AI
 */
function syncQuestsToCommittedData() {
    const currentData = committedTrackerData.userStats || lastGeneratedData.userStats;
    if (!currentData) return;

    const trimmed = currentData.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            const jsonData = JSON.parse(currentData);
            if (jsonData && typeof jsonData === 'object') {
                // Update quests in the JSON data
                jsonData.quests = toStored(normalizeQuests(extensionSettings.quests));
                const updatedJSON = JSON.stringify(jsonData, null, 2);
                committedTrackerData.userStats = updatedJSON;
                lastGeneratedData.userStats = updatedJSON;
            }
        } catch (e) {
            console.warn('[RPG Quests] Failed to sync quests to committed data:', e);
        }
    }
}

/**
 * Helper to generate lock icon HTML if setting is enabled
 * @param {string} tracker - Tracker name
 * @param {string} path - Item path
 * @returns {string} Lock icon HTML or empty string
 */
function getLockIconHtml(tracker, path) {
    const showLockIcons = extensionSettings.showLockIcons ?? true;
    if (!showLockIcons) return '';

    const isLocked = isItemLocked(tracker, path);
    const lockIcon = isLocked ? '🔒' : '🔓';
    const lockTitle = isLocked ? i18n.getTranslation('global.locked') || 'Locked' : i18n.getTranslation('global.unlocked') || 'Unlocked';
    const lockedClass = isLocked ? ' locked' : '';
    return `<span class="rpg-section-lock-icon${lockedClass}" data-tracker="${tracker}" data-path="${path}" title="${lockTitle}">${lockIcon}</span>`;
}

/**
 * HTML escape helper
 * @param {string} text - Text to escape
 * @returns {string} Escaped HTML
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Renders the quests sub-tab navigation (Main, Optional)
 * @param {string} activeTab - Currently active sub-tab ('main', 'optional')
 * @returns {string} HTML for sub-tab navigation
 */
export function renderQuestsSubTabs(activeTab = 'main') {
    const mainText = i18n.getTranslation('quests.section.main') || 'Main Quest';
    const optionalText = i18n.getTranslation('quests.section.optional') || 'Optional Quests';

    return `
        <div class="rpg-quests-subtabs">
            <button class="rpg-quests-subtab ${activeTab === 'main' ? 'active' : ''}" data-tab="main">
                ${mainText}
            </button>
            <button class="rpg-quests-subtab ${activeTab === 'optional' ? 'active' : ''}" data-tab="optional">
                ${optionalText}
            </button>
        </div>
    `;
}

/* ---------------------------------------------------------------------------
   Quests are { name, description, steps: [{ text, done }] } (mechanics/quests.js).
   --------------------------------------------------------------------------- */

function t(key, fallback) {
    return i18n.getTranslation(key) || fallback;
}

/** The quest at main / optional[index] (normalized), or null. */
function getQuest(field, index) {
    const quests = extensionSettings.quests || {};
    return normalizeQuest(field === 'main' ? quests.main : (quests.optional || [])[index]);
}

/** Writes a quest back (null removes it) and syncs it to the data the AI sees. */
function setQuest(field, index, quest) {
    const quests = normalizeQuests(extensionSettings.quests);
    if (field === 'main') {
        quests.main = quest;
    } else if (quest) {
        quests.optional[index] = quest;
    } else {
        quests.optional.splice(index, 1);
    }
    extensionSettings.quests = toStored(quests);
    syncQuestsToCommittedData();
    saveSettings();
    saveChatData();
}

function renderQuestCard(quest, field, index = 0) {
    const lockPath = field === 'main' ? 'quests.main' : `quests.optional[${index}]`;
    const done = quest.steps.filter(s => s.done).length;
    const steps = quest.steps.map((step, i) => `
        <li class="rpg-quest-step${step.done ? ' done' : ''}">
            <button type="button" class="rpg-quest-step-toggle" data-action="toggle-step" data-step="${i}" title="${escapeHtml(step.done ? t('quests.stepUndo', 'Mark not done') : t('quests.stepDone', 'Mark done'))}">
                <i class="fa-${step.done ? 'solid fa-square-check' : 'regular fa-square'}"></i>
            </button>
            <span class="rpg-quest-step-text rpg-editable" contenteditable="true" data-edit-step="${i}">${escapeHtml(step.text)}</span>
            <button type="button" class="rpg-quest-step-remove" data-action="remove-step" data-step="${i}" title="${escapeHtml(t('quests.removeStep', 'Remove step'))}"><i class="fa-solid fa-xmark"></i></button>
        </li>`).join('');
    return `
        <div class="rpg-quest-item rpg-quest-card" data-field="${field}" data-index="${index}">
            <div class="rpg-quest-card-head">
                ${getLockIconHtml('userStats', lockPath)}
                <div class="rpg-quest-title rpg-editable" contenteditable="true" data-edit="name" title="${escapeHtml(t('quests.nameHint', 'The quest\'s name is how it is recognised between updates'))}">${escapeHtml(quest.name)}</div>
                ${quest.steps.length ? `<span class="rpg-quest-progress">${done}/${quest.steps.length}</span>` : ''}
                <div class="rpg-quest-actions">
                    <button class="rpg-quest-complete" data-action="complete-quest" title="${escapeHtml(t('quests.completeQuestTitle', 'Complete quest (gain EXP)'))}"><i class="fa-solid fa-check"></i></button>
                    <button class="rpg-quest-remove" data-action="remove-quest" title="${escapeHtml(t('quests.removeQuestTitle', 'Remove quest (no EXP)'))}"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>
            <div class="rpg-quest-desc rpg-editable" contenteditable="true" data-edit="description" data-placeholder="${escapeHtml(t('quests.descriptionPlaceholder', 'Add a description...'))}">${escapeHtml(quest.description)}</div>
            ${steps ? `<ul class="rpg-quest-steps">${steps}</ul>` : ''}
            <button type="button" class="rpg-quest-add-step" data-action="add-step"><i class="fa-solid fa-plus"></i> ${escapeHtml(t('quests.addStep', 'Step'))}</button>
        </div>`;
}

function renderAddForm(field) {
    return `
        <div class="rpg-inline-form" id="rpg-add-quest-form-${field}" style="display: none;">
            <input type="text" class="rpg-inline-input" id="rpg-new-quest-${field}" maxlength="120" placeholder="${escapeHtml(field === 'main' ? t('quests.main.addQuestPlaceholder', 'Quest name...') : t('quests.optional.addQuestPlaceholder', 'Quest name...'))}" />
            <input type="text" class="rpg-inline-input" id="rpg-new-quest-desc-${field}" maxlength="600" placeholder="${escapeHtml(t('quests.descriptionPlaceholder', 'Add a description...'))}" />
            <div class="rpg-inline-buttons">
                <button class="rpg-inline-btn rpg-inline-cancel" data-action="cancel-add-quest" data-field="${field}"><i class="fa-solid fa-times"></i> ${escapeHtml(t('global.cancel', 'Cancel'))}</button>
                <button class="rpg-inline-btn rpg-inline-save" data-action="save-add-quest" data-field="${field}"><i class="fa-solid fa-check"></i> ${escapeHtml(t('global.add', 'Add'))}</button>
            </div>
        </div>`;
}

/**
 * Renders the main quest view
 * @param {object|string} mainQuest - the main quest (any stored shape)
 */
export function renderMainQuestView(mainQuest) {
    const quest = normalizeQuest(mainQuest);
    return `
        <div class="rpg-quest-section">
            <div class="rpg-quest-header">
                <h3 class="rpg-quest-section-title">${escapeHtml(t('quests.main.title', 'Main Quest'))}</h3>
                ${!quest ? `<button class="rpg-add-quest-btn" data-action="add-quest" data-field="main" title="${escapeHtml(t('quests.main.addQuestTitle', 'Add main quest'))}">
                    <i class="fa-solid fa-plus"></i> ${escapeHtml(t('quests.main.addQuestButton', 'Add Quest'))}
                </button>` : ''}
            </div>
            <div class="rpg-quest-content">
                ${quest ? renderQuestCard(quest, 'main') : `${renderAddForm('main')}<div class="rpg-quest-empty">${escapeHtml(t('quests.main.empty', 'No active main quest'))}</div>`}
            </div>
            <div class="rpg-quest-hint">
                <i class="fa-solid fa-lightbulb"></i>
                ${escapeHtml(t('quests.main.hint', 'The main quest represents your primary objective in the story.'))}
            </div>
        </div>
    `;
}

/**
 * Renders the optional quests view
 * @param {Array} optionalQuests - optional quests (any stored shape)
 */
export function renderOptionalQuestsView(optionalQuests) {
    const quests = (optionalQuests || []).map(normalizeQuest);
    const cards = quests.map((q, i) => (q ? renderQuestCard(q, 'optional', i) : '')).join('');
    return `
        <div class="rpg-quest-section">
            <div class="rpg-quest-header">
                <h3 class="rpg-quest-section-title">${escapeHtml(t('quests.optional.title', 'Optional Quests'))}</h3>
                <button class="rpg-add-quest-btn" data-action="add-quest" data-field="optional" title="${escapeHtml(t('quests.optional.addQuestTitle', 'Add optional quest'))}">
                    <i class="fa-solid fa-plus"></i> ${escapeHtml(t('quests.optional.addQuestButton', 'Add Quest'))}
                </button>
            </div>
            <div class="rpg-quest-content">
                ${renderAddForm('optional')}
                <div class="rpg-quest-list">
                    ${cards || `<div class="rpg-quest-empty">${escapeHtml(t('quests.optional.empty', 'No active optional quests'))}</div>`}
                </div>
                <div class="rpg-quest-hint">
                    <i class="fa-solid fa-info-circle"></i>
                    ${escapeHtml(t('quests.optional.hint', 'Optional quests are side objectives that complement your main story.'))}
                </div>
            </div>
        </div>
    `;
}

/**
 * Main render function for quests
 */
export function renderQuests() {
    if (!extensionSettings.showQuests || !$questsContainer) {
        return;
    }
    const activeSubTab = $questsContainer.data('active-subtab') || 'main';
    const quests = extensionSettings.quests || {};
    let html = '<div class="rpg-quests-wrapper">';
    html += renderQuestsSubTabs(activeSubTab);
    html += '<div class="rpg-quests-panels">';
    html += activeSubTab === 'main' ? renderMainQuestView(quests.main) : renderOptionalQuestsView(quests.optional || []);
    html += '</div></div>';
    $questsContainer.html(html);
    attachQuestEventHandlers();
}

function cardOf(el) {
    const $card = $(el).closest('.rpg-quest-card');
    return { field: $card.data('field'), index: Number($card.data('index')) || 0 };
}

/**
 * Attach event handlers for quest interactions
 */
function attachQuestEventHandlers() {
    $questsContainer.find('.rpg-quests-subtab').on('click', function() {
        $questsContainer.data('active-subtab', $(this).data('tab'));
        renderQuests();
    });

    $questsContainer.find('[data-action="add-quest"]').on('click', function() {
        const field = $(this).data('field');
        $(`#rpg-add-quest-form-${field}`).show();
        $(`#rpg-new-quest-${field}`).focus();
    });
    $questsContainer.find('[data-action="cancel-add-quest"]').on('click', function() {
        const field = $(this).data('field');
        $(`#rpg-add-quest-form-${field}`).hide();
        $(`#rpg-new-quest-${field}, #rpg-new-quest-desc-${field}`).val('');
    });
    $questsContainer.find('[data-action="save-add-quest"]').on('click', function() {
        const field = $(this).data('field');
        const quest = normalizeQuest({ name: $(`#rpg-new-quest-${field}`).val(), description: $(`#rpg-new-quest-desc-${field}`).val(), steps: [] });
        if (!quest) return;
        const index = field === 'main' ? 0 : normalizeQuests(extensionSettings.quests).optional.length;
        setQuest(field, index, quest);
        renderQuests();
    });
    $questsContainer.find('.rpg-inline-input').on('keypress', function(e) {
        if (e.which === 13) $(this).closest('.rpg-inline-form').find('[data-action="save-add-quest"]').click();
    });

    // Complete (gain EXP) or remove (no EXP)
    $questsContainer.find('[data-action="remove-quest"], [data-action="complete-quest"]').on('click', function() {
        const { field, index } = cardOf(this);
        const quest = getQuest(field, index);
        if (!quest) return;
        if ($(this).data('action') === 'complete-quest') completeQuest(field === 'main' ? 'main' : 'side', quest.name, quest.steps?.length);
        else markQuestResolved(quest.name, 'abandoned');
        setQuest(field, index, null);
        renderQuests();
    });

    // Name and description: edited in place
    $questsContainer.find('.rpg-quest-card [data-edit]').on('blur', function() {
        const { field, index } = cardOf(this);
        const quest = getQuest(field, index);
        if (!quest) return;
        const key = $(this).data('edit');
        const value = $(this).text().trim();
        if (key === 'name' && !value) { renderQuests(); return; }
        if (quest[key] === value) return;
        quest[key] = value;
        setQuest(field, index, normalizeQuest(quest));
    }).on('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); $(this).blur(); }
    });

    // Steps
    $questsContainer.find('[data-action="toggle-step"], [data-action="remove-step"], [data-action="add-step"]').on('click', function() {
        const { field, index } = cardOf(this);
        const quest = getQuest(field, index);
        if (!quest) return;
        const step = Number($(this).data('step'));
        const action = $(this).data('action');
        if (action === 'toggle-step') quest.steps[step].done = !quest.steps[step].done;
        else if (action === 'remove-step') quest.steps.splice(step, 1);
        else quest.steps.push({ text: t('quests.newStep', 'New step'), done: false });
        setQuest(field, index, quest);
        renderQuests();
        if (action === 'add-step') {
            const $last = $questsContainer.find(`.rpg-quest-card[data-field="${field}"][data-index="${index}"] [data-edit-step]`).last();
            $last.trigger('focus');
            const range = document.createRange();
            range.selectNodeContents($last[0]);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        }
    });
    $questsContainer.find('[data-edit-step]').on('blur', function() {
        const { field, index } = cardOf(this);
        const quest = getQuest(field, index);
        if (!quest) return;
        const step = Number($(this).data('edit-step'));
        const value = $(this).text().trim();
        if (!value) quest.steps.splice(step, 1);
        else if (quest.steps[step].text === value) return;
        else quest.steps[step].text = value;
        setQuest(field, index, quest);
        if (!value) renderQuests();
    }).on('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); $(this).blur(); }
    });

    // Lock icons (click and touch)
    $questsContainer.find('.rpg-section-lock-icon').on('click touchend', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const $icon = $(this);
        const trackerType = $icon.data('tracker');
        const itemPath = $icon.data('path');
        const currentlyLocked = isItemLocked(trackerType, itemPath);
        setItemLock(trackerType, itemPath, !currentlyLocked);
        $icon.text(!currentlyLocked ? '🔒' : '🔓');
        $icon.attr('title', !currentlyLocked ? 'Locked' : 'Unlocked');
        $icon.toggleClass('locked', !currentlyLocked);
        saveSettings();
    });
}
