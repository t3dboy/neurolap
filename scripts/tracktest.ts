import { generateTrack, STYLE_IDS, styleForSeed, buildCustomTrack } from '../src/track';
const counts: Record<string, number> = {};
let worst = 0, fail = 0;
for (const style of STYLE_IDS) {
  let ok = 0; const lens: number[] = []; let tmax = 0;
  const N = style === 'endurance' ? 8 : 12;
  for (let seed = 1; seed <= N; seed++) {
    const t0 = performance.now();
    const t = generateTrack(seed, style);
    const ms = performance.now() - t0; tmax = Math.max(tmax, ms); worst = Math.max(worst, ms);
    if (t.style === style) ok++;
    lens.push(Math.round(t.length));
  }
  if (ok < N) fail++;
  console.log(`${style.padEnd(10)} ${ok}/${N} as asked | lengths ${lens.join(' ')} | slowest ${tmax.toFixed(0)}ms`);
}
for (let s = 1; s <= 40; s++) { const k = styleForSeed(s); counts[k] = (counts[k] || 0) + 1; }
console.log('auto mix over 40 seeds', counts, 'worst gen', worst.toFixed(0), 'ms');

// hand-drawn shapes, as the editor would hand them over (screen pixels, wobbly)
const wob = (a: number) => Math.sin(a * 7) * 3;
const shapes: Record<string, [number, number][]> = {
  circle: Array.from({ length: 120 }, (_, i) => { const a = (i / 120) * Math.PI * 2; return [300 + Math.cos(a) * 200 + wob(a), 250 + Math.sin(a) * 150 + wob(a + 1)] as [number, number]; }),
  rect: (() => { const P: [number, number][] = []; for (let i = 0; i < 40; i++) P.push([100 + i * 10, 100 + wob(i)]); for (let i = 0; i < 25; i++) P.push([500 + wob(i), 100 + i * 10]); for (let i = 0; i < 40; i++) P.push([500 - i * 10, 350 + wob(i)]); for (let i = 0; i < 25; i++) P.push([100 + wob(i), 350 - i * 10]); return P; })(),
  eight: Array.from({ length: 160 }, (_, i) => { const a = (i / 160) * Math.PI * 2; return [300 + Math.sin(a) * 240, 250 + Math.sin(2 * a) * 110] as [number, number]; }),
  kidney: Array.from({ length: 140 }, (_, i) => { const a = (i / 140) * Math.PI * 2; const r = 1 + 0.35 * Math.cos(2 * a); return [300 + Math.cos(a) * 210 * r, 250 + Math.sin(a) * 130 * r] as [number, number]; }),
};
for (const [name, P] of Object.entries(shapes)) for (const L of [1200, 2500]) {
  const t0 = performance.now();
  const t = buildCustomTrack(P, L, 'parkland');
  const ms = performance.now() - t0;
  const ok = typeof t !== 'string';
  if (!ok && name !== 'eight') fail++;
  console.log(`custom ${name.padEnd(7)} ${L}m: ${ok ? `${Math.round((t as any).length)}m ${(t as any).kind} ${(t as any).name}` : 'REFUSED: ' + t} (${ms.toFixed(0)}ms)`);
}
process.exit(fail ? 1 : 0);
