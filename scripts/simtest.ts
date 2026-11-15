// Headless check: every track style generates, every car class learns to lap, weather behaves.
import { generateTrack, STYLE_IDS, StyleId } from '../src/track';
import { Trainer, DEFAULT_AI } from '../src/sim';
import { CAR_CLASSES, CAR_IDS, CarId } from '../src/cars';
import { Surface, Env, TyreId } from '../src/weather';

const GENS = Number(process.env.GENS ?? 100);
let fail = 0;
function run(seed: number, style: StyleId, car: CarId, env: Env, tyre?: TyreId, settle = false) {
  const track = generateTrack(seed, style);
  const cls = CAR_CLASSES[car];
  const surf = new Surface(track, env);
  if (settle) surf.settle();
  const tr = new Trainer(track, cls.setup, cls, DEFAULT_AI, surf, tyre ?? cls.tyre);
  let first = -1, ticks = 0;
  const t1 = performance.now();
  while (tr.generation <= GENS) {
    ticks++;
    if (tr.step()) { const h = tr.history[tr.history.length - 1]; if (h.bestLap !== null && first < 0) first = h.gen; }
  }
  const ms = performance.now() - t1;
  return { track, tr, first, rate: ticks / (ms / 1000) / 60, surf };
}
const dry: Env = { time: 13, weather: 'dry', intensity: 0 };
const only = process.argv[2];

if (!only || only === 'styles') {
  console.log('--- every style, GT car, dry ---');
  for (const style of STYLE_IDS) for (const seed of [1, 2, 3]) {
    const r = run(seed, style, 'gt', dry);
    const ok = r.tr.recordLap !== null; if (!ok) fail++;
    console.log(`${style.padEnd(10)} seed ${seed} ${r.track.name.padEnd(28)} ${r.track.length.toFixed(0).padStart(5)}m | first lap gen ${String(r.first).padStart(3)} | best ${r.tr.recordLap?.toFixed(2) ?? '-'}s ${r.tr.recordLap ? ((r.track.length / r.tr.recordLap) * 3.6).toFixed(0) : '-'} km/h | hall ${r.tr.hall.length} | ${r.rate.toFixed(0)}x ${ok ? 'OK' : 'FAIL'}`);
  }
}
if (only === 'street') {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const r = run(seed, 'street', 'gt', dry);
    const ok = r.tr.recordLap !== null; if (!ok) fail++;
    console.log(`street seed ${seed} ${r.track.length.toFixed(0)}m first lap gen ${r.first} best ${r.tr.recordLap?.toFixed(2) ?? '-'}s ${ok ? 'OK' : 'FAIL'}`);
  }
}
if (!only || only === 'cars') {
  console.log('--- every car, two tracks, dry ---');
  for (const car of CAR_IDS) for (const [seed, style] of [[2, 'speed'], [3, 'technical']] as [number, StyleId][]) {
    const r = run(seed, style, car, dry);
    const ok = r.tr.recordLap !== null; if (!ok) fail++;
    let top = 0; for (const c of r.tr.cars) top = Math.max(top, c.topSpeed);
    console.log(`${CAR_CLASSES[car].name.padEnd(18)} ${style.padEnd(10)} first lap gen ${String(r.first).padStart(3)} | best ${r.tr.recordLap?.toFixed(2) ?? '-'}s | top ${(top * 3.6).toFixed(0)} km/h ${ok ? 'OK' : 'FAIL'}`);
  }
}
if (!only || only === 'weather') {
  console.log('--- weather, GT car, speed track seed 2 ---');
  const cases: [string, Env, TyreId][] = [
    ['dry / medium', dry, 'medium'],
    ['rain / medium', { time: 13, weather: 'rain', intensity: 0.8 }, 'medium'],
    ['rain / wet', { time: 13, weather: 'rain', intensity: 0.8 }, 'wet'],
    ['snow / medium', { time: 13, weather: 'snow', intensity: 0.8 }, 'medium'],
    ['snow / winter', { time: 13, weather: 'snow', intensity: 0.8 }, 'winter'],
  ];
  const laps: number[] = [];
  for (const [name, env, tyre] of cases) {
    const r = run(2, 'speed', 'gt', env, tyre, true);
    laps.push(r.tr.recordLap ?? 999);
    console.log(`${name.padEnd(16)} best ${r.tr.recordLap?.toFixed(2) ?? '-'}s | line water ${r.surf.lineWater().toFixed(2)} snow ${r.surf.lineSnow().toFixed(2)}`);
  }
  const ok = laps[0] < laps[2] && laps[2] < laps[1] && laps[4] < laps[3];
  console.log(`dry < wet tyres in rain < slicks in rain, winter beats slicks on snow: ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) fail++;
}
process.exit(fail ? 1 : 0);
