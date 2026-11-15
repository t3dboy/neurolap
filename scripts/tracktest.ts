import { generateTrack, STYLE_IDS, styleForSeed } from '../src/track';
const counts: Record<string, number> = {};
let worst = 0;
for (const style of STYLE_IDS) {
  let ok = 0; const lens: number[] = []; let tmax = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const t0 = performance.now();
    const t = generateTrack(seed, style);
    const ms = performance.now() - t0; tmax = Math.max(tmax, ms); worst = Math.max(worst, ms);
    if (t.style === style) ok++;
    lens.push(Math.round(t.length));
  }
  console.log(`${style.padEnd(10)} ${ok}/12 as asked | lengths ${lens.join(' ')} | slowest ${tmax.toFixed(0)}ms`);
}
for (let s = 1; s <= 40; s++) { const k = styleForSeed(s); counts[k] = (counts[k] || 0) + 1; }
console.log('auto mix over 40 seeds', counts, 'worst gen', worst.toFixed(0), 'ms');
