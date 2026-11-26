/**
 * Progression rules: EXP, levels and character points.
 *
 * Pure functions only (no SillyTavern imports) so they can be unit-tested.
 *
 * Rewards are a percentage of the current EXP bar (the EXP needed to reach the
 * next level), so the pace of levelling stays the same at every level: by
 * default about four main quests, or ten to twenty side quests, or twenty
 * even-level enemies make a level.
 */

export const DEFAULT_PROGRESSION = Object.freeze({
    /** EXP bar for level N is expBase × N. Only the displayed numbers depend on it. */
    expBase: 100,
    /** Main quest reward, % of the EXP bar (rolled between min and max). */
    mainQuestMin: 20,
    mainQuestMax: 30,
    /** Side quest reward, % of the EXP bar. */
    sideQuestMin: 5,
    sideQuestMax: 10,
    /**
     * Quest rewards scale with the quest's steps: a quest with this many steps
     * gets the range above, one with twice as many twice as much. Quests
     * without steps count as typical. 0 turns the scaling off.
     */
    mainQuestSteps: 4,
    sideQuestSteps: 2,
    /** No single quest gives more than this % of the EXP bar (after steps and the fast start). */
    questCapEnabled: true,
    questCap: 75,
    /** Defeating an enemy of your own level, % of the EXP bar. */
    enemyBase: 5,
    /**
     * Reward multiplier per level of difference: base × factor^(enemy − you).
     * 1.3 → +1 level ×1.3, +3 ×2.2, +5 ×3.7; −1 ×0.77, −3 ×0.46, −5 ×0.27.
     */
    enemyLevelFactor: 1.3,
    /** Fast start: EXP rewards × this at level 1, fading to ×1 ... */
    earlyBoost: 2,
    /** ... over this many levels (×2 over 4: level 1 ×2, 2 ×1.75, 3 ×1.5, 4 ×1.25, then ×1). */
    earlyLevels: 4,
    /** Character points gained per level. */
    pointsPerLevel: 5,
    /** Cost in character points of +1 to an attribute. */
    attributeCost: 1,
    /** Cost in character points of +1 to a skill level. */
    skillCost: 2
});

function num(value, fallback, min = 0) {
    const n = Number(value);
    return Number.isFinite(n) && n >= min ? n : fallback;
}

/** Fills in missing/invalid values with defaults and orders min/max ranges. */
export function normalizeProgression(settings = {}) {
    const d = DEFAULT_PROGRESSION;
    const out = {
        expBase: num(settings.expBase, d.expBase, 1),
        mainQuestMin: num(settings.mainQuestMin, d.mainQuestMin),
        mainQuestMax: num(settings.mainQuestMax, d.mainQuestMax),
        sideQuestMin: num(settings.sideQuestMin, d.sideQuestMin),
        sideQuestMax: num(settings.sideQuestMax, d.sideQuestMax),
        mainQuestSteps: Math.min(50, Math.floor(num(settings.mainQuestSteps, d.mainQuestSteps))),
        sideQuestSteps: Math.min(50, Math.floor(num(settings.sideQuestSteps, d.sideQuestSteps))),
        questCapEnabled: settings.questCapEnabled === undefined ? d.questCapEnabled : Boolean(settings.questCapEnabled),
        questCap: num(settings.questCap, d.questCap, 1),
        enemyBase: num(settings.enemyBase, d.enemyBase),
        enemyLevelFactor: num(settings.enemyLevelFactor, d.enemyLevelFactor, 1),
        earlyBoost: Math.min(10, num(settings.earlyBoost, d.earlyBoost, 1)),
        earlyLevels: Math.min(50, Math.floor(num(settings.earlyLevels, d.earlyLevels))),
        pointsPerLevel: Math.floor(num(settings.pointsPerLevel, d.pointsPerLevel)),
        attributeCost: Math.max(1, Math.floor(num(settings.attributeCost, d.attributeCost, 1))),
        skillCost: Math.max(1, Math.floor(num(settings.skillCost, d.skillCost, 1)))
    };
    for (const kind of ['mainQuest', 'sideQuest']) {
        if (out[`${kind}Min`] > out[`${kind}Max`]) {
            [out[`${kind}Min`], out[`${kind}Max`]] = [out[`${kind}Max`], out[`${kind}Min`]];
        }
    }
    return out;
}

