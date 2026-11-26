// Long tasks. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { clampStretches, outcomeOdds, resolveTask, taskOutcome, TASK_OUTCOMES } from '../src/systems/mechanics/longTask.js';
import { seededRng } from '../src/systems/mechanics/combat/balance.js';

const ok = { success: true, critical: null };
const no = { success: false, critical: null };
const crit = { success: true, critical: 'success' };
const fumble = { success: false, critical: 'failure' };

test('outcome from the stretches', () => {
    assert.equal(taskOutcome([ok, ok, ok]), 'success');
    assert.equal(taskOutcome([ok, crit, ok]), 'exceptional');
    assert.equal(taskOutcome([ok, no, ok]), 'mostly');
    assert.equal(taskOutcome([ok, no, no]), 'partial');
    assert.equal(taskOutcome([no, no, no]), 'failure');
    assert.equal(taskOutcome([ok, fumble, no]), 'failure');     // a fumble cancels a success
    assert.equal(taskOutcome([ok, no]), 'partial');              // half is not most
    assert.equal(taskOutcome([ok, ok, no, no]), 'partial');
    assert.equal(taskOutcome([ok, ok, ok, no]), 'mostly');
    assert.equal(taskOutcome([ok]), 'success');
    assert.equal(taskOutcome([no]), 'failure');
});

test('stretches are clamped to 1..5', () => {
    assert.equal(clampStretches(0), 1);
    assert.equal(clampStretches(9), 5);
    assert.equal(clampStretches('2'), 2);
    assert.equal(clampStretches('x'), 3);
});

test('resolveTask rolls each stretch against the same target', () => {
    const r = resolveTask(12, 4, seededRng(5));
    assert.equal(r.results.length, 4);
    assert.equal(r.successes, r.results.filter(s => s.success).length);
    assert.ok(r.results.every(s => s.dice.length === 3 && s.total === s.dice.reduce((a, b) => a + b, 0)));
    assert.equal(r.outcome, taskOutcome(r.results));
});

test('the odds add up to 1 and match a simulation', () => {
    for (const [target, n] of [[10, 1], [12, 3], [8, 5]]) {
        const odds = outcomeOdds(target, n);
        assert.ok(Math.abs(Object.values(odds).reduce((a, b) => a + b, 0) - 1) < 1e-9);
        assert.deepEqual(Object.keys(odds), Object.keys(TASK_OUTCOMES));
        const rng = seededRng(target * 10 + n);
        const counts = Object.fromEntries(Object.keys(odds).map(k => [k, 0]));
        const runs = 20000;
        for (let i = 0; i < runs; i++) counts[resolveTask(target, n, rng).outcome] += 1;
        for (const k of Object.keys(odds)) assert.ok(Math.abs(counts[k] / runs - odds[k]) < 0.015, `${target}/${n} ${k}: ${counts[k] / runs} vs ${odds[k]}`);
    }
});
