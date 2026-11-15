// Builds the static toon diorama for a track. Everything here is rendered once and baked.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Track, Theme, distAny, stretchesAt, gap, pitLat } from './track';
import { mulberry32, makeNoise } from './rng';
import { TEAMS, GRID_GAP } from './race';

const PAD = 52;
const WATER_Y = -1.5;

export interface Lamp { x: number; y: number; z: number; r: number; color: [number, number, number] }
export interface World {
  group: THREE.Group;
  minX: number; maxX: number; minZ: number; maxZ: number;
  lamps: Lamp[];                 // street lamps and floodlights: they light the scene at night
  gantry: THREE.Vector3[];       // the five start lights
  uniforms: { uSnow: { value: number }; uWet: { value: number }; uNight: { value: number } };
  mats: THREE.MeshStandardMaterial[]; // every material of the static world, for the renderer to set up
  dispose(): void;
}

function tint(geo: THREE.BufferGeometry, c: THREE.ColorRepresentation): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  const col = new THREE.Color(c);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  g.deleteAttribute('uv');
  return g;
}
export function box(w: number, h: number, d: number, x: number, y: number, z: number, c: THREE.ColorRepresentation) {
  return tint(new THREE.BoxGeometry(w, h, d).translate(x, y, z), c);
}

/** A smooth-shaded lump: vertices welded, pushed about by noise, lighter on top and darker beneath. */
function organic(geo: THREE.BufferGeometry, c: THREE.ColorRepresentation, wobble: number, seed: number): THREE.BufferGeometry {
  geo.deleteAttribute('uv'); geo.deleteAttribute('normal');
  const g = mergeVertices(geo, 1e-3);
  const pos = g.attributes.position as THREE.BufferAttribute;
  g.computeVertexNormals();
  const nor = g.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = wobble * (Math.sin(x * 2.3 + seed) * Math.cos(z * 2.1 - seed * 1.7) + 0.6 * Math.sin(y * 3.1 + seed * 0.6 + x * 1.3));
    pos.setXYZ(i, x + nor.getX(i) * k, y + nor.getY(i) * k, z + nor.getZ(i) * k);
  }
  g.computeVertexNormals();
  const out = g.toNonIndexed();
  const col = new THREE.Color(c), n = out.attributes.position.count, arr = new Float32Array(n * 3), nn = out.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < n; i++) {
    const sh = 0.72 + 0.34 * (nn.getY(i) * 0.5 + 0.5);
    arr[i * 3] = col.r * sh; arr[i * 3 + 1] = col.g * sh; arr[i * 3 + 2] = col.b * sh;
  }
  out.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return out;
}

