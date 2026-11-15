// Race mode: eight cars on a grid, real contact between them, tyre wear, pit stops and
// strategy. The drivers are the brains trained in practice; a thin layer of racecraft on
// top handles traffic, because nothing in practice ever taught them about other cars.
import { Track, pitLat } from './track';
import { Car, Derived, derive, think, drive, locate, feelRoad, placeCar, DT, SPAWN_BACK, Champion, Setup } from './sim';
import { CarClass } from './cars';
import { Surface, Env, TYRES, TyreId, WeatherKind } from './weather';
import { mulberry32, Rng } from './rng';

export const GRID_GAP = 9.5; // metres between grid slots
export const CAR_SCALE = 1.35; // cars are drawn (and collide) a little larger than life so they read on screen

export interface Team { name: string; short: string; color: string; driver: string }
export const TEAMS: Team[] = [
  { name: 'Neurolap', short: 'NEU', color: '#ffd23d', driver: 'Your driver' },
  { name: 'Vela Racing', short: 'VEL', color: '#ff4d4d', driver: 'M. Ortega' },
  { name: 'Kestrel GP', short: 'KES', color: '#3ec8e8', driver: 'A. Lindqvist' },
  { name: 'Orbit Motorsport', short: 'ORB', color: '#ff9a2e', driver: 'T. Okafor' },
  { name: 'Northstar', short: 'NST', color: '#5b8cff', driver: 'J. Brennan' },
  { name: 'Brightwater', short: 'BRW', color: '#40d6b0', driver: 'S. Moreau' },
  { name: 'Sundial Racing', short: 'SUN', color: '#ff7fc0', driver: 'K. Watanabe' },
  { name: 'Hollow Peak', short: 'HPK', color: '#b07cf0', driver: 'L. Duarte' },
];
// how good each rival outfit's car and driver are, best first
const TEAM_FORM = [1, 1.012, 1.006, 1.0, 0.996, 0.992, 0.987, 0.982];

export type Pace = 'conserve' | 'balanced' | 'push' | 'attack';
export const PACE: Record<Pace, { mul: number; wear: number; label: string; hint: string }> = {
  conserve: { mul: 0.93, wear: 0.6, label: 'Conserve', hint: 'slow, kind to the tyres' },
  balanced: { mul: 0.97, wear: 1, label: 'Balanced', hint: 'steady race pace' },
  push: { mul: 1.0, wear: 1.45, label: 'Push', hint: 'everything practice taught' },
  attack: { mul: 1.03, wear: 2.0, label: 'Attack', hint: 'beyond the limit: quick, risky, eats tyres' },
};
export const POINTS = [25, 18, 15, 12, 10, 8, 6, 4];

export interface RaceOpts {
  laps: number;
  difficulty: 0 | 1 | 2;                  // rookie, pro, legend
  forecast: 'current' | 'changeable';
  startTyre: TyreId;
}
export interface PitState { phase: 'in' | 'stopped' | 'out'; s: number; v: number; timer: number; total: number; next: TyreId; lat0: number; s0: number }
export interface Entry {
  i: number; car: Car; team: Team; isPlayer: boolean;
  genome: Float32Array; d: Derived; skill: number;
  pace: Pace; boxCall: TyreId | null; pit: PitState | null;
  lap: number; lapStartT: number; lastLap: number | null; bestLap: number | null;
  pos: number; gap: number | null; lapsDown: number; interval: number | null;
  finished: boolean; finishT: number; dnf: boolean; dnfWhy: string;
  stops: number; used: TyreId[]; penalty: number; offs: number;
  grid: number; quali: number | null;
  cps: Float32Array; cpN: number;
  holdUntil: number; passSide: number;
  plan: { lap: number; wearLimit: number; react: number; wait: number };
  lastStop: number;
}
export interface RaceEvent { t: number; text: string; kind: 'info' | 'radio' | 'pit' | 'pass' | 'bad' | 'purple' | 'flag' }
export interface Spell { t0: number; t1: number; kind: WeatherKind; intensity: number }
export interface Result { e: Entry; pos: number; time: number | null; lapsDown: number; points: number; note: string }

const isRainTyre = (t: TyreId) => t === 'inter' || t === 'wet' || t === 'winter';

