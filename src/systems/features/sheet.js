/**
 * The player's combat sheet: everything combat needs beyond the attributes and
 * skills the panel already tracks (bought values, resistances, abilities,
 * items), the point budget, the inventory link, and the global library of
 * saved character sheets.
 *
 * Per chat: extensionSettings.combatSheet (saved in chat_metadata).
 * Global:   extensionSettings.sheetLibrary (saved characters, optionally linked
 *           to a persona), extensionSettings.classTemplates (level-1 builds),
 *           extensionSettings.combat.
 * See docs/COMBAT_DESIGN.md §1, §7 and §10.
 */

import { getContext } from '../../../../../../extensions.js';
import { getCurrentChatId, user_avatar } from '../../../../../../../script.js';
import { extensionSettings } from '../../core/state.js';
import { saveSettings, saveChatData } from '../../core/persistence.js';
import { getAttributes, getSkills } from '../mechanics/character.js';
import { normalizeProgression } from '../mechanics/progression.js';
import {
    BUYABLE, DAMAGE_TYPES, RESISTANCES, normalizeAbility, normalizeCombatSettings, normalizeStatBlock, normalizeStrike
} from '../mechanics/combat/catalog.js';
import { apCap, abilityCost, abilityPoints, levelBudget, scaleToBudget, statBlockPoints } from '../mechanics/combat/costs.js';
import { BUILTIN_CLASSES } from '../mechanics/classes.js';
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
    const i = replaceId ? library.findIndex(e => e.id === replaceId) : -1;
    const entry = { id: replaceId || newId(), savedAt: Date.now(), ...snapshotFrom(parts, name) };
    // Overwriting keeps the persona link.
    if (i >= 0 && library[i].persona) {
        entry.persona = library[i].persona;
        entry.personaName = library[i].personaName;
    }
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

/* ---------------------------------------------------------------------------
   Persona links: a saved character that belongs to a persona is loaded into
   fresh chats with that persona, and kept up to date when the sheet is saved.
   --------------------------------------------------------------------------- */

/** The active persona: { key: its avatar file (SillyTavern's persona id), name }. */
export function currentPersona() {
    let context = {};
    try { context = getContext() || {}; } catch { /* no context */ }
    const key = context.user_avatar || user_avatar || '';
    return { key: String(key), name: context.name1 || playerName() };
}

/** The saved character linked to a persona (default: the active one), or null. */
export function linkedEntry(personaKey = currentPersona().key) {
    if (!personaKey) return null;
    return getLibrary().find(e => e.persona === personaKey) || null;
}

/** Links a saved character to the active persona (a persona has at most one). */
export function linkToPersona(id) {
    const { key, name } = currentPersona();
    if (!key) return null;
    let linked = null;
    for (const e of getLibrary()) {
        if (e.id === id) {
            e.persona = key;
            e.personaName = name;
            linked = e;
        } else if (e.persona === key) {
            delete e.persona;
            delete e.personaName;
        }
    }
    saveSettings();
    return linked;
}

export function unlinkPersona(id) {
    const e = getLibrary().find(x => x.id === id);
    if (!e) return;
    delete e.persona;
    delete e.personaName;
    saveSettings();
}

/** A chat whose character hasn't been set up yet: empty sheet, level 1, no EXP. */
export function isFreshCharacter() {
    const sheet = extensionSettings.combatSheet;
    const empty = !sheet || JSON.stringify(normalizeSheet(sheet)) === JSON.stringify(emptySheet());
    return empty && (Math.floor(extensionSettings.level) || 1) <= 1 && !(Number(extensionSettings.exp) > 0);
}

/**
 * Loads the active persona's linked character into this chat, if the chat's
 * character is still fresh. Called when the chat or the persona changes.
 * @returns {object|null} the entry loaded
 */
let linkedAppliedTo = null; // "chat|persona" last loaded, so it happens once per chat and persona

export function applyLinkedCharacter() {
    if (!extensionSettings.enabled) return null;
    let chatId = null;
    try { chatId = getCurrentChatId(); } catch { /* no chat */ }
    if (!chatId || !isFreshCharacter()) return null;
    const entry = linkedEntry();
    if (!entry) return null;
    const key = `${chatId}|${entry.persona}`;
    if (linkedAppliedTo === key) return null;
    const parts = partsFromSnapshot(entry);
    if (!parts) return null;
    linkedAppliedTo = key;
    applyParts(parts);
    return entry;
}

/** After the sheet is saved in a chat: updates the active persona's linked character. */
export function syncLinkedCharacter(parts = currentParts()) {
    const entry = linkedEntry();
    if (!entry) return null;
    return saveToLibrary(entry.name, parts, entry.id);
}

/* ---------------------------------------------------------------------------
   Class templates: level-1 builds (attributes, skills, abilities, items) to
   start a character from. Global, like the library.
   --------------------------------------------------------------------------- */

export function getClassTemplates() {
    if (!Array.isArray(extensionSettings.classTemplates)) extensionSettings.classTemplates = [];
    return extensionSettings.classTemplates;
}

/** CP a build costs at level 1 (bonus and glimmer points don't count). */
export function classTemplateCost(parts) {
    const p = sheetPoints({ ...parts, sheet: { ...normalizeSheet(parts.sheet), bonusPoints: 0, glimmerPoints: 0 }, level: 1 });
    return { spent: p.total, budget: p.base };
}

