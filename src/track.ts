import { mulberry32, Rng } from './rng';

export const HALF_WIDTH = 5.5;   // default tarmac half width (m); each track carries its own in track.hw
export const RUNOFF = 3.2;       // default grass/gravel between tarmac and barrier (m)
const MAX_HW = 6.2;
const GRID_R = MAX_HW + 36;      // distance field is exact out to here
const K_MAX = 1 / 15;            // tightest allowed corner (radius 15 m)
const STRETCH = 80;              // samples further apart than this count as different stretches of road
const BRIDGE_CLEARANCE = 6.6;    // height difference where the track crosses itself
/** Ground-plane direction towards the camera (the view looks along -this). Used to put the pits on the near side. */
export const CAM_XZ: [number, number] = [Math.SQRT1_2, Math.SQRT1_2];

export type StyleId = 'classic' | 'speed' | 'street' | 'technical' | 'eight' | 'endurance' | 'custom';
export type Theme = 'forest' | 'parkland' | 'city' | 'desert';
export interface StyleDef {
  id: StyleId; label: string; inspired: string; blurb: string;
  hw: number; runoff: number; elev: [number, number]; theme: Theme; len: [number, number];
}
export const STYLES: Record<StyleId, StyleDef> = {
  classic: { id: 'classic', label: 'Grand Prix classic', inspired: 'Spa, Silverstone', blurb: 'fast flowing sweeps through the forest', hw: 5.5, runoff: 3.2, elev: [3, 6.5], theme: 'forest', len: [650, 1400] },
  speed: { id: 'speed', label: 'Temple of speed', inspired: 'Monza', blurb: 'long straights broken by chicanes', hw: 6, runoff: 4.4, elev: [0.4, 1.6], theme: 'parkland', len: [850, 1500] },
  street: { id: 'street', label: 'Street circuit', inspired: 'Monaco, Singapore, Baku', blurb: 'narrow, walled, ninety-degree corners', hw: 5.0, runoff: 1.9, elev: [0, 2.2], theme: 'city', len: [600, 1300] },
  technical: { id: 'technical', label: 'Technical', inspired: 'Hungaroring, Zandvoort', blurb: 'corner after corner, no rest', hw: 5.2, runoff: 3.4, elev: [2, 5], theme: 'desert', len: [650, 1300] },
  eight: { id: 'eight', label: 'Figure of eight', inspired: 'Suzuka', blurb: 'crosses itself on a bridge', hw: 5.5, runoff: 3.2, elev: [2.5, 5], theme: 'forest', len: [900, 1650] },
  endurance: { id: 'endurance', label: 'Green hell', inspired: 'the Nordschleife', blurb: 'kilometres of blind crests, forest corners and long straights', hw: 5.2, runoff: 3.0, elev: [16, 32], theme: 'forest', len: [3400, 6600] },
  custom: { id: 'custom', label: 'Your circuit', inspired: 'your own drawing', blurb: 'drawn by hand, built to race', hw: 5.5, runoff: 3.2, elev: [2.5, 6], theme: 'parkland', len: [500, 9000] },
};
/** Styles the player can pick from the list. Custom circuits come from the editor. */
export const STYLE_IDS: StyleId[] = ['classic', 'speed', 'street', 'technical', 'eight', 'endurance'];
/** The styles "surprise me" chooses between. Kept to the original five so old seeds still give the same track. */
const AUTO_STYLES: StyleId[] = ['classic', 'speed', 'street', 'technical', 'eight'];
/** Hash of a style id that matches the old index for the original five, so their tracks do not change. */
const styleKey = (style: StyleId) => { const k = AUTO_STYLES.indexOf(style); return k >= 0 ? k : style === 'endurance' ? 5 : 6; };

export interface Track {
  seed: number;
  style: StyleId;
  theme: Theme;
  name: string;
  kind: 'loop' | 'eight';
  n: number;
  ds: number;
  length: number;
  hw: number;                    // tarmac half width
  ro: number;                    // lateral offset of the barrier (hw + run-off)
  px: Float32Array; pz: Float32Array;
  tx: Float32Array; tz: Float32Array;
  curv: Float32Array;            // signed curvature (1/m), + = left
  h: Float32Array;               // elevation (m), 0 at the start line, never negative
  slope: Float32Array;           // dh/ds
  vcurv: Float32Array;           // d2h/ds2: + in a dip, - over a crest
  cross: { over: number; under: number } | null; // sample indices where the bridge crosses
  maxH: number;
  // pit lane: runs alongside the start straight on the camera side
  pitSide: 1 | -1;               // lateral sign (+ = left of travel) of the pit lane
  pitIn: number; pitOut: number; // metres relative to the start line where the lane leaves / rejoins
  pitLane: number;               // lateral offset of the lane centre
  boxes: number[];               // metres relative to the start line of each pit box
  minX: number; maxX: number; minZ: number; maxZ: number;
  // distance field. Each cell remembers the two nearest stretches of road, so that where
  // the track passes over itself a car can tell its own level from the other one.
  gx0: number; gz0: number; gw: number; gh: number;
  gdist: Float32Array; gidx: Int32Array;
  gdist2: Float32Array; gidx2: Int32Array;
  gridR: number;
}

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export function gap(a: number, b: number, n: number): number { const d = a > b ? a - b : b - a; return d > n / 2 ? n - d : d; }

function resample(xs: number[], zs: number[], spacing: number): [number[], number[]] {
  const m = xs.length;
  const cum = [0];
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    cum.push(cum[i] + Math.hypot(xs[j] - xs[i], zs[j] - zs[i]));
  }
  const L = cum[m];
  const n = Math.max(8, Math.round(L / spacing));
  const ox: number[] = [], oz: number[] = [];
  let seg = 0;
  for (let k = 0; k < n; k++) {
    const d = (k / n) * L;
    while (cum[seg + 1] < d) seg++;
    const t = (d - cum[seg]) / Math.max(1e-9, cum[seg + 1] - cum[seg]);
    const j = (seg + 1) % m;
    ox.push(xs[seg] + (xs[j] - xs[seg]) * t);
    oz.push(zs[seg] + (zs[j] - zs[seg]) * t);
  }
  return [ox, oz];
}

