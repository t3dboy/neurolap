import { mulberry32, gauss, Rng } from './rng';
import { Track, distAt, idxAt, rayToEdge, heightAtS } from './track';
import { Setup, CarClass, CAR_CLASSES } from './cars';
import { Surface, TyreDef, TYRES, TyreId } from './weather';

export type { Setup } from './cars';
export const DEFAULT_SETUP: Setup = { ...CAR_CLASSES.gt.setup };

export interface AiConfig {
  population: number;
  mutation: number;   // weight noise sigma
  vision: number;     // sensor range in m
  hidden: number;     // hidden neurons
}
export const DEFAULT_AI: AiConfig = { population: 48, mutation: 0.14, vision: 70, hidden: 10 };

const G = 9.81;
const WHEELBASE = 2.6, AX_A = 1.17, AX_B = 1.43; // weight sits a little forward: stable by default
export const DT = 1 / 60;
const SUB = 2;
export const SPAWN_BACK = 45; // cars start this far before the line, so the lap is a flying lap
export const RAY_ANGLES = [-90, -60, -35, -15, 0, 15, 35, 60, 90].map((d) => (d * Math.PI) / 180);
export const N_RAYS = RAY_ANGLES.length;
const NOTES = [15, 35, 60]; // pace notes: curvature this many metres ahead
// rays, speed, slide, spin, bends ahead, slope here, crest/dip ahead, grip under the tyres
export const N_IN = N_RAYS + 3 + NOTES.length + 3;
// which inputs flip sign when the view is mirrored left-to-right (rays are reversed instead)
const MIRROR_SIGN = [...Array(N_RAYS).fill(1), 1, -1, -1, ...NOTES.map(() => -1), 1, 1, 1];
export const N_OUT = 2;
export const PATH_MAX = 3600;
const FIT_P = 0.7;

export interface Derived {
  mass: number; iz: number; powerW: number; muF: number; muR: number;
  dfK: number; drag: number; brakeF: number; lock: number; aids: number; offroad: number;
  cg: number; sW: number; sZ: number; rollK: number; pitchK: number; // suspension
}
export function derive(s: Setup, cls: CarClass, powerMul = 1, gripMul = 1): Derived {
  return {
    mass: s.mass,
    iz: s.mass * 1.45,
    powerW: s.power * 1000 * powerMul,
    muF: s.grip * gripMul * (1 + 0.12 * s.balance),
    muR: s.grip * gripMul * (1 - 0.12 * s.balance),
    dfK: s.downforce * 1.2,
    drag: 0.55 + 0.24 * s.downforce,
    brakeF: s.brakes * G * s.mass,
    lock: (s.steer * Math.PI) / 180,
    aids: s.aids,
    offroad: cls.offroad,
    cg: cls.susp.cg, sW: cls.susp.freq * 2 * Math.PI, sZ: cls.susp.damp,
    rollK: (cls.susp.roll * Math.PI) / 180 / G, pitchK: (cls.susp.pitch * Math.PI) / 180 / G,
  };
}

export class Car {
  x = 0; z = 0; th = 0;
  vf = 0; vl = 0; w = 0;
  steer = 0; steerCmd = 0; thr = 0; target = 0;
  alive = true; finished = false; crashed = false;
  idx = 0; y = 0; lat = 0; dist = 0;
  total = 0; prevTotal = 0; lastS = 0; mark = 0; stallT = 0;
  lapStart = -1; lapTime = 0;
  fitness = 0; topSpeed = 0; endTime = 0;
  elite = false;
  // conditions and racecraft, set by whoever is running the car
  tyre: TyreDef = TYRES.medium;
  wear = 0;          // 0 fresh .. 1 finished
  damage = 0;        // 0 fine .. 1 wrecked
  grip = 1;          // grip multiplier under the tyres right now
  pace = 1;          // scales the speed the brain asks for
  bias = 0;          // metres: makes the brain believe it is this far to the right, so it moves left
  cap = Infinity;    // speed limit imposed from outside (traffic, pit lane)
  braking = false;
  // a human at the controls: steering and pedals come from the player instead of a brain
  manual = false; inSteer = 0; inThr = 0;
  // the body on its springs: accelerations as the suspension passes them on (it lags and overshoots), and what the body does
  aLong = 0; aLongV = 0; aLat = 0; aLatV = 0;
  roll = 0; pitch = 0; heave = 0; heaveV = 0; spin = 0;
  sensors = new Float32Array(N_IN);
  hiddenAct = new Float32Array(32);
  path = new Float32Array(PATH_MAX * 3); pathN = 0;
}

