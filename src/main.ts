import * as THREE from 'three';
import { generateTrack, Track, STYLES, STYLE_IDS, StyleId } from './track';
import { Trainer, Setup, AiConfig, DEFAULT_AI, N_IN, N_RAYS, N_OUT } from './sim';
import { View, Frame, PALETTE, GOLD } from './view';
import { CAR_CLASSES, CAR_IDS, CarId } from './cars';
import { Env, Surface, TYRES, TYRE_IDS, TyreId, WeatherKind, sunHeight } from './weather';
import { Race, RaceOpts, PACE, Pace, TEAMS, Entry } from './race';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => Array.from(document.querySelectorAll<T>(sel));
const KEY = 'neurolap.v2', SEASON = 'neurolap.season';

// ---------------------------------------------------------------- saved state
interface Saved {
  seed: number; style: StyleId | 'any'; car: CarId; setup: Setup; tyre: TyreId; ai: AiConfig;
  env: Env; headlights: 'auto' | 'on' | 'off'; pane: string | null; folds: Record<string, boolean>; hud: boolean;
  race: RaceOpts;
}
function load(): Saved {
  const d: Saved = {
    seed: 1 + Math.floor(Math.random() * 9999), style: 'any', car: 'gt', setup: { ...CAR_CLASSES.gt.setup }, tyre: CAR_CLASSES.gt.tyre, ai: { ...DEFAULT_AI },
    env: { time: 13, weather: 'dry', intensity: 0.6 }, headlights: 'auto', pane: 'car', folds: {}, hud: true,
    race: { laps: 5, difficulty: 1, forecast: 'current', startTyre: 'medium' },
  };
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s && s.seed) return { ...d, ...s, setup: { ...d.setup, ...s.setup }, ai: { ...d.ai, ...s.ai }, env: { ...d.env, ...s.env }, race: { ...d.race, ...s.race } };
  } catch { /* fresh start */ }
  return d;
}
const state = load();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode */ } };
const env = state.env;

// ---------------------------------------------------------------- world
const view = new View($<HTMLCanvasElement>('c'));
view.env = env; view.headlights = state.headlights;
let track!: Track, surf!: Surface, trainer!: Trainer;
let race: Race | null = null;
let mode: 'practice' | 'race' = 'practice';
let speed = 1;
let cycle = false, timeTarget: number | null = null;
let camTarget: 'overview' | 'follow' | 'leader' = 'overview';
let announced: number | null = null;
let readyNote = false;

