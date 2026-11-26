// Swarms, reserves and encounter balancing. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStatBlock, normalizeCombatSettings } from '../src/systems/mechanics/combat/catalog.js';
import { deriveValues, statBlockPoints } from '../src/systems/mechanics/combat/costs.js';
import { act, advance, createCombat, isActive, swarmBonusDice, swarmSize, SWARM } from '../src/systems/mechanics/combat/engine.js';
import { balanceEncounter, estimateWinRate, formSwarms, seededRng, swarmName } from '../src/systems/mechanics/combat/balance.js';
import { buildRoster } from '../src/systems/mechanics/combat/roster.js';

const hero = () => normalizeStatBlock({
    name: 'Lem', attributes: { str: 13, dex: 15, con: 12 }, bought: { pd: 1, ed: 1 },
    abilities: [
        { name: 'Fire Bolt', effects: [{ type: 'damage', dice: 5, damageType: 'fire' }] },
        { name: 'Flame Wave', target: 'all-enemies', effects: [{ type: 'damage', dice: 3, damageType: 'fire' }] }
    ]
});
const rat = (name = 'Rat') => {
    const b = normalizeStatBlock({ name, tier: 'minion', size: 'tiny', attributes: { str: 11, dex: 12, con: 11 }, abilities: [{ name: 'Bite', effects: [{ type: 'damage', dice: 1, damageType: 'pierce', scaleWith: 'str' }] }] });
    b.points = statBlockPoints(b).total;
    return b;
};
const goblin = (name, tier = 'minion') => {
    const b = normalizeStatBlock({ name, tier, attributes: { str: 13, dex: 13, con: 12 }, bought: { pd: 1 }, abilities: [{ name: 'Spear', effects: [{ type: 'damage', dice: 2, damageType: 'pierce', scaleWith: 'str' }] }] });
    b.points = statBlockPoints(b).total;
    return b;
};
const party = () => [{ block: hero(), side: 'party', isPlayer: true }];

test('size is kept on stat blocks (tiny / large); anything else is normal', () => {
    assert.equal(normalizeStatBlock({ name: 'Rat', size: 'Tiny' }).size, 'tiny');
    assert.equal(normalizeStatBlock({ name: 'Ogre', size: 'huge' }).size, 'large');
    assert.equal(normalizeStatBlock({ name: 'Goblin', size: 'small' }).size, undefined);
});

test('a swarm pools its members\' HP, hits harder while big and takes more from area attacks', () => {
    const member = rat();
    const memberHp = deriveValues(member).maxHp;
    const state = createCombat([...party(), { block: member, side: 'enemies', swarm: 6, name: 'Rat swarm' }], { rng: seededRng(3) });
    const swarm = state.combatants[1];
    assert.equal(swarm.name, 'Rat swarm');
    assert.equal(swarm.maxHp, memberHp * 6);
    assert.equal(swarmSize(swarm), 6);
    assert.equal(swarmBonusDice(swarm), Math.floor(5 * SWARM.dicePerMember));
    swarm.hp = memberHp * 2 + 1;
    assert.equal(swarmSize(swarm), 3);
    assert.ok(state.log.some(e => e.kind === 'swarm'));

    // Area damage is multiplied against a swarm.
    swarm.hp = swarm.maxHp;
    let id = advance(state, seededRng(1));
    while (id !== 'c1') { act(state, { type: 'pass' }); id = advance(state, seededRng(1)); }
    const entries = act(state, { type: 'ability', abilityId: 'flame-wave' }, seededRng(5));
    const hit = entries.find(e => e.kind === 'damage');
    if (hit) assert.match(hit.text, /area vs swarm/);
});

test('reserves wait out of the fight and step in when someone on their side falls', () => {
    const state = createCombat([...party(), { block: goblin('Goblin 1'), side: 'enemies' }, { block: goblin('Goblin 2'), side: 'enemies', reserve: true }], { rng: seededRng(2) });
    const [, first, second] = state.combatants;
    assert.equal(isActive(second), false);
    assert.ok(state.log.some(e => e.kind === 'reserve'));
    first.hp = 1;
    const rng = seededRng(4);
    let guard = 200;
    while (!first.out && guard--) {
        const id = advance(state, rng);
        act(state, id === 'c1' ? { type: 'ability', abilityId: 'fire-bolt', targetId: first.id } : { type: 'pass' }, rng);
    }
    assert.equal(first.out, true);
    assert.equal(isActive(second), true);
    assert.equal(state.over, false);
    assert.ok(state.log.some(e => e.kind === 'arrives'));
});

test('if every starter is a reserve, the first one starts anyway', () => {
    const state = createCombat([...party(), { block: goblin('Goblin'), side: 'enemies', reserve: true }]);
    assert.equal(isActive(state.combatants[1]), true);
    assert.equal(state.over, false);
});

