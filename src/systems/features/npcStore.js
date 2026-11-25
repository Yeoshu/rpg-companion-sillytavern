/**
 * Stored stat blocks of recurring characters.
 *
 * - Chat stat blocks (extensionSettings.statBlocks, saved per chat): named
 *   individuals. They keep their HP and END between fights.
 * - Templates (extensionSettings.npcTemplates, global): generic kinds of
 *   combatant ("Goblin") that can appear any number of times, in any chat.
 *
 * See docs/COMBAT_DESIGN.md §9 and §10.
 */

import { extensionSettings } from '../../core/state.js';
import { saveSettings, saveChatData } from '../../core/persistence.js';
import { normalizeStatBlock } from '../mechanics/combat/catalog.js';
import { baseName, storeKey } from '../mechanics/combat/npcs.js';

const clean = block => {
    const { budget, points, adjusted, stored, storedKey, fromTemplate, template, ...rest } = block;
    return normalizeStatBlock(JSON.parse(JSON.stringify(rest)));
};

function save() {
    saveSettings();
    saveChatData();
}

export function getChatBlocks() {
    if (!extensionSettings.statBlocks || typeof extensionSettings.statBlocks !== 'object') extensionSettings.statBlocks = {};
    return extensionSettings.statBlocks;
}

export function getTemplates() {
    if (!Array.isArray(extensionSettings.npcTemplates)) extensionSettings.npcTemplates = [];
    return extensionSettings.npcTemplates;
}

/** Everything that can be matched to a scene: chat blocks first, then templates (flagged). */
export function allStoredBlocks() {
    return [
        ...Object.values(getChatBlocks()),
        ...getTemplates().map(t => ({ ...t, template: true }))
    ];
}

export function hasChatBlock(name) {
    return Boolean(getChatBlocks()[storeKey(name)]);
}

export function hasTemplate(name) {
    return getTemplates().some(t => storeKey(t.name) === storeKey(baseName(name)));
}

/** Saves (or replaces) a named character in this chat. */
export function saveChatBlock(block, { hp, end } = {}) {
    const b = clean(block);
    if (!b) return null;
    if (hp !== undefined) b.hp = hp;
    if (end !== undefined) b.end = end;
    getChatBlocks()[storeKey(b.name)] = b;
    save();
    return b;
}

/** Saves a generic template under its base name ("Wolf 2" → "Wolf"). */
export function saveTemplate(block) {
    const b = clean({ ...block, name: baseName(block.name) });
    if (!b) return null;
    delete b.hp;
    delete b.end;
    const list = getTemplates();
    const i = list.findIndex(t => storeKey(t.name) === storeKey(b.name));
    if (i >= 0) list[i] = b;
    else list.push(b);
    save();
    return b;
}

export function deleteChatBlock(key) {
    delete getChatBlocks()[key];
    save();
}

export function deleteTemplate(name) {
    extensionSettings.npcTemplates = getTemplates().filter(t => storeKey(t.name) !== storeKey(name));
    save();
}

/** Back to full HP and END (they rested). */
export function restoreChatBlock(key) {
    const b = getChatBlocks()[key];
    if (!b) return;
    delete b.hp;
    delete b.end;
    save();
}

/** After a fight: stored individuals keep the HP and END they ended with. */
export function rememberWounds(combatants) {
    const blocks = getChatBlocks();
    let changed = false;
    for (const c of combatants) {
        const key = c.block.storedKey;
        if (!key || !blocks[key]) continue;
        blocks[key].hp = c.hp;
        blocks[key].end = c.end;
        changed = true;
    }
    if (changed) save();
}