function menger(xs: number[] | Float32Array, zs: number[] | Float32Array, i: number, step: number): number {
  const n = xs.length;
  const a = (i - step + n) % n, c = (i + step) % n;
  const abx = xs[i] - xs[a], abz = zs[i] - zs[a];
  const bcx = xs[c] - xs[i], bcz = zs[c] - zs[i];
  const acx = xs[c] - xs[a], acz = zs[c] - zs[a];
  const cross = abx * bcz - abz * bcx;
  const den = Math.hypot(abx, abz) * Math.hypot(bcx, bcz) * Math.hypot(acx, acz);
  return den < 1e-9 ? 0 : (2 * cross) / den;
}

type Pt = [number, number];
interface Shape { xs: number[]; zs: number[]; cross: [number, number] | null }

function perimeter(V: Pt[]): number {
  let L = 0;
  for (let i = 0; i < V.length; i++) { const j = (i + 1) % V.length; L += Math.hypot(V[j][0] - V[i][0], V[j][1] - V[i][1]); }
  return L;
}
function scaleTo(V: Pt[], L: number): void {
  const k = L / perimeter(V);
  for (const v of V) { v[0] *= k; v[1] *= k; }
}

/**
 * Real circuits are straights joined by arcs. This turns a polygon into exactly that: each
 * corner is rounded off with a true circular arc of (about) the radius asked for, shrunk
 * where the neighbouring straights are too short, never below the 15 m minimum.
 */
function fillet(V: Pt[], R: number[]): { xs: number[]; zs: number[] } | null {
  const m = V.length;
  const d: Pt[] = [], len: number[] = [], th: number[] = [];
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m, dx = V[j][0] - V[i][0], dz = V[j][1] - V[i][1], l = Math.hypot(dx, dz);
    if (l < 1) return null;
    d.push([dx / l, dz / l]); len.push(l);
  }
  for (let i = 0; i < m; i++) {
    const a = d[(i - 1 + m) % m], b = d[i];
    const t = Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]);
    if (Math.abs(t) > 2.75) return null;
    th.push(t);
  }
  const r = R.slice();
  const cut = (i: number) => (Math.abs(th[i]) < 0.03 ? 0 : r[i] * Math.tan(Math.abs(th[i]) / 2));
  for (let pass = 0; pass < 12; pass++) {
    let bad = false;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m, need = cut(i) + cut(j), have = len[i] - 1.5;
      if (need <= have) continue;
      bad = true;
      const k = have / need;
      r[i] = Math.max(15.2, r[i] * k); r[j] = Math.max(15.2, r[j] * k);
    }
    if (!bad) break;
    if (pass === 11) return null;
  }
  const xs: number[] = [], zs: number[] = [];
  for (let i = 0; i < m; i++) {
    const a = d[(i - 1 + m) % m], b = d[i], c = cut(i);
    if (c === 0) { xs.push(V[i][0]); zs.push(V[i][1]); continue; }
    const sg = th[i] > 0 ? 1 : -1;
    const p1x = V[i][0] - a[0] * c, p1z = V[i][1] - a[1] * c;
    const cx = p1x - a[1] * r[i] * sg, cz = p1z + a[0] * r[i] * sg;
    const a0 = Math.atan2(p1z - cz, p1x - cx);
    const K = Math.max(2, Math.ceil((Math.abs(th[i]) * r[i]) / 0.5));
    for (let k = 0; k <= K; k++) {
      const ang = a0 + (th[i] * k) / K;
      xs.push(cx + Math.cos(ang) * r[i]); zs.push(cz + Math.sin(ang) * r[i]);
    }
  }
  return { xs, zs };
}

/** Insert a chicane (a quick left-right or right-left) part way along edge i of a polygon. */
function addChicane(V: Pt[], R: number[], i: number, rnd: Rng): void {
  const A = V[i], B = V[(i + 1) % V.length];
  const L = Math.hypot(B[0] - A[0], B[1] - A[1]), ux = (B[0] - A[0]) / L, uz = (B[1] - A[1]) / L;
  const s0 = L * (0.36 + 0.28 * rnd()) - 21, dd = (rnd() < 0.5 ? -1 : 1) * (6.5 + rnd() * 3);
  const p = (s: number, o: number): Pt => [A[0] + ux * s - uz * o, A[1] + uz * s + ux * o];
  V.splice(i + 1, 0, p(s0, 0), p(s0 + 13, dd), p(s0 + 29, dd), p(s0 + 42, 0));
  R.splice(i + 1, 0, 15.5, 15.5, 15.5, 15.5);
}

