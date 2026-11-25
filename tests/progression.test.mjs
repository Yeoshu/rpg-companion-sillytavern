// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_PROGRESSION, normalizeProgression, expToNextLevel, questReward,
    enemyLevelMultiplier, enemyReward, addExp, earlyMultiplier,
} from '../src/systems/mechanics/progression.js';

const S = normalizeProgression({ earlyBoost: 1 }); // without the fast start
const FAST = normalizeProgression({});

test('EXP bar grows with level', () => {
    assert.equal(expToNextLevel(1, S), 100);
    assert.equal(expToNextLevel(5, S), 500);
    assert.equal(expToNextLevel(0, S), 100);
});

test('fast start: rewards ×2 at level 1, fading to ×1 after the early levels', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 9].map(l => earlyMultiplier(l, FAST)), [2, 1.75, 1.5, 1.25, 1, 1]);
    assert.equal(earlyMultiplier(1, S), 1);
    assert.equal(questReward('main', 1, FAST, () => 0), 40);   // 20% × 2 of 100
    assert.equal(enemyReward(3, 3, FAST), 23);                 // 5% × 1.5 of 300 = 22.5
    assert.equal(enemyReward(5, 5, FAST), 25);                 // past the early levels
});

test('quest rewards are a percentage of the current bar', () => {
    assert.equal(questReward('main', 1, S, () => 0), 20);
    assert.equal(questReward('main', 1, S, () => 0.999), 30);
    assert.equal(questReward('main', 4, S, () => 0.5), 100); // 25% of 400
    assert.equal(questReward('side', 1, S, () => 0), 5);
    assert.equal(questReward('side', 2, S, () => 1), 20);  // 10% of 200
});

test('enemy reward scales with the level difference', () => {
    assert.equal(enemyLevelMultiplier(3, 3, S), 1);
    assert.ok(enemyLevelMultiplier(5, 3, S) > 1.6 && enemyLevelMultiplier(5, 3, S) < 1.7);
    assert.ok(enemyLevelMultiplier(1, 3, S) < 0.6);
    assert.equal(enemyReward(1, 1, S), 5);       // 5% of 100
    assert.equal(enemyReward(2, 1, S), 7);       // 6.5 rounds to 7 (Math.round)
    assert.equal(enemyReward(undefined, 2, S), 10); // unknown level = even match
    assert.equal(enemyReward(1, 20, S), 1);      // trivial foes still give at least 1
});

test('addExp levels up, carries leftover and grants points', () => {
    assert.deepEqual(addExp({ level: 1, exp: 90, points: 0 }, 25, S),
        { level: 2, exp: 15, points: 5, levelsGained: 1, pointsGained: 5 });
    // 100 (lv1) + 200 (lv2) = 300 → level 3 with 10 left
    assert.deepEqual(addExp({ level: 1, exp: 0, points: 1 }, 310, S),
        { level: 3, exp: 10, points: 11, levelsGained: 2, pointsGained: 10 });
    assert.equal(addExp({ level: 1, exp: 0, points: 0 }, 50, S).levelsGained, 0);
});

test('settings are normalized', () => {
    const n = normalizeProgression({ mainQuestMin: 40, mainQuestMax: 10, pointsPerLevel: '5', enemyLevelFactor: 0.5, expBase: -3 });
    assert.equal(n.mainQuestMin, 10);
    assert.equal(n.mainQuestMax, 40);
    assert.equal(n.pointsPerLevel, 5);
    assert.equal(n.enemyLevelFactor, DEFAULT_PROGRESSION.enemyLevelFactor);
    assert.equal(n.expBase, DEFAULT_PROGRESSION.expBase);
    assert.equal(addExp({ level: 1, exp: 0, points: 0 }, 100, normalizeProgression({ pointsPerLevel: 5 })).points, 5);
});
