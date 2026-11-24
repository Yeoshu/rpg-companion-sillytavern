# Combat overhaul: design spec

Status: **draft for review**. Nothing here is built yet. Mark up anything you
want changed; open questions are collected at the end.

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
| **HP** | 10 + 2 × CON | 30 | 1 CP per 2 HP |
| **END** (Endurance) | 2 × CON | 20 | 1 CP per 2 END |
| **REC** (Recovery) | STR/5 + CON/5 | 4 | 2 CP per +1 |
| **OCV** (attack) | DEX/5 | 2 | 5 CP per +1 |
| **DCV** (defence) | DEX/5 | 2 | 5 CP per +1 |
| **PD** (physical defence) | STR/5 | 2 | 1 CP per +1 |
| **ED** (elemental defence) | CON/5 | 2 | 1 CP per +1 |
| **SPD** (actions per turn) | 1 + DEX/10 (rounded down) | 2 | 10 CP per +1 |
| **Unarmed damage** | STR/5 d6, blunt | 2d6 | through STR |

/5 values are rounded to the nearest whole number. SPD is capped at 12.

### Damage types and resistances

- **Physical:** blunt, pierce, slash. Reduced by **PD**.
- **Elemental:** fire, water, earth, air. Reduced by **ED**.

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
| **Damage** | dice (d6), flat bonus, damage type, *adds STR* (physical only: adds the user's unarmed STR dice at no cost, up to the ability's own dice, so STR can at most double it) | 5 per d6, 2 per +1 flat |
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

**Duration factor:** 1 + ¼ per phase after the first.

**Rules:**
- Durations count the **affected character's own phases**. An over-time
  status ticks at the start of each of them.
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
2. **Damage** = dice + flat (+ STR dice if the ability adds STR).
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
| **Strike** | Unarmed: STR/5 d6 blunt, attack roll, END 1 per 2d6 |
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

- Default starting pool: **50 CP**. That's enough for a couple of good
  attributes, two skills and two or three abilities.
- The sheet shows **spent / budget**. Unspent points replace today's CP
  counter, which becomes a computed number.
- Levelling still gives the CP per level, and spending works as now. In
  addition, abilities can be bought, and anything can be refunded.
- The budget is a **metric, not a lock**. Going over shows a warning, and an
  existing character above budget keeps everything.

**Active Point cap:** a warning when one ability's AP exceeds
**25 + 5 × level** (30 at level 1: a 6d6 attack). It's a guide, not a limit.

### Example level 1 build (48 / 50 CP)

| | Cost | Effects |
|---|---|---|
| STR 13, DEX 15, CON 12 | 10 | |
| Stealth +2, Athletics +1 | 6 | |
| Twin Daggers | 13 | 2d6 slash + STR (capped at +2d6) = 4d6, OCV +1 |
| Fire Bolt | 20 | 4d6 fire |

Derived values: HP 34, END 24, REC 5, OCV 3, DCV 3, PD 3, ED 2, SPD 2.

### Enemies

The AI gives each enemy a level and a **tier**. Their budget is the budget of
that level × the tier's multiplier, and the tier scales their HP:

| Tier | Budget | HP | Meant as |
|---|---|---|---|
| Minion | ×0.4 | ×0.5 | Fodder, comes in groups |
| Standard | ×0.8 | ×1 | A fair fight in pairs |
| Elite | ×1.2 | ×1.5 | A fair fight alone |
| Boss | ×2 | ×3 | Fights a whole party |

The EXP reward also gets the tier's HP multiplier (minion ×0.5 … boss ×3).

**Checking the AI's stat blocks:**
- The extension computes the points of every stat block the AI writes.
- Over budget by more than 25%: damage dice and bought values are scaled
  down, and the enemy is marked "adjusted".
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
   and Energy. Named NPCs keep their HP between fights (stored on their stat
   block, reset by Rest or by editing).

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

## Open questions

1. **Elements.** I used the classical four (fire, water, earth, air). Would
   you rather have fire, ice and lightning (plus poison?), or both sets?
2. **Level vs power.** With 50 CP to start and 3 CP per level, a level 5
   character is only about 25% stronger than a level 1 one, while the EXP
   curve pays ×2.9 for an enemy 4 levels up. Options:
   - **(a)** raise CP per level to 5: level 5 ≈ +40%, level 10 ≈ ×1.9
   - **(b)** lower the starting pool to 35
   - **(c)** leave it: level matters little, and points matter more

   My pick is (a).
3. **NPC allies.** Local tactics by default, with a per-ally "I control
   this one" checkbox. Is that right, or should you control all allies by
   default?
4. **Energy.** Should END map to the tracker's Energy bar, when one exists?
   That's my assumption here.
