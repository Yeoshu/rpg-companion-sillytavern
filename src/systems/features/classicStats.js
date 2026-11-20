/**
 * Classic Stats Module
 * Attribute (STR, DEX, ...) and skill-level controls in the user stats section.
 * Attributes have no upper limit; each tile also shows its 3d6 roll target.
 */

import {
    extensionSettings,
    $userStatsContainer
} from '../../core/state.js';
import { saveSettings, saveChatData } from '../../core/persistence.js';
import { updateFabWidgets } from '../ui/mobile.js';
import { updateStripWidgets } from '../ui/desktop.js';
import { attributeRoll, formatTarget, formatModifier, AVERAGE_ATTRIBUTE } from '../mechanics/rules.js';
import { getSkills, setSkillLevel } from '../mechanics/character.js';

const MIN_ATTRIBUTE = 1;

function setAttribute(stat, value) {
    const next = Math.max(MIN_ATTRIBUTE, Math.floor(Number(value)));
    if (!Number.isFinite(next)) return;
    extensionSettings.classicStats[stat] = next;
    saveSettings();
    saveChatData();
    updateFabWidgets();
    updateStripWidgets();
}

/** Updates one attribute tile in place (value + roll target). */
function refreshAttributeTile($tile, stat) {
    const value = extensionSettings.classicStats[stat] ?? AVERAGE_ATTRIBUTE;
    $tile.find('.rpg-classic-stat-value').text(value);
    $tile.find('.rpg-classic-stat-roll').text(formatTarget(attributeRoll(value)));
}

function changeSkill($chip, delta) {
    const key = $chip.data('skill');
    const skill = getSkills().find(s => s.key === key);
    if (!skill) return;
    setSkillLevel(skill.name, skill.level + delta);
    saveChatData();
    $chip.find('.rpg-skill-chip-level').text(formatModifier(Math.max(0, skill.level + delta)));
}

/**
 * Sets up delegated listeners (they survive re-renders of the stats section).
 */
export function setupClassicStatsButtons() {
    if (!$userStatsContainer) return;

    $userStatsContainer.on('click', '.rpg-stat-increase, .rpg-stat-decrease', function () {
        const stat = $(this).data('stat');
        const current = extensionSettings.classicStats[stat] ?? AVERAGE_ATTRIBUTE;
        const delta = $(this).hasClass('rpg-stat-increase') ? 1 : -1;
        setAttribute(stat, current + delta);
        refreshAttributeTile($(this).closest('.rpg-classic-stat'), stat);
    });

    // Type a value directly: Enter commits, invalid input reverts.
    $userStatsContainer.on('keydown', '.rpg-classic-stat-value', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            this.blur();
        }
    });
    $userStatsContainer.on('blur', '.rpg-classic-stat-value', function () {
        const stat = $(this).data('stat');
        const typed = parseInt($(this).text().trim(), 10);
        if (Number.isFinite(typed)) setAttribute(stat, typed);
        refreshAttributeTile($(this).closest('.rpg-classic-stat'), stat);
    });

    $userStatsContainer.on('click', '.rpg-skill-increase, .rpg-skill-decrease', function () {
        changeSkill($(this).closest('.rpg-skill-chip'), $(this).hasClass('rpg-skill-increase') ? 1 : -1);
    });
}
