/**
 * Long tasks: work that takes hours, days or weeks, or the same thing done
 * over and over (training, crafting, searching a library, standing watch).
 *
 * The task is split into a few stretches and each stretch is one 3d6 check
 * against the same target. How many succeed decides how the whole task went:
 *
 *   score = successes + critical successes − critical failures
 *   score > stretches       → exceptional (everything worked, and something went brilliantly)
 *   score = stretches       → success
 *   score > half            → mostly (done, with setbacks)
 *   score > 0               → partial (some of it got done)
 *   otherwise               → failure
 *
 * Pure module (no SillyTavern imports). See docs/MECHANICS.md "Long tasks".
 */

import { resolveCheck, rollDice, successChance } from './rules.js';

export const MIN_STRETCHES = 1;
export const MAX_STRETCHES = 5;
export const DEFAULT_STRETCHES = 3;

/** Outcome tiers, best first. `guide` tells the AI how to narrate the whole task. */
export const TASK_OUTCOMES = {
    exceptional: { label: 'Exceptional', guide: 'Everything went to plan and something went remarkably well: the result is better than hoped, or there is an unexpected bonus.' },
    success: { label: 'Success', guide: 'The task is done as intended, without real trouble.' },
    mostly: { label: 'Mostly successful', guide: 'The task is done, but the failed stretches caused setbacks: lost time, a mistake to live with, a cost or a complication.' },
    partial: { label: 'Partial success', guide: 'Only part of the task got done; the failed stretches went badly. Some progress, but it is unfinished or flawed.' },
    failure: { label: 'Failure', guide: 'The task did not work out. The time is spent anyway, and a critical failure means something went wrong on top of that.' }
};

export function clampStretches(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return DEFAULT_STRETCHES;
    return Math.min(MAX_STRETCHES, Math.max(MIN_STRETCHES, n));
}

/** The outcome tier for a set of stretch results ({success, critical}). */
export function taskOutcome(results) {
    const n = results.length;
    if (!n) return 'failure';
    const score = results.reduce((sum, r) => sum + (r.success ? 1 : 0) + (r.critical === 'success' ? 1 : 0) - (r.critical === 'failure' ? 1 : 0), 0);
    if (score > n) return 'exceptional';
    if (score === n) return 'success';
    if (score > n / 2) return 'mostly';
    if (score > 0) return 'partial';
    return 'failure';
}

/**
 * Rolls every stretch.
 * @param {number} target - the 3d6 target number
 * @param {number} stretches
 * @param {() => number} [rng]
 * @returns {{ results: object[], successes: number, outcome: string }}
 */
export function resolveTask(target, stretches, rng = Math.random) {
    const n = clampStretches(stretches);
    const results = Array.from({ length: n }, () => {
        const r = resolveCheck(target, rollDice(3, 6, rng));
        return { dice: r.dice, total: r.total, success: r.success, margin: r.margin, critical: r.critical };
    });
    return { results, successes: results.filter(r => r.success).length, outcome: taskOutcome(results) };
}

/**
 * Exact chance of each outcome for a target and number of stretches.
 * @returns {Record<string, number>} outcome id → probability (0..1)
 */
export function outcomeOdds(target, stretches) {
    const n = clampStretches(stretches);
    const crit = 1 / 216;
    const p = successChance(target);
    // Each stretch: critical success, plain success, plain failure, critical failure.
    const kinds = [
        { prob: crit, r: { success: true, critical: 'success' } },
        { prob: Math.max(0, p - crit), r: { success: true, critical: null } },
        { prob: Math.max(0, 1 - p - crit), r: { success: false, critical: null } },
        { prob: crit, r: { success: false, critical: 'failure' } }
    ];
    const odds = Object.fromEntries(Object.keys(TASK_OUTCOMES).map(k => [k, 0]));
    const walk = (i, prob, results) => {
        if (prob === 0) return;
        if (i === n) { odds[taskOutcome(results)] += prob; return; }
        for (const k of kinds) walk(i + 1, prob * k.prob, [...results, k.r]);
    };
    walk(0, 1, []);
    return odds;
}
