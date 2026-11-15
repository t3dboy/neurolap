// Conditions: time of day, weather, tyres, and the state of the road surface (water and snow
// lying on it), which the physics reads for grip and the renderer reads for the wet look.
import type { Track } from './track';

export type TyreId = 'soft' | 'medium' | 'hard' | 'inter' | 'wet' | 'winter';
export interface TyreDef {
  id: TyreId; name: string; short: string; color: string;
  dry: number; wet: number; snow: number;  // grip multiplier on a dry, soaked and snowy road
  wearLap: number;                         // share of its life used per lap at a balanced pace
  dryPenalty: number;                      // extra wear when a rain tyre runs on a dry road
}
export const TYRES: Record<TyreId, TyreDef> = {
  soft: { id: 'soft', name: 'Soft', short: 'S', color: '#ff4040', dry: 1.05, wet: 0.5, snow: 0.2, wearLap: 0.1, dryPenalty: 1 },
  medium: { id: 'medium', name: 'Medium', short: 'M', color: '#ffd23d', dry: 1.0, wet: 0.52, snow: 0.22, wearLap: 0.062, dryPenalty: 1 },
  hard: { id: 'hard', name: 'Hard', short: 'H', color: '#f2f2f2', dry: 0.96, wet: 0.52, snow: 0.22, wearLap: 0.04, dryPenalty: 1 },
  inter: { id: 'inter', name: 'Intermediate', short: 'I', color: '#3fcf5a', dry: 0.9, wet: 0.8, snow: 0.36, wearLap: 0.06, dryPenalty: 3 },
  wet: { id: 'wet', name: 'Full wet', short: 'W', color: '#3e8ef0', dry: 0.82, wet: 0.9, snow: 0.42, wearLap: 0.055, dryPenalty: 4 },
  winter: { id: 'winter', name: 'Winter', short: 'X', color: '#a8d8ff', dry: 0.84, wet: 0.78, snow: 0.74, wearLap: 0.06, dryPenalty: 2 },
};
export const TYRE_IDS = Object.keys(TYRES) as TyreId[];

export type WeatherKind = 'dry' | 'rain' | 'snow';
export interface Env {
  time: number;        // hour of the day, 0..24
  weather: WeatherKind;
  intensity: number;   // 0..1 how hard it is raining or snowing
}

/** Sun height: -1 (deep night) .. 0 (horizon) .. 1 (overhead at noon). Sunrise 6:00, sunset 20:00. */
export function sunHeight(time: number): number {
  const f = (time - 6) / 14;
  if (f >= 0 && f <= 1) return Math.sin(Math.PI * f);
  const g = time < 6 ? (time + 4) / 10 : (time - 20) / 10; // through the night
  return -Math.sin(Math.PI * g);
}
/** 0 at night, 1 in full daylight. */
export function daylight(time: number): number {
  const s = sunHeight(time);
  return s <= -0.12 ? 0 : s >= 0.25 ? 1 : (s + 0.12) / 0.37;
}

const sstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export const BINS = 13; // strips across the width of the road

export class Surface {
  track: Track; env: Env;
  n: number;
  water: Float32Array;   // 0 dry .. 1 standing water, per track sample x strip
  snow: Float32Array;    // 0 clear .. 1 deep loose snow
  groundWet = 0;         // the land around the track
  groundSnow = 0;
  version = 0;
  private acc = 0;

  constructor(track: Track, env: Env) {
    this.track = track; this.env = env; this.n = track.n;
    this.water = new Float32Array(track.n * BINS);
    this.snow = new Float32Array(track.n * BINS);
  }

  /** Jump straight to how things would be after a long spell of the current weather. */
  settle() {
    for (let k = 0; k < 400; k++) this.update(0.5);
  }

  step(dt: number) {
    this.acc += dt;
    if (this.acc >= 0.25) { this.update(this.acc); this.acc = 0; }
  }

