// Combat rules engine. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeAbility, normalizeStatBlock, normalizeStatus, normalizeCombatSettings, chargesLimitation, DAMAGE_TYPES
} from '../src/systems/mechanics/combat/catalog.js';
import {
    abilityCost, abilityPoints, deriveValues, statBlockPoints, levelBudget, tierBudget, apCap, scaleToBudget, statusCost
} from '../src/systems/mechanics/combat/costs.js';
import {
    createCombat, advance, act, phasesFor, upcomingPhases, hitChance, effective, getCombatant, validTargets, conclude
} from '../src/systems/mechanics/combat/engine.js';
import { chooseAction } from '../src/systems/mechanics/combat/tactics.js';

/** rng that makes every d6 roll `face` (and every other rng() call the same value). */
const fixed = face => () => (face - 1) / 6 + 0.01;
/** rng that plays back d6 faces in order, then repeats the last. */
const faces = (...list) => { let i = 0; return () => (list[Math.min(i++, list.length - 1)] - 1) / 6 + 0.01; };

const fireBolt = { name: 'Fire Bolt', target: 'one-enemy', effects: [{ type: 'damage', dice: 4, damageType: 'fire' }] };

test('elements and physical types', () => {
    assert.deepEqual(DAMAGE_TYPES, ['blunt', 'pierce', 'slash', 'fire', 'water', 'earth', 'air', 'ice', 'lightning', 'poison']);
});

test('sanitizers accept loose AI input and drop invalid parts', () => {
    const a = normalizeAbility({
        name: 'Venom Strike', target: 'One Enemy', roll: 'ATTACK',
        effects: [
            { type: 'damage', dice: '1', damageType: 'Pierce', addStr: true },
            { type: 'status', status: { template: 'over_time', name: 'Poisoned', dice: 1, duration: 3, damageType: 'poison' } },
            { type: 'teleport' }
        ],
        advantages: ['armor piercing', { id: 'nonsense' }],
        limitations: [{ id: 'charges', uses: 2 }]
    });
    assert.equal(a.id, 'venom-strike');
    assert.equal(a.target, 'one-enemy');
    assert.equal(a.effects.length, 2);
    assert.equal(a.effects[1].status.template, 'overTime');
    assert.deepEqual(a.advantages, [{ id: 'armorPiercing' }]);
    assert.deepEqual(a.limitations, [{ id: 'charges', uses: 2 }]);
    assert.equal(normalizeAbility({ name: 'Nothing', effects: [{ type: 'bogus' }] }), null);
    assert.equal(normalizeStatus({ template: 'modifier', stat: 'ocv', amount: 0 }), null);

    const b = normalizeStatBlock({ name: 'Goblin', tier: 'Minion', attributes: { STR: 12 }, resistances: { Fire: 'weak', bogus: 'immune' }, abilities: [fireBolt, fireBolt] });
    assert.equal(b.tier, 'minion');
    assert.deepEqual(b.attributes, { str: 12, dex: 10, con: 10 });
    assert.deepEqual(b.resistances, { fire: 'weak' });
    assert.deepEqual(b.abilities.map(x => x.id), ['fire-bolt', 'fire-bolt-2']);
});

test('derived values follow the spec (example build)', () => {
    const block = normalizeStatBlock({ name: 'Lem', attributes: { str: 13, dex: 15, con: 12 } });
    assert.deepEqual(deriveValues(block), { maxHp: 44, maxEnd: 24, rec: 5, ocv: 3, dcv: 3, pd: 3, ed: 2, spd: 2, strDice: 3, strBonusDice: 1, dexBonusDice: 1 });
    const fast = normalizeStatBlock({ name: 'X', attributes: { dex: 20 }, bought: { spd: 2, hp: 6 } });
    assert.equal(deriveValues(fast).spd, 5);
    assert.equal(deriveValues(fast).maxHp, 46);
    const roles = normalizeCombatSettings({ roles: { con: 'vigour' } });
    assert.equal(deriveValues(normalizeStatBlock({ name: 'Y', attributes: { vigour: 20 } }), roles).maxHp, 60);
    assert.equal(deriveValues(normalizeStatBlock({ name: 'Boss', tier: 'boss' })).maxHp, 80);
});

