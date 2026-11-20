/**
 * The player character's mechanical sheet, read from extension state.
 * Attributes come from the tracker config + classicStats (saved per chat);
 * skills come from the configured skill list + the AI-tracked skills, with
 * numeric levels kept per chat in extensionSettings.skillLevels.
 */

import { extensionSettings } from '../../core/state.js';
import { AVERAGE_ATTRIBUTE, attributeRoll } from './rules.js';

export const DEFAULT_ATTRIBUTES = [
    { id: 'str', name: 'STR', enabled: true },
    { id: 'dex', name: 'DEX', enabled: true },
    { id: 'con', name: 'CON', enabled: true },
    { id: 'int', name: 'INT', enabled: true },
    { id: 'wis', name: 'WIS', enabled: true },
    { id: 'cha', name: 'CHA', enabled: true }
];

/**
 * Enabled attributes with their current values and rolls.
 * @returns {{ id: string, name: string, value: number, roll: number }[]}
 */
export function getAttributes() {
    const configured = extensionSettings.trackerConfig?.userStats?.rpgAttributes;
    const list = Array.isArray(configured) && configured.length ? configured : DEFAULT_ATTRIBUTES;
    const values = extensionSettings.classicStats || {};
    return list
        .filter(attr => attr && attr.enabled && attr.id && attr.name)
        .map(attr => {
            const value = Number.isFinite(Number(values[attr.id])) ? Number(values[attr.id]) : AVERAGE_ATTRIBUTE;
            return { id: attr.id, name: attr.name, value, roll: attributeRoll(value) };
        });
}

/** Finds an attribute by id or display name, case-insensitively. */
export function findAttribute(idOrName) {
    const key = String(idOrName ?? '').trim().toLowerCase();
    if (!key) return null;
    return getAttributes().find(attr => attr.id.toLowerCase() === key || attr.name.toLowerCase() === key) || null;
}

export function skillKey(name) {
    return String(name ?? '').trim().toLowerCase();
}

/** Skill names from a value that may be an array of {name}/strings or a comma-separated string. */
function namesFrom(value) {
    if (!value) return [];
    const raw = Array.isArray(value)
        ? value.map(item => (typeof item === 'string' ? item : item?.name))
        : String(value).split(',');
    return raw
        .map(name => String(name ?? '').trim())
        .filter(name => name && name.toLowerCase() !== 'none');
}

/**
 * The character's skills with their levels. Empty when the skills section is off.
 * @returns {{ name: string, key: string, level: number }[]}
 */
export function getSkills() {
    const section = extensionSettings.trackerConfig?.userStats?.skillsSection;
    if (!section?.enabled) return [];

    const seen = new Map();
    for (const name of [...namesFrom(section.customFields), ...namesFrom(extensionSettings.userStats?.skills)]) {
        const key = skillKey(name);
        if (!seen.has(key)) seen.set(key, name);
    }

    const levels = extensionSettings.skillLevels || {};
    return [...seen.entries()].map(([key, name]) => ({
        name,
        key,
        level: Math.max(0, Number(levels[key]) || 0)
    }));
}

export function findSkill(name) {
    const key = skillKey(name);
    if (!key) return null;
    return getSkills().find(skill => skill.key === key) || null;
}

export function setSkillLevel(name, level) {
    if (!extensionSettings.skillLevels || typeof extensionSettings.skillLevels !== 'object') {
        extensionSettings.skillLevels = {};
    }
    extensionSettings.skillLevels[skillKey(name)] = Math.max(0, Math.floor(Number(level) || 0));
}
