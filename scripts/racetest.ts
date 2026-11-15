// Headless check of race mode: practise, then run full races and see that they finish sensibly.
import { generateTrack, StyleId } from '../src/track';
import { Trainer, DEFAULT_AI } from '../src/sim';
import { CAR_CLASSES, CarId } from '../src/cars';
import { Surface, Env } from '../src/weather';
import { Race, RaceOpts } from '../src/race';

let fail = 0;
function go(seed: number, style: StyleId, car: CarId, opts: RaceOpts, verbose = false) {
  const env: Env = { time: 13, weather: 'dry', intensity: 0 };
  const track = generateTrack(seed, style), cls = CAR_CLASSES[car];
  const surf = new Surface(track, env);
  const tr = new Trainer(track, cls.setup, cls, DEFAULT_AI, surf, cls.tyre);
  // practise for 70 generations, or longer if nobody has completed a lap yet
  while (tr.generation <= 70 || (!tr.hall.length && tr.generation <= 260)) tr.step();
  if (!tr.hall.length) { console.log('no brain'); fail++; return; }
  const race = new Race(track, cls, cls.setup, tr.hall, DEFAULT_AI.hidden, DEFAULT_AI.vision, surf, env, opts, seed);
  race.start();
  let ticks = 0;
  const t0 = performance.now();
  while (race.phase !== 'done' && ticks < 60 * 60 * 40) {
    race.step(); ticks++;
    // a simple player strategy so the player car is exercised too
    const p = race.player;
    if (race.phase === 'racing' && ticks % 120 === 0 && !p.boxCall && !p.pit) {
      const w = surf.lineWater();
      const cur = p.car.tyre.id, rain = cur === 'inter' || cur === 'wet';
      if (w > 0.3 && !rain) race.callBox(w > 0.6 ? 'wet' : 'inter');
      else if (w < 0.1 && rain) race.callBox('medium');
      else if (p.car.wear > 0.7) race.callBox(rain ? cur : 'hard');
      else if (opts.laps >= 6 && p.used.length < 2 && p.lap >= Math.floor(opts.laps / 2) && !rain) race.callBox(cur === 'medium' ? 'hard' : 'medium');
    }
  }
  const ms = performance.now() - t0;
  const fin = race.results.filter((r) => r.e.finished).length, dnf = race.results.filter((r) => r.e.dnf).length;
  const passes = race.events.filter((e) => e.kind === 'pass').length, pits = race.entries.reduce((s, e) => s + e.stops, 0), offs = race.entries.reduce((s, e) => s + e.offs, 0);
  const ok = race.phase === "done" && fin >= 4;
  if (!ok) fail++;
  console.log(`${style} ${car} ${opts.laps} laps diff ${opts.difficulty} ${opts.forecast}: ${race.phase} in ${(race.time).toFixed(0)}s race time (${ms.toFixed(0)}ms) | finished ${fin} dnf ${dnf} | stops ${pits} offs ${offs} | player P${race.results.find((r) => r.e.isPlayer)!.pos} from grid ${race.player.grid + 1} | fastest ${race.fastest?.lap.toFixed(2)} vs practice ${tr.hall[0].lap.toFixed(2)} ${ok ? 'OK' : 'FAIL'}`);
  if (verbose) {
    for (const r of race.results) console.log(`  P${r.pos} ${r.e.team.short} grid ${r.e.grid + 1} laps ${r.e.lap} ${r.time ? r.time.toFixed(1) + 's' : '-'} best ${r.e.bestLap?.toFixed(2)} stops ${r.e.stops} tyres ${r.e.used.join('>')} offs ${r.e.offs} dmg ${r.e.car.damage.toFixed(2)} pts ${r.points} ${r.note}`);
    console.log('  spells', race.spells.map((s) => `${s.kind}@${Math.max(0, s.t0).toFixed(0)}`).join(' '));
    for (const e of race.events.slice(-14)) console.log(`   [${e.t.toFixed(0)}s ${e.kind}] ${e.text}`);
  }
}
const only = process.argv[2];
if (!only) go(2, 'speed', 'gt', { laps: 6, difficulty: 1, forecast: 'current', startTyre: 'medium' }, true);
if (!only) go(2, 'speed', 'gt', { laps: 8, difficulty: 1, forecast: 'changeable', startTyre: 'medium' }, true);
if (!only) go(3, 'technical', 'f1', { laps: 5, difficulty: 2, forecast: 'current', startTyre: 'soft' });
go(4, 'street', 'hatch', { laps: 4, difficulty: 0, forecast: 'current', startTyre: 'hard' });
if (!only) go(1, 'eight', 'proto', { laps: 5, difficulty: 1, forecast: 'changeable', startTyre: 'medium' });
process.exit(fail ? 1 : 0);
