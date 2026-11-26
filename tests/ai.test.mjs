// In-fight AI calls (prompts and parsers) and recurring characters. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStatBlock } from '../src/systems/mechanics/combat/catalog.js';
import { createCombat, availableActions } from '../src/systems/mechanics/combat/engine.js';
import { abilityCost } from '../src/systems/mechanics/combat/costs.js';
import {
    buildNarrationPrompt, cleanNarration, buildFreeActionPrompt, parseFreeAction, buildTacticsPrompt, parseTactics, describeCombatants
} from '../src/systems/mechanics/combat/aiPrompts.js';
import { matchStatBlocks, looksGeneric, baseName, findKnown, mentions } from '../src/systems/mechanics/combat/npcs.js';
import { buildRoster } from '../src/systems/mechanics/combat/roster.js';

function fight() {
    const lem = normalizeStatBlock({ name: 'Lem', attributes: { dex: 15 }, abilities: [{ name: 'Fire Bolt', effects: [{ type: 'damage', dice: 5, damageType: 'fire' }] }],
        items: [{ name: 'Potion', target: 'self', roll: 'automatic', effects: [{ type: 'heal', dice: 2 }], quantity: 2 }] });
    const wolf = normalizeStatBlock({ name: 'Wolf 1', description: 'A grey wolf.', abilities: [{ name: 'Bite', effects: [{ type: 'damage', dice: 3, damageType: 'pierce' }] }] });
    const wolf2 = normalizeStatBlock({ name: 'Wolf 2' });
    return createCombat([{ block: lem, side: 'party', isPlayer: true }, { block: wolf, side: 'enemies' }, { block: wolf2, side: 'enemies' }]);
}

function optionsFor(state, id) {
    const { abilities, items } = availableActions(state, id);
    return [...abilities.filter(o => !o.ability.basic).map(o => ({ ability: o.ability, kind: 'ability' })), ...items.map(o => ({ ability: o.ability, kind: 'item' }))];
}

test('narration prompt carries the log, the cast and the style, without numbers in the cast', () => {
    const state = fight();
    const msgs = buildNarrationPrompt({
        userName: 'Lem', environment: 'A forest.', combatants: state.combatants,
        lines: ['Lem uses Fire Bolt on Wolf 1.', '  vs Wolf 1: rolled 9 vs 12- → hit.'],
        previous: 'The wolves circled.', style: { tense: 'past', person: 'third', narration: 'omniscient', pov: 'narrator' },
        styleGuide: 'Do not play for {userName}.'
    });
    const all = msgs.map(m => m.content).join('\n');
    assert.ok(all.includes('Lem uses Fire Bolt on Wolf 1.'));
    assert.ok(all.includes('Wolf 1 (enemy, healthy). A grey wolf.'));
    assert.ok(all.includes('past tense, third person'));
    assert.ok(all.includes('Do not play for Lem.'));
    assert.ok(all.includes('The wolves circled.'));
    assert.equal(cleanNarration('```\nNarration: The bolt hits.\n```'), 'The bolt hits.');
});

test('free actions: an existing ability, a basic action, or an improvised check', () => {
    const state = fight();
    const o = {
        options: optionsFor(state, 'c1'), combatants: state.combatants,
        attributes: [{ id: 'str', name: 'STR' }, { id: 'dex', name: 'DEX' }], skills: ['Athletics'], maxAp: 15
    };
    const prompt = buildFreeActionPrompt({ ...o, userName: 'Lem', text: 'I hurl fire at the big one', actor: state.combatants[0] });
    assert.ok(prompt[0].content.includes('Fire Bolt') && prompt[1].content.includes('I hurl fire'));

    assert.deepEqual(pick(parseFreeAction({ type: 'ability', ability: 'fire bolt', target: 'wolf 1' }, o)), { kind: 'ability', id: 'fire-bolt', targetId: 'c2' });
    assert.deepEqual(pick(parseFreeAction({ type: 'ability', ability: 'Potion', target: null }, o)), { kind: 'item', id: 'potion', targetId: null });
    assert.deepEqual(parseFreeAction({ type: 'basic', action: 'Dodge' }, o), { kind: 'basic', action: 'dodge' });
    assert.equal(parseFreeAction({ type: 'ability', ability: 'Meteor' }, o), null);
    assert.equal(parseFreeAction('nope', o), null);

    const imp = parseFreeAction({
        type: 'improvised', description: 'kick the brazier', attribute: 'DEX', skill: 'Athletics', difficulty: 'very hard', target: 'Wolf 2',
        onSuccess: { target: 'one-enemy', effects: [{ type: 'damage', dice: 10, damageType: 'fire' }] }
    }, o);
    assert.equal(imp.kind, 'improvised');
    assert.equal(imp.attribute, 'dex');
    assert.equal(imp.difficulty, 'veryHard');
    assert.equal(imp.targetId, 'c3');
    assert.equal(imp.ability.roll, 'automatic');
    assert.ok(abilityCost(imp.ability).ap <= 15, 'capped to maxAp');
    const plain = parseFreeAction({ type: 'improvised', description: 'shout', attribute: 'cha', onSuccess: null }, o);
    assert.equal(plain.ability, null);
    assert.equal(plain.attribute, 'str', 'unknown attribute falls back to the first');
});

function pick(r) { return { kind: r.kind, id: r.ability.id, targetId: r.targetId }; }

