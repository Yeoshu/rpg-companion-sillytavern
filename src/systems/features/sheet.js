/**
 * The player's combat sheet: everything combat needs beyond the attributes and
 * skills the panel already tracks (bought values, resistances, abilities,
 * items), the point budget, the inventory link, and the global library of
 * saved character sheets.
 *
 * Per chat: extensionSettings.combatSheet (saved in chat_metadata).
 * Global:   extensionSettings.sheetLibrary, extensionSettings.combat.
 * See docs/COMBAT_DESIGN.md §1, §7 and §10.
 */

import { getContext } from '../../../../../../extensions.js';
import { extensionSettings } from '../../core/state.js';
import { saveSettings, saveChatData } from '../../core/persistence.js';
import { getAttributes, getSkills } from '../mechanics/character.js';
import { normalizeProgression } from '../mechanics/progression.js';
import {
    BUYABLE, DAMAGE_TYPES, RESISTANCES, normalizeAbility, normalizeCombatSettings, normalizeStatBlock, normalizeStrike
} from '../mechanics/combat/catalog.js';
import { apCap, abilityCost, abilityPoints, levelBudget, statBlockPoints } from '../mechanics/combat/costs.js';
import { inventoryQuantity } from '../mechanics/combat/inventory.js';
import { parseItems } from '../../utils/itemParser.js';

export const SHEET_VERSION = 1;

export function getCombatSettings() {
    return normalizeCombatSettings(extensionSettings.combat);
}

export function emptySheet() {
    return { bought: {}, resistances: {}, abilities: [], items: [], bonusPoints: 0, strike: normalizeStrike(null), glimmerPoints: 0, glimmerPreferences: '' };
}

/** Cleans a stored sheet (abilities and items go through the catalog sanitizers). */
export function normalizeSheet(raw) {
    const sheet = emptySheet();
    if (!raw || typeof raw !== 'object') return sheet;
    for (const key of Object.keys(BUYABLE)) {
        const v = Math.round(Number(raw.bought?.[key]) || 0);
        if (v) sheet.bought[key] = key === 'spd' ? Math.max(0, v) : v;
    }
    for (const [type, kind] of Object.entries(raw.resistances || {})) {
        if (DAMAGE_TYPES.includes(type) && RESISTANCES[kind]) sheet.resistances[type] = kind;
    }
    sheet.abilities = (raw.abilities || []).map(a => normalizeAbility(a)).filter(Boolean).map(a => { delete a.quantity; return a; });
    sheet.items = (raw.items || []).map(a => normalizeAbility(a, { item: true })).filter(Boolean);
    sheet.bonusPoints = Math.round(Number(raw.bonusPoints) || 0);
    sheet.strike = normalizeStrike(raw.strike);
    // Glimmered abilities come with bonus CP equal to their cost when found.
    sheet.glimmerPoints = Math.max(0, Math.round(Number(raw.glimmerPoints) || 0));
    sheet.glimmerPreferences = String(raw.glimmerPreferences ?? '').slice(0, 1000);
    return sheet;
}

/** This chat's combat sheet (created on first use). */
export function getCombatSheet() {
    if (!extensionSettings.combatSheet || typeof extensionSettings.combatSheet !== 'object') {
        extensionSettings.combatSheet = emptySheet();
    }
    return extensionSettings.combatSheet;
}

export function playerName() {
    try {
        return getContext()?.name1 || 'You';
    } catch {
        return 'You';
    }
}

function attributeValues(attributes = getAttributes()) {
    return Object.fromEntries(attributes.map(a => [a.id, a.value]));
}

function skillValues(skills = getSkills()) {
    return Object.fromEntries(skills.map(s => [s.key, s.level]));
}

/**
 * The player as a stat block (the same shape as NPCs and enemies).
 * @param {object} [parts] - overrides for an unsaved working copy:
 *   { sheet, attributes: {id: value}, skills: {key: level}, level }
 */