export class Race {
  track: Track; cls: CarClass; surf: Surface; env: Env; opts: RaceOpts;
  entries: Entry[] = [];
  order: Entry[] = [];
  phase: 'grid' | 'lights' | 'racing' | 'done' = 'grid';
  time = 0;            // race clock, from lights out
  lightsT = 0; lightsOn = 0; private goAt = 0;
  events: RaceEvent[] = [];
  spells: Spell[] = [];
  manualWeather = false;
  fastest: { e: Entry; lap: number } | null = null;
  winner: Entry | null = null;
  results: Result[] = [];
  crashX = new Float32Array(256); crashZ = new Float32Array(256); crashY = new Float32Array(256); crashCount = 0;
  private H: number; private vision: number;
  private rnd: Rng;
  private tick = 0;
  private wonAt = 0;
  private lastContact = new Map<number, number>();
  private advised = { wear: false, wet: 0, dmg: false };
  private refLap: number;
  private Lc: number; private Wc: number;

  constructor(track: Track, cls: CarClass, setup: Setup, hall: Champion[], H: number, vision: number, surf: Surface, env: Env, opts: RaceOpts, seed: number) {
    this.track = track; this.cls = cls; this.surf = surf; this.env = env; this.opts = opts;
    this.H = H; this.vision = vision;
    this.rnd = mulberry32((seed * 7 + 99) >>> 0);
    this.Lc = cls.len * CAR_SCALE; this.Wc = cls.wid * CAR_SCALE;
    this.refLap = hall[0]?.lap ?? 60;
    const field = 8;
    const diffSkill = [0.95, 0.972, 0.99][opts.difficulty], diffCar = [0.975, 1.0, 1.02][opts.difficulty];
    const nCp = Math.min(6000, Math.ceil(((opts.laps + 2) * track.length) / 50) + 4);
    for (let i = 0; i < field; i++) {
      const isPlayer = i === 0;
      // rivals drive brains from the same practice session; tougher fields get the better ones
      const pick = isPlayer ? 0 : opts.difficulty === 2 ? i % Math.min(3, hall.length) : opts.difficulty === 1 ? i % Math.min(5, hall.length) : Math.min(i, hall.length - 1);
      const form = TEAM_FORM[i];
      const car = new Car();
      const tyre = isPlayer ? opts.startTyre : this.rivalStartTyre(i);
      car.tyre = TYRES[tyre];
      this.entries.push({
        i, car, team: TEAMS[i], isPlayer,
        genome: hall.length ? hall[pick].g : new Float32Array(4), d: derive(setup, cls, isPlayer ? 1 : form * diffCar, isPlayer ? 1 : 0.5 + 0.5 * form),
        skill: isPlayer ? 1 : diffSkill * (0.99 + 0.02 * this.rnd()),
        pace: 'balanced', boxCall: null, pit: null,
        lap: 0, lapStartT: 0, lastLap: null, bestLap: null,
        pos: i + 1, gap: null, lapsDown: 0, interval: null,
        finished: false, finishT: 0, dnf: false, dnfWhy: '',
        stops: 0, used: [tyre], penalty: 0, offs: 0,
        grid: i, quali: null,
        cps: new Float32Array(nCp), cpN: -1,
        holdUntil: 0, passSide: 0,
        plan: { lap: Math.max(1, Math.round(opts.laps * (0.35 + 0.3 * this.rnd()))), wearLimit: 0.6 + 0.2 * this.rnd(), react: 3 + this.rnd() * 14, wait: 0 },
        lastStop: -99,
      });
    }
    this.qualify();
    this.buildForecast();
    this.say('info', `${track.name}: ${opts.laps} laps. ${this.order[0].team.name} on pole.`);
    const p = this.player;
    this.say('radio', p.grid === 0 ? 'Pole position! Clean start and it is ours to lose.' : `We start P${p.grid + 1}. Let's make up places.`);
  }

  get player() { return this.entries[0]; }
  get cars() { return this.entries.map((e) => e.car); }
  leader(): Entry { return this.order[0]; }

  private rivalStartTyre(i: number): TyreId {
    const w = this.surf.lineWater(), s = this.surf.lineSnow();
    if (s > 0.25) return 'winter';
    if (w > 0.6) return 'wet';
    if (w > 0.28) return 'inter';
    return this.opts.laps <= 4 ? 'soft' : i % 3 === 0 ? 'soft' : i % 3 === 1 ? 'medium' : 'hard';
  }

  private say(kind: RaceEvent['kind'], text: string) {
    this.events.push({ t: this.time, text, kind });
    if (this.events.length > 60) this.events.shift();
  }

