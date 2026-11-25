/**
 * Combat engine: the 12-segment turn, phases, attack resolution, statuses and
 * the end of the fight. Everything mechanical in an encounter happens here;
 * the AI only narrates the log this produces.
 *
 * Pure module: state in, state out (mutated in place), with an injectable rng.
 * See docs/COMBAT_DESIGN.md §4–§6.
 *
 * Usage:
 *   const state = createCombat([{ block, side: 'party', isPlayer: true }, { block, side: 'enemies' }]);
 *   let id = advance(state);              // whose phase it is (start-of-phase effects applied)
 *   act(state, { type: 'ability', abilityId: 'fire-bolt', targetId: 'c2' });
 *   id = advance(state);                  // ... until state.over
 */

import { attributeRoll, checkTarget, resolveCheck, rollDice, successChance } from '../rules.js';
import { isPhysical, normalizeAbility, normalizeCombatSettings, RESISTANCES } from './catalog.js';
import { abilityCost, deriveValues, getModifier, hasModifier, scalingDice } from './costs.js';

/** HERO speed chart: segments a character acts in, by SPD. */
export const SPEED_CHART = {
    1: [7],
    2: [6, 12],
    3: [4, 8, 12],
    4: [3, 6, 9, 12],
    5: [3, 5, 8, 10, 12],
    6: [2, 4, 6, 8, 10, 12],
    7: [2, 4, 6, 7, 9, 11, 12],
    8: [2, 3, 5, 6, 8, 9, 11, 12],
    9: [2, 3, 4, 6, 7, 8, 10, 11, 12],
    10: [2, 3, 4, 5, 6, 8, 9, 10, 11, 12],
    11: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    12: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
};

export const DODGE_BONUS = 3;
const LOW_HP = 0.3;

/** Segments a combatant acts in at a given SPD. */
export function phasesFor(spd, equalSpeed = false) {
    if (equalSpeed) return [12];
    return SPEED_CHART[Math.min(12, Math.max(1, Math.round(spd) || 1))];
}

// ---------------------------------------------------------------------------
// Set-up

/**
 * @param {Array<{block: object, side: 'party'|'enemies', isPlayer?: boolean, controlled?: 'player'|'ai', hp?: number, end?: number}>} participants
 *   `block` is a normalized stat block. `hp`/`end` override the starting values
 *   (from the tracker, or a stored NPC); otherwise the block's own hp/end or full.
 * @param {{settings?: object, rng?: () => number}} [options]
 */
export function createCombat(participants, { settings = {}, rng = Math.random } = {}) {
    const s = normalizeCombatSettings(settings);
    const combatants = participants.map((p, i) => {
        const base = deriveValues(p.block, s);
        const startHp = p.hp ?? p.block.hp;
        const startEnd = p.end ?? p.block.end;
        const charges = {};
        for (const a of p.block.abilities || []) {
            const c = getModifier(a, 'charges');
            if (c) charges[a.id] = c.uses;
        }
        return {
            id: `c${i + 1}`,
            name: p.block.name,
            side: p.side === 'party' ? 'party' : 'enemies',
            isPlayer: Boolean(p.isPlayer),
            controlled: p.isPlayer ? 'player' : (p.controlled === 'player' ? 'player' : 'ai'),
            block: p.block,
            base,
            maxHp: base.maxHp,
            hp: clampInt(startHp ?? base.maxHp, 0, base.maxHp),
            maxEnd: base.maxEnd,
            end: clampInt(startEnd ?? base.maxEnd, 0, base.maxEnd),
            statuses: [],
            charges,
            items: (p.block.items || []).map(item => ({ ...item })),
            dodging: false,
            out: false,
            fled: false,
            tie: rng(),
            lastAttackerId: null
        };
    });
    for (const c of combatants) {
        if (c.hp <= 0) c.out = true;
    }
    const state = {
        settings: s,
        turn: 1,
        segment: 12,
        pending: [],
        deferred: [],
        current: null,
        log: [],
        over: false,
        result: null,
        nextStatusId: 1
    };
    state.combatants = combatants;
    state.pending = actorsInSegment(state, 12, true);
    log(state, null, 'start', `Combat begins. Turn 1, segment 12: everyone acts.`);
    checkEnd(state);
    return state;
}

function clampInt(v, min, max) {
    return Math.min(max, Math.max(min, Math.round(Number(v) || 0)));
}

