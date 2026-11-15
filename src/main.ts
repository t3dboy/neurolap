import * as THREE from 'three';
import { generateTrack, buildCustomTrack, Track, STYLES, STYLE_IDS, StyleId, Theme } from './track';
import { Trainer, Setup, AiConfig, DEFAULT_AI, N_IN, N_RAYS, N_OUT, DT, GHOST_EVERY, Ghost, Breed, traitsOf, persona } from './sim';
import { View, Frame, PALETTE, GOLD, GhostPose } from './view';
import { CHALLENGES, Challenge, partsCost, UPGRADES, UP_KEYS, UP_MAX, UpKey, upCost, seasonSetup } from './challenges';
import { CAR_CLASSES, CAR_IDS, CarId } from './cars';
import { Env, Surface, TYRES, TYRE_IDS, TyreId, WeatherKind, sunHeight } from './weather';
import { Race, RaceOpts, PACE, Pace, TEAMS, Entry } from './race';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => Array.from(document.querySelectorAll<T>(sel));
const KEY = 'neurolap.v2', SEASON = 'neurolap.season', CHAL_KEY = 'neurolap.challenges', CHAMP_KEY = 'neurolap.championship';

// ---------------------------------------------------------------- saved state
interface Saved {
  seed: number; style: StyleId | 'any'; car: CarId; setup: Setup; tyre: TyreId; ai: AiConfig;
  env: Env; headlights: 'auto' | 'on' | 'off'; pane: string | null; folds: Record<string, boolean>; hud: boolean;
  race: RaceOpts;
  transfer: boolean; ghosts: boolean;
  custom: CustomTrack | null;
}
interface CustomTrack { pts: string; len: number; theme: Theme }
function load(): Saved {
  const d: Saved = {
    seed: 1 + Math.floor(Math.random() * 9999), style: 'any', car: 'gt', setup: { ...CAR_CLASSES.gt.setup }, tyre: CAR_CLASSES.gt.tyre, ai: { ...DEFAULT_AI },
    env: { time: 13, weather: 'dry', intensity: 0.6 }, headlights: 'auto', pane: 'car', folds: {}, hud: true,
    race: { laps: 5, difficulty: 1, forecast: 'current', startTyre: 'medium' },
    transfer: true, ghosts: true, custom: null,
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
let camTarget: 'overview' | 'follow' | 'leader' | 'director' = 'overview';
// what the practice session is for, beyond practice: a setup challenge, a championship round, a friend's lap to beat
let challenge: Challenge | null = null, challengeDone = false;
let inSeason = false, raceIsSeason = false;
let shared: { lap: number; beaten: boolean } | null = null;
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

function buildTrack(carry = state.transfer) {
  const prev = trainer, prevName = track?.name;
  let built: Track | null = null;
  if (state.custom) {
    const t = buildCustomTrack(decodePts(state.custom.pts), state.custom.len, state.custom.theme);
    if (typeof t === 'string') { toast(t); state.custom = null; save(); } else built = t;
  }
  track = built ?? generateTrack(state.seed, state.style === 'any' ? undefined : state.style);
  surf = new Surface(track, env);
  if (env.weather !== 'dry') surf.settle();
  // brain transfer: the whole population moves to the new circuit and starts again from what it knows
  const brains = carry && prev ? prev.genomes : undefined;
  trainer = new Trainer(track, state.setup, CAR_CLASSES[state.car], state.ai, surf, state.tyre, brains);
  if (brains && brains[0].length === trainer.genomeSize) trainer.transfer = { from: prevName ?? 'elsewhere', firstLapGen: null };
  view.setTrack(track, surf);
  race = null; announced = null; readyNote = false;
  if (mode !== 'practice') setMode('practice');
  const S = STYLES[track.style];
  $('tName').textContent = track.name;
  $('tMeta').textContent = `${S.label} · ${track.length >= 2000 ? (track.length / 1000).toFixed(1) + ' km' : Math.round(track.length) + ' m'}`;
  $<HTMLInputElement>('seed').value = String(state.seed);
  let tight = 0;
  for (let i = 0; i < track.n; i++) tight = Math.max(tight, Math.abs(track.curv[i]));
  $('trackInfo').textContent = track.style === 'custom' ? `Your own circuit: ${Math.round(track.length)} m lap, ${Math.round(track.maxH)} m of climb${track.kind === 'eight' ? ', crossing itself on a bridge' : ''}, tightest corner ${Math.round(1 / tight)} m radius. Share it and the drawing goes in the link.` : `${S.label}, in the spirit of ${S.inspired}: ${S.blurb}. ${Math.round(track.length)} m lap, ${Math.round(track.maxH)} m of climb, road ${(track.hw * 2).toFixed(0)} m wide, tightest corner ${Math.round(1 / tight)} m radius. The same seed and style always give the same track.`;
  paintStyles();
}
function newTrack(seed: number) { leaveContext(); state.seed = seed; state.custom = null; save(); buildTrack(); }

function carChanged(note: string | null, from?: string) {
  save();
  const cls = CAR_CLASSES[state.car];
  trainer.setCar(state.setup, cls, state.tyre, from);
  announced = null; readyNote = false;
  paintCarChip();
  if (note) toast(note);
}
function paintCarChip() {
  const cls = CAR_CLASSES[state.car], lim = budget();
  const tuned = (Object.keys(cls.setup) as (keyof Setup)[]).some((k) => Math.abs(cls.setup[k] - state.setup[k]) > 1e-9);
  $('setupTag').textContent = lim ? `${partsCost(state.setup, lim.base)} of ${lim.budget} parts` : tuned ? 'tuned' : '';
  $('cName').textContent = cls.name;
  $('cMeta').textContent = `${state.setup.power} kW · ${state.setup.mass} kg · ${TYRES[state.tyre].name.toLowerCase()}s`;
  updateBanner();
}
/** The parts budget in force, if any: a challenge's, or a championship car's (only what the garage has bought). */
function budget(): { base: Setup; budget: number } | null {
  if (challenge) return { base: CAR_CLASSES[challenge.car].setup, budget: challenge.budget };
  if (inSeason && champ) return { base: seasonSetup(champ.car, champ.up), budget: 0 };
  return null;
}
function pickCar(id: CarId) {
  const from = CAR_CLASSES[state.car].name;
  leaveContext();
  state.car = id; state.setup = { ...CAR_CLASSES[id].setup }; state.tyre = CAR_CLASSES[id].tyre;
  view.setCarClass(CAR_CLASSES[id]);
  buildCarPane();
  carChanged(`${CAR_CLASSES[id].name}: the drivers have to learn it`, `the ${from}`);
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
function buildSliders<T extends object>(host: HTMLElement, defs: Def<T>[], obj: T, onChange: (key: keyof T) => void, ok?: () => boolean) {
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
    input.addEventListener('change', () => {
      const old = obj[d.key];
      (obj as any)[d.key] = Number(input.value);
      if (ok && !ok()) { (obj as any)[d.key] = old; input.value = String(old); paint(); return; }
      onChange(d.key);
    });
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
    b.className = 'pick' + (state.style === id && !state.custom ? ' sel' : '');
    b.innerHTML = `<b>${title}</b><span>${sub}</span>`;
    b.onclick = () => { leaveContext(); state.style = id; state.custom = null; save(); buildTrack(); };
    host.appendChild(b);
  };
  if (state.custom) {
    const b = document.createElement('button');
    b.className = 'pick sel';
    b.innerHTML = `<b>Your circuit</b><span>drawn by hand. Click to redraw</span>`;
    b.onclick = () => openEditor();
    host.appendChild(b);
  }
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
  buildSliders($('carSliders'), CAR, state.setup, () => carChanged('New setup: the drivers have to relearn the car'), () => {
    const lim = budget();
    if (!lim) return true;
    const cost = partsCost(state.setup, lim.base);
    if (cost <= lim.budget + 1e-6) return true;
    toast(challenge ? `Over budget: that needs ${cost} parts and you have ${lim.budget}` : 'Buy upgrades in the garage first: you can trade parts, not add them');
    return false;
  });
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
$('resetCar').onclick = () => { state.setup = inSeason && champ ? seasonSetup(champ.car, champ.up) : { ...CAR_CLASSES[state.car].setup }; buildCarPane(); carChanged('Back to the standard setup'); };
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
  $('camBtn').textContent = t === 'overview' ? 'Overview' : t === 'director' ? 'Director' : t === 'leader' ? 'Following leader' : mode === 'race' ? 'Following your car' : 'Following leader';
  if (t === 'director') { dir.until = 0; dir.e = null; }
  $('camBtn').classList.toggle('on', t !== 'overview');
}
$('camBtn').onclick = () => setCam(mode !== 'race' ? (camTarget === 'overview' ? 'follow' : 'overview')
  : camTarget === 'overview' ? 'director' : camTarget === 'director' ? 'follow' : camTarget === 'follow' ? 'leader' : 'overview');
$('lineBtn').onclick = () => { view.showLine = !view.showLine; $('lineBtn').classList.toggle('on', view.showLine); };
$('rayBtn').onclick = () => { view.showRays = !view.showRays; $('rayBtn').classList.toggle('on', view.showRays); };
$('ghostBtn').onclick = () => { state.ghosts = !state.ghosts; save(); $('ghostBtn').classList.toggle('on', state.ghosts); };
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
cv.addEventListener('wheel', (e) => { e.preventDefault(); view.zoom = Math.min(track.length > 2500 ? 24 : 8, Math.max(1, view.zoom * Math.exp(-e.deltaY * 0.0015))); if (view.zoom === 1) { view.panX = 0; view.panY = 0; } }, { passive: false });
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
  // the leader's temperament
  const lt = traitsOf(trainer.genomes[trainer.cars.indexOf(l)], trainer.ai.hidden);
  $('persona').innerHTML = `<b>${persona(lt)}</b><span>aggression</span><div class="bar"><i style="width:${Math.round(lt.aggr * 100)}%;background:var(--red)"></i></div><span>tyre care</span><div class="bar"><i style="width:${Math.round(lt.care * 100)}%;background:var(--green)"></i></div>`;
  // brain transfer: how fast did knowledge from elsewhere carry over?
  const tf = trainer.transfer;
  $('adaptCard').style.display = tf ? '' : 'none';
  if (tf) $('adapt').textContent = tf.firstLapGen !== null
    ? `The drivers came from ${tf.from}. They found a clean lap here after ${tf.firstLapGen} generation${tf.firstLapGen === 1 ? '' : 's'}${tf.firstLapGen <= 3 ? ': what they knew carried straight over' : tf.firstLapGen <= 12 ? ': a quick study' : ''}.`
    : `The drivers came from ${tf.from} and are adapting: generation ${trainer.generation}, no clean lap yet.`;
  checkGoals();
  updateBanner();
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
  paintModes();
  labels.forEach((l) => (l.style.display = 'none'));
  ghostLabs.forEach((l) => (l.style.display = 'none'));
  lightsEl.style.display = 'none';
  $('director').style.display = 'none';
  if (m === 'practice') { race = null; raceIsSeason = false; modal(null); }
  setCam(m === 'race' ? 'director' : camTarget === 'leader' || camTarget === 'director' ? 'follow' : camTarget);
  updateBanner();
  layout();
}
function paintModes() {
  const cur = challenge ? 'challenge' : inSeason ? 'season' : mode;
  $$('#modeSeg button').forEach((b) => b.classList.toggle('sel', b.dataset.mode === cur));
}
$$('#modeSeg button').forEach((b) => (b.onclick = () => {
  const m = b.dataset.mode;
  if (m === 'challenge') return challengeList();
  if (m === 'season') return seasonHub();
  leaveContext();
  if (m === 'race') raceSetup(); else setMode('practice');
}));
/** Step out of a challenge or a championship round back into free practice (the season stays saved). */
function leaveContext() {
  if (!challenge && !inSeason) return;
  challenge = null; inSeason = false;
  paintModes(); paintCarChip();
}

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
function startWeekend(o: RaceOpts = state.race, season = false) {
  race = new Race(track, CAR_CLASSES[state.car], state.setup, trainer.hall, trainer.ai.hidden, trainer.ai.vision, surf, env, { ...o }, state.seed + Date.now() % 9973);
  resultsShown = false; boxSel = o.startTyre === 'medium' ? 'hard' : 'medium';
  setMode('race'); raceIsSeason = season; setSpeed(1); syncSky(); buildDock();
  seenOffs.length = 0; seenDmg.length = 0;
  const r = race;
  const rows = r.order.map((e, k) => `<tr class="${e.isPlayer ? 'me' : ''}"><td class="n">${k + 1}</td><td><i class="dot" style="background:${e.team.color}"></i>${e.team.name}</td><td>${e.team.driver}</td><td class="hint">${e.persona}</td><td class="n">${e.quali ? e.quali.toFixed(2) + 's' : 'no time'}</td><td><i class="tyreDot sm" style="--tc:${e.car.tyre.color}">${e.car.tyre.short}</i></td></tr>`).join('');
  modal(`<h1>${season && champ ? `Round ${champ.round + 1}: qualifying` : 'Qualifying'}</h1><p>One flying lap each decides the grid${r.spells.length ? '. The forecast is changeable: watch the radar' : ''}.</p>
    <table class="res"><tr><th></th><th>Team</th><th>Driver</th><th>Style</th><th>Lap</th><th></th></tr>${rows}</table>
    <div class="actions"><button class="btn" id="mBack">Abandon</button><button class="btn primary" id="mGo">To the grid</button></div>`);
  $('mBack').onclick = () => setMode('practice');
  $('mGo').onclick = () => { modal(null); race?.start(); };
  layout();
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
  $('dPersona').textContent = p.persona;
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
  if (r.phase === 'done' && !resultsShown) { resultsShown = true; if (raceIsSeason) seasonResults(); else showResults(); }
  // the director's caption
  const dEl = $('director');
  const showDir = camTarget === 'director' && r.phase === 'racing' && !!dir.why;
  dEl.style.display = showDir ? 'block' : 'none';
  if (showDir) dEl.textContent = dir.why;
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
  if (mode === 'practice') {
    ghostLabs.forEach((el, k) => {
      const g = ghostNow[k];
      if (!g || !state.ghosts) { el.style.display = 'none'; return; }
      view.project(g.pose.x, g.pose.y + 4.2, g.pose.z, scr);
      el.style.display = 'block'; el.style.left = `${scr.x}px`; el.style.top = `${scr.y}px`; el.style.opacity = String(0.45 + 0.55 * g.pose.fade);
      const txt = `gen ${g.g.gen} · ${g.g.lap.toFixed(2)}s`;
      if (el.textContent !== txt) el.textContent = txt;
    });
    return;
  }
  if (!race) return;
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

// ---------------------------------------------------------------- ghosts
// The best lap of earlier generations, replayed against the current one from the same start.
const ghostLabs: HTMLElement[] = Array.from({ length: 5 }, () => { const d = document.createElement('div'); d.className = 'lab ghost'; $('labels').appendChild(d); return d; });
let ghostNow: { pose: GhostPose; g: Ghost }[] = [];
function ghostPoses(): GhostPose[] {
  ghostNow = [];
  if (!state.ghosts) return [];
  const picks = trainer.ghostPick(5), t = trainer.time, step = GHOST_EVERY * DT;
  picks.forEach((g, k) => {
    const f = (t - g.lapStart) / step;
    if (f >= g.n - 1) return; // that lap is over
    const u = Math.max(0, f), i = Math.floor(u), a = u - i, j = Math.min(g.n - 1, i + 1), d = g.data;
    let dth = d[j * 4 + 3] - d[i * 4 + 3];
    dth = Math.atan2(Math.sin(dth), Math.cos(dth));
    const L = (o: number) => d[i * 4 + o] + (d[j * 4 + o] - d[i * 4 + o]) * a;
    ghostNow.push({ pose: { x: L(0), y: L(1), z: L(2), th: d[i * 4 + 3] + dth * a, fade: picks.length === 1 ? 1 : 0.2 + (0.8 * k) / (picks.length - 1) }, g });
  });
  return ghostNow.map((x) => x.pose);
}

// ---------------------------------------------------------------- director camera
// Cuts between what matters: a crash, a pit stop, the closest fight near the front.
const dir: { e: Entry | null; until: number; prio: number; why: string } = { e: null, until: 0, prio: 0, why: '' };
const seenOffs: number[] = [], seenDmg: number[] = [];
function direct(r: Race): Entry {
  const now = performance.now() / 1000;
  if (r.phase !== 'racing') { dir.e = r.leader(); dir.why = ''; return dir.e; }
  const cut = (e: Entry, prio: number, hold: number, why: string) => { dir.e = e; dir.prio = prio; dir.until = now + hold; dir.why = why; };
  // incidents: a car into the barrier, or a knock that did damage
  for (const e of r.entries) {
    const offs = seenOffs[e.i] ?? e.offs, dmg = seenDmg[e.i] ?? e.car.damage;
    if (!e.dnf && (e.offs > offs || e.car.damage > dmg + 0.04) && (dir.prio < 3 || now > dir.until - 1.5)) cut(e, 3, 4, e.offs > offs ? `Incident: ${e.team.short} is in the barrier` : `Contact: ${e.team.short} is damaged`);
    seenOffs[e.i] = e.offs; seenDmg[e.i] = e.car.damage;
  }
  if (dir.e && dir.e.dnf) dir.until = 0;
  if (now < dir.until) return dir.e!;
  // pit stops
  const pit = r.entries.find((e) => e.pit && e.pit.phase !== 'out');
  if (pit && (pit !== dir.e || dir.prio !== 2)) { cut(pit, 2, 5, pit.pit!.phase === 'stopped' ? `Pit stop: ${pit.team.short} in the box` : `${pit.team.short} into the pit lane`); return pit; }
  // the best battle: close, and the nearer the front the better
  let best: Entry | null = null, score = 0;
  for (const e of r.order) {
    if (e.dnf || e.pit || e.finished || e.interval === null || e.interval > 1.1 || e.pos < 2) continue;
    const sc = (1 / (e.interval + 0.25)) * (1.6 - e.pos / 10) * (e.isPlayer ? 1.3 : 1);
    if (sc > score) { score = sc; best = e; }
  }
  if (best) {
    const ahead = r.order[best.pos - 2];
    cut(best, 1, 6, `Battle for P${best.pos - 1}: ${best.team.short} chasing ${ahead.team.short}, ${best.interval!.toFixed(1)}s`);
    return best;
  }
  const lead = r.leader();
  cut(lead, 0, 6, `${lead.team.short} leads${lead.isPlayer ? ': that is us' : ''}`);
  return lead;
}

// ---------------------------------------------------------------- share links
const SETUP_KEYS = CAR.map((d) => d.key);
const THEMES: Theme[] = ['forest', 'parkland', 'city', 'desert'];
/** A drawing in a link: each point as two base-36 pairs, scaled into 0..1295. */
function encodePts(pts: [number, number][]): string {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const k = 1295 / Math.max(1, x1 - x0, z1 - z0), c = (v: number) => Math.round(v).toString(36).padStart(2, '0');
  return pts.map(([x, z]) => c((x - x0) * k) + c((z - z0) * k)).join('');
}
function decodePts(sv: string): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 4 <= sv.length; i += 4) out.push([parseInt(sv.slice(i, i + 2), 36), parseInt(sv.slice(i + 2, i + 4), 36)]);
  return out;
}
function shareLink(): string {
  const p = new URLSearchParams();
  if (state.custom) p.set('d', `${state.custom.pts}.${state.custom.len}.${state.custom.theme}`);
  else p.set('t', `${state.seed}.${track.style}`);
  p.set('c', `${state.car}.${state.tyre}`);
  p.set('s', SETUP_KEYS.map((k) => +state.setup[k].toFixed(3)).join('_'));
  if (trainer.setupBest !== null) p.set('r', trainer.setupBest.toFixed(2));
  return `${location.origin}${location.pathname}#${p.toString()}`;
}
async function share() {
  const url = shareLink(), best = trainer.setupBest;
  try {
    await navigator.clipboard.writeText(url);
    toast(best !== null ? `Link copied. Your ${fmtLap(best)} is the time to beat` : 'Link copied');
  } catch {
    modal(`<h1>Share this circuit</h1><p>Copy the link and send it. ${best !== null ? `Your best lap, ${fmtLap(best)}, goes with it as the time to beat.` : 'Practise first and your best lap goes in the link too.'}</p>
      <input id="shareUrl" class="wideIn" readonly value="${url}" /><div class="actions"><button class="btn primary" id="mGo">Done</button></div>`);
    $<HTMLInputElement>('shareUrl').select();
    $('mGo').onclick = () => modal(null);
  }
}
$('shareBtn').onclick = $('shareBtn2').onclick = () => { void share(); };
// a shared link opened in a tab that already has the game: start afresh from it
window.addEventListener('hashchange', () => { if (location.hash.includes('=')) location.reload(); });
/** Open a shared link: the circuit, the car, the setup, and a lap to beat. */
function readShared() {
  if (!location.hash.includes('=')) return;
  const p = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search);
  const t = p.get('t'), d = p.get('d'), c = p.get('c'), sv = p.get('s'), r = Number(p.get('r'));
  if (t) {
    const [seed, style] = t.split('.');
    if (Number(seed) > 0) state.seed = Math.floor(Number(seed));
    state.style = STYLE_IDS.includes(style as StyleId) ? (style as StyleId) : 'any';
    state.custom = null;
  } else if (d) {
    const [pts, len, theme] = d.split('.');
    if (pts && decodePts(pts).length >= 6) state.custom = { pts, len: Math.min(8000, Math.max(600, Number(len) || 1600)), theme: THEMES.includes(theme as Theme) ? (theme as Theme) : 'parkland' };
  }
  if (c) {
    const [car, tyre] = c.split('.');
    if (CAR_IDS.includes(car as CarId)) { state.car = car as CarId; state.setup = { ...CAR_CLASSES[state.car].setup }; state.tyre = CAR_CLASSES[state.car].tyre; }
    if (TYRE_IDS.includes(tyre as TyreId)) state.tyre = tyre as TyreId;
  }
  if (sv) sv.split('_').forEach((v, i) => {
    const def = CAR[i], n = Number(v);
    if (def && Number.isFinite(n)) (state.setup as any)[def.key] = Math.min(def.max, Math.max(def.min, n));
  });
  if (r > 0) shared = { lap: r, beaten: false };
  save();
  setTimeout(() => toast(shared ? `Shared circuit loaded: beat ${fmtLap(shared.lap)}` : 'Shared circuit loaded'), 600);
}