  /** One flying lap each, alone on the road, decides the grid. */
  private qualify() {
    const t = this.track;
    for (const e of this.entries) {
      const c = new Car();
      c.tyre = e.car.tyre;
      placeCar(c, t, -SPAWN_BACK);
      let start = -1, time = 0;
      e.quali = null;
      for (let k = 0; k < 14000; k++) {
        time += DT;
        feelRoad(c, this.surf);
        c.pace = e.skill;
        think(c, e.genome, this.H, t, this.vision);
        drive(c, e.d, t, this.surf);
        if (!locate(c, t) || c.dist > t.ro - 0.6 || c.vf < -3) break;
        if (start < 0 && c.total >= 0) start = time;
        if (c.total >= t.length) { e.quali = time - start; break; }
      }
    }
    const sorted = this.entries.slice().sort((a, b) => (a.quali ?? 1e9) - (b.quali ?? 1e9));
    sorted.forEach((e, k) => {
      e.grid = k; e.pos = k + 1;
      placeCar(e.car, t, -6 - k * GRID_GAP, (k % 2 ? -1 : 1) * t.hw * 0.4);
      e.car.alive = true; e.car.elite = false;
    });
    this.order = sorted;
  }

  private buildForecast() {
    this.spells = [];
    if (this.opts.forecast !== 'changeable') return;
    const T = this.opts.laps * this.refLap * 1.08, r = this.rnd;
    const snowy = this.env.weather === 'snow';
    const kind: WeatherKind = snowy ? 'snow' : 'rain';
    if (r() < 0.5) {
      // dry start, a shower arrives, then it clears
      const a = T * (0.18 + 0.25 * r()), b = a + T * (0.25 + 0.2 * r());
      this.spells.push({ t0: -1e9, t1: a, kind: 'dry', intensity: 0 }, { t0: a, t1: b, kind, intensity: 0.5 + 0.5 * r() }, { t0: b, t1: 1e9, kind: 'dry', intensity: 0 });
    } else {
      // wet start that dries out, maybe with a late shower
      const a = T * (0.25 + 0.25 * r());
      this.spells.push({ t0: -1e9, t1: a, kind, intensity: 0.5 + 0.4 * r() }, { t0: a, t1: 1e9, kind: 'dry', intensity: 0 });
      if (r() < 0.4) { const c = T * (0.75 + 0.1 * r()); this.spells[1].t1 = c; this.spells.push({ t0: c, t1: 1e9, kind, intensity: 0.4 + 0.4 * r() }); }
    }
    this.applyWeather();
    if (this.spells[0].kind !== 'dry') this.surf.settle();
    // tyres chosen before the weather was known: put the rivals on the right ones
    for (const e of this.entries) if (!e.isPlayer) { const ty = this.rivalStartTyre(e.i); e.car.tyre = TYRES[ty]; e.used = [ty]; }
  }

  private applyWeather() {
    if (this.manualWeather || !this.spells.length) return;
    for (const s of this.spells) if (this.time >= s.t0 && this.time < s.t1) {
      if (this.env.weather !== s.kind || this.env.intensity !== s.intensity) {
        if (this.phase === 'racing') this.say('flag', s.kind === 'dry' ? 'The rain has stopped.' : s.kind === 'snow' ? 'Snow is falling.' : `Rain${s.intensity > 0.7 ? ', and it is heavy' : ''}.`);
        this.env.weather = s.kind; this.env.intensity = s.intensity;
      }
      return;
    }
  }

  /** The next change of weather the pit wall can see coming, if any. */
  nextChange(): { inSec: number; kind: WeatherKind } | null {
    if (this.manualWeather) return null;
    for (const s of this.spells) if (s.t0 > this.time) return { inSec: s.t0 - this.time, kind: s.kind };
    return null;
  }

  start() { if (this.phase === 'grid') { this.phase = 'lights'; this.lightsT = 0; this.goAt = 5 + 0.6 + this.rnd() * 1.4; } }

  callBox(tyre: TyreId | null) {
    const p = this.player;
    if (p.finished || p.dnf || p.pit) return;
    p.boxCall = tyre;
    this.say('radio', tyre ? `Box this lap for ${TYRES[tyre].name.toLowerCase()}s. Box, box.` : 'Stay out, stay out.');
  }
  setPace(p: Pace) { this.player.pace = p; }

  private sRel(c: Car): number {
    const L = this.track.length;
    let s = c.total % L; if (s < 0) s += L;
    return s > L / 2 ? s - L : s;
  }