// ---------------------------------------------------------------------------
// Lookups and effective values

export function getCombatant(state, id) {
    return state.combatants.find(c => c.id === id) || null;
}

export function isActive(c) {
    return c && !c.out && !c.fled;
}

function attributeIdFor(c, stat, roles) {
    if (c.block.attributes[stat] !== undefined) return stat;
    if (roles[stat] && c.block.attributes[roles[stat]] !== undefined) return roles[stat];
    return null;
}

/**
 * Effective values right now: derived values with attribute and direct
 * modifier statuses (and Dodge) applied.
 */
export function effective(state, c) {
    const roles = state.settings.roles;
    const attributes = { ...c.block.attributes };
    const direct = { ocv: 0, dcv: 0, pd: 0, ed: 0, spd: 0, damage: 0 };
    for (const st of c.statuses) {
        if (st.template !== 'modifier') continue;
        if (direct[st.stat] !== undefined) {
            direct[st.stat] += st.amount;
        } else {
            const id = attributeIdFor(c, st.stat, roles);
            if (id) attributes[id] = Math.max(0, attributes[id] + st.amount);
        }
    }
    const d = deriveValues({ ...c.block, attributes }, state.settings);
    return {
        ocv: Math.max(0, d.ocv + direct.ocv),
        dcv: Math.max(0, d.dcv + direct.dcv + (c.dodging ? DODGE_BONUS : 0)),
        pd: Math.max(0, d.pd + direct.pd),
        ed: Math.max(0, d.ed + direct.ed),
        spd: Math.min(12, Math.max(1, d.spd + direct.spd)),
        rec: d.rec,
        strDice: d.strDice,
        strBonusDice: d.strBonusDice,
        dexBonusDice: d.dexBonusDice,
        damageDice: direct.damage,
        dex: attributes[roles.dex] ?? 10,
        attributes
    };
}

// ---------------------------------------------------------------------------
// The turn

function actorsInSegment(state, segment, everyone = false) {
    return state.combatants
        .filter(c => isActive(c) && (everyone || phasesFor(effective(state, c).spd, state.settings.equalSpeed).includes(segment)))
        .sort((a, b) => (effective(state, b).dex - effective(state, a).dex) || (b.tie - a.tie))
        .map(c => c.id);
}

/** The next few phases, for the timeline: [{turn, segment, id}]. */
export function upcomingPhases(state, count = 12) {
    const out = state.pending.map(id => ({ turn: state.turn, segment: state.segment, id }));
    let turn = state.turn;
    let segment = state.segment;
    let guard = 48;
    while (out.length < count && guard-- > 0) {
        segment += 1;
        if (segment > 12) { segment = 1; turn += 1; }
        for (const id of actorsInSegment(state, segment)) out.push({ turn, segment, id });
    }
    return out.slice(0, count);
}

/**
 * Moves to the next phase. Applies start-of-phase effects (damage/healing over
 * time, Dodge ending, incapacitation skipping the phase) and returns the id of
 * the combatant who now has to act, or null when the fight is over.
 */
export function advance(state, rng = Math.random) {
    if (state.current) return state.current;
    let guard = 1000;
    while (!state.over && guard-- > 0) {
        if (!state.pending.length) {
            if (state.deferred.length) {
                resolveDeferred(state, rng);
                continue;
            }
            nextSegment(state);
            continue;
        }
        const c = getCombatant(state, state.pending.shift());
        if (!isActive(c)) continue;
        if (!startPhase(state, c, rng)) continue;
        state.current = c.id;
        return c.id;
    }
    return null;
}

function nextSegment(state) {
    if (state.segment === 12) {
        const lines = [];
        for (const c of state.combatants) {
            if (!isActive(c)) continue;
            const before = c.end;
            c.end = Math.min(c.maxEnd, c.end + effective(state, c).rec);
            if (c.end > before) lines.push(`${c.name} +${c.end - before}`);
        }
        if (lines.length) log(state, null, 'recovery', `End of turn ${state.turn}: recovery (END ${lines.join(', ')}).`);
        state.turn += 1;
        state.segment = 1;
    } else {
        state.segment += 1;
    }
    state.pending = actorsInSegment(state, state.segment);
}