// Shader detail shared by the world's materials: natural colour, fine surface variation,
// a little relief so grass, tarmac and stone catch the light, and rain and snow.
const NOISE_GLSL = `
float nlHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float nlNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(nlHash(i), nlHash(i + vec2(1.0, 0.0)), f.x), mix(nlHash(i + vec2(0.0, 1.0)), nlHash(i + vec2(1.0, 1.0)), f.x), f.y); }
float nlFbm(vec2 p){ return 0.55 * nlNoise(p) + 0.3 * nlNoise(p * 2.13 + 4.1) + 0.15 * nlNoise(p * 4.37 + 9.7); }
`;
interface Detail { fine: number; relief: number; reliefScale: number; natural: number; weather: boolean; gamma: number; gain: number; mottle: number }
function enhance(m: THREE.MeshStandardMaterial, d: Detail, U: World['uniforms']): THREE.MeshStandardMaterial {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uSnow = U.uSnow; sh.uniforms.uWet = U.uWet;
    sh.vertexShader = sh.vertexShader
      .replace('void main() {', 'varying vec3 vWPos;\nvoid main() {')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 wp4 = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          wp4 = instanceMatrix * wp4;
        #endif
        vWPos = (modelMatrix * wp4).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', `varying vec3 vWPos; uniform float uSnow; uniform float uWet;${NOISE_GLSL}\nvoid main() {`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float dn1 = nlFbm(vWPos.xz * ${d.fine.toFixed(3)} + vWPos.y * 0.37), dn2 = nlFbm(vWPos.xz * 0.045 + 7.3);
        vec3 c0 = diffuseColor.rgb;
        c0 = mix(vec3(dot(c0, vec3(0.3, 0.6, 0.1))), c0, ${d.natural.toFixed(3)});
        c0 = pow(c0, vec3(${d.gamma.toFixed(3)})) * ${d.gain.toFixed(3)} * vec3(1.05, 0.94, 0.82);
        c0 *= 1.0 + ${d.mottle.toFixed(3)} * ((dn1 - 0.5) * 1.6 + (dn2 - 0.5) * 1.1);
        diffuseColor.rgb = c0;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + (dn1 - 0.5) * 0.18, 0.04, 1.0);
        ${d.weather ? 'roughnessFactor = mix(roughnessFactor, 0.4, uWet * 0.6);' : ''}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          float hgt = nlFbm(vWPos.xz * ${d.reliefScale.toFixed(3)} + vWPos.y * 0.9) * ${d.relief.toFixed(4)};
          vec3 sp = -vViewPosition, dpx = dFdx(sp), dpy = dFdy(sp);
          vec3 r1 = cross(dpy, normal), r2 = cross(normal, dpx);
          float det = dot(dpx, r1);
          normal = normalize(abs(det) * normal - sign(det) * (dFdx(hgt) * r1 + dFdy(hgt) * r2));
          ${d.weather ? `float upness = dot(normal, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz));
          diffuseColor.rgb *= 1.0 - 0.3 * uWet;
          float sn = uSnow * smoothstep(0.2, 0.7, upness + (dn1 - 0.5) * 0.3);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.89, 0.94), sn);
          roughnessFactor = mix(roughnessFactor, 0.75, sn);` : ''}
        }`);
  };
  return m;
}

class Quads {
  pos: number[] = []; col: number[] = [];
  private c = new THREE.Color();
  quad(a: number[], b: number[], c: number[], d: number[], color: THREE.ColorRepresentation) {
    this.pos.push(...a, ...b, ...c, ...c, ...b, ...d);
    this.c.set(color);
    for (let i = 0; i < 6; i++) this.col.push(this.c.r, this.c.g, this.c.b);
  }
  get empty() { return this.pos.length === 0; }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    return g;
  }
}

export function makeGradientMap(): THREE.DataTexture {
  // five bands across N.L from -1 to 1
  const data = new Uint8Array([105, 105, 150, 210, 255]);
  const tex = new THREE.DataTexture(data, 5, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter; tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

interface Look {
  ground: string[]; high: string; hills: number;
  verge: [string, string]; gravel: [string, string];
  props: ('pine' | 'round' | 'bush' | 'rock' | 'cactus' | 'palm')[]; // four slots: tall A, tall B, low, rock
  tints: string[][];
  density: number;
}
const LOOKS: Record<Theme, Look> = {
  forest: {
    ground: ['#8fd866', '#7fce5c', '#72c356', '#9ae070'], high: '#5fb354', hills: 13,
    verge: ['#9be273', '#86d660'], gravel: ['#ecd9a6', '#e3cd94'],
    props: ['pine', 'round', 'bush', 'rock'],
    tints: [['#2f9160', '#37a56a', '#2a8358', '#40b377'], ['#5cc04e', '#6fd05a', '#4fb046', '#8bdc5c', '#5cc04e', '#6fd05a', '#f2a53f', '#f7a6c6'], ['#57b94c', '#6ccb57', '#48a843'], ['#a8b0ba', '#939ca8', '#bcc3cc']],
    density: 1,
  },
  parkland: {
    ground: ['#a4e27a', '#96d96e', '#8bd266', '#b0e986'], high: '#7cc763', hills: 6,
    verge: ['#aee884', '#9cdf74'], gravel: ['#efdfb0', '#e6d29c'],
    props: ['round', 'round', 'bush', 'rock'],
    tints: [['#4fae48', '#5cc04e', '#6fd05a', '#47a04a'], ['#7fd65e', '#93e06b', '#6ecb58', '#f2c14e', '#f7a6c6', '#ffffff'], ['#63c455', '#7ad364'], ['#b4bcc6', '#a3acb8']],
    density: 0.6,
  },
  city: {
    ground: ['#cfc9bc', '#c6c0b2', '#d6d1c5', '#9fd67a'], high: '#bdb7aa', hills: 2.5,
    verge: ['#bbb6aa', '#b0ab9f'], gravel: ['#c9c4b8', '#bfbaae'],
    props: ['round', 'round', 'bush', 'rock'],
    tints: [['#5cc04e', '#6fd05a', '#4fb046'], ['#6fd05a', '#8bdc5c', '#f7a6c6'], ['#57b94c', '#6ccb57'], ['#a8b0ba', '#939ca8']],
    density: 0.35,
  },
  desert: {
    ground: ['#ecd08f', '#e4c480', '#f1d89d', '#dcb974'], high: '#cf9f62', hills: 10,
    verge: ['#e8c988', '#dfbd79'], gravel: ['#f3e2b4', '#ead6a0'],
    props: ['cactus', 'palm', 'bush', 'rock'],
    tints: [['#4f9a55', '#5aa860', '#458a4d'], ['#5fb85a', '#6dc566', '#52a651'], ['#b5a85c', '#a89a50', '#c4b56a'], ['#d08a55', '#c27a4a', '#dc9c66', '#b96f44']],
    density: 0.45,
  },
};

export function buildWorld(track: Track): World {
  const group = new THREE.Group();
  const rnd = mulberry32((track.seed * 31 + 7) >>> 0);
  const noise = makeNoise(track.seed + 99);
  const look = LOOKS[track.theme];
  const HW = track.hw, RO = track.ro;
  const FLAT_TO = HW + 18, HILLS_AT = HW + 35;
  const uniforms = { uSnow: { value: 0 }, uWet: { value: 0 }, uNight: { value: 0 } };

  // Physically based materials. Land can be dusted with snow (on whatever faces up) and soaked by rain.
  const std = (rough: number, side: THREE.Side = THREE.FrontSide) => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: rough, metalness: 0, side });
  const toon = enhance(std(0.92), { fine: 0.9, relief: 0.2, reliefScale: 1.7, natural: 0.6, weather: true, gamma: 1.5, gain: 0.74, mottle: 0.5 }, uniforms);
  const toonDouble = enhance(std(0.9, THREE.DoubleSide), { fine: 0.9, relief: 0.12, reliefScale: 1.7, natural: 0.6, weather: true, gamma: 1.5, gain: 0.74, mottle: 0.4 }, uniforms);
  const road = enhance(std(0.8, THREE.DoubleSide), { fine: 5.5, relief: 0.012, reliefScale: 9.0, natural: 0.9, weather: false, gamma: 1.25, gain: 0.8, mottle: 0.22 }, uniforms);
  const water = enhance(new THREE.MeshStandardMaterial({ color: '#1c4a5a', roughness: 0.06, metalness: 0.0 }), { fine: 0.25, relief: 0.05, reliefScale: 0.9, natural: 1, weather: false, gamma: 1, gain: 1, mottle: 0.1 }, uniforms);
  // windows and lamp heads: dark glass that mirrors the sky by day, glowing after dark
  const glow = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.1, metalness: 0 });
  glow.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = uniforms.uNight;
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', 'uniform float uNight;\nvoid main() {')
      .replace('#include <color_fragment>', '#include <color_fragment>\n vec3 litCol = diffuseColor.rgb; diffuseColor.rgb = vec3(0.025, 0.035, 0.05);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += litCol * uNight * 0.9;');
  };
  const mats: THREE.MeshStandardMaterial[] = [toon, toonDouble, road, water, glow];
  const geos: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, m: THREE.Material, cast: boolean, recv = true) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.castShadow = cast; mesh.receiveShadow = recv;
    group.add(mesh); geos.push(g);
    return mesh;
  };

  const minX = Math.floor(track.minX - PAD), maxX = Math.ceil(track.maxX + PAD);
  const minZ = Math.floor(track.minZ - PAD), maxZ = Math.ceil(track.maxZ + PAD);
  const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  // ----- start straight frame -----
  // local frame: x along the track, z to the grandstand side. The pits are on the camera's
  // side of the road so we look into the garages and, across the track, into the stand.
  const flip = track.pitSide === 1, fx = flip ? -1 : 1;
  const T = new THREE.Vector3(track.tx[0], 0, track.tz[0]).multiplyScalar(fx), Nn = new THREE.Vector3(-track.tz[0], 0, track.tx[0]).multiplyScalar(fx);
  const frame = new THREE.Matrix4().makeBasis(T, new THREE.Vector3(0, 1, 0), Nn).setPosition(track.px[0], track.h[0], track.pz[0]);
  const inv = frame.clone().invert();
  const tmp = new THREE.Vector3();
  /** 1 well inside the paddock area around the start, fading to 0 outside it. */
  const paddock = (x: number, z: number) => {
    tmp.set(x, 0, z).applyMatrix4(inv);
    return (1 - smooth(52, 66, Math.abs(tmp.x))) * (1 - smooth(RO + 24, RO + 36, Math.abs(tmp.z)));
  };

  const st = new Float64Array(4);
  const hillBase = 0.6 + track.maxH * 0.3;
  // On the long circuits the road climbs tens of metres, so the land away from it has to rise
  // and fall with it: a coarse map of the road's height nearby, spread out by inverse distance.
  const big = track.length > 2500;
  const RC = 30, rw = Math.ceil((maxX - minX) / RC) + 2, rh = Math.ceil((maxZ - minZ) / RC) + 2;
  const region = new Float32Array(big ? rw * rh : 0);
  if (big) {
    const step = Math.max(1, Math.round(15 / track.ds));
    for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) {
      const x = minX + i * RC, z = minZ + j * RC;
      let sw = 0, sh = 0;
      for (let k = 0; k < track.n; k += step) {
        const dx = track.px[k] - x, dz = track.pz[k] - z, wgt = 1 / (dx * dx + dz * dz + 900);
        sw += wgt * wgt; sh += wgt * wgt * track.h[k];
      }
      region[j * rw + i] = sh / sw;
    }
  }
  const regionAt = (x: number, z: number) => {
    const fx = Math.min(rw - 1.001, Math.max(0, (x - minX) / RC)), fz = Math.min(rh - 1.001, Math.max(0, (z - minZ) / RC));
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, c = j * rw + i;
    return (region[c] * (1 - u) + region[c + 1] * u) * (1 - v) + (region[c + rw] * (1 - u) + region[c + rw + 1] * u) * v;
  };
  // Ground height. Near the road the land follows the road's own elevation; further out it
  // blends into rolling hills. Where two stretches are close at different heights the land
  // blends between them, except right beside the lower one, which keeps its level so the
  // upper road has to stand on a wall (or, where it passes over, a bridge).
  const paddockH = track.h[0];
  const heightAt = (x: number, z: number) => {
    const pd = paddock(x, z);
    const hills = big
      ? noise(x * 0.006, z * 0.006, 3) * look.hills * 1.6 + regionAt(x, z) + 1.2 + (paddockH - regionAt(x, z) - 1.2) * pd
      : (noise(x * 0.011, z * 0.011, 3) * look.hills + hillBase) * (1 - pd);
    stretchesAt(track, x, z, st);
    if (st[1] < 0) return hills;
    const dmin = distAny(track, x, z);
    const w = smooth(FLAT_TO, HILLS_AT, dmin);
    if (w >= 1) return hills;
    const h1 = track.h[st[1]];
    let base = h1;
    if (st[3] >= 0) {
      const h2 = track.h[st[3]];
      const k1 = (1 - smooth(FLAT_TO * 0.6, HILLS_AT, st[0])) / (st[0] + 0.5), k2 = (1 - smooth(FLAT_TO * 0.6, HILLS_AT, st[2])) / (st[2] + 0.5);
      base = k1 + k2 > 1e-6 ? (k1 * h1 + k2 * h2) / (k1 + k2) : h1;
      if (Math.abs(h1 - h2) > 2.5) {
        const lowH = Math.min(h1, h2), dLow = h1 < h2 ? st[0] : st[2];
        const wl = smooth(RO + 17, RO + 5, dLow);
        base = base + (lowH - base) * wl;
      }
    }
    return base * (1 - w) + hills * w - (dmin < RO + 1.5 ? 0.06 : 0);
  };

  // ----- terrain -----
  {
    const CELL = big ? 3 : 2;
    const nx = Math.round((maxX - minX) / CELL) + 1, nz = Math.round((maxZ - minZ) / CELL) + 1;
    const pos = new Float32Array(nx * nz * 3), col = new Float32Array(nx * nz * 3);
    const ground = look.ground.map((c) => new THREE.Color(c));
    const high = new THREE.Color(look.high), sand = new THREE.Color('#ecd9a0'), bed = new THREE.Color('#c9b888'), apron = new THREE.Color('#b9b6ae');
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const x = minX + i * CELL, z = minZ + j * CELL, h = heightAt(x, z);
      const k = (j * nx + i) * 3;
      pos[k] = x; pos[k + 1] = h; pos[k + 2] = z;
      let c: THREE.Color;
      if (h < WATER_Y - 0.3) c = bed;
      else if (h < WATER_Y + 0.7) c = sand;
      else if (paddock(x, z) > 0.6) c = apron;
      else if (h > hillBase + 5) c = high;
      else c = ground[Math.min(3, Math.floor((noise(x * 0.035 + 40, z * 0.035 - 20, 2) * 0.5 + 0.5) * 4.6))];
      col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
    }
    const idx: number[] = [];
    for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    const aPos = new THREE.BufferAttribute(pos, 3), aCol = new THREE.BufferAttribute(col, 3);
    g.setAttribute('position', aPos);
    g.setAttribute('color', aCol);
    g.setIndex(idx);
    g.computeVertexNormals();
    // Cut the land into square patches that share the same vertices. Each patch knows its own
    // bounds, so the bake camera and the shadow cameras skip the ones they cannot see: on the
    // big circuits that is most of them whenever the view follows a car.
    const P = 80, aNor = g.getAttribute('normal');
    for (let pj = 0; pj < nz - 1; pj += P) for (let pi = 0; pi < nx - 1; pi += P) {
      const cid: number[] = [];
      const box = new THREE.Box3();
      for (let j = pj; j < Math.min(nz - 1, pj + P); j++) for (let i = pi; i < Math.min(nx - 1, pi + P); i++) {
        const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
        cid.push(a, c, b, b, c, d);
        for (const v of [a, d]) box.expandByPoint(tmp.set(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]));
      }
      const cg = new THREE.BufferGeometry();
      cg.setAttribute('position', aPos); cg.setAttribute('color', aCol); cg.setAttribute('normal', aNor);
      cg.setIndex(cid);
      box.expandByScalar(1);
      cg.boundingBox = box; cg.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
      add(cg, toon, false);
    }

    // diorama skirt: earth sides under the edge of the land
    const q = new Quads();
    const BOT = -16;
    const side = (x0: number, z0: number, x1: number, z1: number) => {
      const steps = Math.round(Math.hypot(x1 - x0, z1 - z0) / CELL);
      for (let s = 0; s < steps; s++) {
        const ax = x0 + ((x1 - x0) * s) / steps, az = z0 + ((z1 - z0) * s) / steps;
        const bx = x0 + ((x1 - x0) * (s + 1)) / steps, bz = z0 + ((z1 - z0) * (s + 1)) / steps;
        const ha = Math.max(heightAt(ax, az), WATER_Y), hb = Math.max(heightAt(bx, bz), WATER_Y);
        q.quad([ax, ha, az], [bx, hb, bz], [ax, -4, az], [bx, -4, bz], '#b98556');
        q.quad([ax, -4, az], [bx, -4, bz], [ax, BOT, az], [bx, BOT, bz], '#8f6243');
      }
    };
    side(minX, maxZ, maxX, maxZ); side(maxX, maxZ, maxX, minZ);
    side(maxX, minZ, minX, minZ); side(minX, minZ, minX, maxZ);
    add(q.build(), road, false);

    // water
    const w = new THREE.PlaneGeometry(maxX - minX - 0.2, maxZ - minZ - 0.2).rotateX(-Math.PI / 2).translate((minX + maxX) / 2, WATER_Y, (minZ + maxZ) / 2);
    add(w, water, false);
  }

  // ----- track ribbons -----
  const n = track.n;
  const corner = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (Math.abs(track.curv[i]) > 0.016) for (let d = -5; d <= 5; d++) corner[(i + d + n) % n] = track.curv[i] > 0 ? 1 : 2;
  const at = (i: number, off: number, y: number) => [track.px[i] - track.tz[i] * off, y + track.h[i], track.pz[i] + track.tx[i] * off];
  const ribbon = (q: Quads, a: number, ya: number, b: number, yb: number, color: (i: number) => THREE.ColorRepresentation | null) => {
    for (let i = 0; i < n; i++) {
      const c = color(i);
      if (c === null) continue;
      const j = (i + 1) % n;
      q.quad(at(i, a, ya), at(i, b, yb), at(j, a, ya), at(j, b, yb), c);
    }
  };
  const idxOf = (s: number) => (((Math.round(s / track.ds)) % n) + n) % n;
  /** metres from the start line, in (-L/2, L/2] */
  const sOf = (i: number) => { const s = i * track.ds; return s > track.length / 2 ? s - track.length : s; };
  const PS = track.pitSide;
  /** is the barrier on this side opened here for the pit lane to cross? */
  const pitGap = (i: number, sgn: number) => {
    if (sgn !== PS) return false;
    const s = sOf(i);
    return (s > track.pitIn + 4 && s < track.pitIn + 40) || (s > track.pitOut - 40 && s < track.pitOut - 4);
  };
  {
    const land = new Quads(), q = new Quads();
    const W = HW;
    // run-off: gravel on the outside of corners, mown stripes elsewhere
    const verge = (sideSign: number) => (i: number) => {
      const outside = (corner[i] === 1 && sideSign < 0) || (corner[i] === 2 && sideSign > 0);
      const alt = Math.floor(i / 5) % 2 === 0;
      return outside ? look.gravel[alt ? 0 : 1] : look.verge[alt ? 0 : 1];
    };
    ribbon(land, W - 0.1, 0.03, RO + 0.1, 0.03, verge(1));
    ribbon(land, -RO - 0.1, 0.03, -W + 0.1, 0.03, verge(-1));
    ribbon(q, -W, 0.05, W, 0.05, () => '#55575e');
    ribbon(q, W - 0.6, 0.07, W - 0.3, 0.07, () => '#f6f3ea');
    ribbon(q, -W + 0.3, 0.07, -W + 0.6, 0.07, () => '#f6f3ea');
    const kerbW = Math.min(1.0, RO - W - 0.4);
    const kerb = (i: number) => (corner[i] ? (Math.floor(i / 2) % 2 ? '#f6f3ea' : '#ea4f4b') : null);
    ribbon(q, W - 0.25, 0.09, W + kerbW, 0.11, kerb);
    ribbon(q, -W - kerbW, 0.11, -W + 0.25, 0.09, kerb);
    // start/finish chequers
    const rows = 3, cols = 12, cw = (2 * W) / cols;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const s0 = r * 0.9 - 1.35, s1 = s0 + 0.9, o0 = -W + c * cw, o1 = o0 + cw;
      const p = (s: number, o: number) => [track.px[0] + track.tx[0] * s - track.tz[0] * o, 0.08, track.pz[0] + track.tz[0] * s + track.tx[0] * o];
      q.quad(p(s0, o0), p(s0, o1), p(s1, o0), p(s1, o1), (r + c) % 2 ? '#f6f3ea' : '#23252e');
    }
    // grid slots
    for (let k = 0; k < 8; k++) {
      const s = -6 - k * GRID_GAP + 4.2, o = (k % 2 ? -1 : 1) * W * 0.4;
      const p = (ds: number, dor: number) => { const i = idxOf(s + ds); return at(i, o + dor, 0.075); };
      q.quad(p(0, -1.5), p(0, 1.5), p(0.35, -1.5), p(0.35, 1.5), '#f6f3ea');
    }

    // ----- pit lane -----
    const LW = 2.9;
    for (let s = track.pitIn; s < track.pitOut; s += 1) {
      const i = idxOf(s), j = idxOf(s + 1);
      const la = pitLat(track, s), lb = pitLat(track, s + 1);
      if (Math.abs(la) < W - 1.2) continue;
      const a0 = la - LW, a1 = la + LW, b0 = lb - LW, b1 = lb + LW;
      q.quad(at(i, a0, 0.06), at(i, a1, 0.06), at(j, b0, 0.06), at(j, b1, 0.06), '#62646b');
      const flatPart = s > track.pitIn + 40 && s < track.pitOut - 41;
      if (flatPart) {
        const inner = PS * (Math.abs(la) - LW + 0.25), innerB = PS * (Math.abs(lb) - LW + 0.25);
        q.quad(at(i, inner, 0.075), at(i, inner + PS * 0.25, 0.075), at(j, innerB, 0.075), at(j, innerB + PS * 0.25, 0.075), '#f6f3ea');
      }
    }
    track.boxes.forEach((s, k) => {
      const o0 = PS * (track.pitLane + 0.6), o1 = PS * (track.pitLane + LW - 0.2);
      const i = idxOf(s - 3.2), j = idxOf(s + 3.2);
      q.quad(at(i, o0, 0.08), at(i, o1, 0.08), at(j, o0, 0.08), at(j, o1, 0.08), TEAMS[k].color);
    });
    add(land.build(), toonDouble, false);
    add(q.build(), road, false);

    // barriers
    const b = new Quads();
    const street = track.style === 'street';
    for (const sgn of [1, -1]) {
      const o1 = sgn * RO, o2 = sgn * (RO + 0.7), H = street ? 1.25 : 1.0;
      const colr = (i: number) => {
        if (pitGap(i, sgn)) return null;
        const hot = (corner[i] === 1 && sgn < 0) || (corner[i] === 2 && sgn > 0);
        const alt = Math.floor(i / 4) % 2 === 0;
        if (street) return hot ? (alt ? '#ea4f4b' : '#f6f3ea') : alt ? '#dcd8cf' : '#4aa8e8';
        return hot ? (alt ? '#ea4f4b' : '#f6f3ea') : alt ? '#f6f3ea' : '#b9c7d6';
      };
      ribbon(b, o1, 0, o1, H, colr);
      ribbon(b, o1, H, o2, H, colr);
      ribbon(b, o2, H, o2, 0, colr);
    }
    add(b.build(), toonDouble, true);

    // ----- viaducts and the bridge -----
    // Wherever the road stands above the land it gets a retaining wall down to the ground.
    // Where it passes over the other stretch of road, the wall is left open as a bridge span.
    const O2 = RO + 0.7, DECK = 1.6;
    const span = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      for (const off of [-RO, 0, RO]) {
        const p = at(i, off, 0);
        stretchesAt(track, p[0], p[2], st);
        for (const e of [0, 2]) {
          const id = st[e + 1];
          if (id >= 0 && gap(id, i, n) > 80 && st[e] < RO + 1.5 && track.h[id] < track.h[i] - 3) {
            for (let d = -3; d <= 3; d++) span[(i + d + n) % n] = 1;
          }
        }
      }
    }
    const v = new Quads();
    const ground = (i: number, off: number) => { const p = at(i, off, 0); return heightAt(p[0], p[2]) - 0.5; };
    const raw = (i: number, off: number, y: number) => [track.px[i] - track.tz[i] * off, y, track.pz[i] + track.tx[i] * off];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const shade = Math.floor(i / 6) % 2 ? '#d2c3a8' : '#bfae92';
      if (span[i] && span[j]) {
        v.quad(at(i, -O2, -DECK), at(i, O2, -DECK), at(j, -O2, -DECK), at(j, O2, -DECK), '#6f6a60');
        for (const sgn of [1, -1]) v.quad(at(i, sgn * O2, 0), at(i, sgn * O2, -DECK), at(j, sgn * O2, 0), at(j, sgn * O2, -DECK), Math.floor(i / 3) % 2 ? '#e2574c' : '#c9463c');
        continue;
      }
      for (const sgn of [1, -1]) {
        const gi = ground(i, sgn * O2), gj = ground(j, sgn * O2);
        if (track.h[i] - gi < 0.9 && track.h[j] - gj < 0.9) continue;
        v.quad(at(i, sgn * O2, 0), raw(i, sgn * O2, Math.min(gi, track.h[i])), at(j, sgn * O2, 0), raw(j, sgn * O2, Math.min(gj, track.h[j])), shade);
      }
      if (span[i] !== span[j]) {
        // abutment: close off the end of the wall where the open span begins
        const k = span[i] ? j : i;
        const g = Math.min(ground(k, O2), ground(k, -O2));
        v.quad(at(k, -O2, 0), at(k, O2, 0), raw(k, -O2, g), raw(k, O2, g), '#bfae92');
      }
    }
    if (!v.empty) add(v.build(), toonDouble, true);
  }

  // ----- start straight buildings -----
  const lamps: Lamp[] = [];
  const gantry: THREE.Vector3[] = [];
  const glowQ = new Quads();
  const toWorld = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(frame);
  {
    const parts: THREE.BufferGeometry[] = [];
    const W = HW;
    const bright = ['#ea4f4b', '#f5c542', '#4aa8e8', '#f6f3ea', '#ff8fb1', '#7bd66b', '#b07cf0'];
    // grandstand (far side)
    const gx = fx * 12, z0 = RO + 5;
    for (let k = 0; k < 6; k++) parts.push(box(40, (k + 1) * 0.9 + 2, 1.7, gx, (k + 1) * 0.45 - 1, z0 + k * 1.7, k % 2 ? '#dfe5ee' : '#c9d2de'));
    for (let k = 0; k < 6; k++) for (let m = 0; m < 26; m++) {
      if (rnd() < 0.28) continue;
      parts.push(box(0.7, 0.9, 0.7, gx - 19 + m * 1.5 + rnd() * 0.3, (k + 1) * 0.9 + 0.45, z0 + k * 1.7 + 0.2, bright[Math.floor(rnd() * bright.length)]));
    }
    parts.push(box(41, 11, 0.6, gx, 3.5, z0 + 10.6, '#f3ead7'));
    parts.push(box(0.6, 11, 11, gx - 20.3, 3.5, z0 + 5.3, '#f3ead7'), box(0.6, 11, 11, gx + 20.3, 3.5, z0 + 5.3, '#f3ead7'));
    parts.push(box(43, 0.5, 13, gx, 9.3, z0 + 4.8, '#ea4f4b'));
    for (let f = 0; f < 5; f++) {
      const ffx = gx - 18 + f * 9;
      parts.push(box(0.14, 3.2, 0.14, ffx, 11.1, z0 + 9.5, '#39404f'), box(1.7, 0.9, 0.08, ffx + 0.9, 12.2, z0 + 9.5, bright[f % bright.length]));
    }
    // pit building (camera side), one garage per team opening onto the pit lane
    const front = -(track.pitLane + 4.4), depth = 8.5, pz = front - depth / 2, len = 86;
    parts.push(box(len, 6.4, depth, 0, 1.2, pz, '#f3ead7'), box(len + 1.5, 0.5, depth + 1.8, 0, 4.65, pz, '#3d4a5c'));
    parts.push(box(len + 0.1, 0.6, 0.2, 0, 3.6, front + 0.05, '#ea4f4b'));
    track.boxes.forEach((s, k) => {
      const x = fx * s;
      parts.push(box(6.4, 2.9, 0.2, x, 1.45, front + 0.06, '#2b3140'), box(6.4, 0.35, 0.24, x, 3.05, front + 0.08, TEAMS[k].color));
      const p = (dx: number, dy: number) => { const v3 = toWorld(x + dx, dy, front + 0.2); return [v3.x, v3.y, v3.z]; };
      glowQ.quad(p(-2.6, 2.75), p(2.6, 2.75), p(-2.6, 2.55), p(2.6, 2.55), '#fff1c4');
    });
    const tx0 = fx * -(len / 2 + 3.4);
    parts.push(box(5.5, 12, 5.5, tx0, 4, pz, '#f3ead7'), box(6.3, 2.2, 6.3, tx0, 10.2, pz, '#7fd6f2'), box(7, 0.5, 7, tx0, 11.5, pz, '#3d4a5c'));
    // start gantry
    parts.push(box(0.7, 7.6, 0.7, 0, 3.8, W + 1.7, '#39404f'), box(0.7, 7.6, 0.7, 0, 3.8, -(W + 1.7), '#39404f'));
    parts.push(box(1.3, 1.4, 2 * (W + 1.7) + 0.7, 0, 7.6, 0, '#39404f'));
    for (let l = 0; l < 5; l++) {
      parts.push(box(0.3, 0.9, 0.9, -0.75 * fx, 7.6, (l - 2) * 1.6, '#3a1f22'));
      gantry.push(toWorld(-0.95 * fx, 7.6, (l - 2) * 1.6));
    }
    const merged = mergeGeometries(parts)!;
    merged.applyMatrix4(frame);
    parts.forEach((p) => p.dispose());
    add(merged, toon, true);
    // floodlights over the grid and the pits
    for (const lx of [-34, -10, 14, 38]) { const p = toWorld(lx, 15, RO + 2); lamps.push({ x: p.x, y: p.y, z: p.z, r: 46, color: [1.0, 0.97, 0.9] }); }
    for (const lx of [-30, 0, 30]) { const p = toWorld(lx, 7, front + 3.5); lamps.push({ x: p.x, y: p.y, z: p.z, r: 26, color: [1.0, 0.9, 0.7] }); }
  }

  // ----- street lamps -----
  {
    const parts: THREE.BufferGeometry[] = [];
    let k = 0;
    for (let s = 70; s < track.length - 70; s += 36, k++) {
      const i = idxOf(s), sgn = k % 2 ? 1 : -1;
      const rel = sOf(i);
      if (sgn === PS && rel > track.pitIn - 8 && rel < track.pitOut + 8) continue;
      const base = at(i, sgn * (RO + 1.5), 0), head = at(i, sgn * (RO - 1.3), 7.4);
      const ang = Math.atan2(track.tz[i], track.tx[i]);
      const m = new THREE.Matrix4().makeRotationY(-ang).setPosition(base[0], base[1], base[2]);
      // local frame here: x along the track, z across it (towards +sgn is away from the road)
      const post = box(0.26, 8.4, 0.26, 0, 3.2, 0, '#4a5262'), arm = box(0.2, 0.2, 3.0, 0, 7.5, -sgn * 1.4, '#4a5262');
      post.applyMatrix4(m); arm.applyMatrix4(m);
      parts.push(post, arm);
      const hx = head[0], hy = head[1], hz = head[2], tx = track.tx[i] * 0.55, tz = track.tz[i] * 0.55, nx = -track.tz[i] * 0.3, nz = track.tx[i] * 0.3;
      glowQ.quad([hx - tx - nx, hy, hz - tz - nz], [hx + tx - nx, hy, hz + tz - nz], [hx - tx + nx, hy, hz - tz + nz], [hx + tx + nx, hy, hz + tz + nz], '#ffe2a8');
      lamps.push({ x: hx, y: hy, z: hz, r: 27, color: [1.0, 0.8, 0.5] });
    }
    if (parts.length) { add(mergeGeometries(parts)!, toon, true); parts.forEach((p) => p.dispose()); }
  }

  // ----- city blocks -----
  const blocks: [number, number, number, number][] = []; // x, z, half width, half depth
  if (track.theme === 'city') {
    const parts: THREE.BufferGeometry[] = [];
    const walls = ['#e8dcc8', '#d9c7b0', '#c9d3dc', '#e6c9b8', '#bfc8d2', '#f0e4d0', '#d6b8a8', '#cfd8c4'];
    const roofs = ['#8a8f9c', '#c96f55', '#6f7684', '#b9604a', '#9aa1ad'];
    const lit = ['#ffd98a', '#fff1c4', '#ffe9b0', '#cfe6ff'];
    const STEP = 29;
    for (let gz = minZ + 16; gz < maxZ - 16; gz += STEP) for (let gx2 = minX + 16; gx2 < maxX - 16; gx2 += STEP) {
      const x = gx2 + (rnd() - 0.5) * 6, z = gz + (rnd() - 0.5) * 6;
      const w = 15 + rnd() * 8, dp = 15 + rnd() * 8, u = rnd(), u2 = rnd(), u3 = rnd(), u4 = rnd();
      const d = distAny(track, x, z);
      if (d < RO + 9 + Math.max(w, dp) * 0.75 || paddock(x, z) > 0.02) continue;
      const g0 = heightAt(x, z);
      if (g0 < WATER_Y + 1.2) continue;
      const park = noise(x * 0.02 + 300, z * 0.02 + 90, 2);
      if (park > 0.28) continue; // left open as a park
      const tall = smooth(-0.1, 0.5, noise(x * 0.012 - 70, z * 0.012 + 20, 2));
      // low-rise beside the circuit so the road is never hidden, towers further back
      const hgt = Math.min(9 + u * 12 + tall * 34, 7 + (d - RO - 9) * 0.75);
      parts.push(box(w, hgt + 3, dp, x, g0 + hgt / 2 - 1.5, z, walls[Math.floor(u2 * walls.length)]));
      parts.push(box(w + 0.8, 0.7, dp + 0.8, x, g0 + hgt + 0.35, z, roofs[Math.floor(u3 * roofs.length)]));
      if (u4 < 0.4) parts.push(box(w * 0.4, 2.2, dp * 0.4, x + w * 0.12, g0 + hgt + 1.8, z - dp * 0.1, '#aab1bd'));
      blocks.push([x, z, w / 2 + 2, dp / 2 + 2]);
      // windows on the two faces the camera sees (+x and +z)
      const floors = Math.max(2, Math.floor((hgt - 2.5) / 3.4));
      for (let f = 0; f < floors; f++) {
        const y0 = g0 + 2.2 + f * 3.4, y1 = y0 + 1.8;
        const nz2 = Math.max(2, Math.floor(dp / 3.3)), nx2 = Math.max(2, Math.floor(w / 3.3));
        for (let c = 0; c < nz2; c++) {
          const a = z - dp / 2 + ((c + 0.2) / nz2) * dp, b = z - dp / 2 + ((c + 0.8) / nz2) * dp;
          glowQ.quad([x + w / 2 + 0.06, y1, a], [x + w / 2 + 0.06, y1, b], [x + w / 2 + 0.06, y0, a], [x + w / 2 + 0.06, y0, b], rnd() < 0.55 ? lit[Math.floor(rnd() * lit.length)] : '#0e1220');
        }
        for (let c = 0; c < nx2; c++) {
          const a = x - w / 2 + ((c + 0.2) / nx2) * w, b = x - w / 2 + ((c + 0.8) / nx2) * w;
          glowQ.quad([a, y1, z + dp / 2 + 0.06], [b, y1, z + dp / 2 + 0.06], [a, y0, z + dp / 2 + 0.06], [b, y0, z + dp / 2 + 0.06], rnd() < 0.55 ? lit[Math.floor(rnd() * lit.length)] : '#0e1220');
        }
      }
    }
    if (parts.length) { add(mergeGeometries(parts)!, toon, true); parts.forEach((p) => p.dispose()); }
  }
  if (!glowQ.empty) add(glowQ.build(), glow, false, false);

  // ----- scattered props (instanced) -----
  let lump = 1;
  // the big circuits are seen from further off and have many more trees: simpler ones do
  const cone = (r: number, h: number, y: number, c: string) => organic(new THREE.ConeGeometry(r, h, big ? 8 : 11, big ? 2 : 3).translate(0, y + h / 2, 0), c, 0.1, lump++ * 1.9);
  const blob = (r: number, x: number, y: number, z: number, c: string, det = 1) =>
    det === 0 ? tint(new THREE.IcosahedronGeometry(r, 0).translate(x, y, z), c) : organic(new THREE.IcosahedronGeometry(r, big ? 1 : r > 1.8 ? 2 : 1).translate(x, y, z), c, r * 0.1, lump++ * 2.7);
  const GEO: Record<Look['props'][number], () => THREE.BufferGeometry> = {
    pine: () => mergeGeometries([
      tint(new THREE.CylinderGeometry(0.32, 0.42, 1.8, 6).translate(0, 0.9, 0), '#5b3d2a'),
      cone(2.3, 3.2, 1.3, '#c8c8c8'), cone(1.8, 2.8, 3.0, '#e2e2e2'), cone(1.25, 2.5, 4.6, '#ffffff'),
    ])!,
    round: () => mergeGeometries([
      tint(new THREE.CylinderGeometry(0.34, 0.46, 2.6, 6).translate(0, 1.3, 0), '#5b3d2a'),
      blob(2.3, 0, 4.2, 0, '#e0e0e0'), blob(1.6, 1.3, 5.3, 0.5, '#ffffff'), blob(1.45, -1.2, 4.9, -0.7, '#c4c4c4'),
    ])!,
    bush: () => mergeGeometries([blob(1.0, 0, 0.6, 0, '#e6e6e6'), blob(0.7, 0.8, 0.45, 0.3, '#ffffff')])!,
    rock: () => mergeGeometries([blob(1.1, 0, 0.5, 0, '#ffffff', 0), blob(0.7, 1.0, 0.3, 0.4, '#dcdcdc', 0)])!,
    cactus: () => mergeGeometries([
      tint(new THREE.CylinderGeometry(0.42, 0.48, 4.2, 7).translate(0, 2.1, 0), '#ffffff'),
      box(1.1, 0.4, 0.4, 0.75, 2.3, 0, '#e4e4e4'), box(0.4, 1.5, 0.4, 1.2, 3.0, 0, '#ffffff'),
      box(0.9, 0.4, 0.4, -0.65, 1.7, 0, '#e4e4e4'), box(0.4, 1.1, 0.4, -1.0, 2.2, 0, '#ffffff'),
    ])!,
    palm: () => mergeGeometries([
      tint(new THREE.CylinderGeometry(0.2, 0.34, 6.2, 6).translate(0, 3.1, 0), '#8a6a4a'),
      tint(new THREE.IcosahedronGeometry(2.6, 1).scale(1, 0.28, 1).translate(0, 6.3, 0), '#ffffff'),
      tint(new THREE.IcosahedronGeometry(1.7, 1).scale(1, 0.35, 1).translate(0, 6.9, 0), '#e0e0e0'),
    ])!,
  };
  type Inst = { m: THREE.Matrix4; c: THREE.Color; k: number };
  const lists: Inst[][] = [[], [], [], []];
  const dummy = new THREE.Object3D();
  const tries = Math.round(((maxX - minX) * (maxZ - minZ)) / 26);
  const thin = Math.max(0, Math.min(0.9, 1 - 500000 / ((maxX - minX) * (maxZ - minZ))));
  const inBlock = (x: number, z: number) => blocks.some((b) => Math.abs(x - b[0]) < b[2] && Math.abs(z - b[1]) < b[3]);
  for (let k = 0; k < tries; k++) {
    const x = minX + 2 + rnd() * (maxX - minX - 4), z = minZ + 2 + rnd() * (maxZ - minZ - 4);
    const u = rnd(), sc = 0.75 + rnd() * 0.7, rot = rnd() * Math.PI * 2, uc = rnd(), ud = rnd();
    const d = distAny(track, x, z);
    if (d < RO + 4.5 || ud > look.density) continue;
    // on the very big circuits, thin the woods away from the road: they are seen from far off
    if (thin > 0 && d > RO + 30 && rnd() < thin) continue;
    const h = heightAt(x, z);
    if (h < WATER_Y + 0.5 || paddock(x, z) > 0.02 || inBlock(x, z)) continue;
    const forest = track.theme === 'city' ? noise(x * 0.02 + 300, z * 0.02 + 90, 2) - 0.2 : noise(x * 0.018 + 200, z * 0.018 + 50, 2);
    let type: number;
    if (forest > 0.05) type = u < 0.6 ? 0 : u < 0.92 ? 1 : 2;
    else if (forest > -0.25) { if (u > 0.3) continue; type = u < 0.12 ? 1 : u < 0.2 ? 0 : u < 0.26 ? 2 : 3; }
    else { if (u > 0.06) continue; type = u < 0.03 ? 3 : 2; }
    dummy.position.set(x, h - 0.15, z);
    dummy.rotation.set(0, rot, 0);
    dummy.scale.setScalar(type < 2 ? sc * 1.15 : sc);
    dummy.updateMatrix();
    const pal = look.tints[type];
    lists[type].push({ m: dummy.matrix.clone(), c: new THREE.Color(pal[Math.floor(uc * pal.length)]), k: Math.floor((x - minX) / 220) * 1000 + Math.floor((z - minZ) / 220) });
  }
  // one instanced mesh per kind of prop per 220 m patch, so that unseen patches are skipped
  look.props.forEach((name, t) => {
    if (!lists[t].length) return;
    const g = GEO[name]();
    geos.push(g);
    const patches = new Map<number, Inst[]>();
    for (const it of lists[t]) { let a = patches.get(it.k); if (!a) patches.set(it.k, (a = [])); a.push(it); }
    for (const items of patches.values()) {
      const im = new THREE.InstancedMesh(g, toon, items.length);
      items.forEach((it, i) => { im.setMatrixAt(i, it.m); im.setColorAt(i, it.c); });
      im.computeBoundingSphere();
      im.castShadow = true; im.receiveShadow = true;
      group.add(im);
    }
  });

  return {
    group, minX, maxX, minZ, maxZ, lamps, gantry, uniforms, mats,
    dispose() { geos.forEach((g) => g.dispose()); mats.forEach((m) => m.dispose()); },
  };
}