/** Put a car on the centreline at s metres from the start line, lateral offset lat, at rest. */
export function placeCar(c: Car, t: Track, s: number, lat = 0) {
  const i = (((Math.round(s / t.ds) % t.n) + t.n) % t.n) | 0;
  c.x = t.px[i] - t.tz[i] * lat; c.z = t.pz[i] + t.tx[i] * lat; c.th = Math.atan2(t.tz[i], t.tx[i]);
  c.vf = 0; c.vl = 0; c.w = 0; c.steer = 0; c.steerCmd = 0; c.thr = 0; c.target = 0;
  c.idx = i; c.y = t.h[i]; c.lat = lat; c.dist = Math.abs(lat);
  c.total = s; c.prevTotal = s; c.lastS = i * t.ds; c.mark = s; c.stallT = 0;
  c.bias = 0; c.cap = Infinity; c.braking = false;
  c.aLong = 0; c.aLongV = 0; c.aLat = 0; c.aLatV = 0; c.roll = 0; c.pitch = 0; c.heave = 0; c.heaveV = 0;
}

const scratchH = new Float32Array(32), mirror = new Float32Array(N_IN);

/** Read the car's sensors and run its brain: sets steerCmd and the speed it wants (target). */
export function think(c: Car, g: Float32Array, H: number, t: Track, vision: number) {
  const inp = c.sensors, ci = c.idx;
  // racecraft can nudge the car sideways by lying to it about where it is on the road
  const ox = c.x + t.tz[ci] * c.bias, oz = c.z - t.tx[ci] * c.bias;
  for (let k = 0; k < N_RAYS; k++) {
    const a = c.th + RAY_ANGLES[k];
    inp[k] = rayToEdge(t, ox, oz, Math.cos(a), Math.sin(a), vision, ci) / vision;
  }
  inp[N_RAYS] = c.vf / 60;
  inp[N_RAYS + 1] = c.vl / 10;
  inp[N_RAYS + 2] = c.w / 2;
  for (let k = 0; k < NOTES.length; k++) {
    const j = (ci + Math.round(NOTES[k] / t.ds)) % t.n;
    inp[N_RAYS + 3 + k] = t.curv[j] * 15;
  }
  inp[N_RAYS + 3 + NOTES.length] = t.slope[ci] * 8;
  inp[N_RAYS + 4 + NOTES.length] = t.vcurv[(ci + Math.round(20 / t.ds)) % t.n] * 150;
  inp[N_RAYS + 5 + NOTES.length] = (c.grip - 1) * 2;
  // The brain is run twice, on the real view and on its mirror image, and the two
  // answers are combined so that it steers symmetrically: what it learns in a left
  // turn it knows for a right turn.
  const m = mirror;
  for (let k = 0; k < N_RAYS; k++) m[k] = inp[N_RAYS - 1 - k];
  for (let k = N_RAYS; k < N_IN; k++) m[k] = inp[k] * MIRROR_SIGN[k];
  const h = c.hiddenAct, h2 = scratchH;
  let p = 0;
  for (let j = 0; j < H; j++) {
    let s = g[p + N_IN], s2 = s;
    for (let k = 0; k < N_IN; k++) { s += g[p + k] * inp[k]; s2 += g[p + k] * m[k]; }
    h[j] = Math.tanh(s); h2[j] = Math.tanh(s2);
    p += N_IN + 1;
  }
  let s0 = g[p + H], s1 = g[p + H + 1 + H], m0 = s0, m1 = s1;
  for (let j = 0; j < H; j++) {
    s0 += g[p + j] * h[j]; s1 += g[p + H + 1 + j] * h[j];
    m0 += g[p + j] * h2[j]; m1 += g[p + H + 1 + j] * h2[j];
  }
  c.steerCmd = Math.tanh((s0 - m0) * 0.5);
  // The second output is the speed the brain wants on a grippy road. Cornering speed goes
  // with the square root of grip, so the wish is scaled for the road actually under the
  // tyres: a brain that learned in the dry still knows to slow down in the wet.
  const gr = c.grip < 0.15 ? 0.15 : c.grip > 1.3 ? 1.3 : c.grip;
  c.target = (35 + 35 * Math.tanh((s1 + m1) * 0.5)) * Math.sqrt(gr) * c.pace;
}