const fmtLap = (t: number | null | undefined) => (t == null ? '-' : t.toFixed(2) + 's');
const fmtClock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const fmtTime = (h: number) => `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
let toastTimer = 0;
function toast(msg: string) {
  const el = $('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 2400);
}

function buildTrack() {
  track = generateTrack(state.seed, state.style === 'any' ? undefined : state.style);
  surf = new Surface(track, env);
  if (env.weather !== 'dry') surf.settle();
  trainer = new Trainer(track, state.setup, CAR_CLASSES[state.car], state.ai, surf, state.tyre);
  view.setTrack(track, surf);
  race = null; announced = null; readyNote = false;
  if (mode !== 'practice') setMode('practice');
  const S = STYLES[track.style];
  $('tName').textContent = track.name;
  $('tMeta').textContent = `${S.label} · ${Math.round(track.length)} m`;
  $<HTMLInputElement>('seed').value = String(state.seed);
  let tight = 0;
  for (let i = 0; i < track.n; i++) tight = Math.max(tight, Math.abs(track.curv[i]));
  $('trackInfo').textContent = `${S.label}, in the spirit of ${S.inspired}: ${S.blurb}. ${Math.round(track.length)} m lap, ${Math.round(track.maxH)} m of climb, road ${(track.hw * 2).toFixed(0)} m wide, tightest corner ${Math.round(1 / tight)} m radius. The same seed and style always give the same track.`;
  paintStyles();
}
function newTrack(seed: number) { state.seed = seed; save(); buildTrack(); }

function carChanged(note: string | null) {
  save();
  const cls = CAR_CLASSES[state.car];
  trainer.setCar(state.setup, cls, state.tyre);
  announced = null; readyNote = false;
  const tuned = (Object.keys(cls.setup) as (keyof Setup)[]).some((k) => Math.abs(cls.setup[k] - state.setup[k]) > 1e-9);
  $('setupTag').textContent = tuned ? 'tuned' : '';
  $('cName').textContent = cls.name;
  $('cMeta').textContent = `${state.setup.power} kW · ${state.setup.mass} kg · ${TYRES[state.tyre].name.toLowerCase()}s`;
  if (note) toast(note);
}
function pickCar(id: CarId) {
  state.car = id; state.setup = { ...CAR_CLASSES[id].setup }; state.tyre = CAR_CLASSES[id].tyre;
  view.setCarClass(CAR_CLASSES[id]);
  buildCarPane();
  carChanged(`${CAR_CLASSES[id].name}: the drivers have to learn it`);
}

// ---------------------------------------------------------------- sliders
interface Def<T> { key: keyof T; label: string; min: number; max: number; step: number; fmt: (v: number) => string; lo: string; hi: string; color: string }
const CAR: Def<Setup>[] = [
  { key: 'power', label: 'Engine power', min: 60, max: 800, step: 10, fmt: (v) => `${v} kW`, lo: 'gentle', hi: 'wheelspin', color: '#ea4f4b' },
  { key: 'grip', label: 'Mechanical grip', min: 0.6, max: 2, step: 0.05, fmt: (v) => v.toFixed(2), lo: 'skates', hi: 'glued', color: '#3d4a5c' },
  { key: 'downforce', label: 'Downforce', min: 0, max: 4, step: 0.1, fmt: (v) => v.toFixed(1), lo: 'slippery, fast', hi: 'planted, draggy', color: '#4aa8e8' },
  { key: 'mass', label: 'Weight', min: 500, max: 2200, step: 10, fmt: (v) => `${v} kg`, lo: 'featherweight', hi: 'tank', color: '#b07cf0' },
  { key: 'brakes', label: 'Brakes', min: 0.5, max: 5, step: 0.05, fmt: (v) => `${v.toFixed(2)} g`, lo: 'weak', hi: 'anchors', color: '#ffa53d' },
  { key: 'steer', label: 'Steering lock', min: 8, max: 40, step: 1, fmt: (v) => `${v}°`, lo: 'lazy', hi: 'twitchy', color: '#40d6b0' },
  { key: 'balance', label: 'Balance', min: -1, max: 1, step: 0.05, fmt: (v) => (Math.abs(v) < 0.01 ? 'neutral' : v < 0 ? `under ${(-v).toFixed(2)}` : `over ${v.toFixed(2)}`), lo: 'understeer', hi: 'oversteer', color: '#ff7fc0' },
  { key: 'aids', label: 'Driver aids', min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%`, lo: 'raw', hi: 'safe', color: '#6fdc5a' },
];
const AI: Def<AiConfig>[] = [
  { key: 'population', label: 'Cars per generation', min: 12, max: 96, step: 4, fmt: (v) => `${v}`, lo: 'few', hi: 'many', color: '#4aa8e8' },
  { key: 'mutation', label: 'Mutation', min: 0.02, max: 0.5, step: 0.01, fmt: (v) => v.toFixed(2), lo: 'careful', hi: 'wild', color: '#ea4f4b' },
  { key: 'vision', label: 'Vision range', min: 15, max: 120, step: 5, fmt: (v) => `${v} m`, lo: 'short-sighted', hi: 'eagle', color: '#ffa53d' },
  { key: 'hidden', label: 'Brain size', min: 4, max: 24, step: 1, fmt: (v) => `${v} neurons`, lo: 'simple', hi: 'big (restarts)', color: '#b07cf0' },
];
function paintRange(input: HTMLInputElement, color?: string) {
  const min = Number(input.min), max = Number(input.max);
  input.style.setProperty('--p', `${((Number(input.value) - min) / (max - min)) * 100}%`);
  if (color) input.style.setProperty('--c', color);
}
function buildSliders<T extends object>(host: HTMLElement, defs: Def<T>[], obj: T, onChange: (key: keyof T) => void) {
  host.innerHTML = '';
  for (const d of defs) {
    const wrap = document.createElement('div');
    wrap.className = 'slider';
    wrap.innerHTML = `<div class="top"><span>${d.label}</span><b></b></div><input type="range" min="${d.min}" max="${d.max}" step="${d.step}" /><div class="ends"><span>${d.lo}</span><span>${d.hi}</span></div>`;
    const input = wrap.querySelector('input')!, val = wrap.querySelector('b')!;
    const paint = () => { val.textContent = d.fmt(Number(input.value)); paintRange(input, d.color); };
    input.value = String(obj[d.key]);
    paint();
    input.addEventListener('input', paint);
    input.addEventListener('change', () => { (obj as any)[d.key] = Number(input.value); onChange(d.key); });
    host.appendChild(wrap);
  }
}
function tyreButtons(host: HTMLElement, current: () => TyreId, pick: (t: TyreId) => void) {
  host.innerHTML = '';
  for (const id of TYRE_IDS) {
    const b = document.createElement('button');
    b.className = 'tyreBtn'; b.textContent = TYRES[id].short; b.title = TYRES[id].name; b.style.setProperty('--tc', TYRES[id].color);
    b.classList.toggle('sel', current() === id);
    b.onclick = () => { pick(id); host.querySelectorAll('.tyreBtn').forEach((x, k) => x.classList.toggle('sel', TYRE_IDS[k] === current())); };
    host.appendChild(b);
  }
}

// ---------------------------------------------------------------- panes
function paintStyles() {
  const host = $('styleList');
  host.innerHTML = '';
  const add = (id: StyleId | 'any', title: string, sub: string) => {
    const b = document.createElement('button');
    b.className = 'pick' + (state.style === id ? ' sel' : '');
    b.innerHTML = `<b>${title}</b><span>${sub}</span>`;
    b.onclick = () => { state.style = id; save(); buildTrack(); };
    host.appendChild(b);
  };
  add('any', 'Surprise me', 'the seed picks the style');
  for (const id of STYLE_IDS) add(id, STYLES[id].label, `like ${STYLES[id].inspired}: ${STYLES[id].blurb}`);
}
function buildCarPane() {
  const host = $('carList');
  host.innerHTML = ''; host.className = 'cards two';
  for (const id of CAR_IDS) {
    const c = CAR_CLASSES[id], b = document.createElement('button');
    b.className = 'pick' + (state.car === id ? ' sel' : '');
    b.innerHTML = `<b>${c.name}</b>`;
    b.onclick = () => pickCar(id);
    host.appendChild(b);
  }
  const cur = CAR_CLASSES[state.car];
  $('carBlurb').textContent = `${cur.kind}. ${cur.blurb}${cur.headlights ? '' : ' No headlights, as in real life: just a rain light.'}`;
  const tyreInfo = () => { const t = TYRES[state.tyre]; $('tyreInfo').textContent = `${t.name}: grip ${Math.round(t.dry * 100)}% dry, ${Math.round(t.wet * 100)}% wet, ${Math.round(t.snow * 100)}% snow.`; };
  tyreButtons($('tyreList'), () => state.tyre, (t) => { state.tyre = t; tyreInfo(); carChanged(`${TYRES[t].name} tyres fitted`); });
  tyreInfo();
  buildSliders($('carSliders'), CAR, state.setup, () => carChanged('New setup: the drivers have to relearn the car'));
}
function buildDriverPane() {
  buildSliders($('aiSliders'), AI, state.ai, (k) => {
    save(); trainer.setAi(state.ai);
    if (k === 'hidden') { announced = null; toast('New brain: learning from scratch'); }
  });
}
function openPane(name: string | null) {
  state.pane = name; save();
  $('panel').classList.toggle('open', !!name);
  $$('#rail button').forEach((b) => b.classList.toggle('sel', b.dataset.pane === name));
  $$('.pane').forEach((p) => p.classList.toggle('show', p.dataset.pane === name));
  layout();
}
$$('#rail button').forEach((b) => (b.onclick = () => openPane(state.pane === b.dataset.pane ? null : b.dataset.pane!)));
$('trackChip').onclick = () => openPane(state.pane === 'track' ? null : 'track');
$('carChip').onclick = () => openPane(state.pane === 'car' ? null : 'car');
$('newTrack').onclick = $('rollTrack').onclick = () => newTrack(1 + Math.floor(Math.random() * 99999));
$<HTMLInputElement>('seed').onchange = (e) => newTrack(Math.max(1, Math.floor(Number((e.target as HTMLInputElement).value) || 1)));
$('resetCar').onclick = () => { state.setup = { ...CAR_CLASSES[state.car].setup }; buildCarPane(); carChanged('Back to the standard setup'); };
$('resetBrain').onclick = () => { trainer.resetBrains(); announced = null; readyNote = false; toast('Wiped. Back to knowing nothing'); };