/** @returns {boolean} whether the combatant gets to act */
function startPhase(state, c, rng) {
    c.dodging = false;
    for (const st of [...c.statuses]) {
        if (st.template !== 'overTime') continue;
        const dice = rollDice(st.dice, 6, rng);
        let amount = dice.reduce((a, b) => a + b, 0);
        if (st.heal) {
            const before = c.hp;
            c.hp = Math.min(c.maxHp, c.hp + amount);
            log(state, c.id, 'tick', `${c.name} regains ${c.hp - before} HP from ${st.name} [${dice.join('+')}] (${c.hp}/${c.maxHp} HP).`);
        } else {
            amount = Math.floor(amount * resistanceMultiplier(c, st.damageType));
            c.hp = Math.max(0, c.hp - amount);
            log(state, c.id, 'tick', `${c.name} takes ${amount} ${st.damageType} damage from ${st.name} [${dice.join('+')}] (${c.hp}/${c.maxHp} HP).`);
        }
        st.remaining -= 1;
        if (st.remaining <= 0) removeStatus(state, c, st, 'wears off');
        if (knockOut(state, c)) return false;
    }
    const inc = c.statuses.find(st => st.template === 'incapacitate');
    if (inc) {
        log(state, c.id, 'skip', `${c.name} is ${inc.name.toLowerCase()} and loses this phase.`);
        inc.remaining -= 1;
        if (inc.remaining <= 0) removeStatus(state, c, inc, 'wears off');
        endPhase(state, c, true);
        return false;
    }
    return true;
}

/** Counts down statuses that last "phases" at the end of the combatant's phase. */
function endPhase(state, c, skipped = false) {
    for (const st of [...c.statuses]) {
        if (!['modifier', 'shield', 'taunt', 'counter'].includes(st.template)) continue;
        if (st.fresh) { st.fresh = false; continue; }
        st.remaining -= 1;
        if (st.remaining <= 0) removeStatus(state, c, st, 'wears off');
    }
    if (!skipped) state.current = null;
}

function removeStatus(state, c, st, why) {
    c.statuses = c.statuses.filter(x => x !== st);
    log(state, c.id, 'status-end', `${st.name} on ${c.name} ${why}.`);
}

function knockOut(state, c) {
    if (c.hp > 0 || c.out) return c.out;
    c.hp = 0;
    c.out = true;
    log(state, c.id, 'out', `${c.name} is out of the fight.`);
    state.pending = state.pending.filter(id => id !== c.id);
    state.deferred = state.deferred.filter(d => d.actorId !== c.id);
    checkEnd(state);
    return true;
}

export function checkEnd(state) {
    if (state.over) return true;
    const player = state.combatants.find(c => c.isPlayer);
    if (player?.fled) return finish(state, 'escaped');
    const alive = side => state.combatants.some(c => c.side === side && isActive(c));
    if (!alive('enemies')) return finish(state, 'victory');
    if (!alive('party')) return finish(state, 'defeat');
    return false;
}

function finish(state, result) {
    state.over = true;
    state.result = result;
    state.current = null;
    log(state, null, 'end', result === 'victory' ? 'Victory.' : result === 'defeat' ? 'Defeat.' : result === 'escaped' ? 'Escaped.' : 'The fight ends.');
    return true;
}

/**
 * Dialogue is a free action: it goes into the log (for narration and the
 * summary) without using the speaker's phase.
 */
export function say(state, actorId, text) {
    const c = getCombatant(state, actorId);
    const line = String(text ?? '').trim().replace(/^["“]|["”]$/g, '').slice(0, 500);
    if (!c || !line || state.over) return null;
    return log(state, c.id, 'speech', `${c.name} says: "${line}"`);
}

/** Ends the fight early (Conclude Encounter). */
export function conclude(state, result = 'interrupted') {
    if (!state.over) finish(state, result);
}

// ---------------------------------------------------------------------------
// Abilities

/** The basic attack: STR/5 d6, with the name and damage type from the stat block ("Strike", blunt). */
export function strikeAbility(state, c) {
    const dice = Math.max(1, effective(state, c).strDice);
    const strike = c.block.strike || {};
    return {
        id: 'strike',
        name: strike.name || 'Strike',
        description: strike.description || 'A basic attack.',
        target: 'one-enemy',
        roll: 'attack',
        effects: [{ type: 'damage', dice, flat: 0, damageType: strike.damageType || 'blunt', scaleWith: 'none' }],
        advantages: [],
        limitations: [],
        basic: true
    };
}

