/**
 * Mouse and trackpad control. Mandatory: the demo must survive a refused
 * webcam, and it is also how the renderer gets tested without a camera.
 *
 *   drag          rotate
 *   shift + drag  slide the cutting plane along its normal
 *   right-drag    tilt the cutting plane
 *   scroll        zoom
 *   click x2      drop the two caliper points
 */

import { cameraBasis, clamp, normalize, objectToWorld, type Frame } from '../coords.ts';
import { snapCaliper } from '../planning/smartMeasure.ts';
import { patch, set, state } from '../state.ts';
import { TUNING } from './tuning.ts';
import type { Vec3 } from '../types.ts';

export interface MouseHooks {
  /** Lets the renderer drop quality while the user is dragging. */
  setMoving: (moving: boolean) => void;
  /** Un-projects a screen pixel onto the volume, for caliper picks. */
  pick: (x: number, y: number) => Vec3 | null;
  frame: () => Frame | null;
}

export function installMouse(canvas: HTMLCanvasElement, hooks: MouseHooks): void {
  let dragging = false;
  let button = 0;
  let lastX = 0;
  let lastY = 0;
  let moved = 0;

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    button = e.button;
    lastX = e.clientX;
    lastY = e.clientY;
    moved = 0;
    canvas.setPointerCapture(e.pointerId);
    hooks.setMoving(true);
  });

  canvas.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    hooks.setMoving(false);
    canvas.releasePointerCapture(e.pointerId);

    // A press that barely moved is a click, so use it as a caliper pick.
    if (moved < 5 && e.button === 0) {
      const p = hooks.pick(e.clientX, e.clientY);
      if (p) addCaliperPoint(p);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    moved += Math.abs(dx) + Math.abs(dy);

    const w = window.innerWidth;

    if (button === 2) {
      // Right-drag tilts the plane: build a rotation of the normal around the
      // screen axes, which feels like tipping a sheet of glass.
      tiltPlane(dx / w, dy / w);
    } else if (e.shiftKey) {
      // Shift-drag slides the plane along its own normal.
      if (!state.plane.locked) {
        const f = hooks.frame();
        const span = f ? f.maxExtent : 300;
        patch('plane', { on: true, d: state.plane.d + (dy / w) * span });
      }
    } else {
      const c = state.camera;
      patch('camera', {
        yaw: c.yaw - (dx / w) * TUNING.rotationPerScreen,
        pitch: clamp(c.pitch - (dy / w) * TUNING.rotationPerScreen, -1.45, 1.45),
      });
    }
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const c = state.camera;
      const factor = Math.exp(e.deltaY * 0.0012);
      patch('camera', { dist: clamp(c.dist * factor, TUNING.zoomMin, TUNING.zoomMax) });
    },
    { passive: false },
  );
}

/**
 * Rotate the plane normal by small screen-aligned angles. Uses the camera's
 * own right/up vectors so a drag to the right always tips the cut to the
 * right, whatever the current orbit.
 */
function tiltPlane(dxFrac: number, dyFrac: number): void {
  if (state.plane.locked) return;
  const c = state.camera;
  const { right, up } = cameraBasis(c.yaw + c.headYaw, c.pitch + c.headPitch);

  const k = 2.4;
  const n = state.plane.n;
  const next = normalize([
    n[0] + right[0] * dxFrac * k + up[0] * dyFrac * k,
    n[1] + right[1] * dxFrac * k + up[1] * dyFrac * k,
    n[2] + right[2] * dxFrac * k + up[2] * dyFrac * k,
  ]);
  patch('plane', { on: true, n: next });
}

/** Caliper: first click sets A, second sets B, third starts over. */
export function addCaliperPoint(p: Vec3): void {
  const c = state.caliper;
  if (!c.a || (c.a && c.b)) {
    set('caliper', { a: p, b: null, mm: 0 });
  } else {
    if (state.data) {
      set('caliper', snapCaliper(state.data, c.a, p));
    } else {
      const mm = Math.hypot(p[0] - c.a[0], p[1] - c.a[1], p[2] - c.a[2]);
      set('caliper', { a: c.a, b: p, mm });
    }
  }
}

/**
 * Un-project a screen pixel to a world-mm point on the volume.
 *
 * Without a depth buffer from the ray-marcher we intersect the view ray with
 * the cutting plane when one is active (which is where the surgeon is looking)
 * and otherwise with the volume's bounding box front face. Good enough for a
 * caliper the user positions visually.
 */
export function pickOnVolume(
  f: Frame,
  rayOrigin: Vec3,
  rayDir: Vec3,
  usePlane: boolean,
): Vec3 | null {
  if (usePlane) {
    const n = state.plane.n;
    const denom = n[0] * rayDir[0] + n[1] * rayDir[1] + n[2] * rayDir[2];
    if (Math.abs(denom) > 1e-6) {
      const t =
        (state.plane.d - (n[0] * rayOrigin[0] + n[1] * rayOrigin[1] + n[2] * rayOrigin[2])) / denom;
      if (t > 0) {
        return [
          rayOrigin[0] + rayDir[0] * t,
          rayOrigin[1] + rayDir[1] * t,
          rayOrigin[2] + rayDir[2] * t,
        ];
      }
    }
  }

  // Slab test against the object-space box, then convert the entry point back
  // to world millimetres.
  const half = f.half;
  let t0 = -Infinity;
  let t1 = Infinity;
  // Ray is given in world mm; move it into object space first.
  const ro: Vec3 = [
    (rayOrigin[0] - f.centerMm[0]) / f.maxExtent,
    (rayOrigin[1] - f.centerMm[1]) / f.maxExtent,
    (rayOrigin[2] - f.centerMm[2]) / f.maxExtent,
  ];
  for (let i = 0; i < 3; i++) {
    const d = rayDir[i];
    if (Math.abs(d) < 1e-9) {
      if (Math.abs(ro[i]) > half[i]) return null;
      continue;
    }
    const a = (-half[i] - ro[i]) / d;
    const b = (half[i] - ro[i]) / d;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  if (t1 < Math.max(t0, 0)) return null;
  const t = Math.max(t0, 0);
  return objectToWorld(f, [ro[0] + rayDir[0] * t, ro[1] + rayDir[1] * t, ro[2] + rayDir[2] * t]);
}