function polyShape(style: StyleId, rnd: Rng): { xs: number[]; zs: number[] } | null {
  const V: Pt[] = [], R: number[] = [];
  if (style === 'speed') {
    // an elongated loop of a few big corners, then chicanes dropped into the long straights
    const K = 4 + Math.floor(rnd() * 3), b = 0.36 + rnd() * 0.2, ph = rnd() * 6.28;
    for (let i = 0; i < K; i++) {
      const ang = ((i + (rnd() - 0.5) * 0.5) / K) * Math.PI * 2 + ph, rr = 0.8 + 0.4 * rnd();
      V.push([Math.cos(ang) * rr, Math.sin(ang) * b * rr]);
      R.push(rnd() < 0.35 ? 16 + rnd() * 8 : 35 + rnd() * 45);
    }
    scaleTo(V, 950 + rnd() * 420);
    const order = V.map((_, i) => i).sort((p, q) => Math.hypot(V[(q + 1) % K][0] - V[q][0], V[(q + 1) % K][1] - V[q][1]) - Math.hypot(V[(p + 1) % K][0] - V[p][0], V[(p + 1) % K][1] - V[p][1]));
    const edgeLen = (i: number) => Math.hypot(V[(i + 1) % K][0] - V[i][0], V[(i + 1) % K][1] - V[i][1]);
    // the longest edge stays clear as the main straight
    const want = order.slice(1, 1 + 1 + (rnd() < 0.65 ? 1 : 0)).filter((i) => edgeLen(i) > 150).sort((p, q) => q - p);
    for (const i of want) addChicane(V, R, i, rnd);
  } else if (style === 'technical') {
    // lots of corners packed around a centre, with one clear sector left for the start straight
    const K = 11 + Math.floor(rnd() * 5), sector = 0.95, ph = rnd() * 6.28;
    for (let i = 0; i < K; i++) {
      const end = i === 0 || i === K - 1;
      const u = (i + (end ? 0 : (rnd() - 0.5) * 0.55)) / (K - 1);
      const ang = ph + sector / 2 + u * (Math.PI * 2 - sector), rr = end ? 0.95 : 0.45 + 0.55 * rnd();
      V.push([Math.cos(ang) * rr * 1.3, Math.sin(ang) * rr]);
      R.push(15.5 + rnd() * 14);
    }
    scaleTo(V, 720 + rnd() * 450);
  } else if (style === 'street') {
    // city blocks: the outline of a clump of grid cells, so every corner is a right angle
    const C = 4 + Math.floor(rnd() * 2), Rw = 3 + Math.floor(rnd() * 2);
    const xsG = [0], zsG = [0];
    for (let i = 0; i < C; i++) xsG.push(xsG[i] + 40 + rnd() * 22);
    for (let j = 0; j < Rw; j++) zsG.push(zsG[j] + 36 + rnd() * 20);
    const cell = new Uint8Array(C * Rw);
    for (let i = 0; i < C; i++) cell[i] = 1; // a full first row gives the long start straight
    const target = Math.round(C * Rw * (0.55 + rnd() * 0.25));
    let count = C;
    for (let guard = 0; guard < 400 && count < target; guard++) {
      const i = Math.floor(rnd() * C), j = 1 + Math.floor(rnd() * (Rw - 1));
      if (cell[j * C + i]) continue;
      if (cell[(j - 1) * C + i] || (j + 1 < Rw && cell[(j + 1) * C + i]) || (i > 0 && cell[j * C + i - 1]) || (i + 1 < C && cell[j * C + i + 1])) { cell[j * C + i] = 1; count++; }
    }
    const inSet = (i: number, j: number) => i >= 0 && j >= 0 && i < C && j < Rw && cell[j * C + i] === 1;
    // no holes: every empty cell must be reachable from outside
    const seen = new Uint8Array((C + 2) * (Rw + 2)), stack = [0];
    seen[0] = 1;
    while (stack.length) {
      const q = stack.pop()!, qi = (q % (C + 2)) - 1, qj = Math.floor(q / (C + 2)) - 1;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = qi + di, nj = qj + dj;
        if (ni < -1 || nj < -1 || ni > C || nj > Rw || inSet(ni, nj)) continue;
        const k = (nj + 1) * (C + 2) + ni + 1;
        if (!seen[k]) { seen[k] = 1; stack.push(k); }
      }
    }
    for (let j = 0; j < Rw; j++) for (let i = 0; i < C; i++) if (!cell[j * C + i] && !seen[(j + 1) * (C + 2) + i + 1]) return null;
    // boundary edges, anticlockwise, keyed by start corner
    const next = new Map<number, number>();
    const key = (i: number, j: number) => j * (C + 1) + i;
    const put = (a: number, b: number) => { if (next.has(a)) return false; next.set(a, b); return true; };
    for (let j = 0; j < Rw; j++) for (let i = 0; i < C; i++) {
      if (!cell[j * C + i]) continue;
      let ok = true;
      if (!inSet(i, j - 1)) ok = put(key(i, j), key(i + 1, j)) && ok;
      if (!inSet(i + 1, j)) ok = put(key(i + 1, j), key(i + 1, j + 1)) && ok;
      if (!inSet(i, j + 1)) ok = put(key(i + 1, j + 1), key(i, j + 1)) && ok;
      if (!inSet(i - 1, j)) ok = put(key(i, j + 1), key(i, j)) && ok;
      if (!ok) return null; // two blocks touching only at a corner
    }
    const first = next.keys().next().value as number;
    const loop: number[] = [];
    for (let k = first, guard = 0; guard < 200; guard++) { loop.push(k); k = next.get(k)!; if (k === first) break; }
    if (loop.length !== next.size) return null;
    const P: Pt[] = loop.map((k) => [xsG[k % (C + 1)], zsG[Math.floor(k / (C + 1))]]);
    for (let i = 0; i < P.length; i++) {
      const a = P[(i - 1 + P.length) % P.length], b = P[i], c = P[(i + 1) % P.length];
      if (Math.abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) < 1e-6) continue; // collinear
      V.push([b[0], b[1]]);
      R.push(rnd() < 0.35 ? 21 + rnd() * 9 : 16.5 + rnd() * 3);
    }
  } else if (style === 'endurance') {
    // a long, wandering lap: a lumpy ring of many corners of every size, from hairpins to
    // flat-out kinks, with a couple of long straights where the ring stretches out
    const K = 24 + Math.floor(rnd() * 10), ph = rnd() * 6.28, asp = 1.25 + rnd() * 0.5;
    const wob = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28], wa = [0.18 + rnd() * 0.12, 0.1 + rnd() * 0.08, 0.05 + rnd() * 0.05];
    for (let i = 0; i < K; i++) {
      const u = (i + (rnd() - 0.5) * 0.6) / K, ang = u * Math.PI * 2 + ph;
      let rr = 1 + wa[0] * Math.sin(2 * ang + wob[0]) + wa[1] * Math.sin(3 * ang + wob[1]) + wa[2] * Math.sin(5 * ang + wob[2]);
      rr *= 0.86 + 0.28 * rnd();
      V.push([Math.cos(ang) * rr * asp, Math.sin(ang) * rr]);
      const q = rnd();
      R.push(q < 0.28 ? 16 + rnd() * 12 : q < 0.7 ? 30 + rnd() * 45 : 85 + rnd() * 110);
    }
    scaleTo(V, 4300 + rnd() * 1900);
  } else {
    // figure of eight: a bow-tie. The left side is the start straight, the diagonals cross in the middle.
    const A = 150 + rnd() * 30, B = A * (0.64 + rnd() * 0.12);
    const j = () => (rnd() - 0.5) * 22;
    V.push([-A, -B], [-A + j() * 0.3, B], [A + j(), -B + j()], [A + 35 + rnd() * 40, j()], [A + j(), B + j()]);
    R.push(30 + rnd() * 30, 30 + rnd() * 30, 22 + rnd() * 30, 20 + rnd() * 25, 22 + rnd() * 30);
    if (rnd() < 0.5) { V.reverse(); R.reverse(); }
  }
  return fillet(V, R);
}