test('ability costs match the spec examples', () => {
    const cost = raw => abilityCost(normalizeAbility(raw));
    assert.deepEqual(pickCost(cost(fireBolt)), { ap: 20, real: 20, end: 2 });
    assert.deepEqual(pickCost(cost({ name: 'Twin Daggers', effects: [{ type: 'damage', dice: 2, damageType: 'slash', addStr: true }], advantages: [{ id: 'accurate', levels: 1 }] })), { ap: 13, real: 13, end: 1 });
    assert.deepEqual(pickCost(cost({ ...fireBolt, target: 'all-enemies' })), { ap: 40, real: 40, end: 4 });
    assert.deepEqual(pickCost(cost({ ...fireBolt, target: 'all-enemies', limitations: [{ id: 'charges', uses: 2 }, 'itemBased'] })), { ap: 40, real: 18, end: 0 });
    assert.deepEqual(pickCost(cost({ name: 'Healing Light', target: 'one-ally', roll: 'automatic', effects: [{ type: 'heal', dice: 2 }] })), { ap: 20, real: 20, end: 2 });
    assert.deepEqual(pickCost(cost({ name: 'Venom', effects: [{ type: 'damage', dice: 1, damageType: 'pierce', addStr: true }, { type: 'status', status: { template: 'overTime', name: 'Poisoned', dice: 1, duration: 3 } }] })), { ap: 16, real: 16, end: 2 });
    assert.equal(cost({ ...fireBolt, advantages: ['noEnd'] }).end, 0);
    assert.equal(cost({ ...fireBolt, limitations: ['doubleEnd'] }).end, 4);
    assert.equal(chargesLimitation(1), 1);
    assert.equal(chargesLimitation(5), 0.5);
    assert.equal(chargesLimitation(20), 0.25);
    assert.equal(statusCost({ template: 'modifier', stat: 'ocv', amount: -2, duration: 3 }), 15);
    assert.equal(statusCost({ template: 'incapacitate', duration: 2 }), 20);
});

function pickCost(c) { return { ap: c.ap, real: c.real, end: c.end }; }

test('points, budgets and the AP cap', () => {
    const lem = normalizeStatBlock({
        name: 'Lem', attributes: { str: 13, dex: 15, con: 12 }, skills: { stealth: 2, athletics: 1 },
        abilities: [fireBolt, { name: 'Twin Daggers', effects: [{ type: 'damage', dice: 2, damageType: 'slash', addStr: true }], advantages: [{ id: 'accurate', levels: 1 }] }],
        items: [{ name: 'Potion', target: 'self', roll: 'automatic', effects: [{ type: 'heal', dice: 2 }], quantity: 3 }]
    });
    assert.equal(statBlockPoints(lem).total, 39); // 10 + 6 + 20 + 13/5 → 3 (ability pool); items are free
    assert.equal(abilityPoints(lem.abilities[1], [lem.abilities[0]]), 3);
    assert.equal(abilityPoints(lem.abilities[0], [lem.abilities[1]]), 20 + 3 - 13);
    assert.equal(levelBudget(1, 5), 50);
    assert.equal(levelBudget(5, 5), 70);
    assert.equal(tierBudget(5, 'minion', 5), 28);
    assert.equal(tierBudget(1, 'boss', 5), 40);
    assert.equal(tierBudget(1, 'standard', 5), 23);
    assert.equal(apCap(1), 30);
    const weak = normalizeStatBlock({ name: 'W', attributes: { str: 8 }, resistances: { fire: 'weak' }, bought: { pd: 2 } });
    assert.equal(statBlockPoints(weak).total, -7 + 6);
});

test('scaleToBudget cuts an overpowered AI stat block down to budget × tolerance', () => {
    const block = normalizeStatBlock({
        name: 'Goblin', tier: 'minion', level: 1, attributes: { str: 25, dex: 18 },
        bought: { ocv: 3 },
        abilities: [{ name: 'Mega Slash', effects: [{ type: 'damage', dice: 20, damageType: 'slash' }] }]
    });
    const budget = tierBudget(1, 'minion', 5); // 20
    scaleToBudget(block, budget);
    assert.ok(statBlockPoints(block).total <= budget * 1.1, `points ${statBlockPoints(block).total}`);
    assert.equal(block.adjusted, true);
    assert.ok(block.abilities[0].effects[0].dice >= 1);
    const fine = normalizeStatBlock({ name: 'Rat', attributes: { dex: 12 } });
    scaleToBudget(fine, 20);
    assert.equal(fine.adjusted, undefined);
});