// ---------------------------------------------------------------- sky and weather
function syncSky() {
  for (const id of ['timeQ', 'timeP']) { const el = $<HTMLInputElement>(id); el.value = String(env.time); }
  $('clock').textContent = $('clock2').textContent = fmtTime(env.time);
  const night = sunHeight(env.time) < 0;
  $('themeBtn').textContent = night ? '☾' : '☀';
  $$('#wxSeg button, #wxSeg2 button').forEach((b) => b.classList.toggle('sel', b.dataset.wx === env.weather));
  const wet = env.weather !== 'dry';
  $('wxQ').style.visibility = wet ? 'visible' : 'hidden';
  $('wxWrap').style.display = wet ? '' : 'none';
  for (const id of ['wxQ', 'wxP']) { const el = $<HTMLInputElement>(id); el.value = String(env.intensity); paintRange(el, env.weather === 'snow' ? '#a8d8ff' : '#4aa8e8'); }
  $('wxVal').textContent = `${Math.round(env.intensity * 100)}%`;
  $('cycleBtn').classList.toggle('on', cycle);
  $('lightBtn').textContent = `Headlights: ${state.headlights}`;
}
function setTime(h: number) { env.time = ((h % 24) + 24) % 24; timeTarget = null; syncSky(); save(); }
function setWeather(kind: WeatherKind, intensity?: number) {
  env.weather = kind;
  if (intensity !== undefined) env.intensity = intensity;
  if (race) race.manualWeather = true;
  syncSky(); save();
}
for (const id of ['timeQ', 'timeP']) $<HTMLInputElement>(id).addEventListener('input', (e) => setTime(Number((e.target as HTMLInputElement).value)));
for (const id of ['wxQ', 'wxP']) $<HTMLInputElement>(id).addEventListener('input', (e) => setWeather(env.weather, Number((e.target as HTMLInputElement).value)));
$$('#wxSeg button, #wxSeg2 button').forEach((b) => (b.onclick = () => setWeather(b.dataset.wx as WeatherKind)));
// the sun/moon button sweeps the clock to night or back to day
$('themeBtn').onclick = () => { timeTarget = sunHeight(env.time) < 0.1 ? 13 : 22; cycle = false; };
$('cycleBtn').onclick = () => { cycle = !cycle; timeTarget = null; syncSky(); };
$('lightBtn').onclick = () => {
  state.headlights = state.headlights === 'auto' ? 'on' : state.headlights === 'on' ? 'off' : 'auto';
  view.headlights = state.headlights; syncSky(); save();
};

// ---------------------------------------------------------------- transport and view
function setSpeed(s: number) {
  speed = s;
  $$('#speeds .btn').forEach((b) => b.classList.toggle('sel', Number(b.dataset.speed) === s));
}
$$('#speeds .btn').forEach((b) => (b.onclick = () => setSpeed(Number(b.dataset.speed))));
let lastSpeed = 1;
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) {
    e.preventDefault();
    if (speed === 0) setSpeed(lastSpeed); else { lastSpeed = speed; setSpeed(0); }
  }
});
function setCam(t: typeof camTarget) {
  camTarget = t;
  view.mode = t === 'overview' ? 'overview' : 'follow';
  $('camBtn').textContent = t === 'overview' ? 'Overview' : t === 'leader' ? 'Following leader' : mode === 'race' ? 'Following your car' : 'Following leader';
  $('camBtn').classList.toggle('on', t !== 'overview');
}
$('camBtn').onclick = () => setCam(camTarget === 'overview' ? 'follow' : camTarget === 'follow' && mode === 'race' ? 'leader' : 'overview');
$('lineBtn').onclick = () => { view.showLine = !view.showLine; $('lineBtn').classList.toggle('on', view.showLine); };
$('rayBtn').onclick = () => { view.showRays = !view.showRays; $('rayBtn').classList.toggle('on', view.showRays); };
$('hudBtn').onclick = () => { state.hud = !state.hud; save(); applyHud(); };
function applyHud() { $('hud').classList.toggle('off', !state.hud); $('hudBtn').classList.toggle('on', state.hud); layout(); }
$$('.fold').forEach((card) => {
  const k = card.dataset.fold!;
  card.classList.toggle('shut', !!state.folds[k]);
  card.querySelector<HTMLElement>('.foldBtn')!.onclick = () => { state.folds[k] = !state.folds[k]; card.classList.toggle('shut', state.folds[k]); save(); };
});

