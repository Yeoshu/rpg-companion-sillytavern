/**
 * Where dice rolls live and how they reach the prompt.
 *
 * A roll belongs to one user message and is stored on it (message.extra), so:
 *  - it is saved with the chat it was made in, never leaking into other chats;
 *  - it keeps applying to swipes/regenerations of the reply to that message;
 *  - it stops applying as soon as the user sends another message.
 *
 * A roll made before typing (manual roller) is "queued" for the chat and
 * attaches to the next message the user sends.
 *
 * The roll text is injected through its own extension prompt, set right before
 * each main generation (from the generate interceptor), so it never ends up in
 * tracker-update requests or encounter prompts.
 */

import { chat, saveChatDebounced, setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../../../../../../../script.js';
import { getContext } from '../../../../../../extensions.js';
import { extensionSettings, queuedDiceRoll, setQueuedDiceRoll } from '../../core/state.js';
import { DIFFICULTIES, formatModifier, formatTarget } from './rules.js';
import { TASK_OUTCOMES } from './longTask.js';

const PROMPT_KEY = 'rpg-companion-dice';
const ROLL_FIELD = 'rpg_dice_roll';

export function getQueuedRoll() {
    return queuedDiceRoll;
}

export function queueRoll(roll) {
    setQueuedDiceRoll(roll);
}

/** Index of the most recent user message, or -1. */
export function latestUserMessageIndex() {
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i]?.is_user && !chat[i]?.is_system) return i;
    }
    return -1;
}

export function getRollForMessage(index) {
    return chat[index]?.extra?.[ROLL_FIELD] || null;
}

export function attachRoll(index, roll) {
    const message = chat[index];
    if (!message) return;
    message.extra = message.extra || {};
    message.extra[ROLL_FIELD] = roll;
    saveChatDebounced();
}

/** The roll that applies to the reply currently being written, if any. */
export function getActiveRoll() {
    return getRollForMessage(latestUserMessageIndex());
}

/**
 * Moves a queued roll onto a just-sent user message.
 * @returns {boolean} true if a roll was attached
 */
export function attachQueuedRollTo(index) {
    const roll = getQueuedRoll();
    if (!roll || !chat[index]?.is_user) return false;
    attachRoll(index, roll);
    setQueuedDiceRoll(null);
    return true;
}

/**
 * Clears what the "Last Roll" display shows: the queued roll if there is one,
 * otherwise the roll attached to the latest user message.
 */
export function clearDisplayedRoll() {
    if (getQueuedRoll()) {
        setQueuedDiceRoll(null);
        return;
    }
    const index = latestUserMessageIndex();
    if (chat[index]?.extra?.[ROLL_FIELD]) {
        delete chat[index].extra[ROLL_FIELD];
        saveChatDebounced();
    }
}

/** "Skill 12, Smithing +2, Hard -3" */
function checkParts(roll) {
    const parts = [`${roll.attribute.name} ${roll.attribute.value} (${formatTarget(roll.base)})`];
    if (roll.skill) {
        parts.push(roll.skill.trained
            ? `${roll.skill.name} ${formatModifier(roll.skill.modifier)}`
            : `${roll.skill.name} untrained ${formatModifier(roll.skill.modifier)}`);
    }
    const difficulty = DIFFICULTIES[roll.difficulty] || DIFFICULTIES.average;
    parts.push(`${difficulty.label} ${formatModifier(difficulty.modifier)}`);
    return parts.join(', ');
}