test('speed chart and segment order', () => {
    assert.deepEqual(phasesFor(2), [6, 12]);
    assert.deepEqual(phasesFor(4), [3, 6, 9, 12]);
    assert.deepEqual(phasesFor(20), phasesFor(12));
    assert.deepEqual(phasesFor(5, true), [12]);

    const rogue = normalizeStatBlock({ name: 'Rogue', attributes: { dex: 20 }, bought: { spd: 1 } }); // SPD 4
    const brute = normalizeStatBlock({ name: 'Brute', attributes: { dex: 10, con: 30 } }); // SPD 2
    const state = createCombat([{ block: rogue, side: 'party', isPlayer: true }, { block: brute, side: 'enemies' }], { rng: fixed(1) });
    const order = [];
    for (let i = 0; i < 9; i++) {
        const id = advance(state, fixed(3));
        order.push(`${state.turn}.${state.segment}:${getCombatant(state, id).name}`);
        act(state, { type: 'dodge' }, fixed(3));
    }
    // Segment 12 of turn 1: everyone, higher DEX first. Then SPD 4 acts twice per brute phase.
    assert.deepEqual(order, ['1.12:Rogue', '1.12:Brute', '2.3:Rogue', '2.6:Rogue', '2.6:Brute', '2.9:Rogue', '2.12:Rogue', '2.12:Brute', '3.3:Rogue']);
    const upcoming = upcomingPhases(state, 4).map(p => `${p.segment}:${getCombatant(state, p.id).name}`);
    assert.deepEqual(upcoming, ['6:Rogue', '6:Brute', '9:Rogue', '12:Rogue']);
});

test('equal speed: everyone acts once per turn', () => {
    const a = normalizeStatBlock({ name: 'A', attributes: { dex: 30 } });
    const b = normalizeStatBlock({ name: 'B' });
    const state = createCombat([{ block: a, side: 'party', isPlayer: true }, { block: b, side: 'enemies' }], { settings: { equalSpeed: true } });
    const seen = [];
    for (let i = 0; i < 4; i++) { seen.push(getCombatant(state, advance(state)).name); act(state, { type: 'pass' }); }
    assert.deepEqual(seen, ['A', 'B', 'A', 'B']);
    assert.equal(state.turn, 2);
});

function duel(playerRaw, enemyRaw, options = {}) {
    const player = normalizeStatBlock({ name: 'Lem', ...playerRaw });
    const enemy = normalizeStatBlock({ name: 'Goblin', ...enemyRaw });
    const state = createCombat([{ block: player, side: 'party', isPlayer: true }, { block: enemy, side: 'enemies' }], { rng: fixed(1), ...options });
    return state;
}

test('attack resolution: to-hit, damage, resistances, defences, END', () => {
    const state = duel({ attributes: { dex: 20, con: 10 }, abilities: [fireBolt] }, { attributes: { dex: 10, con: 15 }, resistances: { fire: 'weak' } });
    assert.equal(advance(state), 'c1');
    const lem = getCombatant(state, 'c1');
    const gob = getCombatant(state, 'c2');
    // 11 + OCV 4 − DCV 2 = 13-
    assert.ok(Math.abs(hitChance(state, 'c1', lem.block.abilities[0], 'c2') - 0.8380) < 0.001);
    // to-hit 4+4+4 = 12 (hit), damage 4d6 all 4s = 16 × 1.5 = 24 − ED 3 = 21
    act(state, { type: 'ability', abilityId: 'fire-bolt', targetId: 'c2' }, fixed(4));
    assert.equal(gob.hp, 50 - 21);
    assert.equal(lem.end, 20 - 2);
    assert.match(state.log.map(l => l.text).join('\n'), /16 \[4\+4\+4\+4\] fire ×1\.5 \(weak\) − 3 ED = 21 damage/);
});

test('natural 3 is a critical hit with maximum damage; natural 18 misses', () => {
    const state = duel({ abilities: [fireBolt] }, { bought: { dcv: 10 } }); // DCV 12: needs 1- normally
    advance(state);
    act(state, { type: 'ability', abilityId: 'fire-bolt', targetId: 'c2' }, fixed(1));
    const gob = getCombatant(state, 'c2');
    assert.equal(gob.hp, 40 - (24 - 2));
    assert.match(state.log.map(l => l.text).join('\n'), /critical hit/);

    const s2 = duel({ attributes: { dex: 100 }, abilities: [fireBolt] }, {});
    advance(s2);
    act(s2, { type: 'ability', abilityId: 'fire-bolt', targetId: 'c2' }, fixed(6));
    assert.equal(getCombatant(s2, 'c2').hp, 40);
});

test('STR adds dice to physical abilities, up to the ability\'s own dice', () => {
    const dagger = { name: 'Dagger', effects: [{ type: 'damage', dice: 2, damageType: 'slash', addStr: true }] };
    const state = duel({ attributes: { str: 25 }, abilities: [dagger] }, { attributes: { str: 0, con: 30 } }); // STR above 10 adds 3 dice, capped to +2; PD 0
    advance(state);
    act(state, { type: 'ability', abilityId: 'dagger', targetId: 'c2' }, fixed(1)); // crit: 4 dice × 6
    assert.equal(getCombatant(state, 'c2').hp, 80 - 24);
});

