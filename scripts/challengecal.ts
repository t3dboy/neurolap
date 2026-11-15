// Sets a fair target for each setup challenge: train the standard car for a long time, then
// several ways of spending the parts budget, and put the target between the two.
// Usage: npx tsx scripts/challengecal.ts <challenge id>
import { generateTrack } from '../src/track';
import { Trainer, DEFAULT_AI, Setup } from '../src/sim';
import { CAR_CLASSES } from '../src/cars';
import { Surface, Env } from '../src/weather';
import { CHALLENGES, partsCost } from '../src/challenges';

const id = process.argv[2];
const ch = CHALLENGES.find((c) => c.id === id)!;
const GENS = Number(process.env.GENS ?? (ch.style === 'endurance' ? 160 : 220));
const cls = CAR_CLASSES[ch.car], base = cls.setup;
const env: Env = { time: 13, weather: ch.weather ?? 'dry', intensity: ch.intensity ?? 0 };
const tyre = ch.weather === 'rain' ? 'inter' : cls.tyre;

function train(s: Setup): number {
  const track = generateTrack(ch.seed, ch.style);
  const surf = new Surface(track, env);
  if (env.weather !== 'dry') surf.settle();
  const tr = new Trainer(track, s, cls, DEFAULT_AI, surf, tyre);
  while (tr.generation <= GENS) tr.step();
  return tr.setupBest ?? Infinity;
}
// how to turn parts into setup: [key, unit, price, direction, step]
const P: [keyof Setup, number, number, number, number][] = [
  ['power', base.power * 0.05, 1, 1, 10], ['grip', 0.05, 1.5, 1, 0.05], ['downforce', 0.2, 1, 1, 0.1], ['mass', base.mass * 0.025, 1, -1, 10], ['brakes', 0.15, 0.5, 1, 0.05],
];
function spend(w: number[]): Setup {
  const s = { ...base }, tot = w.reduce((a, b) => a + b, 0);
  P.forEach(([k, unit, price, dir, step], i) => {
    const parts = (ch.budget * w[i]) / tot;
    s[k] = Math.round((base[k] + (dir * parts * unit) / price) / step) * step;
  });
  // rounding can tip it over budget: walk back power until it fits
  while (partsCost(s, base) > ch.budget) s.power -= 10;
  return s;
}
const plans: [string, number[]][] = [
  ['power', [1, 0, 0, 0, 0]], ['grip', [0, 1, 0, 0, 0]], ['power+grip', [1, 1, 0, 0, 0]],
  ['grip+brakes', [0, 1, 0, 0, 1]], ['aero+grip', [0, 1, 1, 0, 0]], ['weight+power', [1, 0, 0, 1, 0]], ['spread', [1, 1, 1, 1, 1]],
];
// earlier runs showed power alone and weight alone never win: keep the plans worth training
plans.splice(0, plans.length, ['grip', [0, 1, 0, 0, 0]], ['power+grip', [1, 1, 0, 0, 0]], ['aero+grip', [0, 1, 1, 0, 0]], ['spread', [1, 1, 1, 1, 1]]);
if (ch.style === 'endurance') plans.splice(2, 1);
const std = train(base);
console.log(`${id}: standard ${std.toFixed(2)}s`);
let best = Infinity, bestName = '';
for (const [name, w] of plans) {
  const s = spend(w), lap = train(s);
  console.log(`  ${name.padEnd(13)} cost ${partsCost(s, base).toFixed(1)} lap ${lap.toFixed(2)}s`);
  if (lap < best) { best = lap; bestName = name; }
}
const target = Math.round((best + 0.4 * (std - best)) * 10) / 10;
console.log(`RESULT ${id} std ${std.toFixed(2)} best ${best.toFixed(2)} (${bestName}) target ${target.toFixed(1)}`);
