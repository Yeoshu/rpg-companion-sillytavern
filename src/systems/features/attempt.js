/**
 * Attempt Roll
 *
 * The "Attempt" button above the chat input sends the typed message as an
 * action that needs a dice check. On click, the model is asked once (with an
 * editable prompt) which attribute, skill and difficulty fit the action; the
 * user can adjust those in a dialog and roll. The result is queued, the message
 * is sent, and the roll attaches to it, which puts it in the AI's context for
 * that reply. Cancelling leaves the typed text untouched.
 *
 * Nothing runs on ordinary messages: the check prompt is only sent when the
 * button is clicked, and can be switched off in settings.
 */

import { chat, substituteParams } from '../../../../../../../script.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../../../../popup.js';
import { extensionSettings } from '../../core/state.js';
import { saveChatData } from '../../core/persistence.js';
import { i18n } from '../../core/i18n.js';
import { generateWithExternalAPI } from '../generation/apiClient.js';
import { safeGenerateRaw } from '../../utils/responseExtractor.js';
import { extractJSONFromText, repairJSON } from '../../utils/jsonRepair.js';
import {
    DIFFICULTIES, normalizeDifficulty, checkTarget, resolveCheck, successChance,
    formatTarget, formatModifier, UNTRAINED_PENALTY
} from '../mechanics/rules.js';
import { getAttributes, findAttribute, getSkills, findSkill } from '../mechanics/character.js';
import { queueRoll, summarizeRoll } from '../mechanics/rollState.js';

/** Messages of story context given to the referee. */
const CONTEXT_MESSAGES = 4;
const CONTEXT_CHARS_PER_MESSAGE = 600;

export const DEFAULT_ATTEMPT_PROMPT = `You are the rules referee for a tabletop-style roleplay. {{user}} is attempting the action below and will roll for it. Choose the check.

{{user}}'s attributes: {{attributes}}
{{user}}'s skills: {{skills}}
Difficulty levels: easy, average, hard, veryHard, extreme

Recent story:
{{context}}

{{user}}'s attempt:
{{action}}

Choose the single most relevant attribute. If one of {{user}}'s skills applies, name it. If the action clearly needs a trained skill that {{user}} does not have, name that skill anyway (it will be rolled untrained). Otherwise use null. Judge the difficulty from the situation in the story.

Respond with ONLY a JSON object and nothing else:
{"attribute": "<attribute from the list>", "skill": "<skill name or null>", "difficulty": "<difficulty level>", "reason": "<what {{user}} is attempting, in a few words>"}`;

function t(key, fallback) {
    return i18n.getTranslation(key) || fallback;
}

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

let busy = false;

function setButtonBusy(isBusy) {
    $('#rpg-attempt-button')
        .prop('disabled', isBusy)
        .toggleClass('rpg-busy', isBusy)
        .find('i').toggleClass('fa-dice-d20', !isBusy).toggleClass('fa-spinner fa-spin', isBusy);
}

/** Whether SillyTavern is currently generating (the send button is swapped for stop). */
function isGenerating() {
    return $('#mes_stop').is(':visible');
}

/**
 * Click handler for the Attempt button.
 */
export async function startAttempt() {
    if (!extensionSettings.enabled || busy) return;

    const $input = $('#send_textarea');
    const action = String($input.val() || '').trim();
    if (!action) {
        toastr.info(t('attempt.typeFirst', 'Type what you attempt first, then click Attempt.'));
        $input.trigger('focus');
        return;
    }
    if (isGenerating()) {
        toastr.info(t('attempt.wait', 'Wait for the current reply to finish.'));
        return;
    }
    const attributes = getAttributes();
    if (!attributes.length) {
        toastr.warning(t('attempt.noAttributes', 'Add attributes to your character to make checks.'));
        return;
    }

    busy = true;
    try {
        let suggestion = { attributeId: attributes[0].id, skillName: null, difficulty: 'average', reason: '' };
        if (extensionSettings.attemptSuggest !== false) {
            setButtonBusy(true);
            try {
                suggestion = (await requestSuggestion(action)) || suggestion;
            } catch (error) {
                console.error('[RPG Companion] Attempt suggestion failed:', error);
                toastr.warning(t('attempt.suggestFailed', 'Could not get a suggested check; pick one yourself.'));
            } finally {
                setButtonBusy(false);
            }
        }

        const choice = await askToRoll(suggestion);
        if (!choice) return; // cancelled: the typed text stays in the box

        const roll = performCheck({ ...choice, reason: suggestion.reason });
        queueRoll(roll);
        saveChatData();
        showRollResult(roll);
        $(document).trigger('rpg:diceRollChanged');

        // Send the message; the queued roll attaches to it on MESSAGE_SENT.
        $('#send_but').trigger('click');
    } finally {
        busy = false;
    }
}

