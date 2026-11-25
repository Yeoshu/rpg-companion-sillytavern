/**
 * Quest guidelines for the tracker AI (editable in the Prompts editor), and
 * the reminder of quests finished or abandoned recently, so the AI doesn't
 * create them again. See mechanics/quests.js for the quest shape.
 */

import { extensionSettings } from '../../core/state.js';
import { recentQuestHistory } from '../mechanics/quests.js';

export const DEFAULT_QUEST_PROMPT = `Quests:
- A quest is a goal {userName} has actually taken on in the story. Give each one a short, memorable "name" (2 to 5 words, e.g. "The Toad Tax"). The name is the quest's identifier: never rename a quest once it exists. When things change, rewrite its "description" and "steps" instead.
- "steps" are the concrete things to do. Add steps as they become known and set "done": true when one is achieved. Keep a quest to at most 5 steps.
- Keep one main quest. Only add an optional quest when the story clearly presents a new side goal that {userName} has accepted or shown real interest in. Passing remarks, chores and ideas are not quests. Usually there are 0 to 3 optional quests; prefer adding a step to an existing quest over creating a new one.
- When a quest is finished, keep it for that one update with "completed": true (it is then removed). If it becomes impossible or {userName} gives up on it, remove it.
- Never recreate a quest that was already finished or abandoned.
{recentQuests}`;

/** Default number of chat messages a finished quest is mentioned for. */
export const DEFAULT_QUEST_MEMORY = 20;

/** The guidelines with placeholders filled in. */
export function buildQuestGuidelines(userName, chatLength = 0) {
    const template = extensionSettings.customQuestPrompt || DEFAULT_QUEST_PROMPT;
    const memory = Number.isFinite(Number(extensionSettings.questMemory)) ? Number(extensionSettings.questMemory) : DEFAULT_QUEST_MEMORY;
    const recent = recentQuestHistory(extensionSettings.questHistory, chatLength, memory);
    const recentText = recent.length
        ? `Recently finished or abandoned (do not add these again): ${recent.map(h => `${h.name} (${h.outcome})`).join(', ')}.`
        : '';
    const text = template.replace(/{userName}/g, userName).replace(/\{\{user\}\}/g, userName);
    return (text.includes('{recentQuests}') ? text.replace('{recentQuests}', recentText) : `${text}\n${recentText}`).trim();
}
