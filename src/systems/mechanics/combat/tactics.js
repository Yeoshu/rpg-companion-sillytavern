/**
 * Local combat tactics: how AI-controlled combatants (enemies, and allies you
 * don't control) choose their action. See docs/COMBAT_DESIGN.md §8.
 *
 * Every usable ability and target is scored by its expected value:
 *  1. Heal or shield when below 30% HP and able to.
 *  2. Don't re-apply a status the target already has.
 *  3. Avoid abilities you can't pay END for (they cost HP).
 *  4. Otherwise take the best expected damage. Minions go for the weakest
 *     target; others lean towards whoever hurt them last.
 *
 * Pure module.
 */

import { isPhysical } from './catalog.js';
import { scalingDice, statusCost } from './costs.js';
import { abilitySlots, availableActions, effective, statusCategory, getCombatant, hitChance, resistanceMultiplier, swarmBonusDice, SWARM, validTargets } from './engine.js';

const LOW_HP = 0.3;
const AVG_D6 = 3.5;

function expectedDamage(state, actor, target, ability, effect) {
    const eff = effective(state, actor);
    const dice = effect.dice + scalingDice(eff, effect) + swarmBonusDice(actor);
    const area = target.swarm && ['all-enemies', 'everyone'].includes(ability.target) ? SWARM.areaMultiplier : 1;
    const raw = (dice * AVG_D6 + effect.flat) * resistanceMultiplier(target, effect.damageType) * area;
    const t = effective(state, target);
    return Math.max(0, raw - (isPhysical(effect.damageType) ? t.pd : t.ed));
}

function isHarmful(status) {
    if (status.template === 'overTime') return !status.heal;
    if (status.template === 'modifier') return status.amount < 0;
    return status.template === 'incapacitate' || status.template === 'taunt';
}

function hasStatus(target, status) {
    return target.statuses.some(st => st.name.toLowerCase() === status.name.toLowerCase() && st.template === status.template);
}

/** Expected value of using `ability` on one target. */
function scoreOnTarget(state, actor, target, ability, effects = ability.effects) {
    const enemy = target.side !== actor.side;
    const chance = hitChance(state, actor.id, ability, target.id);
    const missing = target.maxHp - target.hp;
    const low = target.hp / target.maxHp < LOW_HP;
    let score = 0;

    for (const e of effects) {
        switch (e.type) {
            case 'damage': {
                const dmg = expectedDamage(state, actor, target, ability, e) * chance;
                score += enemy ? dmg : -dmg * 1.5;
                break;
            }
            case 'heal':
                if (!enemy) score += Math.min(missing, e.dice * AVG_D6 + e.flat) * (low ? 2 : 1);
                break;
            case 'shield':
                if (!enemy && !target.statuses.some(st => st.template === 'shield')) score += e.amount * 0.6 * (low ? 2 : 1);
                break;
            case 'status': {
                const st = e.status;
                if (hasStatus(target, st)) break;
                const harmful = isHarmful(st);
                if (harmful !== enemy) break;
                if (st.template === 'overTime' && st.heal && missing <= 0) break;
                score += statusCost(st) * 0.5 * (enemy ? chance : 1);
                break;
            }
            case 'cleanse': {
                const n = target.statuses.filter(st => statusCategory(st) === e.category).length;
                if (n && (e.category === 'buff') === enemy) score += 5 * n;
                break;
            }
            case 'restoreEnd':
                if (!enemy) score += Math.min(target.maxEnd - target.end, e.amount) * 0.3;
                break;
        }
    }

    if (enemy && score > 0) {
        if (actor.block.tier === 'minion') score *= 1 + (1 - target.hp / target.maxHp);
        else if (actor.lastAttackerId === target.id) score *= 1.5;
    }
    if (!enemy && target.id === actor.id && low && effects.some(e => e.type === 'heal' || e.type === 'shield')) {
        score *= 3;
    }
    return score;
}

/**
 * Chooses an action for an AI-controlled combatant.
 * @returns {object} an action for engine.act()
 */
export function chooseAction(state, id, rng = Math.random) {
    const actor = getCombatant(state, id);
    const { abilities, items } = availableActions(state, id);
    const options = [
        ...abilities.filter(o => o.usable).map(o => ({ ability: o.ability, end: o.end, kind: 'ability' })),
        ...items.filter(o => o.usable).map(o => ({ ability: o.ability, end: 0, kind: 'item' }))
    ];

    let best = null;
    for (const option of options) {
        const { ability } = option;
        const targetIds = validTargets(state, id, ability);
        if (!targetIds.length) continue;
        const single = ['self', 'one-ally', 'one-enemy'].includes(ability.target);
        // Score every target slot as the engine would resolve it (separate targets default sensibly).
        const score = targetId => abilitySlots(state, actor, ability, targetId)
            .reduce((sum, slot) => sum + slot.targets.reduce((s, t) => s + scoreOnTarget(state, actor, t, ability, slot.effects), 0), 0);
        const evaluations = single
            ? targetIds.map(t => ({ targetId: t, score: score(t) }))
            : [{ targetId: null, score: score(null) }];
        for (const ev of evaluations) {
            let score = ev.score;
            if (option.end > actor.end) score *= 0.3;
            if (option.kind === 'item') score *= 0.8; // keep consumables for when they matter
            score *= 0.9 + 0.2 * rng();
            if (score > 0 && (!best || score > best.score)) best = { option, targetId: ev.targetId, score };
        }
    }

    if (!best) {
        return actor.end <= 0 ? { type: 'recover' } : { type: 'dodge' };
    }
    if (best.option.kind === 'item') return { type: 'item', itemId: best.option.ability.id, targetId: best.targetId };
    return { type: 'ability', abilityId: best.option.ability.id, targetId: best.targetId };
}