  private rejoin(e: Entry, lat: number, speed: number, hold: number) {
    const c = e.car, t = this.track, i = c.idx;
    c.x = t.px[i] - t.tz[i] * lat; c.z = t.pz[i] + t.tx[i] * lat; c.th = Math.atan2(t.tz[i], t.tx[i]);
    c.vf = speed; c.vl = 0; c.w = 0; c.steer = 0; c.lastS = i * t.ds; c.lat = lat; c.dist = Math.abs(lat); c.y = t.h[i];
    c.mark = c.total; c.stallT = 0; c.bias = 0;
    e.holdUntil = this.time + hold;
  }

  private retire(e: Entry, why: string) {
    e.dnf = true; e.dnfWhy = why; e.car.alive = false; e.car.vf = 0; e.car.vl = 0; e.car.w = 0;
    this.say('bad', `${e.team.short} is out: ${why}.`);
    if (e.isPlayer) this.say('radio', 'That is our race over. Sorry.');
  }

  private hitBarrier(e: Entry) {
    const c = e.car, t = this.track;
    const v = Math.hypot(c.vf, c.vl);
    const k = this.crashCount++ & 255;
    this.crashX[k] = c.x; this.crashZ[k] = c.z; this.crashY[k] = c.y;
    c.damage = Math.min(1, c.damage + 0.05 + 0.006 * v);
    e.offs++;
    if (c.damage >= 1) { this.retire(e, 'crash damage'); return; }
    this.say('bad', `${e.team.short} hits the barrier${v > 30 ? ' hard' : ''}.`);
    if (e.isPlayer) this.say('radio', c.damage > 0.4 ? 'Big damage. Box for repairs when you can.' : 'We are in the wall! Keep it going.');
    // the marshals push it back to the middle of the road, where a driver knows how to get going
    this.rejoin(e, 0, 0, 2.2);
  }

  /** Racecraft: follow, look for a way past, keep off the car alongside. */
  private traffic(e: Entry) {
    const c = e.car, t = this.track, L = t.length, W = this.Wc, Lc = this.Lc;
    let ahead: Entry | null = null, gapA = 1e9, want = 0, cap = Infinity, squeeze = 0;
    for (const o of this.entries) {
      if (o === e || o.dnf || o.pit || o.finished || this.time < o.holdUntil) continue;
      let d = (o.car.total - c.total) % L; if (d < 0) d += L; if (d > L / 2) d -= L;
      const dl = o.car.lat - c.lat;
      if (d > 0 && d < gapA) { gapA = d; ahead = o; }
      if (Math.abs(d) < Lc * 1.05 && Math.abs(dl) < W * 1.5) squeeze += dl > 0 ? -1 : 1;
    }
    // overtaking is for straights: in and into corners, hold station
    let bendy = 0;
    for (let k = 0; k <= 36; k += 6) bendy = Math.max(bendy, Math.abs(t.curv[(c.idx + k) % t.n]));
    const straight = bendy < 0.012;
    if (!straight) e.passSide = 0;
    if (ahead && gapA < 46) {
      const a = ahead.car, dl = a.lat - c.lat;
      if (straight && gapA < 36 && c.vf - a.vf > -3) {
        const roomL = t.hw - a.lat - W * 0.5, roomR = t.hw + a.lat - W * 0.5;
        if (!e.passSide) e.passSide = roomL > roomR ? 1 : -1;
        const room = e.passSide > 0 ? roomL : roomR;
        if (room > W * 1.1) {
          const lim = t.hw - W * 0.5 - 0.35;
          let wl = a.lat + e.passSide * W * 1.22;
          wl = wl > lim ? lim : wl < -lim ? -lim : wl;
          want = wl - (c.lat - c.bias);
        } else e.passSide = 0;
      }
      if (Math.abs(dl) < W * 1.02 && gapA < Lc + 18) cap = Math.max(5, a.vf + (gapA - Lc - 2.2) * 0.9);
    } else e.passSide = 0;
    want += squeeze * (straight ? 1.2 : 0.5);
    const lim = t.hw * (straight ? 0.55 : 0.2), step = 2.4 * DT;
    want = want > lim ? lim : want < -lim ? -lim : want;
    const db = want - c.bias;
    c.bias += db > step ? step : db < -step ? -step : db;
    c.cap = cap;
  }