const cv = $<HTMLCanvasElement>('c');
let dragging = false, lx = 0, ly = 0;
cv.addEventListener('pointerdown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; cv.setPointerCapture(e.pointerId); cv.classList.add('drag'); });
cv.addEventListener('pointermove', (e) => { if (!dragging || view.mode !== 'overview') return; view.pan(e.clientX - lx, e.clientY - ly); lx = e.clientX; ly = e.clientY; });
cv.addEventListener('pointerup', () => { dragging = false; cv.classList.remove('drag'); });
cv.addEventListener('wheel', (e) => { e.preventDefault(); view.zoom = Math.min(8, Math.max(1, view.zoom * Math.exp(-e.deltaY * 0.0015))); if (view.zoom === 1) { view.panX = 0; view.panY = 0; } }, { passive: false });
cv.addEventListener('dblclick', () => { view.zoom = 1; view.panX = 0; view.panY = 0; });

function layout() {
  const W = window.innerWidth, H = window.innerHeight;
  const rail = $('rail').getBoundingClientRect(), panel = $('panel').getBoundingClientRect();
  view.insetTop = $('top').getBoundingClientRect().bottom + 6;
  view.insetLeft = W > 700 ? (state.pane ? panel.right : rail.right) + 8 : 0;
  view.insetRight = W > 900 && state.hud ? W - $('hud').getBoundingClientRect().left + 8 : 0;
  view.insetBottom = H - (mode === 'race' ? $('dock').getBoundingClientRect().top || H - 140 : $('bar').getBoundingClientRect().top) + 6;
  view.followScale = 0.095; view.lead = 0;
  view.resize();
}
window.addEventListener('resize', layout);

// ---------------------------------------------------------------- practice readouts
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const chart = $<HTMLCanvasElement>('chart').getContext('2d')!;
function drawChart() {
  if (state.folds.curve) return;
  const W = 560, H = 200, g = chart, hs = trainer.history, fg = css('--fg');
  g.clearRect(0, 0, W, H);
  g.fillStyle = css('--field'); g.fillRect(0, 0, W, H);
  const n = Math.max(12, hs.length), x = (i: number) => 8 + ((i + 0.5) / n) * (W - 16);
  const bw = Math.max(2, (W - 16) / n - 2);
  let lo = Infinity, hi = -Infinity;
  for (const h of hs) if (h.bestLap !== null) { lo = Math.min(lo, h.bestLap); hi = Math.max(hi, h.bestLap); }
  for (let i = 0; i < hs.length; i++) {
    const h = hs[i], bh = h.progress * (H - 30);
    g.fillStyle = h.bestLap !== null ? 'rgba(111,220,90,0.35)' : 'rgba(255,165,61,0.45)';
    g.fillRect(x(i) - bw / 2, H - 6 - bh, bw, bh);
    if (h.setupMark) { g.strokeStyle = fg; g.setLineDash([5, 5]); g.lineWidth = 2; g.beginPath(); g.moveTo(x(i) - bw / 2 - 1, 4); g.lineTo(x(i) - bw / 2 - 1, H - 4); g.stroke(); g.setLineDash([]); }
  }
  if (lo < Infinity) {
    const y = (t: number) => 22 + ((t - lo) / Math.max(0.5, hi - lo)) * (H - 60);
    g.strokeStyle = '#ea4f4b'; g.lineWidth = 5; g.lineJoin = 'round'; g.beginPath();
    let started = false;
    for (let i = 0; i < hs.length; i++) { const t = hs[i].bestLap; if (t === null) continue; started ? g.lineTo(x(i), y(t)) : g.moveTo(x(i), y(t)); started = true; }
    g.stroke();
    g.fillStyle = fg; g.font = '800 20px ui-rounded, system-ui'; g.textAlign = 'right';
    g.fillText(`fastest ${lo.toFixed(2)}s`, W - 10, 22);
  }
  $('chartNote').textContent = trainer.setupBest === null ? 'bars: distance' : 'red: lap time, up is faster';
}
const brain = $<HTMLCanvasElement>('brain').getContext('2d')!;
const IN_LABELS = [...Array.from({ length: N_RAYS }, () => 'ray'), 'speed', 'slide', 'spin', 'bend 15m', 'bend 35m', 'bend 60m', 'slope', 'crest', 'grip'];
function drawBrain() {
  if (state.folds.brain) return;
  const W = 560, H = 280, g = brain, fg = css('--fg'), field = css('--field');
  g.clearRect(0, 0, W, H);
  const lead = trainer.leader(), gi = trainer.cars.indexOf(lead), gen = trainer.genomes[gi], Hn = trainer.ai.hidden;
  const xi = 96, xh = 300, xo = 470;
  const yi = (k: number) => 12 + (k / (N_IN - 1)) * (H - 24), yh = (j: number) => 16 + ((j + 0.5) / Hn) * (H - 32), yo = (o: number) => H / 2 - 50 + o * 100;
  const act = (v: number) => (v >= 0 ? `rgba(234,79,75,${Math.min(1, v)})` : `rgba(74,168,232,${Math.min(1, -v)})`);
  g.lineWidth = 1.5;
  let p = 0;
  for (let j = 0; j < Hn; j++) {
    for (let k = 0; k < N_IN; k++) {
      const w = gen[p + k] * lead.sensors[k];
      if (Math.abs(w) < 0.12) continue;
      g.strokeStyle = act(w * 0.7); g.beginPath(); g.moveTo(xi, yi(k)); g.lineTo(xh, yh(j)); g.stroke();
    }
    p += N_IN + 1;
  }
  for (let o = 0; o < N_OUT; o++) for (let j = 0; j < Hn; j++) {
    const w = gen[p + o * (Hn + 1) + j] * lead.hiddenAct[j];
    if (Math.abs(w) < 0.12) continue;
    g.strokeStyle = act(w * 0.7); g.beginPath(); g.moveTo(xh, yh(j)); g.lineTo(xo, yo(o)); g.stroke();
  }
  const node = (x: number, y: number, v: number, r: number) => {
    g.fillStyle = field; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    g.fillStyle = act(v); g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    g.strokeStyle = fg; g.lineWidth = 2.5; g.stroke();
  };
  g.font = '700 14px ui-rounded, system-ui'; g.textAlign = 'right';
  for (let k = 0; k < N_IN; k++) {
    node(xi, yi(k), k < N_RAYS ? 1 - lead.sensors[k] : lead.sensors[k] * 1.5, 6.5);
    g.fillStyle = fg;
    if (k >= N_RAYS || k === 0 || k === N_RAYS - 1 || k === (N_RAYS - 1) / 2) g.fillText(k === 0 ? 'right' : k === N_RAYS - 1 ? 'left' : k === (N_RAYS - 1) / 2 ? 'ahead' : IN_LABELS[k], xi - 14, yi(k) + 5);
  }
  for (let j = 0; j < Hn; j++) node(xh, yh(j), lead.hiddenAct[j], Math.min(9, 90 / Hn + 3));
  node(xo, yo(0), lead.steerCmd, 12); node(xo, yo(1), lead.thr, 12);
  g.textAlign = 'left'; g.fillStyle = fg;
  g.fillText(lead.steerCmd > 0.08 ? 'steer L' : lead.steerCmd < -0.08 ? 'steer R' : 'straight', xo + 18, yo(0) + 5);
  g.fillText(lead.thr > 0.05 ? 'throttle' : lead.thr < -0.05 ? 'BRAKE' : 'coast', xo + 18, yo(1) + 5);
}
function updatePractice() {
  $('sGen').textContent = String(trainer.generation);
  $('sBest').textContent = fmtLap(trainer.setupBest);
  $('sRecord').textContent = fmtLap(trainer.recordLap);
  $('sAlive').textContent = `${trainer.aliveCount}/${trainer.cars.length}`;
  const l = trainer.leader();
  $('sSpeed').textContent = l.alive ? String(Math.round(Math.hypot(l.vf, l.vl) * 3.6)) : '0';
  $('sCrash').textContent = String(trainer.crashCount);
  if (trainer.setupBest !== null && (announced === null || trainer.setupBest < announced - 0.005)) {
    toast(announced === null ? `First clean lap! ${fmtLap(trainer.setupBest)}` : `New best lap ${fmtLap(trainer.setupBest)}`);
    announced = trainer.setupBest;
  }
  if (!readyNote && trainer.hall.length >= 3) { readyNote = true; $('modeSeg').querySelector<HTMLElement>('[data-mode="race"]')!.classList.add('ready'); }
  drawChart(); drawBrain();
}
function updateSkyPane() {
  if (state.pane !== 'sky') return;
  const l = mode !== 'practice' && race ? race.player.car : trainer.leader();
  $('mWater').style.width = `${Math.round(surf.lineWater() * 100)}%`;
  $('mSnow').style.width = `${Math.round(surf.lineSnow() * 100)}%`;
  $('mGrip').style.width = `${Math.round(Math.min(1, l.grip / 1.05) * 100)}%`;
}

// ---------------------------------------------------------------- race
const teamCol = TEAMS.map((t) => new THREE.Color(t.color));
const labels: HTMLElement[] = TEAMS.map((t, i) => { const d = document.createElement('div'); d.className = 'lab' + (i === 0 ? ' me' : ''); d.style.background = t.color; $('labels').appendChild(d); return d; });
let boxSel: TyreId = 'medium', resultsShown = false;
const lightsEl = document.createElement('div');
lightsEl.className = 'sheet'; lightsEl.style.cssText = 'position:fixed;top:84px;left:50%;transform:translateX(-50%);padding:8px 14px;width:auto;display:none;z-index:6';
lightsEl.innerHTML = '<div class="lights"><i></i><i></i><i></i><i></i><i></i></div>';
document.body.appendChild(lightsEl);

function modal(html: string | null, big = false) {
  const m = $('modal');
  m.classList.toggle('show', !!html);
  m.innerHTML = html ? `<div class="sheet${big ? ' big' : ''}">${html}</div>` : '';
}
function setMode(m: 'practice' | 'race') {
  mode = m;
  document.body.dataset.mode = m;
  $$('#modeSeg button').forEach((b) => b.classList.toggle('sel', b.dataset.mode === m));
  labels.forEach((l) => (l.style.display = 'none'));
  lightsEl.style.display = 'none';
  if (m === 'practice') { race = null; modal(null); }
  setCam(m === 'race' ? 'overview' : camTarget === 'leader' ? 'follow' : camTarget);
  layout();
}
$$('#modeSeg button').forEach((b) => (b.onclick = () => (b.dataset.mode === 'race' ? raceSetup() : setMode('practice'))));

function optRow(name: string, opts: [string, string][], cur: string) {
  return `<div class="opts" data-opt="${name}">${opts.map(([v, l]) => `<button class="btn${v === cur ? ' sel' : ''}" data-v="${v}">${l}</button>`).join('')}</div>`;
}
function raceSetup() {
  if (!trainer.hall.length) {
    modal(`<h1>Your driver is not ready</h1><p>Nobody has completed a clean lap in the ${CAR_CLASSES[state.car].name} on ${track.name} yet. A race needs a driver who can get round, so practise first. The longer you practise, the faster and safer the whole grid will be.</p>
      <div class="actions"><button class="btn" id="mBack">Keep practising</button><button class="btn primary" id="mFast">Fast-forward practice</button></div>`);
    $('mBack').onclick = () => modal(null);
    $('mFast').onclick = () => { modal(null); setSpeed(-1); toast('Practising flat out. Come back to Race when a lap is on the board'); };
    return;
  }
  const o = state.race;
  const wetNow = surf.lineWater() > 0.28 || surf.lineSnow() > 0.2;
  modal(`<h1>Race at ${track.name}</h1>
    <p>Eight ${CAR_CLASSES[state.car].name} cars, real contact, tyre wear and pit stops. Your driver is the best brain from practice (${fmtLap(trainer.hall[0].lap)}); the rivals come from the same session. You run the pit wall: pace, tyres and when to stop.</p>
    <h2>Distance</h2>${optRow('laps', [['3', '3 laps'], ['5', '5'], ['8', '8'], ['12', '12'], ['20', '20']], String(o.laps))}
    <h2>Opposition</h2>${optRow('difficulty', [['0', 'Rookies'], ['1', 'Professionals'], ['2', 'Legends']], String(o.difficulty))}
    <h2>Weather</h2>${optRow('forecast', [['current', 'As it is now'], ['changeable', 'Changeable: showers forecast']], o.forecast)}
    <h2>Start on</h2><div id="mTyres" class="tyres"></div>
    <p class="hint">${wetNow ? 'The track is wet right now.' : 'The track is dry right now.'} In a dry race of 6 laps or more you must use two different dry compounds, or take a 10 second penalty.</p>
    <div class="actions"><button class="btn" id="mBack">Back to practice</button><button class="btn primary" id="mGo">Qualify</button></div>`);
  tyreButtons($('mTyres'), () => o.startTyre, (t) => { o.startTyre = t; });
  $$('#modal .opts').forEach((row) => row.querySelectorAll<HTMLElement>('button').forEach((b) => (b.onclick = () => {
    const k = row.dataset.opt as 'laps' | 'difficulty' | 'forecast';
    (o as any)[k] = k === 'forecast' ? b.dataset.v : Number(b.dataset.v);
    row.querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b));
  })));
  $('mBack').onclick = () => modal(null);
  $('mGo').onclick = () => { save(); startWeekend(); };
}
function startWeekend() {
  const o = state.race;
  race = new Race(track, CAR_CLASSES[state.car], state.setup, trainer.hall, trainer.ai.hidden, trainer.ai.vision, surf, env, { ...o }, state.seed + Date.now() % 9973);
  resultsShown = false; boxSel = o.startTyre === 'medium' ? 'hard' : 'medium';
  setMode('race'); setSpeed(1); syncSky(); buildDock();
  const r = race;
  const rows = r.order.map((e, k) => `<tr class="${e.isPlayer ? 'me' : ''}"><td class="n">${k + 1}</td><td><i class="dot" style="background:${e.team.color}"></i>${e.team.name}</td><td>${e.team.driver}</td><td class="n">${e.quali ? e.quali.toFixed(2) + 's' : 'no time'}</td><td><i class="tyreDot sm" style="--tc:${e.car.tyre.color}">${e.car.tyre.short}</i></td></tr>`).join('');
  modal(`<h1>Qualifying</h1><p>One flying lap each decides the grid${r.spells.length ? '. The forecast is changeable: watch the radar' : ''}.</p>
    <table class="res"><tr><th></th><th>Team</th><th>Driver</th><th>Lap</th><th></th></tr>${rows}</table>
    <div class="actions"><button class="btn" id="mBack">Abandon</button><button class="btn primary" id="mGo">To the grid</button></div>`);
  $('mBack').onclick = () => setMode('practice');
  $('mGo').onclick = () => { modal(null); race?.start(); };
}
function buildDock() {
  const seg = $('paceSeg');
  seg.innerHTML = '';
  for (const p of Object.keys(PACE) as Pace[]) {
    const b = document.createElement('button');
    b.textContent = PACE[p].label; b.dataset.p = p;
    b.onclick = () => race?.setPace(p);
    seg.appendChild(b);
  }
  tyreButtons($('boxTyres'), () => boxSel, (t) => { boxSel = t; if (race?.player.boxCall) race.callBox(t); });
  $('boxBtn').onclick = () => { if (!race) return; race.callBox(race.player.boxCall ? null : boxSel); };
}
function tyreDot(e: Entry) { return `<i class="tyreDot sm" style="--tc:${e.car.tyre.color}">${e.car.tyre.short}</i>`; }
function updateRace() {
  const r = race!;
  const p = r.player, c = p.car;
  $('rLap').textContent = r.phase === 'grid' ? 'On the grid' : r.phase === 'lights' ? 'Get ready' : r.phase === 'done' ? 'Finished' : `Lap ${Math.min(r.opts.laps, r.leader().lap + 1)} / ${r.opts.laps}`;
  $('rClock').textContent = r.phase === 'racing' || r.phase === 'done' ? fmtClock(r.time) : '';
  $('tower').innerHTML = r.order.map((e) => {
    const gp = e.dnf ? 'OUT' : e.pit ? 'PIT' : e.finished ? 'FIN' : e.pos === 1 ? 'leader' : e.lapsDown > 0 ? `+${e.lapsDown} lap` : e.gap !== null ? `+${e.gap.toFixed(1)}` : '';
    return `<div class="trow${e.isPlayer ? ' me' : ''}${e.dnf ? ' out' : ''}"><span class="pos">${e.pos}</span><i class="sw" style="background:${e.team.color}"></i><span class="nm">${e.team.short}</span><span class="gp${e.pit ? ' pit' : ''}">${gp}</span>${tyreDot(e)}<span class="wr">${Math.round(e.car.wear * 100)}%</span></div>`;
  }).join('');
  $('feed').innerHTML = r.events.slice(-7).reverse().map((e) => `<div class="ev ${e.kind}">${e.text}</div>`).join('');
  // dock
  $('dPos').textContent = p.dnf ? 'OUT' : `P${p.pos}`;
  $('dGap').textContent = p.dnf ? p.dnfWhy : p.pos === 1 ? 'leading' : p.interval !== null ? `${p.interval.toFixed(1)}s to the car ahead` : '';
  const td = $('dTyre'); td.textContent = c.tyre.short; td.style.setProperty('--tc', c.tyre.color);
  $('dWear').style.width = `${Math.round((1 - c.wear) * 100)}%`;
  $('dWear').style.background = c.wear > 0.7 ? '#ea4f4b' : c.wear > 0.45 ? '#ffa53d' : '#6fdc5a';
  $('dWearTxt').textContent = `${c.tyre.name}, ${Math.round((1 - c.wear) * 100)}% left, ${p.stops} stop${p.stops === 1 ? '' : 's'}`;
  $('dDmg').style.width = `${Math.round(c.damage * 100)}%`;
  $('dDmgTxt').textContent = c.damage < 0.05 ? 'none' : c.damage < 0.35 ? 'scuffed' : c.damage < 0.7 ? 'costing grip' : 'critical';
  $$('#paceSeg button').forEach((b) => b.classList.toggle('sel', b.dataset.p === p.pace));
  $('dPaceHint').textContent = PACE[p.pace].hint;
  $('dSpd').textContent = `${Math.round(Math.hypot(c.vf, c.vl) * 3.6)} km/h`;
  const bb = $<HTMLButtonElement>('boxBtn');
  bb.disabled = !!p.pit || p.finished || p.dnf || r.phase !== 'racing';
  bb.textContent = p.pit ? (p.pit.phase === 'stopped' ? `Stopped ${Math.max(0, p.pit.timer).toFixed(1)}s` : 'In the pit lane') : p.boxCall ? 'Cancel stop' : 'Box this lap';
  bb.classList.toggle('sel', !!p.boxCall);
  $('dBoxHint').textContent = p.boxCall ? `in for ${TYRES[p.boxCall].name.toLowerCase()}s` : `fit ${TYRES[boxSel].name.toLowerCase()}s`;
  const w = surf.lineWater(), sn = surf.lineSnow();
  $('dWx').textContent = sn > 0.2 ? 'Snow' : w > 0.6 ? 'Soaked' : w > 0.28 ? 'Wet' : w > 0.08 ? 'Damp' : 'Dry';
  const nc = r.nextChange();
  $('dWxNext').textContent = nc ? `${nc.kind === 'dry' ? 'clearing' : nc.kind} in ${fmtClock(nc.inSec)}` : env.weather === 'dry' ? 'no rain on the radar' : `${env.weather} falling`;
  // lights
  lightsEl.style.display = r.phase === 'lights' ? 'block' : 'none';
  lightsEl.querySelectorAll('i').forEach((el, k) => el.classList.toggle('on', k < r.lightsOn));
  if (r.phase === 'done' && !resultsShown) { resultsShown = true; showResults(); }
}
function showResults() {
  const r = race!;
  let season: { races: number; pts: Record<string, number> } = { races: 0, pts: {} };
  try { season = JSON.parse(localStorage.getItem(SEASON) || 'null') || season; } catch { /* none */ }
  season.races++;
  for (const x of r.results) season.pts[x.e.team.short] = (season.pts[x.e.team.short] || 0) + x.points;
  try { localStorage.setItem(SEASON, JSON.stringify(season)); } catch { /* private mode */ }
  const win = r.results[0];
  const rows = r.results.map((x) => {
    const t = x.e.dnf ? 'out' : !x.e.finished ? 'not classified' : x === win ? fmtClock(x.time!) + (x.time! % 1).toFixed(1).slice(1) : x.e.lap < win.e.lap ? `+${win.e.lap - x.e.lap} lap` : `+${(x.time! - win.time!).toFixed(1)}s`;
    return `<tr class="${x.e.isPlayer ? 'me' : ''}"><td class="n">${x.pos}</td><td><i class="dot" style="background:${x.e.team.color}"></i>${x.e.team.name}</td><td class="n">${t}</td><td class="n">${fmtLap(x.e.bestLap)}${r.fastest?.e === x.e ? ' ★' : ''}</td><td class="n">${x.e.stops}</td><td class="n">${x.points}</td></tr>${x.note ? `<tr><td></td><td colspan="5" class="hint">${x.note}</td></tr>` : ''}`;
  }).join('');
  const table = TEAMS.map((t) => ({ t, p: season.pts[t.short] || 0 })).sort((a, b) => b.p - a.p)
    .map((x, k) => `<tr class="${x.t.short === 'NEU' ? 'me' : ''}"><td class="n">${k + 1}</td><td><i class="dot" style="background:${x.t.color}"></i>${x.t.short}</td><td class="n">${x.p}</td></tr>`).join('');
  const me = r.results.find((x) => x.e.isPlayer)!;
  modal(`<h1>${me.e.dnf ? 'Did not finish' : me.pos === 1 ? 'You won!' : me.pos <= 3 ? `Podium: P${me.pos}` : `P${me.pos}`}</h1>
    <p>${track.name}, ${r.opts.laps} laps. Started P${me.e.grid + 1}, ${me.e.stops} stop${me.e.stops === 1 ? '' : 's'}, ${me.e.offs} off${me.e.offs === 1 ? '' : 's'}. ★ fastest lap, worth a point.</p>
    <div class="cols"><div><table class="res"><tr><th></th><th>Team</th><th>Time</th><th>Best</th><th>Stops</th><th>Pts</th></tr>${rows}</table></div>
    <div><table class="res"><tr><th></th><th>Season, ${season.races} race${season.races === 1 ? '' : 's'}</th><th>Pts</th></tr>${table}</table><button class="link" id="mSeason" style="margin-top:6px">reset season</button></div></div>
    <div class="actions"><button class="btn" id="mBack">Back to practice</button><button class="btn primary" id="mGo">Race again</button></div>`, true);
  $('mBack').onclick = () => setMode('practice');
  $('mGo').onclick = () => { setMode('practice'); raceSetup(); };
  $('mSeason').onclick = () => { try { localStorage.removeItem(SEASON); } catch { /* fine */ } $('mSeason').textContent = 'season cleared'; };
}
const scr = { x: 0, y: 0 };
function updateLabels() {
  if (!race || mode === 'practice') return;
  for (const e of race.entries) {
    const el = labels[e.i];
    if (e.dnf) { el.style.display = 'none'; continue; }
    view.project(e.car.x, e.car.y + 4.6, e.car.z, scr);
    el.style.display = 'block'; el.style.left = `${scr.x}px`; el.style.top = `${scr.y}px`;
    const txt = `${e.pos} ${e.team.short}`;
    if (el.textContent !== txt) el.textContent = txt;
  }
}

