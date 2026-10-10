/**
 * Applies stable gestures to the app.
 *
 *   OPEN hand      cut: the plane takes the palm's orientation and passes
 *                  through the point under the hand on screen, at the organ's
 *                  depth; moving the hand toward the camera pushes it deeper
 *   PINCH + drag   rotate (grab the body and turn it), or drag a placed stent
 *   two PINCHes    zoom by pulling the hands apart / together
 *   two POINTs     caliper
 *   FIST           lock / unlock (locking lifts the resected piece away)
 *
 * Everything is mapped to where the hand IS on screen (the HUD draws a cursor
 * there), so what you see is what you cut. While locked, a returning hand
 * changes nothing until the cut is unlocked.
 */

import {
  add,
  cameraBasis,
  clamp,
  dot,
  normalize,
  scale,
  sub,
  type Frame,
} from '../coords.ts';
import { snapCaliper } from '../planning/smartMeasure.ts';
import { patch, set, state } from '../state.ts';
import type { Pose, Vec3 } from '../types.ts';
import type { GestureFrame, TrackedHand } from './gestures.ts';
import { OneEuro, OneEuroVec } from './oneEuro.ts';
import { TUNING } from './tuning.ts';

export interface HandHooks {
  frame: () => Frame | null;
  /** Where the cut is anchored in depth (the organ centroid). */
  pivot: () => Vec3 | null;
  /** Camera ray through a screen pixel, in world mm. */
  ray: (xPx: number, yPx: number) => { o: Vec3; d: Vec3 } | null;
  /** Screen pixel to world mm on the plane / volume surface. */
  pick: (xPx: number, yPx: number) => Vec3 | null;
  setMoving: (moving: boolean) => void;
  stentHit: (xPx: number, yPx: number) => boolean;
  stentDrag: (xPx: number, yPx: number) => void;
  onLock: (locked: boolean) => void;
}

const RAD = 180 / Math.PI;

export class HandController {
  private pose: Pose = 'IDLE';
  private normalF = new OneEuroVec(3, TUNING.normalFilter);
  private pointF = new OneEuroVec(3, TUNING.landmarkFilter);
  private depthF = new OneEuro(TUNING.depthFilter);
  private hsEntry = 0;

  private prevUv: [number, number] | null = null;
  private rotVel = { yaw: 0, pitch: 0 };
  private dragStent = false;
  private zoom: { gap0: number; dist0: number } | null = null;

  constructor(private readonly hooks: HandHooks) {}

  update(g: GestureFrame, tMs: number): void {
    const entering = g.pose !== this.pose;
    if (entering) this.leave(this.pose);
    this.pose = g.pose;

    const h = state.hands;
    if (h.left !== g.left || h.right !== g.right || h.pose !== g.pose) {
      set('hands', { left: g.left, right: g.right, pose: g.pose });
    }
    // The HUD's on-screen hand cursor.
    const lead = this.primary(g);
    set('cursor', lead ? { x: lead.obs.uv[0], y: lead.obs.uv[1], pose: g.pose } : null);

    const steady = !!lead && lead.raw === lead.pose;
    switch (g.pose) {
      case 'OPEN':
        if (lead && steady) this.cut(lead, entering, tMs);
        break;
      case 'PINCH': {
        const pinching = g.hands.filter((x) => x.raw === 'PINCH');
        if (pinching.length === 2) this.twoHandZoom(pinching, entering || !this.zoom);
        else if (lead && steady) this.grab(lead, entering);
        break;
      }
      case 'CALIPER':
        this.caliper(g.hands);
        break;
      case 'FIST':
        if (entering) {
          const locked = !state.plane.locked;
          patch('plane', { locked });
          this.hooks.onLock(locked);
        }
        break;
      case 'LOST':
      case 'IDLE':
        break;
    }

    // A released grab keeps turning briefly and settles, like a real object,
    // but only while the hand is idle: a new gesture stops it dead, so the
    // body never drifts under a cut.
    if (g.pose !== 'IDLE' && g.pose !== 'LOST' && g.pose !== 'PINCH') this.rotVel = { yaw: 0, pitch: 0 };
    if (g.pose !== 'PINCH' && (this.rotVel.yaw !== 0 || this.rotVel.pitch !== 0)) {
      this.applyRotation();
      this.rotVel.yaw *= TUNING.rotationDamping;
      this.rotVel.pitch *= TUNING.rotationDamping;
      if (Math.abs(this.rotVel.yaw) + Math.abs(this.rotVel.pitch) < 1e-4) this.rotVel = { yaw: 0, pitch: 0 };
    }

    this.hooks.setMoving(g.pose === 'OPEN' || g.pose === 'PINCH');
  }

  private leave(pose: Pose): void {
    if (pose === 'OPEN') {
      this.normalF.reset();
      this.pointF.reset();
      this.depthF.reset();
    }
    if (pose === 'PINCH') {
      this.prevUv = null;
      this.dragStent = false;
      this.zoom = null;
    }
  }