  private collide() {
    const r = this.Wc * 0.5, off = this.Lc * 0.5 - r, lim = (this.Lc + 1) * (this.Lc + 1), ents = this.entries;
    for (let i = 0; i < ents.length; i++) {
      const A = ents[i];
      if (A.dnf || A.pit || A.finished || this.time < A.holdUntil) continue;
      for (let j = i + 1; j < ents.length; j++) {
        const B = ents[j];
        if (B.dnf || B.pit || B.finished || this.time < B.holdUntil) continue;
        const a = A.car, b = B.car;
        const ddx = b.x - a.x, ddz = b.z - a.z;
        if (ddx * ddx + ddz * ddz > lim || Math.abs(a.y - b.y) > 2.5) continue;
        const ca = Math.cos(a.th), sa = Math.sin(a.th), cb = Math.cos(b.th), sb = Math.sin(b.th);
        let best = 0, nx = 0, nz = 0, oa = 0, ob = 0;
        for (let p = -1; p <= 1; p++) for (let q = -1; q <= 1; q++) {
          const dx = b.x + cb * q * off - (a.x + ca * p * off), dz = b.z + sb * q * off - (a.z + sa * p * off);
          const dd = Math.hypot(dx, dz), pen = 2 * r - dd;
          if (pen > best && dd > 1e-4) { best = pen; nx = dx / dd; nz = dz / dd; oa = p * off; ob = q * off; }
        }
        if (best <= 0) continue;
        a.x -= nx * best * 0.5; a.z -= nz * best * 0.5; b.x += nx * best * 0.5; b.z += nz * best * 0.5;
        const avx = a.vf * ca - a.vl * sa, avz = a.vf * sa + a.vl * ca, bvx = b.vf * cb - b.vl * sb, bvz = b.vf * sb + b.vl * cb;
        const vn = (bvx - avx) * nx + (bvz - avz) * nz;
        if (vn >= 0) continue;
        const jmp = -1.25 * vn * 0.5;
        const ax2 = avx - jmp * nx, az2 = avz - jmp * nz, bx2 = bvx + jmp * nx, bz2 = bvz + jmp * nz;
        a.vf = ax2 * ca + az2 * sa; a.vl = -ax2 * sa + az2 * ca;
        b.vf = bx2 * cb + bz2 * sb; b.vl = -bx2 * sb + bz2 * cb;
        // a knock away from the middle of the car turns it
        a.w += (oa * (-(-nx * sa + nz * ca)) * jmp) * 0.12;
        b.w += (ob * (-nx * sb + nz * cb) * jmp) * 0.12;
        const hit = -vn;
        if (hit > 6) {
          const dmg = (hit - 6) * 0.012;
          a.damage = Math.min(1, a.damage + dmg); b.damage = Math.min(1, b.damage + dmg);
          const key = i * 8 + j;
          if (this.time - (this.lastContact.get(key) ?? -9) > 3) {
            this.lastContact.set(key, this.time);
            this.say('bad', `Contact between ${A.team.short} and ${B.team.short}.`);
            if ((A.isPlayer || B.isPlayer) && this.player.car.damage > 0.35 && !this.advised.dmg) { this.advised.dmg = true; this.say('radio', 'We have damage. It is costing grip: think about a stop.'); }
          }
          if (a.damage >= 1) this.retire(A, 'collision damage');
          if (b.damage >= 1) this.retire(B, 'collision damage');
        }
      }
    }
  }

