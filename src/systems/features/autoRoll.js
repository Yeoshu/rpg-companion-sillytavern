/**
 * Auto-Roll
 *
 * Before the AI replies to a user message, asks the model (with an editable
 * prompt) whether the action in that message needs a dice check and which
 * attribute/skill applies. If it does, the user is asked whether to roll, and
 * can adjust the attribute, skill and difficulty first. Declining lets the
 * chat continue normally; accepting resolves the check with the core rules
 * and attaches the result to the message, which puts it in the AI's context.
 *
 * Runs from the extension's generate interceptor (see index.js), which
 * SillyTavern awaits after the user's message is added to the chat and before
 * the prompt is assembled.
 */

import { chat, substituteParams, saveChatDebounced } from '../../../../../../../script.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../../../../popup.js';
import { extensionSettings } from '../../core/state.js';
import { i18n } from '../../core/i18n.js';
import { generateWithExternalAPI } from '../generation/apiClient.js';
import { safeGenerateRaw } from '../../utils/responseExtractor.js';
import { extractJSONFromText, repairJSON } from '../../utils/jsonRepair.js';
import {
    DIFFICULTIES, normalizeDifficulty, checkTarget, resolveCheck, successChance,
    formatTarget, formatModifier, UNTRAINED_PENALTY
} from '../mechanics/rules.js';
import { getAttributes, findAttribute, getSkills, findSkill } from '../mechanics/character.js';
import { attachRoll, getRollForMessage, latestUserMessageIndex, summarizeRoll } from '../mechanics/rollState.js';

/** Marks a message as already evaluated, so regenerations/swipes don't ask again. */
const CHECKED_FIELD = 'rpg_auto_roll_checked';
/** Messages of story context given to the referee. */
const CONTEXT_MESSAGES = 4;
const CONTEXT_CHARS_PER_MESSAGE = 600;

export const DEFAULT_AUTO_ROLL_PROMPT = `You are the rules referee for a tabletop-style roleplay. Decide whether {{user}}'s latest message describes an action that needs a dice check.

Call for a check only when the outcome is genuinely uncertain AND failure would be interesting: risky, contested, or difficult actions such as sneaking past a guard, picking a lock, climbing a slick wall, persuading someone who is reluctant, or dodging a falling rock. Do NOT call for a check for ordinary actions, casual conversation, things {{user}} would obviously succeed or fail at, or anything another character is doing.

{{user}}'s attributes: {{attributes}}
{{user}}'s skills: {{skills}}
Difficulty levels: easy, average, hard, veryHard, extreme

Recent story:
{{context}}

{{user}}'s latest message:
{{lastMessage}}

Choose the single most relevant attribute. If one of {{user}}'s skills applies, name it. If the action clearly needs a trained skill that {{user}} does not have, name that skill anyway (it will be rolled untrained). Otherwise use null.

Respond with ONLY a JSON object and nothing else:
{"roll": true, "attribute": "<attribute from the list>", "skill": "<skill name or null>", "difficulty": "<difficulty level>", "reason": "<what {{user}} is attempting, in a few words>"}
If no check is needed, respond: {"roll": false}`;

function t(key, fallback) {
    return i18n.getTranslation(key) || fallback;
}

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

export function isAutoRollActive() {
    return !!(extensionSettings.enabled && extensionSettings.autoRoll && (extensionSettings.showAutoRollToggle ?? true));
}

/**
 * Generation types that respond to a freshly sent user message.
 * Regenerate/swipe/continue reuse whatever was decided for that message.
 */
function isNewReply(type) {
    return !type || type === 'normal';
}

/**
 * Entry point from the generate interceptor.
 * @param {string} type - SillyTavern generation type
 */
export async function maybeAutoRoll(type) {
    if (!isAutoRollActive() || !isNewReply(type)) return;

    const index = latestUserMessageIndex();
    const message = chat[index];
    // Only the message the AI is about to answer, and only once.
    if (!message || index !== chat.length - 1) return;
    if (message.extra?.[CHECKED_FIELD] || getRollForMessage(index)) return;

    message.extra = message.extra || {};
    message.extra[CHECKED_FIELD] = true;
    saveChatDebounced();

    let decision;
    try {
        decision = await requestDecision(index);
    } catch (error) {
        console.error('[RPG Companion] Auto-roll check failed:', error);
        toastr.warning(t('autoRoll.checkFailed', 'Auto-roll check failed; continuing without a roll.'));
        return;
    }
    if (!decision) return;

    const choice = await askToRoll(decision);
    if (!choice) return; // declined: the reply is generated as normal

    const roll = performCheck({ ...choice, reason: decision.reason });
    attachRoll(index, roll);
    showRollResult(roll);
    $(document).trigger('rpg:diceRollChanged');
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

function buildContext(index) {
    const lines = [];
    for (let i = index - 1; i >= 0 && lines.length < CONTEXT_MESSAGES; i--) {
        const msg = chat[i];
        if (!msg || msg.is_system || !msg.mes) continue;
        const text = msg.mes.length > CONTEXT_CHARS_PER_MESSAGE ? `…${msg.mes.slice(-CONTEXT_CHARS_PER_MESSAGE)}` : msg.mes;
        lines.unshift(`${msg.name}: ${text}`);
    }
    return lines.join('\n\n') || '(start of story)';
}

/** The filled-in check prompt for the user message at `index`. */
export function buildCheckPrompt(index) {
    const template = extensionSettings.customAutoRollPrompt || DEFAULT_AUTO_ROLL_PROMPT;
    const filled = template
        .replaceAll('{{attributes}}', describeAttributes(getAttributes()))
        .replaceAll('{{skills}}', describeSkills(getSkills()))
        .replaceAll('{{context}}', buildContext(index))
        .replaceAll('{{lastMessage}}', chat[index]?.mes || '');
    return substituteParams(filled);
}

async function requestDecision(index) {
    const prompt = buildCheckPrompt(index);
    const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: 'Respond with the JSON object only.' }
    ];

    const response = extensionSettings.generationMode === 'external'
        ? await generateWithExternalAPI(messages)
        : await safeGenerateRaw({ prompt: messages, quietToLoud: false });

    return parseDecision(response);
}

