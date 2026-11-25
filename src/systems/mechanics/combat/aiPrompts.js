/**
 * The in-fight AI calls: narration, typed free actions and (optional) enemy
 * tactics. Prompt builders and reply parsers only; no SillyTavern imports,
 * so they can be unit-tested. The mechanics are never decided by these
 * replies: narration only describes the log, a free action is turned into an
 * ability or a check that is rolled locally, and a tactic is one of the
 * actor's own options. See docs/COMBAT_DESIGN.md §8.
 */

import { normalizeDifficulty } from '../rules.js';
import { normalizeAbility } from './catalog.js';
import { capAbility } from './costs.js';
import { describeAbility } from './describe.js';
import { describeStatus } from './engine.js';

function list(items) {
    return items.filter(Boolean).join('\n');
}

function hpWord(c) {
    if (c.out) return 'down';
    if (c.waiting) return 'not in the fight yet: waiting to join';
    if (c.fled) return 'fled';
    const f = c.hp / Math.max(1, c.maxHp);
    if (f > 0.75) return 'healthy';
    if (f > 0.4) return 'hurt';
    if (f > 0.15) return 'badly hurt';
    return 'barely standing';
}

/** One line per combatant: who they are and how they're doing (no numbers). */
export function describeCombatants(combatants) {
    return list(combatants.map(c => {
        const side = c.side === 'party' ? 'ally' : 'enemy';
        const who = c.isPlayer ? 'the user\'s character' : side;
        const statuses = c.statuses?.length ? `; ${c.statuses.map(s => s.name).join(', ')}` : '';
        const desc = c.block?.description ? ` ${c.block.description}` : '';
        const swarm = c.swarm && !c.out ? `, a swarm of ${Math.max(1, Math.ceil(c.hp / c.swarm.memberHp))} left of ${c.swarm.count}` : '';
        return `- ${c.name} (${who}${swarm}, ${hpWord(c)}${statuses}).${desc}`;
    }));
}

/* ---------------------------------------------------------------------------
   Narration
   --------------------------------------------------------------------------- */

/**
 * @param {object} o
 * @param {string} o.userName
 * @param {string} o.environment
 * @param {object[]} o.combatants - engine combatants
 * @param {string[]} o.lines - mechanical log lines to narrate, in order
 * @param {string} [o.previous] - the last narration, for continuity
 * @param {object} [o.style] - { tense, person, narration, pov }
 * @param {string} [o.styleGuide] - writing guidelines ({userName} is replaced)
 * @param {string[]} [o.abilityNotes] - "Name: flavour" for abilities used in these lines
 * @param {number} [o.words]
 */
