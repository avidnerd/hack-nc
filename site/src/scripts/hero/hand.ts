/**
 * Webcam opt-in for the hero: the visitor's open hand drives the cut, through
 * the app's own MediaPipe wrapper, 1€ filters and gesture state machine.
 *
 * The mapping mirrors the app's HandController.cut(): the plane takes the
 * palm's orientation (turned to face the viewer) and passes through the point
 * under the hand at the organ's depth; moving the hand toward the camera
 * pushes the cut deeper. Loaded only after the visitor clicks, so the model
 * and WASM never touch first paint.
 */

import { add, clamp, dot, normalize, scale, sub, type Vec3 } from '@app/coords.ts';
import { GestureTracker, type TrackedHand } from '@app/input/gestures.ts';
import { HandInput } from '@app/input/hands.ts';
import { OneEuro, OneEuroVec } from '@app/input/oneEuro.ts';
import { TUNING } from '@app/input/tuning.ts';

import type { HeroRenderer } from './renderer.ts';

const RAD = 180 / Math.PI;

export interface HandSession {
  tick(now: number): void;
  /** True while an open hand is steering the plane. */
  readonly steering: boolean;
  stop(): void;
}

export async function startHand(hero: HeroRenderer, pivot: Vec3): Promise<HandSession | null> {
  const input = new HandInput();
  if (!(await input.start())) return null;

  const tracker = new GestureTracker();
  const normalF = new OneEuroVec(3, TUNING.normalFilter);
  const pointF = new OneEuroVec(3, TUNING.landmarkFilter);
  const depthF = new OneEuro(TUNING.depthFilter);
  let hsEntry = 0;
  let steering = false;

  function cut(hand: TrackedHand, entering: boolean, tMs: number): void {
    const { right, up, forward } = hero.basis();
    let nv = hand.f.normal;
    if (nv[2] < 0) nv = scale(nv, -1);
    const nf = normalF.filter(scale(nv, RAD), tMs);
    const nView = normalize([nf[0], nf[1], nf[2]]);
    const n = normalize(add(add(scale(right, nView[0]), scale(up, nView[1])), scale(forward, -nView[2])));

    const canvas = hero.renderer.domElement.getBoundingClientRect();
    const ray = hero.ray(canvas.left + hand.obs.uv[0] * canvas.width, canvas.top + hand.obs.uv[1] * canvas.height);
    const denom = dot(ray.d, forward);
    const t = Math.abs(denom) > 1e-6 ? dot(sub(pivot, ray.o), forward) / denom : 0;
    const under = add(ray.o, scale(ray.d, t));

    if (entering || hsEntry === 0) hsEntry = hand.f.hs;
    const depthRaw =
      clamp(TUNING.depthGain * Math.log(hand.f.hs / hsEntry), -TUNING.depthClamp, TUNING.depthClamp) *
      hero.frame.maxExtent;
    const depth = depthF.filter(depthRaw, tMs);
    const pf = pointF.filter(add(under, scale(forward, depth)), tMs);
    hero.setPlane(true, n, dot(n, [pf[0], pf[1], pf[2]]));
  }

  input.onFrame = (hands, tMs) => {
    const g = tracker.update(hands, tMs);
    const lead = g.hands.find((h) => h.pose === g.pose) ?? null;
    const open = g.pose === 'OPEN' && !!lead && lead.raw === lead.pose;
    if (open && lead) {
      cut(lead, !steering, tMs);
    } else if (steering) {
      // Leaving the pose: the plane stays where the hand left it, as in the app.
      normalF.reset();
      pointF.reset();
      depthF.reset();
      hsEntry = 0;
    }
    steering = open;
  };

  return {
    tick: (now) => input.tick(now),
    get steering() {
      return steering;
    },
    stop() {
      const v = input.videoElement;
      (v.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
      v.srcObject = null;
    },
  };
}