function physics(c: Car, s: Derived, t: Track, dt: number, gripMul: number, off: boolean) {
  const v = Math.hypot(c.vf, c.vl);
  // hills: gravity pulls the car down the slope; dips press it into the road, crests make it light
  const slope = t.slope[c.idx], co0 = Math.cos(c.th), si0 = Math.sin(c.th);
  const along = co0 * t.tx[c.idx] + si0 * t.tz[c.idx], across = -si0 * t.tx[c.idx] + co0 * t.tz[c.idx];
  const N = Math.max(0.15 * s.mass * G, s.mass * (G + v * v * along * along * t.vcurv[c.idx])) + s.dfK * v * v;
  // Weight transfer. Braking throws load onto the front tyres and accelerating onto the rear,
  // by as much as the springs have let through so far and the height of the centre of gravity
  // allows. In a corner the outer tyres take more than their share, and a tyre asked to carry
  // more grips a little less for it, so tall soft cars lose more grip than low stiff ones.
  // Stability control (driver aids) brakes individual wheels to cancel part of the effect.
  const felt = 0.6 * (1 - 0.5 * s.aids);
  const shift = (felt * s.mass * c.aLong * s.cg) / WHEELBASE;
  let Nf = (N * AX_B) / WHEELBASE - shift;
  Nf = Nf < N * 0.12 ? N * 0.12 : Nf > N * 0.88 ? N * 0.88 : Nf;
  const Nr = N - Nf;
  const gl = c.aLat / G, lose = 1 - felt * 0.05 * Math.min(2.5, gl * gl) * (s.cg / 0.45);
  const muF = s.muF * gripMul * lose, muR = s.muR * gripMul * lose;
  const dir = c.vf >= 0 ? 1 : -1;
  const delta = (c.steer * s.lock) / (1 + v / 28);
  const vfa = Math.max(Math.abs(c.vf), 4);
  const af = Math.atan2(c.vl + c.w * AX_A, vfa) - delta * dir;
  const ar = Math.atan2(c.vl - c.w * AX_B, vfa);
  let Fx = 0, usedR = 0, usedAll = 0;
  if (c.thr > 0) {
    const lim = muR * Nr;
    let thr = c.thr;
    // stability control: ease off the power when the rear starts to slide
    const slide = Math.abs(ar) - 0.07;
    if (slide > 0) thr *= 1 - s.aids * Math.min(1, slide / 0.08);
    let f = (thr * s.powerW) / Math.max(v, 6);
    // traction control: how much of the rear tyres' grip the engine may use up
    const cap = lim * (0.95 - 0.45 * s.aids);
    if (f > cap) f = cap;
    Fx = f; usedR = f / lim;
  } else if (c.thr < 0) {
    const lim = muF * Nf + muR * Nr;
    let f = -c.thr * s.brakeF;
    if (f > lim * 0.92) f = lim * 0.92;
    usedAll = f / lim;
    Fx = Math.abs(c.vf) > 0.4 ? -f * dir : 0;
  }
  const latF = Math.sqrt(1 - usedAll * usedAll);
  const uR = usedR > usedAll ? usedR : usedAll;
  const latR = Math.sqrt(1 - uR * uR);
  const FyF = -muF * Nf * latF * Math.sin(1.25 * Math.atan(14 * af));
  const FyR = -muR * Nr * latR * Math.sin(1.25 * Math.atan(14 * ar));
  const cd = Math.cos(delta), sd = Math.sin(delta);
  let ax = (Fx - FyF * sd) / s.mass + c.w * c.vl - G * slope * along;
  let ay = (FyF * cd + FyR) / s.mass - c.w * c.vf - G * slope * across;
  if (v > 0.05) {
    const dr = ((s.drag * v * v + 180) / s.mass + (off ? 3.5 : 0)) * Math.min(1, v);
    ax -= (dr * c.vf) / v; ay -= (dr * c.vl) / v;
  }
  const wd = (AX_A * FyF * cd - AX_B * FyR) / s.iz;
  c.vf += ax * dt; c.vl += ay * dt; c.w += wd * dt;
  c.th += c.w * dt;
  const co = Math.cos(c.th), si = Math.sin(c.th);
  c.x += (c.vf * co - c.vl * si) * dt;
  c.z += (c.vf * si + c.vl * co) * dt;
}