// ---------------------------------------------------------------- controllers
// PlayStation and Xbox pads both report the browser's "standard" layout:
// face buttons 0-3 (Cross/A, Circle/B, Square/X, Triangle/Y), Share/View = 8, Options/Menu = 9.
const padWas: boolean[] = [];
const getPad = (): Gamepad | null => { for (const g of navigator.getGamepads?.() ?? []) if (g && g.connected) return g; return null; };
const kindOf = (g: Gamepad): 'ps' | 'xbox' => (/xbox|045e|xinput/i.test(g.id) ? 'xbox' : /dualsense|dualshock|playstation|054c|wireless controller/i.test(g.id) ? 'ps' : 'xbox');
window.addEventListener('gamepadconnected', (e) => toast(`${kindOf(e.gamepad) === 'ps' ? 'PlayStation' : 'Xbox'} controller connected`));
window.addEventListener('gamepaddisconnected', () => { if (!getPad()) toast('Controller disconnected'); });
/** Buttons that do one thing per press: pause, camera, confirm or back on a sheet, box in a race. */
function readPad() {
  const g = getPad();
  if (!g) return;
  const hit = (i: number) => { const d = !!g.buttons[i]?.pressed, was = !!padWas[i]; padWas[i] = d; return d && !was; };
  const start = hit(9), view = hit(8), a = hit(0), b = hit(1);
  if (start) { if (speed === 0) setSpeed(lastSpeed || 1); else { lastSpeed = speed; setSpeed(0); } }
  if (view) $('camBtn').click();
  if ($('modal').classList.contains('show')) {
    if (a) document.getElementById('mGo')?.click();
    if (b) document.getElementById('mBack')?.click();
    return;
  }
  if (b && mode === 'race') $('boxBtn').click();
}

