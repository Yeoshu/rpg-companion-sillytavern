# Combat overhaul: design spec

Status: **agreed**. Built so far:

- Step 1, the rules engine: `src/systems/mechanics/combat/`, tests in
  `tests/combat.test.mjs`.
- Step 2, the character sheet: `src/systems/features/sheet.js` (data, budget,
  inventory link, library) and `src/systems/ui/sheetEditor.js` (sheet editor
  and ability builder), opened from the CP badge in the panel.
- Step 3, the combat window: `src/systems/ui/encounterUI.js` runs the fight on
  the engine. The set-up call asks for stat blocks in the §10 format
  (`buildStatBlockInstructions` in `encounterPrompts.js`), `roster.js`
  validates and budget-scales them, then the pre-fight preview, the
  timeline, the action bar with hit chances, the log, and the result screen
  with tier-scaled EXP and the summary. You start at your tracker Health and
  Energy.
- Step 4, the AI calls (`src/systems/mechanics/combat/aiPrompts.js`, pure and
  tested):
  - **Known characters:** before the set-up call, stored stat blocks whose
    names (or aliases) appear in recent chat or Present Characters are
    offered; the AI reuses them by name (`"existing": true`). Templates can
    appear several times ("Toad 1", "Toad 2").
  - **Narration:** one call at the start of each of your phases, narrating
    everything since the last one (Settings → Advanced → Combat narration;
    "only the summary" skips it).
  - **Free actions:** typed text becomes one of your abilities, Dodge /
    Recover / Flee, or an improvised check (attribute, skill, difficulty and
    an effect capped at half your AP guide) that you confirm and roll.
  - **AI tactics** (optional setting): one call per AI-controlled action;
    anything invalid falls back to the local tactics.
  - **Saving:** after the fight, named newcomers can be saved in the chat and
    generic ones as templates (`src/systems/features/npcStore.js`). Stored
    characters start every fight at full HP and END, unless "Saved characters
    keep their wounds" is on; then they keep the HP and END (at least 1) they
    ended the last fight with. The
    Characters manager (from the preview or the character sheet) edits,
    rests and deletes them.
