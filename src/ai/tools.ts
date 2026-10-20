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
 * Result shapes are mirrored by the Python twin (backend engine); keep them
 * in step. Numbers in %, mm, mL and degrees are rounded to 1 decimal.
 */

import { cross, dot, normalize } from '../coords.ts';
import type { Centerline } from '../devices/centerline.ts';
import { lowestRenal, optimizeStent, RULES, type Ostium } from '../devices/stent.ts';
import { evaluatePlane, type EngineContext } from '../planning/engine.ts';
import type { OptimizeResult } from '../planning/optimize.ts';
import { idsFor, structureDistance } from '../planning/smartMeasure.ts';
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
  /** The answer was put on screen (false when it broke a limit). */
  applied: boolean;
}

export interface OptimizeRequest {
  marginMm?: number;
  remnantPct?: number;
  priority?: 'vessels' | 'remnant';
  /** Do not apply an answer further than this from the current cut. */
  maxRotateDeg?: number;
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
  return { margin_min_mm: th.marginMin, flr_min_pct: th.remnantMin };
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
  if (rotate && rotate.deg !== 0) {
    n = normalize(rotateVec(n, AXES[rotate.axis], rotate.deg));
    d = dot(n, pivot);
  }
  return { n, d: d + offsetMm };
}

export interface StentRule {
  id: 'renal_clearance' | 'neck_length' | 'oversize_min' | 'oversize_max' | 'neck_angulation';
  pass: boolean;
  value: number;
  limit: number;
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
  // Clearance below the lowest renal ostium (negative: above it).
  const clearance = lowest === null ? 0 : st.s0 - lowest;
  return [
    { id: 'renal_clearance', pass: !covered && (lowest === null || st.s0 >= lowest), value: r1(clearance), limit: 0, unit: 'mm' },
    { id: 'neck_length', pass: st.neckMm >= RULES.neckMinMm, value: r1(st.neckMm), limit: RULES.neckMinMm, unit: 'mm' },
    { id: 'oversize_min', pass: st.oversizePct >= RULES.oversizeMinPct, value: r1(st.oversizePct), limit: RULES.oversizeMinPct, unit: '%' },
    { id: 'oversize_max', pass: st.oversizePct <= RULES.oversizeMaxPct, value: r1(st.oversizePct), limit: RULES.oversizeMaxPct, unit: '%' },
    { id: 'neck_angulation', pass: st.angulationDeg < RULES.angulationMaxDeg, value: r1(st.angulationDeg), limit: RULES.angulationMaxDeg, unit: '°' },
  ];
}

/** Native neck lumen diameter behind a device of this diameter and oversize. */
export function neckDiameter(st: StentState): number {
  return st.diameterMm / (1 + st.oversizePct / 100);
}

export function stentOut(st: StentState, deviceId: string): Json {
  return {
    device_id: deviceId,
    s0_mm: r1(st.s0),
    length_mm: r1(st.lengthMm),
    diameter_mm: r1(st.diameterMm),
    oversize_pct: r1(st.oversizePct),
    neck_mm: r1(st.neckMm),
    angulation_deg: r1(st.angulationDeg),
    seals: st.seals,
  };
}

