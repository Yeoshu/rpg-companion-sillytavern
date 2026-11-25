/**
 * Quests: a short name that identifies the quest, a description the AI may
 * rewrite freely, and steps it can add and tick off.
 *
 * A quest's identity is its name (case-insensitive): an update that keeps the
 * name but changes the description or steps is the same quest, so only
 * quests whose name disappears count as dropped. Older chats stored quests as
 * plain strings; those become quests with that string as the name.
 *
 * Pure module (no SillyTavern imports).
 */

const MAX_STEPS = 12;

function text(value, max) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Unwraps locked values ({ value, locked }). */
function unwrap(raw) {
    let value = raw;
    while (value && typeof value === 'object' && !Array.isArray(value) && value.value !== undefined) value = value.value;
    return value;
}

export function questKey(name) {
    return text(name, 200).toLowerCase();
}

/**
 * A quest from any stored or AI-written shape, or null for none.
 * @returns {{ name: string, description: string, steps: {text: string, done: boolean}[], completed?: boolean } | null}
 */
export function normalizeQuest(raw) {
    const value = unwrap(raw);
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
        const name = text(value, 200);
        return name && name.toLowerCase() !== 'none' ? { name, description: '', steps: [] } : null;
    }
    if (typeof value !== 'object' || Array.isArray(value)) return null;
    let name = text(value.name ?? value.title, 120);
    let description = text(value.description ?? value.details, 600);
    if (!name && description) {
        name = description.length > 60 ? `${description.slice(0, 57)}...` : description;
    }
    if (!name || name.toLowerCase() === 'none') return null;
    const steps = (Array.isArray(value.steps) ? value.steps : [])
        .map(step => {
            const s = unwrap(step);
            if (typeof s === 'string') return { text: text(s, 200), done: false };
            if (s && typeof s === 'object') return { text: text(s.text ?? s.name ?? s.title, 200), done: Boolean(s.done ?? s.completed ?? s.checked) };
            return null;
        })
        .filter(step => step && step.text)
        .slice(0, MAX_STEPS);
    const quest = { name, description: description === name ? '' : description, steps };
    const status = String(value.status ?? '').toLowerCase();
    if (value.completed === true || status === 'completed' || status === 'complete' || status === 'done') quest.completed = true;
    return quest;
}

/**
 * Both quest lists, cleaned: { main: quest | null, optional: quest[] }.
 * Duplicates (by name) are merged into the first, and the main quest is never
 * also listed as optional.
 */
export function normalizeQuests(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const main = normalizeQuest(r.main);
    const seen = new Set(main ? [questKey(main.name)] : []);
    const optionalSource = Array.isArray(r.optional) ? r.optional : (Array.isArray(r.active) ? r.active : []);
    const optional = [];
    for (const q of optionalSource.map(normalizeQuest)) {
        if (!q || seen.has(questKey(q.name))) continue;
        seen.add(questKey(q.name));
        optional.push(q);
    }
    return { main, optional };
}

/** Stored shape: the main quest is 'None' when there isn't one (older code relies on it). */
export function toStored(quests) {
    return { main: quests.main || 'None', optional: quests.optional };
}

/** Every quest with its kind. */
export function listQuests(quests) {
    const q = normalizeQuests(quests);
    return [...(q.main ? [{ kind: 'main', quest: q.main }] : []), ...q.optional.map(quest => ({ kind: 'side', quest }))];
}

/**
 * What changed between two quest states (by name).
 * @returns {{ dropped: {kind, quest}[], completed: {kind, quest}[], added: {kind, quest}[] }}
 *   dropped: names that disappeared; completed: quests the AI marked completed
 *   (they should be taken off the active lists); added: new names.
 */
export function diffQuests(before, after) {
    const prev = listQuests(before);
    const next = listQuests(after);
    const nextKeys = new Set(next.map(x => questKey(x.quest.name)));
    const prevKeys = new Set(prev.map(x => questKey(x.quest.name)));
    return {
        dropped: prev.filter(x => !nextKeys.has(questKey(x.quest.name))),
        completed: next.filter(x => x.quest.completed),
        added: next.filter(x => !prevKeys.has(questKey(x.quest.name)) && !x.quest.completed)
    };
}

/** Removes quests marked completed from the active lists. */
export function withoutCompleted(quests) {
    const q = normalizeQuests(quests);
    return {
        main: q.main && !q.main.completed ? q.main : null,
        optional: q.optional.filter(x => !x.completed)
    };
}

/** All steps done (and at least one step). */
export function allStepsDone(quest) {
    return Boolean(quest?.steps?.length) && quest.steps.every(s => s.done);
}

/** "The Toad Tax: deliver the toads to the Guild [✓ catch toads; ☐ reach Axel]" */
export function formatQuest(quest) {
    const q = normalizeQuest(quest);
    if (!q) return '';
    const steps = q.steps.length ? ` [${q.steps.map(s => `${s.done ? '✓' : '☐'} ${s.text}`).join('; ')}]` : '';
    return `${q.name}${q.description ? `: ${q.description}` : ''}${steps}`;
}

/**
 * Quests completed or abandoned within the last `messages` chat messages.
 * @param {{name: string, outcome: string, at: number}[]} history
 * @param {number} now - current chat length
 */
export function recentQuestHistory(history, now, messages) {
    return (Array.isArray(history) ? history : []).filter(h => h && h.name && now - (Number(h.at) || 0) <= messages);
}
