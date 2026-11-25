/**
 * Glimmers (after SaGa): using a technique on a dangerous enemy can spark a
 * new one. The chance is rolled locally; only the new ability itself comes
 * from the AI. Pure module.
 */

import { normalizeAbility } from './catalog.js';
import { abilityCost, capAbility } from './costs.js';
import { describeAbility, describeStatBlock } from './describe.js';

/** How much more likely a glimmer is per enemy tier. */
export const GLIMMER_TIER_FACTOR = { minion: 0.25, standard: 1, elite: 2, boss: 3 };
/** Per level the enemy is above (or below) the user. */
export const GLIMMER_LEVEL_FACTOR = 1.4;
export const GLIMMER_MAX_CHANCE = 0.5;

/**
 * Chance (0..1) that using a technique on `enemy` sparks a glimmer.
 * @param {{level: number, tier: string}} enemy
 * @param {number} userLevel
 * @param {number} basePercent - settings.glimmerChance
 */
export function glimmerChance(enemy, userLevel, basePercent) {
    const diff = Math.max(-5, Math.min(5, (Number(enemy?.level) || userLevel) - userLevel));
    const tier = GLIMMER_TIER_FACTOR[enemy?.tier] ?? 1;
    return Math.min(GLIMMER_MAX_CHANCE, Math.max(0, (basePercent / 100) * tier * Math.pow(GLIMMER_LEVEL_FACTOR, diff)));
}

/** Active Points to aim for: a step up from the technique that sparked it, within the level guide. */
export function glimmerTargetAp(seed, apCapValue) {
    const seedAp = seed ? abilityCost(seed).ap : 10;
    return Math.max(10, Math.min(apCapValue, Math.round(seedAp * 1.2 + 5)));
}

const ABILITY_FORMAT = `{
  "name": "Short evocative name",
  "description": "One sentence of flavour: what it looks like",
  "target": "self|one-ally|one-enemy|all-allies|all-enemies|everyone",
  "roll": "attack|automatic",
  "effects": [ ... ],
  "advantages": [],
  "limitations": []
}
Effects:
  {"type": "damage", "dice": N, "flat": 0, "damageType": "blunt|pierce|slash|fire|water|earth|air|ice|lightning|poison", "scaleWith": "none|str|dex"}
  {"type": "heal", "dice": N}
  {"type": "shield", "amount": N, "duration": phases}
  {"type": "status", "status": {"template": "overTime", "name": "Burning", "dice": 1, "damageType": "fire", "duration": 3}}
  {"type": "status", "status": {"template": "modifier", "name": "Weakened", "stat": "ocv|dcv|pd|ed|spd|damage|str|dex|con", "amount": -2, "duration": 3}}
  {"type": "status", "status": {"template": "incapacitate", "name": "Stunned", "duration": 1}}
  {"type": "status", "status": {"template": "taunt", "name": "Provoked", "duration": 2}}
  {"type": "status", "status": {"template": "counter", "name": "Riposte", "dice": 2, "damageType": "slash", "triggers": 1, "duration": 2}}
  {"type": "cleanse", "category": "overTime|debuff|buff|incapacitate"}
  {"type": "restoreEnd", "amount": N}
Advantages (optional): "armorPiercing", {"id": "lifesteal", "percent": 50}, {"id": "accurate", "levels": 1}, "noEnd", "separateTargets" (then effects may have their own "target")
Limitations (optional): {"id": "charges", "uses": 2}, "doubleEnd", "slow"
Costs: a damage die is 5 Active Points, a healing die 10, statuses cost by strength and duration, targeting a whole side doubles an effect's cost, advantages add to the cost.`;

/**
 * @param {object} o
 * @param {string} o.userName
 * @param {object} o.block - the user's stat block
 * @param {object} o.derived - deriveValues(block)
 * @param {object|null} o.seed - the ability being used when the glimmer struck
 * @param {object|null} o.enemy - the enemy's stat block
 * @param {string} o.preferences - the player's wishes for new abilities
 * @param {number} o.targetAp
 * @param {string[]} [o.rejected] - names already proposed and turned down (for rerolls)
 * @param {string} [o.environment]
 */
export function buildGlimmerPrompt(o) {
    const seed = o.seed ? `${o.seed.name}${o.seed.description ? ` ("${o.seed.description}")` : ''}: ${describeAbility(o.seed)}` : 'a basic attack';
    const system = `You design abilities for a tabletop-style RPG run by a rules engine. In the middle of a fight, ${o.userName} has a flash of inspiration (a "glimmer", as in SaGa) and discovers a brand-new technique.`;
    const user = [
        `${o.userName} was using ${seed}${o.enemy ? ` against ${o.enemy.name}${o.enemy.description ? ` (${o.enemy.description})` : ''}` : ''}${o.environment ? `, in ${o.environment}` : ''}.`,
        `\n${o.userName}'s sheet:\n${describeStatBlock(o.block, o.derived)}`,
        o.preferences
            ? `\nThe player's wishes for the abilities ${o.userName} develops:\n${o.preferences}`
            : `\nNo preferences were given: make something that fits ${o.userName}'s existing abilities and style.`,
        `\nInvent one new ability that grows naturally out of the technique being used and fits ${o.userName}. It should be a real step forward but not overwhelming: about ${o.targetAp} Active Points, and different from the abilities ${o.userName} already has.`,
        o.rejected?.length ? `Do not propose these again: ${o.rejected.join(', ')}.` : '',
        `\nReply with JSON only, in this format:\n${ABILITY_FORMAT}`
    ].filter(Boolean).join('\n');
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** The AI's reply as a glimmered ability (capped to `maxAp`), or null. */
export function parseGlimmer(raw, maxAp) {
    const candidate = raw && typeof raw === 'object' ? (raw.ability && typeof raw.ability === 'object' ? raw.ability : raw) : null;
    const ability = normalizeAbility(candidate);
    if (!ability) return null;
    delete ability.quantity;
    capAbility(ability, maxAp);
    ability.glimmered = true;
    return ability;
}