/** The AI's instructions for a long task (see mechanics/longTask.js). */
function describeTaskForPrompt(roll, userName) {
    const outcome = TASK_OUTCOMES[roll.outcome] || TASK_OUTCOMES.failure;
    const n = roll.stretches.length;
    const lines = roll.stretches.map((s, i) => `  Stretch ${i + 1} of ${n}: rolled ${s.total} (${s.dice.join(' + ')}): ${outcomeText(s)}`);
    const what = roll.reason ? `: ${roll.reason}` : '';
    const time = roll.duration ? ` over ${roll.duration}` : '';
    return `[Long task] ${userName} works at a long or repetitive task${time}${what}.\n`
        + `It is split into ${n} stretch${n === 1 ? '' : 'es'} in order, one roll each. Check: ${checkParts(roll)}. Needed 3d6 ≤ ${roll.target}.\n`
        + `${lines.join('\n')}\n`
        + `Overall: ${outcome.label.toUpperCase()} (${roll.successes} of ${n} stretches succeeded). ${outcome.guide}\n`
        + `Skip ahead through this time instead of playing it out: summarize it${roll.duration ? ` (${roll.duration})` : ''} as a short montage, in order, `
        + 'with each stretch going the way its roll says (a bigger margin means it went more smoothly or worse). Do not write it scene by scene or with long dialogue. '
        + 'End once the time has passed, with a brief summary of how it went: what was achieved, what went wrong, and what it cost. '
        + `${roll.duration ? `Move the story's time and date forward by ${roll.duration}. ` : 'Move the story\'s time and date forward accordingly. '}`
        + 'The rolls are final: do not re-roll, soften or ignore them.';
}

function outcomeText(roll) {
    if (roll.critical === 'success') return 'CRITICAL SUCCESS (natural 3)';
    if (roll.critical === 'failure') return 'CRITICAL FAILURE (natural 18)';
    return roll.success ? `SUCCESS by ${roll.margin}` : `FAILURE by ${Math.abs(roll.margin)}`;
}

/** Short one-line summary for the panel. */
export function summarizeRoll(roll) {
    if (!roll) return '';
    if (roll.kind === 'check') {
        const skill = roll.skill ? ` (${roll.skill.name})` : '';
        return `${roll.attribute.name}${skill}: ${roll.total} vs ${formatTarget(roll.target)} ${roll.success ? '✓' : '✗'}`;
    }
    if (roll.kind === 'task') {
        const skill = roll.skill ? ` (${roll.skill.name})` : '';
        const outcome = TASK_OUTCOMES[roll.outcome]?.label || roll.outcome;
        return `${roll.attribute.name}${skill}: ${roll.stretches.map(s => (s.success ? '✓' : '✗')).join('')} ${outcome}`;
    }
    return `${roll.formula}: ${roll.total}`;
}

/** The text the AI sees for a roll. */
export function describeRollForPrompt(roll, userName = getContext().name1) {
    if (!roll) return '';
    // "Lem (she/her)" when the sheet says, so the reply gets the pronouns right.
    const pronouns = String(extensionSettings.combatSheet?.pronouns ?? '').trim();
    if (pronouns) userName = `${userName} (${pronouns})`;

    if (roll.kind === 'task') return describeTaskForPrompt(roll, userName);

    if (roll.kind === 'check') {
        const parts = [`${roll.attribute.name} ${roll.attribute.value} (${formatTarget(roll.base)})`];
        if (roll.skill) {
            parts.push(roll.skill.trained
                ? `${roll.skill.name} ${formatModifier(roll.skill.modifier)}`
                : `${roll.skill.name} untrained ${formatModifier(roll.skill.modifier)}`);
        }
        const difficulty = DIFFICULTIES[roll.difficulty] || DIFFICULTIES.average;
        parts.push(`${difficulty.label} ${formatModifier(difficulty.modifier)}`);
        const attempt = roll.reason ? `: ${roll.reason}` : '';

        return `[Dice check] ${userName} attempted an action that required a roll${attempt}.\n`
            + `Check: ${parts.join(', ')}. Needed 3d6 ≤ ${roll.target}, rolled ${roll.total} (${roll.dice.join(' + ')}). `
            + `Result: ${outcomeText(roll)}.\n`
            + 'Narrate the outcome of this attempt so it matches the result; a bigger margin means a cleaner success or a worse failure. '
            + 'The roll is final: do not re-roll, soften or ignore it.';
    }

    const basis = extensionSettings.trackerConfig?.userStats?.alwaysSendAttributes ? 'their attributes and this roll' : 'this roll';
    return `[Dice roll] ${userName} rolled ${roll.total} on ${roll.formula}. `
        + `Based on ${basis}, decide whether the action they attempted succeeds or fails.`;
}

/**
 * Sets (or clears) the dice prompt for the generation about to run.
 * @param {boolean} [include=true] - false clears it (quiet/impersonate generations)
 */
export function updateDiceInjection(include = true) {
    const text = include ? describeRollForPrompt(getActiveRoll()) : '';
    setExtensionPrompt(PROMPT_KEY, text, extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
}