function endCostOf(state, c, ability) {
    if (ability.id === 'strike' && ability.basic) return Math.max(1, Math.round(ability.effects[0].dice / 2));
    if (ability.improvised || ability.quantity !== undefined) return 0;
    return abilityCost(ability).end;
}

/** Everything the combatant can do this phase (for UI and tactics). */
export function availableActions(state, id) {
    const c = getCombatant(state, id);
    if (!c) return { abilities: [], items: [] };
    const abilities = [strikeAbility(state, c), ...(c.block.abilities || [])].map(a => ({
        ability: a,
        end: endCostOf(state, c, a),
        charges: c.charges[a.id],
        usable: c.charges[a.id] === undefined || c.charges[a.id] > 0
    }));
    const items = c.items.map(item => ({ ability: item, quantity: item.quantity, unlimited: Boolean(item.unlimited), usable: item.unlimited || item.quantity > 0 }));
    return { abilities, items };
}

/** Ids of valid targets for an ability used by `actorId`. */
export function validTargets(state, actorId, ability) {
    const c = getCombatant(state, actorId);
    const live = state.combatants.filter(isActive);
    switch (ability.target) {
        case 'self': return [c.id];
        case 'one-ally':
        case 'all-allies': return live.filter(x => x.side === c.side).map(x => x.id);
        case 'one-enemy':
        case 'all-enemies': {
            const enemies = live.filter(x => x.side !== c.side);
            const taunt = c.statuses.find(st => st.template === 'taunt' && isActive(getCombatant(state, st.sourceId)));
            if (taunt && ability.target === 'one-enemy' && enemies.some(e => e.id === taunt.sourceId)) return [taunt.sourceId];
            return enemies.map(x => x.id);
        }
        case 'everyone': return live.filter(x => x.id !== c.id).map(x => x.id);
        default: return [];
    }
}

/** Target number to hit: 11 + OCV (+ Accurate) − DCV. */
export function attackTargetNumber(state, actor, target, ability) {
    const accurate = getModifier(ability, 'accurate');
    return 11 + effective(state, actor).ocv + (accurate ? accurate.levels : 0) - effective(state, target).dcv;
}

/** Chance (0..1) that `ability` hits `targetId` (1 when no roll is needed). */
export function hitChance(state, actorId, ability, targetId) {
    const actor = getCombatant(state, actorId);
    const target = getCombatant(state, targetId);
    if (!actor || !target) return 0;
    if (!needsAttackRoll(actor, target, ability)) return 1;
    return successChance(attackTargetNumber(state, actor, target, ability));
}

function needsAttackRoll(actor, target, ability) {
    return ability.roll === 'attack' && target.side !== actor.side;
}

export function resistanceMultiplier(c, type) {
    const kind = c.block.resistances?.[type];
    return kind ? RESISTANCES[kind].multiplier : 1;
}

export function statusCategory(st) {
    if (st.template === 'overTime') return st.heal ? 'buff' : 'overTime';
    if (st.template === 'modifier') return st.amount < 0 ? 'debuff' : 'buff';
    if (st.template === 'shield' || st.template === 'counter') return 'buff';
    if (st.template === 'incapacitate') return 'incapacitate';
    return 'debuff';
}

// ---------------------------------------------------------------------------
// Acting

/**
 * Resolves the current combatant's action and ends their phase.
 * @param {object} action
 *   { type: 'ability', abilityId, targetId }
 *   { type: 'item', itemId, targetId }
 *   { type: 'strike', targetId }
 *   { type: 'dodge' } | { type: 'recover' } | { type: 'flee' } | { type: 'pass' }
 *   { type: 'improvised', description, check: { target }, ability, targetId }
 * @returns {object[]} log entries added
 */