/** One tick of driving: work the pedals towards the wanted speed, turn the wheel, move the car. */
export function drive(c: Car, d: Derived, t: Track, surf: Surface) {
  if (c.manual) {
    // pedals ease in over a moment, so a keyboard is not all-or-nothing
    const wantT = c.cap < Infinity && c.vf > c.cap ? -0.5 : c.inThr, dT = wantT - c.thr, mx = (wantT < c.thr ? 9 : 5) * DT;
    c.thr += dT > mx ? mx : dT < -mx ? -mx : dT;
    c.steerCmd = c.inSteer; c.target = c.vf;
  } else {
    const want = c.target < c.cap ? c.target : c.cap;
    const e = (want - c.vf) * 0.5;
    c.thr = e > 1 ? 1 : e < -1 ? -1 : e;
  }
  c.braking = c.thr < -0.15;
  const ds = c.steerCmd - c.steer, maxD = 7 * DT;
  c.steer += ds > maxD ? maxD : ds < -maxD ? -maxD : ds;
  const off = c.dist > t.hw;
  const mul = off ? surf.offGrip(d.offroad) * (c.grip < 1 ? 0.6 + 0.4 * c.grip : 1) : c.grip;
  const vf0 = c.vf, vl0 = c.vl;
  for (let k = 0; k < SUB; k++) physics(c, d, t, DT / SUB, mul, off);
  // suspension: the body follows what the tyres do like a mass on a damped spring
  let aLo = (c.vf - vf0) / DT - c.w * c.vl, aLa = (c.vl - vl0) / DT + c.w * c.vf;
  aLo = aLo > 45 ? 45 : aLo < -45 ? -45 : aLo; aLa = aLa > 45 ? 45 : aLa < -45 ? -45 : aLa;
  const w0 = d.sW, w2 = w0 * w0, dz = 2 * d.sZ * w0;
  c.aLongV += (w2 * (aLo - c.aLong) - dz * c.aLongV) * DT; c.aLong += c.aLongV * DT;
  c.aLatV += (w2 * (aLa - c.aLat) - dz * c.aLatV) * DT; c.aLat += c.aLatV * DT;
  c.pitch = d.pitchK * c.aLong;   // + nose up: squat under power, dive under brakes
  c.roll = -d.rollK * c.aLat;     // + leaning left: the body leans out of the corner
  // ride height: pressed down in dips and by downforce, light over crests, shaken by kerbs and grass
  const v2 = c.vf * c.vf;
  let rest = -(v2 * t.vcurv[c.idx] + (d.dfK * v2) / d.mass) / w2;
  if (off) rest += 0.05 * Math.sin(c.total * 2.1) + 0.03 * Math.sin(c.total * 5.3);
  else if (c.dist > t.hw - 0.45) rest += 0.035 * Math.sin(c.total * 3.14);
  c.heaveV += (w2 * (rest - c.heave) - dz * c.heaveV) * DT; c.heave += c.heaveV * DT;
  c.heave = c.heave > 0.14 ? 0.14 : c.heave < -0.14 ? -0.14 : c.heave;
  c.spin += c.vf * DT;
}