test('statuses: damage over time, modifiers, incapacitate, shield, stacking, cleanse', () => {
    const burn = { name: 'Ignite', roll: 'automatic', effects: [{ type: 'status', status: { template: 'overTime', name: 'Burning', dice: 1, duration: 2, damageType: 'fire' } }] };
    const stun = { name: 'Bash', roll: 'automatic', effects: [{ type: 'status', status: { template: 'incapacitate', name: 'Stunned', duration: 1, resistWith: '' } }] };
    const ward = { name: 'Ward', target: 'self', roll: 'automatic', effects: [{ type: 'shield', amount: 10, duration: 2 }] };
    const haste = { name: 'Haste', target: 'self', roll: 'automatic', effects: [{ type: 'status', status: { template: 'modifier', name: 'Hasted', stat: 'ocv', amount: 3, duration: 1 } }] };
    const purge = { name: 'Purge', target: 'self', roll: 'automatic', effects: [{ type: 'cleanse', category: 'overTime' }] };
    const state = duel({ attributes: { dex: 15 }, abilities: [burn, stun, ward, haste] }, { attributes: { con: 20 }, abilities: [purge] });
    const lem = getCombatant(state, 'c1');
    const gob = getCombatant(state, 'c2');

    advance(state); // Lem, turn 1 seg 12
    act(state, { type: 'ability', abilityId: 'ignite', targetId: 'c2' }, fixed(3));
    assert.equal(gob.statuses[0].name, 'Burning');
    assert.equal(advance(state, fixed(3)), 'c2'); // Goblin starts its phase: burns for 3
    assert.equal(gob.hp, 60 - 3);
    act(state, { type: 'pass' });
    advance(state); // Lem, turn 2 seg 6
    act(state, { type: 'ability', abilityId: 'bash', targetId: 'c2' }, fixed(3));
    const before = gob.hp;
    advance(state, fixed(2)); // goblin skipped -> next is Lem at seg 12
    assert.equal(gob.hp, before - 2);
    assert.equal(gob.statuses.length, 0, 'burn (2 phases) and stun (1) are both gone');
    assert.match(state.log.map(l => l.text).join('\n'), /loses this phase/);
    assert.equal(state.current, 'c1');

    // Self buff lasts through the next own phase (fresh), then wears off.
    act(state, { type: 'ability', abilityId: 'haste' });
    assert.equal(effective(state, lem).ocv, 3 + 3);
    advance(state); act(state, { type: 'pass' }); // goblin seg 12
    advance(state); // Lem turn 3 seg 6
    assert.equal(effective(state, lem).ocv, 6, 'still hasted during the next phase');
    act(state, { type: 'ability', abilityId: 'ward' });
    assert.equal(effective(state, lem).ocv, 3, 'wears off at the end of it');
    assert.equal(lem.statuses.find(s => s.template === 'shield').amount, 10);

    // Re-applying keeps the longer duration; cleanse removes the category.
    advance(state, fixed(3)); // goblin seg 6
    act(state, { type: 'ability', abilityId: 'purge' });
    assert.match(state.log.at(-1).text, /Nothing to cleanse|cleansed/);
});

test('shield absorbs damage before HP', () => {
    const ward = { name: 'Ward', target: 'self', roll: 'automatic', effects: [{ type: 'shield', amount: 5, duration: 3 }] };
    const state = duel({ attributes: { dex: 15 }, abilities: [ward] }, { attributes: { str: 20, dex: 0 } }); // strike 4d6
    advance(state);
    act(state, { type: 'ability', abilityId: 'ward' });
    advance(state);
    act(state, { type: 'strike', targetId: 'c1' }, fixed(2)); // roll 6: hit; 4d6 of 2s = 8 − PD 2 = 6; 5 absorbed
    const lem = getCombatant(state, 'c1');
    assert.equal(lem.hp, 40 - 1);
    assert.equal(lem.statuses.length, 0, 'the shield breaks');
});

test('resistance roll halves incapacitate', () => {
    const stun = { name: 'Bash', roll: 'automatic', effects: [{ type: 'status', status: { template: 'incapacitate', name: 'Stunned', duration: 3 } }] };
    const state = duel({ abilities: [stun] }, {});
    advance(state);
    act(state, { type: 'ability', abilityId: 'bash', targetId: 'c2' }, fixed(2)); // CON roll 6 vs 11-: resists
    assert.equal(getCombatant(state, 'c2').statuses[0].remaining, 1);
});