export function act(state, action, rng = Math.random) {
    const actor = getCombatant(state, state.current);
    if (!actor || state.over) return [];
    const start = state.log.length;
    const type = action?.type || 'pass';

    if (type === 'dodge') {
        actor.dodging = true;
        log(state, actor.id, 'dodge', `${actor.name} dodges (+${DODGE_BONUS} DCV until their next phase).`);
    } else if (type === 'recover') {
        const before = actor.end;
        actor.end = Math.min(actor.maxEnd, actor.end + effective(state, actor).rec);
        log(state, actor.id, 'recover', `${actor.name} catches their breath (+${actor.end - before} END, ${actor.end}/${actor.maxEnd}).`);
    } else if (type === 'flee') {
        flee(state, actor, rng);
    } else if (type === 'improvised') {
        improvise(state, actor, action, rng);
    } else if (type === 'ability' || type === 'strike' || type === 'item') {
        let ability;
        if (type === 'strike') ability = strikeAbility(state, actor);
        else if (type === 'item') ability = actor.items.find(i => i.id === action.itemId);
        else ability = action.abilityId === 'strike' ? strikeAbility(state, actor) : actor.block.abilities.find(a => a.id === action.abilityId);
        if (!ability) {
            log(state, actor.id, 'error', `${actor.name} hesitates (unknown action).`);
        } else if (type === 'item' && !ability.unlimited && !(ability.quantity > 0) && !action.resolvingDeferred) {
            log(state, actor.id, 'error', `${actor.name} has no ${ability.name} left.`);
        } else if (actor.charges[ability.id] !== undefined && actor.charges[ability.id] <= 0 && !action.resolvingDeferred) {
            log(state, actor.id, 'error', `${actor.name} has no uses of ${ability.name} left.`);
        } else if (hasModifier(ability, 'slow') && !action.resolvingDeferred) {
            payFor(state, actor, ability);
            state.deferred.push({ actorId: actor.id, action: { ...action, resolvingDeferred: true } });
            log(state, actor.id, 'prepare', `${actor.name} begins ${ability.name}; it goes off at the end of the segment.`);
        } else {
            if (!action.resolvingDeferred) payFor(state, actor, ability);
            if (!knockOut(state, actor)) useAbility(state, actor, ability, action.targetId, rng, action.effectTargets || {});
        }
    } else {
        log(state, actor.id, 'pass', `${actor.name} waits.`);
    }

    if (!action?.resolvingDeferred && state.current === actor.id) endPhase(state, actor);
    checkEnd(state);
    return state.log.slice(start);
}

function resolveDeferred(state, rng) {
    const list = state.deferred;
    state.deferred = [];
    for (const d of list) {
        const actor = getCombatant(state, d.actorId);
        if (!isActive(actor) || state.over) continue;
        const saved = state.current;
        state.current = actor.id;
        act(state, d.action, rng);
        state.current = saved;
    }
}

/** END, charges and item quantities. Missing END is paid in HP. */
function payFor(state, actor, ability) {
    const cost = endCostOf(state, actor, ability);
    if (cost > 0) {
        if (actor.end >= cost) {
            actor.end -= cost;
        } else {
            const missing = cost - actor.end;
            actor.end = 0;
            actor.hp = Math.max(0, actor.hp - missing);
            log(state, actor.id, 'strain', `${actor.name} is out of END and pushes through, losing ${missing} HP (${actor.hp}/${actor.maxHp}).`);
        }
    }
    if (actor.charges[ability.id] !== undefined) actor.charges[ability.id] -= 1;
    if (ability.quantity !== undefined && !ability.unlimited) ability.quantity = Math.max(0, ability.quantity - 1);
}