// ---------------------------------------------------------------- transfer and breeding
function syncTransfer() { $$('#transferSeg button').forEach((b) => b.classList.toggle('sel', (b.dataset.v === '1') === state.transfer)); }
$$('#transferSeg button').forEach((b) => (b.onclick = () => { state.transfer = b.dataset.v === '1'; save(); syncTransfer(); }));
syncTransfer();
const BREED_HINT: Record<Breed, string> = {
  balanced: 'Only lap time counts. Temperaments drift as they please.',
  aggression: 'Selection favours aggressive drivers: they push harder in practice and try more moves in a race, at some risk.',
  care: 'Selection favours drivers who look after their tyres: a touch slower over one lap, longer stints in a race.',
};
function syncBreed() {
  const b0 = state.ai.breed ?? 'balanced';
  $$('#breedSeg button').forEach((b) => b.classList.toggle('sel', b.dataset.v === b0));
  $('breedHint').textContent = BREED_HINT[b0];
}
$$('#breedSeg button').forEach((b) => (b.onclick = () => {
  state.ai.breed = b.dataset.v as Breed; save(); trainer.setAi(state.ai); syncBreed();
  toast(state.ai.breed === 'balanced' ? 'Breeding for pace only' : `Breeding for ${state.ai.breed === 'care' ? 'tyre care' : 'aggression'}`);
}));
syncBreed();

