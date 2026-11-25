/**
 * Encounter Prompt Builder Module
 * Handles all AI prompt generation for combat encounters
 */

import { getContext } from '../../../../../../extensions.js';
import { chat, characters, this_chid, substituteParams } from '../../../../../../../script.js';
import { selected_group, getGroupMembers, groups } from '../../../../../../group-chats.js';
import { extensionSettings, committedTrackerData } from '../../core/state.js';
import { currentEncounter } from '../features/encounterState.js';
import { repairJSON } from '../../utils/jsonRepair.js';
import { isPresentCharactersEnabled } from '../../utils/presentCharacters.js';
import { buildInventorySummary, generateTrackerInstructions, generateTrackerExample, buildAttributesString } from './promptBuilder.js';
import { applyLocks } from './lockManager.js';

/**
 * Gets character information from the current chat
 * @returns {Promise<string>} Formatted character information
 */
async function getCharactersInfo() {
    let characterInfo = '';

    // Check if in group chat
    if (selected_group) {
        const group = groups.find(g => g.id === selected_group);
        const groupMembers = getGroupMembers(selected_group);

        if (groupMembers && groupMembers.length > 0) {
            characterInfo += 'Characters in this roleplay:\n';

            const disabledMembers = group?.disabled_members || [];
            let characterIndex = 0;

            groupMembers.forEach((member) => {
                if (!member || !member.name) return;

                // Skip muted characters
                if (member.avatar && disabledMembers.includes(member.avatar)) {
                    return;
                }

                characterIndex++;
                characterInfo += `<character${characterIndex}="${member.name}">\n`;

                if (member.description) {
                    characterInfo += `${member.description}\n`;
                }

                if (member.personality) {
                    characterInfo += `${member.personality}\n`;
                }

                characterInfo += `</character${characterIndex}>\n`;
            });
        }
    } else if (this_chid !== undefined && characters && characters[this_chid]) {
        // Single character chat
        const character = characters[this_chid];

        characterInfo += 'Character in this roleplay:\n\n';
        characterInfo += `<character="${character.name}">\n`;

        if (character.description) {
            characterInfo += `${character.description}\n`;
        }

        if (character.personality) {
            characterInfo += `${character.personality}\n`;
        }

        characterInfo += `</character>\n\n`;
    }

    return characterInfo;
}

/**
 * The stat block format and budget the set-up call asks for.
 * See docs/COMBAT_DESIGN.md §3, §4, §7 and §10.
 */