function useAbility(state, actor, ability, targetId, rng, effectTargets = {}) {
    const roll = getModifier(ability, 'requiresRoll');
    if (roll) {
        const skillName = (roll.skill || '').toLowerCase();
        const known = skillName && actor.block.skills?.[skillName] !== undefined;
        const attrId = attributeIdFor(actor, roll.attribute, state.settings.roles);
        const t = checkTarget({
            attribute: attrId ? effective(state, actor).attributes[attrId] : 10,
            skillLevel: known ? actor.block.skills[skillName] : null,
            untrained: Boolean(skillName) && !known
        }).target;
        const r = resolveCheck(t, rollDice(3, 6, rng));
        if (!r.success) {
            log(state, actor.id, 'fizzle', `${actor.name} tries ${ability.name} but fails the activation roll (${r.total} vs ${t}-).`);
            return;
        }
    }

    const slots = abilitySlots(state, actor, ability, targetId, effectTargets);
    const all = slots.flatMap(slot => slot.targets);
    if (!all.length) {
        log(state, actor.id, 'error', `${actor.name} uses ${ability.name}, but there is no valid target.`);
        return;
    }
    const names = [...new Set(all.filter(t => t.id !== actor.id || slots.length === 1).map(t => t.name))];
    const targetNames = ability.target === 'self' && slots.length === 1 ? '' : (names.length ? ` on ${names.join(', ')}` : '');
    log(state, actor.id, 'action', `${actor.name} uses ${ability.name}${targetNames}.`, { abilityId: ability.id, targets: all.map(t => t.id) });

    let dealt = 0;
    const damageState = { first: true };
    for (const slot of slots) {
        for (const target of slot.targets) {
            if (!isActive(target)) continue;
            let crit = false;
            const hostile = needsAttackRoll(actor, target, ability);
            if (hostile) {
                const t = attackTargetNumber(state, actor, target, ability);
                const r = resolveCheck(t, rollDice(3, 6, rng));
                crit = r.critical === 'success';
                const what = slots.length > 1 && slot.label ? ` (${slot.label})` : '';
                log(state, actor.id, 'roll', `  vs ${target.name}${what}: rolled ${r.total} vs ${t}- → ${r.success ? (crit ? 'critical hit' : 'hit') : 'miss'}.`, { roll: r, targetId: target.id });
                if (!r.success) continue;
            }
            dealt += applyEffects(state, actor, target, ability, crit, rng, slot.effects, damageState);
            if (hostile) counterAttack(state, target, actor, ability, rng);
            if (!isActive(actor)) break;
        }
        if (!isActive(actor)) break;
    }

    const lifesteal = getModifier(ability, 'lifesteal');
    if (lifesteal && dealt > 0 && isActive(actor)) {
        const before = actor.hp;
        actor.hp = Math.min(actor.maxHp, actor.hp + Math.floor(dealt * lifesteal.percent / 100));
        if (actor.hp > before) log(state, actor.id, 'heal', `  ${actor.name} drains ${actor.hp - before} HP (${actor.hp}/${actor.maxHp}).`);
    }
}

/** Which side a target type points at. */
function targetSide(target) {
    if (target === 'self' || target === 'one-ally' || target === 'all-allies') return 'ally';
    if (target === 'one-enemy' || target === 'all-enemies') return 'enemy';
    return 'any';
}

/**
 * Splits an ability into target slots. Without the separateTargets advantage
 * there is one slot (every effect on the ability's targets). With it, effects
 * without their own target share the main slot, and every effect with its own
 * target is a slot of its own (each single-target slot is chosen separately;
 * an unchosen one defaults to the main target when that fits, else the first
 * valid target).
 * @returns {{ index: number, target: string, label: string, effects: object[], targets: object[] }[]}
 */
export function abilitySlots(state, actor, ability, targetId, effectTargets = {}) {
    const separate = hasModifier(ability, 'separateTargets');
    const pickTargets = (target, chosen) => {
        const valid = validTargets(state, actor.id, { target });
        if (!['self', 'one-ally', 'one-enemy'].includes(target)) return valid.map(id => getCombatant(state, id));
        let id = valid.includes(chosen) ? chosen : null;
        if (!id && valid.includes(targetId) && targetSide(target) === targetSide(ability.target)) id = targetId;
        if (!id) id = valid[0];
        return id ? [getCombatant(state, id)] : [];
    };
    const mainEffects = separate ? ability.effects.filter(e => !e.target) : ability.effects;
    const slots = [];
    if (mainEffects.length) {
        slots.push({ index: -1, target: ability.target, label: '', effects: mainEffects, targets: pickTargets(ability.target, targetId) });
    }
    if (separate) {
        ability.effects.forEach((e, i) => {
            if (!e.target) return;
            slots.push({ index: i, target: e.target, label: `effect ${i + 1}`, effects: [e], targets: pickTargets(e.target, effectTargets[i]) });
        });
    }
    return slots;
}

/** A counter status on `holder` strikes back at the attacker who just hit them. */
function counterAttack(state, holder, attacker, ability, rng) {
    if (ability.isCounter || !isActive(holder) || !isActive(attacker)) return;
    const st = holder.statuses.find(x => x.template === 'counter' && x.triggers > 0);
    if (!st) return;
    log(state, holder.id, 'counter', `  ${holder.name}'s ${st.name} strikes back at ${attacker.name}.`);
    const counter = { id: 'counter', name: st.name, isCounter: true, advantages: [], limitations: [], effects: [] };
    dealDamage(state, holder, attacker, counter, { type: 'damage', dice: st.dice, flat: 0, damageType: st.damageType, scaleWith: 'none' }, false, false, rng);
    st.triggers -= 1;
    if (st.triggers <= 0) removeStatus(state, holder, st, 'is spent');
}