// ---------------------------------------------------------------- banner: what this session is for
function updateBanner() {
  const el = $('banner');
  let html = '';
  if (mode === 'practice' && challenge) {
    const lim = budget()!, cost = partsCost(state.setup, lim.base), best = trainer?.setupBest ?? null;
    html = `<b>${challenge.title}</b><span class="meta">beat ${challenge.target.toFixed(1)}s · ${cost} of ${challenge.budget} parts · best ${fmtLap(best)}${challengeDone ? ' · done!' : ''}</span><button class="btn" id="bnCar">Setup</button><button class="btn" id="bnExit">Leave</button>`;
  } else if (mode === 'practice' && inSeason && champ) {
    html = `<b>Round ${champ.round + 1} of ${champ.rounds.length}</b><span class="meta">${track.name} · ${champ.credits} credits · best ${fmtLap(trainer?.setupBest)}</span><button class="btn" id="bnGarage">Garage</button><button class="btn" id="bnTable">Standings</button><button class="btn primary" id="bnRace">Race weekend</button>`;
  } else if (mode === 'practice' && shared) {
    html = `<b>Time to beat: ${fmtLap(shared.lap)}</b><span class="meta">from a shared link · your best ${fmtLap(trainer?.setupBest)}${shared.beaten ? ' · beaten!' : ''}</span><button class="btn" id="bnExit">Dismiss</button>`;
  }
  if (el.dataset.html === html) return;
  el.dataset.html = html; el.innerHTML = html; el.classList.toggle('show', !!html);
  const on = (id: string, f: () => void) => { const b = document.getElementById(id); if (b) b.onclick = f; };
  on('bnCar', () => openPane('car'));
  on('bnExit', () => { if (challenge) leaveContext(); else shared = null; updateBanner(); });
  on('bnGarage', () => garage()); on('bnTable', seasonHub); on('bnRace', seasonRace);
}
/** Goals that are checked as practice runs: a challenge target, a friend's lap. */
function checkGoals() {
  const best = trainer.setupBest;
  if (best === null) return;
  if (shared && !shared.beaten && best < shared.lap && !challenge && !inSeason) { shared.beaten = true; toast(`You beat the shared lap: ${fmtLap(best)} against ${fmtLap(shared.lap)}`); }
  if (challenge && env.weather === (challenge.weather ?? 'dry')) {
    const cost = partsCost(state.setup, CAR_CLASSES[challenge.car].setup);
    if (cost > challenge.budget) return;
    const prog = loadChal(), mine = prog[challenge.id] ?? { best: null, done: false };
    if (mine.best === null || best < mine.best - 1e-6) { mine.best = best; prog[challenge.id] = mine; saveChal(prog); }
    if (!challengeDone && best <= challenge.target) {
      challengeDone = true; mine.done = true; prog[challenge.id] = mine; saveChal(prog);
      const next = CHALLENGES.find((c) => c.target > 0 && !prog[c.id]?.done);
      modal(`<h1>Challenge complete!</h1><p>${fmtLap(best)} against a target of ${challenge.target.toFixed(1)}s, using ${cost} of ${challenge.budget} parts.</p>
        <div class="actions"><button class="btn" id="mBack">Keep improving</button>${next ? '<button class="btn primary" id="mGo">Next challenge</button>' : ''}</div>`);
      $('mBack').onclick = () => modal(null);
      if (next) $('mGo').onclick = () => startChallenge(next);
    }
  }
}