/** Calls back for every pair of samples (i < j, at least 50 apart along the lap) closer than r. Stops when it returns true. */
function nearPairs(xs: number[], zs: number[], r: number, cb: (i: number, j: number, d2: number) => boolean): boolean {
  const n = xs.length, cell = Math.max(r, 1);
  const map = new Map<number, number[]>();
  const key = (cx: number, cz: number) => cx * 73856093 ^ cz * 19349663;
  for (let i = 0; i < n; i++) {
    const k = key(Math.floor(xs[i] / cell), Math.floor(zs[i] / cell));
    let b = map.get(k); if (!b) map.set(k, (b = [])); b.push(i);
  }
  const r2 = r * r;
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(xs[i] / cell), cz = Math.floor(zs[i] / cell);
    for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
      const b = map.get(key(cx + ox, cz + oz));
      if (!b) continue;
      for (const j of b) {
        if (j < i + 50 || n - (j - i) < 50) continue;
        const dx = xs[i] - xs[j], dz = zs[i] - zs[j], d2 = dx * dx + dz * dz;
        if (d2 < r2 && cb(i, j, d2)) return true;
      }
    }
  }
  return false;
}

/** Where the centreline crosses itself, as [i, j] pairs with i < j, in order of i. */
function crossingsOf(xs: number[], zs: number[]): [number, number][] {
  const n = xs.length, out: [number, number][] = [];
  nearPairs(xs, zs, Math.sqrt(6), (i, j) => {
    const i2 = (i + 1) % n, j2 = (j + 1) % n;
    const rx = xs[i2] - xs[i], rz = zs[i2] - zs[i], sx = xs[j2] - xs[j], sz = zs[j2] - zs[j];
    const den = rx * sz - rz * sx;
    if (Math.abs(den) < 1e-9) return false;
    const t = ((xs[j] - xs[i]) * sz - (zs[j] - zs[i]) * sx) / den;
    const u = ((xs[j] - xs[i]) * rz - (zs[j] - zs[i]) * rx) / den;
    if (t >= 0 && t < 1 && u >= 0 && u < 1) out.push([i, j]);
    return false;
  });
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return out;
}

/** Turn corners tighter than the minimum radius into gentler ones, then sample every metre. */
function relax(xs: number[], zs: number[]): [number[], number[]] {
  [xs, zs] = resample(xs, zs, 1);
  for (let pass = 0; pass < 600; pass++) {
    const n = xs.length;
    const flag = new Uint8Array(n);
    let any = false;
    for (let i = 0; i < n; i++) {
      if (Math.abs(menger(xs, zs, i, 3)) > K_MAX) {
        any = true;
        for (let d = -6; d <= 6; d++) flag[(i + d + n) % n] = 1;
      }
    }
    if (!any) break;
    const nx = xs.slice(), nz = zs.slice();
    for (let i = 0; i < n; i++) {
      if (!flag[i]) continue;
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      nx[i] = 0.5 * xs[i] + 0.25 * (xs[a] + xs[b]);
      nz[i] = 0.5 * zs[i] + 0.25 * (zs[a] + zs[b]);
    }
    xs = nx; zs = nz;
    if (pass % 25 === 24) [xs, zs] = resample(xs, zs, 1);
  }
  return resample(xs, zs, 1);
}

/**
 * The checks every circuit must pass: corners no tighter than the minimum, no crossings
 * (one square crossing for a figure of eight), and no two stretches of road closer than two
 * barriers plus a gap. Returns the crossing, or a reason it failed.
 */
function validate(xs: number[], zs: number[], S: StyleDef, allowCross: boolean): { cross: [number, number] | null } | string {
  const n = xs.length;
  for (let i = 0; i < n; i++) if (Math.abs(menger(xs, zs, i, 3)) > K_MAX * 1.15) return 'a corner is too tight';
  const crossings = crossingsOf(xs, zs);
  let cross: [number, number] | null = null;
  let X = 0, Z = 0;
  if (!allowCross) {
    if (crossings.length) return 'the road crosses itself';
  } else {
    if (crossings.length > 1) return 'the road crosses itself more than once';
    if (crossings.length === 1) {
      cross = crossings[0];
      const [a, b] = cross;
      X = xs[a]; Z = zs[a];
      const tan = (i: number) => { const p = (i + 4) % n, q = (i - 4 + n) % n; const dx = xs[p] - xs[q], dz = zs[p] - zs[q], l = Math.hypot(dx, dz); return [dx / l, dz / l]; };
      const ta = tan(a), tb = tan(b);
      if (Math.abs(ta[0] * tb[1] - ta[1] * tb[0]) < 0.8) return 'the crossing is not square enough for a bridge';
    }
  }
  const minD = 2 * (S.hw + S.runoff) + 5;
  const close = nearPairs(xs, zs, minD, (i, j) => {
    if (!cross) return true;
    return Math.hypot(xs[i] - X, zs[i] - Z) > 36 || Math.hypot(xs[j] - X, zs[j] - Z) > 36;
  });
  if (close) return 'two parts of the road run too close together';
  return { cross };
}