export function buildPlayerStatBlock(parts = {}) {
    const sheet = parts.sheet || getCombatSheet();
    const block = normalizeStatBlock({
        name: playerName(),
        level: parts.level ?? extensionSettings.level ?? 1,
        tier: 'standard',
        attributes: parts.attributes || attributeValues(),
        skills: parts.skills || skillValues(),
        bought: sheet.bought,
        resistances: sheet.resistances,
        abilities: sheet.abilities,
        items: sheet.items,
        strike: sheet.strike
    });
    // (normalizeStatBlock adds STR/DEX/CON at 10 when missing: 0 points.)
    return block;
}

/**
 * Points spent, the budget and what's left.
 * @returns {{ attributes, skills, bought, abilities, resistances, total, budget, base, bonus, unspent }}
 */
export function sheetPoints(parts = {}) {
    const progression = normalizeProgression(extensionSettings.progression);
    const settings = getCombatSettings();
    const sheet = parts.sheet || getCombatSheet();
    const block = buildPlayerStatBlock(parts);
    const spent = statBlockPoints(block, { skillCost: progression.skillCost, attributeCost: progression.attributeCost });
    const base = levelBudget(block.level, progression.pointsPerLevel, settings);
    const bonus = Math.round(Number(sheet.bonusPoints) || 0);
    const glimmer = Math.max(0, Math.round(Number(sheet.glimmerPoints) || 0));
    const budget = base + bonus + glimmer;
    return { ...spent, base, bonus, glimmer, budget, unspent: budget - spent.total };
}

/**
 * Adds an ability found through a glimmer to this chat's sheet, with bonus CP
 * equal to what it costs the sheet right now (so it's free; later changes
 * cost as usual, and deleting it keeps the points).
 * @returns {{ ability: object, points: number }}
 */
export function addGlimmeredAbility(raw) {
    const sheet = getCombatSheet();
    sheet.abilities = normalizeSheet(sheet).abilities;
    const ability = normalizeAbility({ ...raw, glimmered: true });
    if (!ability) return null;
    delete ability.quantity;
    let id = ability.id || 'glimmer';
    let n = 2;
    while (sheet.abilities.some(a => a.id === id)) id = `${ability.id}-${n++}`;
    ability.id = id;
    const points = abilityPoints(ability, sheet.abilities);
    sheet.abilities.push(ability);
    sheet.glimmerPoints = Math.max(0, Math.round(Number(sheet.glimmerPoints) || 0)) + points;
    sheetChanged();
    return { ability, points };
}

/** AP cap warning for one ability at the player's level. */
export function overCap(ability, level = extensionSettings.level) {
    return abilityCost(ability).ap > apCap(level, getCombatSettings());
}

export function sheetChanged() {
    saveSettings();
    saveChatData();
    $(document).trigger('rpg:progressionChanged');
}

/**
 * A tracker stat (Health, Energy) as a 0..1 fraction of its maximum, or null
 * when the tracker doesn't have it.
 */
export function trackerFraction(statId) {
    const config = extensionSettings.trackerConfig?.userStats?.customStats || [];
    const stat = config.find(s => s?.id === statId && s.enabled !== false);
    const value = Number(extensionSettings.userStats?.[statId]);
    if (!stat || !Number.isFinite(value)) return null;
    const max = Number(stat.maxValue) > 0 ? Number(stat.maxValue) : 100;
    return Math.max(0, Math.min(1, value / max));
}

/** The player's stat block as it enters a fight: items take their quantity from the inventory. */
export function playerCombatBlock() {
    const block = buildPlayerStatBlock();
    const entries = carriedEntries();
    block.items = block.items.map(item => (item.unlimited ? { ...item } : { ...item, quantity: itemStock(item, entries).quantity }));
    return block;
}

/* ---------------------------------------------------------------------------
   Inventory link
   --------------------------------------------------------------------------- */

/** Entries carried on the person, from the tracker inventory. */
export function carriedEntries() {
    const inv = extensionSettings.userStats?.inventory;
    const text = typeof inv === 'string' ? inv : inv?.onPerson;
    return parseItems(typeof text === 'string' ? text : '');
}

/**
 * How many of an item the character has: the tracker inventory when the item
 * is listed there, otherwise the item's own quantity.
 * @returns {{ quantity: number, linked: boolean }}
 */
export function itemStock(item, entries = carriedEntries()) {
    const n = inventoryQuantity(entries, item.name);
    return n === null ? { quantity: item.quantity ?? 0, linked: false } : { quantity: n, linked: true };
}