  private pitStep(e: Entry) {
    const c = e.car, t = this.track, p = e.pit!, box = t.boxes[e.i];
    const LIMIT = 22;
    if (p.phase === 'in') {
      let v = p.v;
      v = v > LIMIT ? Math.max(LIMIT, v - 20 * DT) : Math.min(LIMIT, v + 10 * DT);
      const stopV = Math.sqrt(2 * 11 * Math.max(0, box - p.s)) + 0.4;
      if (v > stopV) v = stopV;
      p.v = v; p.s += v * DT; c.total += v * DT;
      if (p.s >= box - 0.15) {
        p.phase = 'stopped'; p.v = 0;
        p.total = 2.2 + this.rnd() * 0.9 + (c.damage > 0.1 ? 2.5 + 5 * c.damage : 0);
        p.timer = p.total;
      }
    } else if (p.phase === 'stopped') {
      p.timer -= DT;
      if (p.timer <= 0) {
        c.tyre = TYRES[p.next]; c.wear = 0;
        if (!e.used.includes(p.next)) e.used.push(p.next);
        const fixed = c.damage > 0.1; c.damage = 0;
        e.stops++; e.lastStop = e.lap; p.phase = 'out';
        this.say('pit', `${e.team.short} pits: ${p.total.toFixed(1)}s for ${TYRES[p.next].name.toLowerCase()}s${fixed ? ' and repairs' : ''}.`);
        if (e.isPlayer) { this.say('radio', `Good stop, ${p.total.toFixed(1)} seconds. Go, go, go.`); this.advised.wear = false; this.advised.dmg = false; }
      }
    } else {
      // leave no faster than the corners just after the pit exit allow
      let vmax = LIMIT;
      for (let k = 0; k <= 70; k += 5) {
        const j = (((Math.round((p.s + k) / t.ds)) % t.n) + t.n) % t.n;
        const vc = Math.sqrt(8 / Math.max(0.004, Math.abs(t.curv[j])));
        vmax = Math.min(vmax, Math.sqrt(vc * vc + 2 * 6 * Math.max(0, p.s + k - t.pitOut)));
      }
      p.v = Math.min(vmax, p.v + 9 * DT); if (p.v < 6) p.v = 6;
      p.s += p.v * DT; c.total += p.v * DT;
    }
    const i = ((Math.round(p.s / t.ds) % t.n) + t.n) % t.n;
    // ease from wherever the car was on the road onto the pit lane path
    const ease = Math.max(0, 1 - (p.s - p.s0) / 22), off0 = (p.lat0 - pitLat(t, p.s0)) * ease * ease;
    const lat = pitLat(t, p.s) + off0, dlat = (pitLat(t, p.s + 1) - pitLat(t, p.s));
    c.idx = i; c.lat = lat; c.dist = Math.abs(lat);
    c.x = t.px[i] - t.tz[i] * lat; c.z = t.pz[i] + t.tx[i] * lat; c.y = t.h[i];
    c.th = Math.atan2(t.tz[i], t.tx[i]) + Math.atan(dlat);
    c.vf = p.v; c.vl = 0; c.w = 0; c.steer = 0; c.braking = p.phase === 'in' && p.v < LIMIT - 1;
    c.lastS = i * t.ds; c.prevTotal = c.total - p.v * DT;
    if (p.phase === 'out' && p.s >= t.pitOut) { e.pit = null; c.mark = c.total; c.stallT = 0; c.bias = 0; }
  }

  private strategy(e: Entry) {
    const c = e.car, o = this.opts;
    const remaining = o.laps - e.lap;
    if (e.boxCall || e.pit || e.finished || remaining < 1) return;
    const w = this.surf.lineWater(), sn = this.surf.lineSnow();
    const ideal: TyreId | null = sn > 0.25 ? 'winter' : w > 0.6 ? 'wet' : w > 0.28 ? 'inter' : null;
    const cur = c.tyre.id;
    const dryChoice = (): TyreId => {
      const opts: TyreId[] = remaining <= 3 ? ['soft', 'medium'] : remaining <= 7 ? ['medium', 'soft', 'hard'] : ['hard', 'medium'];
      return opts.find((t) => !e.used.includes(t)) ?? opts[0];
    };
    let call: TyreId | null = null;
    const wrong = ideal ? cur !== ideal && !(ideal === 'inter' && cur === 'wet' && w > 0.45) : isRainTyre(cur) && w < 0.12 && sn < 0.1;
    if (wrong) { if ((e.plan.wait += 0.5) > e.plan.react) call = ideal ?? dryChoice(); }
    else {
      e.plan.wait = 0;
      if (c.wear > e.plan.wearLimit && remaining > 1) call = isRainTyre(cur) ? cur : dryChoice();
      else if (c.damage > 0.45 && remaining > 1) call = isRainTyre(cur) ? cur : dryChoice();
      else if (o.laps >= 6 && e.used.length < 2 && !isRainTyre(cur) && e.lap >= e.plan.lap && remaining > 1) call = dryChoice();
    }
    if (call) e.boxCall = call;
    e.pace = c.wear > 0.72 ? 'conserve' : e.interval !== null && e.interval < 1.3 ? (o.difficulty === 2 ? 'attack' : 'push') : o.difficulty === 0 ? 'balanced' : 'push';
  }