function tryGenerate(seed: number, attempt: number, style: StyleId): Shape | null {
  const S = STYLES[style];
  const rnd = mulberry32((seed * 7919 + attempt * 104729 + styleKey(style) * 7717 + 1) >>> 0);
  let xs: number[] = [], zs: number[] = [];
  if (style === 'classic') {
    // smooth spline through scattered points; one edge is forced dead straight for the start
    const K = 7 + Math.floor(rnd() * 5), R = 112;
    const cx: number[] = [], cz: number[] = [];
    for (let i = 0; i < K; i++) {
      const ang = ((i + (rnd() - 0.5) * 0.7) / K) * Math.PI * 2;
      const rad = R * (0.4 + 0.8 * rnd());
      cx.push(Math.cos(ang) * rad * 1.3);
      cz.push(Math.sin(ang) * rad);
    }
    let bi = 0, bl = 0;
    for (let i = 0; i < K; i++) { const l = Math.hypot(cx[(i + 1) % K] - cx[i], cz[(i + 1) % K] - cz[i]); if (l > bl) { bl = l; bi = i; } }
    if (bl < 150) return null;
    const ax = cx[bi], az = cz[bi], bx = cx[(bi + 1) % K], bz = cz[(bi + 1) % K];
    cx.splice(bi + 1, 0, ax + (bx - ax) * 0.2, ax + (bx - ax) * 0.8);
    cz.splice(bi + 1, 0, az + (bz - az) * 0.2, az + (bz - az) * 0.8);
    const M = cx.length, SUB = 24;
    for (let i = 0; i < M; i++) {
      const p0 = (i - 1 + M) % M, p1 = i, p2 = (i + 1) % M, p3 = (i + 2) % M;
      for (let q = 0; q < SUB; q++) {
        const t = q / SUB, t2 = t * t, t3 = t2 * t;
        const f = (a: number, b: number, c: number, d: number) =>
          0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
        xs.push(f(cx[p0], cx[p1], cx[p2], cx[p3]));
        zs.push(f(cz[p0], cz[p1], cz[p2], cz[p3]));
      }
    }
  } else {
    const g = polyShape(style, rnd);
    if (!g) return null;
    xs = g.xs; zs = g.zs;
  }
  [xs, zs] = relax(xs, zs);
  const n = xs.length;
  if (n < S.len[0] || n > S.len[1]) return null;
  if (style === 'eight' && crossingsOf(xs, zs).length !== 1) return null;
  const v = validate(xs, zs, S, style === 'eight');
  if (typeof v === 'string') return null;
  return { xs, zs, cross: v.cross };
}

/**
 * Pick the start line: the middle of a dead-straight run long enough for the grid, the pit
 * lane and the buildings, with nothing else from the circuit in the way on either side.
 */
function findStart(xs: number[], zs: number[], cross: [number, number] | null, ro: number): number {
  const n = xs.length;
  const straight = new Uint8Array(n);
  for (let i = 0; i < n; i++) straight[i] = Math.abs(menger(xs, zs, i, 4)) < 0.0015 ? 1 : 0;
  const runs: [number, number][] = []; // [start, length]
  let i0 = 0;
  while (i0 < n && straight[i0]) i0++;
  if (i0 === n) return -1;
  for (let k = 0; k < n;) {
    const i = (i0 + k) % n;
    if (!straight[i]) { k++; continue; }
    let l = 0;
    while (l < n && straight[(i + l) % n]) l++;
    runs.push([i, l]); k += l;
  }
  runs.sort((a, b) => b[1] - a[1]);
  for (const [rs, rl] of runs) {
    if (rl < 104) break;
    const st = (rs + Math.round(Math.min(Math.max(rl * 0.55, 50), rl - 50))) % n;
    if (cross && (gap(st, cross[0], n) < 245 || gap(st, cross[1], n) < 245)) continue;
    const tx = xs[(st + 1) % n] - xs[(st - 1 + n) % n], tz = zs[(st + 1) % n] - zs[(st - 1 + n) % n], tl = Math.hypot(tx, tz);
    const nx = -tz / tl, nz = tx / tl;
    const pit = nx * CAM_XZ[0] + nz * CAM_XZ[1] > 0 ? 1 : -1;
    let ok = true;
    for (let di = -110; di <= 110 && ok; di += 5) {
      const i = (st + di + n) % n;
      const a = (i - 1 + n) % n, b = (i + 1) % n, l = Math.hypot(xs[b] - xs[a], zs[b] - zs[a]);
      const mx = -(zs[b] - zs[a]) / l, mz = (xs[b] - xs[a]) / l;
      for (const side of [1, -1]) {
        const D = Math.abs(di) <= 55 ? ro + 20 : side === pit ? ro + 10 : 0;
        if (!D) continue;
        const qx = xs[i] + mx * side * D, qz = zs[i] + mz * side * D, lim = (ro + 3) * (ro + 3);
        for (let j = 0; j < n; j += 2) {
          if (gap(i, j, n) < 130) continue;
          const dx = xs[j] - qx, dz = zs[j] - qz;
          if (dx * dx + dz * dz < lim) { ok = false; break; }
        }
        if (!ok) break;
      }
    }
    if (ok) return st;
  }
  return -1;
}

function buildElevation(seed: number, n: number, ds: number, cross: [number, number] | null, elev: [number, number]): Float32Array | null {
  const r = mulberry32((seed * 977 + 3) >>> 0);
  const bump = (u: number) => (u < 1 ? 0.5 * (1 + Math.cos(Math.PI * u)) : 0);
  for (let attempt = 0; attempt < 7; attempt++) {
    const amp = (elev[0] + r() * (elev[1] - elev[0])) * Math.pow(0.7, attempt);
    const ph = [r() * 6.28, r() * 6.28, r() * 6.28, r() * 6.28];
    const w = [1, 0.65, 0.4, 0.22];
    // a long lap gets more hills: extra, shorter waves for crests and dips along the way
    const extra = n > 2500 ? Math.round(n / 700) : 0;
    const fq = [1, 2, 3, 4];
    for (let k = 0; k < extra; k++) { ph.push(r() * 6.28); const f = 5 + k * 2 + Math.floor(r() * 2); fq.push(f); w.push(1.4 / f); }
    const h = new Float32Array(n);
    let lo = Infinity;
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let k = 0; k < w.length; k++) v += w[k] * Math.sin((fq[k] * 2 * Math.PI * i) / n + ph[k]);
      h[i] = v * amp;
      lo = Math.min(lo, h[i]);
    }
    // level ground around the start line, where the pits and buildings stand
    const flat = new Float32Array(n);
    if (!extra) for (let i = 0; i < n; i++) { flat[i] = smooth(100, 155, gap(i, 0, n)); h[i] = (h[i] - lo) * flat[i]; }
    else {
      // on a long lap the hills are big, so level the start area at its own height rather
      // than pulling it down to the lowest point (which would make a wall either side of it)
      let hs = 0, cnt = 0;
      for (let i = 0; i < n; i++) if (gap(i, 0, n) < 100) { hs += h[i]; cnt++; }
      hs /= Math.max(1, cnt);
      let lo2 = Infinity;
      for (let i = 0; i < n; i++) { flat[i] = smooth(60, 260, gap(i, 0, n)); h[i] = hs + (h[i] - hs) * flat[i]; lo2 = Math.min(lo2, h[i]); }
      for (let i = 0; i < n; i++) h[i] -= lo2;
    }
    if (cross) {
      const up = h[cross[0]] >= h[cross[1]] ? cross[0] : cross[1], dn = up === cross[0] ? cross[1] : cross[0];
      for (let it = 0; it < 8; it++) {
        const need = BRIDGE_CLEARANCE - (h[up] - h[dn]);
        if (need <= 0.01) break;
        for (let i = 0; i < n; i++) h[i] += need * 1.03 * bump(gap(i, up, n) / 90) * flat[i];
      }
      if (h[up] - h[dn] < BRIDGE_CLEARANCE - 0.05) continue;
    }
    let steep = 0;
    for (let i = 0; i < n; i++) steep = Math.max(steep, Math.abs(h[(i + 1) % n] - h[(i - 1 + n) % n]) / (2 * ds));
    if (steep <= 0.15) return h;
  }
  return cross ? null : new Float32Array(n);
}