/* ---------------------------------------------------------------------------
   Asking the model
   --------------------------------------------------------------------------- */

function describeAttributes(attributes) {
    return attributes.map(attr => `${attr.name} ${attr.value}`).join(', ') || 'none';
}

function describeSkills(skills) {
    return skills.map(skill => `${skill.name} ${formatModifier(skill.level)}`).join(', ') || 'none';
}

function buildContext() {
    const lines = [];
    for (let i = chat.length - 1; i >= 0 && lines.length < CONTEXT_MESSAGES; i--) {
        const msg = chat[i];
        if (!msg || msg.is_system || !msg.mes) continue;
        const text = msg.mes.length > CONTEXT_CHARS_PER_MESSAGE ? `…${msg.mes.slice(-CONTEXT_CHARS_PER_MESSAGE)}` : msg.mes;
        lines.unshift(`${msg.name}: ${text}`);
    }
    return lines.join('\n\n') || '(start of story)';
}

/** The filled-in check prompt for the typed action. */
export function buildCheckPrompt(action) {
    const template = extensionSettings.customAttemptPrompt || DEFAULT_ATTEMPT_PROMPT;
    const filled = template
        .replaceAll('{{attributes}}', describeAttributes(getAttributes()))
        .replaceAll('{{skills}}', describeSkills(getSkills()))
        .replaceAll('{{context}}', buildContext())
        .replaceAll('{{action}}', action)
        .replaceAll('{{lastMessage}}', action);
    return substituteParams(filled);
}

async function requestSuggestion(action) {
    const messages = [
        { role: 'system', content: buildCheckPrompt(action) },
        { role: 'user', content: 'Respond with the JSON object only.' }
    ];

    const response = extensionSettings.generationMode === 'external'
        ? await generateWithExternalAPI(messages)
        : await safeGenerateRaw({ prompt: messages, quietToLoud: false });

    return parseSuggestion(response);
}

/**
 * Turns the model's reply into a suggested check, or null if it can't be read.
 * Unknown attributes/difficulties fall back to sensible defaults; the user can
 * still change them in the dialog.
 */
export function parseSuggestion(text) {
    if (!text) return null;
    const jsonText = extractJSONFromText(String(text)) || String(text);
    const match = jsonText.match(/\{[\s\S]*\}/);
    const data = repairJSON(match ? match[0] : jsonText);
    if (!data || typeof data !== 'object') return null;

    const attributes = getAttributes();
    if (!attributes.length) return null;
    const attribute = findAttribute(data.attribute) || attributes[0];

    const skillName = typeof data.skill === 'string' && data.skill.trim() && data.skill.trim().toLowerCase() !== 'null'
        ? data.skill.trim()
        : null;

    return {
        attributeId: attribute.id,
        skillName,
        difficulty: normalizeDifficulty(data.difficulty),
        reason: typeof data.reason === 'string' ? data.reason.trim() : ''
    };
}

/* ---------------------------------------------------------------------------
   Asking the user
   --------------------------------------------------------------------------- */

/**
 * Resolves a dialog choice into the pieces the rules need.
 * Skill values: '' (none), 'skill:<key>' (trained), 'untrained:<name>'.
 */
function interpretChoice({ attributeId, skillValue, difficulty }) {
    const attribute = findAttribute(attributeId) || getAttributes()[0];
    let skill = null;
    if (skillValue?.startsWith('skill:')) {
        const found = findSkill(skillValue.slice(6));
        if (found) skill = { name: found.name, trained: true, modifier: found.level };
    } else if (skillValue?.startsWith('untrained:')) {
        skill = { name: skillValue.slice(10), trained: false, modifier: UNTRAINED_PENALTY };
    }
    const target = checkTarget({
        attribute: attribute.value,
        skillLevel: skill?.trained ? skill.modifier : null,
        untrained: skill ? !skill.trained : false,
        difficulty
    });
    return { attribute, skill, difficulty: normalizeDifficulty(difficulty), target };
}