  private primary(g: GestureFrame): TrackedHand | null {
    return g.hands.find((h) => h.pose === g.pose) ?? g.hands[0] ?? null;
  }

  /* ------------------------------------------------------------------- cut */

  private cut(hand: TrackedHand, entering: boolean, tMs: number): void {
    if (state.plane.locked) return;
    const f = this.hooks.frame();
    if (!f) return;
    const c = state.camera;
    const { right, up, forward } = cameraBasis(c.yaw + c.headYaw, c.pitch + c.headPitch);

    // Orientation: the palm's normal, turned to face the viewer so the near
    // side is cut away and you look straight at the cut face.
    let nv = hand.f.normal;
    if (nv[2] < 0) nv = scale(nv, -1);
    const nf = this.normalF.filter(scale(nv, RAD), tMs);
    const nView = normalize([nf[0], nf[1], nf[2]]);
    const n = normalize(add(add(scale(right, nView[0]), scale(up, nView[1])), scale(forward, -nView[2])));

    // Position: the point under the hand, at the organ's depth...
    const pivot = this.hooks.pivot() ?? f.centerMm;
    const ray = this.hooks.ray(hand.obs.uv[0] * window.innerWidth, hand.obs.uv[1] * window.innerHeight);
    if (!ray) return;
    const denom = dot(ray.d, forward);
    const t = Math.abs(denom) > 1e-6 ? dot(sub(pivot, ray.o), forward) / denom : 0;
    const under = add(ray.o, scale(ray.d, t));

    // ...pushed deeper as the hand moves toward the camera (§6.2: hand size
    // as the depth proxy), measured from where the hand was when it opened.
    if (entering || this.hsEntry === 0) this.hsEntry = hand.f.hs;
    const depthRaw =
      clamp(TUNING.depthGain * Math.log(hand.f.hs / this.hsEntry), -TUNING.depthClamp, TUNING.depthClamp) * f.maxExtent;
    const depth = this.depthF.filter(depthRaw, tMs);
    const pf = this.pointF.filter(add(under, scale(forward, depth)), tMs);
    const p: Vec3 = [pf[0], pf[1], pf[2]];

    patch('plane', { on: true, n, d: dot(n, p) });
  }

  /* ------------------------------------------------------- grab and rotate */

  private grab(hand: TrackedHand, entering: boolean): void {
    const uv = hand.obs.pinchUv;
    const px = uv[0] * window.innerWidth;
    const py = uv[1] * window.innerHeight;
    if (entering || !this.prevUv) {
      this.prevUv = [uv[0], uv[1]];
      this.dragStent = this.hooks.stentHit(px, py);
      return;
    }
    if (this.dragStent) {
      if (!state.plane.locked) this.hooks.stentDrag(px, py);
      return;
    }
    const du = uv[0] - this.prevUv[0];
    const dv = uv[1] - this.prevUv[1];
    this.prevUv = [uv[0], uv[1]];
    const dz = TUNING.rotationDeadzone;
    // Same direction as a mouse drag: the body turns the way the hand moves.
    this.rotVel.yaw = Math.abs(du) > dz ? -du * TUNING.rotationPerScreen : 0;
    this.rotVel.pitch = Math.abs(dv) > dz ? dv * TUNING.rotationPerScreen * 0.75 : 0;
    this.applyRotation();
  }

  private applyRotation(): void {
    const c = state.camera;
    patch('camera', {
      yaw: c.yaw + this.rotVel.yaw,
      pitch: clamp(c.pitch + this.rotVel.pitch, -1.45, 1.45),
    });
  }

  private twoHandZoom(hands: TrackedHand[], start: boolean): void {
    const [a, b] = hands;
    const gap = Math.hypot(a.obs.pinchUv[0] - b.obs.pinchUv[0], a.obs.pinchUv[1] - b.obs.pinchUv[1]);
    if (start || !this.zoom) {
      this.zoom = { gap0: Math.max(gap, 0.02), dist0: state.camera.dist };
      this.rotVel = { yaw: 0, pitch: 0 };
      return;
    }
    // Hands apart = closer, like stretching a photo.
    const floor = Math.min(TUNING.zoomMin, this.zoom.dist0); // copilot may have framed closer
    const dist = clamp(this.zoom.dist0 * Math.pow(this.zoom.gap0 / Math.max(gap, 0.02), TUNING.zoomGain), floor, TUNING.zoomMax);
    patch('camera', { dist });
  }

  /* --------------------------------------------------------------- caliper */

  private caliper(hands: TrackedHand[]): void {
    if (hands.length < 2) return;
    const pts = hands.map((h) =>
      this.hooks.pick(h.obs.indexUv[0] * window.innerWidth, h.obs.indexUv[1] * window.innerHeight),
    );
    const [a, b] = pts;
    if (!a || !b) return;
    // Ends within a few mm of a wall or landmark land on it, and the reading
    // names what it spans.
    if (state.data) set('caliper', snapCaliper(state.data, a, b));
    else set('caliper', { a, b, mm: Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) });
  }
}
