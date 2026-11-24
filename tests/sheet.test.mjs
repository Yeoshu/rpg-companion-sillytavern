// Inventory linking and ability descriptions. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEntry, inventoryQuantity, setInventoryQuantity } from '../src/systems/mechanics/combat/inventory.js';
import { describeAbility } from '../src/systems/mechanics/combat/describe.js';
import { normalizeAbility } from '../src/systems/mechanics/combat/catalog.js';

test('inventory entries are split into name and count', () => {
    assert.deepEqual(parseEntry('Health Potion x3'), { name: 'Health Potion', quantity: 3 });
    assert.deepEqual(parseEntry('3x Health Potions'), { name: 'Health Potions', quantity: 3 });
    assert.deepEqual(parseEntry('2 Bombs'), { name: 'Bombs', quantity: 2 });
    assert.deepEqual(parseEntry('Smoke Bomb (2)'), { name: 'Smoke Bomb', quantity: 2 });
    assert.deepEqual(parseEntry('**Rope**'), { name: 'Rope', quantity: 1 });
    assert.deepEqual(parseEntry('Elixir ×12'), { name: 'Elixir', quantity: 12 });
});

test('items match inventory entries by name, ignoring case and plurals', () => {
    const inv = ['Sword', '3x Health Potions', 'Glass', 'Bomb x2'];
    assert.equal(inventoryQuantity(inv, 'health potion'), 3);
    assert.equal(inventoryQuantity(inv, 'Glasses'), 1);
    assert.equal(inventoryQuantity(inv, 'Bombs'), 2);
    assert.equal(inventoryQuantity(inv, 'Shield'), null);
});

test('setting a count rewrites, removes or appends the entry', () => {
    const inv = ['Sword', '3x Health Potions', 'Bomb x2'];
    assert.deepEqual(setInventoryQuantity(inv, 'Health Potion', 2), ['Sword', 'Health Potions x2', 'Bomb x2']);
    assert.deepEqual(setInventoryQuantity(inv, 'Bomb', 0), ['Sword', '3x Health Potions']);
    assert.deepEqual(setInventoryQuantity(inv, 'Bomb', 1), ['Sword', '3x Health Potions', 'Bomb']);
    assert.deepEqual(setInventoryQuantity(inv, 'Ether', 4), ['Sword', '3x Health Potions', 'Bomb x2', 'Ether x4']);
    assert.deepEqual(inv, ['Sword', '3x Health Potions', 'Bomb x2'], 'input not mutated');
});

test('abilities are described in plain English', () => {
    const a = normalizeAbility({
        name: 'Venom Strike', effects: [
            { type: 'damage', dice: 1, flat: 2, damageType: 'pierce', addStr: true },
            { type: 'status', status: { template: 'overTime', name: 'Poisoned', dice: 1, duration: 3, damageType: 'poison' } }
        ], advantages: ['armorPiercing'], limitations: [{ id: 'charges', uses: 2 }]
    });
    assert.equal(describeAbility(a), '1d6+2 (+STR) pierce damage, Poisoned: 1d6 poison per phase for 3 phases → one enemy (attack roll); armour-piercing, 2 uses per fight');
    const stun = normalizeAbility({ name: 'Bash', target: 'all-enemies', roll: 'automatic', effects: [{ type: 'status', status: { template: 'incapacitate', name: 'Dazed', duration: 1 } }] });
    assert.equal(describeAbility(stun), 'Dazed: loses 1 phase (CON roll halves) → all enemies (automatic)');
});
