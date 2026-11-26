// Built-in class templates. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_CLASSES } from '../src/systems/mechanics/classes.js';
import { normalizeCombatSettings, normalizeStatBlock } from '../src/systems/mechanics/combat/catalog.js';
import { abilityCost, apCap, levelBudget, scaleToBudget, statBlockPoints } from '../src/systems/mechanics/combat/costs.js';

const heroic = normalizeCombatSettings({});
const gritty = normalizeCombatSettings({ powerPreset: 'gritty' });
const opts = { skillCost: 2, attributeCost: 1 };

test('every built-in class is a valid level-1 build within the Heroic budget', () => {
    assert.ok(BUILTIN_CLASSES.length >= 4);
    const ids = new Set();
    for (const c of BUILTIN_CLASSES) {
        assert.ok(!ids.has(c.id), c.id);
        ids.add(c.id);
        const block = normalizeStatBlock(c);
        assert.equal(block.level, 1);
        assert.equal(block.abilities.length, c.abilities.length, `${c.name}: every ability survives normalizing`);
        const spent = statBlockPoints(block, opts).total;
        assert.ok(spent <= levelBudget(1, 5, heroic), `${c.name}: ${spent} CP`);
        assert.ok(spent >= levelBudget(1, 5, heroic) * 0.7, `${c.name}: uses most of the budget (${spent} CP)`);
        for (const a of block.abilities) assert.ok(abilityCost(a).ap <= apCap(1, heroic), `${c.name} ${a.name}: ${abilityCost(a).ap} AP`);
    }
});

test('on Gritty the classes trim down to the 50 CP budget', () => {
    for (const c of BUILTIN_CLASSES) {
        const block = normalizeStatBlock(c);
        scaleToBudget(block, levelBudget(1, 5, gritty), { tolerance: 1, ...opts });
        assert.ok(statBlockPoints(block, opts).total <= 50, c.name);
        assert.ok(block.abilities.length >= 1, c.name);
    }
});
