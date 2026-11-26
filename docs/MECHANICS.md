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

## Long tasks

The **Task** button (hourglass, next to Attempt) is for work that takes hours,
days or weeks, or the same thing done over and over: a week of sword drills,
crafting a bow, searching an archive all night, a long journey.

1. Type the task, ideally with how long you spend ("I spend the next three
   days at the forge making a proper sword").
2. Click **Task**. With "Suggest the check with AI" on, the model picks the
   attribute, skill and difficulty like for Attempt, plus how long it takes and
   how many **stretches** (1–5) to split it into (the editable **Task Check
   Prompt**).
3. The dialog shows the target for each roll and the odds of each outcome.
   Adjust anything and click **Roll and send**.

Each stretch is one 3d6 check against the same target. The score is the
number of successes, +1 for each critical success, −1 for each critical
failure:

| Score | Outcome |
|---|---|
| more than the stretches | Exceptional: everything worked, and something went remarkably well |
| all stretches | Success |
| more than half | Mostly successful: done, with setbacks |
| above 0 | Partial success: some of it done |
| 0 or less | Failure: the time is spent anyway |

The roll is attached to your message like an Attempt, and the AI is told to
skip ahead: summarize the time as a short montage in which each stretch goes
the way its roll says, end once the time has passed with what was achieved,
what went wrong and what it cost, and move the story's time and date forward
(the tracker picks that up from the reply). More stretches make the result
steadier: one roll is all or nothing, five rolls rarely fail outright.

Rules: `src/systems/mechanics/longTask.js`; button and dialog:
`src/systems/features/longTask.js`.

## Progression

Level, EXP and unspent character points (CP) are saved per chat. The level and
EXP can be typed directly on the sheet; reaching the bar levels you up.

    EXP bar = 100 × current level

Every reward is a **percentage of the current bar**, so levelling keeps the same
pace at every level:

| Source | Reward (default) | About this many per level |
|---|---|---|
| Main quest completed (4 steps) | 20–30% (rolled) | 4 |
| Side quest completed (2 steps) | 5–10% (rolled) | 10–20 |
| Enemy of your level defeated | 5% | 20 |

Quests give EXP when you click their ✓ (Complete). ✗ removes a quest without
EXP.

**Bigger quests give more.** The quest rewards are for a quest of typical
size: 4 steps for a main quest, 2 for a side quest. The reward scales with
the quest's steps (all of them, done or not): a 2-step main quest gives half,
an 8-step one twice as much. A quest without steps counts as typical. Both
numbers are in Settings → Progression; 0 turns the scaling off.

**Quest cap.** However big the quest, one quest gives at most 75% of the EXP
bar (after the steps and the fast start), so a padded quest can't hand out a
whole level. The cap can be changed or switched off in Settings → Progression.

**Fast start.** So a new character gets going quickly, every reward is
multiplied at the first levels: ×2 at level 1, fading evenly to ×1 over four
levels (×2, ×1.75, ×1.5, ×1.25, then ×1). Two main quests take you from
level 1 to 2. Both numbers are in Settings → Progression; ×1 turns it off.

### Quests

A quest has a short **name** ("The Toad Tax"), a **description** and
**steps** (`src/systems/mechanics/quests.js`). The name is the quest's
identifier: the AI may rewrite the description and add or tick off steps
every update, and as long as the name stays, it's the same quest. In the
panel everything is editable: click the name or description, tick steps, add
or remove them. Older chats' plain-text quests become quests with that text
as the name.

How the AI handles quests (naming, steps, when to add optional quests,
finishing) is the **Quest Guidelines** prompt in the Prompts editor. By
default it asks for one main quest and only a few optional ones, and prefers
adding a step to an existing quest over creating a new one.

When a tracker update **marks a quest completed** (`"completed": true`) or
**drops a quest's name**, a dialog asks which were completed and awards EXP
for the ticked ones. Quests the AI marked completed, or whose steps were all
done, come pre-ticked, as does a lone dropped quest. Each quest is only
asked about once per chat, so swipes and regenerations don't ask again;
quests you completed or removed yourself are never asked about. The dialog
can be turned off in Settings → Progression (then only quests the AI marked
completed give EXP).

Quests that were completed or abandoned are listed by name in the tracker
prompt for 20 messages (Settings → Progression), so the AI doesn't create
them again.

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

### Character points and the character sheet

A character is worth a number of character points (CP), and has a **budget**:

    Budget = starting pool + 5 × (level − 1) + any bonus you set

The starting pool comes from the **power level** (Settings → Character Sheet,
or the select on the sheet itself): Gritty 50, **Heroic 100 (default)**,
Legendary 150, or Custom. Enemies are built on a separate world pool (50), so
the power level only changes your side. See `docs/COMBAT_DESIGN.md` "Power
level".

The badge next to the EXP bar shows the CP still unspent (red when over
budget). Click it to open the **character sheet**, where everything that
costs points is edited with live totals:

- **Attributes:** 1 CP per point above 10 (points below 10 give CP back).
  5 attribute points make +1 on every roll with that attribute, so +1 to rolls
  costs 5 CP, but it is broad.
- **Skills:** 2 CP per level. A direct +1, but only for that skill.
- **Combat values** (HP, END, REC, OCV, DCV, PD, ED, SPD), **resistances**,
  **abilities** and **items**: see `docs/COMBAT_DESIGN.md`. Abilities are made
  in the ability builder from effect tags, with their cost shown as you build.

The budget is a guide, not a lock: going over only turns the badge red.
Characters can be saved to a library, loaded into other chats, and exported
or imported as files from the sheet's "Saved characters" section.

The progression numbers are in Settings → Progression; the starting pool, the
Active Point guide and which attributes act as STR/DEX/CON are in Settings →
Character Sheet.

## Combat

Encounters run on the same 3d6 rules through a local combat engine; see
`docs/COMBAT_DESIGN.md`.

## Not built yet

Natural next steps for the system:

- NPC attributes/skills, and opposed checks (both sides roll, compare margins).
- A "check" mode in the manual dice roller.
