# Mechanics

The start of a small, setting-agnostic rules system that gives the extension's
numbers a meaning. It follows the HERO System's philosophy: open-ended
characteristics, one consistent 3d6 roll for everything, and the higher a number
gets, the more it adds.

Code: `src/systems/mechanics/rules.js` (pure rules, unit-tested in `tests/`),
`progression.js` (EXP and character points, pure and unit-tested),
`character.js` (reads the character sheet), `rollState.js` (where rolls are
stored and how they reach the prompt). `src/systems/features/experience.js`
connects progression to the panel, quests and encounters.

## The roll

Every check is **3d6, roll under or equal to a target number**.

- 3d6 is a bell curve: each +1 matters most near the middle, and luck can't
  swamp competence the way a flat d20 does.
- A **natural 3 always succeeds**; a **natural 18 always fails**.
- **Margin** = target − roll. It tells the narrator *how well* it went
  (success by 6 is clean; failure by 1 is a near miss).

Targets are written HERO-style: `11-` means "roll 11 or less".

## Attributes

Attributes (STR, DEX, CON, INT, WIS, CHA by default, or your own) are
open-ended numbers. **10 is an ordinary adult. There is no cap.**

    Attribute roll = 9 + attribute / 5   (rounded)

| Attribute | Roll | Chance |
|---|---|---|
| 5  | 10- | 50% |
| 10 | 11- | 62% |
| 15 | 12- | 74% |
| 20 | 13- | 84% |
| 30 | 15- | 95% |

Every 5 points is another +1, forever.

## Skills

Skills ride on whichever attribute fits the situation (Persuasion might use CHA
to charm or INT to argue); the check decides the attribute, the skill adds its
level.

- **Trained**: attribute roll + skill level (levels start at +0 and have no cap).
- **Untrained** (the task needs a skill the character doesn't have): attribute roll **−3**.
- No skill involved: plain attribute roll.

Skill levels are set in the panel (the chips under the skills line) and are
saved per chat. Skills only take part when the Skills section is enabled in
Edit Trackers.

## Difficulty

| Difficulty | Modifier |
|---|---|
| Easy | +2 |
| Average | +0 |
| Hard | −2 |
| Very Hard | −4 |
| Extreme | −6 |

    Target = attribute roll + skill (or untrained −3) + difficulty

Example: DEX 14 (12-), Stealth +2, Hard −2 → roll 12 or less (74%).

## Where rolls go

- A roll belongs to **one user message** and is stored on it. It applies to the
  AI's reply to that message (including swipes and regenerations) and stops
  applying when you send your next message. Rolls never cross chats.
- A roll made with the manual roller before you send is queued and attaches to
  the next message you send (the Attempt button uses the same mechanism).
- The roll reaches the AI through its own injected prompt, only for the main
  reply. Tracker updates, encounter prompts and quiet generations never see it.

## Attempt

The **Attempt** button (d20, above the chat input next to the plot buttons)
sends what you typed as an action that needs a roll:

1. Type the action ("I try to pick the lock before the guard comes back").
2. Click **Attempt**. The model is asked once which attribute, skill and
   difficulty fit, using the editable **Attempt Check Prompt** (Prompts editor).
   Turn off "Suggest the check with AI" in settings to skip this and pick them
   yourself.
3. A dialog shows the check with its target and odds. Adjust it if you like and
   click **Roll and send**: the dice are rolled, the message is sent, and the
   result is attached to it. **Cancel** leaves your text in the box.

Ordinary messages never trigger anything; rolling is always your call.

The suggestion uses the same model as tracker generation (SillyTavern's current
API, or the external API in External mode).

## Progression

Level, EXP and unspent character points (CP) are saved per chat. The level and
EXP can be typed directly on the sheet; reaching the bar levels you up.

    EXP bar = 100 × current level

Every reward is a **percentage of the current bar**, so levelling keeps the same
pace at every level:

| Source | Reward (default) | About this many per level |
|---|---|---|
| Main quest completed | 20–30% (rolled) | 4 |
| Side quest completed | 5–10% (rolled) | 10–20 |
| Enemy of your level defeated | 5% | 20 |

Quests give EXP when you click their ✓ (Complete). ✗ removes a quest without
EXP.

When a tracker update from the AI drops a quest by itself, a dialog asks
whether it was completed (a lone quest comes pre-ticked) and awards EXP for the
ticked ones. The AI replacing the main quest counts as dropping it. Each quest
is only asked about once per chat, so swipes and regenerations don't ask again;
quests you completed or removed yourself are never asked about. This can be
turned off in Settings → Progression.

### Enemies

The encounter set-up prompt asks the model to give each enemy a level on the
player's scale. Defeating one gives

    5% × 1.3^(enemy level − your level)

| Enemy vs you | −5 | −3 | −1 | 0 | +1 | +3 | +5 |
|---|---|---|---|---|---|---|---|
| Multiplier | ×0.27 | ×0.46 | ×0.77 | ×1 | ×1.3 | ×2.2 | ×3.7 |
| Reward | 1.3% | 2.3% | 3.8% | 5% | 6.5% | 11% | 19% |

1.3 keeps the curve gentle: a boss five levels above you is worth almost a
fifth of a level, while trash mobs far below you still give a token 1 EXP.
EXP is awarded when the encounter ends: for every enemy on a victory, and for
enemies brought to 0 HP otherwise. Enemies without a level count as even.

### Character points

Each level gives **3 CP**. Click the CP badge next to the EXP bar to spend them:

- **+1 attribute costs 1 CP.** 5 attribute points make +1 on every roll with
  that attribute, so +1 to rolls costs 5 CP, but it is broad.
- **+1 skill level costs 2 CP.** A direct +1, but only for that skill.

This follows HERO's split: characteristics are cheap per point and broad,
skills are cheaper per +1 but narrow. Only points added in the dialog can be
taken back before applying; attributes and skills can still be edited freely
on the sheet.

All of these numbers are in Settings → Progression.

## Not built yet

Natural next steps for the system:

- NPC attributes/skills, and opposed checks (both sides roll, compare margins).
- Feeding encounter combat through the same rules instead of AI judgement.
- A "check" mode in the manual dice roller.