- Step 5, persistence and settings:
  - **Tracker write-back** (`features/combatAftermath.js`, pure part in
    `mechanics/combat/aftermath.js`): when the fight ends, Health and Energy
    are set from your HP and END (as a share of each stat's maximum), and
    used items come off the On Person inventory (or the sheet's own quantity
    for items not in the inventory). The summary prompt is given these exact
    values, so its tracker update agrees. Settings → Advanced → "Update the
    tracker after a fight".
  - **Combat logs**: the last 10 fights per chat (log, narration, summary,
    who took part), with a viewer, export and delete (Settings → Advanced →
    View combat logs).
  - **Settings**: tier budget and HP multipliers, the over-budget tolerance
    (Settings → Character Sheet), the pause between enemy actions, equal
    speed, narration mode and AI tactics (Settings → Advanced).

The overhaul is complete.

Decisions on the open questions are at the end; balance changes found by
simulation are marked in §2, §3 and §7.

## Goals

- **The numbers are local, the story is the AI's.** Every roll, every point of
  damage, turn order and the end of the fight are decided by the extension's
  rules engine. The AI creates opponents, interprets free-text actions and
  narrates results that are already decided.
- **Build anything from a small set of parts.** An ability or item is a thing,
  used on a target, with a list of effects. Names and descriptions are pure
  flavour; the effects carry the mechanics.
- **One scale for everyone.** The player, NPC allies and enemies share the same
  stat block format, the same point costs and the same rules.
- **HERO System as the model.** Point-costed powers with advantages and
  limitations, Endurance, Speed and the 12-segment turn, CV-based to-hit rolls,
  all on the 3d6 roll-under engine already in `docs/MECHANICS.md`.
- **Persistence.** Fights start from and write back to the tracker's Health
  (and Energy). Stat blocks are kept per chat; character sheets can be saved
  to a library and reused across chats.

The structure stays as it is: a separate encounter window, and a summary posted
to the chat at the end.

---

## 1. Skills, abilities and items

| | What it is | Used in | Costs CP |
|---|---|---|---|
| **Skill** | A trained competence with a level (Stealth +2) | Attempt checks (unchanged) | 2 per level |
| **Ability** | A combat action built from effect tags | Encounters | Its real cost (§3) |
| **Item** | An ability with a quantity, used up on use | Encounters (and the tracker inventory) | No (equipment comes from the story), but its point cost is shown as a guide |

An item is linked to the tracker inventory by name: "Health Potion x3" in the
inventory uses the item definition called "Health Potion", and using one in
combat lowers the count to x2 locally.

---

## 2. Derived combat values

Attributes stay open-ended (10 = ordinary adult). Combat values are derived
from them, plus anything bought with CP. Because attribute names are
customisable, settings map each role to an attribute (defaults shown).

| Value | Formula | Typical at 10 | Buy extra |
|---|---|---|---|
| **HP** | 20 + 2 × CON | 40 | 1 CP per 2 HP |
| **END** (Endurance) | 2 × CON | 20 | 1 CP per 2 END |
| **REC** (Recovery) | STR/5 + CON/5 | 4 | 2 CP per +1 |
| **OCV** (attack) | DEX/5 | 2 | 5 CP per +1 |
| **DCV** (defence) | DEX/5 | 2 | 5 CP per +1 |
| **PD** (physical defence) | STR/5 | 2 | 3 CP per +1 |
| **ED** (elemental defence) | CON/5 | 2 | 3 CP per +1 |
| **SPD** (actions per turn) | 1 + DEX/10 (rounded down) | 2 | 10 CP per +1 |
| **Unarmed damage** | STR/5 d6, blunt | 2d6 | through STR |

/5 values are rounded to the nearest whole number. SPD is capped at 12.

### Damage types and resistances

- **Physical:** blunt, pierce, slash. Reduced by **PD**.
- **Elemental:** fire, water, earth, air, ice, lightning, poison. Reduced by **ED**.

Each stat block can list per-type modifiers:

| Modifier | Damage taken | Cost |
|---|---|---|
| Immune | ×0 | 15 CP |
| Resistant | ×0.5 | 5 CP |
| Weak | ×1.5 | −5 CP (gives points back) |

Adding a type later is one entry in a list.

---

## 3. Abilities: effect tags and point cost

### Shape

```json
{
  "name": "Fire Bolt",
  "description": "A lance of white flame.",
  "target": "one-enemy",
  "roll": "attack",
  "effects": [
    { "type": "damage", "dice": 4, "flat": 0, "damageType": "fire" }
  ],
  "advantages": [],
  "limitations": []
}
```

**Target:** self, one ally, one enemy, all allies, all enemies, everyone.

**Roll:**
- **attack:** the to-hit roll (§5). On a miss, nothing happens.
- **automatic:** no roll. Typical for self-buffs and healing.

### Effects (base cost in Active Points, AP)

| Effect | Fields | Base cost |
|---|---|---|
| **Damage** | dice (d6), flat bonus, damage type, *scales with* none / STR / DEX (physical only: adds 1d6 per 5 points of that attribute above 10, at no cost, up to the effect's own dice, so it can at most double it) | 5 per d6, 2 per +1 flat |
| **Heal** | dice, flat | 10 per d6, 4 per +1 flat |
| **Shield** | amount absorbed, duration | 1 per point absorbed (× duration, below) |
| **Apply status** | a status (§4) | cost of the status |
| **Cleanse** | category: over time / debuff / buff / incapacitate | 5 per category |
| **Restore END** | amount | 1 per point |

### Advantages (raise the cost)

    Active Points = sum of effect base costs × (1 + sum of advantages)

| Advantage | Value |
|---|---|
| Area: hits every target on that side | +1 |
| Armour-piercing: halves PD/ED | +½ |
| Lifesteal: heals the user for X% of damage dealt | +X/100 (50% → +½) |
| Accurate: +X OCV with this ability | +¼ per +1 |
| No END cost | +½ |
| Separate targets: effects can have their own target (each chosen separately when used; an unchosen one falls back to the main target when that fits, else the first valid one). Area is then counted per effect. | +¼ per effect with its own target |

### Limitations (lower the price)

    Real cost (CP) = Active Points / (1 + sum of limitations), rounded

| Limitation | Value |
|---|---|
| Charges instead of END: 1 use per fight | −1 |
| 2–3 uses per fight | −¾ |
| 4–8 uses per fight | −½ |
| Costs double END | −½ |
| Requires a skill roll to activate | −½ |
| Item-based: lost if the item is lost or taken | −½ |
| Slow: acts at the end of the segment, after everyone else | −¼ |

### END cost

Each use costs **AP / 10 END** (rounded, at least 1), unless it has *No END cost*
or Charges. A character without enough END can still act, but each missing
point costs 1 HP.

### Example

| | Effects | AP | Real cost | END |
|---|---|---|---|---|
| Fire Bolt | 4d6 fire | 20 | 20 | 2 |
| Twin Daggers | 2d6 slash + STR, Accurate +1 | 10 × 1.25 = 12.5 → 13 | 13 | 1 |
| Fireball | 4d6 fire, Area | 20 × 2 = 40 | 40 | 4 |
| Fireball, 2 scrolls | 4d6 fire, Area, 2–3 uses (−¾), item (−½) | 40 | 40 / 2.25 = 18 | 0 |
| Healing Light | 2d6 heal, one ally, automatic | 20 | 20 | 2 |
| Venom Strike | 1d6 pierce + STR, poison status (1d6 for 3 phases) | 5 + 11 = 16 | 16 | 2 |

---

## 4. Statuses

Every status is one of five templates. You name and describe it; the template
carries the mechanics.

| Template | Fields | Examples | Cost |
|---|---|---|---|
| **Over time** | dice per tick (damage with a type, or healing), duration | burn, poison, bleed, regeneration | damage dice × 5 × duration × ¾ (healing: × 10 instead of × 5) |
| **Modifier** | value (OCV, DCV, PD, ED, SPD, damage dice, or an attribute), ± amount, duration | haste, weaken, armour break, blessed | per-point buy cost (§2) × amount × duration factor |
| **Incapacitate** | duration | stun, sleep, freeze, paralysis | 10 per phase lost |
| **Shield** | amount, duration | ward, barrier | 1 per point × duration factor |
| **Taunt** | duration | provoke | 5 per phase |
| **Counter** | dice and damage type, times it can strike back, duration | thorns, riposte, reflective ward | 5 per d6 × ¾ × times × duration factor |

**Duration factor:** 1 + ¼ per phase after the first.

**Rules:**
- Durations count the **affected character's own phases**. An over-time
  status ticks at the start of each of them. Over-time damage ignores PD/ED (it's already in) but
  is affected by resistances and weaknesses.
- Modifiers, shields and taunts count down at the end of each of the affected
  character's phases. One applied during the character's own phase (a self-buff)
  lasts through their next phase too.
- **Stacking:** re-applying the same status refreshes its duration and keeps
  the higher potency. Different statuses stack.
- **Resisting:** *Incapacitate* and *Taunt* allow the target a CON roll (or
  INT for mental flavours; it's chosen in the builder). A success halves the
  duration, rounded down; it can drop to 0.
- **Categories** (for Cleanse):
  - *over time* (damage over time only)
  - *debuff* (any negative modifier)
  - *buff* (any positive modifier, regeneration, shield)
  - *incapacitate*

---

## 5. Resolving an attack

1. **To hit:** roll 3d6 ≤ **11 + OCV (+ Accurate) − target's DCV**.
   - A natural 3 always hits and is a **critical**: the damage dice count at
     their maximum.
   - A natural 18 always misses.
   - Area abilities roll once per target.
2. **Damage** = dice + flat (+ STR or DEX bonus dice if the effect scales with one).
3. **× resistance or weakness** for the damage type.
4. **− PD or ED** (halved for armour-piercing). At least 0.
5. A **Shield** absorbs damage before HP.
6. **Statuses** on the ability apply on a hit. A target with a resistance roll
   rolls for it.

A character at **0 HP is out of the fight**. Below 0 counts as 0, and HP
doesn't go negative.

---

## 6. Speed and the 12-segment turn

A turn has 12 segments. A character acts in the segments listed for their SPD:

| SPD | Acts in segments |
|---|---|
| 1 | 7 |
| 2 | 6, 12 |
| 3 | 4, 8, 12 |
| 4 | 3, 6, 9, 12 |
| 5 | 3, 5, 8, 10, 12 |
| 6 | 2, 4, 6, 8, 10, 12 |
| 7 | 2, 4, 6, 7, 9, 11, 12 |
| 8 | 2, 3, 5, 6, 8, 9, 11, 12 |
| 9 | 2, 3, 4, 6, 7, 8, 10, 11, 12 |
| 10 | 2, 3, 4, 5, 6, 8, 9, 10, 11, 12 |
| 11 | 2–12 |
| 12 | 1–12 |

**Order:**
- The fight starts at **segment 12**, so everyone acts once first.
- Within a segment, higher DEX acts first. Ties are broken by a die roll once
  per fight.

**Recovery:** after segment 12, everyone regains REC in END.

**Equal speed option.** A setting that gives everyone SPD 1: one action each
per turn, in DEX order.

**What this looks like:** a SPD 4 rogue against SPD 2 goblins acts twice for
every goblin action. A SPD 6 duellist against a SPD 2 brute gets three actions
between each of the brute's swings.

**Timeline.** The window shows a strip of segments 1–12, with portraits on the
segments where each combatant acts, so you can see who's coming up.

### Basic actions (everyone has them, no CP)

| Action | Effect |
|---|---|
| **Strike** | The basic attack: STR/5 d6, attack roll, END 1 per 2d6. Its name, damage type and flavour can be changed on the sheet ("Fire Fist", fire). |
| **Dodge** | +3 DCV until your next phase |
| **Recover** | Regain REC END (and nothing else) |
| **Use item** | Use an item (a phase) |
| **Flee** | DEX roll against the fastest enemy's DEX roll (higher margin wins). Success ends the fight as *escaped*. |
| **Free action** | Type what you do (§8) |

---

## 7. Point budget and balance

**Total points** a character is worth:

    attributes:  (value − 10) × 1 for each attribute (below 10 gives points back)
    skills:      level × 2
    bought derived values (§2)
    abilities:   real cost
    resistances/weaknesses

**Budget:**

    Budget at level L = starting pool + CP per level × (L − 1)

- Starting pool: from the **power level** (see "Power level" below):
  Gritty 50, Heroic 100 (default), Legendary 150. Enemies use the separate
  **world pool** (50) instead: `worldBudget` in `costs.js`.
- The sheet shows **spent / budget**. Unspent points replace today's CP
  counter, which becomes a computed number.
- Levelling still gives the CP per level, and spending works as now. In
  addition, abilities can be bought, and anything can be refunded.
- The budget is a **metric, not a lock**. Going over shows a warning, and an
  existing character above budget keeps everything.

**Active Point cap:** a warning when one ability's AP exceeds
**base + 5 × level**, the base from the power level (Gritty 25: 30 at level
1, a 6d6 attack; Heroic 35: 40, 8d6; Legendary 45: 50, 10d6). It's a guide,
not a limit.

### Abilities are priced as a pool

Only one ability can be used per phase, so a wide repertoire shouldn't cost
as much as stacking power into one attack. Abilities are priced like a HERO
Multipower: **the most expensive ability costs its full real cost; every other
ability costs a fifth of its real cost** (rounded up). The builder shows what
adding an ability actually costs this sheet.

### Example level 1 build (50 / 50 CP)

| | Cost | Effects |
|---|---|---|
| STR 13, DEX 15, CON 12 | 10 | |
| Stealth +2, Athletics +1 | 6 | |
| PD +1, ED +1 | 6 | |
| Fire Bolt | 25 | 5d6 fire (the most expensive ability: full cost) |
| Twin Daggers | 3 | 2d6 slash + STR (+1d6) = 3d6, OCV +1 (real 13, ÷5) |

Derived values: HP 44, END 24, REC 5, OCV 3, DCV 3, PD 4, ED 3, SPD 2.

### Enemies

The AI gives each enemy a level and a **tier**. Their budget is the budget of
that level × the tier's multiplier, and the tier scales their HP:

| Tier | Budget | HP | Meant as | Simulated vs the build above |
|---|---|---|---|---|
| Minion | ×0.4 | ×0.5 | Fodder, comes in groups | three: ~55% win |
| Standard | ×0.45 | ×1 | A fair fight in pairs | one: ~95%, two: ~35% |
| Elite | ×0.6 | ×1.5 | A fair fight alone | ~50% |
| Boss | ×0.8 | ×2 | Fights a whole party | ~10% solo |

The multipliers are below 1 because enemies spend everything on combat,
while a player character also buys skills and versatility. They were tuned
by simulating thousands of fights with the engine; fights last 5–8 player
phases. Power rises steeply with points, so a few points matter.

The EXP reward also gets the tier's HP multiplier (minion ×0.5 … boss ×2).

**Checking the AI's stat blocks:**
- The extension computes the points of every stat block the AI writes.
- Over budget by more than 10%: the most expensive parts (damage dice,
  bought values, attributes) are cut step by step, and the enemy is marked
  "adjusted".
- Invalid tags are dropped.
- You see all of it in the pre-fight preview (§9).

---

## 8. What the AI does

| Call | When | Input | Output |
|---|---|---|---|
| **Set-up** | Fight start | Scene (as now), confirmed existing stat blocks, the tag vocabulary, the budget table | New stat blocks in the schema (§10), each with a level and tier, plus environment and style |
| **Free action** | When you type an action | Your sheet, the situation, your text | One of: <br>• "this is ability X on target Y"<br>• an improvised check: attribute, skill, difficulty, and an outcome built from the same effect tags, capped at half your AP cap, rolled locally |
| **Narration** | Once per player phase | The mechanical log since your last phase (who did what, rolls, damage, statuses) | Narrative prose only (no numbers to change) |
| **Summary** | Fight end | The whole log | The chat summary, as now |
| **Tactics** *(optional)* | Each enemy phase, if turned on | The enemy's abilities and the situation | Which ability on whom |

**Enemy tactics.** By default, enemies choose locally:
1. Heal or shield when below 30% HP and able to.
2. Don't re-apply a status the target already has.
3. Prefer a free (no END) attack when low on END.
4. Otherwise take the action with the best expected damage. Minions pick the
   weakest target; others are weighted towards whoever hurt them last.

The optional AI tactics setting replaces this with a call per enemy phase.

**Narration setting:**
- *Every player phase* (default)
- *Only at the end*: a mechanical log during the fight, and the summary
  tells the story. This is the cheapest option.

So a fight costs one set-up call, one call per player phase (or none), one per
free action, and one summary. Today's version costs a large call per round.

The per-phase prompt no longer resends character cards and chat history. The
set-up call already turned them into stat blocks and an environment
description.

---

## 9. Flow

1. **Enter Encounter.** The narrative-style dialog, as now.
2. **Matching stat blocks.**
   - The chat's stored stat blocks are matched against present characters and
     names in recent messages. Matching is case-insensitive and includes
     aliases.
   - A dialog asks: "These characters already have stat blocks: ☑ Mira
     ☑ Captain Hale. Use them?"
3. **Set-up call.**
4. **Pre-fight preview.**
   - Every combatant appears with its stat block, points and "adjusted" flags.
   - You can edit any stat block, regenerate the enemies, or start.
5. **Combat window.** It shows:
   - the speed timeline
   - combatants with HP, END and status chips (hover a chip for exact numbers)
   - your action bar, on your phases. Each ability shows its END cost and your
     hit chance against the selected target, e.g. "Fire Bolt · 2 END · 74%
     vs Goblin".
   - the log: mechanical lines (with dice) and narration
6. **NPC allies.** By default, the local tactics play them. A per-ally
   checkbox lets you choose their actions yourself.
7. **End.** One side is at 0 HP, someone fled, or you click Conclude.
   - Write back to the tracker:
     - Health % = HP / max HP
     - Energy % = END / max END, if an Energy stat exists
     - item counts in the inventory
   - Award EXP (with tiers).
   - Offer to save new named stat blocks to the chat, and generic ones as
     reusable templates.
   - Post the summary.
8. **Health on entry.** HP = max HP × tracker Health %, and the same for END
   and Energy. Named NPCs start at full HP and END. With "Saved characters
   keep their wounds" on, they keep their HP between fights instead (stored
   on their stat block, reset by Rest or by editing). Templates never keep
   HP. Note that a branch or checkpoint copies the chat's data, saved
   characters included.

---

## 10. Storage

| What | Where | Lifetime |
|---|---|---|
| The player's sheet (attributes, skills, bought values, abilities, items, resistances) | `chat_metadata.rpg_companion.sheet` | Per chat |
| NPC and enemy stat blocks | `chat_metadata.rpg_companion.statBlocks` (keyed by lowercase name, with aliases) | Per chat |
| Saved character sheets and NPC templates | `extensionSettings.sheetLibrary` | Global |
| Encounter logs | `chat_metadata.rpg_companion.encounterLogs`, last 10 | Per chat (fixes the logs that are lost today) |

**Library behaviour:**
- Loading a sheet from the library **copies** it into the chat.
- "Save to library" writes it back, either overwriting the entry or as a copy.
- Import and export as a JSON file make sheets shareable.
- **Persona link** (🔗 on a saved character): links it to the active persona
  (one character per persona). A fresh chat with that persona (empty sheet,
  level 1, no EXP) starts with the character loaded, including its level,
  and saving the sheet in a chat with that persona updates the saved copy.
  Chats that already have a character are never overwritten.
- **Class templates** (`extensionSettings.classTemplates`, global): level-1
  builds to start a character from. "Save as class" stores the current
  attributes, skills, bought values, resistances, abilities, items and Strike
  at level 1, and refuses builds that cost more than a level-1 character has
  (the power level's starting pool). Applying one replaces those parts of the
  sheet; the name, level, bonus and glimmer points stay, so a level-3
  character keeps the CP it has on top. A class that costs more than the
  current power level allows is flagged. Templates import and export like
  saved characters.

**Stat block schema** (the same for the player, allies and enemies):

```json
{
  "name": "Captain Hale",
  "aliases": ["Hale", "the Captain"],
  "level": 4,
  "tier": "elite",
  "attributes": { "str": 14, "dex": 12, "con": 15, "int": 11, "wis": 10, "cha": 13 },
  "bought": { "ocv": 1, "pd": 3 },
  "resistances": { "slash": "resistant", "fire": "weak" },
  "abilities": [ /* §3 */ ],
  "items": [ { /* ability */ "quantity": 2 } ],
  "hp": 52, "end": 30,
  "description": "...", "sprite": "⚓"
}
```

---

## 11. Build order

1. **Rules engine.** Pure and unit-tested: costs, derived values, speed chart,
   attack resolution, statuses, budget, validation and scaling, enemy tactics.
2. **Sheet and builder.**
   - The sheet editor (a popup opened from the panel).
   - The ability builder: a live AP / real cost / END readout, and cap
     warnings.
   - Items and the inventory link.
   - The library, and migration from today's attributes, skills and CP.
3. **Combat window.** A rewrite on top of the engine: timeline, action bar,
   log, the pre-fight preview.
4. **AI calls.** Set-up schema and validation, free actions, narration,
   optional tactics, summary. Also stat block matching and saving.
5. **Persistence and polish.** Health and Energy sync, EXP tiers, settings
   (equal speed, narration mode, tactics, every number in §2–§7), docs.

Each step is usable and testable before the next one.

---

## Additions after the overhaul

- **STR or DEX scaling** for physical damage effects (replaces "adds STR";
  old sheets keep working).
- **Counter** status: when the holder is hit by an enemy's attack roll, it
  deals its dice back to the attacker (through their defences), up to its
  number of times, then it's spent. Misses, automatic abilities and damage
  over time don't trigger it, and counters never trigger counters.
- **Basic attack** name, damage type and flavour on the sheet (and in AI
  stat blocks as `"strike"`).
- **Separate targets** advantage (table in §3). Magic Missile: three 1d6
  effects, two with their own one-enemy target, picked one after another.
  Battle Surge: damage to the main target plus a buff with target self.
- The ability builder compares an ability's average damage with your basic
  attack's.
- **Unlimited items** (a checkbox in the item builder): never used up and not
  counted against the inventory, e.g. a wand or a holy symbol.
- **Narration per side's turn**: one narration call when the acting side
  changes (your side's run of phases, then theirs), instead of one per phase.
- **Planning several phases**: when you act more than once before the other
  side does (higher SPD), you queue an action for each of those phases
  (Undo / Go), they play out, and the whole run is narrated together. A typed
  action ends the plan: the queued actions resolve and are narrated, then the
  typed action is worked out as before, and you plan the rest afterwards.
- **Dialogue** (Say, next to Act) is a free action: it's logged at once,
  doesn't use the phase, and goes into the narration and summary.
- **Choosing the opponent**: the Enter Encounter dialog asks who or what you
  fight. Left empty, the AI decides from the scene; filled in, the set-up is
  built around it (and it's matched against stored characters too).
- **Flavour reaches the AI**: ability, item and basic-attack descriptions go
  into the set-up sheet, free-action and tactics prompts, and narration and
  the summary get the descriptions of the abilities that were used.

## Glimmers

After SaGa: abilities can spark on their own in tough fights, for characters
who should grow rather than be fully designed (`mechanics/combat/glimmer.js`,
tested).

- **When**: each time the player uses an ability or their basic attack on
  an enemy (not items, typed or basic actions), a local roll against
  `base chance × tier factor × 1.4^(enemy level − your level)`, capped at
  50%. Tier factor: minion ¼, standard 1, elite 2, boss 3. Base 5%, at most
  1 glimmer per fight (Settings → Character Sheet).
- **What**: the fight pauses ("💡 Glimmer!") and one AI call designs a new
  ability that grows out of the technique being used, from the sheet and the
  character's **glimmer preferences** (character sheet → Glimmers), aiming at
  1.2 × the technique's AP + 5, capped at the AP guide for the level. You
  can **learn it**, **reroll** (the AI is told not to repeat what was turned
  down) or **let it go**.
- **Learned**: it's added to the sheet (marked 💡) and used at once instead
  of the chosen action, as in SaGa. The sheet gets **bonus CP equal to what
  the ability cost it** when learned, so it's free; editing it later costs
  normally, and deleting it keeps the points.
- Glimmers are logged, so narration and the summary describe them.

## Encounter difficulty: swarms and reserves

Per-enemy budgets don't stop the AI from sending six of something, and six
attacks a round kill a level 1 character however weak each one is (six
minion rats at a third of the minion budget still won 99% of simulated
fights). So the encounter as a whole is checked too.

**The estimate** (`mechanics/combat/balance.js`). Before the preview, the
fight is played out locally 120 times with everyone, the player included,
on the local tactics, the party at full HP and END (the budget is about the
encounter, not your current wounds). It uses a seeded RNG, so the same
encounter always gets the same number. The preview shows it: "Estimated
chance to win: 65%". Real play usually does better than the automatic
tactics.

**The target** (Settings → Character Sheet → *Keep encounters winnable*,
*Target chance to win*, default 65%). When the estimate is below it, in
this order, re-estimating after each step:

1. **Swarms.** Tiny creatures (`size: "tiny"`: cat-sized or smaller, such as
   rats, bats, insects, crows) in groups of three or more of the same kind
   fight as one swarm. Goblin-sized and bigger never swarm. The AI can also
   ask for one with `"count": N` on a tiny creature. Swarms are formed even
   when the encounter is already within the target.
2. **Reserves.** The strongest enemy always starts. Others are held back,
   weakest first, until the estimate reaches the target. A held-back enemy
   joins the fight whenever someone on its side falls, so the number of
   enemies acting at once stays the same.
3. **Shrinking swarms,** never below three.
4. **Leaving out reserves,** last first: they hang back, are elsewhere or
   flee at once (the narration is told).

A single enemy is never weakened here; its tier budget already caps it. A
lone boss stays a party-sized threat. With balancing off, only the AI's own
`count`, `size` and `reserve` marks are used.

**Swarm rules** (`SWARM` in `engine.js`). One combatant that acts once per
phase, on the member's stat block, with all the members' HP pooled. Members
are lost as HP drops (each member's worth of HP is one member). The first
damage effect of each attack gets +½ die per member alive beyond the first
(six rats: +2 dice). Area attacks (all enemies, everyone) do ×1.5 damage to
a swarm. EXP: each member is worth half a normal enemy of its tier.

**The prompt.** The AI is told what a fair fight is (about one elite, one
or two standard enemies, or a leader with two or three minions), to use
`"count"` for several of the same kind, `"size"`, and `"reserve": true`
for extras the story calls for. `count` on anything bigger than tiny is
just that many copies.

**Numbers at level 1** (example 50 CP character, automatic tactics):

| Encounter | Before | After |
|---|---|---|
| 6 rats (minion, tiny) | 0% | one swarm of 6, ~65% |
| 6 goblins (minion) | 0% | 1 fighting, 3 waiting, 2 left out, ~70% |
| 2 standard bandits | ~3% | 1 fighting, 1 left out, ~80% |
| goblin chief (elite) + 4 goblins | 0% | the chief alone, ~40–50% |

## Power level

The tier budgets in §7 were tuned for a 50 CP character, which turned out
to feel weak at level 1: one ordinary enemy at 77%, two at 3%, an elite at
45%. Fine for a world where fights are dangerous, too harsh for a solo
hero. So the player's starting pool and the world's are separate settings:

- **World pool** (`worldPool`, 50): enemies and NPC allies are built on
  `worldPool + points per level × (level − 1)`, times their tier.
- **Power level** (`powerPreset`): sets the player's starting pool and the
  AP guide base. Editing either by hand makes it Custom.

| Preset | Starting CP | AP guide at level 1 |
|---|---|---|
| Gritty | 50 | 30 |
| **Heroic** (default) | 100 | 40 |
| Legendary | 150 | 50 |

Simulated at level 1 against the default enemies (automatic tactics on
both sides, 300 fights each):

| Character | 1 standard | 2 standard | elite | boss | 3 minions | level 3 elite |
|---|---|---|---|---|---|---|
| Gritty 50 (the §7 example) | 77% | 3% | 45% | 1% | 23% | 9% |
| Heroic 100, mixed (24 CP of skills, attack, heal, area) | 96% | 45% | 82% | 27% | 82% | 46% |
| Heroic 100, all-in fighter | 100% | 93% | 100% | 88% | 99% | 96% |
| Legendary 150, mixed | 100% | 100% | 100% | 96% | 100% | 99% |

How a character spends the points matters a lot (pool pricing makes a
focused attacker very strong), so the presets set the budget, not an exact
difficulty. The encounter check ("Encounter difficulty") still catches fights
that are too much.

An existing install whose starting pool and AP guide were the old defaults
(50 / 25) moves to Heroic (settings version 8), which leaves 50 CP unspent
on existing characters; customised values become Custom.

## Decisions

1. **Elements:** both sets: fire, water, earth, air, ice, lightning, plus
   poison.
2. **Level vs power:** option (a). CP per level is now 5 by default, so
   level 5 is about +40% over level 1, and level 10 about ×1.9.
3. **NPC allies:** local tactics by default, with a per-ally "I control this
   one" checkbox.
4. **Energy:** END maps to the tracker's Energy bar when one exists. A real
   basis for the Energy value comes later.
