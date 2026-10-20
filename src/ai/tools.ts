/**
 * The agent's tools (shared/tools.json), executed in the browser against the
 * live engine. JSON in, JSON out; never throws: a failure is `{error}`.
 *
 * Every tool goes through the same code path as the equivalent voice command
 * (the host hands those over from main.ts), so a tool call moves the plane,
 * places the stent or opens a card exactly as speaking would. Nothing here
 * computes a planning number itself: values come from the engine, the stent
 * rules or the planning grid, and are only rounded for the reply.
 *
 * Result shapes, error strings and rounding are the contract in docs/TOOLS.md,
 * shared with the Python executor (backend/app/engine/tools.py) that produces
 * the teacher traces. `make tool-parity` replays one script through both and
 * requires identical JSON. Numbers in %, mm, mL and degrees are rounded to 1
 * decimal.
 */

import { cross, dot, normalize } from '../coords.ts';
import type { Centerline } from '../devices/centerline.ts';
import {
  evaluateStent,
  FALLBACK_S0,
  lowestRenal,
  maxStart,
  NECK_WINDOW_MM,
  optimizeStent,
  placeStent,
  preferredStart,
  RULES,
  sizeAt,
  type Ostium,
} from '../devices/stent.ts';
import { evaluatePlane, type EngineContext } from '../planning/engine.ts';
import { violations, type OptimizeResult } from '../planning/optimize.ts';
import { structureDistance } from '../planning/smartMeasure.ts';
import type { PlanningGrid } from '../planning/volume.ts';
import { state } from '../state.ts';
import type { CaseData, PlanMetrics, Plane, PresetName, StentState, Thresholds, Vec3 } from '../types.ts';
import type { CardContent } from '../ui/infoCard.ts';
import type { Intent } from '../voice/intents.ts';

export type Json = Record<string, unknown>;

/** What main.ts's optimize path reports back, so the tool can describe it. */
export interface OptimizeOutcome {
  res: OptimizeResult;
  /** Fine-grid numbers for the start and the answer (what the HUD shows). */
  before: PlanMetrics;
  after: PlanMetrics;
  th: Thresholds;
  /** The search went all around the tumour, not just near the start. */
  wide: boolean;
  /** A cut was on when the search started. */
  hadCut: boolean;
}

export interface OptimizeRequest {
  marginMm?: number;
  remnantPct?: number;
  priority?: 'vessels' | 'remnant';
  /** Bound the local search to this cone half-angle (and skip the wide search). */
  maxRotateDeg?: number;
  /** Bound the local search to this offset range (and skip the wide search). */
  maxOffsetMm?: number;
}

/** The parts of the app (owned by main.ts) the tools drive. */
export interface ToolHost {
  engine(): EngineContext | null;
  grid(): PlanningGrid | null;
  /**
   * Where the cut is headed: the end of a running animation, else the plane
   * on screen. Chained calls in one turn build on this, not on a mid-tween frame.
   */
  plane(): Plane;
  /** Tumour centroid (else the organ's): rotations pivot where the cut passes closest to it. */
  pivotPoint(): Vec3;
  /** Animated, undoable move of the cut that also turns it on (voice cuts). */
  placeCut(p: Plane): void;
  optimize(req: OptimizeRequest): Promise<OptimizeOutcome | null>;
  dispatch(intent: Intent): void;
  stentCenterline(): Centerline | null;
  stentOstia(): Ostium[];
  /** Place the device: v1 placement when s0 is omitted, exactly at s0 otherwise. */
  placeStent(s0?: number, lengthMm?: number): StentState | null;
  /** The device where it is headed (the end of a running slide), else the one drawn. */
  stent(): StentState | null;
  /** Put this exact device in place, without animation. */
  setStent(st: StentState): void;
  /** The spoken stent "optimize": slides the placed device to its nearest seal. */
  optimizeStent(): void;
  showCard(card: CardContent): void;
  /** The voice "write the plan": downloads plan.md (and plane.json). */
  writePlan(): void;
  /** Visibility changed outside dispatch: rebuild the label palette. */
  refreshVisibility(): void;
  syncHud(): void;
}

