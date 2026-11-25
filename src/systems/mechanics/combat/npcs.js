/**
 * Recurring characters: matching stored stat blocks to a scene, and deciding
 * what to offer to save after a fight. Pure module.
 * See docs/COMBAT_DESIGN.md §9 and §10.
 */

export function storeKey(name) {
    return String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** All the names a block answers to. */
export function namesOf(block) {
    return [block.name, ...(block.aliases || [])].map(n => String(n ?? '').trim()).filter(Boolean);
}

/** Whether `text` mentions the name as a whole word (case-insensitive, plural allowed). */
export function mentions(text, name) {
    if (!text || !name) return false;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(name)}(e?s)?($|[^\\p{L}\\p{N}])`, 'iu');
    return re.test(text);
}

/**
 * Stored stat blocks that seem to be in the scene.
 * @param {object[]} blocks - stored stat blocks (chat blocks and templates)
 * @param {string} text - recent chat text
 * @param {string[]} presentNames - names from the Present Characters tracker
 * @returns {object[]} the matching blocks, in the given order
 */
export function matchStatBlocks(blocks, text, presentNames = []) {
    const present = new Set(presentNames.map(storeKey));
    return (blocks || []).filter(block => namesOf(block).some(n => present.has(storeKey(n)) || mentions(text, n)));
}

/** "Wolf 2", "Bandit 3" and minions look like generic enemies rather than individuals. */
export function looksGeneric(block) {
    return /\s\d+$/.test(String(block?.name ?? '').trim()) || block?.tier === 'minion';
}

/** "Wolf 2" → "Wolf" (the name a template would be saved under). */
export function baseName(name) {
    return String(name ?? '').trim().replace(/\s+\d+$/, '');
}

/**
 * Finds the stored block an AI-listed combatant refers to.
 * @param {object} raw - an entry from the set-up reply
 * @param {object[]} known - confirmed stored blocks
 */
export function findKnown(raw, known) {
    if (!raw || typeof raw !== 'object' || !known?.length) return null;
    const key = storeKey(raw.name);
    const byName = known.find(b => namesOf(b).some(n => storeKey(n) === key));
    if (byName) return byName;
    const base = storeKey(baseName(raw.name));
    return known.find(b => namesOf(b).some(n => storeKey(n) === base)) || null;
}