test('END runs out: missing END is paid in HP; recovery after segment 12', () => {
    const state = duel({ attributes: { con: 3 }, abilities: [fireBolt] }, { attributes: { con: 40 } });
    const lem = getCombatant(state, 'c1');
    assert.equal(lem.maxEnd, 6);
    lem.end = 1;
    advance(state);
    act(state, { type: 'ability', abilityId: 'fire-bolt', targetId: 'c2' }, fixed(4));
    assert.equal(lem.end, 0);
    assert.equal(lem.hp, 26 - 1);
    advance(state); act(state, { type: 'pass' });
    advance(state); // turn 2: recovery happened (REC 2 + 1 = 3)
    assert.equal(lem.end, 3);
});

test('charges, items and slow abilities', () => {
    const bomb = { name: 'Bomb', limitations: [{ id: 'charges', uses: 1 }, 'slow'], effects: [{ type: 'damage', dice: 3, damageType: 'fire' }] };
    const potion = { name: 'Potion', target: 'self', roll: 'automatic', effects: [{ type: 'heal', dice: 1, flat: 2 }], quantity: 1 };
    const state = duel({ attributes: { dex: 15 }, abilities: [bomb], items: [potion] }, { attributes: { con: 40 } });
    const lem = getCombatant(state, 'c1');
    const gob = getCombatant(state, 'c2');
    advance(state);
    act(state, { type: 'ability', abilityId: 'bomb', targetId: 'c2' }, fixed(3));
    assert.equal(gob.hp, 100, 'slow: nothing yet');
    advance(state, fixed(3)); act(state, { type: 'pass' }); // goblin acts in the same segment first
    advance(state, fixed(3)); // end of segment: the bomb goes off, then turn 2
    assert.equal(gob.hp, 100 - (9 - 8)); // ED 8
    assert.equal(lem.charges.bomb, 0);
    act(state, { type: 'ability', abilityId: 'bomb', targetId: 'c2' });
    assert.match(state.log.at(-1).text, /no uses/);
    lem.hp = 10;
    advance(state); act(state, { type: 'pass' });
    advance(state);
    act(state, { type: 'item', itemId: 'potion' }, fixed(5));
    assert.equal(lem.hp, 17);
    assert.equal(lem.items[0].quantity, 0);
});

test('taunt forces single-target attacks onto its source', () => {
    const provoke = { name: 'Provoke', roll: 'automatic', effects: [{ type: 'status', status: { template: 'taunt', name: 'Provoked', duration: 2, resistWith: '' } }] };
    const tank = normalizeStatBlock({ name: 'Tank', attributes: { dex: 20 }, abilities: [provoke] });
    const mage = normalizeStatBlock({ name: 'Mage' });
    const gob = normalizeStatBlock({ name: 'Goblin' });
    const state = createCombat([{ block: tank, side: 'party', isPlayer: true }, { block: mage, side: 'party' }, { block: gob, side: 'enemies' }], { rng: fixed(1) });
    advance(state);
    act(state, { type: 'ability', abilityId: 'provoke', targetId: 'c3' }, fixed(3));
    assert.deepEqual(validTargets(state, 'c3', { target: 'one-enemy' }), ['c1']);
});

test('the fight ends: victory, defeat, fleeing, conclude', () => {
    const state = duel({ attributes: { str: 50 } }, { attributes: { con: 0 } });
    advance(state);
    act(state, { type: 'strike', targetId: 'c2' }, fixed(3));
    assert.equal(state.over, true);
    assert.equal(state.result, 'victory');
    assert.equal(advance(state), null);

    const s2 = duel({ attributes: { con: 0 } }, { attributes: { str: 50, dex: 30 } });
    assert.equal(advance(s2), 'c2');
    act(s2, { type: 'strike', targetId: 'c1' }, fixed(4));
    assert.equal(s2.result, 'defeat');

    const s3 = duel({ attributes: { dex: 30 } }, {});
    advance(s3);
    act(s3, { type: 'flee' }, faces(1, 1, 1, 5, 5, 5)); // 3 vs 15- beats 15 vs 11-
    assert.equal(s3.result, 'escaped');

    const s4 = duel({}, {});
    conclude(s4);
    assert.equal(s4.result, 'interrupted');
});

test('starting HP from the tracker; 0 HP starts out', () => {
    const player = normalizeStatBlock({ name: 'Lem' });
    const state = createCombat([{ block: player, side: 'party', isPlayer: true, hp: 12 }, { block: normalizeStatBlock({ name: 'G' }), side: 'enemies', hp: 99 }]);
    assert.equal(getCombatant(state, 'c1').hp, 12);
    assert.equal(getCombatant(state, 'c2').hp, 40, 'clamped to max');
});

