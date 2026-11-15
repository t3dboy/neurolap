// Car classes: each is a preset setup that gives the car the character of its real-world kind.
import type { TyreId } from './weather';

export interface Setup {
  power: number;      // kW
  grip: number;       // tyre friction coefficient
  downforce: number;  // adds grip with speed, costs drag
  mass: number;       // kg
  brakes: number;     // peak braking in g
  steer: number;      // steering lock in degrees
  balance: number;    // -1 understeer .. +1 oversteer (front/rear grip bias)
  aids: number;       // 0..1 traction and stability control
}

export type CarId = 'f1' | 'proto' | 'gt' | 'rally' | 'muscle' | 'hatch' | 'saloon';
export interface CarClass {
  id: CarId; name: string; kind: string; blurb: string;
  setup: Setup;
  len: number; wid: number;      // metres, before the on-screen scale-up
  headlights: boolean;           // has headlights in real life
  rainLight: boolean;            // flashing red light at the back in the wet
  offroad: number;               // share of grip kept on grass
  tyre: TyreId;                  // what it leaves the garage on
  front: [number, number, number]; rear: [number, number, number]; // lamp positions (x fwd, y up, z half-spacing)
  susp: Suspension;
  wheels: Wheels;
  spray: number;                 // how much water the car throws up (open wheels throw far more)
}
/** How the body rides on its springs. Angles are per g of acceleration. */
export interface Suspension {
  freq: number;    // natural frequency of the springs, Hz: about 1.3 for a soft road car, over 4 for a racing car
  damp: number;    // damping ratio: under 0.5 wallows, around 0.7 is taut
  roll: number;    // degrees of body roll per g of cornering
  pitch: number;   // degrees of dive or squat per g of braking or acceleration
  cg: number;      // height of the centre of gravity, m: sets how much weight shifts between the tyres
}
export interface Wheels { fx: number; rx: number; fz: number; rz: number; fr: number; rr: number; fw: number; rw: number; open: boolean }