  private update(dt: number) {
    const e = this.env, k = e.intensity, sun = daylight(e.time);
    const raining = e.weather === 'rain' && k > 0.02, snowing = e.weather === 'snow' && k > 0.02;
    const W = this.water, S = this.snow;
    const fill = dt * 0.045 * (0.35 + 0.65 * k), dry = dt * (0.005 + 0.011 * sun);
    const fall = dt * 0.028 * (0.3 + 0.7 * k), melt = dt * (0.0012 + 0.0045 * sun);
    for (let b = 0; b < BINS; b++) {
      const edge = Math.abs((b / (BINS - 1)) * 2 - 1);
      // roads are crowned: water runs to the edges and lingers there
      const cap = (0.5 + 0.5 * k) * (0.68 + 0.32 * edge * edge), dr = dry * (1.3 - 0.65 * edge);
      for (let i = b; i < W.length; i += BINS) {
        let w = W[i], s = S[i];
        if (raining) { if (w < cap) { w += fill; if (w > cap) w = cap; } else w -= dt * 0.01; }
        else if (w > 0) w -= snowing ? dr * 0.4 : dr;
        if (snowing) { s += fall; if (s > 1) s = 1; }
        else if (s > 0) { const m = raining ? melt * 4 : melt; s -= m; if (!raining && w < 0.75) w += m * 0.6; }
        W[i] = w < 0 ? 0 : w; S[i] = s < 0 ? 0 : s;
      }
    }
    if (raining) this.groundWet = Math.min(1, this.groundWet + dt * 0.05 * (0.4 + 0.6 * k));
    else this.groundWet = Math.max(0, this.groundWet - dt * (0.004 + 0.008 * sun));
    if (snowing) this.groundSnow = Math.min(1, this.groundSnow + dt * 0.022 * (0.3 + 0.7 * k));
    else this.groundSnow = Math.max(0, this.groundSnow - dt * (raining ? 0.012 : 0.001 + 0.003 * sun));
    this.version++;
  }

  private bin(lat: number): number {
    const f = (lat / this.track.hw) * 0.5 + 0.5;
    return f < 0 || f > 1 ? -1 : Math.round(f * (BINS - 1));
  }

  /** A car's tyres push water and snow aside: this is what makes a dry line (or ruts in snow). */
  carPass(idx: number, lat: number, v: number, dt: number) {
    const kw = Math.min(0.9, 2.4 * dt * Math.min(1, v / 20)), ks = Math.min(0.9, 3.2 * dt * Math.min(1, v / 15));
    const n = this.n, W = this.water, S = this.snow;
    for (let side = -1; side <= 1; side += 2) {
      const b = this.bin(lat + side * 1.0);
      if (b < 0) continue;
      for (let d = -2; d <= 2; d++) {
        const c = (((idx + d) % n) + n) % n * BINS + b;
        W[c] *= 1 - kw; S[c] *= 1 - ks;
      }
    }
  }

  waterAt(idx: number, lat: number): number { const b = this.bin(lat); return b < 0 ? this.groundWet : this.water[idx * BINS + b]; }
  snowAt(idx: number, lat: number): number { const b = this.bin(lat); return b < 0 ? this.groundSnow : this.snow[idx * BINS + b]; }

  /** Grip multiplier for a tyre on the tarmac at this spot. */
  gripAt(idx: number, lat: number, tyre: TyreDef): number {
    const b = this.bin(lat);
    const w = b < 0 ? this.groundWet : this.water[idx * BINS + b], s = b < 0 ? this.groundSnow : this.snow[idx * BINS + b];
    let g = tyre.dry + (tyre.wet - tyre.dry) * sstep(0.04, 0.5, w);
    if (s > 0.03) g += (tyre.snow - g) * sstep(0.03, 0.4, s);
    return g;
  }

  /** Grip multiplier off the tarmac, on grass or gravel. */
  offGrip(carOffroad: number): number {
    return carOffroad * (1 - 0.3 * this.groundWet) * (1 - 0.4 * this.groundSnow);
  }

  /** How wet the driven part of the road is on average (0..1), for strategy calls. */
  lineWater(): number {
    let s = 0, c = 0;
    for (let i = 0; i < this.n; i += 4) for (let b = 4; b <= 8; b++) { s += this.water[i * BINS + b]; c++; }
    return s / c;
  }
  lineSnow(): number {
    let s = 0, c = 0;
    for (let i = 0; i < this.n; i += 4) for (let b = 4; b <= 8; b++) { s += this.snow[i * BINS + b]; c++; }
    return s / c;
  }
}
