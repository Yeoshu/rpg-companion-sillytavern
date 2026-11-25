/**
 * Turns the set-up call's JSON into a validated roster: every stat block goes
 * through the sanitizer, gets a unique name, and is scaled down when it's
 * over its tier's budget. Pure module. See docs/COMBAT_DESIGN.md §7 and §9.
 */

import { normalizeCombatSettings, normalizeStatBlock } from './catalog.js';
import { scaleToBudget, statBlockPoints, tierBudget } from './costs.js';
import { findKnown, storeKey } from './npcs.js';

function uniqueNames(blocks, taken) {
    const counts = new Map();
    for (const b of blocks) counts.set(b.name.toLowerCase(), (counts.get(b.name.toLowerCase()) || 0) + 1);
    const seen = new Map();
    for (const b of blocks) {
        const key = b.name.toLowerCase();
        if (counts.get(key) > 1) {
            const n = (seen.get(key) || 0) + 1;
            seen.set(key, n);
            b.name = `${b.name} ${n}`;
        }
        let name = b.name;
        let i = 2;
        while (taken.has(name.toLowerCase())) name = `${b.name} (${i++})`;
        b.name = name;
        taken.add(name.toLowerCase());
    }
}

/**
 * @param {object} raw - parsed set-up JSON ({ party, enemies, environment, styleNotes })
 * @param {object} options
 * @param {string} options.playerName - left out if the AI includes the player anyway
 * @param {number} options.pointsPerLevel
 * @param {object} [options.settings] - combat settings
 * @param {number} [options.skillCost]
 * @param {number} [options.attributeCost]
 * @param {object[]} [options.known] - confirmed stored stat blocks; entries that
 *   name one of them (or say "existing": true) use the stored block unchanged.
 *   Stored blocks with `template: true` are generic and don't keep HP.
 * @returns {{ party: object[], enemies: object[], environment: string, styleNotes: object|null }}
 */
export function buildRoster(raw, { playerName = '', pointsPerLevel = 5, settings = {}, skillCost = 2, attributeCost = 1, known = [] } = {}) {
    const s = normalizeCombatSettings(settings);
    const player = String(playerName).trim().toLowerCase();
    const fromEntry = entry => {
        const stored = findKnown(entry, known);
        if (stored) {
            const block = normalizeStatBlock(JSON.parse(JSON.stringify(stored)));
            if (!block) return null;
            block.stored = true;
            if (stored.template) {
                // A template stands for any number of generic combatants.
                block.name = String(entry?.name || block.name).trim() || block.name;
                block.fromTemplate = storeKey(stored.name);
                delete block.hp;
                delete block.end;
            } else {
                block.storedKey = storeKey(stored.name);
            }
            return block;
        }
        const block = normalizeStatBlock(entry);
        if (block) {
            // Starting HP/END only come from stored characters, never from the AI.
            delete block.hp;
            delete block.end;
        }
        return block;
    };
    const take = list => (Array.isArray(list) ? list : [])
        .map(fromEntry)
        .filter(b => b && b.name.toLowerCase() !== player);
    const seen = new Set();
    const once = b => {
        // A stored individual can only be in the fight once.
        if (!b.storedKey) return true;
        if (seen.has(b.storedKey)) return false;
        seen.add(b.storedKey);
        return true;
    };
    const party = take(raw?.party).filter(once);
    const enemies = take(raw?.enemies).filter(once);
    const taken = new Set(player ? [player] : []);
    uniqueNames(party, taken);
    uniqueNames(enemies, taken);
    for (const block of [...party, ...enemies]) {
        block.budget = tierBudget(block.level, block.tier, pointsPerLevel, s);
        if (!block.stored) scaleToBudget(block, block.budget, { tolerance: s.budgetTolerance, skillCost, attributeCost });
        block.points = statBlockPoints(block, { skillCost, attributeCost }).total;
    }
    return {
        party,
        enemies,
        environment: String(raw?.environment ?? '').trim().slice(0, 500),
        styleNotes: raw?.styleNotes && typeof raw.styleNotes === 'object' ? raw.styleNotes : null
    };
}