test('improvised actions roll a check, then apply effects automatically', () => {
    const state = duel({}, {});
    advance(state);
    act(state, {
        type: 'improvised', description: 'kicking the brazier over', check: { target: 12 }, targetId: 'c2',
        ability: { name: 'Brazier', target: 'one-enemy', effects: [{ type: 'damage', dice: 2, damageType: 'fire' }] }
    }, fixed(3));
    assert.equal(getCombatant(state, 'c2').hp, 40 - (6 - 2));
    assert.equal(getCombatant(state, 'c1').end, 20, 'no END cost');
});

test('tactics: heal when low, avoid repeat statuses, prefer damage otherwise', () => {
    const heal = { name: 'Mend', target: 'self', roll: 'automatic', effects: [{ type: 'heal', dice: 3 }] };
    const curse = { name: 'Curse', effects: [{ type: 'status', status: { template: 'modifier', name: 'Cursed', stat: 'ocv', amount: -2, duration: 3 } }] };
    const claw = { name: 'Claw', effects: [{ type: 'damage', dice: 3, damageType: 'slash' }] };
    const state = duel({}, { attributes: { dex: 25 }, abilities: [heal, curse, claw] });
    const gob = getCombatant(state, 'c2');
    assert.equal(advance(state), 'c2'); // DEX 25 acts first
    gob.hp = 5;
    assert.deepEqual(chooseAction(state, 'c2', () => 0.5), { type: 'ability', abilityId: 'mend', targetId: 'c2' });
    gob.hp = gob.maxHp;
    assert.equal(chooseAction(state, 'c2', () => 0.5).abilityId, 'claw');
    act(state, { type: 'ability', abilityId: 'curse', targetId: 'c1' }, fixed(2));
    assert.ok(getCombatant(state, 'c1').statuses.length);
    advance(state); act(state, { type: 'pass' });
    advance(state);
    const scores = new Set();
    for (let i = 0; i < 20; i++) scores.add(chooseAction(state, 'c2').abilityId);
    assert.ok(!scores.has('curse'), 'does not re-curse');
});

test('a full AI-vs-AI fight terminates with a result', () => {
    for (let seed = 0; seed < 20; seed++) {
        let x = seed + 1;
        const rng = () => { x = (x * 16807) % 2147483647; return x / 2147483647; };
        const make = (name, extra) => normalizeStatBlock({ name, attributes: { str: 12, dex: 13, con: 12 }, abilities: [fireBolt, { name: 'Mend', target: 'self', roll: 'automatic', effects: [{ type: 'heal', dice: 2 }] }], ...extra });
        const state = createCombat([
            { block: make('Hero'), side: 'party', isPlayer: true },
            { block: make('Orc', { tier: 'elite' }), side: 'enemies' },
            { block: make('Imp', { tier: 'minion' }), side: 'enemies' }
        ], { rng });
        let steps = 0;
        while (!state.over && steps < 500) {
            const id = advance(state, rng);
            if (!id) break;
            act(state, chooseAction(state, id, rng), rng);
            steps++;
        }
        assert.ok(state.over, `seed ${seed} did not finish`);
        assert.ok(['victory', 'defeat'].includes(state.result));
    }
});

import { buildRoster } from '../src/systems/mechanics/combat/roster.js';

test('buildRoster validates, names, budgets and scales AI stat blocks', () => {
    const raw = {
        party: [{ name: 'Lem', attributes: { str: 30 } }, { name: 'Aqua', level: 1, tier: 'standard', attributes: { con: 12 } }],
        enemies: [
            { name: 'Goblin', level: 1, tier: 'minion', abilities: [{ name: 'Stab', effects: [{ type: 'damage', dice: 12, damageType: 'pierce' }] }] },
            { name: 'Goblin', level: 1, tier: 'minion', abilities: [{ name: 'Stab', effects: [{ type: 'damage', dice: 2, damageType: 'pierce' }] }] },
            { name: '' },
            'nonsense'
        ],
        environment: 'A cave.',
        styleNotes: { environmentType: 'cave' }
    };
    const r = buildRoster(raw, { playerName: 'lem', pointsPerLevel: 5 });
    assert.deepEqual(r.party.map(b => b.name), ['Aqua']);
    assert.deepEqual(r.enemies.map(b => b.name), ['Goblin 1', 'Goblin 2']);
    assert.equal(r.enemies[0].budget, 20);
    assert.equal(r.enemies[0].adjusted, true);
    assert.ok(r.enemies[0].points <= 22);
    assert.equal(r.enemies[1].adjusted, undefined);
    assert.equal(r.environment, 'A cave.');
    assert.deepEqual(buildRoster(null).enemies, []);
});

