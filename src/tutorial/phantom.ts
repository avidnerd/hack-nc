/**
 * The tutorial's practice object: a simple, obviously artificial "organ"
 * (an ellipsoid) with a "tumour" sphere inside and a "vessel" tube beside it,
 * built in memory as an ordinary CaseData with real surface meshes.
 *
 * Because it is a normal case, practising runs through exactly the same
 * gesture layer, cut, caliper and planning engine as a real scan: what you
 * learn here is what happens on the CT. It is only ever used for the
 * tutorial and is labelled as practice everywhere it appears.
 */

import * as THREE from 'three';

import { HU_CURVE, WINDOW_PRESETS, huToU8 } from '../io/volumeCase.ts';
import type { CaseData, LabelDef, MeshEntry, Vec3 } from '../types.ts';

const N = 112;
const SP = 1.5;
const C = ((N - 1) * SP) / 2;

const ORGAN = { r: [62, 46, 40] as Vec3 };
const TUMOR = { c: [C + 24, C - 6, C + 8] as Vec3, r: 13 };
const VESSEL = { x: C - 8, y: C + 20, r: 5 };

export const PRACTICE_LABELS: LabelDef[] = [
  { id: 1, key: 'liver', name: 'Practice organ', color: [0.74, 0.42, 0.36], role: 'organ' },
  { id: 2, key: 'tumor', name: 'Practice tumour', color: [1.0, 0.36, 0.2], role: 'tumor' },
  { id: 4, key: 'portal_vein', name: 'Practice vessel', color: [0.34, 0.82, 0.78], role: 'vessel' },
];

/** Deterministic texture so the cut face looks like tissue, not flat grey. */
function grain(i: number, j: number, k: number): number {
  const h = Math.sin(i * 12.9898 + j * 78.233 + k * 37.719) * 43758.5453;
  return h - Math.floor(h);
}

export function makePhantom(): CaseData {
  const volume = new Uint8Array(N * N * N);
  const labels = new Uint8Array(N * N * N);
  for (let k = 0; k < N; k++) {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = i * SP;
        const y = j * SP;
        const z = k * SP;
        const idx = i + N * (j + N * k);
        const e = ((x - C) / ORGAN.r[0]) ** 2 + ((y - C) / ORGAN.r[1]) ** 2 + ((z - C) / ORGAN.r[2]) ** 2;
        const t = Math.hypot(x - TUMOR.c[0], y - TUMOR.c[1], z - TUMOR.c[2]);
        const v = Math.hypot(x - VESSEL.x, y - VESSEL.y);
        let hu = -1000;
        let id = 0;
        if (v <= VESSEL.r && Math.abs(z - C) < 70) {
          hu = 170;
          id = 4;
        } else if (t <= TUMOR.r) {
          hu = 25 + 10 * grain(i, j, k);
          id = 2;
        } else if (e <= 1) {
          hu = 55 + 14 * grain(i, j, k);
          id = 1;
        }
        volume[idx] = huToU8(hu);
        labels[idx] = id;
      }
    }
  }

  // Surface meshes in world mm, from plain three.js primitives.
  const parts: { key: string; label: number; geo: THREE.BufferGeometry }[] = [];
  const organ = new THREE.SphereGeometry(1, 64, 40);
  organ.scale(...ORGAN.r);
  organ.translate(C, C, C);
  parts.push({ key: 'liver', label: 1, geo: organ });
  const tumor = new THREE.SphereGeometry(TUMOR.r, 40, 28);
  tumor.translate(...TUMOR.c);
  parts.push({ key: 'tumor', label: 2, geo: tumor });
  const vessel = new THREE.CylinderGeometry(VESSEL.r, VESSEL.r, 140, 28, 1, false);
  vessel.rotateX(Math.PI / 2);
  vessel.translate(VESSEL.x, VESSEL.y, C);
  parts.push({ key: 'portal_vein', label: 4, geo: vessel });

  const entries: MeshEntry[] = [];
  const pos: number[] = [];
  const ind: number[] = [];
  for (const p of parts) {
    const g = p.geo;
    const P = g.getAttribute('position').array as Float32Array;
    const I = g.index!.array;
    entries.push({ key: p.key, label: p.label, vertexOffset: pos.length / 3, vertexCount: P.length / 3, indexOffset: ind.length, indexCount: I.length });
    for (const x of P) pos.push(x);
    for (const x of I) ind.push(x);
    g.dispose();
  }

  return {
    meta: {
      id: 'practice',
      name: 'Practice object (not a patient)',
      kind: 'liver',
      shape: [N, N, N],
      spacing: [SP, SP, SP],
      origin: [0, 0, 0],
      huRange: [-1000, 2000],
      huCurve: HU_CURVE,
      labels: PRACTICE_LABELS,
      vesselIds: [4],
      windowPresets: WINDOW_PRESETS,
      defaultPreset: 'soft',
    },
    volume,
    labels,
    centerlines: null,
    meshes: { entries, positions: new Float32Array(pos), indices: new Uint32Array(ind) },
  };
}