function buildDialog(suggestion) {
    const attributes = getAttributes();
    const skills = getSkills();
    const suggested = suggestion.skillName ? findSkill(suggestion.skillName) : null;

    const attributeOptions = attributes.map(attr => `<option value="${escapeHtml(attr.id)}" ${attr.id === suggestion.attributeId ? 'selected' : ''}>${escapeHtml(attr.name)} ${attr.value} (${formatTarget(attr.roll)})</option>`).join('');

    let skillOptions = `<option value="">${escapeHtml(t('attempt.noSkill', 'None'))}</option>`;
    skillOptions += skills.map(skill => `<option value="skill:${escapeHtml(skill.key)}" ${suggested?.key === skill.key ? 'selected' : ''}>${escapeHtml(skill.name)} ${formatModifier(skill.level)}</option>`).join('');
    // A skill the model asked for that the character doesn't have: offer it untrained (only when skills are in use).
    if (suggestion.skillName && !suggested && skills.length) {
        skillOptions += `<option value="untrained:${escapeHtml(suggestion.skillName)}" selected>${escapeHtml(suggestion.skillName)} (${escapeHtml(t('attempt.untrained', 'untrained'))} ${formatModifier(UNTRAINED_PENALTY)})</option>`;
    }

    const difficultyOptions = Object.entries(DIFFICULTIES).map(([id, d]) => `<option value="${id}" ${id === suggestion.difficulty ? 'selected' : ''}>${escapeHtml(t(`attempt.difficulty.${id}`, d.label))} (${formatModifier(d.modifier)})</option>`).join('');

    const $dialog = $(`
        <div class="rpg-roll-prompt">
            <h3><i class="fa-solid fa-dice-d20"></i> ${escapeHtml(t('attempt.dialogTitle', 'Attempt'))}</h3>
            ${suggestion.reason ? `<p class="rpg-roll-reason">${escapeHtml(suggestion.reason)}</p>` : ''}
            <div class="rpg-roll-fields">
                <label><span>${escapeHtml(t('attempt.attribute', 'Attribute'))}</span><select class="text_pole" data-roll="attribute">${attributeOptions}</select></label>
                ${skills.length ? `<label><span>${escapeHtml(t('attempt.skill', 'Skill'))}</span><select class="text_pole" data-roll="skill">${skillOptions}</select></label>` : ''}
                <label><span>${escapeHtml(t('attempt.difficulty', 'Difficulty'))}</span><select class="text_pole" data-roll="difficulty">${difficultyOptions}</select></label>
            </div>
            <div class="rpg-roll-target"></div>
        </div>
    `);

    const readChoice = () => ({
        attributeId: $dialog.find('[data-roll="attribute"]').val(),
        skillValue: $dialog.find('[data-roll="skill"]').val() || '',
        difficulty: $dialog.find('[data-roll="difficulty"]').val()
    });

    const refresh = () => {
        const { attribute, skill, difficulty, target } = interpretChoice(readChoice());
        const chance = Math.round(successChance(target.target) * 100);
        const parts = [`${escapeHtml(attribute.name)} ${formatTarget(target.base)}`];
        if (skill) parts.push(`${escapeHtml(skill.name)} ${formatModifier(target.skill)}`);
        if (target.difficulty) parts.push(`${escapeHtml(DIFFICULTIES[difficulty].label)} ${formatModifier(target.difficulty)}`);
        $dialog.find('.rpg-roll-target').html(
            `<div>${escapeHtml(t('attempt.rollUnder', 'Roll 3d6 under or equal to'))} <strong>${target.target}</strong> <span class="rpg-roll-chance">(${chance}%)</span></div>`
            + `<small>${parts.join(' · ')}</small>`
        );
    };
    $dialog.on('change', 'select', refresh);
    refresh();

    return { $dialog, readChoice };
}

/**
 * Shows the confirmation dialog.
 * @returns {Promise<object|null>} the (possibly adjusted) choice, or null if declined
 */
async function askToRoll(suggestion) {
    const { $dialog, readChoice } = buildDialog(suggestion);
    const result = await callGenericPopup($dialog, POPUP_TYPE.CONFIRM, '', {
        okButton: t('attempt.roll', 'Roll and send'),
        cancelButton: t('attempt.cancel', 'Cancel')
    });
    return result === POPUP_RESULT.AFFIRMATIVE ? readChoice() : null;
}

/* ---------------------------------------------------------------------------
   Rolling
   --------------------------------------------------------------------------- */

/** Rolls the check and returns the record stored on the message. */
export function performCheck(choice, dice) {
    const { attribute, skill, difficulty, target } = interpretChoice(choice);
    const outcome = resolveCheck(target.target, dice);
    return {
        kind: 'check',
        attribute: { id: attribute.id, name: attribute.name, value: attribute.value },
        skill,
        difficulty,
        base: target.base,
        target: target.target,
        dice: outcome.dice,
        total: outcome.total,
        success: outcome.success,
        margin: outcome.margin,
        critical: outcome.critical,
        reason: choice.reason || '',
        timestamp: Date.now()
    };
}

function showRollResult(roll) {
    const title = roll.success ? t('attempt.success', 'Success') : t('attempt.failure', 'Failure');
    const detail = `${summarizeRoll(roll)} (${roll.dice.join(' + ')})`;
    (roll.success ? toastr.success : toastr.error)(detail, `🎲 ${title}`, { timeOut: 6000 });
}
