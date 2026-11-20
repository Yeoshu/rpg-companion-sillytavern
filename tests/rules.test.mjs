// Run with: npm test   (or: node --test tests/)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    attributeRoll, checkTarget, resolveCheck, successChance, rollDice,
    normalizeDifficulty, formatTarget, formatModifier, UNTRAINED_PENALTY,
} from '../src/systems/mechanics/rules.js';

test('attribute roll is 9 + attribute/5, uncapped', () => {
    assert.equal(attributeRoll(10), 11); // ordinary adult
    assert.equal(attributeRoll(15), 12);
    assert.equal(attributeRoll(20), 13);
    assert.equal(attributeRoll(13), 12); // 2.6 rounds to 3
    assert.equal(attributeRoll(12), 11); // 2.4 rounds to 2
    assert.equal(attributeRoll(60), 21); // no cap
    assert.equal(attributeRoll(0), 9);
    assert.equal(attributeRoll(-5), 9); // negative treated as 0
    assert.equal(attributeRoll('abc'), 9);
});

test('check target combines attribute, skill, difficulty and situational modifiers', () => {
    assert.deepEqual(checkTarget({ attribute: 10 }), { base: 11, skill: 0, difficulty: 0, situational: 0, target: 11 });
    assert.equal(checkTarget({ attribute: 15, skillLevel: 2, difficulty: 'hard' }).target, 12 + 2 - 2);
    assert.equal(checkTarget({ attribute: 10, untrained: true }).target, 11 + UNTRAINED_PENALTY);
    assert.equal(checkTarget({ attribute: 10, skillLevel: 5, untrained: true }).skill, UNTRAINED_PENALTY);
    assert.equal(checkTarget({ attribute: 10, difficulty: 'extreme', situational: 1 }).target, 11 - 6 + 1);
    assert.equal(checkTarget({ attribute: 10, skillLevel: -4 }).skill, 0); // skill levels never go negative
});

test('difficulty names are normalized', () => {
    assert.equal(normalizeDifficulty('Very Hard'), 'veryHard');
    assert.equal(normalizeDifficulty('very-hard'), 'veryHard');
    assert.equal(normalizeDifficulty('EASY'), 'easy');
    assert.equal(normalizeDifficulty('nonsense'), 'average');
    assert.equal(normalizeDifficulty(undefined), 'average');
});

test('3d6 roll-under resolution with margin', () => {
    const hit = resolveCheck(11, [3, 4, 2]);
    assert.equal(hit.total, 9);
    assert.equal(hit.success, true);
    assert.equal(hit.margin, 2);
    assert.equal(hit.critical, null);

    const exact = resolveCheck(11, [5, 5, 1]);
    assert.equal(exact.success, true);
    assert.equal(exact.margin, 0);

    const miss = resolveCheck(11, [6, 5, 2]);
    assert.equal(miss.success, false);
    assert.equal(miss.margin, -2);
});

test('natural 3 always succeeds, natural 18 always fails', () => {
    const lucky = resolveCheck(1, [1, 1, 1]);
    assert.equal(lucky.success, true);
    assert.equal(lucky.critical, 'success');

    const unlucky = resolveCheck(25, [6, 6, 6]);
    assert.equal(unlucky.success, false);
    assert.equal(unlucky.critical, 'failure');
});

test('success chance follows the 3d6 curve', () => {
    assert.equal(successChance(10), 0.5);
    assert.equal(successChance(11), 135 / 216);
    assert.equal(successChance(0), 1 / 216); // only a natural 3
    assert.equal(successChance(30), 215 / 216); // a natural 18 still fails
    assert.ok(successChance(12) > successChance(11));
});

test('dice use the supplied random source', () => {
    assert.deepEqual(rollDice(3, 6, () => 0), [1, 1, 1]);
    assert.deepEqual(rollDice(2, 20, () => 0.999), [20, 20]);
});

test('formatting helpers', () => {
    assert.equal(formatTarget(11), '11-');
    assert.equal(formatModifier(2), '+2');
    assert.equal(formatModifier(0), '+0');
    assert.equal(formatModifier(-3), '−3');
});