/** Work out where on the lap the car now is. False if it has left its stretch of road altogether. */
export function locate(c: Car, t: Track): boolean {
  const idx = idxAt(t, c.x, c.z, c.idx);
  if (idx < 0) return false;
  const dx = c.x - t.px[idx], dz = c.z - t.pz[idx];
  const sNow = idx * t.ds + dx * t.tx[idx] + dz * t.tz[idx];
  let dS = sNow - c.lastS;
  if (dS > t.length / 2) dS -= t.length; else if (dS < -t.length / 2) dS += t.length;
  c.prevTotal = c.total; c.total += dS; c.lastS = sNow; c.idx = idx;
  c.lat = -dx * t.tz[idx] + dz * t.tx[idx];
  c.dist = distAt(t, c.x, c.z, idx);
  c.y = heightAtS(t, sNow);
  return true;
}

/** Refresh the grip under a car's tyres from the road surface, its tyres and their wear. */
export function feelRoad(c: Car, surf: Surface) {
  c.grip = surf.gripAt(c.idx, c.lat, c.tyre) * (1 - 0.3 * Math.pow(c.wear, 1.6)) * (1 - 0.3 * c.damage);
}

export interface GenStat {
  gen: number;
  progress: number;       // best fraction of the lap covered
  bestLap: number | null; // fastest lap this generation
  finished: number;
  crashed: number;
  setupMark: boolean;     // car setup changed before this generation
}

export interface Champion { g: Float32Array; lap: number }

export class Trainer {
  track: Track;
  setup: Setup;
  cls: CarClass;
  ai: AiConfig;
  surf: Surface;
  tyre: TyreId;
  private d: Derived;
  private rnd: Rng;
  genomes: Float32Array[] = [];
  cars: Car[] = [];
  generation = 1;
  time = 0;
  tick = 0;
  history: GenStat[] = [];
  recordLap: number | null = null;   // best ever on this track
  setupBest: number | null = null;   // best with the current setup
  bestPath = new Float32Array(PATH_MAX * 3); bestPathN = 0; bestPathVersion = 0;
  crashX = new Float32Array(256); crashZ = new Float32Array(256); crashY = new Float32Array(256); crashCount = 0;
  /** The fastest distinct brains that have completed a lap with this car: the race grid is drawn from these. */
  hall: Champion[] = [];
  private stale = 0;
  private bestFit = 0;
  private pendingMark = false;

  constructor(track: Track, setup: Setup, cls: CarClass, ai: AiConfig, surf: Surface, tyre: TyreId) {
    this.track = track;
    this.setup = { ...setup };
    this.cls = cls;
    this.ai = { ...ai };
    this.surf = surf;
    this.tyre = tyre;
    this.d = derive(setup, cls);
    this.rnd = mulberry32((track.seed ^ 0x9e3779b9) >>> 0);
    this.resetBrains();
  }

  get genomeSize() { return this.ai.hidden * (N_IN + 1) + N_OUT * (this.ai.hidden + 1); }

  resetBrains() {
    const H = this.ai.hidden, size = this.genomeSize;
    this.genomes = [];
    for (let i = 0; i < this.ai.population; i++) {
      const g = new Float32Array(size);
      for (let k = 0; k < size; k++) g[k] = gauss(this.rnd) * 0.5;
      g[H * (N_IN + 1) + (H + 1) + H] = -0.6; // speed bias: start out cautious
      this.genomes.push(g);
    }
    this.generation = 1;
    this.history = [];
    this.recordLap = null; this.setupBest = null; this.bestPathN = 0; this.bestPathVersion++;
    this.crashCount = 0; this.hall = [];
    this.stale = 0; this.bestFit = 0;
    this.startGeneration();
  }

  /** The car changed (setup, class or tyres): the drivers keep their brains but must prove themselves again. */
  setCar(s: Setup, cls: CarClass, tyre: TyreId) {
    this.setup = { ...s }; this.cls = cls; this.tyre = tyre;
    this.d = derive(s, cls);
    this.setupBest = null; this.bestPathN = 0; this.bestPathVersion++;
    this.hall = [];
    this.stale = 0; this.bestFit = 0;
    this.pendingMark = true;
    this.startGeneration();
  }

