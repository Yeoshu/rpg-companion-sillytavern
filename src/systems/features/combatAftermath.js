/**
 * After a fight: writes the player's HP and END to the tracker's Health and
 * Energy, takes used items off the inventory (or the sheet, for items that
 * aren't in the inventory), and keeps a log of the fight per chat.
 * See docs/COMBAT_DESIGN.md §9 and §10.
 */

import { extensionSettings } from '../../core/state.js';
import { saveSettings, saveChatData } from '../../core/persistence.js';
import { computeAftermath } from '../mechanics/combat/aftermath.js';
import { carriedEntries, getCombatSettings, getCombatSheet } from './sheet.js';
import { renderUserStats, updateUserStatsData } from '../rendering/userStats.js';
import { renderInventory } from '../rendering/inventory.js';

export const MAX_ENCOUNTER_LOGS = 10;

/** Maximum of an enabled tracker stat, or null if the tracker doesn't have it. */
function statMax(id) {
    const stat = (extensionSettings.trackerConfig?.userStats?.customStats || []).find(s => s?.id === id && s.enabled !== false);
    if (!stat) return null;
    return Number(stat.maxValue) > 0 ? Number(stat.maxValue) : 100;
}

/**
 * Applies the fight's outcome to the tracker (when the setting is on).
 * @param {object} state - the finished engine state
 * @returns {{ out: object, healthMax: number|null, energyMax: number|null } | null}
 */
export function applyAftermath(state) {
    const player = state.combatants.find(c => c.isPlayer);
    if (!player || !getCombatSettings().syncTracker) return null;
    const healthMax = statMax('health');
    const energyMax = statMax('energy');
    const out = computeAftermath({ player, healthMax, energyMax, entries: carriedEntries() });

    const stats = extensionSettings.userStats || (extensionSettings.userStats = {});
    if (out.health !== null) stats.health = out.health;
    if (out.energy !== null) stats.energy = out.energy;
    if (out.items.some(i => i.linked)) {
        const text = out.entries.join(', ') || 'None';
        if (stats.inventory && typeof stats.inventory === 'object') stats.inventory.onPerson = text;
        else stats.inventory = { version: 2, onPerson: text, clothing: 'None', stored: {}, assets: 'None' };
    }
    const sheet = getCombatSheet();
    for (const [id, quantity] of Object.entries(out.sheetQuantities)) {
        const item = (sheet.items || []).find(i => i.id === id);
        if (item) item.quantity = quantity;
    }

    try {
        updateUserStatsData();
    } catch (error) {
        console.warn('[RPG Companion] Could not update tracker data after combat:', error);
    }
    saveSettings();
    saveChatData();
    try {
        renderUserStats();
        renderInventory();
    } catch { /* panel not shown */ }
    $(document).trigger('rpg:progressionChanged');
    return { out, healthMax, energyMax };
}

/* ---------------------------------------------------------------------------
   Encounter logs (per chat, the last MAX_ENCOUNTER_LOGS)
   --------------------------------------------------------------------------- */

export function getEncounterLogs() {
    if (!Array.isArray(extensionSettings.encounterLogs)) extensionSettings.encounterLogs = [];
    return extensionSettings.encounterLogs;
}

/** Saves a finished fight to this chat's logs (when "Save combat logs" is on). */
export function saveEncounterRecord(record) {
    if (extensionSettings.encounterSettings?.autoSaveLogs === false) return;
    const logs = getEncounterLogs();
    logs.push({ timestamp: Date.now(), ...record });
    while (logs.length > MAX_ENCOUNTER_LOGS) logs.shift();
    saveChatData();
}

export function deleteEncounterRecord(timestamp) {
    extensionSettings.encounterLogs = getEncounterLogs().filter(l => l.timestamp !== timestamp);
    saveChatData();
}