/* ------------------------------------------------------------ pure helpers */

/** One decimal, the precision every unit-bearing number is reported at. */
export function r1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** Unit normals carry 4 decimals: enough to rebuild the plane within 0.01 mm at 100 mm. */
export function r4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

export function planeOut(p: Plane): { normal: number[]; d: number } {
  return { normal: p.n.map(r4), d: r1(p.d) };
}

export function metricsOut(m: PlanMetrics): { flr_pct: number; margin_mm: number; vessels_crossed: number } {
  return { flr_pct: r1(m.remnantPct), margin_mm: r1(m.marginMm), vessels_crossed: m.vesselsCrossed };
}

export function thresholdsOut(th: Thresholds): { margin_min_mm: number; flr_min_pct: number } {
  return { margin_min_mm: r1(th.marginMin), flr_min_pct: r1(th.remnantMin) };
}

/** Rodrigues: `v` turned by `deg` about unit axis `k`. */
function rotateVec(v: Vec3, k: Vec3, deg: number): Vec3 {
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
}

const AXES: Record<'x' | 'y' | 'z', Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/**
 * set_plane's relative move. The normal turns `deg` (right-handed) about the
 * world axis, the plane keeps passing through `pivot`, then slides
 * `offsetMm` along the new normal (positive: toward the resected side).
 */
export function movePlaneBy(
  p: Plane,
  pivot: Vec3,
  rotate: { axis: 'x' | 'y' | 'z'; deg: number } | null,
  offsetMm: number,
): Plane {
  let n = normalize(p.n);
  let d = p.d;
  if (rotate) {
    n = normalize(rotateVec(n, AXES[rotate.axis], rotate.deg));
    d = dot(n, pivot);
  }
  return { n, d: d + offsetMm };
}

/** Which rules a device is checked against; M4's rule cards add sourced ones. */
export const RULES_SOURCE = 'default';

export interface StentRule {
  id: 'renal' | 'neck_length' | 'oversize' | 'angulation';
  pass: boolean;
  value: number | null;
  limit: number | number[];
  unit: string;
}

/**
 * The per-rule breakdown of a stent verdict, in the order evaluateStent
 * checks them. Values are the ones evaluateStent computed; this only reports
 * them against the same RULES limits.
 */
export function stentRules(st: StentState, ostia: Ostium[]): StentRule[] {
  const s1 = st.s0 + st.lengthMm;
  const covered = ostia.some((o) => o.s >= st.s0 && o.s <= s1);
  const lowest = lowestRenal(ostia);
  // Clearance below the lowest renal ostium (negative: above it); null without ostia.
  const clearance = lowest === null ? null : st.s0 - lowest;
  return [
    { id: 'renal', pass: !covered && (clearance === null || clearance >= 0), value: clearance === null ? null : r1(clearance), limit: 0, unit: 'mm' },
    { id: 'neck_length', pass: st.neckMm >= RULES.neckMinMm, value: r1(st.neckMm), limit: RULES.neckMinMm, unit: 'mm' },
    {
      id: 'oversize',
      pass: st.oversizePct >= RULES.oversizeMinPct && st.oversizePct <= RULES.oversizeMaxPct,
      value: r1(st.oversizePct),
      limit: [RULES.oversizeMinPct, RULES.oversizeMaxPct],
      unit: '%',
    },
    { id: 'angulation', pass: st.angulationDeg < RULES.angulationMaxDeg, value: r1(st.angulationDeg), limit: RULES.angulationMaxDeg, unit: 'deg' },
  ];
}

export function stentOut(st: StentState, deviceId: string | null, ostia: Ostium[]): Json {
  return {
    device_id: deviceId,
    s0_mm: r1(st.s0),
    length_mm: r1(st.lengthMm),
    diameter_mm: r1(st.diameterMm),
    oversize_pct: r1(st.oversizePct),
    rules: stentRules(st, ostia),
    rules_source: RULES_SOURCE,
    seals: st.seals,
  };
}