  setAi(ai: AiConfig) {
    const brainChanged = ai.hidden !== this.ai.hidden;
    this.ai = { ...ai };
    if (brainChanged) this.resetBrains();
  }

  private startGeneration() {
    const t = this.track;
    const pop = this.genomes.length;
    while (this.cars.length < pop) this.cars.push(new Car());
    this.cars.length = pop;
    for (let i = 0; i < pop; i++) {
      const c = this.cars[i];
      placeCar(c, t, -SPAWN_BACK);
      c.alive = true; c.finished = false; c.crashed = false;
      c.lapStart = -1; c.lapTime = 0; c.fitness = 0; c.topSpeed = 0; c.pathN = 0;
      c.tyre = TYRES[this.tyre]; c.wear = 0; c.damage = 0; c.pace = 1;
      c.elite = i === 0 && this.generation > 1;
    }
    this.time = 0; this.tick = 0;
  }

  get aliveCount() { let n = 0; for (const c of this.cars) if (c.alive) n++; return n; }

  /** The car to watch: furthest-along live car, else the furthest of all. */
  leader(): Car {
    let best = this.cars[0], bs = -Infinity;
    for (const c of this.cars) {
      const s = c.total + (c.alive ? 1e6 : 0);
      if (s > bs) { bs = s; best = c; }
    }
    return best;
  }

  private enshrine(g: Float32Array, lap: number) {
    const h = this.hall;
    for (const e of h) if (Math.abs(e.lap - lap) < 1e-4) return;
    if (h.length >= 8 && lap >= h[h.length - 1].lap) return;
    h.push({ g: g.slice(), lap });
    h.sort((a, b) => a.lap - b.lap);
    if (h.length > 8) h.length = 8;
  }

