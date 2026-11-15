// Renderer.
//
// The static world is not drawn every frame. It is rendered into a "tile": a set of
// textures holding, for every pixel, the light that reaches it. That light is gathered
// progressively, the way an offline renderer does it: each pass lights the scene from a
// slightly different point on the sun's disc and from one random direction of the sky,
// each with its own shadow map, and the passes are averaged. A few dozen passes give soft
// sun penumbras and true sky occlusion (the gentle darkness under trees and in corners).
// The tile is only rebuilt when the camera, the time of day or the weather changes; when
// the camera follows a car the tile is larger than the screen and simply slides, and what
// is already gathered is carried across.
//
// Because the tile also keeps colour and depth per pixel, lamps and headlights are added
// afterwards as deferred lights. Cars, rain, snow and the film of water on the road are
// drawn live into an HDR buffer on top, and the frame is finished with bloom, depth of
// field, filmic tone mapping and anti-aliasing.
import * as THREE from 'three';
import { Track, idxAt } from './track';
import { Car, RAY_ANGLES, N_RAYS } from './sim';
import { buildWorld, World } from './world';
import { carGeometry, wheelGeometry } from './carmodels';
import { CarClass, CAR_CLASSES } from './cars';
import { Env, Surface, BINS, sunHeight } from './weather';
import { CAR_SCALE } from './race';

const CAM_DIR = new THREE.Vector3(1, 1.15, 1).normalize();
const MAX_CARS = 96;
const L_STATIC = 0, L_LIVE = 1, L_PRE = 2;
const PASSES_STILL = 44, PASSES_MOVING = 26, OVERSCAN = 1.9, FOLLOW_RES = 0.62, HISTORY_CAP = 20;
export const PALETTE = ['#e23b3b', '#f08a24', '#3fae4a', '#22a6c9', '#2f6fe0', '#8a55d6', '#e0559f', '#e9e6dd', '#1fb894', '#f26a3d'].map((c) => new THREE.Color(c));
export const GOLD = new THREE.Color('#f2b705');
const WRECK = new THREE.Color('#3d4048');

/** What to draw this frame, whoever is running the cars (practice or a race). */
export interface Frame {
  cars: Car[];
  color(i: number, out: THREE.Color): void;
  hidden(i: number): boolean;
  focus: Car | null;          // camera follows this one in follow mode
  marker: Car | null;         // gets the arrow
  rays: Car | null;           // gets its sensor rays drawn
  vision: number;
  path: { P: Float32Array; N: number; version: number } | null;
  crash: { x: Float32Array; y: Float32Array; z: Float32Array; count: number };
  startLights: number;        // how many of the five start lights are lit
}

// ---------------------------------------------------------------- sky
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const C = (r: number, g: number, b: number) => new THREE.Color(r, g, b);
const K = {
  sunLow: C(1.0, 0.36, 0.1), sunHigh: C(1.0, 0.93, 0.82), moon: C(0.5, 0.62, 1.0), cloudSun: C(0.82, 0.86, 0.92),
  zenDay: C(0.16, 0.36, 0.95), zenNight: C(0.006, 0.01, 0.03), zenWarm: C(0.2, 0.22, 0.6),
  horDay: C(0.62, 0.78, 1.0), horNight: C(0.014, 0.022, 0.06), horWarm: C(1.0, 0.5, 0.22),
  cloudDay: C(0.52, 0.56, 0.62), gnd: C(0.2, 0.17, 0.12),
};
class Sky {
  sunDir = new THREE.Vector3(); sunCol = new THREE.Color(); sunInt = 1; sunSoft = 0.02;
  zen = new THREE.Color(); hor = new THREE.Color(); skyInt = 1;   // sky radiance towards the zenith and the horizon
  avg = new THREE.Color(); gnd = new THREE.Color();
  ref = new THREE.Color(); snow = new THREE.Color(); lit = 1;
  night = 0; day = 1; exposure = 1;
  private t = new THREE.Color();
  set(time: number, overcast: number) {
    const h = sunHeight(time), o = overcast;
    const day = (this.day = smooth(-0.05, 0.3, h)), warm = Math.exp(-Math.pow(h / 0.2, 2)) * (1 - o);
    this.night = 1 - smooth(-0.12, 0.1, h);
    const f = Math.min(1, Math.max(0, (time - 6) / 14)), A0 = Math.atan2(0.7, -0.6);
    if (h > 0.02) {
      const el = Math.max(0.11, h * 1.08), az = A0 + (f - 0.5) * 2.6;
      this.sunDir.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
      this.sunInt = 4.2 * smooth(0.02, 0.26, h);
      this.sunCol.copy(K.sunLow).lerp(K.sunHigh, smooth(0.02, 0.45, h));
    } else {
      const el = 0.8, az = A0 + 0.9;
      this.sunDir.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
      this.sunInt = 0.16 * smooth(0.02, -0.14, h);
      this.sunCol.copy(K.moon);
    }
    this.sunInt *= 1 - 0.86 * o;
    this.sunCol.lerp(K.cloudSun, o * 0.8);
    this.sunSoft = 0.02 + 0.09 * o + 0.012 * warm;
    this.zen.copy(K.zenNight).lerp(K.zenDay, day).lerp(K.zenWarm, warm * 0.55);
    this.hor.copy(K.horNight).lerp(K.horDay, day).lerp(K.horWarm, warm * 0.8);
    const cloud = this.t.copy(K.cloudDay).multiplyScalar(0.04 + 0.96 * day);
    this.zen.lerp(cloud, o * 0.9); this.hor.lerp(cloud, o * 0.85);
    this.skyInt = 1.9;
    this.avg.copy(this.zen).lerp(this.hor, 0.5);
    this.gnd.copy(K.gnd).multiplyScalar(0.25 + 0.75 * day);
    this.ref.copy(this.avg);
    const direct = this.sunInt * Math.max(0.1, this.sunDir.y);
    this.lit = (direct + this.skyInt * 0.5 * (this.avg.r + this.avg.g + this.avg.b) / 3) / Math.PI;
    this.snow.copy(this.sunCol).multiplyScalar(direct).add(this.t.copy(this.avg).multiplyScalar(this.skyInt * 0.5)).multiplyScalar(0.86 / Math.PI);
    this.exposure = 0.92 + 1.5 * this.night + 0.3 * o * day + 0.6 * (1 - day) * (1 - this.night);
  }
  /** Radiance of the sky in a given direction. */
  at(y: number, out: THREE.Color) { return out.copy(this.hor).lerp(this.zen, Math.pow(Math.max(0, y), 0.5)); }
}

// ---------------------------------------------------------------- shaders
const FS_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const NOISE = `
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
float fbm(vec2 p){ return 0.5 * noise(p) + 0.3 * noise(p * 2.1 + 3.0) + 0.2 * noise(p * 4.3 + 8.0); }`;
// carry gathered light across when the tile slides
const COPY_FRAG = `
uniform sampler2D tOld; uniform vec2 uScale; uniform vec2 uOff; uniform float uCap; varying vec2 vUv;
void main(){
  vec2 uv = vUv * uScale + uOff;
  vec4 a = texture2D(tOld, uv);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0 || a.a < 0.5) { gl_FragColor = vec4(0.0); return; }
  float k = min(a.a, uCap) / a.a;
  gl_FragColor = a * k;
}`;
// show the tile: averaged light, backdrop, drifting cloud shadow, a breath of haze
const SHOW_FRAG = `
uniform sampler2D tAccum; uniform sampler2D tDepth; uniform vec2 uScale; uniform vec2 uOff;
uniform vec3 bgTop; uniform vec3 bgBottom; uniform float uNight; uniform float uFlash; uniform float uTime; uniform float uCloud;
uniform mat4 uInvVP; uniform vec3 uFog; uniform float uFogAmt; uniform float uFocus; uniform float uRange; uniform vec2 uPx;
varying vec2 vUv;
${NOISE}
void main(){
  vec2 uv = vUv * uScale + uOff;
  vec4 a = texture2D(tAccum, uv);
  float d = texture2D(tDepth, uv).r;
  vec3 col;
  if (a.a < 0.5 || d > 0.99999) {
    d = 1.0;
    float v = smoothstep(0.0, 1.0, vUv.y);
    col = mix(bgBottom, bgTop, v);
    vec2 cell = floor(vUv / uPx / 3.0);
    col += vec3(0.8, 0.85, 1.0) * step(0.996, hash(cell)) * hash(cell + 7.0) * uNight * smoothstep(0.25, 0.9, vUv.y) * 0.4;
  } else {
    col = a.rgb / a.a;
    vec4 wp = uInvVP * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec2 p = wp.xz / wp.w;
    float cl = fbm(p * 0.0045 + uTime * vec2(0.011, 0.006));
    col *= 1.0 - uCloud * smoothstep(0.52, 0.78, cl) * 0.38;
    float far = clamp((d - uFocus) * uRange / 420.0, 0.0, 1.0);
    col = mix(col, uFog, far * uFogAmt);
  }
  col += vec3(0.6, 0.66, 0.9) * uFlash;
  gl_FragColor = vec4(col, 1.0);
  gl_FragDepth = d;
}`;
// a light (point or spot) applied to the tile by reading its colour and depth
const VOL_VERT = `
attribute vec4 iPosR; attribute vec4 iDirC; attribute vec3 iCol;
varying vec4 vPosR; varying vec4 vDirC; varying vec3 vCol;
void main(){
  vPosR = iPosR; vDirC = iDirC; vCol = iCol;
  float spot = step(-1.5, iDirC.w);
  vec3 wp = iPosR.xyz + iDirC.xyz * iPosR.w * 0.5 * spot + position * iPosR.w * mix(1.0, 0.62, spot);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const VOL_FRAG = `