// ---------------------------------------------------------------- track editor
function openEditor() {
  let pts: [number, number][] = [];
  let len = state.custom?.len ?? 1600, theme: Theme = state.custom?.theme ?? 'parkland', drawing = false;
  modal(`<h1>Draw a circuit</h1><p>Draw one closed loop. Long, clean lines become straights and every turn becomes a real corner. It needs one straight of about 110 m for the start and the pits.</p>
    <canvas id="edCanvas" width="720" height="460"></canvas>
    <h2>Lap length</h2>${optRow('len', [['1000', '1 km'], ['1600', '1.6 km'], ['2500', '2.5 km'], ['4000', '4 km'], ['6000', '6 km']], String(len))}
    <h2>Scenery</h2>${optRow('theme', [['forest', 'Forest'], ['parkland', 'Parkland'], ['city', 'City'], ['desert', 'Desert']], theme)}
    <p class="hint" id="edMsg"></p>
    <div class="actions"><button class="btn" id="mBack">Cancel</button><button class="btn" id="edClear">Clear</button><button class="btn primary" id="mGo">Build it</button></div>`, true);
  const cvE = $<HTMLCanvasElement>('edCanvas'), g = cvE.getContext('2d')!;
  // a shared drawing comes back in 0..1295: fit it to the canvas
  if (state.custom) {
    const raw = decodePts(state.custom.pts);
    let x1 = 0, z1 = 0; for (const [x, z] of raw) { x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
    const k = Math.min(620 / Math.max(1, x1), 380 / Math.max(1, z1));
    pts = raw.map(([x, z]) => [50 + x * k, 40 + z * k]);
  }
  const paint = () => {
    g.clearRect(0, 0, 720, 460);
    g.strokeStyle = 'rgba(128,128,128,0.18)'; g.lineWidth = 1;
    for (let x = 0; x < 720; x += 40) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 460); g.stroke(); }
    for (let y = 0; y < 460; y += 40) { g.beginPath(); g.moveTo(0, y); g.lineTo(720, y); g.stroke(); }
    if (pts.length < 2) { g.fillStyle = 'rgba(128,128,128,0.7)'; g.font = '700 18px ui-rounded, system-ui'; g.textAlign = 'center'; g.fillText('Draw your circuit here', 360, 236); return; }
    g.lineJoin = g.lineCap = 'round';
    for (const [w, c] of [[16, '#1d1b30'], [10, '#5a5d6e']] as const) {
      g.strokeStyle = c; g.lineWidth = w; g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
      for (const q of pts) g.lineTo(q[0], q[1]);
      if (!drawing) g.closePath();
      g.stroke();
    }
    g.fillStyle = '#ffd23d'; g.beginPath(); g.arc(pts[0][0], pts[0][1], 6, 0, 7); g.fill();
  };
  const at = (e: PointerEvent): [number, number] => { const b = cvE.getBoundingClientRect(); return [((e.clientX - b.left) / b.width) * 720, ((e.clientY - b.top) / b.height) * 460]; };
  cvE.onpointerdown = (e) => { drawing = true; pts = [at(e)]; cvE.setPointerCapture(e.pointerId); paint(); };
  cvE.onpointermove = (e) => { if (!drawing) return; const q = at(e), l = pts[pts.length - 1]; if (Math.hypot(q[0] - l[0], q[1] - l[1]) > 5) { pts.push(q); paint(); } };
  cvE.onpointerup = () => { drawing = false; paint(); };
  paint();
  $$('#modal .opts').forEach((row) => row.querySelectorAll<HTMLElement>('button').forEach((b) => (b.onclick = () => {
    if (row.dataset.opt === 'len') len = Number(b.dataset.v); else theme = b.dataset.v as Theme;
    row.querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b));
  })));
  $('edClear').onclick = () => { pts = []; paint(); $('edMsg').textContent = ''; };
  $('mBack').onclick = () => modal(null);
  $('mGo').onclick = () => {
    if (pts.length < 12) { $('edMsg').textContent = 'Draw a whole loop first.'; return; }
    // fewer points travel better in a link; the drawing's shape is all that matters
    const step = Math.max(1, Math.ceil(pts.length / 90)), thin = pts.filter((_, i) => i % step === 0);
    const enc = encodePts(thin);
    $('edMsg').textContent = 'Building...';
    setTimeout(() => {
      const t = buildCustomTrack(decodePts(enc), len, theme);
      if (typeof t === 'string') { $('edMsg').textContent = t; return; }
      leaveContext();
      state.custom = { pts: enc, len, theme }; save();
      modal(null); buildTrack();
      toast(`${track.name}: ${Math.round(track.length)} m. Over to the drivers`);
    }, 30);
  };
}
$('drawBtn').onclick = openEditor;