test('tier multipliers are configurable', () => {
    const s = normalizeCombatSettings({ tiers: { boss: { budget: 1.5, hp: 4 }, minion: { budget: 'x' } } });
    assert.equal(s.tiers.boss.budget, 1.5);
    assert.equal(s.tiers.minion.budget, 0.4, 'invalid falls back');
    assert.equal(tierBudget(1, 'boss', 5, s), 75);
    assert.equal(deriveValues(normalizeStatBlock({ name: 'B', tier: 'boss' }), s).maxHp, 160);
    assert.equal(normalizeCombatSettings({}).syncTracker, true);
    assert.equal(normalizeCombatSettings({ aiDelay: 99999 }).aiDelay, 5000);
});

import { abilitySlots, availableActions } from '../src/systems/mechanics/combat/engine.js';
import { scalingDice } from '../src/systems/mechanics/combat/costs.js';

test('damage can scale with STR or DEX (physical only, capped at own dice); addStr still works', () => {
    const v = { strBonusDice: 3, dexBonusDice: 2 };
    const dex = normalizeAbility({ name: 'Bow', effects: [{ type: 'damage', dice: 3, damageType: 'pierce', scaleWith: 'DEX' }] }).effects[0];
    assert.equal(dex.scaleWith, 'dex');
    assert.equal(scalingDice(v, dex), 2);
    const old = normalizeAbility({ name: 'Axe', effects: [{ type: 'damage', dice: 1, damageType: 'slash', addStr: true }] }).effects[0];
    assert.equal(old.scaleWith, 'str');
    assert.equal(scalingDice(v, old), 1, 'capped at the effect\'s own dice');
    const fire = normalizeAbility({ name: 'X', effects: [{ type: 'damage', dice: 3, damageType: 'fire', scaleWith: 'dex' }] }).effects[0];
    assert.equal(scalingDice(v, fire), 0, 'elemental damage does not scale');

    const bow = { name: 'Bow', effects: [{ type: 'damage', dice: 2, damageType: 'pierce', scaleWith: 'dex' }] };
    const state = duel({ attributes: { dex: 25 }, abilities: [bow] }, { attributes: { str: 0, dex: 0, con: 30 } });
    advance(state);
    act(state, { type: 'ability', abilityId: 'bow', targetId: 'c2' }, fixed(1)); // crit: (2 + 2) dice × 6, PD 0
    assert.equal(getCombatant(state, 'c2').hp, 80 - 24);
});

test('the basic attack can be renamed and change damage type', () => {
    const block = normalizeStatBlock({ name: 'Lem', strike: { name: 'Fire Fist', damageType: 'Fire', description: 'Burning knuckles.' } });
    assert.deepEqual(block.strike, { name: 'Fire Fist', damageType: 'fire', description: 'Burning knuckles.' });
    assert.deepEqual(normalizeStatBlock({ name: 'X' }).strike, { name: 'Strike', damageType: 'blunt', description: '' });
    const state = duel({ strike: { name: 'Fire Fist', damageType: 'fire' } }, { resistances: { fire: 'weak' } });
    advance(state);
    act(state, { type: 'strike', targetId: 'c2' }, fixed(3)); // 2d6 of 3s = 6 fire ×1.5 = 9 − ED 2 = 7
    assert.equal(getCombatant(state, 'c2').hp, 40 - 7);
    assert.match(state.log.map(l => l.text).join('\n'), /uses Fire Fist on Goblin/);
});

test('counter statuses strike back when the holder is hit', () => {
    const thorns = { name: 'Thorns', target: 'self', roll: 'automatic', effects: [{ type: 'status', status: { template: 'counter', name: 'Thorns', dice: 2, damageType: 'pierce', triggers: 2, duration: 3 } }] };
    const cost = abilityCost(normalizeAbility(thorns));
    assert.equal(cost.ap, Math.round(5 * 2 * 0.75 * 2 * 1.5));
    const state = duel({ attributes: { dex: 0, con: 30 } }, { attributes: { dex: 20 }, abilities: [thorns] });
    const gob = getCombatant(state, 'c2');
    const lem = getCombatant(state, 'c1');
    assert.equal(advance(state), 'c2');
    act(state, { type: 'ability', abilityId: 'thorns' });
    advance(state);
    act(state, { type: 'strike', targetId: 'c2' }, fixed(2)); // hits (6 vs 11+0-4=7-); thorns 2d6 of 2s = 4 − PD 2 = 2 back
    assert.match(state.log.map(l => l.text).join('\n'), /Thorns strikes back at Lem/);
    assert.equal(lem.hp, 80 - 2);
    assert.equal(gob.statuses[0].triggers, 1);
    // A miss does not trigger it
    advance(state); act(state, { type: 'pass' });
    advance(state);
    act(state, { type: 'strike', targetId: 'c2' }, fixed(6)); // natural 18: miss
    assert.equal(gob.statuses[0].triggers, 1);
});