uniform sampler2D tDepth; uniform sampler2D tAlbedo;
uniform vec2 uRes; uniform vec2 uScale; uniform vec2 uOff; uniform vec2 uTexel; uniform mat4 uInvVP; uniform vec3 uToCam;
varying vec4 vPosR; varying vec4 vDirC; varying vec3 vCol;
vec3 posAt(vec2 uv){ float d = texture2D(tDepth, uv).r; vec4 w = uInvVP * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); return w.xyz / w.w; }
void main(){
  vec2 uv = gl_FragCoord.xy / uRes * uScale + uOff;
  if (texture2D(tDepth, uv).r > 0.9999) discard;
  vec3 P = posAt(uv);
  vec3 L = vPosR.xyz - P;
  float dist = length(L);
  if (dist > vPosR.w) discard;
  L /= dist;
  vec3 n = normalize(cross(posAt(uv + vec2(uTexel.x, 0.0)) - P, posAt(uv + vec2(0.0, uTexel.y)) - P));
  if (dot(n, uToCam) < 0.0) n = -n;
  float ndl = max(dot(n, L) * 0.85 + 0.15, 0.0);
  float att = 1.0 - dist / vPosR.w; att = att * att / (1.0 + dist * dist * 0.012);
  if (vDirC.w > -1.5) att *= smoothstep(vDirC.w, vDirC.w + 0.12, dot(-L, vDirC.xyz));
  vec3 alb = texture2D(tAlbedo, uv).rgb;
  alb = pow(alb, vec3(1.35)) * 0.72;
  gl_FragColor = vec4(alb * vCol * att * ndl, 1.0);
}`;
// soft glowing sprites: lamps, headlights, tail lights. With uReflect they become the
// streak a light smears down a wet road.
const GLOW_VERT = `
attribute vec4 iPosS; attribute vec4 iColI; uniform float uReflect;
varying vec2 vP; varying vec4 vC;
void main(){
  vP = position.xy; vC = iColI;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]), up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 off = mix(right * position.x + up * position.y, right * position.x * 0.5 + up * (position.y - 1.0) * 3.4, uReflect) * iPosS.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(iPosS.xyz + off, 1.0);
}`;
const GLOW_FRAG = `
uniform float uReflect; varying vec2 vP; varying vec4 vC;
void main(){
  float r2 = dot(vP, vP);
  float a = mix(exp(-r2 * 6.0) * 0.5 + exp(-r2 * 60.0) * 2.0, exp(-vP.x * vP.x * 5.0) * (0.5 - 0.5 * vP.y) * (0.5 - 0.5 * vP.y) * 0.4, uReflect);
  gl_FragColor = vec4(vC.rgb * vC.a * a, 1.0);
}`;
// the film of water or snow lying on the tarmac
const WET_VERT = `
attribute vec2 aw; varying vec2 vW; varying vec3 vWorld;
void main(){ vW = aw; vWorld = position; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }`;
const WET_FRAG = `
uniform vec3 uSky; uniform vec3 uSnow; uniform float uTime; uniform float uRain; uniform float uLit;
varying vec2 vW; varying vec3 vWorld;
${NOISE}
float ripples(vec2 p){
  vec2 id = floor(p), f = fract(p) - 0.5;
  float t = fract(uTime * 1.4 + hash(id) * 7.0);
  vec2 c = (vec2(hash(id + 3.1), hash(id + 5.7)) - 0.5) * 0.5;
  return smoothstep(0.05, 0.0, abs(length(f - c) - t * 0.42)) * (1.0 - t);
}
void main(){
  vec2 p = vWorld.xz;
  float w = vW.x, s = vW.y;
  float wet = smoothstep(0.02, 0.4, w);
  float puddle = smoothstep(0.7, 0.9, w + (fbm(p * 0.3) - 0.5) * 0.5);
  float rip = (ripples(p * 0.7) + ripples(p * 1.3 + 4.0)) * uRain * wet;
  // wet tarmac goes dark and glossy; standing water mirrors the sky
  vec3 col = mix(vec3(0.006, 0.007, 0.009) * uLit, uSky * 0.42, 0.06 + 0.7 * puddle + rip * 0.25);
  float a = wet * 0.62 + puddle * 0.3 + rip * 0.1;
  float sn = smoothstep(0.03, 0.42, s + (fbm(p * 0.9) - 0.5) * 0.2);
  col = mix(col, uSnow * (0.86 + 0.14 * noise(p * 2.3)), sn);
  a = max(a, sn * 0.96);
  gl_FragColor = vec4(col, a);
}`;
const RAIN_VERT = `
attribute vec3 aSeed; attribute float aEnd;
uniform float uTime; uniform vec3 uCenter; uniform vec3 uSize; uniform vec3 uVel; uniform float uLen; uniform float uSnow; uniform float uPx;
varying float vA;
void main(){
  vec3 p = aSeed * uSize + uVel * uTime;
  p.xz = mod(p.xz - uCenter.xz, uSize.xz) - 0.5 * uSize.xz + uCenter.xz;
  p.y = mod(p.y, uSize.y) + uCenter.y;
  p.x += sin(uTime * 0.9 + aSeed.x * 40.0) * 1.6 * uSnow; p.z += cos(uTime * 0.7 + aSeed.z * 40.0) * 1.6 * uSnow;
  p -= normalize(uVel) * uLen * aEnd;
  vA = 0.55 + 0.45 * aSeed.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  gl_PointSize = uPx * (0.6 + aSeed.x);
}`;
const RAIN_FRAG = `uniform vec3 uCol; uniform float uAlpha; varying float vA; void main(){ gl_FragColor = vec4(uCol, uAlpha * vA); }`;
const SPRAY_VERT = `
attribute float aAlpha; attribute float aSize; uniform float uPxPerM; varying float vA;
void main(){ vA = aAlpha; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); gl_PointSize = min(aSize * uPxPerM, 420.0); }`;
const SPRAY_FRAG = `uniform vec3 uCol; varying float vA; void main(){ vec2 q = gl_PointCoord - 0.5; float r = length(q) * 2.0; float a = exp(-r * r * 3.2) * (1.0 - smoothstep(0.75, 1.0, r)) * vA; gl_FragColor = vec4(uCol, a); }`;
// --- finishing passes ---
const BRIGHT_FRAG = `
uniform sampler2D tex; uniform vec2 uTexel; varying vec2 vUv;
void main(){
  vec3 c = vec3(0.0);
  c += texture2D(tex, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tex, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture2D(tex, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tex, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  float l = max(c.r, max(c.g, c.b));
  gl_FragColor = vec4(c * smoothstep(0.9, 2.2, l), 1.0);
}`;
const BLUR_FRAG = `
uniform sampler2D tex; uniform vec2 uDir; varying vec2 vUv;
void main(){
  vec3 c = texture2D(tex, vUv).rgb * 0.227;
  c += (texture2D(tex, vUv + uDir * 1.385).rgb + texture2D(tex, vUv - uDir * 1.385).rgb) * 0.316;
  c += (texture2D(tex, vUv + uDir * 3.231).rgb + texture2D(tex, vUv - uDir * 3.231).rgb) * 0.0703;
  gl_FragColor = vec4(c, 1.0);
}`;
// depth of field, bloom, filmic tone curve, vignette, grain
const FINAL_FRAG = `
uniform sampler2D tHdr; uniform sampler2D tBloom1; uniform sampler2D tBloom2; uniform sampler2D tDepth;
uniform vec2 uScale; uniform vec2 uOff; uniform vec2 uPx; uniform float uFocus; uniform float uCoc; uniform float uCocMax;
uniform float uExposure; uniform float uTime; uniform float uBloom;
varying vec2 vUv;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main(){
  float d = texture2D(tDepth, vUv * uScale + uOff).r;
  float coc = d > 0.9999 ? uCocMax : min(uCocMax, abs(d - uFocus) * uCoc);
  vec3 c = texture2D(tHdr, vUv).rgb;
  if (coc > 0.6) {
    float w = 1.0;
    for (int i = 0; i < 14; i++) {
      float fi = float(i) + 0.5, r = sqrt(fi / 14.0) * coc, a = fi * 2.39996;
      c += texture2D(tHdr, vUv + vec2(cos(a), sin(a)) * r * uPx).rgb; w += 1.0;
    }
    c /= w;
  }
  c += (texture2D(tBloom1, vUv).rgb * 0.6 + texture2D(tBloom2, vUv).rgb) * uBloom;
  c *= uExposure;
  c = aces(c);
  // grade: a touch more colour and a gentle S-curve, as a print would have
  c = mix(vec3(dot(c, vec3(0.3, 0.59, 0.11))), c, 1.08);
  c = clamp(mix(c, c * c * (3.0 - 2.0 * c), 0.3), 0.0, 1.0);
  vec2 q = vUv - 0.5;
  c *= 1.0 - dot(q, q) * 0.42;
  c = pow(c, vec3(1.0 / 2.2));
  c += (hash(vUv * 913.0 + uTime) - 0.5) * 0.014;
  gl_FragColor = vec4(c, 1.0);
}`;
const FXAA_FRAG = `
uniform sampler2D tex; uniform vec2 uPx; varying vec2 vUv;
float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
void main(){
  vec3 m = texture2D(tex, vUv).rgb;
  float lM = luma(m);
  float lNW = luma(texture2D(tex, vUv + vec2(-1.0, -1.0) * uPx).rgb), lNE = luma(texture2D(tex, vUv + vec2(1.0, -1.0) * uPx).rgb);
  float lSW = luma(texture2D(tex, vUv + vec2(-1.0, 1.0) * uPx).rgb), lSE = luma(texture2D(tex, vUv + vec2(1.0, 1.0) * uPx).rgb);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE))), lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float red = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
  dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + red), -8.0, 8.0) * uPx;
  vec3 a = 0.5 * (texture2D(tex, vUv + dir * (1.0 / 3.0 - 0.5)).rgb + texture2D(tex, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture2D(tex, vUv - dir * 0.5).rgb + texture2D(tex, vUv + dir * 0.5).rgb);
  float lB = luma(b);
  gl_FragColor = vec4((lB < lMin || lB > lMax) ? a : b, 1.0);
}`;
const SKY_FRAG = `
uniform vec3 uZen; uniform vec3 uHor; uniform vec3 uGnd; uniform vec3 uSunDir; uniform vec3 uSunCol;
varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir);
  vec3 c = d.y > 0.0 ? mix(uHor, uZen, pow(d.y, 0.5)) : mix(uHor, uGnd, smoothstep(0.0, -0.25, d.y));
  float s = max(dot(d, uSunDir), 0.0);
  c += uSunCol * (pow(s, 900.0) * 30.0 + pow(s, 40.0) * 0.5);
  gl_FragColor = vec4(c, 1.0);
}`;

function instanced(base: THREE.BufferGeometry, attrs: Record<string, number>, max: number) {
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index; g.setAttribute('position', base.attributes.position);
  const arr: Record<string, Float32Array> = {};
  for (const k in attrs) {
    arr[k] = new Float32Array(max * attrs[k]);
    const a = new THREE.InstancedBufferAttribute(arr[k], attrs[k]); a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute(k, a);
  }
  g.instanceCount = 0;
  return { g, arr, touch() { for (const k in attrs) (g.attributes[k] as THREE.BufferAttribute).needsUpdate = true; } };
}
const fsMat = (frag: string, uniforms: Record<string, THREE.IUniform>, extra: THREE.ShaderMaterialParameters = {}) =>
  new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: frag, depthTest: false, depthWrite: false, uniforms, ...extra });

const SPRAY_N = 7000, SPRAY_K = 11, VOL_MAX = MAX_CARS + 96;
const BODY_MOTION = 1.6; // body roll, dive and squat are drawn a little larger than life so they read from up here
interface Tile { l: number; b: number; w: number; h: number; follow: boolean }

export class View {
  renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 10, 1600);
  private bakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 10, 1600);
  private sun = new THREE.DirectionalLight('#ffffff', 3);
  private skyLight = new THREE.DirectionalLight('#ffffff', 0);
  private hemi = new THREE.HemisphereLight('#ffffff', '#333333', 1);
  private sky = new Sky();
  private world: World | null = null;
  private track: Track | null = null;
  private surf: Surface | null = null;
  // the tile
  private accum: THREE.WebGLRenderTarget[] = []; private cur = 0;
  private gAlb!: THREE.WebGLRenderTarget;
  private tile: Tile | null = null; private tileW = 0; private tileH = 0;
  private passes = 0; private need = 0; private sampleNo = 1;
  private lightKey = '';
  // the frame
  private hdr!: THREE.WebGLRenderTarget; private ldr!: THREE.WebGLRenderTarget;
  private bl: THREE.WebGLRenderTarget[] = [];
  private pmrem: THREE.PMREMGenerator; private envRT: THREE.WebGLRenderTarget | null = null; private envWait = 0;
  private skyScene = new THREE.Scene(); private skyMat: THREE.ShaderMaterial;
  private albedoMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  private depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
  private fsScene = new THREE.Scene(); private fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private fsQuad: THREE.Mesh;
  private copyMat: THREE.ShaderMaterial; private showMat: THREE.ShaderMaterial; private brightMat: THREE.ShaderMaterial; private blurMat: THREE.ShaderMaterial;
  private finalMat: THREE.ShaderMaterial; private fxaaMat: THREE.ShaderMaterial; private volMat: THREE.ShaderMaterial;
  private vol = instanced(new THREE.BoxGeometry(2, 2, 2), { iPosR: 4, iDirC: 4, iCol: 3 }, VOL_MAX);
  private glows = instanced(new THREE.PlaneGeometry(2, 2), { iPosS: 4, iColI: 4 }, 640);
  private refl = instanced(new THREE.PlaneGeometry(2, 2), { iPosS: 4, iColI: 4 }, 640);
  private cars: THREE.InstancedMesh; private carShadow: THREE.InstancedMesh;
  private carMat: THREE.MeshPhysicalMaterial;
  private marker: THREE.Mesh; private rays: THREE.LineSegments; private line: THREE.Mesh; private crashes: THREE.InstancedMesh;
  private wet: THREE.Mesh | null = null; private wetMat: THREE.ShaderMaterial; private wetVersion = -1;
  private rain: THREE.LineSegments; private snowPts: THREE.Points; private rainMat: THREE.ShaderMaterial; private snowMat: THREE.ShaderMaterial;
  private spray: THREE.Points; private sprayMat: THREE.ShaderMaterial; private sp = new Float32Array(SPRAY_N * SPRAY_K); private spHead = 0;
  private wheels: THREE.InstancedMesh; private wheelMat: THREE.MeshStandardMaterial;
  private lineVersion = -1; private crashSeen = -1;
  private center = new THREE.Vector3(); private R = new THREE.Vector3(); private U = new THREE.Vector3();
  private fit = { cx: 0, cy: 0, w: 1, h: 1 };
  private cam = { cx: 0, cy: 0, s: 0.3 };
  private snap = true;
  private cls: CarClass = CAR_CLASSES.gt;
  private overcast = 0; private rainVis = 0; private snowVis = 0;
  private lastT = 0; private flash = 0; private focusD = 0.5;
  env: Env = { time: 13, weather: 'dry', intensity: 0 };
  headlights: 'auto' | 'on' | 'off' = 'auto';
  insetLeft = 0; insetRight = 0; insetTop = 0; insetBottom = 0;
  mode: 'overview' | 'follow' = 'overview';
  zoom = 1; panX = 0; panY = 0;
  showLine = true; showRays = true;
  followScale = 0.095;   // metres per CSS pixel when following a car
  lead = 0;              // seconds: look this far ahead of the followed car
  dof = 1;               // depth of field strength, 0 = off
  bakes = 0;

  constructor(canvas: HTMLCanvasElement) {
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' }));
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.autoClear = false;
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap; r.shadowMap.autoUpdate = false;

    this.sun.castShadow = true; this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0003; this.sun.shadow.normalBias = 0.22;
    this.skyLight.castShadow = true; this.skyLight.shadow.mapSize.set(2048, 2048);
    this.skyLight.shadow.bias = -0.0005; this.skyLight.shadow.normalBias = 0.5;
    for (const l of [this.sun, this.skyLight, this.hemi]) l.layers.enableAll();
    this.scene.add(this.sun, this.sun.target, this.skyLight, this.skyLight.target, this.hemi);

    // the sky, as an environment for reflections
    this.pmrem = new THREE.PMREMGenerator(r);
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      vertexShader: `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: SKY_FRAG,
      uniforms: { uZen: { value: new THREE.Color() }, uHor: { value: new THREE.Color() }, uGnd: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color() } },
    });
    this.skyScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), this.skyMat));

    this.fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.fsQuad.frustumCulled = false;
    this.fsScene.add(this.fsQuad);
    const V2 = () => ({ value: new THREE.Vector2() });
    this.copyMat = fsMat(COPY_FRAG, { tOld: { value: null }, uScale: V2(), uOff: V2(), uCap: { value: HISTORY_CAP } });
    this.showMat = fsMat(SHOW_FRAG, {
      tAccum: { value: null }, tDepth: { value: null }, uScale: V2(), uOff: V2(), bgTop: { value: new THREE.Color() }, bgBottom: { value: new THREE.Color() },
      uNight: { value: 0 }, uFlash: { value: 0 }, uTime: { value: 0 }, uCloud: { value: 0 }, uInvVP: { value: new THREE.Matrix4() }, uFog: { value: new THREE.Color() },
      uFogAmt: { value: 0 }, uFocus: { value: 0.5 }, uRange: { value: 1590 }, uPx: V2(),
    }, { depthTest: true, depthFunc: THREE.AlwaysDepth, depthWrite: true });
    this.brightMat = fsMat(BRIGHT_FRAG, { tex: { value: null }, uTexel: V2() });
    this.blurMat = fsMat(BLUR_FRAG, { tex: { value: null }, uDir: V2() });
    this.finalMat = fsMat(FINAL_FRAG, {
      tHdr: { value: null }, tBloom1: { value: null }, tBloom2: { value: null }, tDepth: { value: null }, uScale: V2(), uOff: V2(), uPx: V2(),
      uFocus: { value: 0.5 }, uCoc: { value: 0 }, uCocMax: { value: 0 }, uExposure: { value: 1 }, uTime: { value: 0 }, uBloom: { value: 0.4 },
    });
    this.fxaaMat = fsMat(FXAA_FRAG, { tex: { value: null }, uPx: V2() });
    this.volMat = new THREE.ShaderMaterial({
      vertexShader: VOL_VERT, fragmentShader: VOL_FRAG, depthTest: false, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending,
      uniforms: { tDepth: { value: null }, tAlbedo: { value: null }, uRes: V2(), uScale: V2(), uOff: V2(), uTexel: V2(), uInvVP: { value: new THREE.Matrix4() }, uToCam: { value: CAM_DIR.clone() } },
    });

    const put = <T extends THREE.Object3D>(o: T, layer: number) => { o.layers.set(layer); o.frustumCulled = false; this.scene.add(o); return o; };
    put(new THREE.Mesh(this.vol.g, this.volMat), L_PRE).renderOrder = 0;

    // ----- road film (water, snow) -----
    this.wetMat = new THREE.ShaderMaterial({
      vertexShader: WET_VERT, fragmentShader: WET_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uSky: { value: new THREE.Color() }, uSnow: { value: new THREE.Color() }, uTime: { value: 0 }, uRain: { value: 0 }, uLit: { value: 1 } },
    });

    // ----- cars: lacquered paint that mirrors the sky -----
    this.carMat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.07, envMapIntensity: 1.1 });
    this.cars = put(new THREE.InstancedMesh(carGeometry('gt', 0), this.carMat, MAX_CARS), L_LIVE);
    this.cars.receiveShadow = true;
    this.wheelMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.1, envMapIntensity: 0.6 });
    this.wheels = put(new THREE.InstancedMesh(wheelGeometry(), this.wheelMat, MAX_CARS * 4), L_LIVE);
    this.wheels.receiveShadow = true;
    // a soft pool of shade under each car
    const sc = document.createElement('canvas'); sc.width = 128; sc.height = 128;
    const sg2 = sc.getContext('2d')!;
    const grd = sg2.createRadialGradient(64, 64, 6, 64, 64, 62);
    grd.addColorStop(0, 'rgba(255,255,255,0.95)'); grd.addColorStop(0.5, 'rgba(255,255,255,0.6)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    sg2.fillStyle = grd; sg2.fillRect(0, 0, 128, 128);
    const shTex = new THREE.CanvasTexture(sc);
    const sh = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.carShadow = put(new THREE.InstancedMesh(sh, new THREE.MeshBasicMaterial({ alphaMap: shTex, color: '#000000', transparent: true, opacity: 0.7, depthWrite: false }), MAX_CARS), L_PRE);
    this.carShadow.renderOrder = 4;

    this.marker = put(new THREE.Mesh(new THREE.ConeGeometry(1.0, 2.0, 4).rotateX(Math.PI), new THREE.MeshBasicMaterial({ color: '#ffb400' })), L_LIVE);

    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N_RAYS * 6), 3));
    this.rays = put(new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, depthWrite: false })), L_LIVE);
    this.rays.renderOrder = 4;

    const lg = new THREE.BufferGeometry();
    const LMAX = 3600;
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LMAX * 6), 3));
    lg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(LMAX * 6), 3));
    const li = new Uint32Array((LMAX - 1) * 6);
    for (let i = 0; i < LMAX - 1; i++) li.set([i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 2, i * 2 + 1, i * 2 + 3], i * 6);
    lg.setIndex(new THREE.BufferAttribute(li, 1));
    lg.setDrawRange(0, 0);
    this.line = put(new THREE.Mesh(lg, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide })), L_PRE);
    this.line.renderOrder = 2;

    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const g = cv.getContext('2d')!;
    g.lineCap = 'round';
    for (const [w, c] of [[17, '#141420'], [9, '#ff3b30']] as const) {
      g.strokeStyle = c; g.lineWidth = w;
      g.beginPath(); g.moveTo(16, 16); g.lineTo(48, 48); g.moveTo(48, 16); g.lineTo(16, 48); g.stroke();
    }
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    this.crashes = put(new THREE.InstancedMesh(new THREE.PlaneGeometry(2.4, 2.4).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }), 256), L_PRE);
    this.crashes.renderOrder = 3; this.crashes.count = 0;

    // ----- glows and their reflections on a wet road -----
    const glowOpts = { vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };
    put(new THREE.Mesh(this.refl.g, new THREE.ShaderMaterial({ ...glowOpts, uniforms: { uReflect: { value: 1 } } })), L_PRE).renderOrder = 5;
    put(new THREE.Mesh(this.glows.g, new THREE.ShaderMaterial({ ...glowOpts, uniforms: { uReflect: { value: 0 } } })), L_LIVE).renderOrder = 8;

    // ----- falling rain and snow -----
    const mkFall = (count: number, lines: boolean) => {
      const per = lines ? 2 : 1, geo = new THREE.BufferGeometry();
      const seed = new Float32Array(count * per * 3), end = new Float32Array(count * per);
      for (let i = 0; i < count; i++) {
        const a = Math.random(), b = Math.random(), c = Math.random();
        for (let k = 0; k < per; k++) { seed.set([a, b, c], (i * per + k) * 3); end[i * per + k] = k; }
      }
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * per * 3), 3));
      geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
      geo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
      const mat = new THREE.ShaderMaterial({
        vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG, transparent: true, depthWrite: false,
        uniforms: { uTime: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uSize: { value: new THREE.Vector3(300, 70, 300) }, uVel: { value: new THREE.Vector3() }, uLen: { value: 0 }, uSnow: { value: lines ? 0 : 1 }, uPx: { value: 3 }, uCol: { value: new THREE.Color() }, uAlpha: { value: 0.4 } },
      });
      return { geo, mat };
    };
    const rn = mkFall(9000, true), snw = mkFall(8000, false);
    this.rainMat = rn.mat; this.snowMat = snw.mat;
    this.rain = put(new THREE.LineSegments(rn.geo, rn.mat), L_LIVE); this.rain.renderOrder = 9;
    this.snowPts = put(new THREE.Points(snw.geo, snw.mat), L_LIVE); this.snowPts.renderOrder = 9;

    // ----- spray thrown up by tyres -----
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPRAY_N * 3), 3));
    sg.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(SPRAY_N), 1));
    sg.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(SPRAY_N), 1));
    this.sprayMat = new THREE.ShaderMaterial({ vertexShader: SPRAY_VERT, fragmentShader: SPRAY_FRAG, transparent: true, depthWrite: false, uniforms: { uPxPerM: { value: 1 }, uCol: { value: new THREE.Color() } } });
    this.spray = put(new THREE.Points(sg, this.sprayMat), L_LIVE); this.spray.renderOrder = 7;
  }

  setCarClass(cls: CarClass) {
    this.cls = cls;
    this.cars.geometry.dispose();
    this.cars.geometry = carGeometry(cls.id, 0);
  }

  setTrack(track: Track, surf: Surface) {
    if (this.world) { this.scene.remove(this.world.group); this.world.dispose(); }
    if (this.wet) { this.scene.remove(this.wet); this.wet.geometry.dispose(); }
    this.track = track; this.surf = surf;
    const w = (this.world = buildWorld(track));
    this.scene.add(w.group);
    // every pass adds its light on top of the last, against depth laid down once
    for (const m of w.mats) {
      m.blending = THREE.AdditiveBlending; m.depthWrite = false; m.depthFunc = THREE.LessEqualDepth;
      m.polygonOffset = true; m.polygonOffsetFactor = 0; m.polygonOffsetUnits = -4;
      m.envMapIntensity = m.roughness < 0.2 ? 1 : 0.16;
      if (this.envRT) m.envMap = this.envRT.texture;
    }
    this.center.set((w.minX + w.maxX) / 2, 0, (w.minZ + w.maxZ) / 2);
    const c = this.center;

    // the road film: one vertex per track sample per strip
    const N = track.n, pos = new Float32Array(N * BINS * 3), idx = new Uint32Array(N * (BINS - 1) * 6);
    for (let i = 0; i < N; i++) for (let b = 0; b < BINS; b++) {
      const off = ((b / (BINS - 1)) * 2 - 1) * track.hw, k = (i * BINS + b) * 3;
      pos[k] = track.px[i] - track.tz[i] * off; pos[k + 1] = track.h[i] + 0.085; pos[k + 2] = track.pz[i] + track.tx[i] * off;
    }
    let q = 0;
    for (let i = 0; i < N; i++) for (let b = 0; b < BINS - 1; b++) {
      const a = i * BINS + b, d = ((i + 1) % N) * BINS + b;
      idx[q++] = a; idx[q++] = a + 1; idx[q++] = d; idx[q++] = d; idx[q++] = a + 1; idx[q++] = d + 1;
    }
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const aw = new THREE.BufferAttribute(new Float32Array(N * BINS * 2), 2); aw.setUsage(THREE.DynamicDrawUsage);
    wg.setAttribute('aw', aw);
    wg.setIndex(new THREE.BufferAttribute(idx, 1));
    this.wet = new THREE.Mesh(wg, this.wetMat);
    this.wet.layers.set(L_PRE); this.wet.frustumCulled = false; this.wet.renderOrder = 1;
    this.scene.add(this.wet);
    this.wetVersion = -1;

    for (const cam of [this.camera, this.bakeCam]) { cam.position.copy(c).addScaledVector(CAM_DIR, 800); cam.lookAt(c); cam.updateMatrixWorld(); }
    this.R.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this.U.setFromMatrixColumn(this.camera.matrixWorld, 1);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const p = new THREE.Vector3();
    for (let i = 0; i < track.n; i++) {
      p.set(track.px[i], track.h[i], track.pz[i]).sub(c);
      const x = p.dot(this.R), y = p.dot(this.U);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    this.fit = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 + 3, w: x1 - x0 + 50, h: y1 - y0 + 46 };
    this.zoom = 1; this.panX = 0; this.panY = 0;
    this.lineVersion = -1; this.crashSeen = -1;
    this.snap = true; this.tile = null; this.lightKey = '';
    for (let i = 0; i < SPRAY_N; i++) this.sp[i * SPRAY_K + 6] = 1e9;
  }

  resize() {
    const cv = this.renderer.domElement;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    const W = cv.width, H = cv.height;
    for (const t of [this.hdr, this.ldr, ...this.bl]) t?.dispose();
    this.hdr = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: true });
    this.ldr = new THREE.WebGLRenderTarget(W, H, { depthBuffer: false });
    const half = () => new THREE.WebGLRenderTarget(W >> 1, H >> 1, { type: THREE.HalfFloatType, depthBuffer: false });
    const quarter = () => new THREE.WebGLRenderTarget(W >> 2, H >> 2, { type: THREE.HalfFloatType, depthBuffer: false });
    this.bl = [half(), half(), quarter(), quarter()];
    this.tile = null;
  }

  /** World metres per CSS pixel right now. */
  get scale() { return this.cam.s; }
  /** 0 by day, 1 at night. */
  get night() { return this.sky.night; }
  /** How far the current tile's lighting has been gathered, 0..1. */
  get progress() { return this.need ? Math.min(1, this.passes / this.need) : 1; }

  pan(dxPx: number, dyPx: number) {
    this.panX -= dxPx * this.cam.s; this.panY += dyPx * this.cam.s;
  }

  /** Where a world point lands on screen, in CSS pixels. */
  project(x: number, y: number, z: number, out: { x: number; y: number }) {
    const p = this.v.set(x, y, z).sub(this.center), cam = this.camera, cv = this.renderer.domElement;
    out.x = ((p.dot(this.R) - cam.left) / (cam.right - cam.left)) * cv.clientWidth;
    out.y = ((cam.top - p.dot(this.U)) / (cam.top - cam.bottom)) * cv.clientHeight;
  }

  private updateCamera(focus: Car | null) {
    const cv = this.renderer.domElement, W = cv.clientWidth, H = cv.clientHeight;
    const freeW = Math.max(200, W - this.insetLeft - this.insetRight), freeH = Math.max(150, H - this.insetTop - this.insetBottom);
    let tx: number, ty: number, ts: number;
    const cam = this.camera, range = cam.far - cam.near;
    const fol = this.mode === 'follow' && !!focus;
    if (fol && focus) {
      const co = Math.cos(focus.th), si = Math.sin(focus.th), ld = this.lead;
      const p = this.v.set(focus.x + (co * focus.vf - si * focus.vl) * ld, focus.y, focus.z + (si * focus.vf + co * focus.vl) * ld).sub(this.center);
      tx = p.dot(this.R); ty = p.dot(this.U); ts = this.followScale;
      this.focusD = (800 - p.dot(CAM_DIR) - cam.near) / range;
    } else {
      const s0 = Math.max(this.fit.w / freeW, this.fit.h / freeH);
      ts = s0 / this.zoom; tx = this.fit.cx + this.panX; ty = this.fit.cy + this.panY;
    }
    const c = this.cam, k = this.snap ? 1 : fol ? 0.12 : 0.22;
    this.snap = false;
    c.cx = Math.abs(tx - c.cx) < c.s * 0.02 ? tx : c.cx + (tx - c.cx) * k;
    c.cy = Math.abs(ty - c.cy) < c.s * 0.02 ? ty : c.cy + (ty - c.cy) * k;
    c.s = Math.abs(ts - c.s) < c.s * 0.0005 ? ts : c.s + (ts - c.s) * k;
    cam.left = c.cx - (this.insetLeft + freeW / 2) * c.s;
    cam.right = cam.left + W * c.s;
    cam.top = c.cy + (this.insetTop + freeH / 2) * c.s;
    cam.bottom = cam.top - H * c.s;
    cam.updateProjectionMatrix();
    // otherwise focus on the ground in the middle of the free part of the view
    if (!fol) this.focusD = (800 + (this.U.y * c.cy) / CAM_DIR.y - cam.near) / range;
  }

  private allocTile(w: number, h: number) {
    if (this.tileW === w && this.tileH === h && this.accum.length) return false;
    for (const t of [...this.accum, this.gAlb]) t?.dispose();
    const mk = () => { const t = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true }); t.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType); return t; };
    this.accum = [mk(), mk()];
    this.gAlb = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true });
    this.tileW = w; this.tileH = h;
    return true;
  }

  /** Point the bake camera at a tile and lay down its depth and colour; gathered light is carried over where it can be. */
  private retile(t: Tile, carry: boolean) {
    const r = this.renderer, old = this.tile, bc = this.bakeCam;
    const next = 1 - this.cur, RT = this.accum[next];
    bc.left = t.l; bc.right = t.l + t.w; bc.bottom = t.b; bc.top = t.b + t.h;
    bc.updateProjectionMatrix();
    bc.layers.set(L_STATIC);
    r.setRenderTarget(RT);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, true);
    if (carry && old) {
      const u = this.copyMat.uniforms;
      u.tOld.value = this.accum[this.cur].texture;
      u.uScale.value.set(t.w / old.w, t.h / old.h); u.uOff.value.set((t.l - old.l) / old.w, (t.b - old.b) / old.h);
      this.fsQuad.material = this.copyMat;
      r.render(this.fsScene, this.fsCam);
    }
    this.scene.overrideMaterial = this.depthMat;
    r.render(this.scene, bc);
    this.scene.overrideMaterial = this.albedoMat;
    r.setRenderTarget(this.gAlb); r.setClearColor(0x000000, 1); r.clear(true, true, true);
    r.render(this.scene, bc);
    this.scene.overrideMaterial = null;
    r.setRenderTarget(null);
    this.cur = next; this.tile = t;
    this.passes = carry && old ? 1 : 0;
    this.need = t.follow ? PASSES_MOVING : PASSES_STILL;
    this.m4.multiplyMatrices(bc.projectionMatrix, bc.matrixWorldInverse).invert();
    this.showMat.uniforms.uInvVP.value.copy(this.m4);
    this.volMat.uniforms.uInvVP.value.copy(this.m4);
  }

  /** Aim a shadow-casting light across the tile from the given direction. */
  private aim(light: THREE.DirectionalLight, dir: THREE.Vector3) {
    const t = this.tile!, cx = t.l + t.w / 2, cy = t.b + t.h / 2, k = -(this.U.y * cy) / CAM_DIR.y;
    const g = this.v4.copy(this.center).addScaledVector(this.R, cx).addScaledVector(this.U, cy).addScaledVector(CAM_DIR, k);
    const rad = Math.hypot(t.w / 2, t.h / 2 / CAM_DIR.y) + 34;
    light.position.copy(g).addScaledVector(dir, 760);
    light.target.position.copy(g);
    const sc = light.shadow.camera;
    sc.left = -rad; sc.right = rad; sc.top = rad; sc.bottom = -rad; sc.near = 60; sc.far = 1500;
    sc.updateProjectionMatrix();
  }

  /** One more look at the scene, lit from a fresh point on the sun and a fresh patch of sky. */
  private gather() {
    const r = this.renderer, k = this.sky, first = this.passes === 0, i = this.sampleNo++;
    const d = this.v3.copy(k.sunDir);
    if (!first) {
      // somewhere on the sun's disc: this is what softens shadow edges with distance
      const a = ((i * 0.3247) % 1) * 6.2832, rr = k.sunSoft * Math.sqrt((i * 0.618034) % 1);
      const t1 = this.v.set(-d.z, 0, d.x).normalize(), t2 = this.v2.crossVectors(d, t1);
      d.addScaledVector(t1, Math.cos(a) * rr).addScaledVector(t2, Math.sin(a) * rr).normalize();
    }
    this.aim(this.sun, d);
    this.sun.color.copy(k.sunCol); this.sun.intensity = k.sunInt;
    if (first) {
      // a quick first look: open sky from everywhere at once, to be refined by the passes that follow
      this.skyLight.intensity = 0;
      this.hemi.color.copy(k.avg); this.hemi.groundColor.copy(k.gnd); this.hemi.intensity = k.skyInt * 0.5;
    } else {
      const y = 0.05 + 0.95 * ((i * 0.754878) % 1), a = ((i * 0.569840) % 1) * 6.2832, h = Math.sqrt(1 - y * y);
      this.aim(this.skyLight, this.v.set(Math.cos(a) * h, y, Math.sin(a) * h));
      k.at(y, this.skyLight.color); this.skyLight.intensity = k.skyInt;
      this.hemi.color.copy(k.gnd); this.hemi.groundColor.copy(k.gnd); this.hemi.intensity = 0.35; // light bounced up off the ground
    }
    r.shadowMap.needsUpdate = true;
    this.bakeCam.layers.set(L_STATIC);
    r.setRenderTarget(this.accum[this.cur]);
    r.render(this.scene, this.bakeCam);
    r.setRenderTarget(null);
    this.passes++; this.bakes++;
  }

  /** Bring the sun, sky and weather look up to date; restart the gathering if the light has changed. */
  private updateSky(dt: number) {
    const e = this.env, w = this.world!, s = this.surf!;
    const wantO = e.weather === 'dry' ? 0 : 0.35 + 0.65 * e.intensity;
    const step = dt * 0.7;
    this.overcast += Math.max(-step, Math.min(step, wantO - this.overcast));
    this.rainVis += Math.max(-step, Math.min(step, (e.weather === 'rain' ? e.intensity : 0) - this.rainVis));
    this.snowVis += Math.max(-step, Math.min(step, (e.weather === 'snow' ? e.intensity : 0) - this.snowVis));
    const snow = Math.round(s.groundSnow * 40) / 40, wet = Math.round(s.groundWet * 20) / 20;
    const key = `${e.time.toFixed(4)}|${this.overcast.toFixed(3)}|${snow}|${wet}`;
    if (key === this.lightKey) { if (this.envWait > 0 && --this.envWait === 0) this.makeEnv(); return; }
    this.lightKey = key;
    const k = this.sky;
    k.set(e.time, this.overcast);
    w.uniforms.uSnow.value = snow; w.uniforms.uWet.value = wet; w.uniforms.uNight.value = smooth(0.25, 0.8, k.night);
    (this.carShadow.material as THREE.MeshBasicMaterial).opacity = 0.75 * (0.45 + 0.55 * k.day) * (1 - 0.3 * this.overcast);
    // the sky as a mirror: rebuilt at once the first time, then only once the light has settled
    if (!this.envRT) this.makeEnv(); else this.envWait = 6;
    // start gathering again under the new light
    if (this.tile && this.accum.length) {
      const r = this.renderer;
      r.setRenderTarget(this.accum[this.cur]); r.setClearColor(0x000000, 0); r.clear(true, false, false); r.setRenderTarget(null);
      this.passes = 0; this.need = this.tile.follow ? PASSES_MOVING : PASSES_STILL;
    }
  }

  private makeEnv() {
    const k = this.sky, u = this.skyMat.uniforms;
    u.uZen.value.copy(k.zen); u.uHor.value.copy(k.hor); u.uGnd.value.copy(k.gnd).multiplyScalar(0.6);
    u.uSunDir.value.copy(k.sunDir); u.uSunCol.value.copy(k.sunCol).multiplyScalar(k.sunInt * 0.3);
    const old = this.envRT;
    this.envRT = this.pmrem.fromScene(this.skyScene, 0, 1, 200);
    old?.dispose();
    for (const m of [...this.world!.mats, this.carMat, this.wheelMat]) m.envMap = this.envRT.texture;
    this.renderer.setRenderTarget(null);
  }

  /** Decide which tile the current view needs, and rebuild or slide it if it has moved off the one we have. */
  private updateTile() {
    const cam = this.camera, cv = this.renderer.domElement, pr = this.renderer.getPixelRatio();
    const vw = cam.right - cam.left, vh = cam.top - cam.bottom, t = this.tile;
    if (this.mode === 'follow') {
      const w = vw * OVERSCAN, h = vh * OVERSCAN;
      const inside = t && t.follow && Math.abs(t.w - w) < w * 0.002 && cam.left >= t.l && cam.right <= t.l + t.w && cam.bottom >= t.b && cam.top <= t.b + t.h;
      if (inside) return;
      const k = Math.min(1, 4096 / (cv.clientWidth * pr * FOLLOW_RES * OVERSCAN));
      const fresh = this.allocTile(Math.round(cv.clientWidth * pr * FOLLOW_RES * OVERSCAN * k), Math.round(cv.clientHeight * pr * FOLLOW_RES * OVERSCAN * k));
      // centre the new tile a little ahead, in the direction the view is travelling
      let ax = 0, ay = 0;
      if (t && t.follow) {
        const dx = (cam.left + vw / 2) - (t.l + t.w / 2), dy = (cam.bottom + vh / 2) - (t.b + t.h / 2), l = Math.hypot(dx, dy) || 1;
        ax = (dx / l) * w * 0.2; ay = (dy / l) * h * 0.2;
      }
      const carry = !fresh && !!t && t.follow && Math.abs(t.w - w) < w * 0.002;
      this.retile({ l: cam.left + vw / 2 + ax - w / 2, b: cam.bottom + vh / 2 + ay - h / 2, w, h, follow: true }, carry);
    } else {
      const same = t && !t.follow && Math.abs(t.l - cam.left) < vw * 1e-5 && Math.abs(t.b - cam.bottom) < vh * 1e-5 && Math.abs(t.w - vw) < vw * 1e-5;
      if (same) return;
      this.allocTile(cv.width, cv.height);
      this.retile({ l: cam.left, b: cam.bottom, w: vw, h: vh, follow: false }, false);
    }
  }

  private m4 = new THREE.Matrix4(); private q = new THREE.Quaternion(); private sc = new THREE.Vector3();
  private v = new THREE.Vector3(); private v2 = new THREE.Vector3(); private v3 = new THREE.Vector3(); private v4 = new THREE.Vector3();
  private col = new THREE.Color();
  private static UP = new THREE.Vector3(0, 1, 0);
  private static FWD_Z = new THREE.Vector3(0, 0, 1);
  private static FWD_X = new THREE.Vector3(1, 0, 0);
  private q2 = new THREE.Quaternion();

  private get lightsOn() {
    return this.headlights === 'on' || (this.headlights === 'auto' && (this.sky.night > 0.3 || this.overcast > 0.6));
  }

  private updateLive(f: Frame, t: number, dt: number) {
    const cars = f.cars, n = Math.min(cars.length, MAX_CARS), trk = this.track!, k = this.sky, surf = this.surf!, cls = this.cls;
    this.cars.count = this.carShadow.count = n; this.wheels.count = n * 4;
    const sx = (-k.sunDir.x / Math.max(0.3, k.sunDir.y)) * 0.5 * k.day, sz = (-k.sunDir.z / Math.max(0.3, k.sunDir.y)) * 0.5 * k.day;
    const S = CAR_SCALE, lit = this.lightsOn, night = k.night;
    const G = this.glows, Rf = this.refl, V = this.vol;
    let ng = 0, nr = 0, nv = 0;
    const glow = (x: number, y: number, z: number, size: number, r: number, g: number, b: number, I: number, wetRef: number) => {
      if (ng >= 640) return;
      G.arr.iPosS.set([x, y, z, size], ng * 4); G.arr.iColI.set([r, g, b, I], ng * 4); ng++;
      if (wetRef > 0.03 && nr < 640) { Rf.arr.iPosS.set([x, y - 0.3, z, size * 1.6], nr * 4); Rf.arr.iColI.set([r, g, b, I * wetRef], nr * 4); nr++; }
    };
    const light = (x: number, y: number, z: number, rad: number, dx: number, dy: number, dz: number, cone: number, r: number, g: number, b: number) => {
      if (nv >= VOL_MAX) return;
      V.arr.iPosR.set([x, y, z, rad], nv * 4); V.arr.iDirC.set([dx, dy, dz, cone], nv * 4); V.arr.iCol.set([r, g, b], nv * 3); nv++;
    };
    // lamps first: they are always wanted, headlights take what room is left
    const lampOn = smooth(0.15, 0.75, night), lineWet = Math.min(1, surf.lineWater() * 1.6) * 0.5;
    if (lampOn > 0.02) for (const l of this.world!.lamps) {
      const big = l.r > 40, I = lampOn * (big ? 6.5 : 3.6);
      light(l.x, l.y, l.z, l.r * 1.25, 0, -1, 0, -2, l.color[0] * I, l.color[1] * I, l.color[2] * I);
      glow(l.x, l.y, l.z, big ? 1.9 : 1.1, l.color[0], l.color[1], l.color[2], lampOn * 0.7, big ? 0 : lineWet);
    }
    const blink = (t * 4) % 1 < 0.5;
    const hl = 6.5 * smooth(0.05, 0.6, night);
    const crowd = n > 10 ? 10 / n : 1; // a practice field of dozens shares the spray budget
    for (let i = 0; i < n; i++) {
      const c = cars[i];
      const hide = f.hidden(i);
      const s = hide ? 0 : S;
      this.q.setFromAxisAngle(View.UP, -c.th);
      this.m4.compose(this.v.set(c.x + sx, c.y + 0.13, c.z + sz), this.q, this.sc.set(cls.len * s * 1.45, s, cls.wid * s * 1.9));
      this.carShadow.setMatrixAt(i, this.m4);
      // nose up or down with the slope, and the body moving on its springs: dive, squat, roll, heave
      const co = Math.cos(c.th), si = Math.sin(c.th);
      const along = co * trk.tx[c.idx] + si * trk.tz[c.idx], tilt = Math.atan(trk.slope[c.idx] * along);
      this.q.multiply(this.q2.setFromAxisAngle(View.FWD_Z, tilt + c.pitch * BODY_MOTION));
      this.q.multiply(this.q2.setFromAxisAngle(View.FWD_X, c.roll * BODY_MOTION));
      this.m4.compose(this.v.set(c.x, c.y + 0.06 + c.heave * BODY_MOTION * s, c.z), this.q, this.sc.setScalar(s));
      this.cars.setMatrixAt(i, this.m4);
      // the wheels stay on the road, turn with the steering and roll with the speed
      const wl = cls.wheels, steerA = (c.steer * cls.setup.steer * Math.PI) / 180 / (1 + Math.abs(c.vf) / 28);
      for (let k = 0; k < 4; k++) {
        const front = k < 2, lx = front ? wl.fx : wl.rx, lz = (front ? wl.fz : wl.rz) * (k & 1 ? -1 : 1), rr = front ? wl.fr : wl.rr, ww = front ? wl.fw : wl.rw;
        this.q.setFromAxisAngle(View.UP, -(c.th + (front ? steerA : 0)));
        this.q.multiply(this.q2.setFromAxisAngle(View.FWD_Z, tilt - c.spin / rr));
        this.m4.compose(this.v.set(c.x + (co * lx - si * lz) * S, c.y + 0.06 + (rr + lx * Math.tan(tilt)) * S, c.z + (si * lx + co * lz) * S), this.q, this.sc.set(rr * s, rr * s, ww * s));
        this.wheels.setMatrixAt(i * 4 + k, this.m4);
      }
      f.color(i, this.col);
      if (!c.alive) this.col.lerp(WRECK, 0.8);
      this.cars.setColorAt(i, this.col);
      if (hide || !c.alive) continue;

      const water = surf.waterAt(c.idx, c.lat), wetRef = Math.min(1, water * 1.6) * (0.35 + 0.65 * night);
      const at = (lx: number, ly: number, lz: number, out: number[]) => { out[0] = c.x + co * lx * S - si * lz * S; out[1] = c.y + ly * S; out[2] = c.z + si * lx * S + co * lz * S; };
      const p: number[] = [0, 0, 0];
      const v = Math.hypot(c.vf, c.vl);
      if (lit && cls.headlights) {
        const I = 1.6 + 1.2 * night;
        for (const sd of [1, -1]) { at(cls.front[0] + 0.1, cls.front[1], cls.front[2] * sd, p); glow(p[0], p[1], p[2], 1.0, 1.0, 0.95, 0.8, I * 0.6, wetRef); }
        if (hl > 0.5) { at(cls.front[0], cls.front[1] + 0.25, 0, p); light(p[0], p[1], p[2], 48, co * 0.99, -0.13, si * 0.99, 0.9, 1.0 * hl, 0.93 * hl, 0.78 * hl); }
      }
      if (cls.headlights && (lit || c.braking)) {
        const I = c.braking ? 2.6 : 0.8 * (0.4 + 0.6 * night);
        for (const sd of [1, -1]) { at(cls.rear[0] - 0.1, cls.rear[1], cls.rear[2] * sd, p); glow(p[0], p[1], p[2], c.braking ? 1.1 : 0.8, 1.0, 0.06, 0.03, I, wetRef * 0.8); }
      }
      if (cls.rainLight && (water > 0.12 || this.rainVis > 0.05 || this.snowVis > 0.05) && blink) {
        at(cls.rear[0] - 0.15, cls.rear[1], 0, p); glow(p[0], p[1], p[2], 0.9, 1.0, 0.05, 0.03, 1.2 + 1.4 * night, wetRef);
      }
      // spray: every tyre on a wet road flings water up and back. Open wheels throw tall rooster
      // tails; bodywork catches most of it on other cars, which trail a lower, wider cloud.
      const mist = Math.max(water, surf.snowAt(c.idx, c.lat) * 0.55);
      if (mist > 0.08 && v > 7 && dt > 0) {
        const wl = cls.wheels, open = wl.open;
        const wx = co * c.vf - si * c.vl, wz = si * c.vf + co * c.vl;
        const amount = Math.min(1, mist * 1.7) * Math.min(1.7, v / 28) * cls.spray * crowd;
        for (let k = 0; k < 4; k++) {
          const front = k < 2;
          const rate = amount * (open ? 115 : front ? 26 : 80) * dt;
          let cnt = Math.floor(rate + Math.random());
          const lx = front ? wl.fx : wl.rx, side = k & 1 ? -1 : 1, lz = (front ? wl.fz : wl.rz) * side, rr = front ? wl.fr : wl.rr;
          while (cnt-- > 0) {
            const j = (this.spHead = (this.spHead + 1) % SPRAY_N) * SPRAY_K, u = Math.random(), u2 = Math.random(), u3 = Math.random();
            at(lx - rr * 0.7 - u * 0.5, 0.15 + u2 * 0.3, lz + (u3 - 0.5) * 0.3, p);
            const haze = u < 0.22;
            // thrown off the tyre: it keeps some of the car's speed, so it hangs in the air behind
            const keep = haze ? 0.1 + u2 * 0.1 : open ? 0.3 + u2 * 0.3 : 0.24 + u2 * 0.22;
            const out = (haze ? 0.6 : open ? 1.6 : 2.8) * (u3 - (open ? 0.5 : 0.2)) * side;
            this.sp.set([
              p[0], p[1], p[2],
              wx * keep - si * out + (Math.random() - 0.5) * 1.5, haze ? 0.6 + u3 : open ? 3.2 + u3 * 7.5 * Math.min(1.4, v / 32) : 1.2 + u3 * 3.0, wz * keep + co * out + (Math.random() - 0.5) * 1.5,
              0, haze ? 1.8 + u2 * 1.6 : open ? 0.8 + u2 * 0.9 : 0.6 + u2 * 0.7,
              haze ? 2.4 : 0.6 + u2 * 0.6, haze ? 2.6 : open ? 5.2 : 3.6, haze ? 0.1 : open ? 0.3 : 0.2,
            ], j);
          }
        }
      }
    }
    this.cars.instanceMatrix.needsUpdate = this.carShadow.instanceMatrix.needsUpdate = this.wheels.instanceMatrix.needsUpdate = true;
    if (this.cars.instanceColor) this.cars.instanceColor.needsUpdate = true;
    for (let i = 0; i < f.startLights; i++) { const g = this.world!.gantry[i]; glow(g.x, g.y, g.z, 1.7, 1.0, 0.05, 0.03, 4, 0); }
    G.g.instanceCount = ng; Rf.g.instanceCount = nr; V.g.instanceCount = nv;
    G.touch(); Rf.touch(); V.touch();

    // spray particles: they rise, slow, fall back, spread and thin out
    {
      const sp = this.sp, pos = this.spray.geometry.attributes.position.array as Float32Array;
      const al = this.spray.geometry.attributes.aAlpha.array as Float32Array, sz2 = this.spray.geometry.attributes.aSize.array as Float32Array;
      const drag = 1 - Math.min(0.9, 1.3 * dt);
      for (let i = 0; i < SPRAY_N; i++) {
        const j = i * SPRAY_K;
        const age = (sp[j + 6] += dt), life = sp[j + 7];
        if (age >= life) { al[i] = 0; continue; }
        sp[j] += sp[j + 3] * dt; sp[j + 1] += sp[j + 4] * dt; sp[j + 2] += sp[j + 5] * dt;
        sp[j + 4] -= 7 * dt; sp[j + 3] *= drag; sp[j + 5] *= drag;
        if (sp[j + 1] < 0.15) { sp[j + 1] = 0.15; sp[j + 4] = 0; }
        const u = age / life, fade = (1 - u) * Math.sqrt(1 - u) * Math.min(1, age / 0.06);
        pos[i * 3] = sp[j]; pos[i * 3 + 1] = sp[j + 1]; pos[i * 3 + 2] = sp[j + 2];
        al[i] = sp[j + 10] * fade; sz2[i] = sp[j + 8] + sp[j + 9] * age;
      }
      const ga = this.spray.geometry.attributes;
      ga.position.needsUpdate = ga.aAlpha.needsUpdate = ga.aSize.needsUpdate = true;
      this.sprayMat.uniforms.uPxPerM.value = this.renderer.getPixelRatio() / this.cam.s;
      this.sprayMat.uniforms.uCol.value.copy(k.snow).multiplyScalar(1.15).addScalar(0.012);
    }

    const mk = f.marker;
    this.marker.visible = !!mk && mk.alive;
    if (mk) { this.marker.position.set(mk.x, mk.y + 5.4 + Math.sin(t * 5) * 0.35, mk.z); this.marker.rotation.y = t * 2; }

    const rc = f.rays;
    this.rays.visible = this.showRays && !!rc && rc.alive;
    if (this.rays.visible && rc) {
      const a = this.rays.geometry.attributes.position as THREE.BufferAttribute, arr = a.array as Float32Array;
      for (let q = 0; q < N_RAYS; q++) {
        const ang = rc.th + RAY_ANGLES[q], d = rc.sensors[q] * f.vision, y = rc.y + 0.9;
        arr.set([rc.x, y, rc.z, rc.x + Math.cos(ang) * d, y, rc.z + Math.sin(ang) * d], q * 6);
      }
      a.needsUpdate = true;
    }

    this.line.visible = this.showLine && !!f.path;
    if (f.path && this.lineVersion !== f.path.version) {
      this.lineVersion = f.path.version;
      const N = Math.min(3600, f.path.N), P = f.path.P, g = this.line.geometry;
      const pos = g.attributes.position.array as Float32Array, colr = g.attributes.color.array as Float32Array;
      let v0 = Infinity, v1 = -Infinity;
      for (let i = 0; i < N; i++) { v0 = Math.min(v0, P[i * 3 + 2]); v1 = Math.max(v1, P[i * 3 + 2]); }
      let hint = 0;
      for (let i = 0; i < N; i++) {
        const a = Math.max(0, i - 1), b = Math.min(N - 1, i + 1);
        let dx = P[b * 3] - P[a * 3], dz = P[b * 3 + 1] - P[a * 3 + 1];
        const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
        const x = P[i * 3], z = P[i * 3 + 1], hw = 0.4;
        const id = idxAt(trk, x, z, hint);
        if (id >= 0) hint = id;
        const y = trk.h[hint] + 0.14;
        pos.set([x - dz * hw, y, z + dx * hw, x + dz * hw, y, z - dx * hw], i * 6);
        this.col.setHSL(((P[i * 3 + 2] - v0) / Math.max(1, v1 - v0)) * 0.5, 0.95, 0.5);
        colr.set([this.col.r, this.col.g, this.col.b, this.col.r, this.col.g, this.col.b], i * 6);
      }
      g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true;
      g.setDrawRange(0, Math.max(0, N - 1) * 6);
    }

    if (this.crashSeen !== f.crash.count) {
      this.crashSeen = f.crash.count;
      const m = Math.min(256, f.crash.count);
      this.crashes.count = m;
      this.q.identity();
      for (let i = 0; i < m; i++) {
        this.m4.compose(this.v.set(f.crash.x[i], f.crash.y[i] + 0.16, f.crash.z[i]), this.q, this.sc.setScalar(1));
        this.crashes.setMatrixAt(i, this.m4);
      }
      this.crashes.instanceMatrix.needsUpdate = true;
    }

    // road film
    if (this.wet && this.wetVersion !== surf.version) {
      this.wetVersion = surf.version;
      const a = this.wet.geometry.attributes.aw as THREE.BufferAttribute, arr = a.array as Float32Array, W = surf.water, Sn = surf.snow;
      for (let i = 0, m = W.length; i < m; i++) { arr[i * 2] = W[i]; arr[i * 2 + 1] = Sn[i]; }
      a.needsUpdate = true;
    }
    const wu = this.wetMat.uniforms;
    wu.uSky.value.copy(k.ref); wu.uSnow.value.copy(k.snow); wu.uTime.value = t; wu.uRain.value = this.rainVis; wu.uLit.value = k.lit;

    // rain and snow fall in a box of air that follows the view
    const cam = this.camera, midX = (cam.left + cam.right) / 2, midY = (cam.top + cam.bottom) / 2;
    const tt = -(this.U.y * midY) / CAM_DIR.y;
    const cx = this.center.x + this.R.x * midX + this.U.x * midY + CAM_DIR.x * tt, cz = this.center.z + this.R.z * midX + this.U.z * midY + CAM_DIR.z * tt;
    const span = Math.min(520, Math.max(cam.right - cam.left, (cam.top - cam.bottom) / CAM_DIR.y) * 1.15);
    const pr = this.renderer.getPixelRatio();
    const setFall = (m: THREE.ShaderMaterial, obj: THREE.Object3D & { geometry: THREE.BufferGeometry }, vis: number, vel: [number, number, number], len: number, per: number, total: number, alpha: number) => {
      obj.visible = vis > 0.01;
      if (!obj.visible) return;
      const u = m.uniforms;
      u.uTime.value = t; u.uCenter.value.set(cx, -6, cz); u.uSize.value.set(span, 75, span); u.uVel.value.set(...vel); u.uLen.value = len;
      u.uPx.value = 2.6 * pr; u.uCol.value.copy(k.snow).multiplyScalar(1.15); u.uAlpha.value = alpha;
      obj.geometry.setDrawRange(0, Math.floor(total * Math.min(1, vis * 1.15)) * per);
    };
    setFall(this.rainMat, this.rain, this.rainVis, [-7, -34, 4], 2.2 + 1.2 * this.rainVis, 2, 9000, 0.3 + 0.2 * this.rainVis);
    setFall(this.snowMat, this.snowPts, this.snowVis, [-1.5, -4.2, 1], 0, 1, 8000, 0.85);

    // lightning in a real downpour
    if (this.rainVis > 0.8 && Math.random() < dt * 0.09) this.flash = 1;
    this.flash = Math.max(0, this.flash - dt * 3.2);
  }

  private pass(mat: THREE.ShaderMaterial, to: THREE.WebGLRenderTarget | null) {
    this.fsQuad.material = mat;
    this.renderer.setRenderTarget(to);
    this.renderer.render(this.fsScene, this.fsCam);
  }

  render(f: Frame, time: number) {
    if (!this.track || !this.hdr) return;
    const dt = this.lastT ? Math.min(0.1, time - this.lastT) : 0;
    this.lastT = time;
    const r = this.renderer, k = this.sky, cam = this.camera;
    this.updateCamera(f.focus);
    this.updateSky(dt);
    const before = this.tile;
    this.updateTile();
    // gather more light: one look while the view is still changing, a few once it rests
    const t = this.tile!;
    const budget = t.follow ? 2 : before === t ? 3 : 1;
    for (let i = 0; i < budget && this.passes < this.need; i++) this.gather();

    this.updateLive(f, time, dt);
    // live lighting for the cars: the true sun, and open sky
    this.sun.color.copy(k.sunCol); this.sun.intensity = k.sunInt;
    this.skyLight.intensity = 0;
    this.hemi.color.copy(k.avg); this.hemi.groundColor.copy(k.gnd); this.hemi.intensity = k.skyInt * 0.5;

    const A = this.accum[this.cur];
    const sx = (cam.right - cam.left) / t.w, sy = (cam.top - cam.bottom) / t.h, ox = (cam.left - t.l) / t.w, oy = (cam.bottom - t.b) / t.h;
    const su = this.showMat.uniforms;
    su.tAccum.value = A.texture; su.tDepth.value = A.depthTexture; su.uScale.value.set(sx, sy); su.uOff.value.set(ox, oy);
    this.col.copy(k.hor).lerp(k.zen, 0.35).multiplyScalar(0.9);
    su.bgTop.value.copy(this.col); su.bgBottom.value.copy(k.hor).multiplyScalar(0.95);
    su.uNight.value = k.night * (1 - this.overcast); su.uFlash.value = this.flash * this.flash * 1.5; su.uTime.value = time;
    su.uCloud.value = k.day * (0.55 - 0.45 * this.overcast) * (this.env.weather === 'dry' ? 1 : 0.4);
    su.uFog.value.copy(k.hor).multiplyScalar(0.8); su.uFogAmt.value = 0.1 + 0.3 * this.overcast; su.uFocus.value = this.focusD;
    su.uPx.value.set(1 / r.domElement.clientWidth, 1 / r.domElement.clientHeight);
    const vu = this.volMat.uniforms;
    vu.tDepth.value = A.depthTexture; vu.tAlbedo.value = this.gAlb.texture; vu.uRes.value.set(this.hdr.width, this.hdr.height);
    vu.uScale.value.set(sx, sy); vu.uOff.value.set(ox, oy); vu.uTexel.value.set(1.5 / this.tileW, 1.5 / this.tileH);

    r.setRenderTarget(this.hdr);
    r.setClearColor(0x000000, 1); r.clear(true, true, true);
    this.pass(this.showMat, this.hdr);
    cam.layers.set(L_PRE); r.render(this.scene, cam);
    cam.layers.set(L_LIVE); r.render(this.scene, cam);

    // bloom
    const [b1, b1b, b2, b2b] = this.bl;
    this.brightMat.uniforms.tex.value = this.hdr.texture; this.brightMat.uniforms.uTexel.value.set(1 / this.hdr.width, 1 / this.hdr.height);
    this.pass(this.brightMat, b1);
    const blur = (src: THREE.WebGLRenderTarget, dst: THREE.WebGLRenderTarget, dx: number, dy: number) => {
      this.blurMat.uniforms.tex.value = src.texture; this.blurMat.uniforms.uDir.value.set(dx / src.width, dy / src.height);
      this.pass(this.blurMat, dst);
    };
    blur(b1, b1b, 1, 0); blur(b1b, b1, 0, 1);
    blur(b1, b2b, 2, 0); blur(b2b, b2, 0, 2);
    blur(b2, b2b, 1.5, 0); blur(b2b, b2, 0, 1.5);

    const fu = this.finalMat.uniforms, pr = r.getPixelRatio();
    fu.tHdr.value = this.hdr.texture; fu.tBloom1.value = b1.texture; fu.tBloom2.value = b2.texture; fu.tDepth.value = A.depthTexture;
    fu.uScale.value.set(sx, sy); fu.uOff.value.set(ox, oy); fu.uPx.value.set(1 / this.hdr.width, 1 / this.hdr.height);
    fu.uFocus.value = this.focusD;
    // blur grows with distance from the focal plane, in pixels: the look of a real lens on a model
    fu.uCoc.value = this.dof * ((cam.far - cam.near) * 0.0065 * pr) / this.cam.s;
    fu.uCocMax.value = this.dof * 4.2 * pr;
    fu.uExposure.value = k.exposure; fu.uTime.value = time % 10;
    this.pass(this.finalMat, this.ldr);
    this.fxaaMat.uniforms.tex.value = this.ldr.texture; this.fxaaMat.uniforms.uPx.value.set(1 / this.ldr.width, 1 / this.ldr.height);
    this.pass(this.fxaaMat, null);
  }
}