export const CAR_CLASSES: Record<CarId, CarClass> = {
  f1: {
    id: 'f1', name: 'Formula racer', kind: 'Open-wheel single-seater', blurb: 'Huge downforce and power, brakes like a wall. Fast everywhere, unforgiving.',
    setup: { power: 750, grip: 1.75, downforce: 3.4, mass: 800, brakes: 4.5, steer: 18, balance: 0.1, aids: 0.35 },
    len: 5.6, wid: 2.0, headlights: false, rainLight: true, offroad: 0.5, tyre: 'medium',
    susp: { freq: 4.2, damp: 0.75, roll: 0.35, pitch: 0.3, cg: 0.27 }, wheels: { fx: 1.78, rx: -1.6, fz: 0.95, rz: 0.9, fr: 0.36, rr: 0.4, fw: 0.4, rw: 0.5, open: true }, spray: 1.7,
    front: [2.7, 0.35, 0.5], rear: [-2.75, 0.62, 0],
  },
  proto: {
    id: 'proto', name: 'Endurance prototype', kind: 'Closed-cockpit sports prototype', blurb: 'Closed-cockpit downforce car built to race through the night.',
    setup: { power: 520, grip: 1.55, downforce: 2.6, mass: 1030, brakes: 3.2, steer: 20, balance: 0, aids: 0.55 },
    len: 4.9, wid: 2.0, headlights: true, rainLight: true, offroad: 0.5, tyre: 'medium',
    susp: { freq: 3.2, damp: 0.7, roll: 0.8, pitch: 0.6, cg: 0.33 }, wheels: { fx: 1.5, rx: -1.5, fz: 0.92, rz: 0.92, fr: 0.4, rr: 0.4, fw: 0.42, rw: 0.42, open: false }, spray: 1.0,
    front: [2.45, 0.55, 0.78], rear: [-2.45, 0.7, 0.8],
  },
  gt: {
    id: 'gt', name: 'GT racer', kind: 'GT sports car', blurb: 'A road supercar turned racer: wing, slicks, plenty of grunt.',
    setup: { power: 410, grip: 1.35, downforce: 1.6, mass: 1300, brakes: 2.0, steer: 24, balance: 0.1, aids: 0.65 },
    len: 4.6, wid: 2.0, headlights: true, rainLight: false, offroad: 0.55, tyre: 'medium',
    susp: { freq: 2.5, damp: 0.65, roll: 1.6, pitch: 1.1, cg: 0.42 }, wheels: { fx: 1.42, rx: -1.42, fz: 0.98, rz: 0.98, fr: 0.44, rr: 0.44, fw: 0.42, rw: 0.42, open: false }, spray: 0.9,
    front: [2.3, 0.62, 0.7], rear: [-2.3, 0.78, 0.72],
  },
  rally: {
    id: 'rally', name: 'Rally car', kind: 'Rally hatchback', blurb: 'Tail-happy, tough, and the only one that likes grass and snow.',
    setup: { power: 280, grip: 1.1, downforce: 0.5, mass: 1230, brakes: 1.5, steer: 30, balance: 0.3, aids: 0.4 },
    len: 4.1, wid: 1.85, headlights: true, rainLight: false, offroad: 0.9, tyre: 'medium',
    susp: { freq: 1.7, damp: 0.55, roll: 3.2, pitch: 2.4, cg: 0.52 }, wheels: { fx: 1.28, rx: -1.28, fz: 0.92, rz: 0.92, fr: 0.46, rr: 0.46, fw: 0.38, rw: 0.38, open: false }, spray: 1.0,
    front: [2.05, 0.78, 0.62], rear: [-2.05, 0.95, 0.66],
  },
  muscle: {
    id: 'muscle', name: 'Muscle car', kind: 'V8 coupe', blurb: 'Big engine, big weight, small brakes. Straights good, corners optional.',
    setup: { power: 360, grip: 1.0, downforce: 0.1, mass: 1750, brakes: 1.1, steer: 26, balance: 0.35, aids: 0.3 },
    len: 5.0, wid: 2.0, headlights: true, rainLight: false, offroad: 0.6, tyre: 'hard',
    susp: { freq: 1.35, damp: 0.42, roll: 4.6, pitch: 3.4, cg: 0.56 }, wheels: { fx: 1.55, rx: -1.5, fz: 1.0, rz: 1.0, fr: 0.46, rr: 0.46, fw: 0.44, rw: 0.44, open: false }, spray: 0.9,
    front: [2.48, 0.66, 0.72], rear: [-2.48, 0.74, 0.74],
  },
  hatch: {
    id: 'hatch', name: 'Hot hatch', kind: 'Front-drive hatchback', blurb: 'Light, eager and safe. Understeers before it bites.',
    setup: { power: 200, grip: 1.08, downforce: 0.2, mass: 1300, brakes: 1.3, steer: 30, balance: -0.3, aids: 0.85 },
    len: 4.0, wid: 1.8, headlights: true, rainLight: false, offroad: 0.65, tyre: 'hard',
    susp: { freq: 1.6, damp: 0.5, roll: 3.8, pitch: 2.6, cg: 0.54 }, wheels: { fx: 1.25, rx: -1.25, fz: 0.9, rz: 0.9, fr: 0.42, rr: 0.42, fw: 0.36, rw: 0.36, open: false }, spray: 0.8,
    front: [2.0, 0.7, 0.62], rear: [-2.0, 0.9, 0.64],
  },
  saloon: {
    id: 'saloon', name: 'Family saloon', kind: 'Ordinary road car', blurb: 'The school run, flat out. Slow, soft, every driver aid switched on.',
    setup: { power: 110, grip: 0.92, downforce: 0, mass: 1450, brakes: 1.0, steer: 30, balance: -0.4, aids: 1.0 },
    len: 4.7, wid: 1.82, headlights: true, rainLight: false, offroad: 0.65, tyre: 'hard',
    susp: { freq: 1.25, damp: 0.4, roll: 5.2, pitch: 3.6, cg: 0.58 }, wheels: { fx: 1.45, rx: -1.45, fz: 0.9, rz: 0.9, fr: 0.42, rr: 0.42, fw: 0.36, rw: 0.36, open: false }, spray: 0.8,
    front: [2.33, 0.68, 0.64], rear: [-2.33, 0.8, 0.66],
  },
};
export const CAR_IDS = Object.keys(CAR_CLASSES) as CarId[];