export function buildStatBlockInstructions(userName, setup = {}) {
    const level = Math.max(1, Math.floor(setup.level) || 1);
    const b = setup.budgets || {};
    let text = `Based on everything above, set up the fight. Work out who fights alongside ${userName} (if anyone) and who the enemies are, and write a stat block for each of them. ${userName} already has a character sheet; do NOT include ${userName}.\n\n`;
    if (setup.playerSheet) {
        text += `${userName}'s sheet, for scale:\n<sheet>\n${setup.playerSheet}\n</sheet>\n\n`;
    }
    if (setup.known?.length) {
        text += `These characters already have stat blocks. If they take part in this fight, put them in "party" or "enemies" as just {"name": "<name>", "existing": true} instead of writing a stat block (a generic one, like a template for a kind of creature, can be listed several times):\n`;
        text += setup.known.map(k => `- ${k.name}${k.template ? ' (generic)' : ''}${k.description ? `: ${k.description}` : ''}`).join('\n') + '\n\n';
    }
    text += `Return ONLY a JSON object:
{
  "party": [ /* allies fighting with ${userName}; may be empty */ ],
  "enemies": [ /* everyone fighting against ${userName} */ ],
  "environment": "One or two sentences describing the battlefield",
  "styleNotes": {
    "environmentType": "forest|dungeon|desert|cave|city|ruins|snow|water|castle|wasteland|plains|mountains|swamp|volcanic|spaceship|mansion",
    "atmosphere": "bright|dark|foggy|stormy|calm|eerie|chaotic|peaceful",
    "timeOfDay": "dawn|day|dusk|night|twilight",
    "weather": "clear|rainy|snowy|windy|stormy|overcast"
  }
}

Each stat block:
{
  "name": "Goblin Archer",
  "level": ${level},
  "tier": "minion|standard|elite|boss",
  "description": "One sentence: what they look like and how they fight",
  "sprite": "one emoji",
  "attributes": { "str": 10, "dex": 12, "con": 10 },
  "bought": { "pd": 1 },
  "resistances": { "fire": "weak" },
  "abilities": [
    {
      "name": "Shortbow",
      "description": "Flavour text",
      "target": "one-enemy",
      "roll": "attack",
      "effects": [ { "type": "damage", "dice": 3, "damageType": "pierce" } ],
      "advantages": [],
      "limitations": []
    }
  ]
}

Rules for stat blocks:
- attributes: 10 is an ordinary adult, 13 capable, 15 very capable, 20 exceptional; there is no cap. STR adds damage and physical defence, DEX gives accuracy, defence and speed (actions per turn), CON gives HP, END and elemental defence.
- bought (optional): extra hp, end, rec, ocv (accuracy), dcv (defence), pd (physical defence), ed (elemental defence), spd (actions per turn; 1 extra is a lot).
- resistances (optional): damage type -> "resistant" (half), "immune" (none) or "weak" (x1.5).
- tier: minion = fodder that comes in groups, standard = an ordinary fighter, elite = a dangerous individual, boss = a big threat meant for a whole party.
- level: on ${userName}'s scale (${userName} is level ${level}). An even match is the same level; judge it from how dangerous they are in the story.
- abilities: 1 to 3 per combatant. Everyone can already Strike, Dodge, Recover and Flee, so don't list those.
  - target: self, one-ally, one-enemy, all-allies, all-enemies, everyone
  - roll: "attack" (must hit; the target can dodge) or "automatic" (buffs, heals, auras)
  - damageType: blunt, pierce, slash (physical) or fire, water, earth, air, ice, lightning, poison (elemental). "addStr": true on physical attacks adds the user's strength.
  - effects:
    {"type": "damage", "dice": N, "flat": 0, "damageType": "slash", "addStr": true}
    {"type": "heal", "dice": N}
    {"type": "shield", "amount": N, "duration": phases}
    {"type": "status", "status": {"template": "overTime", "name": "Burning", "dice": 1, "damageType": "fire", "duration": 3}}
    {"type": "status", "status": {"template": "overTime", "name": "Regenerating", "dice": 1, "heal": true, "duration": 3}}
    {"type": "status", "status": {"template": "modifier", "name": "Weakened", "stat": "ocv|dcv|pd|ed|spd|damage|str|dex|con", "amount": -2, "duration": 3}}
    {"type": "status", "status": {"template": "incapacitate", "name": "Stunned", "duration": 1}}
    {"type": "status", "status": {"template": "taunt", "name": "Provoked", "duration": 2}}
    {"type": "cleanse", "category": "overTime|debuff|buff|incapacitate"}
    {"type": "restoreEnd", "amount": N}
  - advantages (optional): "armorPiercing", {"id": "lifesteal", "percent": 50}, {"id": "accurate", "levels": 1}, "noEnd"
  - limitations (optional): {"id": "charges", "uses": 2}, "doubleEnd", "itemBased", "slow"
- Points: every stat block is worth points (attributes 1 per point above 10, a damage die 5, a healing die 10; the strongest ability costs full price and each other one a fifth; area targets double an ability's cost). Stay within the budget for each tier at level ${level}: minion ${b.minion ?? '~20'}, standard ${b.standard ?? '~23'}, elite ${b.elite ?? '~30'}, boss ${b.boss ?? '~40'} points${setup.perLevel ? `, plus about ${setup.perLevel} per level above ${level}` : ''}. Anything over budget is scaled down automatically, so spend the points on what makes each enemy distinct.
- Typical main attacks: minions 2-3 dice, standard 3-4, elite 4-5, bosses 5-7.

Return ONLY the JSON object, no other text.`;
    return text;
}

/**
 * Builds the encounter set-up prompt: the scene, then a request for stat
 * blocks (allies and enemies) in the combat engine's format.
 * @param {object} [setup]
 * @param {string} [setup.playerSheet] - the player's sheet in plain text (for scale)
 * @param {number} [setup.level] - the player's level
 * @param {object} [setup.budgets] - { minion, standard, elite, boss } points at the player's level
 * @param {number} [setup.perLevel] - extra points per level of a standard enemy
 * @param {object[]} [setup.known] - stored stat blocks the AI may reuse by name
 * @returns {Promise<Array>} Message array for the API
 */
