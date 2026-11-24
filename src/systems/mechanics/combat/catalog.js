/**
 * Combat catalog: the vocabulary abilities, items, statuses and stat blocks are
 * built from, and the sanitizers that turn loose input (the builder UI, saved
 * sheets, or JSON written by the AI) into valid objects.
 *
 * Pure module: no SillyTavern imports. See docs/COMBAT_DESIGN.md.
 */

export const PHYSICAL_TYPES = ['blunt', 'pierce', 'slash'];
export const ELEMENTAL_TYPES = ['fire', 'water', 'earth', 'air', 'ice', 'lightning', 'poison'];
export const DAMAGE_TYPES = [...PHYSICAL_TYPES, ...ELEMENTAL_TYPES];

export function isPhysical(type) {
    return PHYSICAL_TYPES.includes(type);
}

/** Damage multipliers for per-type resistances, and their point cost. */
export const RESISTANCES = {
    immune: { multiplier: 0, cost: 15 },
    resistant: { multiplier: 0.5, cost: 5 },
    weak: { multiplier: 1.5, cost: -5 }
};

export const TARGETS = ['self', 'one-ally', 'one-enemy', 'all-allies', 'all-enemies', 'everyone'];
export const AREA_TARGETS = ['all-allies', 'all-enemies', 'everyone'];

export const ROLLS = ['attack', 'automatic'];

export const EFFECT_TYPES = ['damage', 'heal', 'shield', 'status', 'cleanse', 'restoreEnd'];

export const STATUS_TEMPLATES = ['overTime', 'modifier', 'incapacitate', 'shield', 'taunt'];

export const CLEANSE_CATEGORIES = ['overTime', 'debuff', 'buff', 'incapacitate'];

/**
 * Values a combatant can buy with CP and that modifier statuses can change.
 * `cost` is CP per +1 (HP and END: per point, 2 points per CP).
 */
export const BUYABLE = {
    hp: { label: 'HP', cost: 0.5 },
    end: { label: 'END', cost: 0.5 },
    rec: { label: 'REC', cost: 2 },
    ocv: { label: 'OCV', cost: 5 },
    dcv: { label: 'DCV', cost: 5 },
    pd: { label: 'PD', cost: 3 },
    ed: { label: 'ED', cost: 3 },
    spd: { label: 'SPD', cost: 10 }
};

/** Values a modifier status can target besides attributes. */
export const MODIFIER_STATS = ['ocv', 'dcv', 'pd', 'ed', 'spd', 'damage'];
/** CP per +1 of a modifier stat (attributes cost 1, `damage` is +1d6). */
export const MODIFIER_COST = { ocv: 5, dcv: 5, pd: 3, ed: 3, spd: 10, damage: 5, attribute: 1 };

/** Advantages raise an ability's Active Points: AP = base × (1 + sum). */
export const ADVANTAGES = {
    armorPiercing: { label: 'Armour-piercing', value: () => 0.5 },
    lifesteal: { label: 'Lifesteal', value: a => clamp(a.percent, 1, 100, 50) / 100 },
    accurate: { label: 'Accurate', value: a => 0.25 * clamp(a.levels, 1, 10, 1) },
    noEnd: { label: 'No END cost', value: () => 0.5 }
};
/** Area targets add this advantage automatically. */
export const AREA_ADVANTAGE = 1;

/** Limitations lower the real cost: real = AP / (1 + sum). */
export const LIMITATIONS = {
    charges: { label: 'Charges', value: l => chargesLimitation(clamp(l.uses, 1, 99, 1)) },
    doubleEnd: { label: 'Costs double END', value: () => 0.5 },
    requiresRoll: { label: 'Requires a skill roll', value: () => 0.5 },
    itemBased: { label: 'Item-based', value: () => 0.5 },
    slow: { label: 'Slow', value: () => 0.25 }
};

export function chargesLimitation(uses) {
    if (uses <= 1) return 1;
    if (uses <= 3) return 0.75;
    if (uses <= 8) return 0.5;
    return 0.25;
}

/**
 * Enemy tiers: budget multiplier (of the level budget) and HP multiplier.
 * EXP rewards use the HP multiplier. Tuned by simulation against a 50 CP
 * level 1 character: one standard enemy is an easy win (~95%), two are a
 * real risk (~35%), three minions about even (~55%), an elite alone about
 * even (~50%), and a boss is meant for a party (~10% solo).
 */