test('tiny creatures in groups of three or more merge into one swarm; bigger ones never do', () => {
    const { entries, merged } = formSwarms([rat('Rat 1'), rat('Rat 2'), rat('Rat 3'), goblin('Goblin 1'), goblin('Goblin 2'), goblin('Goblin 3')]);
    assert.deepEqual(merged, [{ name: 'Rat', count: 3 }]);
    assert.equal(entries.length, 4);
    assert.equal(entries[0].swarm, 3);
    assert.equal(entries[0].name, 'Rat swarm');
    assert.equal(entries.filter(e => e.swarm).length, 1);
    // Two tiny ones stay separate; a swarm the AI asked for is kept.
    assert.equal(formSwarms([rat('Rat 1'), rat('Rat 2')]).entries.filter(e => e.swarm).length, 0);
    const asked = rat('Bats');
    asked.swarm = 5;
    assert.equal(formSwarms([asked]).entries[0].swarm, 5);
    assert.equal(swarmName('Bat swarm'), 'Bat swarm');
    assert.equal(swarmName('Wolf Pack'), 'Wolf Pack');
});

test('the estimate is repeatable for the same seed', () => {
    const p = [...party(), { block: goblin('Goblin'), side: 'enemies' }];
    assert.equal(estimateWinRate(p, { runs: 40, seed: 7 }), estimateWinRate(p, { runs: 40, seed: 7 }));
});

test('balancing: six rats become a swarm, six goblins mostly wait in reserve', () => {
    const rats = balanceEncounter({ party: party(), enemies: Array.from({ length: 6 }, (_, i) => rat(`Rat ${i + 1}`)), runs: 60 });
    assert.equal(rats.enemies.length, 1);
    assert.ok(rats.enemies[0].swarm >= 3);
    assert.ok(rats.changes[0].includes('swarm'));

    const goblins = Array.from({ length: 6 }, (_, i) => goblin(`Goblin ${i + 1}`));
    const before = estimateWinRate([...party(), ...goblins.map(block => ({ block, side: 'enemies' }))], { runs: 60 });
    const result = balanceEncounter({ party: party(), enemies: goblins, runs: 60 });
    assert.ok(before < 0.65);
    assert.ok(result.estimate > before);
    assert.ok(result.enemies.filter(e => !e.reserve).length >= 1);
    assert.ok(result.enemies.some(e => e.reserve) || result.heldBack.length);
    assert.equal(result.enemies.some(e => e.swarm), false);
});

test('balancing keeps the strongest enemy in the fight and never touches an easy fight', () => {
    const chief = goblin('Goblin Chief', 'elite');
    chief.points += 100;
    const result = balanceEncounter({ party: party(), enemies: [goblin('Goblin 1'), chief, goblin('Goblin 2'), goblin('Goblin 3')], runs: 60 });
    const starter = result.enemies.find(e => !e.reserve);
    assert.equal(starter.block.name, 'Goblin Chief');

    const easy = balanceEncounter({ party: party(), enemies: [rat('Rat')], runs: 40 });
    assert.deepEqual(easy.changes, []);
    assert.equal(easy.enemies.length, 1);
});

test('roster: "count" makes copies of normal creatures and a swarm of tiny ones; "reserve" is kept', () => {
    const roster = buildRoster({
        enemies: [
            { name: 'Goblin', tier: 'minion', count: 3, attributes: { str: 12 } },
            { name: 'Rat', size: 'tiny', tier: 'minion', count: 6 },
            { name: 'Wolf', reserve: true }
        ]
    }, { settings: normalizeCombatSettings({}) });
    assert.deepEqual(roster.enemies.map(b => b.name), ['Goblin 1', 'Goblin 2', 'Goblin 3', 'Rat', 'Wolf']);
    assert.equal(roster.enemies[0].swarm, undefined);
    assert.equal(roster.enemies[3].swarm, 6);
    assert.equal(roster.enemies[4].reserve, true);
});

test('saved characters start fresh unless wounds are kept; templates always do', () => {
    const known = [
        { ...normalizeStatBlock({ name: 'Grak', attributes: { con: 12 } }), hp: 7, end: 3 },
        { ...normalizeStatBlock({ name: 'Wolf' }), hp: 4, template: true }
    ];
    const raw = { enemies: [{ name: 'Grak' }, { name: 'Wolf' }] };
    const fresh = buildRoster(raw, { settings: normalizeCombatSettings({}), known });
    assert.equal(fresh.enemies[0].hp, undefined);
    assert.equal(fresh.enemies[0].storedKey, 'grak');
    assert.equal(fresh.enemies[1].hp, undefined);
    const kept = buildRoster(raw, { settings: normalizeCombatSettings({ keepWounds: true }), known });
    assert.equal(kept.enemies[0].hp, 7);
    assert.equal(kept.enemies[0].end, 3);
    assert.equal(kept.enemies[1].hp, undefined);
});