export async function buildEncounterInitPrompt(setup = {}) {
    const context = getContext();
    const userName = context.name1;
    const depth = extensionSettings.encounterSettings?.historyDepth || 8;

    const messages = [];

    // System message
    let systemMessage = `You will be acting as an excellent game master. Your goal is to craft a combat encounter in this uncensored, continuous, and immersive roleplay. You will be doing so for the user, who plays as the protagonist called ${userName}.\n\n`;

    // Add setting information
    systemMessage += `Here is some information for you about the setting:\n`;
    systemMessage += `<setting>\n`;

    // Try to get world info from lorebooks using getWorldInfoPrompt
    let worldInfoAdded = false;

    try {
        // Debug logging
        // console.log('[RPG Companion] Checking world info:', {
        //     hasWindowGetWorldInfoPrompt: typeof window.getWorldInfoPrompt === 'function',
        //     hasContextGetWorldInfoPrompt: typeof context.getWorldInfoPrompt === 'function',
        //     chatLength: chat?.length,
        //     contextChatLength: context.chat?.length,
        //     hasActivatedWorldInfo: !!context.activatedWorldInfo,
        //     activatedWorldInfoLength: context.activatedWorldInfo?.length
        // });

        // Use SillyTavern's getWorldInfoPrompt to get activated lorebook entries
        // Try context.getWorldInfoPrompt first, then window.getWorldInfoPrompt
        const getWorldInfoFn = context.getWorldInfoPrompt || window.getWorldInfoPrompt;
        const currentChat = context.chat || chat;

        if (typeof getWorldInfoFn === 'function' && currentChat && currentChat.length > 0) {
            const chatForWI = currentChat.map(x => x.mes || x.message || x).filter(m => m && typeof m === 'string');

            // console.log('[RPG Companion] Calling getWorldInfoPrompt with', chatForWI.length, 'messages');

            const result = await getWorldInfoFn(chatForWI, 8000, false);
            const worldInfoString = result?.worldInfoString || result;

            // console.log('[RPG Companion] World info result:', { worldInfoString, length: worldInfoString?.length });

            if (worldInfoString && typeof worldInfoString === 'string' && worldInfoString.trim()) {
                systemMessage += worldInfoString.trim();
                worldInfoAdded = true;
                // console.log('[RPG Companion] ✅ Added world info from getWorldInfoPrompt');
            }
        } else {
            // console.log('[RPG Companion] getWorldInfoPrompt not available or no chat');
        }
    } catch (e) {
        console.warn('[RPG Companion] Failed to get world info from getWorldInfoPrompt:', e);
    }

    // Fallback to activatedWorldInfo
    if (!worldInfoAdded && context.activatedWorldInfo && Array.isArray(context.activatedWorldInfo) && context.activatedWorldInfo.length > 0) {
        // console.log('[RPG Companion] Using fallback activatedWorldInfo:', context.activatedWorldInfo.length, 'entries');
        context.activatedWorldInfo.forEach((entry) => {
            if (entry && entry.content) {
                systemMessage += `${entry.content}\n\n`;
                worldInfoAdded = true;
            }
        });
    }

    if (!worldInfoAdded) {
        console.warn('[RPG Companion] ⚠️ No world information available');
        systemMessage += 'No world information available.';
    }

    systemMessage += `\n</setting>\n\n`;

    // Add character information
    const charactersInfo = await getCharactersInfo();
    if (charactersInfo) {
        systemMessage += `Here is the information available to you about the characters participating in the fight:\n`;
        systemMessage += `<characters>\n${charactersInfo}</characters>\n\n`;
    }

    // Add persona information
    systemMessage += `Here are details about the user's ${userName}:\n`;
    systemMessage += `<persona>\n`;

    try {
        const personaText = substituteParams('{{persona}}');
        if (personaText && personaText !== '{{persona}}') {
            systemMessage += personaText;
        } else {
            systemMessage += 'No persona information available.';
        }
    } catch (e) {
        systemMessage += 'No persona information available.';
    }

    systemMessage += `\n</persona>\n\n`;

    // Add chat history from before the encounter
    systemMessage += `Here is the chat history from before the encounter started between the user and the assistant:\n`;
    systemMessage += `<history>\n`;

    messages.push({
        role: 'system',
        content: systemMessage
    });

    // Add recent chat history (last X messages before encounter)
    if (chat && chat.length > 0) {
        const recentMessages = chat.slice(-depth - 1, -1); // Exclude the last message (encounter trigger)

        for (const message of recentMessages) {
            const content = message.mes?.trim();
            // Skip empty messages
            if (content) {
                messages.push({
                    role: message.is_user ? 'user' : 'assistant',
                    content: content
                });
            }
        }

        // Add the encounter trigger message
        const lastMessage = chat[chat.length - 1];
        if (lastMessage && lastMessage.mes?.trim()) {
            currentEncounter.encounterStartMessage = lastMessage.mes;
            messages.push({
                role: lastMessage.is_user ? 'user' : 'assistant',
                content: lastMessage.mes.trim()
            });
        }
    }

    // Build user's current stats
    let userStatsInfo = '';

    // Add HP and other stats from committed tracker data
    if (committedTrackerData.userStats) {
        userStatsInfo += `${userName}'s Current Stats:\n${committedTrackerData.userStats}\n\n`;
    }

    // Add skills if available
    const skillsSection = extensionSettings.trackerConfig?.userStats?.skillsSection;
    if (skillsSection?.enabled && skillsSection.customFields && skillsSection.customFields.length > 0) {
        userStatsInfo += `${userName}'s Skills: ${skillsSection.customFields.join(', ')}\n`;
    }

    // Add inventory
    const inventory = extensionSettings.userStats?.inventory;
    if (inventory) {
        const inventorySummary = buildInventorySummary(inventory);
        userStatsInfo += `${userName}'s Inventory:\n${inventorySummary}\n\n`;
    }

    // Add classic stats/attributes
    // (uses the configured attributes, so custom/disabled ones are respected)
    if (extensionSettings.classicStats) {
        const attributesString = buildAttributesString();
        if (attributesString) {
            userStatsInfo += `${userName}'s Attributes: ${attributesString}\n\n`;
        }
    }

    // Add present characters info for party members
    let partyInfo = '';
    if (committedTrackerData.characterThoughts) {
        partyInfo += `Present Characters (potential party members):\n${committedTrackerData.characterThoughts}\n\n`;
    }

    // Close history and add combat initialization instruction
    let initInstruction = `</history>\n\n`;

    // Wrap RPG Companion panel data in context tags
    initInstruction += `Here is some additional tracked context for the scene:\n`;
    initInstruction += `<context>\n`;
    initInstruction += userStatsInfo;
    initInstruction += partyInfo;
    initInstruction += `</context>\n\n`;

    initInstruction += `The combat starts now.\n\n`;
    initInstruction += buildStatBlockInstructions(userName, setup);

    // Only add the instruction if it has meaningful content
    if (initInstruction.trim()) {
        messages.push({
            role: 'user',
            content: initInstruction.trim()
        });
    }

    // Validate that we have at least one message with content
    if (messages.length === 0 || messages.every(m => !m.content || !m.content.trim())) {
        throw new Error('Unable to build encounter prompt - no valid content available');
    }

    return messages;
}