/** What the starting cut violated, and how the search went, as stable codes. */
export function optimizeReasonCodes(o: OptimizeOutcome, req: OptimizeRequest, avoidCrossed: string[]): string[] {
  const codes: string[] = [];
  for (const v of o.res.violated) {
    codes.push({ tumor: 'start_tumor_incomplete', margin: 'start_margin_below_min', remnant: 'start_flr_below_min', vessels: 'start_crosses_vessels' }[v]);
  }
  if (o.wide) codes.push('searched_around_tumor');
  if (o.res.angleDeg < 0.5 && o.res.offsetMm < 0.5) codes.push('kept_current_plane');
  if (req.maxRotateDeg !== undefined && o.res.angleDeg > req.maxRotateDeg) codes.push('exceeds_max_rotate');
  if (req.maxOffsetMm !== undefined && o.res.offsetMm > req.maxOffsetMm) codes.push('exceeds_max_offset');
  for (const id of avoidCrossed) codes.push(`crosses_avoided:${id}`);
  if (!o.res.feasible) {
    const after = o.after;
    if (after.tumorIncomplete) codes.push('result_tumor_incomplete');
    else if (after.marginMm < o.th.marginMin) codes.push('result_margin_below_min');
    if (after.remnantPct < o.th.remnantMin) codes.push('result_flr_below_min');
    if (after.vesselsCrossed > 0) codes.push('result_crosses_vessels');
  }
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
      case 'place_stent':
        parts.push(r.seals ? `Stent placed. Neck ${r.neck_mm} mm. Seals.` : 'Stent placed. It does not seal.');
        break;
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

/* ---------------------------------------------------------------- executor */

let host: ToolHost | null = null;

export function setToolHost(h: ToolHost): void {
  host = h;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function liverCase(data: CaseData | null): string | null {
  if (!data) return 'no case loaded';
  if (data.meta.kind !== 'liver') return `the ${data.meta.kind} case has no liver segmentation to plan a cut on`;
  return null;
}

function currentPlane(): Plane {
  const p = host!.plane();
  return { n: [...p.n] as Vec3, d: p.d };
}

/** `c` projected onto plane `p`. */
function onPlane(p: Plane, c: Vec3): Vec3 {
  const k = dot(p.n, c) - p.d;
  return [c[0] - p.n[0] * k, c[1] - p.n[1] * k, c[2] - p.n[2] * k];
}

/** Keys of the structures in this case, for errors that list what exists. */
function structureKeys(data: CaseData): string[] {
  return data.meta.labels.map((l) => l.key);
}

export function getState(): Json {
  const data = state.data;
  const st = state.stent;
  return {
    case_id: state.caseId,
    case_kind: data?.meta.kind ?? null,
    mode: state.mode,
    plane: planeOut(currentPlane()),
    plane_on: state.plane.on,
    stent: st ? stentOut(st, deviceId) : null,
    thresholds: thresholdsOut(state.thresholds),
    visible: data ? data.meta.labels.filter((l) => state.visible[l.key] !== false).map((l) => l.key) : [],
  };
}

/** The device the agent last named; v1 has one generic device. */
let deviceId = 'generic';

const METHOD = {
  flr: 'kept liver voxels / all liver voxels x 100, planning grid',
  margin: 'minimum distance from the cut surface to the tumour, exact Euclidean distance transform',
  vessels_crossed: 'connected vessel components straddling the plane, inside the liver box',
  tumor_volume: 'tumour voxel count x voxel volume, planning grid',
  neck_length: 'length below the device top where the lumen stays within 10 % of the neck mean diameter',
  neck_diameter: 'mean lumen diameter over the first 15 mm below the device top',
  distance: 'closest wall-to-wall gap, Euclidean distance transform on the segmentation grid',
};

function measure(args: Json): Json {
  const h = host!;
  const what = String(args.what ?? '');
  const data = state.data;
  if (!data) return { error: 'no case loaded' };
  const out = (value: number, unit: string) => ({ what, value: unit ? r1(value) : value, unit, method: METHOD[what as keyof typeof METHOD] });
  switch (what) {
    case 'flr':
    case 'margin':
    case 'vessels_crossed': {
      const bad = liverCase(data);
      if (bad) return { error: bad };
      const engine = h.engine();
      if (!engine) return { error: 'planning engine not ready' };
      if (!state.plane.on) return { error: 'there is no cut; call set_plane or optimize_plane first' };
      const m = evaluatePlane(engine, currentPlane(), { locate: false });
      if (what === 'flr') return out(m.remnantPct, '%');
      if (what === 'vessels_crossed') return out(m.vesselsCrossed, '');
      if (m.tumorIncomplete) return { ...out(0, 'mm'), tumor_incomplete: true };
      return out(m.marginMm, 'mm');
    }
    case 'tumor_volume': {
      const g = h.grid();
      if (!g || g.tumorIdx.length === 0) return { error: 'no tumour segmented in this case' };
      return out(g.tumorMl, 'mL');
    }
    case 'neck_length':
    case 'neck_diameter': {
      const st = state.stent;
      if (!st) return { error: 'no stent placed; call place_stent first' };
      return what === 'neck_length' ? out(st.neckMm, 'mm') : out(neckDiameter(st), 'mm');
    }
    case 'distance': {
      const a = typeof args.a === 'string' ? args.a : '';
      const b = typeof args.b === 'string' ? args.b : '';
      if (!a || !b) return { error: 'distance needs a and b (structure ids)' };
      const aIds = idsFor(data, a);
      const bIds = idsFor(data, b);
      const missing = !aIds.length ? a : !bIds.length ? b : null;
      if (missing) return { error: `no structure "${missing}" in this case`, known: structureKeys(data) };
      const r = structureDistance(data, aIds, bIds, 120);
      if (!r) return { error: `${a} and ${b} are more than 120 mm apart` };
      // The same view the spoken "how far is A from B" opens.
      h.dispatch({ kind: 'distance', a, b });
      return { ...out(r.mm, 'mm'), a, b };
    }
    default:
      return { error: `unknown measurement "${what}"` };
  }
}

function setPlane(args: Json): Json {
  const h = host!;
  const bad = liverCase(state.data);
  const engine = h.engine();
  if (!engine) return { error: 'planning engine not ready' };
  if (state.plane.locked) return { error: 'the cut is locked; the user must unlock it' };
  let to: Plane;
  if (args.normal !== undefined || args.d !== undefined) {
    const n = Array.isArray(args.normal) ? args.normal.map(num) : null;
    const d = num(args.d);
    if (!n || n.length !== 3 || n.some((x) => x === null) || d === null) return { error: 'normal needs 3 numbers and d a number' };
    const len = Math.hypot(n[0]!, n[1]!, n[2]!);
    if (len < 1e-6) return { error: 'normal must not be zero' };
    to = { n: [n[0]! / len, n[1]! / len, n[2]! / len], d: d / len };
  } else {
    const rot = args.rotate_deg as { axis?: unknown; deg?: unknown } | undefined;
    const axis = rot && (rot.axis === 'x' || rot.axis === 'y' || rot.axis === 'z') ? rot.axis : null;
    const deg = rot ? num(rot.deg) : null;
    if (rot && (axis === null || deg === null)) return { error: 'rotate_deg needs axis x|y|z and deg' };
    const off = args.offset_mm === undefined ? 0 : num(args.offset_mm);
    if (off === null) return { error: 'offset_mm must be a number' };
    if (!rot && off === 0) return { error: 'give normal and d, or rotate_deg and/or offset_mm' };
    if (!state.plane.on) return { error: 'there is no cut to move; give normal and d, or call optimize_plane' };
    const from = currentPlane();
    to = movePlaneBy(from, onPlane(from, h.pivotPoint()), axis && deg !== null ? { axis, deg } : null, off);
  }
  h.placeCut(to);
  const res: Json = { plane: planeOut(to) };
  if (bad) return { ...res, note: bad };
  const m = evaluatePlane(engine, to, { locate: false });
  return { ...res, ...metricsOut(m), tumor_incomplete: m.tumorIncomplete };
}

async function optimizePlaneTool(args: Json): Promise<Json> {
  const h = host!;
  const bad = liverCase(state.data);
  if (bad) return { error: bad };
  const data = state.data!;
  const avoid = Array.isArray(args.avoid) ? args.avoid.filter((x): x is string => typeof x === 'string') : [];
  const unknown = avoid.filter((k) => idsFor(data, k).length === 0);
  if (unknown.length) return { error: `no structure "${unknown[0]}" in this case`, known: structureKeys(data) };
  const avoidIds = new Set(avoid.flatMap((k) => idsFor(data, k)));
  const req: OptimizeRequest = {};
  const margin = num(args.margin_min_mm);
  const flr = num(args.flr_min_pct);
  if (margin !== null && margin > 0) req.marginMm = margin;
  if (flr !== null && flr > 0 && flr < 100) req.remnantPct = flr;
  // DECISION: the search already penalises every vessel it crosses; naming
  // vessels to avoid switches it to the vessels-first weights (the spoken
  // "spare the vessels"). The search cone itself is fixed by the engine, so
  // max_rotate_deg / max_offset_mm are enforced on the answer: one beyond
  // them is reported, not applied.
  const vesselIds = new Set(data.meta.labels.filter((l) => l.role === 'vessel').map((l) => l.id));
  if ([...avoidIds].some((id) => vesselIds.has(id))) req.priority = 'vessels';
  const maxRot = num(args.max_rotate_deg);
  const maxOff = num(args.max_offset_mm);
  if (maxRot !== null) req.maxRotateDeg = maxRot;
  if (maxOff !== null) req.maxOffsetMm = maxOff;
  const o = await h.optimize(req);
  if (!o) return { error: 'the optimizer found no cut' };
  const crossed = [...new Set((o.after.vesselCuts ?? []).map((c) => c.id))]
    .filter((id) => avoidIds.has(id))
    .map((id) => data.meta.labels.find((l) => l.id === id)?.key ?? String(id));
  return {
    plane: planeOut(o.res.plane),
    before: metricsOut(o.before),
    after: metricsOut(o.after),
    feasible: o.res.feasible && crossed.length === 0,
    applied: o.applied,
    reason_codes: optimizeReasonCodes(o, req, crossed),
    angle_deg: r1(o.res.angleDeg),
    offset_mm: r1(o.res.offsetMm),
  };
}

function stentReady(): string | null {
  const h = host!;
  if (state.data?.meta.kind !== 'aorta') return 'stent grafts are planned on the aorta case; this case is not one';
  if (!h.stentCenterline()) return 'no aortic centerline in this case';
  return null;
}

function placeStentTool(args: Json): Json {
  const h = host!;
  const bad = stentReady();
  if (bad) return { error: bad };
  deviceId = typeof args.device_id === 'string' && args.device_id ? args.device_id : 'generic';
  const s0 = num(args.s0_mm);
  const len = num(args.length_mm);
  const cl = h.stentCenterline()!;
  if (s0 !== null && (s0 < 0 || s0 > cl.length)) return { error: `s0_mm must be within the centerline, 0 to ${r1(cl.length)} mm` };
  const st = h.placeStent(s0 ?? undefined, len ?? undefined);
  if (!st) return { error: 'could not place the stent' };
  return { ...stentOut(st, deviceId), rules: stentRules(st, h.stentOstia()), rules_source: 'default simplified EVAR rules' };
}

function optimizeStentTool(args: Json): Json {
  const h = host!;
  const bad = stentReady();
  if (bad) return { error: bad };
  const st = state.stent;
  if (!st) return { error: 'no stent placed; call place_stent first' };
  if (typeof args.device_id === 'string' && args.device_id) deviceId = args.device_id;
  if (st.seals) return { found: true, moved_mm: 0, ...stentOut(st, deviceId) };
  // The same search the spoken "optimize" runs, read before it animates.
  const res = optimizeStent(h.stentCenterline()!, h.stentOstia(), st);
  h.optimizeStent();
  if (!res.stent) return { found: false, failing_rule: res.blocker ?? 'no position passes every rule', search_mm: 40 };
  return { found: true, moved_mm: r1(res.movedMm), ...stentOut(res.stent, deviceId), rules: stentRules(res.stent, h.stentOstia()) };
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
  const unknown = ids.filter((k) => k !== 'all' && idsFor(data, k).length === 0);
  if (unknown.length) return { error: `no structure "${unknown[0]}" in this case`, known: structureKeys(data) };
  if (mode === 'isolate') {
    const keep = new Set(ids.flatMap((k) => idsFor(data, k)));
    const vis: Record<string, boolean> = {};
    for (const l of data.meta.labels) vis[l.key] = keep.has(l.id);
    state.visible = vis;
    h.refreshVisibility();
    h.dispatch({ kind: 'focus', structure: ids[0] });
  } else {
    for (const k of ids) h.dispatch({ kind: 'show', structure: k, on: mode === 'highlight' });
  }
  return { ok: true, mode, structure_ids: ids };
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
  const bad = liverCase(state.data);
  if (bad) return { error: bad };
  const engine = h.engine();
  if (!engine) return { error: 'planning engine not ready' };
  if (!state.plane.on) return { error: 'there is no cut; call set_plane or optimize_plane first' };
  const m = evaluatePlane(engine, currentPlane(), { locate: false });
  if (m.tumorIncomplete) return { error: 'the cut leaves tumour on the remnant side; move the plane first', ...metricsOut(m) };
  // DECISION: v1 has no resect command; until the M5 animation the tool
  // opens a card with the resection numbers so the action is visible.
  h.showCard({
    kicker: 'Resect',
    title: 'Planned resection',
    rows: [
      { label: 'Resected', value: `${r1(m.resectedMl)} mL` },
      { label: 'Future liver remnant', value: `${r1(m.remnantPct)} %`, flag: m.remnantPct < state.thresholds.remnantMin },
      { label: 'Margin', value: `${r1(m.marginMm)} mm`, flag: m.marginMm < state.thresholds.marginMin },
    ],
    notes: ['Planar cut on the planning grid. Real resections follow Couinaud segments.'],
  });
  return { resected_ml: r1(m.resectedMl), remnant_flr_pct: r1(m.remnantPct) };
}

function writePlanTool(): Json {
  const h = host!;
  const data = state.data;
  if (!data) return { error: 'no case loaded' };
  const engine = h.engine();
  const g = h.grid();
  const m = engine && state.plane.on && data.meta.kind === 'liver' ? evaluatePlane(engine, currentPlane(), { locate: false }) : null;
  const st = state.stent;
  h.writePlan();
  return {
    case_id: state.caseId,
    case_name: data.meta.name,
    case_kind: data.meta.kind,
    plane: state.plane.on ? planeOut(currentPlane()) : null,
    metrics: m ? { ...metricsOut(m), tumor_incomplete: m.tumorIncomplete, resected_ml: r1(m.resectedMl) } : null,
    stent: st ? { ...stentOut(st, deviceId), rules: stentRules(st, h.stentOstia()) } : null,
    thresholds: thresholdsOut(state.thresholds),
    organ_ml: g && g.organIdx.length ? r1(g.organMl) : null,
    tumor_ml: g && g.tumorIdx.length ? r1(g.tumorMl) : null,
    files: state.plane.on ? ['plan.md', 'plane.json'] : ['plan.md'],
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
        return { error: 'unavailable', reason: 'VISTA-3D point segmentation is not deployed yet' };
      case 'lookup_device_rules':
        return { error: 'unavailable', reason: 'device rule lookup is not deployed yet; default simplified EVAR rules apply' };
      default:
        return { error: `unknown tool "${name}"` };
    }
  } catch (err) {
    console.warn('[tools]', name, err);
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