/** The rule id behind a stent failReason ("Neck too short, 8 millimeters" is neck_length). */
export function ruleOfReason(reason: string | null): StentRule['id'] | null {
  if (!reason) return null;
  if (reason.startsWith('Neck too short')) return 'neck_length';
  if (reason.startsWith('Neck angled')) return 'angulation';
  if (reason.startsWith('Undersized') || reason.startsWith('Oversized')) return 'oversize';
  if (/renal/i.test(reason)) return 'renal';
  return null;
}

const START_CODES = { tumor: 'tumor_incomplete', margin: 'margin_below_min', remnant: 'flr_below_min', vessels: 'vessels_crossed' } as const;

/**
 * What the starting cut violated (or `no_cut`), which search answered, and
 * `avoid_crossed` when the answer still divides a structure to avoid.
 */
export function optimizeReasonCodes(o: OptimizeOutcome, avoidCrossed: boolean): string[] {
  const codes: string[] = o.hadCut ? o.res.violated.map((v) => START_CODES[v]) : ['no_cut'];
  codes.push(o.wide ? 'wide_search' : 'local_search');
  if (avoidCrossed) codes.push('avoid_crossed');
  return codes;
}

/**
 * A plain sentence from tool results alone, for when the model gives no
 * usable text. Every number in it is a tool value, so it is grounded.
 */
export function templateReply(results: { name: string; result: Json }[]): string {
  const parts: string[] = [];
  for (const { name, result: r } of results) {
    if (typeof r.error === 'string') {
      parts.push(`${name.replace(/_/g, ' ')} failed: ${r.error}.`);
      continue;
    }
    const m = (r.after ?? r) as Json;
    switch (name) {
      case 'set_plane':
      case 'optimize_plane':
        parts.push(
          `${name === 'optimize_plane' ? 'Optimized' : 'Moved'}. FLR ${m.flr_pct} %, margin ${m.margin_mm} mm, ${m.vessels_crossed} vessels crossed.`,
        );
        break;
      case 'measure':
        parts.push(`${String(r.what).replace(/_/g, ' ')} ${r.value}${r.unit ? ` ${r.unit}` : ''}.`);
        break;
      case 'place_stent': {
        const neck = (r.rules as StentRule[] | undefined)?.find((x) => x.id === 'neck_length')?.value;
        parts.push(r.seals ? `Stent placed. Neck ${neck} mm. Seals.` : 'Stent placed. It does not seal.');
        break;
      }
      case 'optimize_stent':
        parts.push(r.found ? `Stent seals at ${r.s0_mm} mm.` : `No sealing position: ${String(r.failing_rule ?? 'no rule passes')}.`);
        break;
      case 'resect':
        parts.push(`Resects ${r.resected_ml} mL. FLR ${r.remnant_flr_pct} %.`);
        break;
      case 'set_threshold':
        parts.push('Threshold updated.');
        break;
      case 'write_plan':
        parts.push('Plan written.');
        break;
      default:
        break;
    }
  }
  return parts.join(' ') || 'Done.';
}

/* ------------------------------------------------- errors (docs/TOOLS.md) */

const NO_CUT = 'no cut placed yet; use set_plane or optimize_plane first';
const notLiver = (kind: string) => `the ${kind} case is not a liver resection case; cut metrics need the liver case`;
const noTumour = () => `case "${state.caseId}" has no tumour`;
const PLANE_ID = 'plane';
const REACH_MM = 120;

/* ---------------------------------------------------------------- executor */

let host: ToolHost | null = null;

export function setToolHost(h: ToolHost): void {
  host = h;
}

/**
 * What the agent has done in this case that the app state does not record:
 * the device it named and the cut it resected. Reset when the case changes.
 */