/**
 * Builds the final summary prompt
 * This is sent when combat ends to get a narrative summary
 * @param {Array} combatLog - Full combat log
 * @param {string} result - Combat result ('victory', 'defeat', or 'fled')
 * @returns {Promise<Array>} Message array for the API
 */
export async function buildCombatSummaryPrompt(combatLog, result) {
    const context = getContext();
    const userName = context.name1;

    const messages = [];

    // Get narrative style from settings (use summary narrative settings)
    const narrativeStyle = extensionSettings.encounterSettings?.summaryNarrative || {};
    const tense = narrativeStyle.tense || 'past';
    const person = narrativeStyle.person || 'third';
    const narration = narrativeStyle.narration || 'omniscient';
    const pov = narrativeStyle.pov || 'narrator';

    // Build system message with setting info
    let systemMessage = `You are summarizing a combat encounter that just concluded.\n\n`;

    // Add setting information
    systemMessage += `Here is some information for you about the setting:\n`;
    systemMessage += `<setting>\n`;

    // Get world info using the same method as encounter init
    let worldInfoAdded = false;
    try {
        const getWorldInfoFn = context.getWorldInfoPrompt || window.getWorldInfoPrompt;
        const currentChat = context.chat || chat;

        if (typeof getWorldInfoFn === 'function' && currentChat && currentChat.length > 0) {
            const chatForWI = currentChat.map(x => x.mes || x.message || x).filter(m => m && typeof m === 'string');
            const result = await getWorldInfoFn(chatForWI, 8000, false);
            const worldInfoString = result?.worldInfoString || result;

            if (worldInfoString && typeof worldInfoString === 'string' && worldInfoString.trim()) {
                systemMessage += worldInfoString.trim();
                worldInfoAdded = true;
            }
        }
    } catch (e) {
        console.warn('[RPG Companion] Failed to get world info for summary:', e);
    }

    // Fallback to activatedWorldInfo
    if (!worldInfoAdded && context.activatedWorldInfo && Array.isArray(context.activatedWorldInfo) && context.activatedWorldInfo.length > 0) {
        context.activatedWorldInfo.forEach((entry) => {
            if (entry && entry.content) {
                systemMessage += `${entry.content}\n\n`;
                worldInfoAdded = true;
            }
        });
    }

    if (!worldInfoAdded) {
        systemMessage += 'No world information available.';
    }

    systemMessage += `\n</setting>\n\n`;

    // Add character information
    const charactersInfo = await getCharactersInfo();
    if (charactersInfo) {
        systemMessage += `Here is the information available to you about the characters:\n`;
        systemMessage += `<characters>\n${charactersInfo}</characters>\n\n`;
    }

    // Add persona information
    systemMessage += `Here are details about ${userName}:\n`;
    systemMessage += `<persona>\n`;

    try {
        const personaText = substituteParams('{{persona}}');
        if (personaText && personaText !== '{{persona}}') {
            systemMessage += personaText;
        } else {
            systemMessage += 'No persona information available.';
        }
    } catch (e) {
        systemMessage += 'No persona information available.';
    }

    systemMessage += `\n</persona>\n\n`;

    // Add the message that triggered the encounter
    if (currentEncounter.encounterStartMessage) {
        systemMessage += `Here is the last message before combat started:\n`;
        systemMessage += `<trigger>\n${currentEncounter.encounterStartMessage}\n</trigger>\n\n`;
    }

    messages.push({
        role: 'system',
        content: systemMessage
    });

    let summaryMessage = `Combat has ended with result: ${result}\n\n`;
    summaryMessage += `Full combat log (the dice and numbers are final; describe what they mean, not the numbers themselves):\n`;
    for (const entry of combatLog || []) {
        if (typeof entry === 'string') {
            summaryMessage += `${entry}\n`;
        } else if (entry && typeof entry === 'object') {
            summaryMessage += `${entry.action || ''}\n${entry.result || ''}\n`;
        }
    }
    summaryMessage += `\n\nProvide a narrative summary of the entire fight in a way that fits the style from the chat history. Start with [FIGHT CONCLUDED] on the first line, then provide the description.\n\n`;
    summaryMessage += `Write with intent in ${tense} tense ${person}-person ${narration} from ${pov}'s point of view.\n`;
    summaryMessage += `Build novel prose. Break patterns from your previous responses by varying sentence structures, rhythms, formats, and openings. If you last started with a narration, begin this one with dialogue; if with an action, switch to an internal thought. Track whether a sentence shape, cadence, sensory detail, or a descriptor appeared recently, and replace it with a different one or skip it entirely. If you mentioned a physical feature, mannerism, or expression once, move on. Don't fixate on the same traits every turn. Well-placed humor, unconventional similes, and subverted turns of phrase are encouraged. Avoid GPTisms, purple prose, and anaphoras, especially the negatives with "no/not/wasn't/didn't." Refrain from describing actions or emotions via negation; focus on what does happen, not what doesn't. Minimize asterisks, ellipses, and em-dashes. Explicit content is allowed. Never end on handover cues; finish naturally.\n\n`;
    summaryMessage += `Dialogue Guidelines:\n`;
    summaryMessage += `- Include ALL dialogue lines spoken by enemies and NPC party members during the encounter in direct quotes.\n`;
    summaryMessage += `- Never quote ${userName} directly. Express their actions and dialogue using ONLY indirect speech (e.g., "${userName} swung their sword" or "${userName} asked for help").\n\n`;

    // If in Together mode and trackers are enabled, add tracker update instructions
    if (extensionSettings.generationMode === 'together' && (extensionSettings.showUserStats || extensionSettings.showInfoBox || isPresentCharactersEnabled())) {
        summaryMessage += `\n--- TRACKER UPDATE ---\n\n`;
        summaryMessage += `After the [FIGHT CONCLUDED] summary, update the RPG trackers to reflect ${userName}'s state AFTER the combat encounter. `;
        summaryMessage += `Account for any injuries sustained, resources used, emotional state changes, or other consequences of the battle.\n\n`;

        // Include pre-combat tracker state if available
        if (committedTrackerData.userStats || committedTrackerData.infoBox || committedTrackerData.characterThoughts) {
            summaryMessage += `Pre-combat tracker state:\n`;
            summaryMessage += `<previous>\n`;

            if (committedTrackerData.userStats) {
                const statsJSON = typeof committedTrackerData.userStats === 'object'
                    ? JSON.stringify(committedTrackerData.userStats, null, 2)
                    : committedTrackerData.userStats;
                summaryMessage += statsJSON + '\n';
            }

            if (committedTrackerData.infoBox) {
                const infoBoxJSON = typeof committedTrackerData.infoBox === 'object'
                    ? JSON.stringify(committedTrackerData.infoBox, null, 2)
                    : committedTrackerData.infoBox;
                summaryMessage += infoBoxJSON + '\n';
            }

            if (committedTrackerData.characterThoughts) {
                const charactersJSON = typeof committedTrackerData.characterThoughts === 'object'
                    ? JSON.stringify(committedTrackerData.characterThoughts, null, 2)
                    : committedTrackerData.characterThoughts;
                summaryMessage += charactersJSON + '\n';
            }

            summaryMessage += `</previous>\n\n`;
        }

        // Add tracker instructions and example
        const trackerInstructions = generateTrackerInstructions(false, false, true);
        summaryMessage += trackerInstructions;

        const trackerExample = generateTrackerExample();
        if (trackerExample) {
            summaryMessage += `\n${trackerExample}`;
        }
    }

    messages.push({
        role: 'user',
        content: summaryMessage
    });

    return messages;
}