/**
 * Turns the model's reply into a check request, or null if no roll is needed.
 * Unknown attributes/difficulties fall back to sensible defaults; the user can
 * still change them in the confirmation dialog.
 */
export function parseDecision(text) {
    if (!text) return null;
    const jsonText = extractJSONFromText(String(text)) || String(text);
    const match = jsonText.match(/\{[\s\S]*\}/);
    const data = repairJSON(match ? match[0] : jsonText);
    if (!data || data.roll !== true) return null;

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

function buildDialog(decision) {
    const attributes = getAttributes();
    const skills = getSkills();
    const suggested = decision.skillName ? findSkill(decision.skillName) : null;

    const attributeOptions = attributes.map(attr => `<option value="${escapeHtml(attr.id)}" ${attr.id === decision.attributeId ? 'selected' : ''}>${escapeHtml(attr.name)} ${attr.value} (${formatTarget(attr.roll)})</option>`).join('');

    let skillOptions = `<option value="">${escapeHtml(t('autoRoll.noSkill', 'None'))}</option>`;
    skillOptions += skills.map(skill => `<option value="skill:${escapeHtml(skill.key)}" ${suggested?.key === skill.key ? 'selected' : ''}>${escapeHtml(skill.name)} ${formatModifier(skill.level)}</option>`).join('');
    // A skill the model asked for that the character doesn't have: offer it untrained (only when skills are in use).
    if (decision.skillName && !suggested && skills.length) {
        skillOptions += `<option value="untrained:${escapeHtml(decision.skillName)}" selected>${escapeHtml(decision.skillName)} (${escapeHtml(t('autoRoll.untrained', 'untrained'))} ${formatModifier(UNTRAINED_PENALTY)})</option>`;
    }

    const difficultyOptions = Object.entries(DIFFICULTIES).map(([id, d]) => `<option value="${id}" ${id === decision.difficulty ? 'selected' : ''}>${escapeHtml(t(`autoRoll.difficulty.${id}`, d.label))} (${formatModifier(d.modifier)})</option>`).join('');

    const $dialog = $(`
        <div class="rpg-roll-prompt">
            <h3><i class="fa-solid fa-dice-d20"></i> ${escapeHtml(t('autoRoll.dialogTitle', 'Roll for it?'))}</h3>
            ${decision.reason ? `<p class="rpg-roll-reason">${escapeHtml(decision.reason)}</p>` : ''}
            <div class="rpg-roll-fields">
                <label><span>${escapeHtml(t('autoRoll.attribute', 'Attribute'))}</span><select class="text_pole" data-roll="attribute">${attributeOptions}</select></label>
                ${skills.length ? `<label><span>${escapeHtml(t('autoRoll.skill', 'Skill'))}</span><select class="text_pole" data-roll="skill">${skillOptions}</select></label>` : ''}
                <label><span>${escapeHtml(t('autoRoll.difficulty', 'Difficulty'))}</span><select class="text_pole" data-roll="difficulty">${difficultyOptions}</select></label>
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
            `<div>${escapeHtml(t('autoRoll.rollUnder', 'Roll 3d6 under or equal to'))} <strong>${target.target}</strong> <span class="rpg-roll-chance">(${chance}%)</span></div>`
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
async function askToRoll(decision) {
    const { $dialog, readChoice } = buildDialog(decision);
    const result = await callGenericPopup($dialog, POPUP_TYPE.CONFIRM, '', {
        okButton: t('autoRoll.roll', 'Roll'),
        cancelButton: t('autoRoll.skip', "Don't roll")
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
    const title = roll.success ? t('autoRoll.success', 'Success') : t('autoRoll.failure', 'Failure');
    const detail = `${summarizeRoll(roll)} (${roll.dice.join(' + ')})`;
    (roll.success ? toastr.success : toastr.error)(detail, `🎲 ${title}`, { timeOut: 6000 });
}
