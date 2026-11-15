// Low-poly toon models for each car class. Forward is +x, the ground is y = 0.
// White parts take the car's livery colour; everything else keeps its own.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { box } from './world';
import { CarId } from './cars';

const BODY = '#ffffff', GLASS = '#27344a', DARK = '#2a2c36', LAMP = '#fff6c2', TAIL = '#ff3b30';

export function carGeometry(id: CarId, inflate: number): THREE.BufferGeometry {
  const f = inflate, parts: THREE.BufferGeometry[] = [];
  const b = (w: number, h: number, d: number, x: number, y: number, z: number, c: string) => parts.push(box(w + f * 2, h + f * 2, d + f * 2, x, y, z, c));
  // wheels are separate objects (see wheelGeometry): they stay on the road while the body moves on its springs
  const wheel = (_x: number, _z: number, _r: number, _w: number) => {};
  const wheels = (fxp: number, rxp: number, z: number, r: number, w: number) => { wheel(fxp, z, r, w); wheel(fxp, -z, r, w); wheel(rxp, z, r, w); wheel(rxp, -z, r, w); };
  const lamps = (x: number, y: number, z: number) => { b(0.1, 0.2, 0.42, x, y, z, LAMP); b(0.1, 0.2, 0.42, x, y, -z, LAMP); };
  const tails = (x: number, y: number, z: number) => { b(0.08, 0.16, 0.4, x, y, z, TAIL); b(0.08, 0.16, 0.4, x, y, -z, TAIL); };

  switch (id) {
    case 'f1':
      b(5.0, 0.1, 1.5, 0, 0.22, 0, DARK);                 // floor
      b(2.6, 0.36, 0.52, 1.45, 0.47, 0, BODY);            // nose and tub
      b(0.9, 0.22, 0.34, 2.55, 0.36, 0, BODY);
      b(0.5, 0.07, 2.0, 2.85, 0.18, 0, BODY);             // front wing
      b(0.55, 0.26, 0.07, 2.85, 0.28, 0.98, DARK); b(0.55, 0.26, 0.07, 2.85, 0.28, -0.98, DARK);
      b(1.9, 0.44, 0.5, -0.35, 0.47, 0.56, BODY); b(1.9, 0.44, 0.5, -0.35, 0.47, -0.56, BODY); // sidepods
      b(2.3, 0.5, 0.62, -0.75, 0.72, 0, BODY);            // engine cover
      b(0.6, 0.42, 0.38, -0.15, 1.12, 0, BODY);           // airbox
      b(0.36, 0.3, 0.32, 0.38, 0.9, 0, '#ffd23d');        // helmet
      b(0.75, 0.07, 0.56, 0.5, 1.06, 0, DARK);            // halo
      b(0.12, 0.3, 0.1, 0.86, 0.9, 0, DARK);
      b(0.46, 0.08, 1.62, -2.48, 1.16, 0, BODY);          // rear wing
      b(0.62, 0.72, 0.07, -2.48, 0.86, 0.8, DARK); b(0.62, 0.72, 0.07, -2.48, 0.86, -0.8, DARK);
      b(0.1, 0.16, 0.26, -2.76, 0.62, 0, TAIL);           // rain light
      wheel(1.78, 0.95, 0.36, 0.4); wheel(1.78, -0.95, 0.36, 0.4); wheel(-1.6, 0.9, 0.4, 0.5); wheel(-1.6, -0.9, 0.4, 0.5);
      break;
    case 'proto':
      b(4.7, 0.5, 2.0, 0, 0.52, 0, BODY);
      b(0.9, 0.3, 2.0, 2.3, 0.4, 0, BODY);
      b(1.7, 0.46, 1.1, 0.25, 1.0, 0, GLASS);
      b(1.4, 0.08, 1.0, 0.15, 1.26, 0, BODY);
      b(1.9, 0.5, 0.08, -1.2, 1.1, 0, BODY);              // shark fin
      b(1.5, 0.3, 0.5, 0.3, 0.9, 0.78, BODY); b(1.5, 0.3, 0.5, 0.3, 0.9, -0.78, BODY); // wheel arches
      b(0.42, 0.07, 1.96, -2.25, 1.24, 0, BODY);
      b(0.5, 0.6, 0.07, -2.25, 1.0, 0.95, DARK); b(0.5, 0.6, 0.07, -2.25, 1.0, -0.95, DARK);
      lamps(2.46, 0.56, 0.78); tails(-2.38, 0.7, 0.8);
      wheels(1.5, -1.5, 0.92, 0.4, 0.42);
      break;
    case 'gt':
      b(4.5, 0.6, 1.95, 0, 0.6, 0, BODY);
      b(1.2, 0.3, 1.8, 1.6, 0.44, 0, BODY);
      b(0.4, 0.08, 2.05, 2.3, 0.26, 0, DARK);             // splitter
      b(1.9, 0.5, 1.56, -0.35, 1.14, 0, GLASS);
      b(1.5, 0.1, 1.46, -0.35, 1.42, 0, BODY);
      b(0.55, 0.1, 2.05, -2.1, 1.5, 0, BODY);             // wing
      b(0.14, 0.56, 0.14, -2.1, 1.2, 0.62, DARK); b(0.14, 0.56, 0.14, -2.1, 1.2, -0.62, DARK);
      lamps(2.28, 0.66, 0.68); tails(-2.27, 0.78, 0.72);
      wheels(1.42, -1.42, 0.98, 0.44, 0.42);
      break;
    case 'rally':
      b(4.0, 0.68, 1.8, 0, 0.72, 0, BODY);
      b(2.2, 0.62, 1.6, -0.3, 1.36, 0, GLASS);
      b(2.0, 0.1, 1.62, -0.3, 1.7, 0, BODY);
      b(0.45, 0.16, 0.45, 0.25, 1.82, 0, DARK);           // roof scoop
      b(0.32, 0.08, 1.74, -1.45, 1.86, 0, BODY);          // roof spoiler
      b(0.2, 0.3, 1.2, 2.06, 0.98, 0, DARK);              // lamp pod
      b(0.08, 0.24, 0.24, 2.18, 0.98, 0.42, LAMP); b(0.08, 0.24, 0.24, 2.18, 0.98, -0.42, LAMP); b(0.08, 0.24, 0.24, 2.18, 0.98, 0.14, LAMP); b(0.08, 0.24, 0.24, 2.18, 0.98, -0.14, LAMP);
      b(0.06, 0.36, 0.42, -1.72, 0.42, 0.72, DARK); b(0.06, 0.36, 0.42, -1.72, 0.42, -0.72, DARK); // mud flaps
      lamps(2.02, 0.76, 0.62); tails(-2.02, 0.95, 0.66);
      wheels(1.28, -1.28, 0.92, 0.46, 0.38);
      break;
    case 'muscle':
      b(4.9, 0.6, 2.0, 0, 0.64, 0, BODY);
      b(1.5, 0.16, 0.7, 1.35, 1.0, 0, DARK);              // bonnet scoop
      b(1.75, 0.52, 1.7, -0.7, 1.2, 0, GLASS);
      b(1.45, 0.1, 1.6, -0.7, 1.5, 0, BODY);
      b(0.4, 0.14, 1.9, -2.3, 1.0, 0, BODY);              // ducktail
      b(0.1, 0.3, 1.5, 2.46, 0.66, 0, DARK);              // grille
      lamps(2.48, 0.68, 0.76); tails(-2.47, 0.74, 0.74);
      wheels(1.55, -1.5, 1.0, 0.46, 0.44);
      break;
    case 'hatch':
      b(3.9, 0.66, 1.78, 0, 0.68, 0, BODY);
      b(2.3, 0.62, 1.58, -0.45, 1.32, 0, GLASS);
      b(2.1, 0.1, 1.6, -0.45, 1.66, 0, BODY);
      b(0.3, 0.08, 1.6, -1.6, 1.74, 0, DARK);
      lamps(1.98, 0.72, 0.62); tails(-1.97, 0.92, 0.64);
      wheels(1.25, -1.25, 0.9, 0.42, 0.36);
      break;
    default: // saloon
      b(4.6, 0.62, 1.8, 0, 0.66, 0, BODY);
      b(2.4, 0.58, 1.6, -0.2, 1.24, 0, GLASS);
      b(1.9, 0.1, 1.56, -0.2, 1.56, 0, BODY);
      b(0.1, 0.2, 1.2, 2.31, 0.6, 0, DARK);
      lamps(2.32, 0.7, 0.64); tails(-2.32, 0.8, 0.66);
      wheels(1.45, -1.45, 0.9, 0.42, 0.36);
  }
  const m = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return m;
}

/** One wheel: radius 1, width 1, axle along z. Scaled per car; spokes make its turning visible. */
export function wheelGeometry(): THREE.BufferGeometry {
  const paint = (g0: THREE.BufferGeometry, v: number, flat: boolean) => {
    const g = g0.toNonIndexed(); g.deleteAttribute('uv');
    if (flat) g.computeVertexNormals();
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(v), 3));
    return g;
  };
  const parts = [
    paint(new THREE.CylinderGeometry(1, 1, 1, 20).rotateX(Math.PI / 2), 0.02, false),          // tyre
    paint(new THREE.CylinderGeometry(0.66, 0.66, 1.03, 16).rotateX(Math.PI / 2), 0.09, false),  // rim well
    paint(new THREE.BoxGeometry(1.24, 0.17, 1.06), 0.55, true), paint(new THREE.BoxGeometry(0.17, 1.24, 1.06), 0.55, true), // spokes
    paint(new THREE.CylinderGeometry(0.2, 0.2, 1.1, 10).rotateX(Math.PI / 2), 0.7, false),      // hub
  ];
  const m = mergeGeometries(parts)!;
  parts.forEach((q) => q.dispose());
  return m;
}