/**
 * Parses JSON response from the AI, handling code blocks
 * @param {string} response - The AI response
 * @returns {object|null} Parsed JSON object or null if parsing fails
 */
export function parseEncounterJSON(response) {
    try {
        // Ensure response is a string
        if (!response || typeof response !== 'string') {
            console.error('[RPG Companion] parseEncounterJSON received non-string input:', typeof response);
            return null;
        }

        // Remove code blocks if present
        let cleaned = response.trim();

        // Remove ```json, ```markdown, and ``` markers (more comprehensive)
        cleaned = cleaned.replace(/```(?:json|markdown)?\s*/gi, '');

        // Remove any remaining backticks
        cleaned = cleaned.replace(/`/g, '');

        // Find the first { and last }
        const firstBrace = cleaned.indexOf('{');
        const lastBrace = cleaned.lastIndexOf('}');

        if (firstBrace !== -1 && lastBrace !== -1) {
            cleaned = cleaned.substring(firstBrace, lastBrace + 1);
        } else {
            console.error('[RPG Companion] No JSON object found in response');
            return null;
        }

        // Try to parse directly first
        try {
            return JSON.parse(cleaned);
        } catch (initialError) {
            // If direct parsing fails, try JSON repair
            console.warn('[RPG Companion] Initial parse failed, attempting JSON repair...');
            const repaired = repairJSON(cleaned);

            if (repaired) {
                // console.log('[RPG Companion] ✓ Successfully repaired encounter JSON');
                return repaired;
            }

            // If repair also failed, throw the original error
            throw initialError;
        }
    } catch (error) {
        console.error('[RPG Companion] Failed to parse encounter JSON:', error);
        console.error('[RPG Companion] Response was:', response);
        return null;
    }
}
