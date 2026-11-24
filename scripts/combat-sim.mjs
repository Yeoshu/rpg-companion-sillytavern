// Balance simulation for the combat engine (all combatants use the local tactics).
import { normalizeStatBlock, BUYABLE, TIERS } from '../src/systems/mechanics/combat/catalog.js';
import { statBlockPoints } from '../src/systems/mechanics/combat/costs.js';
import { createCombat, advance, act } from '../src/systems/mechanics/combat/engine.js';
import { chooseAction } from '../src/systems/mechanics/combat/tactics.js';
const lem = () => normalizeStatBlock({ name: 'Lem', attributes: { str: 13, dex: 15, con: 12 }, skills:{stealth:2,athletics:1}, bought: { pd: 1, ed: 1 },
  abilities: [{ name: 'Fire Bolt', effects: [{ type: 'damage', dice: 5, damageType: 'fire' }] },
              { name: 'Twin Daggers', effects: [{ type: 'damage', dice: 2, damageType: 'slash', addStr: true }], advantages: [{ id: 'accurate', levels: 1 }] }] });
// Enemy on a budget: 35% attributes, 45% attack dice, 20% defences (fractional parts averaged by mixing).
function build(name, tier, budget, k) {
  const a = budget * 0.35, dice = budget * 0.45 / 5, def = budget * 0.2 / BUYABLE.pd.cost;
  const r = v => Math.floor(v) + ((k * 0.618) % 1 < v % 1 ? 1 : 0);
  return normalizeStatBlock({ name, tier, attributes: { str: 10 + r(a / 3), dex: 10 + r(a / 3), con: 10 + r(a / 3) },
    bought: { pd: r(def / 2), ed: r(def / 2) },
    abilities: [{ name: 'Claw', effects: [{ type: 'damage', dice: Math.max(1, r(dice)), damageType: 'slash', addStr: true }] }] });
}
function run(count, tier, budget, N = 300) {
  let wins = 0, ph = 0, pts = 0;
  for (let n = 0; n < N; n++) {
    const es = Array.from({ length: count }, (_, i) => build('E' + i, tier, budget, n * count + i));
    pts += statBlockPoints(es[0]).total;
    const s = createCombat([{ block: lem(), side: 'party', isPlayer: true }, ...es.map(b => ({ block: b, side: 'enemies' }))]);
    let p = 0;
    while (!s.over) { const id = advance(s); if (!id) break; if (id === 'c1') p++; act(s, chooseAction(s, id)); }
    if (s.result === 'victory') wins++; ph += p;
  }
  return `${(wins / N * 100).toFixed(0).padStart(3)}% (${(ph / N).toFixed(1)} ph, ~${(pts / N).toFixed(0)}pt)`;
}
const pool = 50; console.log('Lem pts', statBlockPoints(lem()).total);
// Usage: node scripts/combat-sim.mjs
// Win rate of the 50 CP example build (docs/COMBAT_DESIGN.md §7) against
// auto-built enemies at each tier's default budget, and at other multipliers.
for (const m of [0.3, 0.4, 0.45, 0.5, 0.6, 0.7, 0.8, 1]) {
  const b = pool * m;
  console.log(String(m).padEnd(4), '| 1 std', run(1, 'standard', b), '| 2 std', run(2, 'standard', b), '| 3 min', run(3, 'minion', b), '| elite', run(1, 'elite', b), '| boss', run(1, 'boss', b));
}
