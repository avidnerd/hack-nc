/**
 * Everything that happens to the stent in one case: placing it, dragging and
 * nudging it, optimizing it, and keeping the drawn mesh, the flow particles,
 * the HUD and the spoken verdict in step with the deterministic rules.
 */

import type * as THREE from 'three';

import { clamp, easeInOut, type Frame } from '../coords.ts';
import { FlowParticles } from '../render/flowParticles.ts';
import { RenalMarkers } from '../render/renalMarkers.ts';
import { StentMesh } from '../render/stentMesh.ts';
import { say, set, state } from '../state.ts';
import type { CaseData, StentState, Vec3 } from '../types.ts';
import { Centerline } from './centerline.ts';
import { flowProfile } from './flow1d.ts';
import {
  evaluateStent,
  maxStart,
  optimizeStent,
  ostiaOnCenterline,
  placeStent,
  preferredStart,
  sizeAt,
  STENT_LENGTH_MM,
  type Ostium,
} from './stent.ts';

type Project = (p: Vec3) => { x: number; y: number; behind: boolean } | null;

/** Where a fresh stent sits when the case has no renal ostia to seat below. */
const FALLBACK_S0 = 30;
const GRAB_PX = 90;

export class StentSession {
  private cl: Centerline | null = null;
  private ostia: Ostium[] = [];
  private kind: CaseData['meta']['kind'] = 'liver';
  private readonly mesh: StentMesh;
  private readonly particles: FlowParticles;
  private readonly renals: RenalMarkers;
  private grabOffset = 0;
  private anim: { from: number; to: number; start: number } | null = null;

  constructor(
    rig: THREE.Group,
    private readonly project: Project,
  ) {
    this.mesh = new StentMesh(rig, project);
    this.particles = new FlowParticles(rig);
    this.renals = new RenalMarkers(rig, project);
  }

  get available(): boolean {
    return this.cl !== null;
  }

  get centerline(): Centerline | null {
    return this.cl;
  }

  /** Renal ostia as arc lengths on the centerline (for the agent's rule breakdown). */
  get renalOstia(): Ostium[] {
    return this.ostia;
  }

  setCase(data: CaseData, f: Frame): void {
    const pts = data.centerlines?.vessels.aorta;
    this.cl = pts && pts.length > 1 ? new Centerline(pts) : null;
    this.ostia = this.cl && data.centerlines ? ostiaOnCenterline(this.cl, data.centerlines.renalOstia) : [];
    this.kind = data.meta.kind;
    this.mesh.setCenterline(this.cl, f);
    this.particles.setCenterline(this.cl, f);
    this.renals.set(this.kind === 'aorta' ? this.cl : null, this.ostia, f);
    this.anim = null;
    this.apply(null);
  }

  /** Per frame. */
  update(dtS: number): void {
    if (this.anim && state.stent) {
      const t = clamp((performance.now() - this.anim.start) / 800, 0, 1);
      const s0 = this.anim.from + (this.anim.to - this.anim.from) * easeInOut(t);
      this.moveTo(s0, false);
      if (t >= 1) this.anim = null;
    }
    const surgeon = state.mode === 'surgeon';
    this.mesh.update(true);
    this.renals.update(this.kind === 'aorta' && surgeon);
    // Flow is the aorta case's story; in the liver case it only appears once
    // someone actually puts a device in.
    const showFlow = this.kind === 'aorta' && (surgeon || !!state.stent);
    this.particles.update(dtS, showFlow && state.visible.aorta !== false);
  }

  /* --------------------------------------------------------------- intents */

  place(): void {
    // The stent graft treats the abdominal aorta; it has no place in a liver
    // resection, so the liver case points at the right case instead.
    if (this.kind !== 'aorta') {
      say('Stent grafts are for the aorta. Say: load the aorta case.');
      return;
    }
    if (!this.cl) {
      say('No vessel to stent in this case.');
      return;
    }
    const st = placeStent(this.cl, this.ostia, preferredStart(this.ostia, FALLBACK_S0));
    this.apply(st);
    say(
      st.seals
        ? `Placed. Neck ${Math.round(st.neckMm)} millimeters. Seals.`
        : `Placed. Won't seal. ${st.failReason}.`,
    );
  }

