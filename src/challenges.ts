// Setup challenges and championship upgrades share one idea: performance parts cost money.
// Making the car faster than its standard setup spends parts; giving something back
// (less power, more weight) refunds half. Balance, steering lock and driver aids are tuning,
// not parts, so they are free.
import { Setup, CarId, CAR_CLASSES } from './cars';
import { StyleId } from './track';
import { WeatherKind } from './weather';

interface Price { key: keyof Setup; unit: (base: Setup) => number; price: number; better: 1 | -1; label: string }
const PRICES: Price[] = [
  { key: 'power', unit: (b) => b.power * 0.05, price: 1, better: 1, label: 'engine' },
  { key: 'grip', unit: () => 0.05, price: 1.5, better: 1, label: 'tyres and suspension' },
  { key: 'downforce', unit: () => 0.2, price: 1, better: 1, label: 'aero' },
  { key: 'mass', unit: (b) => b.mass * 0.025, price: 1, better: -1, label: 'weight saving' },
  { key: 'brakes', unit: () => 0.15, price: 0.5, better: 1, label: 'brakes' },
];
export const PART_KEYS = PRICES.map((p) => p.key);

/** Parts spent going from `base` to `s`. Improvements cost their price; give-backs refund half. */
export function partsCost(s: Setup, base: Setup): number {
  let c = 0;
  for (const p of PRICES) {
    const u = ((s[p.key] - base[p.key]) * p.better) / p.unit(base);
    c += u > 0 ? u * p.price : u * p.price * 0.5;
  }
  return Math.round(c * 10) / 10;
}

export interface Challenge {
  id: string; title: string; blurb: string;
  seed: number; style: StyleId; car: CarId; budget: number; target: number;
  weather?: WeatherKind; intensity?: number;
}

// Targets were set by training each challenge headlessly (scripts/challengecal.ts): the
// standard car, however long it trains, does not get there; a sensible spend of the budget does.
export const CHALLENGES: Challenge[] = [
  { id: 'hatch-classic', title: 'Hot hatch', blurb: 'A shopping car on a proper Grand Prix circuit. Find the time without blowing the budget.', seed: 12, style: 'classic', car: 'hatch', budget: 8, target: 31.6 },
  { id: 'saloon-speed', title: 'Saloon on a diet', blurb: 'Long straights reward power, the chicanes punish weight. Where do the parts go?', seed: 7, style: 'speed', car: 'saloon', budget: 10, target: 42.8 },
  { id: 'gt-street', title: 'Street fight', blurb: 'Walls everywhere. Grip and brakes, or engine?', seed: 5, style: 'street', car: 'gt', budget: 10, target: 36.3 },
  { id: 'rally-eight', title: 'Over the bridge', blurb: 'A rally car on a figure of eight, over the bridge and under it.', seed: 3, style: 'eight', car: 'rally', budget: 10, target: 44.6 },
  { id: 'f1-wet', title: 'Rain master', blurb: 'The formula racer on a technical track in the rain. Power is no use if you cannot put it down.', seed: 9, style: 'technical', car: 'f1', budget: 12, target: 47.3, weather: 'rain', intensity: 0.7 },
  { id: 'proto-hell', title: 'Green hell', blurb: 'Five kilometres of forest in an endurance prototype. Patience.', seed: 4, style: 'endurance', car: 'proto', budget: 12, target: 135.5 },
];

// ---------------------------------------------------------------- championship upgrades
export type UpKey = 'engine' | 'aero' | 'grip' | 'weight' | 'brakes';
export const UPGRADES: Record<UpKey, { label: string; blurb: string; apply: (s: Setup, base: Setup) => void }> = {
  engine: { label: 'Engine', blurb: '+5% power', apply: (s, b) => { s.power = Math.round(s.power + b.power * 0.05); } },
  aero: { label: 'Aero', blurb: '+0.2 downforce', apply: (s) => { s.downforce = Math.round((s.downforce + 0.2) * 10) / 10; } },
  grip: { label: 'Suspension', blurb: '+0.05 grip', apply: (s) => { s.grip = Math.round((s.grip + 0.05) * 100) / 100; } },
  weight: { label: 'Weight saving', blurb: '-2.5% weight', apply: (s, b) => { s.mass = Math.round(s.mass - b.mass * 0.025); } },
  brakes: { label: 'Brakes', blurb: '+0.15 g', apply: (s) => { s.brakes = Math.round((s.brakes + 0.15) * 100) / 100; } },
};
export const UP_KEYS = Object.keys(UPGRADES) as UpKey[];
export const UP_MAX = 4;
export const upCost = (level: number) => 12 + level * 8;

/** The car a championship team has built: the standard setup plus every upgrade bought. */
export function seasonSetup(car: CarId, up: Partial<Record<UpKey, number>>): Setup {
  const base = CAR_CLASSES[car].setup, s = { ...base };
  for (const k of UP_KEYS) for (let i = 0; i < (up[k] ?? 0); i++) UPGRADES[k].apply(s, base);
  return s;
}