/* ---------------------------------------------------------------------------
   Library
   --------------------------------------------------------------------------- */

export function getLibrary() {
    if (!Array.isArray(extensionSettings.sheetLibrary)) extensionSettings.sheetLibrary = [];
    return extensionSettings.sheetLibrary;
}

/** The current chat's character (or an editor's working copy) as plain parts. */
export function currentParts() {
    return {
        sheet: JSON.parse(JSON.stringify(normalizeSheet(getCombatSheet()))),
        attributes: attributeValues(),
        skills: skillValues(),
        level: Math.max(1, Math.floor(extensionSettings.level) || 1)
    };
}

/** A portable snapshot of a character, for the library and export. */
export function snapshotFrom(parts, name = playerName()) {
    return {
        version: SHEET_VERSION,
        name,
        level: parts.level,
        attributes: { ...parts.attributes },
        attributeNames: Object.fromEntries(getAttributes().map(a => [a.id, a.name])),
        skills: { ...parts.skills },
        ...JSON.parse(JSON.stringify(normalizeSheet(parts.sheet)))
    };
}

/** Parts from a snapshot. Attributes this chat doesn't track keep their saved value on the side. */
export function partsFromSnapshot(raw) {
    const snap = normalizeSnapshot(raw);
    if (!snap) return null;
    return {
        sheet: normalizeSheet(snap),
        attributes: { ...snap.attributes },
        skills: { ...snap.skills },
        level: snap.level
    };
}

/** Writes parts into this chat and saves. */
export function applyParts(parts, { includeLevel = true } = {}) {
    extensionSettings.classicStats = { ...(extensionSettings.classicStats || {}), ...parts.attributes };
    extensionSettings.skillLevels = { ...(extensionSettings.skillLevels || {}), ...parts.skills };
    extensionSettings.combatSheet = normalizeSheet(parts.sheet);
    if (includeLevel && parts.level && parts.level !== extensionSettings.level) {
        extensionSettings.level = parts.level;
        extensionSettings.exp = 0;
    }
    sheetChanged();
}

function newId() {
    return `sheet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Validates a snapshot from storage or an imported file. */
export function normalizeSnapshot(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name ?? '').trim().slice(0, 80);
    if (!name) return null;
    const num = (v, d) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);
    const attributes = {};
    for (const [k, v] of Object.entries(raw.attributes || {})) attributes[String(k)] = Math.max(0, num(v, 10));
    const skills = {};
    for (const [k, v] of Object.entries(raw.skills || {})) skills[String(k).toLowerCase()] = Math.max(0, num(v, 0));
    return {
        version: SHEET_VERSION,
        name,
        level: Math.max(1, num(raw.level, 1)),
        attributes,
        attributeNames: raw.attributeNames && typeof raw.attributeNames === 'object' ? { ...raw.attributeNames } : {},
        skills,
        ...normalizeSheet(raw)
    };
}

/**
 * Saves a character to the library.
 * @param {string} name
 * @param {object} [parts] - defaults to the current chat's character
 * @param {string|null} [replaceId] - overwrite this entry instead of adding one
 */
export function saveToLibrary(name, parts = currentParts(), replaceId = null) {
    const library = getLibrary();
    const entry = { id: replaceId || newId(), savedAt: Date.now(), ...snapshotFrom(parts, name) };
    const i = replaceId ? library.findIndex(e => e.id === replaceId) : -1;
    if (i >= 0) library[i] = entry;
    else library.push(entry);
    saveSettings();
    return entry;
}

export function deleteFromLibrary(id) {
    extensionSettings.sheetLibrary = getLibrary().filter(e => e.id !== id);
    saveSettings();
}

/** Adds an imported snapshot (parsed JSON) to the library. */
export function importToLibrary(raw) {
    const snap = normalizeSnapshot(raw);
    if (!snap) return null;
    const entry = { ...snap, id: newId(), savedAt: Date.now() };
    getLibrary().push(entry);
    saveSettings();
    return entry;
}

/** Offers a snapshot as a .json download. */
export function downloadSnapshot(snapshot) {
    const { id, savedAt, ...data } = snapshot;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(data.name || 'character').replace(/[^\w.-]+/g, '_')}.rpg-sheet.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
