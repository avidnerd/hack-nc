/**
 * The stent graft as drawn: a lattice tube along the centerline segment it
 * covers, teal when it seals and red when it does not, with a deploy
 * animation that unrolls it from the proximal end.
 */

import * as THREE from 'three';

import { clamp, easeInOut, worldToObject, type Frame } from '../coords.ts';
import type { Centerline } from '../devices/centerline.ts';
import type { StentState, Vec3 } from '../types.ts';

const TEAL = new THREE.Color(0x58e5c8);
const RED = new THREE.Color(0xff5f56);
const DEPLOY_MS = 800;

/** A THREE curve that follows the centerline over [s0, s1], in object space. */
class SegmentCurve extends THREE.Curve<THREE.Vector3> {
  constructor(
    private readonly cl: Centerline,
    private readonly f: Frame,
    private readonly s0: number,
    private readonly s1: number,
  ) {
    super();
  }

  override getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const p = worldToObject(this.f, this.cl.pointAt(this.s0 + (this.s1 - this.s0) * t));
    return target.set(p[0], p[1], p[2]);
  }
}

export class StentMesh {
  readonly group = new THREE.Group();
  private lattice: THREE.LineSegments | null = null;
  private fill: THREE.Mesh | null = null;
  private label: HTMLElement;

  private cl: Centerline | null = null;
  private frame: Frame | null = null;
  private stent: StentState | null = null;
  private deployStart = 0;
  private color = TEAL.clone();
  private builtKey = '';

  constructor(
    rig: THREE.Group,
    private readonly project: (p: Vec3) => { x: number; y: number; behind: boolean } | null,
  ) {
    rig.add(this.group);
    this.label = document.createElement('div');
    this.label.className = 'stent-label';
    this.label.hidden = true;
    document.body.append(this.label);
  }

  setCenterline(cl: Centerline | null, f: Frame | null): void {
    this.cl = cl;
    this.frame = f;
    this.set(null);
  }

  /** Show, move or remove the stent. A new stent replays the deploy animation. */
  set(stent: StentState | null): void {
    const fresh = !!stent && !this.stent;
    this.stent = stent;
    if (fresh) this.deployStart = performance.now();
    if (!stent) {
      this.clear();
      this.label.hidden = true;
    }
  }

  /** Centerline samples the stent currently covers, for pinch hit-testing. */
  coveredPoints(step = 5): Vec3[] {
    const st = this.stent;
    const cl = this.cl;
    if (!st || !cl) return [];
    const out: Vec3[] = [];
    for (let s = st.s0; s <= st.s0 + st.lengthMm; s += step) out.push(cl.pointAt(s));
    return out;
  }

  update(visible: boolean): void {
    const st = this.stent;
    const cl = this.cl;
    const f = this.frame;
    this.group.visible = visible && !!st;
    if (!st || !cl || !f) return;

    const t = easeInOut(clamp((performance.now() - this.deployStart) / DEPLOY_MS, 0, 1));
    const len = Math.max(2, st.lengthMm * t);
    const key = `${st.s0.toFixed(2)}|${len.toFixed(2)}|${st.diameterMm.toFixed(2)}`;
    if (key !== this.builtKey) {
      this.build(cl, f, st.s0, st.s0 + len, st.diameterMm / 2);
      this.builtKey = key;
    }

    // Colour eases toward the verdict so a rule flipping reads as a change.
    this.color.lerp(st.seals ? TEAL : RED, 0.18);
    (this.lattice?.material as THREE.LineBasicMaterial | undefined)?.color.copy(this.color);
    (this.fill?.material as THREE.MeshBasicMaterial | undefined)?.color.copy(this.color);

    const s = this.project(cl.pointAt(st.s0));
    if (s && !s.behind && visible && t > 0.95) {
      this.label.hidden = false;
      this.label.classList.toggle('bad', !st.seals);
      this.label.textContent = st.seals
        ? `Neck ${Math.round(st.neckMm)} mm · ø${st.diameterMm.toFixed(0)} mm · seals`
        : (st.failReason ?? "Won't seal");
      this.label.style.transform = `translate(${s.x + 18}px, ${s.y}px) translate(0, -50%)`;
    } else {
      this.label.hidden = true;
    }
  }

  private build(cl: Centerline, f: Frame, s0: number, s1: number, rMm: number): void {
    this.clear();
    const curve = new SegmentCurve(cl, f, s0, s1);
    const segs = Math.max(4, Math.round((s1 - s0) / 4));
    const radius = rMm / f.maxExtent;

    const tube = new THREE.TubeGeometry(curve, segs, radius, 14, false);
    // The wireframe of a tube is a diamond-ish lattice, which reads as a
    // braided stent at this size.
    const wire = new THREE.WireframeGeometry(tube);
    this.lattice = new THREE.LineSegments(
      wire,
      new THREE.LineBasicMaterial({
        color: this.color,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
      }),
    );
    this.lattice.renderOrder = 12;

    this.fill = new THREE.Mesh(
      tube,
      new THREE.MeshBasicMaterial({
        color: this.color,
        transparent: true,
        opacity: 0.14,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.fill.renderOrder = 11;
    this.group.add(this.fill, this.lattice);
  }

  private clear(): void {
    for (const o of [this.lattice, this.fill]) {
      if (!o) continue;
      this.group.remove(o);
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
    this.lattice = null;
    this.fill = null;
    this.builtKey = '';
  }
}