// ---------------------------------------------------------------- frames
const noCrash = { x: new Float32Array(1), y: new Float32Array(1), z: new Float32Array(1), count: 0 };
function practiceFrame(): Frame {
  const t = trainer, lead = t.leader();
  return {
    cars: t.cars,
    color: (i, out) => { out.copy(t.cars[i].elite ? GOLD : PALETTE[i % PALETTE.length]); },
    hidden: (i) => t.cars[i].finished,
    focus: lead, marker: lead, rays: lead, vision: t.ai.vision,
    path: { P: t.bestPath, N: t.bestPathN, version: t.bestPathVersion },
    crash: { x: t.crashX, y: t.crashY, z: t.crashZ, count: t.crashCount },
    startLights: 0,
  };
}
function raceFrame(now: number): Frame {
  const r = race!, blink = (now * 5) % 1 < 0.5;
  return {
    cars: r.cars,
    color: (i, out) => { out.copy(teamCol[i]); },
    hidden: (i) => r.phase === 'racing' && r.time < r.entries[i].holdUntil && blink,
    focus: camTarget === 'leader' ? r.leader().car : r.player.car, marker: r.player.dnf ? null : r.player.car, rays: null, vision: 0,
    path: null,
    crash: r.crashCount ? { x: r.crashX, y: r.crashY, z: r.crashZ, count: r.crashCount } : noCrash,
    startLights: r.phase === 'lights' ? r.lightsOn : 0,
  };
}

