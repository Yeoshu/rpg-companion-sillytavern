/**
 * What a fight changes on the tracker: Health and Energy from the player's
 * HP and END, and the items they used. Pure module; features/combatAftermath.js
 * applies the result. See docs/COMBAT_DESIGN.md §9.
 */

import { inventoryQuantity, setInventoryQuantity } from './inventory.js';

/**
 * @param {object} o
 * @param {object} o.player - the player's engine combatant (after the fight)
 * @param {number|null} o.healthMax - the tracker Health stat's maximum, or null if there's none
 * @param {number|null} o.energyMax - the tracker Energy stat's maximum, or null
 * @param {string[]} o.entries - On Person inventory entries
 * @returns {{ health: number|null, energy: number|null, entries: string[],
 *             items: {name: string, before: number, after: number, linked: boolean}[],
 *             sheetQuantities: Object<string, number> }}
 */
export function computeAftermath({ player, healthMax = null, energyMax = null, entries = [] }) {
    const out = { health: null, energy: null, entries: [...entries], items: [], sheetQuantities: {} };
    if (healthMax) out.health = Math.max(0, Math.min(healthMax, Math.round((player.hp / Math.max(1, player.maxHp)) * healthMax)));
    if (energyMax) out.energy = Math.max(0, Math.min(energyMax, Math.round((player.end / Math.max(1, player.maxEnd)) * energyMax)));
    for (const item of player.items || []) {
        if (item.unlimited) continue;
        const original = (player.block.items || []).find(i => i.id === item.id);
        const used = (original?.quantity ?? item.quantity) - item.quantity;
        if (used <= 0) continue;
        const held = inventoryQuantity(out.entries, item.name);
        if (held !== null) {
            const after = Math.max(0, held - used);
            out.entries = setInventoryQuantity(out.entries, item.name, after);
            out.items.push({ name: item.name, before: held, after, linked: true });
        } else {
            out.sheetQuantities[item.id] = item.quantity;
            out.items.push({ name: item.name, before: original?.quantity ?? item.quantity + used, after: item.quantity, linked: false });
        }
    }
    return out;
}

/** The aftermath as plain facts for the summary prompt. */
export function describeAftermath(out, userName, { healthMax, energyMax } = {}) {
    const facts = [];
    if (out.health !== null) facts.push(`${userName}'s Health is now ${out.health}/${healthMax}`);
    if (out.energy !== null) facts.push(`Energy ${out.energy}/${energyMax}`);
    for (const i of out.items) facts.push(`${i.name} used: ${i.before} → ${i.after}`);
    return facts.join('; ');
}
