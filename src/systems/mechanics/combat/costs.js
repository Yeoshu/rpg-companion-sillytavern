/**
 * Combat costs: derived values, Active Points / real cost / END of abilities,
 * the point value of a stat block, budgets, and scaling AI-written stat blocks
 * down to budget.
 *
 * Pure module. See docs/COMBAT_DESIGN.md §2, §3, §4 and §7.
 */

import {
    ADVANTAGES, AREA_ADVANTAGE, AREA_TARGETS, BUYABLE, DEFAULT_COMBAT, LIMITATIONS,
    MODIFIER_COST, RESISTANCES, TIERS
} from './catalog.js';

const fifth = v => Math.round((Number(v) || 0) / 5);

/** Value of the attribute playing `role` (str/dex/con), with an optional override map. */
export function roleValue(attributes, role, roles = DEFAULT_COMBAT.roles) {
    const id = roles[role] || role;
    const v = attributes?.[id];
    return Number.isFinite(Number(v)) ? Number(v) : 10;
}

/**
 * Derived combat values for a stat block (before statuses and tier).
 * @param {object} block - normalized stat block
 * @param {object} settings - normalized combat settings
 */
export function deriveValues(block, settings = DEFAULT_COMBAT) {
    const roles = settings.roles || DEFAULT_COMBAT.roles;
    const STR = roleValue(block.attributes, 'str', roles);
    const DEX = roleValue(block.attributes, 'dex', roles);
    const CON = roleValue(block.attributes, 'con', roles);
    const b = block.bought || {};
    const tier = TIERS[block.tier] || TIERS.standard;
    const baseHp = 20 + 2 * CON + (b.hp || 0);
    return {
        maxHp: Math.max(1, Math.round(baseHp * tier.hp)),
        maxEnd: Math.max(0, 2 * CON + (b.end || 0)),
        rec: Math.max(0, fifth(STR) + fifth(CON) + (b.rec || 0)),
        ocv: Math.max(0, fifth(DEX) + (b.ocv || 0)),
        dcv: Math.max(0, fifth(DEX) + (b.dcv || 0)),
        pd: Math.max(0, fifth(STR) + (b.pd || 0)),
        ed: Math.max(0, fifth(CON) + (b.ed || 0)),
        spd: Math.min(12, Math.max(1, 1 + Math.floor(DEX / 10) + (b.spd || 0))),
        strDice: Math.max(0, fifth(STR)),
        /** Dice that STR above 10 adds to physical abilities with "adds STR". */
        strBonusDice: Math.max(0, fifth(STR - 10))
    };
}

/** 1 + ¼ per phase after the first. */
export function durationFactor(duration) {
    return 1 + 0.25 * Math.max(0, (Number(duration) || 1) - 1);
}

/** Active Points of a status (§4). */
export function statusCost(status) {
    const d = status.duration || 1;
    switch (status.template) {
        case 'overTime':
            return status.dice * (status.heal ? 10 : 5) * d * 0.75;
        case 'modifier': {
            const per = MODIFIER_COST[status.stat] ?? MODIFIER_COST.attribute;
            return per * Math.abs(status.amount) * durationFactor(d);
        }
        case 'incapacitate':
            return 10 * d;
        case 'shield':
            return status.amount * durationFactor(d);
        case 'taunt':
            return 5 * d;
        default:
            return 0;
    }
}

/** Base cost of one effect, before advantages. */
export function effectCost(effect) {
    switch (effect.type) {
        case 'damage': return 5 * effect.dice + 2 * effect.flat;
        case 'heal': return 10 * effect.dice + 4 * effect.flat;
        case 'shield': return effect.amount * durationFactor(effect.duration);
        case 'status': return statusCost(effect.status);
        case 'cleanse': return 5;
        case 'restoreEnd': return effect.amount;
        default: return 0;
    }
}

function sumModifiers(list, catalog) {
    return (list || []).reduce((sum, m) => sum + (catalog[m.id] ? catalog[m.id].value(m) : 0), 0);
}

export function hasModifier(ability, id) {
    return (ability.advantages || []).some(m => m.id === id) || (ability.limitations || []).some(m => m.id === id);
}

export function getModifier(ability, id) {
    return (ability.advantages || []).find(m => m.id === id) || (ability.limitations || []).find(m => m.id === id) || null;
}

/**
 * Costs of an ability.
 * @returns {{ base: number, advantages: number, limitations: number, ap: number, real: number, end: number }}
 */
export function abilityCost(ability) {
    const base = ability.effects.reduce((sum, e) => sum + effectCost(e), 0);
    const advantages = sumModifiers(ability.advantages, ADVANTAGES) + (AREA_TARGETS.includes(ability.target) ? AREA_ADVANTAGE : 0);
    const limitations = sumModifiers(ability.limitations, LIMITATIONS);
    const ap = Math.round(base * (1 + advantages));
    const real = Math.round(ap / (1 + limitations));
    let end = 0;
    if (!hasModifier(ability, 'noEnd') && !hasModifier(ability, 'charges')) {
        end = Math.max(1, Math.round(ap / 10)) * (hasModifier(ability, 'doubleEnd') ? 2 : 1);
    }
    return { base, advantages, limitations, ap, real, end };
}

/** AP above which an ability gets a warning at this level. */
export function apCap(level, settings = DEFAULT_COMBAT) {
    return settings.apCapBase + settings.apCapPerLevel * Math.max(1, level || 1);
}

/**
 * Point budget at a level (before tier).
 * @param {number} level
 * @param {number} pointsPerLevel - from progression settings
 */
export function levelBudget(level, pointsPerLevel, settings = DEFAULT_COMBAT) {
    return settings.startingPool + pointsPerLevel * (Math.max(1, level || 1) - 1);
}

