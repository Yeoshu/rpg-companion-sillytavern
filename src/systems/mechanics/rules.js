/**
 * Core rules: the mechanical backbone of the extension.
 *
 * A small, setting-agnostic system modelled on the HERO System's philosophy:
 *
 *  - Attributes are open-ended numbers. 10 is an ordinary adult; there is no cap.
 *  - Every check is a 3d6 roll-under: roll the target number or less to succeed.
 *    3d6 gives a bell curve, so each point of modifier matters most near the
 *    middle and luck can't swamp competence.
 *  - An attribute's roll is 9 + (attribute / 5), written like "11-".
 *    Every 5 points of attribute is +1 to the roll, forever: higher numbers
 *    keep adding more, with no plateau.
 *  - Skills ride on an attribute. A trained skill adds its level to that
 *    attribute's roll; attempting something that needs a skill you lack is
 *    harder (untrained penalty).
 *  - Circumstances (difficulty) add or subtract from the target.
 *  - A natural 3 always succeeds and a natural 18 always fails.
 *  - Margin of success/failure (target - roll) tells the narrator how well it went.
 *
 * This file has no dependencies on SillyTavern or extension state so it can be
 * reused by every feature (checks, encounters, NPCs) and unit-tested directly.
 */

/** Base of every attribute roll. */
export const BASE_ROLL = 9;
/** Attribute points per +1 to the roll. */
export const POINTS_PER_PLUS_ONE = 5;
/** Modifier for attempting a task that needs a skill the character doesn't have. */
export const UNTRAINED_PENALTY = -3;
/** The value an attribute starts at for an ordinary person. */
export const AVERAGE_ATTRIBUTE = 10;

/**
 * Difficulty levels and their modifiers to the target number.
 * Keys are stable ids (used in prompts and saved rolls); labels are for display.
 */
export const DIFFICULTIES = {
    easy: { label: 'Easy', modifier: 2 },
    average: { label: 'Average', modifier: 0 },
    hard: { label: 'Hard', modifier: -2 },
    veryHard: { label: 'Very Hard', modifier: -4 },
    extreme: { label: 'Extreme', modifier: -6 },
};

/** Accepts ids and loose spellings ("very hard", "Very-Hard") and returns a difficulty id. */
export function normalizeDifficulty(value) {
    const key = String(value ?? '').toLowerCase().replace(/[^a-z]/g, '');
    const match = Object.keys(DIFFICULTIES).find(id => id.toLowerCase() === key);
    return match || 'average';
}

/**
 * The roll for a raw attribute: 9 + attribute/5, rounded to nearest.
 * @param {number} value - attribute value (no upper limit)
 * @returns {number} target number for 3d6 roll-under
 */
export function attributeRoll(value) {
    const safe = Math.max(0, Number(value) || 0);
    return BASE_ROLL + Math.round(safe / POINTS_PER_PLUS_ONE);
}

/**
 * Works out the final target number for a check.
 * @param {object} params
 * @param {number} params.attribute - value of the attribute used
 * @param {number|null} [params.skillLevel] - level of a trained skill, or null for none
 * @param {boolean} [params.untrained] - the task needs a skill the character lacks
 * @param {string} [params.difficulty] - difficulty id
 * @param {number} [params.situational] - any extra modifier
 * @returns {{ base: number, skill: number, difficulty: number, situational: number, target: number }}
 */
export function checkTarget({ attribute, skillLevel = null, untrained = false, difficulty = 'average', situational = 0 }) {
    const base = attributeRoll(attribute);
    const skill = untrained ? UNTRAINED_PENALTY : Math.max(0, Number(skillLevel) || 0);
    const diff = DIFFICULTIES[normalizeDifficulty(difficulty)].modifier;
    const extra = Number(situational) || 0;
    return { base, skill, difficulty: diff, situational: extra, target: base + skill + diff + extra };
}

/**
 * Rolls dice. `rng` returns a float in [0, 1) and can be swapped out in tests.
 */
export function rollDice(count, sides, rng = Math.random) {
    const dice = [];
    for (let i = 0; i < count; i++) {
        dice.push(Math.floor(rng() * sides) + 1);
    }
    return dice;
}

/**
 * Resolves a 3d6 roll-under check against a target number.
 * @param {number} target
 * @param {number[]} [dice] - pre-rolled 3d6 (otherwise rolled here)
 * @returns {{ dice: number[], total: number, target: number, success: boolean, margin: number, critical: 'success'|'failure'|null }}
 */
export function resolveCheck(target, dice = rollDice(3, 6)) {
    const total = dice.reduce((sum, d) => sum + d, 0);
    let critical = null;
    let success = total <= target;
    if (total === 3) {
        critical = 'success';
        success = true;
    } else if (total === 18) {
        critical = 'failure';
        success = false;
    }
    return { dice, total, target, success, margin: target - total, critical };
}

/** Number of ways to roll each total on 3d6 (index = total). */
const WAYS_3D6 = (() => {
    const ways = new Array(19).fill(0);
    for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) for (let c = 1; c <= 6; c++) ways[a + b + c]++;
    return ways;
})();

/**
 * Chance (0..1) of succeeding at a target number, including the natural 3/18 rules.
 */
export function successChance(target) {
    let ways = 0;
    for (let total = 3; total <= 17; total++) {
        if (total === 3 || total <= target) ways += WAYS_3D6[total];
    }
    return ways / 216;
}

/** "11-" style notation used throughout the UI and prompts. */
export function formatTarget(target) {
    return `${target}-`;
}

/** "+2" / "−3" / "+0" with a real minus sign. */
export function formatModifier(value) {
    const n = Number(value) || 0;
    return n < 0 ? `−${Math.abs(n)}` : `+${n}`;
}
