/**
 * Task: the "Task" button above the chat input, for long or repetitive work
 * (a week of training, crafting a bow, searching the archive all night).
 *
 * Like Attempt, it takes the typed message, optionally asks the model once
 * which check fits (plus how long the task takes and how many stretches to
 * roll), lets the user adjust that and roll, and sends the message with the
 * result attached. The AI is then told to skip ahead through that time and
 * summarize how it went (see describeRollForPrompt in mechanics/rollState.js).
 *
 * Rules: mechanics/longTask.js. Docs: docs/MECHANICS.md "Long tasks".
 */

import { substituteParams } from '../../../../../../../script.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../../../../popup.js';
import { extensionSettings } from '../../core/state.js';
import { saveChatData } from '../../core/persistence.js';
import { i18n } from '../../core/i18n.js';
import { generateWithExternalAPI } from '../generation/apiClient.js';
import { safeGenerateRaw } from '../../utils/responseExtractor.js';
import { getAttributes, getSkills } from '../mechanics/character.js';
import { queueRoll, summarizeRoll } from '../mechanics/rollState.js';
import {
    DEFAULT_STRETCHES, MAX_STRETCHES, MIN_STRETCHES, TASK_OUTCOMES, clampStretches, outcomeOdds, resolveTask
} from '../mechanics/longTask.js';
import {
    buildContext, checkFieldsHtml, describeAttributes, describeSkills, interpretChoice, parseSuggestion,
    readCheckChoice, targetSummaryHtml
} from './attempt.js';

export const DEFAULT_TASK_PROMPT = `You are the rules referee for a tabletop-style roleplay. {{user}} is starting a long or repetitive task (it takes hours, days or longer) and will roll for it. Choose the check and how long it takes.

{{user}}'s attributes: {{attributes}}
{{user}}'s skills: {{skills}}
Difficulty levels: easy, average, hard, veryHard, extreme

Recent story:
{{context}}

{{user}}'s task:
{{action}}

Choose the single most relevant attribute. If one of {{user}}'s skills applies, name it. If the task clearly needs a trained skill that {{user}} does not have, name that skill anyway (it will be rolled untrained). Otherwise use null. Judge the difficulty from the situation in the story. Say how long the task takes in a few words (use what {{user}} said if they gave a time). Split it into 1 to 5 stretches to roll for: 1 for a single sitting, more for longer or more varied work.

Respond with ONLY a JSON object and nothing else:
{"attribute": "<attribute from the list>", "skill": "<skill name or null>", "difficulty": "<difficulty level>", "duration": "<how long, e.g. three days>", "stretches": <1-5>, "reason": "<what {{user}} is doing, in a few words>"}`;

function t(key, fallback) {
    return i18n.getTranslation(key) || fallback;
}

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

let busy = false;

function setButtonBusy(isBusy) {
    $('#rpg-task-button')
        .prop('disabled', isBusy)
        .toggleClass('rpg-busy', isBusy)
        .find('i').toggleClass('fa-hourglass-half', !isBusy).toggleClass('fa-spinner fa-spin', isBusy);
}

function isGenerating() {
    return $('#mes_stop').is(':visible');
}

/** The filled-in task prompt for the typed action. */
export function buildTaskPrompt(action) {
    const template = extensionSettings.customTaskPrompt || DEFAULT_TASK_PROMPT;
    const filled = template
        .replaceAll('{{attributes}}', describeAttributes(getAttributes()))
        .replaceAll('{{skills}}', describeSkills(getSkills()))
        .replaceAll('{{context}}', buildContext())
        .replaceAll('{{action}}', action);
    return substituteParams(filled);
}

/** Like parseSuggestion, plus duration and stretches. */
export function parseTaskSuggestion(text) {
    const base = parseSuggestion(text);
    if (!base) return null;
    let data = {};
    try {
        const match = String(text).match(/\{[\s\S]*\}/);
        data = match ? JSON.parse(match[0]) : {};
    } catch {
        const duration = String(text).match(/"duration"\s*:\s*"([^"]*)"/);
        const stretches = String(text).match(/"stretches"\s*:\s*"?(\d+)/);
        data = { duration: duration?.[1], stretches: stretches?.[1] };
    }
    return {
        ...base,
        duration: typeof data.duration === 'string' ? data.duration.trim().slice(0, 80) : '',
        stretches: clampStretches(data.stretches ?? DEFAULT_STRETCHES)
    };
}

async function requestSuggestion(action) {
    const messages = [
        { role: 'system', content: buildTaskPrompt(action) },
        { role: 'user', content: 'Respond with the JSON object only.' }
    ];
    const response = extensionSettings.generationMode === 'external'
        ? await generateWithExternalAPI(messages)
        : await safeGenerateRaw({ prompt: messages, quietToLoud: false });
    return parseTaskSuggestion(response);
}

/** Rolls the task and returns the record stored on the message. */
export function performTask(choice, rng) {
    const { attribute, skill, difficulty, target } = interpretChoice(choice);
    const result = resolveTask(target.target, choice.stretches, rng);
    return {
        kind: 'task',
        attribute: { id: attribute.id, name: attribute.name, value: attribute.value },
        skill,
        difficulty,
        base: target.base,
        target: target.target,
        duration: String(choice.duration || '').trim(),
        stretches: result.results,
        successes: result.successes,
        outcome: result.outcome,
        reason: choice.reason || '',
        timestamp: Date.now()
    };
}