function circuitName(seed: number, style: StyleId): string {
  const r = mulberry32((seed * 31337 + 11) >>> 0);
  const A = ['Val', 'Mor', 'Ash', 'Kel', 'Bran', 'Sol', 'Tor', 'Lin', 'Mar', 'Cas', 'Del', 'Ven', 'Ost', 'Rid', 'Fen', 'Hal', 'Quin', 'Zar', 'Bel', 'Cor', 'Nor', 'Pen'];
  const B = ['ford', 'dale', 'mont', 'ville', 'berg', 'stad', 'holm', 'wick', 'ora', 'ano', 'ingen', 'ia', 'ton', 'more', 'ezza', 'aro'];
  const N = A[Math.floor(r() * A.length)] + B[Math.floor(r() * B.length)];
  const pick = (o: string[]) => o[Math.floor(r() * o.length)];
  switch (style) {
    case 'classic': return pick([`Circuit de ${N}`, `${N} Park`, `${N} Grand Prix Circuit`]);
    case 'speed': return pick([`Autodromo di ${N}`, `${N} Speedway`]);
    case 'street': return pick([`${N} Street Circuit`, `${N} Harbour Circuit`, `${N} City Circuit`]);
    case 'technical': return pick([`${N}ring`, `Circuito de ${N}`]);
    case 'endurance': return pick([`${N}ring`, `${N} Nordschleife`, `${N} Mountain Course`]);
    case 'custom': return `${N} Park`;
    default: return pick([`${N} International`, `${N} Crossover`]);
  }
}

/** Which style a seed gets when the player has not asked for one. */
export function styleForSeed(seed: number): StyleId {
  const r = mulberry32((seed * 2654435761 + 5) >>> 0);
  r(); r();
  return AUTO_STYLES[Math.floor(r() * AUTO_STYLES.length)];
}

export function generateTrack(seed: number, wanted?: StyleId): Track {
  let style: StyleId = wanted ?? styleForSeed(seed);
  let built: { xs: number[]; zs: number[]; cross: [number, number] | null; h: Float32Array } | null = null;
  for (let pass = 0; pass < 2 && !built; pass++) {
    const S = STYLES[style];
    for (let a = 0; a < 600 && !built; a++) {
      const g = tryGenerate(seed, a, style);
      if (!g) continue;
      let { xs, zs } = g;
      const n = xs.length;
      const start = findStart(xs, zs, g.cross, S.hw + S.runoff);
      if (start < 0) continue;
      xs = xs.slice(start).concat(xs.slice(0, start));
      zs = zs.slice(start).concat(zs.slice(0, start));
      const cross: [number, number] | null = g.cross ? [(g.cross[0] - start + n) % n, (g.cross[1] - start + n) % n] : null;
      let len = 0;
      for (let i = 0; i < n; i++) len += Math.hypot(xs[(i + 1) % n] - xs[i], zs[(i + 1) % n] - zs[i]);
      const h = buildElevation(seed, n, len / n, cross, S.elev);
      if (!h) continue;
      built = { xs, zs, cross, h };
    }
    if (!built) style = 'speed';
  }
  if (!built) {
    // last resort: a plain stadium oval, always valid
    const xs: number[] = [], zs: number[] = [];
    const g = fillet([[-150, -60], [150, -60], [150, 60], [-150, 60]], [55, 55, 55, 55])!;
    const [rx, rz] = resample(g.xs, g.zs, 1);
    const st = findStart(rx, rz, null, HALF_WIDTH + RUNOFF);
    const s0 = Math.max(0, st);
    xs.push(...rx.slice(s0), ...rx.slice(0, s0)); zs.push(...rz.slice(s0), ...rz.slice(0, s0));
    built = { xs, zs, cross: null, h: new Float32Array(xs.length) };
    style = 'speed';
  }
  return finishTrack(seed, style, built.xs, built.zs, built.cross, built.h, STYLES[style].theme, circuitName(seed, style));
}

