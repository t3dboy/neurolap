export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(r: Rng): number {
  let u = 0;
  while (u < 1e-9) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

// Smooth 2D value noise, deterministic per seed.
export function makeNoise(seed: number) {
  const r = mulberry32(seed);
  const perm = new Float32Array(4096);
  for (let i = 0; i < 4096; i++) perm[i] = r();
  const h = (x: number, y: number) => perm[((x * 73856093) ^ (y * 19349663)) & 4095];
  const base = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
  // fbm in roughly [-1, 1]
  return (x: number, y: number, oct = 4) => {
    let v = 0, amp = 1, f = 1, tot = 0;
    for (let o = 0; o < oct; o++) {
      v += (base(x * f + o * 17.3, y * f - o * 9.1) * 2 - 1) * amp;
      tot += amp; amp *= 0.5; f *= 2.03;
    }
    return v / tot;
  };
}