  /** Advance one tick. Returns true when the generation has just ended (a new one has started). */
  step(): boolean {
    const t = this.track, L = t.length, surf = this.surf, H = this.ai.hidden, vis = this.ai.vision, d = this.d;
    const prevTime = this.time, ext = Math.min(320, L * 0.3);
    this.time += DT; this.tick++;
    surf.step(DT);
    let alive = 0;
    const rec = this.tick % 3 === 0;
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      if (!c.alive) continue;
      c.endTime = this.time;
      feelRoad(c, surf);
      think(c, this.genomes[i], H, t, vis);
      drive(c, d, t, surf);
      const v = Math.hypot(c.vf, c.vl);
      if (v > c.topSpeed) c.topSpeed = v;

      if (!locate(c, t) || c.dist > t.ro - 0.6) {
        c.alive = false; c.crashed = true;
        const k = this.crashCount++ & 255;
        this.crashX[k] = c.x; this.crashZ[k] = c.z; this.crashY[k] = c.y;
        continue;
      }
      surf.carPass(c.idx, c.lat, v, DT);
      const prevTotal = c.prevTotal;
      if (c.lapStart < 0 && c.total >= 0) {
        c.lapStart = prevTime + ((0 - prevTotal) / Math.max(1e-6, c.total - prevTotal)) * DT;
        c.pathN = 0;
      }
      if (c.lapStart >= 0 && c.lapTime === 0 && rec && c.pathN < PATH_MAX) {
        const p = c.pathN * 3;
        c.path[p] = c.x; c.path[p + 1] = c.z; c.path[p + 2] = v;
        c.pathN++;
      }
      if (c.lapStart >= 0 && c.lapTime === 0 && c.total >= L) {
        const tc = prevTime + ((L - prevTotal) / Math.max(1e-6, c.total - prevTotal)) * DT;
        c.lapTime = tc - c.lapStart;
      }
      // The lap only counts once the car has also carried its speed through the start of the
      // next one: a race is many laps, and the first corner looks different at full speed.
      if (c.lapTime > 0 && c.total >= L + ext) {
        c.alive = false; c.finished = true;
        if (this.setupBest === null || c.lapTime < this.setupBest) {
          this.setupBest = c.lapTime;
          this.bestPath.set(c.path.subarray(0, c.pathN * 3));
          this.bestPathN = c.pathN; this.bestPathVersion++;
        }
        if (this.recordLap === null || c.lapTime < this.recordLap) this.recordLap = c.lapTime;
        this.enshrine(this.genomes[i], c.lapTime);
        continue;
      }
      if (c.vf < -3) { c.alive = false; c.crashed = true; continue; }
      if (c.total > c.mark + 6) { c.mark = c.total; c.stallT = 0; }
      else if ((c.stallT += DT) > 2.5) { c.alive = false; continue; }
      alive++;
    }
    if (alive === 0 || this.time > (L + ext + SPAWN_BACK) / 6 + 4) {
      this.evolve();
      return true;
    }
    return false;
  }

  private evolve() {
    const L = this.track.length, pop = this.cars.length;
    let bestLap: number | null = null, finished = 0, crashed = 0, bestProg = 0;
    // until someone completes a lap, getting further is nearly all that counts
    const fitP = this.setupBest === null ? 0.15 : FIT_P;
    for (const c of this.cars) {
      // distance matters, and so does how fast it was covered: a quick car that crashes late
      // can outrank a slow car that survives, which keeps pushing the pace up
      const dist = Math.max(0, c.total + SPAWN_BACK);
      const t = c.alive ? this.time : c.endTime;
      c.fitness = dist * Math.pow(dist / Math.max(t, 2), fitP) * (c.finished ? 1.35 : 1);
      if (c.finished) { finished++; if (bestLap === null || c.lapTime < bestLap) bestLap = c.lapTime; }
      if (c.crashed) crashed++;
      bestProg = Math.max(bestProg, c.finished ? 1 : Math.max(0, c.total) / L);
    }
    this.history.push({ gen: this.generation, progress: Math.min(1, bestProg), bestLap, finished, crashed, setupMark: this.pendingMark });
    this.pendingMark = false;

    const order = this.cars.map((_, i) => i).sort((a, b) => this.cars[b].fitness - this.cars[a].fitness);
    const top = this.cars[order[0]].fitness;
    if (top > this.bestFit * 1.0005) { this.bestFit = top; this.stale = 0; } else this.stale++;
    const sigma = this.ai.mutation * Math.min(3, 1 + 0.12 * this.stale);

    const target = this.ai.population;
    const next: Float32Array[] = [];
    const nElite = Math.max(2, Math.round(target * 0.08));
    for (let e = 0; e < nElite && e < pop; e++) next.push(this.genomes[order[e]].slice());
    const poolN = Math.max(2, Math.ceil(pop * 0.35));
    const r = this.rnd;
    const pick = () => {
      let b = Math.floor(r() * poolN);
      for (let k = 0; k < 2; k++) { const o = Math.floor(r() * poolN); if (o < b) b = o; }
      return this.genomes[order[b]];
    };
    while (next.length < target) {
      const a = pick(), child = a.slice();
      if (r() < 0.6) { const b = pick(); for (let k = 0; k < child.length; k++) if (r() < 0.5) child[k] = b[k]; }
      // each child gets its own step size: a few big leaps to explore, many small nudges to refine
      const u = r();
      const sg = sigma * (u < 0.12 ? 3 : u < 0.5 ? 1 : u < 0.8 ? 0.3 : 0.08);
      const kind = r();
      if (kind < 0.22) {
        // pace mutation: only the "how fast do I want to go" output changes, steering is untouched.
        // This is what gets a population past a corner it keeps arriving at too quickly.
        const H = this.ai.hidden, row = H * (N_IN + 1) + (H + 1);
        const s2 = Math.max(sg, 0.1) * (1 + 0.25 * this.stale);
        if (r() < 0.5) child[row + H] += gauss(r) * s2 * 2;
        else for (let k = 0; k <= H; k++) if (r() < 0.5) child[row + k] += gauss(r) * s2;
      } else {
        const pm = u < 0.12 ? 0.5 : r() < 0.5 ? 0.15 : 0.6;
        for (let k = 0; k < child.length; k++) if (r() < pm) child[k] += gauss(r) * sg;
      }
      next.push(child);
    }
    this.genomes = next;
    this.generation++;
    this.startGeneration();
  }
}
