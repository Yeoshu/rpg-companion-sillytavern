/**
 * Encounter difficulty: estimates how likely the party is to win by playing
 * the fight out locally many times (everyone using the local tactics), and
 * trims encounters that are too much for the player:
 *
 *  1. Groups of tiny creatures (rats, bats, insects) become swarms.
 *  2. Extra enemies (goblin-sized and up) wait in reserve and step in as
 *     others fall, weakest first, the strongest enemy always starting.
 *  3. If that still isn't enough, swarms shrink and the last reserves stay
 *     out of the fight altogether.
 *
 * A single enemy is never weakened here (its tier budget already caps it).
 * Pure module. See docs/COMBAT_DESIGN.md "Encounter difficulty".
 */

import { TIERS } from './catalog.js';
import { act, advance, createCombat } from './engine.js';
import { chooseAction } from './tactics.js';

/** Creatures that can form swarms. */
export const SWARM_SIZES = ['tiny'];
const MIN_SWARM = 3;
const MAX_PHASES = 400;

/** Small seeded RNG (mulberry32), so the same encounter gets the same estimate. */
export function seededRng(seed) {
    let a = (Number(seed) >>> 0) || 1;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Chance (0..1) that the party wins, from `runs` simulated fights.
 * Fights that run past MAX_PHASES count as half a win.
 * @param {object[]} participants - as for createCombat (blocks are not changed)
 */
export function estimateWinRate(participants, { settings = {}, runs = 120, seed = 1 } = {}) {
    const rng = seededRng(seed);
    let wins = 0;
    for (let n = 0; n < runs; n++) {
        const copy = participants.map(p => ({ ...p, block: JSON.parse(JSON.stringify(p.block)) }));
        const state = createCombat(copy, { settings, rng });
        let phases = 0;
        while (!state.over && phases++ < MAX_PHASES) {
            const id = advance(state, rng);
            if (!id) break;
            act(state, chooseAction(state, id, rng), rng);
        }
        if (state.result === 'victory') wins += 1;
        else if (!state.over) wins += 0.5;
    }
    return wins / runs;
}

/** "Giant Rat 3" → "giant rat" */
function familyKey(block) {
    return String(block.name || '').toLowerCase().replace(/\s*\(\d+\)$/, '').replace(/\s+\d+$/, '').trim();
}

function familyName(block) {
    return String(block.name || '').replace(/\s*\(\d+\)$/, '').replace(/\s+\d+$/, '').trim();
}

/** "Rat" → "Rat swarm"; names that already say swarm, pack, flock... are kept. */
export function swarmName(name) {
    return /\b(swarm|horde|pack|flock|colony|cloud|nest|mob|brood|school|murder|plague)\b/i.test(name) ? name : `${name} swarm`;
}

/** "Goblin 1, Goblin 2, Shaman" → "2 × Goblin, Shaman" */
function listNames(entries) {
    const counts = new Map();
    for (const e of entries) {
        const name = e.name || familyName(e.block);
        counts.set(name, (counts.get(name) || 0) + 1);
    }
    return [...counts].map(([name, n]) => (n > 1 ? `${n} × ${name}` : name)).join(', ');
}

const TIER_RANK = Object.fromEntries(Object.keys(TIERS).map((id, i) => [id, i]));

function strength(entry) {
    return (TIER_RANK[entry.block.tier] ?? 1) * 1000 + (Number(entry.block.points) || 0) + (entry.swarm || 1) * 5;
}

/**
 * Enemy entries for createCombat: tiny creatures that come in groups of three
 * or more are merged into one swarm per kind; swarms the AI asked for
 * (`block.swarm`) are kept.
 * @param {object[]} blocks - enemy stat blocks (from buildRoster)
 * @returns {{ entries: {block, swarm?, reserve?, name?}[], merged: {name: string, count: number}[] }}
 */
export function formSwarms(blocks) {
    const groups = new Map();
    const entries = [];
    for (const block of blocks) {
        const tiny = SWARM_SIZES.includes(block.size);
        const requested = Math.round(Number(block.swarm) || 0);
        if (tiny && requested >= 2 && !block.storedKey) {
            entries.push({ block, swarm: requested, name: swarmName(familyName(block)), reserve: Boolean(block.reserve) });
            continue;
        }
        if (tiny && !block.storedKey) {
            const key = familyKey(block);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(block);
            entries.push({ block, group: key, reserve: Boolean(block.reserve) });
            continue;
        }
        entries.push({ block, reserve: Boolean(block.reserve) });
    }
    const merged = [];
    const out = [];
    for (const entry of entries) {
        if (!entry.group) { out.push(entry); continue; }
        const members = groups.get(entry.group);
        if (members.length < MIN_SWARM) { out.push({ block: entry.block, reserve: entry.reserve }); continue; }
        if (members[0] !== entry.block) continue;
        const block = { ...entry.block, name: familyName(entry.block) };
        merged.push({ name: block.name, count: members.length });
        out.push({ block, swarm: members.length, name: swarmName(block.name) });
    }
    return { entries: out, merged };
}

/**
 * Makes an encounter fit the difficulty target.
 * @param {object} options
 * @param {object[]} options.party - party participants for createCombat (player first)
 * @param {object[]} options.enemies - enemy stat blocks from buildRoster
 *   (may carry `size`, `swarm` and `reserve` from the AI)
 * @param {number} [options.target=0.65] - the lowest acceptable chance to win
 * @param {object} [options.settings] - combat settings
 * @param {number} [options.runs]
 * @param {number} [options.seed]
 * @returns {{ enemies: object[], estimate: number, before: number, changes: string[], heldBack: string[] }}
 *   enemies: participants for createCombat (side 'enemies'); changes: what was
 *   done, in plain words, for the preview; heldBack: who stays out of the
 *   fight, for the narration.
 */
export function balanceEncounter({ party, enemies, target = 0.65, settings = {}, runs = 120, seed = 1 }) {
    const changes = [];
    const { entries, merged } = formSwarms(enemies);
    for (const m of merged) changes.push(`${m.count} × ${m.name} fight as one swarm`);
    // Party at full strength: the budget is about the encounter, not the player's current wounds.
    const fullParty = party.map(p => ({ ...p, hp: undefined, end: undefined }));
    const participants = () => [
        ...fullParty,
        ...entries.filter(e => !e.dropped).map(e => ({ block: e.block, side: 'enemies', swarm: e.swarm, reserve: e.reserve, name: e.name }))
    ];
    const estimate = () => estimateWinRate(participants(), { settings, runs, seed });

    let chance = estimate();
    const before = chance;
    if (chance >= target) return { enemies: participants().filter(p => p.side === 'enemies'), estimate: chance, before, changes, heldBack: [] };
    const heldBack = [];

    // The strongest enemy always starts in the fight; others go to the reserve, weakest first.
    const byStrength = [...entries].sort((a, b) => strength(b) - strength(a));
    const leader = byStrength[0];
    const front = () => entries.filter(e => !e.reserve && !e.dropped);
    const candidates = [...byStrength].reverse().filter(e => e !== leader && !e.reserve);
    const reserved = [];
    for (const entry of candidates) {
        if (chance >= target || front().length <= 1) break;
        entry.reserve = true;
        reserved.push(entry);
        chance = estimate();
    }
    // Reserves join in the order they were held back.
    entries.sort((a, b) => (a.reserve === b.reserve ? 0 : a.reserve ? 1 : -1));
    if (reserved.length) changes.push(`${listNames(reserved)} ${reserved.length === 1 ? 'waits' : 'wait'} to join as others fall`);

    // Shrink swarms (never below three).
    for (const entry of entries.filter(e => e.swarm)) {
        const start = entry.swarm;
        while (chance < target && entry.swarm > MIN_SWARM) {
            entry.swarm -= 1;
            chance = estimate();
        }
        if (entry.swarm < start) {
            changes.push(`the ${entry.name} is ${entry.swarm} strong (${start - entry.swarm} hang back)`);
            heldBack.push(`${start - entry.swarm} of the ${entry.name}`);
        }
    }

    // Leave out the last reserves.
    const dropped = [];
    for (const entry of [...entries].reverse()) {
        if (chance >= target) break;
        if (!entry.reserve || entry.dropped) continue;
        entry.dropped = true;
        dropped.push(entry);
        chance = estimate();
    }
    heldBack.push(...dropped.map(e => e.name || e.block.name));
    // Reserves that stay out don't also "wait to join".
    if (dropped.length) {
        const waiting = reserved.filter(e => !e.dropped);
        const i = changes.findIndex(c => c.endsWith('to join as others fall'));
        if (i >= 0) {
            if (waiting.length) changes[i] = `${listNames(waiting)} ${waiting.length === 1 ? 'waits' : 'wait'} to join as others fall`;
            else changes.splice(i, 1);
        }
        changes.push(`${listNames(dropped)} ${dropped.length === 1 ? 'stays' : 'stay'} out of the fight`);
    }

    return { enemies: participants().filter(p => p.side === 'enemies'), estimate: chance, before, changes, heldBack };
}