// ---------------------------------------------------------------- loop
let last = performance.now(), acc = 0, hudT = 0, themeNow = '';
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  readPad();
  const step = () => (mode !== 'practice' && race ? race.step() : trainer.step());
  if (speed > 0) {
    acc += dt * 60 * speed;
    let n = Math.min(Math.floor(acc), speed * 4);
    acc -= Math.floor(acc);
    while (n-- > 0) step();
  } else if (speed < 0) {
    const t0 = performance.now();
    while (performance.now() - t0 < 11) for (let k = 0; k < 20; k++) step();
  }
  // the clock: swept by the day/night button, or left to run
  if (timeTarget !== null) {
    const d = timeTarget - env.time, s = dt * 9;
    if (Math.abs(d) <= s) { env.time = timeTarget; timeTarget = null; save(); } else env.time += Math.sign(d) * s;
    syncSky();
  } else if (cycle && speed !== 0) { env.time = (env.time + dt * (24 / 150)) % 24; syncSky(); }

  view.render(mode !== 'practice' && race ? raceFrame(now / 1000) : practiceFrame(), now / 1000);
  updateLabels();
  if (now - hudT > 120) {
    hudT = now;
    if (mode !== 'practice' && race) updateRace(); else updatePractice();
    updateSkyPane();
    const th = view.night > 0.5 ? 'dark' : 'light';
    if (th !== themeNow) { themeNow = th; document.documentElement.dataset.theme = th; }
    if (race && mode !== 'practice' && env.weather !== lastWx) syncSky();
    lastWx = env.weather;
  }
  requestAnimationFrame(frame);
}
let lastWx: WeatherKind = env.weather;

view.setCarClass(CAR_CLASSES[state.car]);
buildCarPane(); buildDriverPane();
document.body.dataset.mode = 'practice';
$$('#modeSeg button').forEach((b) => b.classList.toggle('sel', b.dataset.mode === 'practice'));
setSpeed(1); setCam('overview');
buildTrack();
carChanged(null);
syncSky();
openPane(state.pane);
applyHud();
(window as any).neurolap = { get trainer() { return trainer; }, get race() { return race; }, get surf() { return surf; }, view, env, state, newTrack, setSpeed, setTime, setWeather, pickCar, raceSetup, startWeekend, setMode };
requestAnimationFrame(frame);
