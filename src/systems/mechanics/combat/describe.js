/**
 * Plain-English summaries of abilities, effects and statuses, for the sheet,
 * the builder and (later) prompts. Pure module.
 */

const TARGET_TEXT = {
    'self': 'self',
    'one-ally': 'one ally',
    'one-enemy': 'one enemy',
    'all-allies': 'all allies',
    'all-enemies': 'all enemies',
    'everyone': 'everyone else'
};

export function describeTarget(target) {
    return TARGET_TEXT[target] || target;
}

function dice(n, flat) {
    const parts = [];
    if (n) parts.push(`${n}d6`);
    if (flat) parts.push(n ? `+${flat}` : `${flat}`);
    return parts.join('') || '0';
}

function phases(n) {
    return `${n} phase${n === 1 ? '' : 's'}`;
}

/** "Burning: 1d6 fire per phase for 3 phases" */
export function describeStatusTemplate(st) {
    const name = st.name ? `${st.name}: ` : '';
    const resist = st.resistWith ? ` (${st.resistWith.toUpperCase()} roll halves)` : '';
    switch (st.template) {
        case 'overTime':
            return `${name}${st.dice}d6 ${st.heal ? 'healing' : st.damageType} per phase for ${phases(st.duration)}`;
        case 'modifier': {
            const sign = st.amount > 0 ? '+' : '−';
            const what = st.stat === 'damage' ? `${sign}${Math.abs(st.amount)}d6 damage` : `${sign}${Math.abs(st.amount)} ${st.stat.toUpperCase()}`;
            return `${name}${what} for ${phases(st.duration)}`;
        }
        case 'incapacitate':
            return `${name}loses ${phases(st.duration)}${resist}`;
        case 'shield':
            return `${name}absorbs ${st.amount} for ${phases(st.duration)}`;
        case 'taunt':
            return `${name}must target the user for ${phases(st.duration)}${resist}`;
        default:
            return st.name || st.template;
    }
}

export function describeEffect(e) {
    switch (e.type) {
        case 'damage': return `${dice(e.dice, e.flat)}${e.addStr ? ' (+STR)' : ''} ${e.damageType} damage`;
        case 'heal': return `heals ${dice(e.dice, e.flat)}`;
        case 'shield': return `shield absorbing ${e.amount} for ${phases(e.duration)}`;
        case 'status': return describeStatusTemplate(e.status);
        case 'cleanse': return `removes ${e.category === 'overTime' ? 'damage over time' : e.category === 'incapacitate' ? 'incapacitation' : `${e.category}s`}`;
        case 'restoreEnd': return `restores ${e.amount} END`;
        default: return e.type;
    }
}

const MODIFIER_TEXT = {
    armorPiercing: () => 'armour-piercing',
    lifesteal: m => `lifesteal ${m.percent}%`,
    accurate: m => `+${m.levels} OCV`,
    noEnd: () => 'no END',
    charges: m => `${m.uses} use${m.uses === 1 ? '' : 's'} per fight`,
    doubleEnd: () => 'double END',
    requiresRoll: m => `needs a ${m.skill || (m.attribute || '').toUpperCase()} roll`,
    itemBased: () => 'item-based',
    slow: () => 'slow'
};

/** "5d6 fire damage → one enemy (attack roll); armour-piercing" */
export function describeAbility(ability) {
    const effects = ability.effects.map(describeEffect).join(', ');
    const roll = ability.roll === 'attack' ? 'attack roll' : 'automatic';
    const mods = [...(ability.advantages || []), ...(ability.limitations || [])]
        .map(m => (MODIFIER_TEXT[m.id] ? MODIFIER_TEXT[m.id](m) : m.id));
    return `${effects} → ${describeTarget(ability.target)} (${roll})${mods.length ? `; ${mods.join(', ')}` : ''}`;
}