/** Applies every effect of an ability to one target. Returns damage dealt. */
function applyEffects(state, actor, target, ability, crit, rng, effects = ability.effects, damageState = { first: true }) {
    let dealt = 0;
    for (const e of effects) {
        if (!isActive(target)) break;
        if (e.type === 'damage') {
            dealt += dealDamage(state, actor, target, ability, e, crit, damageState.first, rng);
            damageState.first = false;
        } else if (e.type === 'heal') {
            const dice = crit ? new Array(e.dice).fill(6) : rollDice(e.dice, 6, rng);
            const amount = dice.reduce((a, b) => a + b, 0) + e.flat;
            const before = target.hp;
            target.hp = Math.min(target.maxHp, target.hp + amount);
            log(state, target.id, 'heal', `  ${target.name} heals ${target.hp - before} HP${dice.length ? ` [${dice.join('+')}${e.flat ? `+${e.flat}` : ''}]` : ''} (${target.hp}/${target.maxHp}).`);
        } else if (e.type === 'shield') {
            applyStatus(state, actor, target, { template: 'shield', name: ability.name, amount: e.amount, duration: e.duration }, rng);
        } else if (e.type === 'status') {
            applyStatus(state, actor, target, e.status, rng);
        } else if (e.type === 'cleanse') {
            const removed = target.statuses.filter(st => statusCategory(st) === e.category);
            for (const st of removed) removeStatus(state, target, st, 'is cleansed');
            if (!removed.length) log(state, target.id, 'cleanse', `  Nothing to cleanse on ${target.name}.`);
        } else if (e.type === 'restoreEnd') {
            const before = target.end;
            target.end = Math.min(target.maxEnd, target.end + e.amount);
            log(state, target.id, 'end', `  ${target.name} regains ${target.end - before} END (${target.end}/${target.maxEnd}).`);
        }
    }
    return dealt;
}

function dealDamage(state, actor, target, ability, e, crit, first, rng) {
    const eff = effective(state, actor);
    let diceCount = e.dice + scalingDice(eff, e);
    if (first) diceCount = Math.max(0, diceCount + eff.damageDice);
    const dice = crit ? new Array(diceCount).fill(6) : rollDice(diceCount, 6, rng);
    const raw = dice.reduce((a, b) => a + b, 0) + e.flat;
    const mult = resistanceMultiplier(target, e.damageType);
    const afterResist = Math.floor(raw * mult);
    const tEff = effective(state, target);
    let defence = isPhysical(e.damageType) ? tEff.pd : tEff.ed;
    if (hasModifier(ability, 'armorPiercing')) defence = Math.floor(defence / 2);
    let damage = Math.max(0, afterResist - defence);

    const parts = [`${raw}${dice.length ? ` [${dice.join('+')}${e.flat ? `+${e.flat}` : ''}]` : ''} ${e.damageType}`];
    if (mult !== 1) parts.push(`×${mult} (${target.block.resistances[e.damageType]})`);
    if (defence) parts.push(`− ${defence} ${isPhysical(e.damageType) ? 'PD' : 'ED'}`);

    let absorbed = 0;
    for (const st of target.statuses.filter(s => s.template === 'shield')) {
        if (damage <= 0) break;
        const take = Math.min(st.amount, damage);
        st.amount -= take;
        damage -= take;
        absorbed += take;
        if (st.amount <= 0) removeStatus(state, target, st, 'breaks');
    }
    target.hp = Math.max(0, target.hp - damage);
    if (damage > 0 || absorbed > 0) target.lastAttackerId = actor.id;
    log(state, target.id, 'damage',
        `  ${parts.join(' ')} = ${damage + absorbed} damage${absorbed ? ` (${absorbed} absorbed)` : ''} → ${target.name} ${target.hp}/${target.maxHp} HP.`,
        { amount: damage, absorbed, damageType: e.damageType, crit });
    knockOut(state, target);
    return damage + absorbed;
}

