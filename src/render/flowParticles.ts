/**
 * Flow particles: 600 points advected along the centerline at a speed set by
 * the 1D flow profile, scattered across the lumen, coloured slow-blue to
 * fast-red. A visual of `flow1d.ts`, not a simulation of its own.
 */

import * as THREE from 'three';

import { cross, normalize, worldToObject, type Frame } from '../coords.ts';
import type { Centerline } from '../devices/centerline.ts';
import { velocityAt, type FlowProfile } from '../devices/flow1d.ts';
import type { Vec3 } from '../types.ts';

const N = 600;
/** Visual speed of blood at the median radius, in mm per second. */
const BASE_SPEED = 55;

const SLOW = new THREE.Color(0x3b82f6);
const MID = new THREE.Color(0x58e5c8);
const FAST = new THREE.Color(0xff4d4d);

export class FlowParticles {
  readonly points: THREE.Points;
  private s = new Float32Array(N);
  private theta = new Float32Array(N);
  private rho = new Float32Array(N);
  private cl: Centerline | null = null;
  private frame: Frame | null = null;
  private flow: FlowProfile | null = null;
  private tmp = new THREE.Color();

  constructor(rig: THREE.Group) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    this.points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: 2.6,
        sizeAttenuation: false,
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.points.renderOrder = 13;
    this.points.frustumCulled = false;
    this.points.visible = false;
    rig.add(this.points);
  }

  setCenterline(cl: Centerline | null, f: Frame | null): void {
    this.cl = cl;
    this.frame = f;
    if (!cl) return;
    // Deterministic scatter so the screenshot harness and the demo match.
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < N; i++) {
      this.s[i] = rnd() * cl.length;
      this.theta[i] = rnd() * Math.PI * 2;
      this.rho[i] = Math.sqrt(rnd()) * 0.85;
    }
  }

  setFlow(flow: FlowProfile | null): void {
    this.flow = flow;
  }

  update(dtS: number, visible: boolean): void {
    const cl = this.cl;
    const f = this.frame;
    const flow = this.flow;
    this.points.visible = visible && !!cl && !!flow;
    if (!this.points.visible || !cl || !f || !flow) return;

    const pos = this.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = this.points.geometry.getAttribute('color') as THREE.BufferAttribute;
    const L = cl.length;

    for (let i = 0; i < N; i++) {
      const v = velocityAt(flow, this.s[i]);
      this.s[i] += v * BASE_SPEED * dtS;
      if (this.s[i] > L) this.s[i] -= L;

      const s = this.s[i];
      const c = cl.pointAt(s);
      const t = cl.tangentAt(s);
      // Any vector not parallel to the tangent seeds the cross-section basis.
      const seed: Vec3 = Math.abs(t[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      const u = normalize(cross(t, seed));
      const w = cross(t, u);
      // Inside a stent the lumen is the device's, which flow1d already knows.
      const r = flow.r[Math.min(flow.r.length - 1, Math.round(s))] * this.rho[i];
      const ct = Math.cos(this.theta[i]) * r;
      const st = Math.sin(this.theta[i]) * r;
      const p = worldToObject(f, [
        c[0] + u[0] * ct + w[0] * st,
        c[1] + u[1] * ct + w[1] * st,
        c[2] + u[2] * ct + w[2] * st,
      ]);
      pos.setXYZ(i, p[0], p[1], p[2]);

      // 1 = typical speed (teal); slower shades blue, faster red.
      const k = Math.log2(v);
      if (k >= 0) this.tmp.copy(MID).lerp(FAST, Math.min(1, k / 1.5));
      else this.tmp.copy(MID).lerp(SLOW, Math.min(1, -k / 0.8));
      col.setXYZ(i, this.tmp.r, this.tmp.g, this.tmp.b);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }
}