test('tactics: replies become engine actions, nonsense falls back', () => {
    const state = fight();
    const o = { actor: state.combatants[1], combatants: state.combatants, options: optionsFor(state, 'c2') };
    assert.ok(buildTacticsPrompt(o)[1].content.includes('- Bite'));
    assert.deepEqual(parseTactics({ action: 'Bite', target: 'Lem' }, o), { type: 'ability', abilityId: 'bite', targetId: 'c1' });
    assert.deepEqual(parseTactics({ action: 'dodge' }, o), { type: 'dodge' });
    assert.deepEqual(parseTactics({ action: 'strike', target: 'lem' }, o), { type: 'strike', targetId: 'c1' });
    assert.equal(parseTactics({ action: 'Fly away' }, o), null);
    assert.equal(parseTactics(null, o), null);
});

test('recurring characters: matching, generic names, roster substitution', () => {
    const mira = normalizeStatBlock({ name: 'Mira', aliases: ['the Captain'], attributes: { dex: 14 } });
    mira.hp = 12;
    const goblin = { ...normalizeStatBlock({ name: 'Goblin', tier: 'minion' }), template: true };
    const blocks = [mira, goblin];
    assert.ok(mentions('The Captain draws her blade.', 'the Captain'));
    assert.ok(mentions('Three goblins burst in!', 'Goblin'));
    assert.ok(!mentions('Miranda waves.', 'Mira'));
    assert.deepEqual(matchStatBlocks(blocks, 'Goblins everywhere.', []).map(b => b.name), ['Goblin']);
    assert.deepEqual(matchStatBlocks(blocks, '', ['mira']).map(b => b.name), ['Mira']);
    assert.ok(looksGeneric({ name: 'Wolf 2' }) && looksGeneric({ name: 'Rat', tier: 'minion' }) && !looksGeneric({ name: 'Mira' }));
    assert.equal(baseName('Wolf 12'), 'Wolf');
    assert.equal(findKnown({ name: 'Goblin 2' }, blocks).name, 'Goblin');

    const roster = buildRoster({
        party: [{ name: 'Mira', existing: true }],
        enemies: [{ name: 'Goblin', existing: true }, { name: 'Goblin', existing: true }, { name: 'Ogre', hp: 999, attributes: { str: 20 } }, { name: 'Mira' }]
    }, { known: blocks, pointsPerLevel: 5, settings: { keepWounds: true } });
    assert.deepEqual(roster.party.map(b => [b.name, b.hp, b.storedKey]), [['Mira', 12, 'mira']]);
    assert.deepEqual(roster.enemies.map(b => b.name), ['Goblin 1', 'Goblin 2', 'Ogre']);
    assert.equal(roster.enemies[0].fromTemplate, 'goblin');
    assert.equal(roster.enemies[0].hp, undefined);
    assert.equal(roster.enemies[2].hp, undefined, 'AI-written HP is ignored');
});

import { describeAbility, describeStatBlock } from '../src/systems/mechanics/combat/describe.js';
import { normalizeAbility } from '../src/systems/mechanics/combat/catalog.js';
import { deriveValues } from '../src/systems/mechanics/combat/costs.js';

test('flavour descriptions reach the prompts', () => {
    const lem = normalizeStatBlock({ name: 'Lem', strike: { name: 'Fire Fist', damageType: 'fire', description: 'burning knuckles' },
        abilities: [{ name: 'Fire Bolt', description: 'a lance of white flame', effects: [{ type: 'damage', dice: 5, damageType: 'fire' }] }] });
    const text = describeStatBlock(lem, deriveValues(lem));
    assert.ok(text.includes('Basic attack: Fire Fist, 2d6 fire ("burning knuckles")'));
    assert.ok(text.includes('- Fire Bolt ("a lance of white flame"): 5d6 fire damage'));

    const state = createCombat([{ block: lem, side: 'party', isPlayer: true }, { block: normalizeStatBlock({ name: 'Wolf' }), side: 'enemies' }]);
    const o = { options: optionsFor(state, 'c1'), combatants: state.combatants, attributes: [{ id: 'dex', name: 'DEX' }], skills: [], maxAp: 15, strikeName: 'Fire Fist' };
    const prompt = buildFreeActionPrompt({ ...o, userName: 'Lem', text: 'punch it', actor: state.combatants[0] }).map(m => m.content).join('\n');
    assert.ok(prompt.includes('"a lance of white flame"') && prompt.includes('Fire Fist: their basic attack ("burning knuckles")'));
    assert.deepEqual(parseFreeAction({ type: 'ability', ability: 'Fire Fist', target: 'Wolf' }, o).ability.id, 'strike');
    const narration = buildNarrationPrompt({ userName: 'Lem', combatants: state.combatants, lines: ['Lem uses Fire Bolt on Wolf.'], abilityNotes: ["Lem's Fire Bolt: a lance of white flame"] });
    assert.ok(narration[0].content.includes("- Lem's Fire Bolt: a lance of white flame"));

    const surge = normalizeAbility({ name: 'Surge', advantages: ['separateTargets'], effects: [{ type: 'damage', dice: 3, damageType: 'slash' }, { type: 'heal', dice: 1, target: 'self' }] });
    assert.equal(describeAbility(surge), '3d6 slash damage, heals 1d6 (→ self) → one enemy (attack roll); separate targets');
});

test('the player\'s pronouns from the sheet reach the combatant list', () => {
    const player = { name: 'Lem', side: 'party', isPlayer: true, hp: 40, maxHp: 40, block: { pronouns: 'she/her' } };
    const foe = { name: 'Goblin', side: 'enemies', hp: 10, maxHp: 20, block: { description: 'A wiry goblin.' } };
    const text = describeCombatants([player, foe]);
    assert.match(text, /- Lem \(the user's character, she\/her, healthy\)/);
    assert.match(text, /- Goblin \(enemy, hurt\)\. A wiry goblin\./);
    assert.doesNotMatch(describeCombatants([{ ...player, block: {} }]), /,\s*,/);
});
