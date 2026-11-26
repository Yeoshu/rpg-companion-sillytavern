/**
 * Keeps stats the user switched off in the Tracker Editor out of prompts.
 *
 * Saved tracker data (the last update, committed tracker data) can still hold
 * values for stats that were switched off later, so everything that pastes
 * that data into a prompt passes it through here first.
 *
 * Pure module (no SillyTavern imports).
 */

function disabledStats(userStatsConfig) {
    return (userStatsConfig?.customStats || []).filter(s => s && s.enabled === false);
}

function matches(stat, key) {
    const k = String(key ?? '').toLowerCase().trim();
    return Boolean(k) && (String(stat.id ?? '').toLowerCase() === k || String(stat.name ?? '').toLowerCase().trim() === k);
}

/**
 * User stats without the switched-off ones.
 * @param {object|string} userStats - tracker JSON (object or string), or the old "Health: 80%" text
 * @param {object} userStatsConfig - extensionSettings.trackerConfig.userStats
 * @returns {object|string} the same kind of value it was given
 */
export function withoutDisabledStats(userStats, userStatsConfig) {
    const off = disabledStats(userStatsConfig);
    if (!off.length || !userStats) return userStats;
    const isOff = key => off.some(stat => matches(stat, key));

    if (typeof userStats === 'string') {
        let parsed = null;
        try {
            parsed = JSON.parse(userStats);
        } catch {
            // Old text format: drop "Health: 80%" lines.
            return userStats.split('\n').filter(line => {
                const m = line.match(/^\s*[-*]?\s*([^:]+):/);
                return !(m && isOff(m[1]));
            }).join('\n');
        }
        return parsed && typeof parsed === 'object' ? JSON.stringify(withoutDisabledStats(parsed, userStatsConfig), null, 2) : userStats;
    }

    if (typeof userStats !== 'object') return userStats;
    const copy = JSON.parse(JSON.stringify(userStats));
    if (Array.isArray(copy.stats)) copy.stats = copy.stats.filter(s => !(s && (isOff(s.id) || isOff(s.name))));
    for (const key of Object.keys(copy)) {
        if (key !== 'stats' && isOff(key)) delete copy[key];
    }
    return copy;
}

/**
 * Present Characters data without the character stats switched off in the
 * Tracker Editor (all of them when the Character Stats section is off).
 * @param {object|array|string} characters - tracker JSON ({characters: [...]} or an array), object or string
 * @param {object} presentCharactersConfig - extensionSettings.trackerConfig.presentCharacters
 * @returns {object|array|string} the same kind of value it was given
 */
export function withoutDisabledCharacterStats(characters, presentCharactersConfig) {
    const statsConfig = presentCharactersConfig?.characterStats;
    const allOff = statsConfig?.enabled === false;
    const off = (statsConfig?.customStats || []).filter(s => s && s.enabled === false);
    if (!characters || (!allOff && !off.length)) return characters;
    const isOff = key => off.some(stat => matches(stat, key));

    if (typeof characters === 'string') {
        let parsed = null;
        try {
            parsed = JSON.parse(characters);
        } catch {
            return characters; // old text format: left as it is
        }
        return parsed && typeof parsed === 'object' ? JSON.stringify(withoutDisabledCharacterStats(parsed, presentCharactersConfig), null, 2) : characters;
    }
    if (typeof characters !== 'object') return characters;
    const copy = JSON.parse(JSON.stringify(characters));
    const list = Array.isArray(copy) ? copy : (Array.isArray(copy.characters) ? copy.characters : []);
    for (const c of list) {
        if (!c || typeof c !== 'object' || c.stats === undefined) continue;
        if (allOff) delete c.stats;
        else if (Array.isArray(c.stats)) c.stats = c.stats.filter(s => !(s && (isOff(s.id) || isOff(s.name))));
        else if (typeof c.stats === 'object') for (const k of Object.keys(c.stats)) if (isOff(k)) delete c.stats[k];
    }
    return copy;
}