function oddsHtml(choice, stretches) {
    const { target } = interpretChoice(choice);
    const odds = outcomeOdds(target.target, stretches);
    const pct = p => (p > 0 && p < 0.005 ? '<1' : Math.round(p * 100));
    const good = odds.exceptional + odds.success;
    return `<div class="rpg-task-odds"><small>${escapeHtml(t('task.odds', 'Odds'))}: `
        + `${escapeHtml(t('task.outcome.success', TASK_OUTCOMES.success.label))} ${pct(good)}% · `
        + `${escapeHtml(t('task.outcome.mostly', TASK_OUTCOMES.mostly.label))} ${pct(odds.mostly)}% · `
        + `${escapeHtml(t('task.outcome.partial', TASK_OUTCOMES.partial.label))} ${pct(odds.partial)}% · `
        + `${escapeHtml(t('task.outcome.failure', TASK_OUTCOMES.failure.label))} ${pct(odds.failure)}%</small></div>`;
}

/**
 * Shows the dialog.
 * @returns {Promise<object|null>} the choice, or null if cancelled
 */
async function askToRoll(suggestion) {
    const stretchOptions = Array.from({ length: MAX_STRETCHES - MIN_STRETCHES + 1 }, (_, i) => i + MIN_STRETCHES)
        .map(n => `<option value="${n}" ${n === suggestion.stretches ? 'selected' : ''}>${n}</option>`).join('');
    const extra = `
        <label><span>${escapeHtml(t('task.duration', 'Takes'))}</span><input type="text" class="text_pole" data-roll="duration" value="${escapeHtml(suggestion.duration)}" placeholder="${escapeHtml(t('task.durationHint', 'e.g. three days'))}"></label>
        <label><span>${escapeHtml(t('task.stretches', 'Rolls'))}</span><select class="text_pole" data-roll="stretches">${stretchOptions}</select></label>`;
    const $dialog = $(`
        <div class="rpg-roll-prompt rpg-task-prompt">
            <h3><i class="fa-solid fa-hourglass-half"></i> ${escapeHtml(t('task.dialogTitle', 'Task'))}</h3>
            ${suggestion.reason ? `<p class="rpg-roll-reason">${escapeHtml(suggestion.reason)}</p>` : ''}
            ${checkFieldsHtml(suggestion, extra)}
            <div class="rpg-roll-target"></div>
            <small class="rpg-note">${escapeHtml(t('task.explain', 'The task is split into stretches, one 3d6 roll each. How many succeed decides how it went; the story then skips ahead through the time and sums it up.'))}</small>
        </div>
    `);
    const readChoice = () => ({
        ...readCheckChoice($dialog),
        duration: String($dialog.find('[data-roll="duration"]').val() || '').trim(),
        stretches: clampStretches($dialog.find('[data-roll="stretches"]').val())
    });
    const refresh = () => {
        const choice = readChoice();
        $dialog.find('.rpg-roll-target').html(
            targetSummaryHtml(choice, { label: t('task.eachRoll', 'Each roll: 3d6 under or equal to') }) + oddsHtml(choice, choice.stretches)
        );
    };
    $dialog.on('change input', 'select, input', refresh);
    refresh();

    const result = await callGenericPopup($dialog, POPUP_TYPE.CONFIRM, '', {
        okButton: t('task.roll', 'Roll and send'),
        cancelButton: t('attempt.cancel', 'Cancel')
    });
    return result === POPUP_RESULT.AFFIRMATIVE ? readChoice() : null;
}

function showTaskResult(roll) {
    const outcome = t(`task.outcome.${roll.outcome}`, TASK_OUTCOMES[roll.outcome]?.label || roll.outcome);
    const good = roll.outcome === 'exceptional' || roll.outcome === 'success' || roll.outcome === 'mostly';
    const detail = `${summarizeRoll(roll)} (${roll.stretches.map(s => s.total).join(', ')})`;
    (good ? toastr.success : toastr.error)(escapeHtml(detail), `⏳ ${escapeHtml(outcome)}`, { timeOut: 6000 });
}

/** Click handler for the Task button. */
export async function startTask() {
    if (!extensionSettings.enabled || busy) return;

    const $input = $('#send_textarea');
    const action = String($input.val() || '').trim();
    if (!action) {
        toastr.info(t('task.typeFirst', 'Type the task first (what you do, and for how long), then click Task.'));
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
        let suggestion = { attributeId: attributes[0].id, skillName: null, difficulty: 'average', reason: '', duration: '', stretches: DEFAULT_STRETCHES };
        if (extensionSettings.attemptSuggest !== false) {
            setButtonBusy(true);
            try {
                suggestion = (await requestSuggestion(action)) || suggestion;
            } catch (error) {
                console.error('[RPG Companion] Task suggestion failed:', error);
                toastr.warning(t('attempt.suggestFailed', 'Could not get a suggested check; pick one yourself.'));
            } finally {
                setButtonBusy(false);
            }
        }

        const choice = await askToRoll(suggestion);
        if (!choice) return; // cancelled: the typed text stays in the box

        const roll = performTask({ ...choice, reason: suggestion.reason || action.slice(0, 200) });
        queueRoll(roll);
        saveChatData();
        showTaskResult(roll);
        $(document).trigger('rpg:diceRollChanged');

        // Send the message; the queued roll attaches to it on MESSAGE_SENT.
        $('#send_but').trigger('click');
    } finally {
        busy = false;
    }
}
