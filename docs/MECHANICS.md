# Mechanics

The start of a small, setting-agnostic rules system that gives the extension's
numbers a meaning. It follows the HERO System's philosophy: open-ended
characteristics, one consistent 3d6 roll for everything, and the higher a number
gets, the more it adds.

Code: `src/systems/mechanics/rules.js` (pure rules, unit-tested in `tests/`),
`character.js` (reads the character sheet), `rollState.js` (where rolls are
stored and how they reach the prompt).

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
- A roll made with the manual roller before you type is queued and attaches to
  the next message you send.
- The roll reaches the AI through its own injected prompt, only for the main
  reply. Tracker updates, encounter prompts and quiet generations never see it.

## Auto-Roll

When the Auto-Roll toggle (d20 icon in the panel footer) is on, every message
you send is first checked by the model with the editable **Auto-Roll Check
Prompt** (Prompts editor). It answers whether a check is needed and, if so,
which attribute, skill and difficulty apply. You then get a dialog where you
can adjust those and either roll or skip. Skipping continues the chat as
normal. Each message is only checked once.

The check uses the same model as tracker generation (SillyTavern's current API,
or the external API in External mode).

## Not built yet

Natural next steps for the system:

- NPC attributes/skills, and opposed checks (both sides roll, compare margins).
- Feeding encounter combat through the same rules instead of AI judgement.
- Advancement: attributes and skills that grow through play, with a cost
  (HERO's point-buy is a good model).
- A "check" mode in the manual dice roller.