interface AgentSession {
  caseId: string;
  deviceId: string | null;
  resectedAt: Plane | null;
}
let session: AgentSession = { caseId: '', deviceId: null, resectedAt: null };

function sess(): AgentSession {
  if (session.caseId !== state.caseId) session = { caseId: state.caseId, deviceId: null, resectedAt: null };
  return session;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function currentPlane(): Plane {
  const p = host!.plane();
  return { n: [...p.n] as Vec3, d: p.d };
}

/** True while the cut the agent resected is still the cut. */
function resected(): boolean {
  const r = sess().resectedAt;
  if (!r || !state.plane.on) return false;
  const p = currentPlane();
  return p.d === r.d && p.n.every((x, i) => x === r.n[i]);
}

/** `c` projected onto plane `p`. */
function onPlane(p: Plane, c: Vec3): Vec3 {
  const k = dot(p.n, c) - p.d;
  return [c[0] - p.n[0] * k, c[1] - p.n[1] * k, c[2] - p.n[2] * k];
}

function isLiverCase(data: CaseData): boolean {
  return data.meta.kind === 'liver';
}

/** The error for ids that are not this case's label keys (plus `plane` where allowed), else null. */
function badIds(data: CaseData, ids: string[], allowPlane = false): string | null {
  const valid = data.meta.labels.map((l) => l.key);
  if (allowPlane) valid.push(PLANE_ID);
  const bad = ids.filter((k) => !valid.includes(k));
  if (!bad.length) return null;
  return `unknown structure ${bad.map((b) => `"${b}"`).join(', ')}; valid ids: ${[...valid].sort().join(', ')}`;
}

function labelId(data: CaseData, key: string): number {
  return data.meta.labels.find((l) => l.key === key)!.id;
}

function visibleKeys(data: CaseData | null): string[] {
  return data ? data.meta.labels.filter((l) => state.visible[l.key] !== false).map((l) => l.key) : [];
}

function stentJson(st: StentState): Json {
  return stentOut(st, sess().deviceId, host!.stentOstia());
}

export function getState(): Json {
  const data = state.data;
  const st = host?.stent() ?? state.stent;
  return {
    case_id: state.caseId,
    case_kind: data?.meta.kind ?? null,
    mode: state.mode,
    plane: state.plane.on ? planeOut(currentPlane()) : null,
    stent: st && host ? stentJson(st) : null,
    thresholds: thresholdsOut(state.thresholds),
    visible: visibleKeys(data),
  };
}

const METHOD = {
  flr: 'kept organ voxels / organ voxels x 100 (organ = liver + tumour)',
  margin: 'min tumour distance (EDT) over kept organ voxels within one voxel diagonal of the plane; 0 if tumour is kept',
  vessels_crossed: '6-connected vessel components within one voxel diagonal of the plane, in the organ box, >= 120 mm^3',
  tumor_volume: 'tumour voxels x voxel volume (full-resolution labels)',
  neck_length: "length distal to the stent's proximal end where lumen diameter stays within 10% of the 15 mm neck mean",
  neck_diameter: "mean lumen diameter over the first 15 mm below the stent's proximal end, sampled every 1 mm",
  distance: 'closest wall-to-wall gap: min voxel-centre distance (exact EDT, full-resolution labels) minus the mean voxel size',
  plane_distance: 'min |n.x - d| over the structure voxel centres (0 if the plane cuts it)',
};

/** The stent the neck measures read: the placed one, else where a fresh one would seat. */
function neckStent(): StentState {
  const h = host!;
  return h.stent() ?? placeStent(h.stentCenterline()!, h.stentOstia(), preferredStart(h.stentOstia(), FALLBACK_S0));
}

/** Min |n.x - d| over a structure's planning-grid voxels, 0 when the plane cuts through it. */
function planeDistance(g: PlanningGrid, id: number, p: Plane): number | null {
  let lo = Infinity;
  let hi = -Infinity;
  let near = Infinity;
  for (let idx = 0; idx < g.labels.length; idx++) {
    if (g.labels[idx] !== id) continue;
    const x = g.worldAt(idx);
    const sd = p.n[0] * x[0] + p.n[1] * x[1] + p.n[2] * x[2] - p.d;
    if (sd < lo) lo = sd;
    if (sd > hi) hi = sd;
    if (Math.abs(sd) < near) near = Math.abs(sd);
  }
  if (lo === Infinity) return null;
  return lo <= 0 && hi >= 0 ? 0 : near;
}

function measure(args: Json): Json {
  const h = host!;
  const what = String(args.what ?? '');
  const data = state.data;
  if (!data) return { error: 'no case loaded' };
  const out = (value: number, unit: string, method: string = METHOD[what as keyof typeof METHOD]) => ({
    what,
    value: unit ? r1(value) : value,
    unit,
    method,
  });
  switch (what) {
    case 'flr':
    case 'margin':
    case 'vessels_crossed': {
      if (!isLiverCase(data)) return { error: notLiver(data.meta.kind) };
      const engine = h.engine();
      const g = h.grid();
      if (!engine || !g) return { error: 'planning engine not ready' };
      if (what === 'margin' && g.tumorIdx.length === 0) return { error: noTumour() };
      if (!state.plane.on) return { error: NO_CUT };
      const m = evaluatePlane(engine, currentPlane(), { locate: false });
      if (what === 'flr') return out(m.remnantPct, '%');
      if (what === 'vessels_crossed') return out(m.vesselsCrossed, '');
      return out(m.marginMm, 'mm');
    }
    case 'tumor_volume': {
      const g = h.grid();
      const tumour = data.meta.labels.find((l) => l.role === 'tumor');
      if (!g || !tumour || g.tumorIdx.length === 0) return { error: noTumour() };
      let count = 0;
      for (let i = 0; i < data.labels.length; i++) if (data.labels[i] === tumour.id) count++;
      const sp = data.meta.spacing;
      return out((count * sp[0] * sp[1] * sp[2]) / 1000, 'mL');
    }
    case 'neck_length':
    case 'neck_diameter': {
      const bad = stentReady();
      if (bad) return { error: bad };
      const st = neckStent();
      if (what === 'neck_length') return out(st.neckMm, 'mm');
      return out(h.stentCenterline()!.meanDiameter(st.s0, st.s0 + NECK_WINDOW_MM), 'mm');
    }
    case 'distance': {
      const a = typeof args.a === 'string' ? args.a : '';
      const b = typeof args.b === 'string' ? args.b : '';
      if (!a || !b) return { error: 'distance needs a and b' };
      const bad = badIds(data, [a, b], true);
      if (bad) return { error: bad };
      if (a === PLANE_ID || b === PLANE_ID) {
        if (a === b) return out(0, 'mm', METHOD.plane_distance);
        if (!state.plane.on) return { error: NO_CUT };
        const other = a === PLANE_ID ? b : a;
        const g = h.grid();
        const v = g ? planeDistance(g, labelId(data, other), currentPlane()) : null;
        if (v === null) return { error: `"${other}" is not on the planning grid` };
        return out(v, 'mm', METHOD.plane_distance);
      }
      const ia = labelId(data, a);
      const ib = labelId(data, b);
      if (!data.labels.includes(ia) || !data.labels.includes(ib)) return { error: `"${a}" or "${b}" has no voxels in this case` };
      const r = structureDistance(data, [ia], [ib], REACH_MM);
      if (!r) return { error: `"${a}" and "${b}" are more than ${REACH_MM} mm apart` };
      // Both structures are shown now (the view below reveals them a frame
      // later), so the state the next call reads already has them.
      state.visible = { ...state.visible, [a]: true, [b]: true };
      h.refreshVisibility();
      // The same view the spoken "how far is A from B" opens.
      h.dispatch({ kind: 'distance', a, b });
      return out(r.mm, 'mm');
    }
    default:
      return { error: `unknown measure "${what}"` };
  }
}

function setPlane(args: Json): Json {
  const h = host!;
  const data = state.data;
  if (!data) return { error: 'no case loaded' };
  const engine = h.engine();
  if (!engine) return { error: 'planning engine not ready' };
  if (state.plane.locked) return { error: 'the cut is locked; the user must unlock it' };
  const hasAbs = args.normal !== undefined || args.d !== undefined;
  if (hasAbs && (args.normal === undefined || args.d === undefined)) return { error: 'give normal and d together' };
  if (!hasAbs && args.rotate_deg === undefined && args.offset_mm === undefined) {
    return { error: 'give normal and d, or rotate_deg and/or offset_mm' };
  }
  // Relative moves with no cut on start from the default plane (+x through the organ).
  let to = currentPlane();
  if (hasAbs) {
    const n = Array.isArray(args.normal) ? args.normal.map(num) : null;
    const d = num(args.d);
    if (!n || n.length !== 3 || n.some((x) => x === null) || d === null) return { error: 'normal needs 3 numbers and d a number' };
    if (Math.hypot(n[0]!, n[1]!, n[2]!) < 1e-6) return { error: 'normal must be non-zero' };
    // DECISION: d is mm along the unit normal; a non-unit normal is only a direction.
    to = { n: normalize([n[0]!, n[1]!, n[2]!]), d };
  }
  if (args.rotate_deg !== undefined) {
    const rot = args.rotate_deg as { axis?: unknown; deg?: unknown };
    const axis = rot.axis === 'x' || rot.axis === 'y' || rot.axis === 'z' ? rot.axis : null;
    const deg = num(rot.deg);
    if (axis === null || deg === null) return { error: 'rotate_deg needs axis x|y|z and deg' };
    to = movePlaneBy(to, onPlane(to, h.pivotPoint()), { axis, deg }, 0);
  }
  if (args.offset_mm !== undefined) {
    const off = num(args.offset_mm);
    if (off === null) return { error: 'offset_mm must be a number' };
    to = { n: to.n, d: to.d + off };
  }
  sess().resectedAt = null;
  h.placeCut(to);
  const res: Json = { plane: planeOut(to) };
  if (!isLiverCase(data)) return { ...res, note: notLiver(data.meta.kind) };
  const m = evaluatePlane(engine, to, { locate: false });
  return { ...res, ...metricsOut(m), tumor_incomplete: m.tumorIncomplete };
}

async function optimizePlaneTool(args: Json): Promise<Json> {
  const h = host!;
  const data = state.data;
  if (!data) return { error: 'no case loaded' };
  if (!isLiverCase(data)) return { error: notLiver(data.meta.kind) };
  const g = h.grid();
  if (!g) return { error: 'planning engine not ready' };
  if (g.tumorIdx.length === 0) return { error: noTumour() };
  const avoid = Array.isArray(args.avoid) ? args.avoid.filter((x): x is string => typeof x === 'string') : [];
  const bad = badIds(data, avoid);
  if (bad) return { error: bad };
  const req: OptimizeRequest = {};
  const margin = num(args.margin_min_mm);
  const flr = num(args.flr_min_pct);
  if (margin !== null) req.marginMm = margin;
  if (flr !== null) req.remnantPct = flr;
  // DECISION: naming structures to avoid switches the search to the
  // vessels-first weights (the spoken "spare the vessels"); the engine has
  // no per-structure penalty. Same rule in the Python executor.
  if (avoid.length) req.priority = 'vessels';
  const maxRot = num(args.max_rotate_deg);
  const maxOff = num(args.max_offset_mm);
  if (maxRot !== null) req.maxRotateDeg = maxRot;
  if (maxOff !== null) req.maxOffsetMm = maxOff;
  const o = await h.optimize(req);
  if (!o) return { error: 'optimizer found no plane' };
  sess().resectedAt = null;
  const avoidIds = new Set(avoid.map((k) => labelId(data, k)));
  const crossed = (o.after.vesselCuts ?? []).some((c) => avoidIds.has(c.id));
  return {
    plane: planeOut(o.res.plane),
    before: metricsOut(o.before),
    after: metricsOut(o.after),
    feasible: o.res.feasible,
    reason_codes: optimizeReasonCodes(o, crossed),
    angle_deg: r1(o.res.angleDeg),
    offset_mm: r1(o.res.offsetMm),
  };
}

function stentReady(): string | null {
  const h = host!;
  const data = state.data;
  if (!data) return 'no case loaded';
  if (data.meta.kind !== 'aorta') return `stent grafts are for the aorta case; "${state.caseId}" is a ${data.meta.kind} case`;
  if (!h.stentCenterline()) return 'no aorta centerline in this case';
  return null;
}

function placeStentTool(args: Json): Json {
  const h = host!;
  const bad = stentReady();
  if (bad) return { error: bad };
  // s0 and length are clamped to the centerline (placeAt), as in the Python twin.
  const st = h.placeStent(num(args.s0_mm) ?? undefined, num(args.length_mm) ?? undefined);
  if (!st) return { error: 'could not place the stent' };
  sess().deviceId = typeof args.device_id === 'string' ? args.device_id : null;
  return stentJson(st);
}

function optimizeStentTool(args: Json): Json {
  const h = host!;
  const bad = stentReady();
  if (bad) return { error: bad };
  const cl = h.stentCenterline()!;
  const ostia = h.stentOstia();
  const placed = h.stent();
  // DECISION: with no device placed, start from where a fresh one would seat
  // (just below the lowest renal), sized there.
  let cur = placed;
  if (!cur) {
    const s0 = Math.min(Math.max(preferredStart(ostia, FALLBACK_S0), 0), maxStart(cl));
    cur = evaluateStent(cl, ostia, s0, sizeAt(cl, s0));
  }
  // The same search the spoken "optimize" runs, read before it animates.
  const res = optimizeStent(cl, ostia, cur);
  sess().deviceId = typeof args.device_id === 'string' ? args.device_id : null;
  if (placed) h.optimizeStent();
  if (!res.stent) return { found: false, failing_rule: ruleOfReason(res.blocker) };
  if (!placed) h.setStent(res.stent);
  return { found: true, moved_mm: r1(res.movedMm), ...stentJson(res.stent) };
}

function setThreshold(args: Json): Json {
  const value = num(args.value);
  if (value === null) return { error: 'value must be a number' };
  if (args.name === 'margin_min_mm') host!.dispatch({ kind: 'setThreshold', name: 'marginMin', value });
  else if (args.name === 'flr_min_pct') host!.dispatch({ kind: 'setThreshold', name: 'remnantMin', value });
  else return { error: 'name must be margin_min_mm or flr_min_pct' };
  return { thresholds: thresholdsOut(state.thresholds) };
}

function show(args: Json): Json {
  const h = host!;
  const data = state.data;
  if (!data) return { error: 'no case loaded' };
  const ids = Array.isArray(args.structure_ids) ? args.structure_ids.filter((x): x is string => typeof x === 'string') : [];
  const mode = args.mode;
  if (!ids.length) return { error: 'structure_ids is empty' };
  if (mode !== 'highlight' && mode !== 'isolate' && mode !== 'hide') return { error: 'mode must be highlight, isolate or hide' };
  const bad = badIds(data, ids);
  if (bad) return { error: bad };
  if (mode === 'isolate') {
    const vis: Record<string, boolean> = {};
    for (const l of data.meta.labels) vis[l.key] = ids.includes(l.key);
    state.visible = vis;
    h.refreshVisibility();
    h.dispatch({ kind: 'focus', structure: ids[0] });
  } else {
    // Highlighting shows the structure and points at it, as the spoken "show".
    for (const k of ids) h.dispatch({ kind: 'show', structure: k, on: mode === 'highlight' });
  }
  return { ok: true, structure_ids: ids, mode, visible: visibleKeys(data) };
}

function windowTool(args: Json): Json {
  const presets: PresetName[] = ['liver', 'soft', 'bone', 'lung'];
  const p = presets.find((x) => x === args.preset);
  if (!p) return { error: 'preset must be liver, soft, bone or lung' };
  host!.dispatch({ kind: 'window', preset: p });
  return { ok: true, preset: p };
}

function resect(): Json {
  const h = host!;
  const data = state.data;
  if (!data) return { error: 'no case loaded' };
  if (!isLiverCase(data)) return { error: notLiver(data.meta.kind) };
  const engine = h.engine();
  if (!engine) return { error: 'planning engine not ready' };
  if (!state.plane.on) return { error: NO_CUT };
  const p = currentPlane();
  const m = evaluatePlane(engine, p, { locate: false });
  // DECISION: v1 has no resect command; until the M5 animation the tool
  // opens a card with the resection numbers so the action is visible.
  h.showCard({
    kicker: 'Resect',
    title: 'Planned resection',
    rows: [
      { label: 'Resected', value: `${r1(m.resectedMl)} mL` },
      { label: 'Future liver remnant', value: `${r1(m.remnantPct)} %`, flag: m.remnantPct < state.thresholds.remnantMin },
      { label: 'Margin', value: `${r1(m.marginMm)} mm`, flag: m.tumorIncomplete || m.marginMm < state.thresholds.marginMin },
    ],
    notes: ['Planar cut on the planning grid. Real resections follow Couinaud segments.'],
  });
  sess().resectedAt = p;
  return { resected_ml: r1(m.resectedMl), remnant_flr_pct: r1(m.remnantPct) };
}

function writePlanTool(): Json {
  const h = host!;
  const data = state.data;
  if (!data) return { error: 'no case loaded' };
  const engine = h.engine();
  const g = h.grid();
  const on = state.plane.on;
  const m = engine && on && isLiverCase(data) ? evaluatePlane(engine, currentPlane(), { locate: false }) : null;
  const st = h.stent();
  const wasResected = resected();
  h.writePlan();
  return {
    case_id: state.caseId,
    case_kind: data.meta.kind,
    plane: on ? planeOut(currentPlane()) : null,
    metrics: m
      ? {
          ...metricsOut(m),
          tumor_incomplete: m.tumorIncomplete,
          resected_ml: r1(m.resectedMl),
          meets_targets: g && g.tumorIdx.length ? violations(m, state.thresholds).length === 0 : null,
        }
      : null,
    stent: st ? stentJson(st) : null,
    thresholds: thresholdsOut(state.thresholds),
    resected: wasResected,
  };
}

/** Run one tool call. Never throws: failures come back as `{error}`. */
export async function executeTool(name: string, args: Json | null | undefined): Promise<Json> {
  if (!host) return { error: 'the app is not ready' };
  const a = args ?? {};
  try {
    switch (name) {
      case 'get_state':
        return getState();
      case 'measure':
        return measure(a);
      case 'set_plane':
        return setPlane(a);
      case 'optimize_plane':
        return await optimizePlaneTool(a);
      case 'place_stent':
        return placeStentTool(a);
      case 'optimize_stent':
        return optimizeStentTool(a);
      case 'set_threshold':
        return setThreshold(a);
      case 'show':
        return show(a);
      case 'window':
        return windowTool(a);
      case 'resect':
        return resect();
      case 'write_plan':
        return writePlanTool();
      case 'segment_point':
        return { error: 'unavailable', reason: 'VISTA-3D point segmentation is not wired yet (M2)' };
      case 'lookup_device_rules':
        return { error: 'unavailable', reason: 'device rule lookup is not wired yet (M4); default simplified EVAR rules apply' };
      default:
        return { error: `unknown tool "${name}"` };
    }
  } catch (err) {
    console.warn('[tools]', name, err);
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
