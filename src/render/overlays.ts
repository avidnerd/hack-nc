/**
 * Geometry drawn on top of the ray-marched volume: the cut-plane outline, the
 * caliper line with its live mm label, the margin's closest approach, the
 * vessels the cut divides, and (from flowParticles / stent) the device and
 * flow.
 *
 * The ray-marcher writes no depth, so overlays cannot be depth-tested against
 * anatomy. They are drawn after it with depthTest off and kept thin and
 * semi-transparent, which reads as an annotation layer rather than as objects
 * floating in front of the body.
 */

import * as THREE from 'three';

import { worldToObject, type Frame } from '../coords.ts';
import { planeBasis } from '../planning/plane.ts';
import { on, state } from '../state.ts';
import type { Plane, Vec3 } from '../types.ts';

const TEAL = 0x58e5c8;
const CALIPER = 0xffd166;
const MARGIN_OK = 0x7ee0a1;
const MARGIN_LOW = 0xffb347;
const MARGIN_BAD = 0xff5a5f;

export class Overlays {
  readonly group = new THREE.Group();

  private planeLine: THREE.LineLoop;
  private caliperLine: THREE.Line;
  private caliperEnds: THREE.Points;
  private caliperLabel: HTMLElement;
  /** Closest approach of the cut to the tumour: the margin, drawn. */
  private marginLine: THREE.Line;
  private marginEnds: THREE.Points;
  private marginLabel: HTMLElement;
  /** One marker per vessel the cut divides, exactly where it divides it. */
  private vesselMarks: THREE.Points;
  private vesselTags: HTMLElement[] = [];
  /** A saved plan's plane, dashed, beside the live one (compare). */
  private ghostLine: THREE.LineLoop;

  private frame: Frame | null = null;

  constructor(
    rig: THREE.Group,
    private readonly project: (p: Vec3) => { x: number; y: number; behind: boolean } | null,
  ) {
    rig.add(this.group);
    this.group.renderOrder = 10;

    this.planeLine = new THREE.LineLoop(
      new THREE.BufferGeometry(),
      overlayLine(TEAL, 0.55),
    );
    this.planeLine.renderOrder = 10;
    this.group.add(this.planeLine);

    this.caliperLine = new THREE.Line(new THREE.BufferGeometry(), overlayLine(CALIPER, 0.95));
    this.caliperLine.renderOrder = 11;
    this.group.add(this.caliperLine);

    this.caliperEnds = overlayPoints(CALIPER, 7);
    this.caliperEnds.renderOrder = 11;
    this.group.add(this.caliperEnds);

    this.marginLine = new THREE.Line(new THREE.BufferGeometry(), overlayLine(MARGIN_OK, 0.95));
    this.marginLine.renderOrder = 11;
    this.marginEnds = overlayPoints(MARGIN_OK, 8);
    this.marginEnds.renderOrder = 11;
    this.group.add(this.marginLine, this.marginEnds);
    this.marginLabel = label('margin-label');

    this.vesselMarks = overlayPoints(MARGIN_BAD, 14);
    this.vesselMarks.renderOrder = 12;
    this.group.add(this.vesselMarks);
    for (let i = 0; i < 4; i++) this.vesselTags.push(label('vessel-tag'));

    this.ghostLine = new THREE.LineLoop(
      new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({ color: 0xc9a7ff, dashSize: 0.015, gapSize: 0.01, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false }),
    );
    this.ghostLine.renderOrder = 10;
    this.group.add(this.ghostLine);

    this.caliperLabel = label('caliper-label');

    on('caliper', () => this.syncCaliper());
    on('reset', () => this.syncCaliper());
  }

  setFrame(f: Frame): void {
    this.frame = f;
    this.syncCaliper();
  }