export const TIERS = {
    minion: { label: 'Minion', budget: 0.4, hp: 0.5 },
    standard: { label: 'Standard', budget: 0.45, hp: 1 },
    elite: { label: 'Elite', budget: 0.6, hp: 1.5 },
    boss: { label: 'Boss', budget: 0.8, hp: 2 }
};

export const DEFAULT_COMBAT = Object.freeze({
    /** CP a level 1 character is built on. */
    startingPool: 50,
    /** Ability AP cap warning: base + perLevel × level. */
    apCapBase: 25,
    apCapPerLevel: 5,
    /** AI stat blocks over budget × this are scaled down. */
    budgetTolerance: 1.1,
    /** Everyone acts once per turn, in DEX order. */
    equalSpeed: false,
    /** Which attribute plays each role in the derived values. */
    roles: Object.freeze({ str: 'str', dex: 'dex', con: 'con' })
});

export function normalizeCombatSettings(settings = {}) {
    const d = DEFAULT_COMBAT;
    const roles = settings.roles || {};
    return {
        startingPool: clamp(settings.startingPool, 0, 10000, d.startingPool),
        apCapBase: clamp(settings.apCapBase, 0, 10000, d.apCapBase),
        apCapPerLevel: clamp(settings.apCapPerLevel, 0, 1000, d.apCapPerLevel),
        budgetTolerance: clamp(settings.budgetTolerance, 1, 10, d.budgetTolerance),
        equalSpeed: Boolean(settings.equalSpeed),
        roles: {
            str: slug(roles.str) || d.roles.str,
            dex: slug(roles.dex) || d.roles.dex,
            con: slug(roles.con) || d.roles.con
        }
    };
}

// ---------------------------------------------------------------------------
// Helpers

export function clamp(value, min, max, fallback = min) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function int(value, min, max, fallback = min) {
    return Math.round(clamp(value, min, max, fallback));
}

export function slug(value) {
    return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Loose matching for AI-written enums: "One Enemy", "one_enemy" → "one-enemy". */
function pick(value, allowed, fallback) {
    const key = slug(value).replace(/-/g, '');
    return allowed.find(a => a.toLowerCase().replace(/-/g, '') === key) ?? fallback;
}

function text(value, max = 500) {
    return String(value ?? '').trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// Sanitizers

/**
 * A status. Durations count the affected character's own phases.
 * @returns {object|null}
 */
export function normalizeStatus(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const template = pick(raw.template ?? raw.type, STATUS_TEMPLATES, null);
    if (!template) return null;
    const status = {
        name: text(raw.name, 60) || template,
        description: text(raw.description),
        template,
        duration: int(raw.duration, 1, 20, 1)
    };
    if (template === 'overTime') {
        status.heal = Boolean(raw.heal);
        status.dice = int(raw.dice, 1, 20, 1);
        if (!status.heal) status.damageType = pick(raw.damageType, DAMAGE_TYPES, 'poison');
    } else if (template === 'modifier') {
        const stat = slug(raw.stat);
        status.stat = MODIFIER_STATS.includes(stat) ? stat : (stat || 'ocv');
        status.amount = int(raw.amount, -50, 50, -1);
        if (status.amount === 0) return null;
    } else if (template === 'shield') {
        status.amount = int(raw.amount, 1, 500, 5);
    }
    if (template === 'incapacitate' || template === 'taunt') {
        // Attribute role or id the target resists with ('' = no resistance roll).
        status.resistWith = raw.resistWith === '' || raw.resistWith === false ? '' : (slug(raw.resistWith) || 'con');
    }
    return status;
}

export function normalizeEffect(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const type = pick(raw.type, EFFECT_TYPES, null);
    switch (type) {
        case 'damage':
            return {
                type,
                dice: int(raw.dice, 0, 50, 0),
                flat: int(raw.flat, 0, 200, 0),
                damageType: pick(raw.damageType, DAMAGE_TYPES, 'blunt'),
                addStr: Boolean(raw.addStr)
            };
        case 'heal':
            return { type, dice: int(raw.dice, 0, 50, 0), flat: int(raw.flat, 0, 200, 0) };
        case 'shield':
            return { type, amount: int(raw.amount, 1, 500, 5), duration: int(raw.duration, 1, 20, 1) };
        case 'status': {
            const status = normalizeStatus(raw.status ?? raw);
            return status ? { type, status } : null;
        }
        case 'cleanse':
            return { type, category: pick(raw.category, CLEANSE_CATEGORIES, 'debuff') };
        case 'restoreEnd':
            return { type, amount: int(raw.amount, 1, 500, 5) };
        default:
            return null;
    }
}

function normalizeModifiers(list, catalog) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const raw of list) {
        const id = typeof raw === 'string' ? raw : raw?.id;
        const key = Object.keys(catalog).find(k => k.toLowerCase() === String(id ?? '').toLowerCase().replace(/[^a-z]/g, ''));
        if (!key || out.some(m => m.id === key)) continue;
        const entry = { id: key };
        if (key === 'lifesteal') entry.percent = int(raw?.percent, 1, 100, 50);
        if (key === 'accurate') entry.levels = int(raw?.levels, 1, 10, 1);
        if (key === 'charges') entry.uses = int(raw?.uses, 1, 99, 1);
        if (key === 'requiresRoll') {
            entry.skill = text(raw?.skill, 60);
            entry.attribute = slug(raw?.attribute) || 'int';
        }
        out.push(entry);
    }
    return out;
}