// ---------------------------------------------------------------- setup challenges
type ChalProgress = Record<string, { best: number | null; done: boolean }>;
function loadChal(): ChalProgress { try { return JSON.parse(localStorage.getItem(CHAL_KEY) || '{}'); } catch { return {}; } }
function saveChal(p: ChalProgress) { try { localStorage.setItem(CHAL_KEY, JSON.stringify(p)); } catch { /* private mode */ } }
function challengeList() {
  const prog = loadChal();
  const rows = CHALLENGES.filter((c) => c.target > 0).map((c) => {
    const m = prog[c.id], st = STYLES[c.style];
    const badge = m?.done ? '<i class="medal done">done</i>' : m?.best ? `<i class="medal">${fmtLap(m.best)}</i>` : '<i class="medal">new</i>';
    return `<button data-id="${c.id}"><b>${c.title}</b>${badge}<span>${c.blurb}</span><span class="spec">${st.label} · ${CAR_CLASSES[c.car].name} · ${c.budget} parts · beat ${c.target.toFixed(1)}s${c.weather === 'rain' ? ' · rain' : ''}</span></button>`;
  }).join('');
  modal(`<h1>Setup challenges</h1><p>Each one is a circuit, a car and a parts budget. Spend the parts on the setup sliders (power, grip, aero, weight, brakes), then train the drivers until they beat the target. Giving something back refunds half its parts. Balance, steering and aids are free.</p>
    <div class="chal">${rows}</div><div class="actions"><button class="btn" id="mBack">Close</button></div>`, true);
  $$('#modal .chal button').forEach((b) => (b.onclick = () => startChallenge(CHALLENGES.find((c) => c.id === b.dataset.id)!)));
  $('mBack').onclick = () => modal(null);
}
function startChallenge(ch: Challenge) {
  challenge = ch; challengeDone = !!loadChal()[ch.id]?.done; inSeason = false;
  const cls = CAR_CLASSES[ch.car];
  state.custom = null; state.seed = ch.seed; state.style = ch.style; state.car = ch.car;
  state.setup = { ...cls.setup }; state.tyre = ch.weather === 'rain' ? 'inter' : cls.tyre;
  env.weather = ch.weather ?? 'dry'; env.intensity = ch.intensity ?? 0.6;
  view.setCarClass(cls); buildCarPane();
  modal(null); buildTrack(false); trainer.transfer = null;
  syncSky(); paintCarChip(); setMode('practice'); openPane('car');
  toast(`${ch.title}: ${ch.budget} parts to spend`);
}