  /** Per-frame: plane outline follows the live plane, labels follow the camera. */
  update(): void {
    const f = this.frame;
    if (!f) return;

    const p = state.plane;
    this.planeLine.visible = p.on && state.mode === 'surgeon';
    if (this.planeLine.visible) {
      const poly = planeBoxPolygon(f, p);
      setPositions(this.planeLine.geometry, poly.map((q) => worldToObject(f, q)));
      (this.planeLine.material as THREE.LineBasicMaterial).color.setHex(
        p.locked ? 0xffb347 : TEAL,
      );
    }

    this.updateMargin(f);
    this.updateVesselCuts(f);

    const g = state.ghostPlane;
    this.ghostLine.visible = !!g && state.mode === 'surgeon';
    if (g) {
      setPositions(this.ghostLine.geometry, planeBoxPolygon(f, g).map((q) => worldToObject(f, q)));
      this.ghostLine.computeLineDistances();
    }

    const c = state.caliper;
    if (c.a && c.b) {
      const mid: Vec3 = [(c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2, (c.a[2] + c.b[2]) / 2];
      const s = this.project(mid);
      if (s && !s.behind) {
        this.caliperLabel.hidden = false;
        this.caliperLabel.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -150%)`;
      } else {
        this.caliperLabel.hidden = true;
      }
    }
  }

  /**
   * Draws the margin the HUD reports: a short line from the point on the cut
   * surface closest to the tumour to the tumour itself, coloured against the
   * margin threshold, so "6.4 mm" has a place you can look at.
   */
  private updateMargin(f: Frame): void {
    const m = state.metrics;
    const path = m?.marginPath;
    const show = !!m && !!path && state.plane.on && state.mode === 'surgeon' && !m.tumorIncomplete && !state.viewSection;
    this.marginLine.visible = show;
    this.marginEnds.visible = show;
    if (!show || !m || !path) {
      this.marginLabel.hidden = true;
      return;
    }
    const obj = path.map((q) => worldToObject(f, q));
    setPositions(this.marginLine.geometry, obj);
    setPositions(this.marginEnds.geometry, obj);
    const min = state.thresholds.marginMin;
    const color = m.marginMm < 1 ? MARGIN_BAD : m.marginMm < min ? MARGIN_LOW : MARGIN_OK;
    (this.marginLine.material as THREE.LineBasicMaterial).color.setHex(color);
    (this.marginEnds.material as THREE.PointsMaterial).color.setHex(color);
    const s = this.project(path[0]);
    if (s && !s.behind) {
      this.marginLabel.hidden = false;
      this.marginLabel.textContent = `margin ${m.marginMm.toFixed(1)} mm`;
      this.marginLabel.style.color = `#${color.toString(16).padStart(6, '0')}`;
      this.marginLabel.style.transform = `translate(${s.x}px, ${s.y}px) translate(12px, -50%)`;
    } else {
      this.marginLabel.hidden = true;
    }
  }

  /** Marks each divided vessel on the cut face, with its name. */
  private updateVesselCuts(f: Frame): void {
    const m = state.metrics;
    // Resection marks belong to the liver case; an aorta-case cut only views.
    const resection = state.data?.meta.kind === 'liver' && !state.viewSection;
    const cuts = resection && state.plane.on && state.mode === 'surgeon' ? (m?.vesselCuts ?? []) : [];
    this.vesselMarks.visible = cuts.length > 0;
    if (cuts.length > 0) setPositions(this.vesselMarks.geometry, cuts.map((c) => worldToObject(f, c.p)));
    this.vesselTags.forEach((tag, i) => {
      const c = cuts[i];
      const s = c ? this.project(c.p) : null;
      if (!c || !s || s.behind) {
        tag.hidden = true;
        return;
      }
      tag.hidden = false;
      const name = state.data?.meta.labels.find((l) => l.id === c.id)?.name ?? 'vessel';
      tag.textContent = `${name}, divided`;
      tag.style.transform = `translate(${s.x}px, ${s.y}px) translate(10px, -130%)`;
    });
  }

  private syncCaliper(): void {
    const f = this.frame;
    const c = state.caliper;
    const pts = [c.a, c.b].filter((x): x is Vec3 => !!x);
    const visible = !!f && pts.length > 0;
    this.caliperLine.visible = visible && pts.length === 2;
    this.caliperEnds.visible = visible;
    if (!f || !visible) {
      this.caliperLabel.hidden = true;
      return;
    }
    const obj = pts.map((q) => worldToObject(f, q));
    setPositions(this.caliperLine.geometry, obj);
    setPositions(this.caliperEnds.geometry, obj);
    if (pts.length === 2) {
      this.caliperLabel.textContent = c.label ? `${c.label}: ${c.mm.toFixed(1)} mm` : `${c.mm.toFixed(1)} mm`;
    } else {
      this.caliperLabel.hidden = true;
    }
  }
}

function overlayLine(color: number, opacity: number): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
  });
}

function overlayPoints(color: number, size: number): THREE.Points {
  return new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({
      color,
      size,
      map: dotTexture(),
      alphaTest: 0.5,
      sizeAttenuation: false,
      depthTest: false,
      transparent: true,
    }),
  );
}

let dot: THREE.Texture | null = null;

/** A round sprite, so overlay points read as dots rather than GL squares. */
function dotTexture(): THREE.Texture {
  if (dot) return dot;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(16, 16, 14, 0, Math.PI * 2);
  g.fill();
  dot = new THREE.CanvasTexture(c);
  return dot;
}

function label(cls: string): HTMLElement {
  const e = document.createElement('div');
  e.className = cls;
  e.hidden = true;
  document.body.append(e);
  return e;
}

function setPositions(geo: THREE.BufferGeometry, pts: Vec3[]): void {
  const arr = new Float32Array(pts.length * 3);
  pts.forEach((p, i) => arr.set(p, i * 3));
  geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  geo.computeBoundingSphere();
}

/**
 * The polygon where a plane cuts the volume's bounding box, in world mm,
 * ordered around the plane normal. Empty when the plane misses the box.
 */
export function planeBoxPolygon(f: Frame, plane: Plane): Vec3[] {
  const lo = f.origin;
  const hi: Vec3 = [lo[0] + f.extent[0], lo[1] + f.extent[1], lo[2] + f.extent[2]];
  const corners: Vec3[] = [];
  for (let i = 0; i < 8; i++) {
    corners.push([i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]);
  }
  const edges: [number, number][] = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const sd = (p: Vec3) => plane.n[0] * p[0] + plane.n[1] * p[1] + plane.n[2] * p[2] - plane.d;
  const pts: Vec3[] = [];
  for (const [a, b] of edges) {
    const da = sd(corners[a]);
    const db = sd(corners[b]);
    if ((da > 0) === (db > 0)) continue;
    const t = da / (da - db);
    const A = corners[a];
    const B = corners[b];
    pts.push([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
  }
  if (pts.length < 3) return [];
  const c: Vec3 = [0, 0, 0];
  for (const p of pts) {
    c[0] += p[0] / pts.length;
    c[1] += p[1] / pts.length;
    c[2] += p[2] / pts.length;
  }
  const [u, v] = planeBasis(plane.n);
  const ang = (p: Vec3) => {
    const q: Vec3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    return Math.atan2(q[0] * v[0] + q[1] * v[1] + q[2] * v[2], q[0] * u[0] + q[1] * u[1] + q[2] * u[2]);
  };
  return pts.sort((a, b) => ang(a) - ang(b));
}