/**
 * An ability (or, with `quantity`, an item).
 * @returns {object|null} null when nothing usable is left
 */
export function normalizeAbility(raw, { item = false } = {}) {
    if (!raw || typeof raw !== 'object') return null;
    const name = text(raw.name, 80);
    if (!name) return null;
    const effects = (Array.isArray(raw.effects) ? raw.effects : []).map(normalizeEffect).filter(Boolean);
    if (!effects.length) return null;
    const ability = {
        id: slug(raw.id) || slug(name),
        name,
        description: text(raw.description),
        target: pick(raw.target, TARGETS, 'one-enemy'),
        roll: pick(raw.roll, ROLLS, 'attack'),
        effects,
        advantages: normalizeModifiers(raw.advantages, ADVANTAGES),
        limitations: normalizeModifiers(raw.limitations, LIMITATIONS)
    };
    if (item || raw.quantity !== undefined) {
        ability.quantity = int(raw.quantity, 0, 999, 1);
    }
    return ability;
}

function uniqueIds(list) {
    const seen = new Set();
    for (const a of list) {
        let id = a.id || 'ability';
        let n = 2;
        while (seen.has(id)) id = `${a.id}-${n++}`;
        a.id = id;
        seen.add(id);
    }
    return list;
}

/**
 * A stat block: the same shape for the player, allies and enemies.
 */
export function normalizeStatBlock(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = text(raw.name, 80);
    if (!name) return null;

    const attributes = {};
    for (const [key, value] of Object.entries(raw.attributes || {})) {
        const id = slug(key);
        if (id) attributes[id] = int(value, 0, 1000, 10);
    }
    for (const id of ['str', 'dex', 'con']) {
        if (attributes[id] === undefined) attributes[id] = 10;
    }

    const bought = {};
    for (const key of Object.keys(BUYABLE)) {
        const v = int(raw.bought?.[key], key === 'spd' ? 0 : -1000, 1000, 0);
        if (v) bought[key] = v;
    }

    const resistances = {};
    for (const [key, value] of Object.entries(raw.resistances || {})) {
        const type = pick(key, DAMAGE_TYPES, null);
        const kind = pick(value, Object.keys(RESISTANCES), null);
        if (type && kind) resistances[type] = kind;
    }

    const skills = {};
    for (const [key, value] of Object.entries(raw.skills || {})) {
        const n = text(key, 60).toLowerCase();
        if (n) skills[n] = int(value, 0, 100, 0);
    }

    const block = {
        name,
        aliases: (Array.isArray(raw.aliases) ? raw.aliases : []).map(a => text(a, 80)).filter(Boolean),
        level: int(raw.level, 1, 1000, 1),
        tier: pick(raw.tier, Object.keys(TIERS), 'standard'),
        attributes,
        bought,
        resistances,
        skills,
        abilities: uniqueIds((raw.abilities || []).map(a => normalizeAbility(a)).filter(Boolean).map(a => { delete a.quantity; return a; })),
        items: uniqueIds((raw.items || []).map(a => normalizeAbility(a, { item: true })).filter(Boolean)),
        description: text(raw.description, 1000),
        sprite: text(raw.sprite, 16)
    };
    if (raw.hp !== undefined && raw.hp !== null) block.hp = int(raw.hp, 0, 100000, 0);
    if (raw.end !== undefined && raw.end !== null) block.end = int(raw.end, 0, 100000, 0);
    return block;
}