/** EXP needed to go from `level` to `level + 1`. */
export function expToNextLevel(level, settings = DEFAULT_PROGRESSION) {
    return Math.max(1, Math.round(settings.expBase * Math.max(1, Math.floor(level) || 1)));
}

/** Fast-start multiplier on EXP rewards at a level (1 once the early levels are past). */
export function earlyMultiplier(level, settings = DEFAULT_PROGRESSION) {
    const boost = Number(settings.earlyBoost ?? 1);
    const levels = Math.floor(Number(settings.earlyLevels ?? 0));
    const l = Math.max(1, Math.floor(level) || 1);
    if (!(boost > 1) || levels <= 0 || l > levels) return 1;
    return 1 + (boost - 1) * (levels - l + 1) / levels;
}

/**
 * Converts a percentage of the bar to whole EXP (at least 1 for a positive %), with the fast start.
 * @param {number} [cap] - the most it may give, as a % of the bar (after the fast start)
 */
function percentOfBar(percent, level, settings, cap = Infinity) {
    if (percent <= 0) return 0;
    const boosted = Math.min(percent * earlyMultiplier(level, settings), cap);
    return Math.max(1, Math.round(expToNextLevel(level, settings) * boosted / 100));
}

/** The quest reward cap, as a % of the bar (Infinity when off). */
export function questCapPercent(settings = DEFAULT_PROGRESSION) {
    return settings.questCapEnabled === false ? Infinity : (Number(settings.questCap) || Infinity);
}

/**
 * How much a quest's size scales its reward: its steps ÷ the typical number
 * of steps for its kind. Quests without steps (or with scaling off) count 1.
 */
export function questStepMultiplier(kind, steps, settings = DEFAULT_PROGRESSION) {
    const typical = Number(kind === 'main' ? settings.mainQuestSteps : settings.sideQuestSteps) || 0;
    const n = Math.floor(Number(steps) || 0);
    if (typical <= 0 || n <= 0) return 1;
    return n / typical;
}

/**
 * EXP for completing a quest.
 * @param {'main'|'side'} kind
 * @param {number} level - current level
 * @param {object} settings - normalized progression settings
 * @param {() => number} rng - returns [0, 1)
 * @param {number} [steps] - the quest's number of steps (see questStepMultiplier)
 */
export function questReward(kind, level, settings = DEFAULT_PROGRESSION, rng = Math.random, steps = 0) {
    const min = kind === 'main' ? settings.mainQuestMin : settings.sideQuestMin;
    const max = kind === 'main' ? settings.mainQuestMax : settings.sideQuestMax;
    return percentOfBar((min + (max - min) * rng()) * questStepMultiplier(kind, steps, settings), level, settings, questCapPercent(settings));
}

/** Reward multiplier for an enemy `enemyLevel` vs a player at `playerLevel`. */
export function enemyLevelMultiplier(enemyLevel, playerLevel, settings = DEFAULT_PROGRESSION) {
    const diff = (Number(enemyLevel) || playerLevel) - playerLevel;
    return Math.pow(settings.enemyLevelFactor, diff);
}

/** EXP for defeating one enemy. */
export function enemyReward(enemyLevel, playerLevel, settings = DEFAULT_PROGRESSION) {
    const percent = settings.enemyBase * enemyLevelMultiplier(enemyLevel, playerLevel, settings);
    return percentOfBar(percent, playerLevel, settings);
}

/**
 * Adds EXP and resolves any level-ups. Leftover EXP carries into the next level.
 * @param {{level: number, exp: number, points: number}} state
 * @param {number} amount
 * @returns {{level: number, exp: number, points: number, levelsGained: number, pointsGained: number}}
 */
export function addExp(state, amount, settings = DEFAULT_PROGRESSION) {
    let level = Math.max(1, Math.floor(state.level) || 1);
    let exp = Math.max(0, Math.floor(state.exp) || 0) + Math.max(0, Math.floor(amount) || 0);
    let levelsGained = 0;

    while (exp >= expToNextLevel(level, settings)) {
        exp -= expToNextLevel(level, settings);
        level += 1;
        levelsGained += 1;
    }

    const pointsGained = levelsGained * settings.pointsPerLevel;
    return {
        level,
        exp,
        points: Math.max(0, Math.floor(state.points) || 0) + pointsGained,
        levelsGained,
        pointsGained
    };
}