// ---------------------------------------------------------------- championship
interface Champ {
  car: CarId; rounds: { seed: number; style: StyleId }[]; round: number; laps: number; difficulty: 0 | 1 | 2;
  pts: Record<string, number>; credits: number; up: Partial<Record<UpKey, number>>;
  log: { name: string; pos: number; pts: number; winner: string }[];
}
let champ: Champ | null = (() => { try { return JSON.parse(localStorage.getItem(CHAMP_KEY) || 'null'); } catch { return null; } })();
const saveChamp = () => { try { if (champ) localStorage.setItem(CHAMP_KEY, JSON.stringify(champ)); else localStorage.removeItem(CHAMP_KEY); } catch { /* private mode */ } };
const seasonOver = () => !!champ && champ.round >= champ.rounds.length;
function standings(c: Champ): string {
  return TEAMS.map((t) => ({ t, p: c.pts[t.short] || 0 })).sort((a, b) => b.p - a.p)
    .map((x, k) => `<tr class="${x.t.short === 'NEU' ? 'me' : ''}"><td class="n">${k + 1}</td><td><i class="dot" style="background:${x.t.color}"></i>${x.t.name}</td><td class="n">${x.p}</td></tr>`).join('');
}
function roundsTable(c: Champ): string {
  return c.rounds.map((r, k) => {
    const done = c.log[k], name = r.style === 'endurance' ? `${STYLES[r.style].label} finale` : STYLES[r.style].label;
    return `<tr class="${k === c.round ? 'me' : ''}"><td class="n">${k + 1}</td><td>${name}</td><td>${done ? `${done.name}` : k === c.round ? 'next' : ''}</td><td class="n">${done ? `P${done.pos}, ${done.pts} pts` : ''}</td></tr>`;
  }).join('');
}
function seasonHub() {
  if (!champ || seasonOver()) return seasonNew();
  const c = champ, rd = c.rounds[c.round];
  const atRound = inSeason && mode === 'practice' && !state.custom && state.seed === rd.seed && track.style === rd.style;
  modal(`<h1>Championship</h1><p>The ${CAR_CLASSES[c.car].name} over ${c.rounds.length} rounds, ${c.laps} laps each. Your drivers carry what they learn from round to round, and points buy upgrades. ${c.credits} credits in the bank.</p>
    <div class="cols"><div><table class="res"><tr><th></th><th>Round</th><th>Circuit</th><th>Result</th></tr>${roundsTable(c)}</table></div>
    <div><table class="res"><tr><th></th><th>Standings</th><th>Pts</th></tr>${standings(c)}</table></div></div>
    <div class="actions"><button class="btn" id="mQuit">Abandon season</button><button class="btn" id="mGarage">Garage</button>${atRound ? '<button class="btn" id="mBack">Close</button><button class="btn primary" id="mGo">Race weekend</button>' : `<button class="btn primary" id="mGo">Go to round ${c.round + 1}</button>`}</div>`, true);
  $('mGarage').onclick = () => garage();
  $('mQuit').onclick = () => { champ = null; saveChamp(); leaveContext(); modal(null); toast('Season abandoned'); };
  if (atRound) { $('mBack').onclick = () => modal(null); $('mGo').onclick = seasonRace; } else $('mGo').onclick = enterRound;
}
function seasonNew() {
  const o = { car: state.car, rounds: 6, laps: 5, difficulty: 1 as 0 | 1 | 2, finale: 'no' };
  const last = champ && seasonOver() ? `<h2>Last season</h2><table class="res">${standings(champ)}</table>` : '';
  modal(`<h1>New championship</h1><p>A season across several circuits. Between rounds your drivers keep learning, and the points you score buy upgrades in the garage. The rival teams develop their cars as the season goes on, so keep up.</p>
    <h2>Car</h2><div class="opts" data-opt="car">${CAR_IDS.map((id) => `<button class="btn${id === o.car ? ' sel' : ''}" data-v="${id}">${CAR_CLASSES[id].name}</button>`).join('')}</div>
    <h2>Rounds</h2>${optRow('rounds', [['4', '4'], ['6', '6'], ['8', '8']], '6')}
    <h2>Race distance</h2>${optRow('laps', [['3', '3 laps'], ['5', '5 laps'], ['8', '8 laps']], '5')}
    <h2>Opposition</h2>${optRow('difficulty', [['0', 'Rookies'], ['1', 'Professionals'], ['2', 'Legends']], '1')}
    <h2>Finale</h2>${optRow('finale', [['no', 'A normal round'], ['yes', 'Green hell: a 5 km endurance circuit']], 'no')}
    ${last}
    <div class="actions"><button class="btn" id="mBack">Cancel</button><button class="btn primary" id="mGo">Start the season</button></div>`, true);
  $$('#modal .opts').forEach((row) => row.querySelectorAll<HTMLElement>('button').forEach((b) => (b.onclick = () => {
    const k = row.dataset.opt!;
    (o as any)[k] = k === 'car' || k === 'finale' ? b.dataset.v : Number(b.dataset.v);
    row.querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b));
  })));
  $('mBack').onclick = () => modal(null);
  $('mGo').onclick = () => {
    const styles: StyleId[] = ['classic', 'speed', 'street', 'technical', 'eight'];
    for (let i = styles.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [styles[i], styles[j]] = [styles[j], styles[i]]; }
    const rounds = Array.from({ length: o.rounds }, (_, k) => ({ seed: 1 + Math.floor(Math.random() * 99999), style: styles[k % styles.length] }));
    if (o.finale === 'yes') rounds[rounds.length - 1].style = 'endurance';
    champ = { car: o.car, rounds, round: 0, laps: o.laps, difficulty: o.difficulty, pts: {}, credits: 0, up: {}, log: [] };
    saveChamp();
    enterRound();
  };
}
/** Load the current round's circuit. The drivers come along from wherever they were. */
function enterRound() {
  if (!champ || seasonOver()) return;
  challenge = null; inSeason = true;
  const rd = champ.rounds[champ.round], cls = CAR_CLASSES[champ.car];
  const keep = { steer: state.setup.steer, balance: state.setup.balance, aids: state.setup.aids };
  state.custom = null; state.seed = rd.seed; state.style = rd.style;
  const sameCar = state.car === champ.car;
  state.car = champ.car; state.setup = seasonSetup(champ.car, champ.up); state.tyre = cls.tyre;
  if (sameCar) Object.assign(state.setup, keep);
  save();
  view.setCarClass(cls); buildCarPane();
  modal(null); buildTrack(true);
  paintCarChip(); setMode('practice');
  toast(`Round ${champ.round + 1}: ${track.name}. Practise, then race`);
}
function garage(after?: () => void) {
  if (!champ) return;
  const c = champ, base = CAR_CLASSES[c.car].setup;
  const rows = UP_KEYS.map((k) => {
    const lv = c.up[k] ?? 0, cost = upCost(lv), full = lv >= UP_MAX;
    return `<tr><td><b>${UPGRADES[k].label}</b><br><span class="hint">${UPGRADES[k].blurb} per level</span></td><td>${'●'.repeat(lv)}${'○'.repeat(UP_MAX - lv)}</td><td class="n">${full ? 'max' : `${cost} cr`}</td><td><button class="btn${full || c.credits < cost ? '' : ' primary'}" data-k="${k}" ${full || c.credits < cost ? 'disabled' : ''}>Buy</button></td></tr>`;
  }).join('');
  const s = seasonSetup(c.car, c.up);
  modal(`<h1>Garage</h1><p>${c.credits} credits. You earn one credit per championship point, plus 6 for every race you start. The drivers have to get used to each upgrade, so buy before practice, not just before the race.</p>
    <table class="res">${rows}</table>
    <p class="hint">Your car now: ${s.power} kW (standard ${base.power}), grip ${s.grip.toFixed(2)}, downforce ${s.downforce.toFixed(1)}, ${s.mass} kg, brakes ${s.brakes.toFixed(2)} g.</p>
    <div class="actions"><button class="btn primary" id="mBack">Done</button></div>`);
  $$('#modal button[data-k]').forEach((b) => (b.onclick = () => {
    const k = b.dataset.k as UpKey, lv = c.up[k] ?? 0;
    if (lv >= UP_MAX || c.credits < upCost(lv)) return;
    c.credits -= upCost(lv); c.up[k] = lv + 1; saveChamp();
    if (inSeason) {
      const keep = { steer: state.setup.steer, balance: state.setup.balance, aids: state.setup.aids };
      state.setup = { ...seasonSetup(c.car, c.up), ...keep };
      buildCarPane(); carChanged(`${UPGRADES[k].label} upgraded: the drivers have to get used to it`, 'the old spec');
    }
    garage(after);
  }));
  if (after) $('mBack').textContent = 'Next round';
  $('mBack').onclick = () => { modal(null); updateBanner(); after?.(); };
}
function seasonRace() {
  if (!champ) return;
  if (!trainer.hall.length) { raceSetup(); return; } // explains that the drivers need a lap first
  const c = champ, o: RaceOpts = { laps: c.laps, difficulty: c.difficulty, forecast: c.round % 3 === 2 ? 'changeable' : 'current', startTyre: 'medium', rivalBoost: 1 + 0.012 * c.round };
  modal(`<h1>Round ${c.round + 1}: ${track.name}</h1><p>${c.laps} laps against ${['rookies', 'professionals', 'legends'][c.difficulty]}. ${o.forecast === 'changeable' ? 'Showers are forecast.' : 'The forecast is settled.'} Your driver is the best brain from practice (${fmtLap(trainer.hall[0].lap)}).</p>
    <h2>Start on</h2><div id="mTyres" class="tyres"></div>
    <div class="actions"><button class="btn" id="mBack">More practice</button><button class="btn primary" id="mGo">Qualify</button></div>`);
  tyreButtons($('mTyres'), () => o.startTyre, (t) => { o.startTyre = t; });
  $('mBack').onclick = () => modal(null);
  $('mGo').onclick = () => startWeekend(o, true);
}
function seasonResults() {
  const r = race!, c = champ!;
  for (const x of r.results) c.pts[x.e.team.short] = (c.pts[x.e.team.short] || 0) + x.points;
  const me = r.results.find((x) => x.e.isPlayer)!, earned = me.points + 6;
  c.credits += earned;
  c.log[c.round] = { name: track.name, pos: me.pos, pts: me.points, winner: r.results[0].e.team.short };
  c.round++;
  saveChamp();
  const over = seasonOver();
  const order = TEAMS.map((t) => ({ t, p: c.pts[t.short] || 0 })).sort((a, b) => b.p - a.p);
  const rows = r.results.map((x) => `<tr class="${x.e.isPlayer ? 'me' : ''}"><td class="n">${x.pos}</td><td><i class="dot" style="background:${x.e.team.color}"></i>${x.e.team.name}</td><td class="hint">${x.e.persona}</td><td class="n">${x.points}</td></tr>`).join('');
  const champText = over ? (order[0].t.short === 'NEU' ? 'You are the champions!' : `${order[0].t.name} are champions. You finished P${order.findIndex((x) => x.t.short === 'NEU') + 1}.`) : '';
  modal(`<h1>${over ? champText : me.e.dnf ? 'Did not finish' : `P${me.pos} at ${track.name}`}</h1>
    <p>${me.points} points and ${earned} credits. ${over ? 'That was the final round.' : `Next: round ${c.round + 1} of ${c.rounds.length}.`}</p>
    <div class="cols"><div><table class="res"><tr><th></th><th>Race</th><th>Style</th><th>Pts</th></tr>${rows}</table></div>
    <div><table class="res"><tr><th></th><th>Standings</th><th>Pts</th></tr>${standings(c)}</table></div></div>
    <div class="actions">${over ? '<button class="btn" id="mBack">Back to practice</button><button class="btn primary" id="mGo">New season</button>' : '<button class="btn" id="mGarage">Garage</button><button class="btn primary" id="mGo">Next round</button>'}</div>`, true);
  if (over) { $('mBack').onclick = () => { inSeason = false; setMode('practice'); }; $('mGo').onclick = () => { inSeason = false; setMode('practice'); seasonNew(); }; }
  else { $('mGarage').onclick = () => garage(enterRound); $('mGo').onclick = enterRound; }
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
    ghosts: ghostPoses(),
  };
}
function raceFrame(now: number): Frame {
  const r = race!, blink = (now * 5) % 1 < 0.5;
  return {
    cars: r.cars,
    color: (i, out) => { out.copy(teamCol[i]); },
    hidden: (i) => r.phase === 'racing' && r.time < r.entries[i].holdUntil && blink,
    focus: camTarget === 'leader' ? r.leader().car : camTarget === 'director' ? direct(r).car : r.player.car, marker: r.player.dnf ? null : r.player.car, rays: null, vision: 0,
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

readShared();
view.setCarClass(CAR_CLASSES[state.car]);
buildCarPane(); buildDriverPane();
$('ghostBtn').classList.toggle('on', state.ghosts);
document.body.dataset.mode = 'practice';
$$('#modeSeg button').forEach((b) => b.classList.toggle('sel', b.dataset.mode === 'practice'));
setSpeed(1); setCam('overview');
buildTrack(false);
carChanged(null);
trainer.transfer = null;
syncSky();
openPane(state.pane);
applyHud();
(window as any).neurolap = { get trainer() { return trainer; }, get race() { return race; }, get surf() { return surf; }, get track() { return track; }, get champ() { return champ; }, view, env, state, newTrack, setSpeed, setTime, setWeather, pickCar, raceSetup, startWeekend, setMode, shareLink, startChallenge, openEditor, seasonHub, enterRound, seasonRace, buildTrack };
requestAnimationFrame(frame);