test('separate targets: each effect with its own target is resolved (and rolled) on its own', () => {
    const missiles = normalizeAbility({
        name: 'Magic Missile', target: 'one-enemy', roll: 'attack', advantages: ['separateTargets'],
        effects: [
            { type: 'damage', dice: 1, damageType: 'fire' },
            { type: 'damage', dice: 1, damageType: 'fire', target: 'one-enemy' },
            { type: 'damage', dice: 1, damageType: 'fire', target: 'one-enemy' }
        ]
    });
    // 15 base; +¼ × 2 own targets → 15 × 1.5
    assert.equal(abilityCost(missiles).ap, 23);
    const surge = normalizeAbility({
        name: 'Battle Surge', target: 'one-enemy', advantages: ['separateTargets'],
        effects: [{ type: 'damage', dice: 3, damageType: 'slash' }, { type: 'status', target: 'self', status: { template: 'modifier', name: 'Surging', stat: 'ocv', amount: 1, duration: 2 } }]
    });
    // damage 15 + buff 5×1.25=6.25 → ×1.25 → 26.6
    assert.equal(abilityCost(surge).ap, 27);
    // Without the advantage, an effect's own target is ignored
    const plain = normalizeAbility({ name: 'P', effects: [{ type: 'damage', dice: 2, damageType: 'fire', target: 'all-enemies' }] });
    assert.equal(abilityCost(plain).ap, 10);

    const lem = normalizeStatBlock({ name: 'Lem', attributes: { dex: 30 }, abilities: [missiles, surge] });
    const state = createCombat([{ block: lem, side: 'party', isPlayer: true }, { block: normalizeStatBlock({ name: 'A' }), side: 'enemies' }, { block: normalizeStatBlock({ name: 'B' }), side: 'enemies' }], { rng: fixed(1) });
    advance(state);
    const slots = abilitySlots(state, getCombatant(state, 'c1'), missiles, 'c2', { 2: 'c3' });
    assert.deepEqual(slots.map(s => s.targets.map(t => t.id)), [['c2'], ['c2'], ['c3']], 'unchosen defaults to the main target');
    act(state, { type: 'ability', abilityId: 'magic-missile', targetId: 'c2', effectTargets: { 1: 'c3', 2: 'c3' } }, fixed(3));
    const rolls = state.log.filter(l => l.kind === 'roll');
    assert.equal(rolls.length, 3, 'one attack roll per missile');
    assert.equal(getCombatant(state, 'c2').hp, 40 - 1);   // 3 fire − ED 2
    assert.equal(getCombatant(state, 'c3').hp, 40 - 2);

    advance(state); act(state, { type: 'pass' });
    advance(state); act(state, { type: 'pass' });
    advance(state);
    act(state, { type: 'ability', abilityId: 'battle-surge', targetId: 'c2' }, fixed(3));
    assert.equal(getCombatant(state, 'c1').statuses[0].name, 'Surging', 'the buff goes to the user');
    assert.equal(state.log.filter(l => l.kind === 'roll').length, 4, 'no roll for the self effect');
});

test('unlimited items are never used up', () => {
    const wand = { name: 'Wand', target: 'one-enemy', effects: [{ type: 'damage', dice: 2, damageType: 'lightning' }], quantity: 0, unlimited: true };
    const state = duel({ items: [wand] }, { attributes: { con: 40 } });
    assert.equal(normalizeAbility(wand, { item: true }).unlimited, true);
    advance(state);
    assert.ok(availableActions(state, 'c1').items[0].usable);
    act(state, { type: 'item', itemId: 'wand', targetId: 'c2' }, fixed(3));
    advance(state); act(state, { type: 'pass' });
    advance(state);
    act(state, { type: 'item', itemId: 'wand', targetId: 'c2' }, fixed(3));
    assert.equal(state.log.filter(l => l.text.includes('uses Wand')).length, 2);
    assert.equal(getCombatant(state, 'c1').items[0].quantity, 0);
});