  private advise() {
    const p = this.player, c = p.car;
    if (p.finished || p.dnf || p.pit) return;
    if (c.wear > 0.68 && !this.advised.wear) { this.advised.wear = true; this.say('radio', 'These tyres are nearly gone. Box when you are ready.'); }
    const w = this.surf.lineWater(), level = w > 0.6 ? 2 : w > 0.28 ? 1 : w < 0.1 ? 0 : -1;
    if (level >= 0 && level !== this.advised.wet) {
      this.advised.wet = level;
      const cur = c.tyre.id;
      if (level === 2 && cur !== 'wet') this.say('radio', 'It is properly wet now. Full wets are the tyre.');
      else if (level === 1 && !isRainTyre(cur)) this.say('radio', 'Track is wet enough for intermediates.');
      else if (level === 0 && isRainTyre(cur)) this.say('radio', 'There is a dry line. Slicks are faster now.');
    }
    const nc = this.nextChange();
    if (nc && nc.inSec < this.refLap * 1.5 && nc.inSec > this.refLap * 1.5 - 0.6) this.say('radio', nc.kind === 'dry' ? 'Radar says it stops raining in about a lap.' : `Radar shows ${nc.kind} arriving in about a lap.`);
  }

  private classify() {
    const L = this.track.length;
    const key = (e: Entry) => (e.finished ? 3e9 - e.finishT : e.dnf ? e.car.total - 1e9 : e.car.total + 1e6 * 0);
    const prev = this.order;
    const next = this.entries.slice().sort((a, b) => (a.finished !== b.finished ? (a.finished ? -1 : 1) : a.dnf !== b.dnf ? (a.dnf ? 1 : -1) : a.finished ? (b.lap - a.lap) || (a.finishT - b.finishT) : key(b) - key(a)));
    const lead = next[0];
    next.forEach((e, k) => {
      const was = e.pos;
      e.pos = k + 1;
      if (this.phase === 'racing' && !e.dnf && !e.finished && e.pos < was && this.time > 4) {
        const victim = prev[k];
        if (victim && victim !== e && !victim.pit && !victim.dnf && !e.pit) {
          this.say('pass', `${e.team.short} takes P${e.pos} from ${victim.team.short}.`);
          if (e.isPlayer) this.say('radio', e.pos === 1 ? 'You lead the race!' : `Great move. P${e.pos}.`);
          else if (victim.isPlayer) this.say('radio', `Lost a place to ${e.team.short}. P${victim.pos + 1}.`);
        }
      }
      if (e.dnf) { e.gap = null; e.interval = null; return; }
      const ref = (o: Entry) => {
        const cp = Math.min(e.cpN, o.cpN);
        return cp < 0 ? 0 : e.cps[cp] - o.cps[cp];
      };
      e.lapsDown = Math.max(0, Math.floor((lead.car.total - e.car.total) / L));
      e.gap = k === 0 ? 0 : Math.max(0, ref(lead));
      e.interval = k === 0 ? null : Math.max(0, ref(next[k - 1]));
    });
    this.order = next;
  }

  private finishRace() {
    this.phase = 'done';
    const fl = this.fastest?.e;
    this.results = this.order.map((e, k) => {
      const two = this.opts.laps >= 6 && !e.dnf && e.used.every((t) => !isRainTyre(t)) && e.used.length < 2;
      if (two) e.penalty += 10;
      return { e, pos: k + 1, time: e.finished ? e.finishT + e.penalty : null, lapsDown: e.lapsDown, points: 0, note: e.dnf ? e.dnfWhy : two ? '+10s: only one tyre compound used' : '' };
    });
    // penalties can reshuffle cars that finished on the same lap
    this.results.sort((a, b) => (a.e.dnf !== b.e.dnf ? (a.e.dnf ? 1 : -1) : a.e.finished !== b.e.finished ? (a.e.finished ? -1 : 1) : a.e.finished ? (b.e.lap - a.e.lap) || (a.time! - b.time!) : b.e.car.total - a.e.car.total));
    this.results.forEach((r, k) => { r.pos = k + 1; r.points = r.e.dnf ? 0 : (POINTS[k] ?? 0) + (r.e === fl ? 1 : 0); });
    const p = this.results.find((r) => r.e.isPlayer)!;
    this.say('radio', p.e.dnf ? 'We will get them next time.' : p.pos === 1 ? 'P1! You have won the race! Incredible job.' : p.pos <= 3 ? `P${p.pos}! A podium. Brilliant drive.` : `P${p.pos}. Good points.`);
  }

