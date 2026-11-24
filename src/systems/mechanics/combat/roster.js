/**
 * Turns the set-up call's JSON into a validated roster: every stat block goes
 * through the sanitizer, gets a unique name, and is scaled down when it's
 * over its tier's budget. Pure module. See docs/COMBAT_DESIGN.md §7 and §9.
 */

import { normalizeCombatSettings, normalizeStatBlock } from './catalog.js';
import { scaleToBudget, statBlockPoints, tierBudget } from './costs.js';

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
 * @returns {{ party: object[], enemies: object[], environment: string, styleNotes: object|null }}
 */
export function buildRoster(raw, { playerName = '', pointsPerLevel = 5, settings = {}, skillCost = 2, attributeCost = 1 } = {}) {
    const s = normalizeCombatSettings(settings);
    const player = String(playerName).trim().toLowerCase();
    const take = list => (Array.isArray(list) ? list : [])
        .map(normalizeStatBlock)
        .filter(b => b && b.name.toLowerCase() !== player);
    const party = take(raw?.party);
    const enemies = take(raw?.enemies);
    const taken = new Set(player ? [player] : []);
    uniqueNames(party, taken);
    uniqueNames(enemies, taken);
    for (const block of [...party, ...enemies]) {
        block.budget = tierBudget(block.level, block.tier, pointsPerLevel, s);
        scaleToBudget(block, block.budget, { tolerance: s.budgetTolerance, skillCost, attributeCost });
        block.points = statBlockPoints(block, { skillCost, attributeCost }).total;
    }
    return {
        party,
        enemies,
        environment: String(raw?.environment ?? '').trim().slice(0, 500),
        styleNotes: raw?.styleNotes && typeof raw.styleNotes === 'object' ? raw.styleNotes : null
    };
}
