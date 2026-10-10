/**
 * The renal artery origins on the aorta, drawn: the landmark every
 * infrarenal stent decision is measured from. A dot and a name tag per
 * ostium, red while the graft covers it, so "Right renal artery covered" has
 * something on screen to point at.
 */

import * as THREE from 'three';

import { worldToObject, type Frame } from '../coords.ts';
import type { Centerline } from '../devices/centerline.ts';
import type { Ostium } from '../devices/stent.ts';
import { state } from '../state.ts';
import type { Vec3 } from '../types.ts';

const OK = 0xffd166;
const COVERED = 0xff5a5f;

export class RenalMarkers {
  private readonly dots: THREE.Points;
  private tags: { el: HTMLElement; o: Ostium; p: Vec3 }[] = [];

  constructor(
    rig: THREE.Group,
    private readonly project: (p: Vec3) => { x: number; y: number; behind: boolean } | null,
  ) {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(16, 16, 14, 0, Math.PI * 2);
    g.fill();
    this.dots = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({
        size: 11,
        map: new THREE.CanvasTexture(c),
        alphaTest: 0.5,
        vertexColors: true,
        sizeAttenuation: false,
        depthTest: false,
        transparent: true,
      }),
    );
    this.dots.renderOrder = 12;
    rig.add(this.dots);
  }

  set(cl: Centerline | null, ostia: Ostium[], f: Frame): void {
    for (const t of this.tags) t.el.remove();
    this.tags = [];
    this.dots.visible = false;
    if (!cl || ostia.length === 0) return;
    const pts = ostia.map((o) => cl.pointAt(o.s));
    const pos = new Float32Array(pts.length * 3);
    pts.forEach((p, i) => pos.set(worldToObject(f, p), i * 3));
    this.dots.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dots.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pts.length * 3), 3));
    this.dots.geometry.computeBoundingSphere();
    this.tags = ostia.map((o, i) => {
      const el = document.createElement('div');
      el.className = 'renal-tag';
      el.textContent = `${o.side === 'left' ? 'L' : 'R'} renal artery`;
      el.hidden = true;
      document.body.append(el);
      return { el, o, p: pts[i] };
    });
  }

  /** Per frame: visibility, covered colouring, tags follow the camera. */
  update(show: boolean): void {
    const visible = show && this.tags.length > 0 && state.visible.aorta !== false;
    this.dots.visible = visible;
    const st = state.stent;
    const col = this.dots.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    this.tags.forEach((t, i) => {
      const covered = !!st && t.o.s >= st.s0 && t.o.s <= st.s0 + st.lengthMm;
      if (col) {
        const c = new THREE.Color(covered ? COVERED : OK);
        col.setXYZ(i, c.r, c.g, c.b);
      }
      t.el.classList.toggle('covered', covered);
      const s = visible ? this.project(t.p) : null;
      if (!s || s.behind) {
        t.el.hidden = true;
        return;
      }
      t.el.hidden = false;
      // Left renal tags sit to the screen-right of the dot (anterior view
      // shows the patient's left on screen-right), right renal to the left.
      // The left tag also rides above its dot, clear of the stent's verdict
      // label, which sits to the right of the graft.
      const dx = t.o.side === 'left' ? '14px' : 'calc(-100% - 14px)';
      const dy = t.o.side === 'left' ? '-180%' : '-50%';
      t.el.style.transform = `translate(${s.x}px, ${s.y}px) translate(${dx}, ${dy})`;
    });
    if (col) col.needsUpdate = true;
  }
}