  /** Advance one tick. */
  step() {
    const t = this.track, L = t.length;
    this.tick++;
    this.surf.step(DT);
    if (this.phase === 'grid' || this.phase === 'done') return;
    if (this.phase === 'lights') {
      this.lightsT += DT;
      this.lightsOn = this.lightsT >= this.goAt ? 0 : Math.min(5, Math.floor(this.lightsT));
      if (this.lightsT >= this.goAt) { this.phase = 'racing'; this.time = 0; this.say('flag', 'Lights out and away we go!'); for (const e of this.entries) { e.lapStartT = 0; e.car.mark = e.car.total; } }
      return;
    }
    const prevTime = this.time;
    this.time += DT;
    this.applyWeather();
    for (const e of this.entries) {
      const c = e.car;
      if (e.dnf) continue;
      const before = c.total;
      if (e.pit) this.pitStep(e);
      else if (this.time < e.holdUntil) { c.vf = 0; c.vl = 0; c.w = 0; c.braking = true; c.mark = c.total; }
      else {
        feelRoad(c, this.surf);
        if (e.finished) { c.bias = 0; c.cap = 16; } else this.traffic(e);
        c.pace = PACE[e.pace].mul * e.skill;
        think(c, e.genome, this.H, t, this.vision);
        drive(c, e.d, t, this.surf);
        if (!locate(c, t) || c.dist > t.ro - 0.6) { if (e.finished) { this.rejoin(e, 0, 0, 1); } else this.hitBarrier(e); }
        else {
          const v = Math.hypot(c.vf, c.vl);
          this.surf.carPass(c.idx, c.lat, v, DT);
          if (c.vf < -3) this.rejoin(e, 0, 0, 2.5);
          else if (c.total > c.mark + 5) { c.mark = c.total; c.stallT = 0; }
          else if ((c.stallT += DT) > 4) { this.rejoin(e, 0, 0, 1.5); this.say('bad', `${e.team.short} is recovered by the marshals.`); }
          // tyre wear: distance, pace, sliding, and rain tyres cooking on a dry road
          const dS = c.total - before;
          if (dS > 0) {
            const water = this.surf.waterAt(c.idx, c.lat);
            const wrong = 1 + (c.tyre.dryPenalty - 1) * (1 - Math.min(1, water * 3));
            c.wear = Math.min(1, c.wear + (dS / L) * c.tyre.wearLap * PACE[e.pace].wear * wrong * (1 + 1.5 * Math.min(1, Math.abs(c.vl) / 6)));
          }
          // pit entry
          if (e.boxCall && !e.finished) {
            const s = this.sRel(c), ps = s - (c.total - before);
            if (ps < t.pitIn && s >= t.pitIn) { e.pit = { phase: 'in', s, v: Math.max(8, c.vf), timer: 0, total: 0, next: e.boxCall, lat0: c.lat, s0: s }; e.boxCall = null; c.cap = Infinity; }
          }
        }
      }
      if (e.dnf) continue;
      // timing
      const cp = Math.floor(c.total / 50);
      if (cp > e.cpN && cp < e.cps.length) { for (let k = e.cpN + 1; k <= cp; k++) if (k >= 0) e.cps[k] = this.time; e.cpN = cp; }
      const done = Math.floor(c.total / L);
      if (c.total >= 0 && done > e.lap && !e.finished) {
        const tc = prevTime + ((done * L - before) / Math.max(1e-6, c.total - before)) * DT;
        const lapT = tc - e.lapStartT;
        e.lap = done; e.lastLap = lapT; e.lapStartT = tc;
        if (e.bestLap === null || lapT < e.bestLap) e.bestLap = lapT;
        if (!this.fastest || lapT < this.fastest.lap) {
          this.fastest = { e, lap: lapT };
          if (e.lap > 1) this.say('purple', `Fastest lap: ${e.team.short} ${lapT.toFixed(2)}s.`);
        }
        if (this.winner || e.lap >= this.opts.laps) {
          e.finished = true; e.finishT = tc;
          if (!this.winner) { this.winner = e; this.wonAt = this.time; this.say('flag', `Chequered flag! ${e.team.name} wins.`); }
        } else if (e.isPlayer) {
          const left = this.opts.laps - e.lap;
          if (left === 1) this.say('radio', 'Last lap. Bring it home.');
        }
      }
    }
    this.collide();
    if (this.tick % 6 === 0) this.classify();
    if (this.tick % 30 === 0) { for (const e of this.entries) if (!e.isPlayer && !e.dnf) this.strategy(e); this.advise(); }
    if (this.entries.every((e) => e.finished || e.dnf) || (this.winner && this.time - this.wonAt > 60)) { this.classify(); this.finishRace(); }
  }
}