function applyStatus(state, source, target, status, rng) {
    let duration = status.duration || 1;
    if ((status.template === 'incapacitate' || status.template === 'taunt') && status.resistWith && target.side !== source.side) {
        const id = attributeIdFor(target, status.resistWith, state.settings.roles);
        const value = id ? effective(state, target).attributes[id] : 10;
        const t = attributeRoll(value);
        const r = resolveCheck(t, rollDice(3, 6, rng));
        if (r.success) {
            duration = Math.floor(duration / 2);
            log(state, target.id, 'resist', `  ${target.name} resists ${status.name} (${r.total} vs ${t}-)${duration ? `: ${duration} phase${duration === 1 ? '' : 's'}` : ' completely'}.`);
            if (!duration) return;
        }
    }
    const existing = target.statuses.find(st => st.name.toLowerCase() === status.name.toLowerCase() && st.template === status.template);
    if (existing) {
        existing.remaining = Math.max(existing.remaining, duration);
        if (status.dice) existing.dice = Math.max(existing.dice, status.dice);
        if (status.amount !== undefined) {
            existing.amount = Math.abs(status.amount) > Math.abs(existing.amount) ? status.amount : existing.amount;
        }
        if (status.template === 'taunt') existing.sourceId = source.id;
        if (status.triggers) existing.triggers = Math.max(existing.triggers || 0, status.triggers);
        existing.fresh = state.current === target.id;
        log(state, target.id, 'status', `  ${status.name} on ${target.name} is renewed (${existing.remaining} phase${existing.remaining === 1 ? '' : 's'}).`);
        return;
    }
    const st = {
        ...status,
        id: `s${state.nextStatusId++}`,
        remaining: duration,
        sourceId: source.id,
        fresh: state.current === target.id
    };
    target.statuses.push(st);
    log(state, target.id, 'status', `  ${target.name} gains ${describeStatus(st)}.`);
}

/** Short mechanical description: "Burning (1d6 fire per phase, 3 phases)". */
export function describeStatus(st) {
    const n = st.remaining ?? st.duration;
    const phases = `${n} phase${n === 1 ? '' : 's'}`;
    switch (st.template) {
        case 'overTime': return `${st.name} (${st.dice}d6 ${st.heal ? 'healing' : st.damageType} per phase, ${phases})`;
        case 'modifier': return `${st.name} (${st.amount > 0 ? '+' : ''}${st.amount}${st.stat === 'damage' ? 'd6 damage' : ` ${st.stat.toUpperCase()}`}, ${phases})`;
        case 'incapacitate': return `${st.name} (loses ${phases})`;
        case 'shield': return `${st.name} (absorbs ${st.amount}, ${phases})`;
        case 'taunt': return `${st.name} (must target its source, ${phases})`;
        case 'counter': return `${st.name} (strikes back for ${st.dice}d6 ${st.damageType} when hit, ${st.triggers}×, ${phases})`;
        default: return st.name;
    }
}

function flee(state, actor, rng) {
    const enemies = state.combatants.filter(c => isActive(c) && c.side !== actor.side);
    const chaser = enemies.sort((a, b) => (effective(state, b).spd - effective(state, a).spd) || (effective(state, b).dex - effective(state, a).dex))[0];
    const mine = resolveCheck(attributeRoll(effective(state, actor).dex), rollDice(3, 6, rng));
    const theirs = chaser ? resolveCheck(attributeRoll(effective(state, chaser).dex), rollDice(3, 6, rng)) : null;
    const success = mine.success && (!theirs || !theirs.success || mine.margin > theirs.margin);
    log(state, actor.id, 'flee',
        `${actor.name} tries to flee: DEX ${mine.total} vs ${mine.target}-${theirs ? `, ${chaser.name} ${theirs.total} vs ${theirs.target}-` : ''} → ${success ? 'gets away' : 'fails'}.`);
    if (success) {
        actor.fled = true;
        state.pending = state.pending.filter(id => id !== actor.id);
    }
}

function improvise(state, actor, action, rng) {
    const t = Number(action.check?.target) || 11;
    const r = resolveCheck(t, rollDice(3, 6, rng));
    const what = action.description || 'something unexpected';
    log(state, actor.id, 'improvised', `${actor.name} tries ${what}: rolled ${r.total} vs ${t}- → ${r.success ? 'success' : 'failure'} (margin ${r.margin >= 0 ? '+' : ''}${r.margin}).`, { roll: r });
    if (!r.success || !action.ability) return;
    const ability = normalizeAbility({ ...action.ability, name: action.ability.name || 'Improvised action' });
    if (!ability) return;
    ability.roll = 'automatic';
    ability.improvised = true;
    useAbility(state, actor, ability, action.targetId, rng);
}

// ---------------------------------------------------------------------------

function log(state, actorId, kind, text, data = undefined) {
    const entry = { turn: state.turn, segment: state.segment, actorId, kind, text };
    if (data) entry.data = data;
    state.log.push(entry);
    return entry;
}
