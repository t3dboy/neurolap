// Headless check of manual control: a scripted "human" (follow the centreline) in a free session and a race.
import { generateTrack } from '../src/track';
import { Trainer, DEFAULT_AI } from '../src/sim';
import { CAR_CLASSES } from '../src/cars';
import { Surface, Env } from '../src/weather';
import { Race } from '../src/race';
const env: Env = { time: 13, weather: 'dry', intensity: 0 };
const track = generateTrack(2, 'speed'), cls = CAR_CLASSES.gt;
const surf = new Surface(track, env);
const tr = new Trainer(track, cls.setup, cls, DEFAULT_AI, surf, cls.tyre);
while (tr.generation <= 50) tr.step();
let fail = 0;
function human(r: Race) {
  const c = r.player.car, n = track.n, la = (c.idx + 14) % n;
  let e = Math.atan2(track.pz[la] - c.z, track.px[la] - c.x) - c.th;
  while (e > Math.PI) e -= 2 * Math.PI; while (e < -Math.PI) e += 2 * Math.PI;
  let k = 0; for (let i = 0; i < 45; i++) k = Math.max(k, Math.abs(track.curv[(c.idx + i) % n]));
  const vt = Math.min(45, Math.sqrt(9 / Math.max(0.004, k)));
  r.input.steer = Math.max(-1, Math.min(1, e * 2.2 * (1 + c.vf / 28)));
  r.input.thr = c.vf < vt ? 1 : -0.8;
}
for (const free of [true, false]) {
  const r = new Race(track, cls, cls.setup, tr.hall, DEFAULT_AI.hidden, DEFAULT_AI.vision, surf, env, { laps: free ? 1e6 : 3, difficulty: 1, forecast: 'current', startTyre: 'medium', manual: true, free }, 5);
  r.start();
  let t = 0;
  while (r.phase !== 'done' && t++ < 60 * 220) { human(r); r.step(); }
  const p = r.player;
  const ok = free ? p.lap >= 3 && r.entries.length === 4 : r.phase === 'done' && p.finished;
  if (!ok) fail++;
  console.log(`${free ? 'free session' : '3-lap race'}: cars ${r.entries.length} | player laps ${p.lap} best ${p.bestLap?.toFixed(2)} (AI ${tr.hall[0].lap.toFixed(2)}) offs ${p.offs} pos ${p.pos} phase ${r.phase} ${ok ? 'OK' : 'FAIL'}`);
}
// nobody at the controls: the car must simply sit there, not crash the sim
const r = new Race(track, cls, cls.setup, [], DEFAULT_AI.hidden, DEFAULT_AI.vision, surf, env, { laps: 1e6, difficulty: 1, forecast: 'current', startTyre: 'medium', manual: true, free: true }, 5);
for (let i = 0; i < 600; i++) r.step();
console.log(`no brains, no input: cars ${r.entries.length}, speed ${r.player.car.vf.toFixed(2)} ${r.entries.length === 1 && Math.abs(r.player.car.vf) < 0.5 ? 'OK' : 'FAIL'}`);
process.exit(fail ? 1 : 0);