export function buildNarrationPrompt(o) {
    const style = o.style || {};
    const words = o.words || 120;
    const system = list([
        `You narrate a fight in an ongoing roleplay, one moment at a time. The fight is run by a rules engine: every hit, miss, amount of damage and effect below has already been decided. Describe what happened; never change, add or undo an outcome.`,
        o.environment ? `\nThe battlefield: ${o.environment}` : '',
        `\nWho is fighting:\n${describeCombatants(o.combatants || [])}`,
        o.abilityNotes?.length ? `\nWhat the abilities used look like:\n${o.abilityNotes.map(n => `- ${n}`).join('\n')}` : '',
        `\nWrite in ${style.tense || 'present'} tense, ${style.person || 'second'} person, ${style.narration || 'limited'} narration, from ${style.pov || o.userName}'s point of view.`,
        o.styleGuide ? `\n${String(o.styleGuide).replace(/{userName}/g, o.userName)}` : ''
    ]);
    const user = list([
        o.previous ? `The previous moment, for continuity (don't repeat it):\n${o.previous}\n` : '',
        `What just happened, in order:\n${(o.lines || []).join('\n')}`,
        `\nNarrate exactly these events as prose in under ${words} words. Show hits, misses and wounds through the fiction rather than numbers. Don't decide anything ${o.userName} does beyond what is listed, and stop at the end of these events.`
    ]);
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** Strips code fences, quotes and a leading label from a narration reply. */
export function cleanNarration(text) {
    return String(text ?? '')
        .replace(/```[a-z]*\n?/gi, '')
        .replace(/^\s*(narration|narrative)\s*:\s*/i, '')
        .trim();
}

/* ---------------------------------------------------------------------------
   Free actions
   --------------------------------------------------------------------------- */

/**
 * @param {object} o
 * @param {string} o.userName
 * @param {string} o.text - what the player typed
 * @param {object} o.actor - the engine combatant acting
 * @param {object[]} o.combatants
 * @param {object[]} o.options - { ability, kind: 'ability'|'item' } the actor can use
 * @param {{id: string, name: string}[]} o.attributes
 * @param {string[]} o.skills
 * @param {number} o.maxAp - cap for an improvised effect
 * @param {string} [o.environment]
 */
export function buildFreeActionPrompt(o) {
    const abilityLines = o.options.map(({ ability, kind }) => `- ${ability.name}${kind === 'item' ? ' (item)' : ''}${ability.description ? ` ("${ability.description}")` : ''}: ${describeAbility(ability)}`);
    const system = list([
        `You are the game master of a turn-based fight run by a rules engine. ${o.actor.name} describes what they do; you decide how the rules handle it. You never decide the outcome: the engine rolls the dice.`,
        o.environment ? `\nThe battlefield: ${o.environment}` : '',
        `\nCombatants:\n${describeCombatants(o.combatants)}`,
        `\n${o.actor.name}'s options:\n${list(abilityLines) || '- (no abilities)'}\n- ${o.actor.block?.strike?.name || 'Strike'}: their basic attack${o.actor.block?.strike?.description ? ` ("${o.actor.block.strike.description}")` : ''}\n- Dodge, Recover (catch breath), Flee`,
        `\nAttributes: ${o.attributes.map(a => a.name).join(', ')}. Skills: ${o.skills.length ? o.skills.join(', ') : 'none'}.`
    ]);
    const user = list([
        `${o.actor.name}: "${o.text}"`,
        `\nIf this is one of the options above, reply:`,
        `{"type": "ability", "ability": "<option name>", "target": "<combatant name or null>"}`,
        `If it is Dodge, Recover or Flee, reply: {"type": "basic", "action": "dodge|recover|flee"}`,
        `Otherwise it is an improvised action. Pick the attribute (and skill, if one fits) to roll and how hard it is, and what happens if it works, using these effects:`,
        `{"type": "improvised", "description": "<short phrase, e.g. kicking the brazier into the wolves>", "attribute": "<attribute>", "skill": "<skill or null>", "difficulty": "easy|average|hard|veryHard|extreme", "target": "<combatant name or null>", "onSuccess": {"target": "self|one-ally|one-enemy|all-allies|all-enemies", "effects": [ ... ]} }`,
        `Effects: {"type": "damage", "dice": N, "damageType": "blunt|pierce|slash|fire|water|earth|air|ice|lightning|poison"}, {"type": "heal", "dice": N}, {"type": "status", "status": {"template": "incapacitate|modifier|overTime|shield|taunt", "name": "...", "duration": N, ...}}, {"type": "shield", "amount": N, "duration": N}.`,
        `Keep improvised effects modest (at most about ${Math.max(1, Math.floor(o.maxAp / 5))} dice of damage) and the difficulty honest: something clever and simple is average, something risky is hard or worse. Use "onSuccess": null if success only changes the situation without a mechanical effect.`,
        `Reply with the JSON object only.`
    ]);
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

function byName(list, name, key = 'name') {
    const n = String(name ?? '').trim().toLowerCase();
    if (!n || n === 'null') return null;
    return list.find(x => String(x[key]).toLowerCase() === n)
        || list.find(x => String(x[key]).toLowerCase().startsWith(n) || n.startsWith(String(x[key]).toLowerCase()))
        || null;
}

/**
 * Turns a free-action reply into something the engine can run.
 * @param {object|null} raw - parsed JSON
 * @param {object} o - { options, combatants, attributes, skills, maxAp }
 * @returns {null | {kind: 'ability'|'item', ability, targetId}
 *               | {kind: 'basic', action}
 *               | {kind: 'improvised', description, attribute, skill, difficulty, ability|null, targetId}}
 */
export function parseFreeAction(raw, o) {
    if (!raw || typeof raw !== 'object') return null;
    const type = String(raw.type || '').toLowerCase();
    const target = byName(o.combatants.filter(c => !c.out && !c.fled), raw.target);
    if (type === 'basic') {
        const action = String(raw.action || '').toLowerCase();
        return ['dodge', 'recover', 'flee'].includes(action) ? { kind: 'basic', action } : null;
    }
    if (type === 'ability') {
        const name = String(raw.ability || '').trim().toLowerCase();
        const strikeName = String(o.strikeName || 'strike').toLowerCase();
        if (name === 'strike' || name === strikeName) return { kind: 'ability', ability: { id: 'strike', name: 'Strike', target: 'one-enemy' }, targetId: target?.id ?? null };
        const option = o.options.find(x => x.ability.name.toLowerCase() === name || x.ability.id === name)
            || byName(o.options.map(x => ({ ...x, name: x.ability.name })), raw.ability);
        return option ? { kind: option.kind, ability: option.ability, targetId: target?.id ?? null } : null;
    }
    if (type === 'improvised') {
        const attr = byName(o.attributes, raw.attribute, 'id') || byName(o.attributes, raw.attribute) || o.attributes[0];
        const skill = raw.skill && String(raw.skill).toLowerCase() !== 'null' ? String(raw.skill).trim() : null;
        let ability = null;
        if (raw.onSuccess && typeof raw.onSuccess === 'object') {
            ability = normalizeAbility({ name: 'Improvised', ...raw.onSuccess, roll: 'automatic' });
            if (ability) {
                ability.improvised = true;
                capAbility(ability, o.maxAp);
            }
        }
        return {
            kind: 'improvised',
            description: String(raw.description || 'something unexpected').trim().slice(0, 140),
            attribute: attr?.id,
            skill,
            difficulty: normalizeDifficulty(raw.difficulty),
            ability,
            targetId: target?.id ?? null
        };
    }
    return null;
}

/* ---------------------------------------------------------------------------
   Tactics (optional)
   --------------------------------------------------------------------------- */

/**
 * @param {object} o - { actor, combatants, options: [{ability, kind}], environment }
 */
export function buildTacticsPrompt(o) {
    const opts = o.options.map(({ ability, kind }) => `- ${ability.name}${kind === 'item' ? ' (item)' : ''}${ability.description ? ` ("${ability.description}")` : ''}: ${describeAbility(ability)}`);
    const statuses = c => (c.statuses?.length ? ` [${c.statuses.map(describeStatus).join('; ')}]` : '');
    const others = o.combatants.filter(c => !c.out && !c.fled)
        .map(c => `- ${c.name} (${c.side === o.actor.side ? 'ally' : 'enemy'}): ${c.hp}/${c.maxHp} HP${statuses(c)}`);
    const system = `You choose actions for ${o.actor.name} in a turn-based fight. Play them in character: their nature and the situation matter more than squeezing out damage.${o.actor.block?.description ? `\n${o.actor.name}: ${o.actor.block.description}` : ''}`;
    const user = list([
        `${o.actor.name} has ${o.actor.hp}/${o.actor.maxHp} HP and ${o.actor.end}/${o.actor.maxEnd} END.`,
        `Combatants:\n${list(others)}`,
        `Options:\n${list(opts)}\n- Strike (their basic attack${o.actor.block?.strike?.name && o.actor.block.strike.name !== 'Strike' ? `: ${o.actor.block.strike.name}` : ''})\n- Dodge\n- Recover\n- Flee`,
        `Reply with JSON only: {"action": "<option name>", "target": "<combatant name or null>"}`
    ]);
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** A tactics reply as an engine action, or null (fall back to local tactics). */
export function parseTactics(raw, o) {
    if (!raw || typeof raw !== 'object') return null;
    const action = String(raw.action || '').trim().toLowerCase();
    if (['dodge', 'recover', 'flee'].includes(action)) return { type: action };
    const target = byName(o.combatants.filter(c => !c.out && !c.fled), raw.target);
    if (action === 'strike' || action === String(o.actor?.block?.strike?.name || '').toLowerCase()) return target ? { type: 'strike', targetId: target.id } : null;
    const option = o.options.find(x => x.ability.name.toLowerCase() === action || x.ability.id === action);
    if (!option) return null;
    return option.kind === 'item'
        ? { type: 'item', itemId: option.ability.id, targetId: target?.id ?? null }
        : { type: 'ability', abilityId: option.ability.id, targetId: target?.id ?? null };
}