/** Everything that follows from the centreline: directions, curvature, heights, the distance field, the pits. */
function finishTrack(seed: number, style: StyleId, xs: number[], zs: number[], crossIdx: [number, number] | null, h: Float32Array, theme: Theme, name: string): Track {
  const S = STYLES[style];
  const n = xs.length;

  const px = Float32Array.from(xs), pz = Float32Array.from(zs);
  const tx = new Float32Array(n), tz = new Float32Array(n), curvRaw = new Float32Array(n), curv = new Float32Array(n);
  let length = 0;
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n, b = (i + 1) % n;
    const dx = px[b] - px[a], dz = pz[b] - pz[a];
    const l = Math.hypot(dx, dz) || 1;
    tx[i] = dx / l; tz[i] = dz / l;
    curvRaw[i] = menger(px, pz, i, 3);
    length += Math.hypot(px[b] - px[i], pz[b] - pz[i]);
  }
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let d = -2; d <= 2; d++) s += curvRaw[(i + d + n) % n];
    curv[i] = s / 5;
  }
  const ds = length / n;
  const slope = new Float32Array(n), vcurv = new Float32Array(n);
  let maxH = 0;
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n, b = (i + 1) % n;
    slope[i] = (h[b] - h[a]) / (2 * ds);
    vcurv[i] = (h[b] - 2 * h[i] + h[a]) / (ds * ds);
    maxH = Math.max(maxH, h[i]);
  }
  let cross: Track['cross'] = null;
  if (crossIdx) {
    const [a, b] = crossIdx;
    cross = h[a] >= h[b] ? { over: a, under: b } : { over: b, under: a };
  }

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, px[i]); maxX = Math.max(maxX, px[i]);
    minZ = Math.min(minZ, pz[i]); maxZ = Math.max(maxZ, pz[i]);
  }

  // distance field (1 m cells)
  const gx0 = Math.floor(minX - GRID_R - 2), gz0 = Math.floor(minZ - GRID_R - 2);
  const gw = Math.ceil(maxX + GRID_R + 2) - gx0 + 1, gh = Math.ceil(maxZ + GRID_R + 2) - gz0 + 1;
  const gdist = new Float32Array(gw * gh).fill(GRID_R), gdist2 = new Float32Array(gw * gh).fill(GRID_R);
  const gidx = new Int32Array(gw * gh).fill(-1), gidx2 = new Int32Array(gw * gh).fill(-1);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = px[i], az = pz[i], bx = px[j], bz = pz[j];
    const ex = bx - ax, ez = bz - az, el2 = ex * ex + ez * ez || 1;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - GRID_R) - gx0);
    const x1 = Math.min(gw - 1, Math.ceil(Math.max(ax, bx) + GRID_R) - gx0);
    const z0 = Math.max(0, Math.floor(Math.min(az, bz) - GRID_R) - gz0);
    const z1 = Math.min(gh - 1, Math.ceil(Math.max(az, bz) + GRID_R) - gz0);
    for (let gz = z0; gz <= z1; gz++) {
      const wz = gz + gz0;
      for (let gx = x0; gx <= x1; gx++) {
        const wx = gx + gx0;
        let t = ((wx - ax) * ex + (wz - az) * ez) / el2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(wx - (ax + ex * t), wz - (az + ez * t));
        if (d >= GRID_R) continue;
        const c = gz * gw + gx, id = t < 0.5 ? i : j;
        const i1 = gidx[c], i2 = gidx2[c];
        if (i1 < 0) { gdist[c] = d; gidx[c] = id; }
        else if (gap(i1, id, n) < STRETCH) { if (d < gdist[c]) { gdist[c] = d; gidx[c] = id; } }
        else if (i2 < 0) { gdist2[c] = d; gidx2[c] = id; }
        else if (gap(i2, id, n) < STRETCH) { if (d < gdist2[c]) { gdist2[c] = d; gidx2[c] = id; } }
        else if (gdist[c] >= gdist2[c]) { if (d < gdist[c]) { gdist[c] = d; gidx[c] = id; } }
        else if (d < gdist2[c]) { gdist2[c] = d; gidx2[c] = id; }
      }
    }
  }

  const ro = S.hw + S.runoff;
  const pitSide: 1 | -1 = -tz[0] * CAM_XZ[0] + tx[0] * CAM_XZ[1] > 0 ? 1 : -1;
  const boxes: number[] = [];
  for (let k = 0; k < 8; k++) boxes.push(-35 + k * 10);
  return {
    seed, style, theme, name, kind: crossIdx ? 'eight' : 'loop',
    n, ds, length, hw: S.hw, ro, px, pz, tx, tz, curv, h, slope, vcurv, cross, maxH,
    pitSide, pitIn: -100, pitOut: 100, pitLane: ro + 4.8, boxes,
    minX, maxX, minZ, maxZ, gx0, gz0, gw, gh, gdist, gidx, gdist2, gidx2, gridR: GRID_R,
  };
}

/**
 * Build a circuit from a hand-drawn loop. The drawing is simplified to its main turns, scaled
 * to the length asked for, and every turn becomes a real arc; straights stay straight. One
 * square crossing is allowed (it becomes a bridge). Returns the track, or why it cannot be built.
 */
export function buildCustomTrack(pts: [number, number][], length: number, theme: Theme): Track | string {
  if (pts.length < 6) return 'Draw a bigger loop';
  // A drawing with no straight long enough for the pits is simplified harder (fewer, longer
  // sides) until one appears; the first reason it failed is the one reported.
  let why = '';
  for (const tolMul of [1, 2, 3.5, 5.5]) {
    const t = customAttempt(pts, length, theme, tolMul);
    if (typeof t !== 'string') return t;
    if (!why) why = t;
  }
  return why;
}

function customAttempt(pts: [number, number][], length: number, theme: Theme, tolMul: number): Track | string {
  // keep the turns that matter: Ramer-Douglas-Peucker on the closed loop
  let span = 0;
  for (let i = 0; i < pts.length; i += 2) for (let j = 0; j < pts.length; j += 2) span = Math.max(span, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
  const tol = span * 0.018 * tolMul;
  let fi = 0, fdist = 0;
  for (let i = 0; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (d > fdist) { fdist = d; fi = i; } }
  const loop = pts.concat([pts[0]]), keep = new Uint8Array(loop.length);
  const dp = (a: number, b: number) => {
    let far = -1, fd = tol;
    const [ax, az] = loop[a], [bx, bz] = loop[b], dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((loop[i][0] - ax) * dz - (loop[i][1] - az) * dx) / l;
      if (d > fd) { fd = d; far = i; }
    }
    if (far >= 0) { keep[far] = 1; dp(a, far); dp(far, b); }
  };
  // split the loop at the point furthest from the first, then simplify both halves
  keep[0] = keep[fi] = 1;
  dp(0, fi); dp(fi, loop.length - 1);
  let V: Pt[] = [];
  for (let i = 0; i < loop.length - 1; i++) if (keep[i]) V.push([loop[i][0], loop[i][1]]);
  // merge points that ended up very close together
  V = V.filter((p, i) => Math.hypot(p[0] - V[(i + 1) % V.length][0], p[1] - V[(i + 1) % V.length][1]) > span * 0.02);
  if (V.length < 3) return 'Draw a bigger loop';
  scaleTo(V, length);
  const turn = (i: number) => {
    const a = V[(i - 1 + V.length) % V.length], b = V[i], c = V[(i + 1) % V.length];
    return Math.abs(Math.atan2((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]), (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])));
  };
  const R = V.map((_, i) => { const t = turn(i); return t > 1.6 ? 17 : t > 0.9 ? 30 : t > 0.45 ? 55 : 110; });
  const S = STYLES.custom;
  const g = fillet(V, R);
  if (!g) return 'A turn doubles back on itself: open out the hairpins';
  const [xs0, zs0] = relax(g.xs, g.zs);
  const v = validate(xs0, zs0, S, true);
  if (typeof v === 'string') return `Cannot build it: ${v}. Try a bigger size or a looser drawing.`;
  const n = xs0.length;
  const start = findStart(xs0, zs0, v.cross, S.hw + S.runoff);
  if (start < 0) return 'It needs one straight of about 110 m with room beside it for the pits. Draw a longer straight, or make the circuit bigger.';
  const xs = xs0.slice(start).concat(xs0.slice(0, start)), zs = zs0.slice(start).concat(zs0.slice(0, start));
  const cross: [number, number] | null = v.cross ? [(v.cross[0] - start + n) % n, (v.cross[1] - start + n) % n] : null;
  let len = 0;
  for (let i = 0; i < n; i++) len += Math.hypot(xs[(i + 1) % n] - xs[i], zs[(i + 1) % n] - zs[i]);
  let seed = 7;
  for (const p of V) seed = (Math.imul(seed, 31) + Math.round(p[0] * 10) * 17 + Math.round(p[1] * 10)) >>> 0;
  seed = 1 + (seed % 900000);
  const h = buildElevation(seed, n, len / n, cross, n > 2500 ? [6, 14] : S.elev);
  if (!h) return 'The crossing cannot be lifted onto a bridge here: move it away from the start straight.';
  return finishTrack(seed, 'custom', xs, zs, cross, h, theme, circuitName(seed, 'custom'));
}