/** Budget for an enemy of this level and tier. */
export function tierBudget(level, tier, pointsPerLevel, settings = DEFAULT_COMBAT) {
    return Math.round(levelBudget(level, pointsPerLevel, settings) * (TIERS[tier] || TIERS.standard).budget);
}

/**
 * Point value of a stat block. Items are free (equipment comes from the story).
 * @returns {{ attributes: number, skills: number, bought: number, abilities: number, resistances: number, total: number }}
 */
export function statBlockPoints(block, { skillCost = 2, attributeCost = 1 } = {}) {
    const attributes = Object.values(block.attributes || {}).reduce((s, v) => s + (v - 10) * attributeCost, 0);
    const skills = Object.values(block.skills || {}).reduce((s, v) => s + v * skillCost, 0);
    const bought = Object.entries(block.bought || {}).reduce((s, [k, v]) => s + (BUYABLE[k] ? BUYABLE[k].cost * v : 0), 0);
    const abilities = abilityPoolCost(block.abilities || []);
    const resistances = Object.values(block.resistances || {}).reduce((s, k) => s + (RESISTANCES[k]?.cost || 0), 0);
    const total = Math.round(attributes + skills + bought + abilities + resistances);
    return { attributes, skills, bought: Math.round(bought), abilities, resistances, total };
}

/**
 * Abilities are priced like a HERO Multipower, because only one can be used
 * per phase anyway: the most expensive one costs its full real cost, every
 * other one a fifth of its real cost (rounded up).
 */
export const EXTRA_ABILITY_FRACTION = 0.2;

export function abilityPoolCost(abilities) {
    const costs = abilities.map(a => abilityCost(a).real).sort((a, b) => b - a);
    return costs.reduce((sum, c, i) => sum + (i === 0 ? c : Math.ceil(c * EXTRA_ABILITY_FRACTION)), 0);
}

/** CP an ability adds to a sheet that already has `others`. */
export function abilityPoints(ability, others = []) {
    return abilityPoolCost([...others, ability]) - abilityPoolCost(others);
}

/** One step of reducing the most expensive part of an ability. Returns false if nothing left to cut. */
function shrinkAbility(ability) {
    // Biggest effect first.
    const effects = [...ability.effects].sort((a, b) => effectCost(b) - effectCost(a));
    for (const e of effects) {
        if ((e.type === 'damage' || e.type === 'heal') && e.dice > 1) { e.dice -= 1; return true; }
        if ((e.type === 'damage' || e.type === 'heal') && e.flat > 0) { e.flat = Math.max(0, e.flat - 2); return true; }
        if (e.type === 'status') {
            const s = e.status;
            if (s.duration > 1) { s.duration -= 1; return true; }
            if (s.template === 'overTime' && s.dice > 1) { s.dice -= 1; return true; }
            if (s.template === 'modifier' && Math.abs(s.amount) > 1) { s.amount -= Math.sign(s.amount); return true; }
            if (s.template === 'shield' && s.amount > 2) { s.amount = Math.ceil(s.amount / 2); return true; }
        }
        if (e.type === 'shield' && e.amount > 2) { e.amount = Math.ceil(e.amount * 0.75); return true; }
        if (e.type === 'restoreEnd' && e.amount > 2) { e.amount = Math.ceil(e.amount * 0.75); return true; }
    }
    return false;
}

/**
 * Shrinks an ability until its Active Points are at most `maxAp` (used for
 * improvised actions). Mutates and returns it.
 */
export function capAbility(ability, maxAp) {
    let guard = 200;
    while (abilityCost(ability).ap > maxAp && guard-- > 0) {
        if (!shrinkAbility(ability)) break;
    }
    return ability;
}

/**
 * Scales an (AI-written) stat block down until it is within budget × tolerance.
 * Cuts whatever currently costs the most: an ability's biggest effect, a
 * bought value, or an attribute above 10. Mutates and returns the block, with
 * `adjusted: true` when anything changed.
 */
export function scaleToBudget(block, budget, options = {}) {
    const tolerance = options.tolerance ?? DEFAULT_COMBAT.budgetTolerance;
    const limit = Math.max(0, budget * tolerance);
    let guard = 2000;
    let adjusted = false;
    while (statBlockPoints(block, options).total > limit && guard-- > 0) {
        const candidates = [];
        for (const a of block.abilities) candidates.push({ cost: abilityCost(a).real, cut: () => shrinkAbility(a) });
        for (const [k, v] of Object.entries(block.bought)) {
            if (v > 0) candidates.push({ cost: BUYABLE[k].cost * v, cut: () => { block.bought[k] = v - 1; if (!block.bought[k]) delete block.bought[k]; return true; } });
        }
        for (const [k, v] of Object.entries(block.attributes)) {
            if (v > 10) candidates.push({ cost: v - 10, cut: () => { block.attributes[k] = v - 1; return true; } });
        }
        for (const [k, v] of Object.entries(block.skills)) {
            if (v > 0) candidates.push({ cost: v * 2, cut: () => { block.skills[k] = v - 1; return true; } });
        }
        candidates.sort((a, b) => b.cost - a.cost);
        let cut = false;
        for (const c of candidates) {
            if (c.cut()) { cut = true; break; }
        }
        if (!cut) {
            // Only single-die abilities left over budget: drop the most expensive one.
            const worst = [...block.abilities].sort((a, b) => abilityCost(b).real - abilityCost(a).real)[0];
            if (!worst || block.abilities.length <= 1) break;
            block.abilities = block.abilities.filter(a => a !== worst);
        }
        adjusted = true;
    }
    if (adjusted) block.adjusted = true;
    return block;
}
