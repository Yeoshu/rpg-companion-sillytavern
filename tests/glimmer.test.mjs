// Glimmers. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { glimmerChance, glimmerTargetAp, buildGlimmerPrompt, parseGlimmer } from '../src/systems/mechanics/combat/glimmer.js';
import { normalizeAbility, normalizeStatBlock, normalizeCombatSettings } from '../src/systems/mechanics/combat/catalog.js';
import { abilityCost, deriveValues } from '../src/systems/mechanics/combat/costs.js';

test('glimmer chance grows with the enemy\'s tier and level, capped', () => {
    assert.equal(glimmerChance({ level: 1, tier: 'standard' }, 1, 5), 0.05);
    assert.equal(glimmerChance({ level: 1, tier: 'minion' }, 1, 5), 0.0125);
    assert.ok(Math.abs(glimmerChance({ level: 3, tier: 'boss' }, 1, 5) - 0.05 * 3 * 1.96) < 1e-9);
    assert.equal(glimmerChance({ level: 20, tier: 'boss' }, 1, 30), 0.5);
    assert.equal(glimmerChance({ level: 1 }, 1, 0), 0);
    assert.deepEqual([normalizeCombatSettings({}).glimmerEnabled, normalizeCombatSettings({}).glimmerChance, normalizeCombatSettings({}).glimmerMaxPerFight], [true, 5, 1]);
});

test('glimmer prompt and reply', () => {
    const fireBolt = normalizeAbility({ name: 'Fire Bolt', description: 'a lance of flame', effects: [{ type: 'damage', dice: 4, damageType: 'fire' }] });
    assert.equal(glimmerTargetAp(fireBolt, 30), 29);
    assert.equal(glimmerTargetAp(fireBolt, 25), 25);
    const block = normalizeStatBlock({ name: 'Lem', abilities: [fireBolt] });
    const msgs = buildGlimmerPrompt({ userName: 'Lem', block, derived: deriveValues(block), seed: fireBolt, enemy: { name: 'Ogre', description: 'huge' }, preferences: 'Ice magic, please', targetAp: 29, rejected: ['Frost Nova'] });
    const all = msgs.map(m => m.content).join('\n');
    assert.ok(all.includes('Fire Bolt ("a lance of flame")') && all.includes('against Ogre (huge)') && all.includes('Ice magic, please') && all.includes('about 29 Active Points') && all.includes('Frost Nova'));
    const a = parseGlimmer({ name: 'Glacier Lance', effects: [{ type: 'damage', dice: 12, damageType: 'ice' }] }, 30);
    assert.equal(a.glimmered, true);
    assert.ok(abilityCost(a).ap <= 30);
    assert.equal(parseGlimmer({ ability: { name: 'X', effects: [{ type: 'heal', dice: 1 }] } }, 30).name, 'X');
    assert.equal(parseGlimmer('no', 30), null);
    assert.equal(normalizeAbility({ name: 'Y', glimmered: true, effects: [{ type: 'heal', dice: 1 }] }).glimmered, true);
});
