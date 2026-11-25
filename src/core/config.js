/**
 * Core Configuration Module
 * Extension metadata and configuration constants
 */

// Type imports
/** @typedef {import('../types/inventory.js').InventoryV2} InventoryV2 */

export const extensionName = 'third-party/rpg-companion-sillytavern';

/**
 * Dynamically determine extension path based on current location
 * This supports both global (public/extensions) and user-specific (data/default-user/extensions) installations
 */
const currentScriptPath = import.meta.url;
const isUserExtension = currentScriptPath.includes('/data/') || currentScriptPath.includes('\\data\\');
export const extensionFolderPath = isUserExtension
    ? `data/default-user/extensions/${extensionName}`
    : `scripts/extensions/${extensionName}`;

/**
 * Default extension settings
 */
export const defaultSettings = {
    enabled: true,
    autoUpdate: true,
    updateDepth: 4, // How many messages to include in the context
    generationMode: 'together', // 'separate' or 'together' - whether to generate with main response or separately
    showUserStats: true,
    showInfoBox: true,
    showCharacterThoughts: true,
    showAlternatePresentCharactersPanel: false,
    enableThoughtBasedExpressions: false,
    hideDefaultExpressionDisplay: false,
    showInventory: true, // Show inventory section (v2 system)
    showQuests: true, // Show quests section
    showLockIcons: true, // Show lock/unlock icons on tracker items
    showThoughtsInChat: true, // Show thoughts overlay in chat
    thoughtsInChatStyle: 'corner', // 'corner' or 'inline'
    enableHtmlPrompt: false, // Enable immersive HTML prompt injection
    enableSpotifyMusic: false, // Enable Spotify music integration (asks AI for Spotify URLs)
    customSpotifyPrompt: '', // Custom Spotify prompt text (empty = use default)
    // Controls when the extension skips injecting tracker instructions/examples/HTML
    // into generations that appear to be user-injected instructions. Valid values:
    //  - 'none'          -> never skip (legacy behavior: always inject)
    //  - 'guided'        -> skip for any guided / instruct or quiet_prompt generation
    //  - 'impersonation' -> skip only for impersonation-style guided generations
    // This setting helps compatibility with other extensions like GuidedGenerations.
    skipInjectionsForGuided: 'none',
    enablePlotButtons: true, // Show plot progression buttons above chat input
    saveTrackerHistory: false, // Save tracker data in chat history for each message
    panelPosition: 'right', // 'left', 'right', or 'top'
    theme: 'default', // Theme: default, sci-fi, fantasy, cyberpunk, custom
    customColors: {
        bg: '#1a1a2e',
        accent: '#16213e',
        text: '#eaeaea',
        highlight: '#e94560'
    },
    statBarColorLow: '#cc3333', // Color for low stat values (red)
    statBarColorHigh: '#33cc66', // Color for high stat values (green)
    enableAnimations: true, // Enable smooth animations for stats and content updates
    mobileFabPosition: {
        top: 'calc(var(--topBarBlockSize) + 60px)',
        right: '12px'
    }, // Saved position for mobile FAB button
    userStats: {
        health: 100,
        satiety: 100,
        energy: 100,
        hygiene: 100,
        arousal: 0,
        mood: '😐',
        conditions: 'None',
        /** @type {InventoryV2} */
        inventory: {
            version: 2,
            onPerson: "None",
            stored: {},
            assets: "None"
        }
    },
    classicStats: {
        str: 10,
        dex: 10,
        con: 10,
        int: 10,
        wis: 10,
        cha: 10
    },
    lastDiceRoll: null, // Legacy: rolls now live on chat messages (mechanics/rollState.js)
    skillLevels: {}, // Per-chat skill levels, keyed by lowercase skill name
    exp: 0, // Per-chat EXP towards the next level
    combatSheet: null, // Per-chat combat sheet: bought values, resistances, abilities, items (features/sheet.js)
    sheetLibrary: [], // Saved character sheets, reusable across chats
    statBlocks: {}, // Per-chat stat blocks of recurring NPCs, keyed by lowercase name (they keep their HP between fights)
    npcTemplates: [], // Generic stat blocks ("Goblin") reusable in any chat
    encounterLogs: [], // Per-chat logs of the last fights (features/combatAftermath.js)
    combat: { // Combat tuning (see src/systems/mechanics/combat/catalog.js DEFAULT_COMBAT)
        startingPool: 50,
        apCapBase: 25,
        apCapPerLevel: 5,
        budgetTolerance: 1.1,
        equalSpeed: false,
        roles: { str: 'str', dex: 'dex', con: 'con' },
        glimmerEnabled: true,
        glimmerChance: 5,
        glimmerMaxPerFight: 1
    },
    resolvedQuests: [], // Per-chat quests already completed/removed/answered (lowercase titles)
    askAboutDroppedQuests: true, // Ask whether quests the tracker AI removes were completed
    progression: { // Tuning for EXP and character points (see src/systems/mechanics/progression.js)
        expBase: 100,
        mainQuestMin: 20,
        mainQuestMax: 30,
        sideQuestMin: 5,
        sideQuestMax: 10,
        enemyBase: 5,
        enemyLevelFactor: 1.3,
        pointsPerLevel: 5,
        attributeCost: 1,
        skillCost: 2
    },
    showAttemptButton: true, // Show the Attempt (roll for it) button above the chat input
    attemptSuggest: true, // Ask the AI which attribute/skill/difficulty fits when Attempt is clicked
    customAttemptPrompt: '', // Custom attempt check prompt (empty = use default)
    customQuestPrompt: '', // Custom quest guidelines for tracker updates (empty = use default)
    questMemory: 20, // Chat messages a finished/abandoned quest is listed in the tracker prompt
    questHistory: [], // Per chat: [{name, outcome, at}] quests finished or abandoned
    collapsedInventoryLocations: [] // Array of collapsed storage location names
};