/** The template form of a build: level 1, no earned bonus points. */
function classSnapshot(parts, name) {
    const snap = snapshotFrom({ ...parts, level: 1 }, name);
    snap.level = 1;
    snap.bonusPoints = 0;
    snap.glimmerPoints = 0;
    snap.kind = 'class';
    return snap;
}

/**
 * Saves a build as a class template.
 * @returns {{ entry?: object, error?: string, spent: number, budget: number }}
 *   error 'overBudget' when the build costs more than a level-1 character has
 */
export function saveClassTemplate(name, parts = currentParts(), replaceId = null) {
    const { spent, budget } = classTemplateCost(parts);
    if (spent > budget) return { error: 'overBudget', spent, budget };
    const list = getClassTemplates();
    const entry = { id: replaceId || newId(), savedAt: Date.now(), ...classSnapshot(parts, name) };
    const i = replaceId ? list.findIndex(e => e.id === replaceId) : -1;
    if (i >= 0) list[i] = entry;
    else list.push(entry);
    saveSettings();
    return { entry, spent, budget };
}

export function deleteClassTemplate(id) {
    extensionSettings.classTemplates = getClassTemplates().filter(e => e.id !== id);
    saveSettings();
}

/** Adds an imported file (a class template or any saved character) as a class template. */
export function importClassTemplate(raw) {
    const snap = normalizeSnapshot(raw);
    if (!snap) return null;
    const entry = { ...snap, level: 1, bonusPoints: 0, glimmerPoints: 0, kind: 'class', id: newId(), savedAt: Date.now() };
    getClassTemplates().push(entry);
    saveSettings();
    return entry;
}

/** Scales a stat block's purchases by `f` (attributes above 10, skills, bought values, ability dice and shields). */
function shrinkBuild(block, f) {
    const scale = (v, min = 0) => Math.max(min, Math.floor(v * f));
    for (const [k, v] of Object.entries(block.attributes)) if (v > 10) block.attributes[k] = 10 + scale(v - 10);
    for (const [k, v] of Object.entries(block.skills)) block.skills[k] = scale(v);
    for (const [k, v] of Object.entries(block.bought)) {
        if (v > 0) block.bought[k] = scale(v);
        if (!block.bought[k]) delete block.bought[k];
    }
    for (const a of block.abilities) {
        for (const e of a.effects) {
            if ((e.type === 'damage' || e.type === 'heal') && e.dice) e.dice = scale(e.dice, 1);
            if (e.type === 'shield') e.amount = scale(e.amount, 1);
            const st = e.status;
            if (st && st.dice) st.dice = scale(st.dice, 1);
            if (st && st.template === 'shield') st.amount = scale(st.amount, 1);
        }
    }
}

/** Built-in classes (marked `builtin`) followed by the user's own. */
export function allClassTemplates() {
    return [...BUILTIN_CLASSES.map(c => ({ ...JSON.parse(JSON.stringify(c)), builtin: true })), ...getClassTemplates()];
}

/**
 * A working copy with a class template applied: the template's attributes,
 * skills, abilities, items, bought values, resistances and Strike replace the
 * current ones (tracked attributes it doesn't list go to 10, skills to 0;
 * attributes and skills this chat doesn't track are left out). The level,
 * bonus points and glimmer points stay. A build that costs more than a
 * level-1 character has with the current power level is trimmed to fit.
 * @returns {{ parts: object, trimmed: {from: number, to: number}|null }|null}
 */
export function partsWithClass(work, template) {
    const parts = partsFromSnapshot(template);
    if (!parts) return null;
    const tracked = (values, keys) => (keys.length ? Object.fromEntries(Object.entries(values).filter(([k]) => keys.includes(k))) : { ...values });
    const attributeKeys = Object.keys(work.attributes || {});
    const skillKeys = Object.keys(work.skills || {});
    const sheet = normalizeSheet({
        ...parts.sheet,
        bonusPoints: work.sheet?.bonusPoints || 0,
        glimmerPoints: work.sheet?.glimmerPoints || 0,
        glimmerPreferences: work.sheet?.glimmerPreferences || ''
    });
    const out = {
        ...work,
        sheet,
        attributes: { ...Object.fromEntries(attributeKeys.map(k => [k, 10])), ...tracked(parts.attributes, attributeKeys) },
        skills: { ...Object.fromEntries(skillKeys.map(k => [k, 0])), ...tracked(parts.skills, skillKeys) }
    };
    // Too big for this power level's level-1 budget: trim it like an NPC.
    const { spent, budget } = classTemplateCost(out);
    if (spent <= budget) return { parts: out, trimmed: null };
    const progression = normalizeProgression(extensionSettings.progression);
    const options = { tolerance: 1, skillCost: progression.skillCost, attributeCost: progression.attributeCost };
    const block = buildPlayerStatBlock({ ...out, sheet: { ...sheet, bonusPoints: 0, glimmerPoints: 0 }, level: 1 });
    // Shrink everything in proportion first, so the build keeps its shape,
    // then let the NPC trimmer shave off whatever is still over.
    shrinkBuild(block, budget / spent);
    scaleToBudget(block, budget, options);
    for (const k of Object.keys(out.attributes)) if (block.attributes[k] !== undefined) out.attributes[k] = block.attributes[k];
    for (const k of Object.keys(out.skills)) if (block.skills[k] !== undefined) out.skills[k] = block.skills[k];
    out.sheet = normalizeSheet({ ...sheet, bought: block.bought, abilities: block.abilities });
    return { parts: out, trimmed: { from: spent, to: classTemplateCost(out).spent } };
}