/** Lateral offset of the pit lane centre at s metres from the start line (signed, + = left). */
export function pitLat(t: Track, s: number): number {
  const a = 0, b = t.pitLane; // joins and leaves at the middle of the road, where the drivers are at home
  const u = Math.min(smooth(t.pitIn, t.pitIn + 38, s), smooth(t.pitOut, t.pitOut - 38, s));
  return t.pitSide * (a + (b - a) * u);
}

/** Distance to this cell's stretch of road that is nearest (along the lap) to sample `hint`. */
function pick(t: Track, c: number, hint: number): number {
  const i2 = t.gidx2[c];
  if (i2 >= 0 && gap(i2, hint, t.n) < gap(t.gidx[c], hint, t.n)) return t.gdist2[c];
  return t.gdist[c];
}

/** Distance from (x,z) to the centreline of the stretch of road around sample `hint`, bilinear. */
export function distAt(t: Track, x: number, z: number, hint: number): number {
  const fx = x - t.gx0, fz = z - t.gz0;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  if (ix < 0 || iz < 0 || ix >= t.gw - 1 || iz >= t.gh - 1) return t.gridR;
  const ux = fx - ix, uz = fz - iz;
  const c = iz * t.gw + ix;
  const a = pick(t, c, hint), b = pick(t, c + 1, hint), d = pick(t, c + t.gw, hint), e = pick(t, c + t.gw + 1, hint);
  return a + (b - a) * ux + (d - a) * uz + (a - b - d + e) * ux * uz;
}

/** Distance from (x,z) to the nearest road of any stretch, bilinear. */
export function distAny(t: Track, x: number, z: number): number {
  const fx = x - t.gx0, fz = z - t.gz0;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  if (ix < 0 || iz < 0 || ix >= t.gw - 1 || iz >= t.gh - 1) return t.gridR;
  const ux = fx - ix, uz = fz - iz;
  const c = iz * t.gw + ix, g = t.gdist, g2 = t.gdist2, m = Math.min;
  const a = m(g[c], g2[c]), b = m(g[c + 1], g2[c + 1]), d = m(g[c + t.gw], g2[c + t.gw]), e = m(g[c + t.gw + 1], g2[c + t.gw + 1]);
  return a + (b - a) * ux + (d - a) * uz + (a - b - d + e) * ux * uz;
}

/** The (up to) two stretches of road near (x,z): [dist1, idx1, dist2, idx2], idx -1 when absent. */
export function stretchesAt(t: Track, x: number, z: number, out: Float64Array): void {
  const ix = Math.round(x - t.gx0), iz = Math.round(z - t.gz0);
  if (ix < 0 || iz < 0 || ix >= t.gw || iz >= t.gh) { out[0] = t.gridR; out[1] = -1; out[2] = t.gridR; out[3] = -1; return; }
  const c = iz * t.gw + ix;
  out[0] = t.gdist[c]; out[1] = t.gidx[c]; out[2] = t.gdist2[c]; out[3] = t.gidx2[c];
}

/** Nearest sample on the car's own stretch of road, or -1 when it has left it. */
export function idxAt(t: Track, x: number, z: number, hint: number): number {
  const ix = Math.round(x - t.gx0), iz = Math.round(z - t.gz0);
  if (ix < 0 || iz < 0 || ix >= t.gw || iz >= t.gh) return -1;
  const c = iz * t.gw + ix;
  let i = t.gidx[c];
  const i2 = t.gidx2[c];
  if (i < 0) return -1;
  if (i2 >= 0 && gap(i2, hint, t.n) < gap(i, hint, t.n)) i = i2;
  return gap(i, hint, t.n) > 60 ? -1 : i;
}

/** Elevation at distance s along the lap. */
export function heightAtS(t: Track, s: number): number {
  const f = (((s / t.ds) % t.n) + t.n) % t.n;
  const i = Math.floor(f), j = (i + 1) % t.n;
  return t.h[i] + (t.h[j] - t.h[i]) * (f - i);
}

/** Distance along a ray until it leaves the tarmac, capped at range. Sphere-traced. */
export function rayToEdge(t: Track, x: number, z: number, dx: number, dz: number, range: number, hint: number): number {
  let d = 0;
  for (let i = 0; i < 40; i++) {
    const edge = t.hw - distAt(t, x + dx * d, z + dz * d, hint);
    if (edge <= 0.05) return d;
    d += edge > 0.5 ? edge : 0.5;
    if (d >= range) return range;
  }
  return d < range ? d : range;
}