  /**
   * The agent's place_stent: with no s0, exactly the spoken "place the stent";
   * with s0, the device sized for that seat and left there, sealing or not.
   */
  placeAt(s0?: number, lengthMm = STENT_LENGTH_MM): StentState | null {
    if (this.kind !== 'aorta' || !this.cl) return null;
    const len = clamp(lengthMm, 20, this.cl.length);
    let st: StentState;
    if (s0 === undefined) {
      st = placeStent(this.cl, this.ostia, preferredStart(this.ostia, FALLBACK_S0), len);
    } else {
      const at = clamp(s0, 0, maxStart(this.cl, len));
      st = evaluateStent(this.cl, this.ostia, at, sizeAt(this.cl, at), len);
    }
    this.anim = null;
    this.apply(st);
    say(st.seals ? `Placed. Neck ${Math.round(st.neckMm)} millimeters. Seals.` : `Placed. Won't seal. ${st.failReason}.`);
    return st;
  }

  /** Put a saved stent back exactly (restoring a plan); null removes it. */
  restore(st: StentState | null): void {
    this.anim = null;
    this.apply(st && this.cl ? st : null);
  }

  /** Drop the device without a spoken line (reset, case switch). */
  clear(): void {
    this.anim = null;
    this.apply(null);
  }

  remove(): void {
    if (!state.stent) {
      say('No stent to remove.');
      return;
    }
    this.apply(null);
    say('Stent removed.');
  }

  nudge(mm: number): void {
    if (!state.stent || state.plane.locked) return;
    this.moveTo(state.stent.s0 + mm, true);
  }

  /** "Optimize" while a stent is placed: nearest sealing seat for this device. */
  optimize(): void {
    const st = state.stent;
    if (!st || !this.cl) return;
    if (st.seals) {
      say(`Already seals. Neck ${Math.round(st.neckMm)} millimeters.`);
      return;
    }
    const res = optimizeStent(this.cl, this.ostia, st);
    if (!res.stent) {
      say(`No seal within 40 millimeters. ${res.blocker ?? 'No position passes every rule'}.`);
      return;
    }
    const dir = res.movedMm < 0 ? 'up' : 'down';
    this.anim = { from: st.s0, to: res.stent.s0, start: performance.now() };
    say(
      `Optimized. Moved ${Math.abs(Math.round(res.movedMm))} millimeters ${dir}. ` +
        `Neck ${Math.round(res.stent.neckMm)} millimeters. Seals.`,
    );
  }

  /* ------------------------------------------------------------ pinch drag */

  /** True when (x, y) is within grabbing distance of the stent on screen. */
  hit(x: number, y: number): boolean {
    const st = state.stent;
    if (!st || !this.cl) return false;
    let best = Infinity;
    let bestS = st.s0;
    for (let s = st.s0; s <= st.s0 + st.lengthMm; s += 4) {
      const p = this.project(this.cl.pointAt(s));
      if (!p || p.behind) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < best) {
        best = d;
        bestS = s;
      }
    }
    if (best > GRAB_PX) return false;
    this.grabOffset = bestS - st.s0;
    return true;
  }

  /** Slide the stent so the grabbed point follows the pinch along the vessel. */
  drag(x: number, y: number): void {
    const st = state.stent;
    if (!st || !this.cl) return;
    let best = Infinity;
    let bestS = 0;
    for (let s = 0; s <= this.cl.length; s += 2) {
      const p = this.project(this.cl.pointAt(s));
      if (!p || p.behind) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < best) {
        best = d;
        bestS = s;
      }
    }
    this.moveTo(bestS - this.grabOffset, true);
  }

  /* -------------------------------------------------------------- internals */

  /**
   * Re-seat the current device at s0 (same diameter: the surgeon is moving a
   * chosen graft, not picking a new one) and announce verdict changes.
   */
  private moveTo(s0: number, announce: boolean): void {
    const st = state.stent;
    if (!st || !this.cl) return;
    const next = evaluateStent(
      this.cl,
      this.ostia,
      clamp(s0, 0, maxStart(this.cl, st.lengthMm)),
      st.diameterMm,
      st.lengthMm,
    );
    if (Math.abs(next.s0 - st.s0) < 0.25) return;
    this.apply(next);
    if (announce && next.seals !== st.seals) {
      say(next.seals ? `Seals. Neck ${Math.round(next.neckMm)} millimeters.` : `Won't seal. ${next.failReason}.`);
    } else if (announce && !next.seals && next.failReason !== st.failReason) {
      say(`Won't seal. ${next.failReason}.`);
    }
  }

  private apply(st: StentState | null): void {
    this.mesh.set(st);
    const flow = this.cl ? flowProfile(this.cl, st) : null;
    this.particles.setFlow(flow);
    set('flowDrop', flow ? flow.dpRel : null);
    set('stent', st);
  }

  /** The drawn device's sample points, for the plan note and tests. */
  coveredPoints(): Vec3[] {
    return this.mesh.coveredPoints();
  }

  /** Relative proximal-to-distal pressure drop, native = 100. */
  pressureDrop(): number | null {
    return this.cl ? flowProfile(this.cl, state.stent).dpRel : null;
  }
}
