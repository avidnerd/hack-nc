/**
 * The imaging copilot: "Scrub, show me …" turned into the view a surgeon
 * would otherwise have to direct someone to click through to.
 *
 *   relation      both structures found, closest wall-to-wall gap measured,
 *                 camera flown to see it side-on, both highlighted, the line
 *                 and its mm drawn on the anatomy
 *   nearest       one distance field from the tumour read off for every
 *                 segmented vessel: the closest one, shown the same way plus
 *                 a CT section through the gap
 *   focus         fly to one structure and highlight it
 *   save/restore  a baseline plan (overwrite needs "confirm") and a history
 *                 of views to step back through
 *   compare       baseline vs current through the same planning engine, both
 *                 planes drawn, the differences stated without judgement
 *
 * Every number comes from the deterministic modules (smartMeasure, engine);
 * nothing here invents a coordinate, an id or a measurement. If a structure
 * is not in the segmentation the answer says so. A failure restores the view
 * it started from. Manual control is never locked: the camera orbits the
 * framed target, so hands, mouse and keys adjust from there.
 */

import { worldToObject, type Frame } from '../coords.ts';
import { evaluatePlane, type EngineContext } from '../planning/engine.ts';
import { idsFor, nearestAmong, structureDistance, type StructureDistance } from '../planning/smartMeasure.ts';
import { voxelsOf } from '../planning/anatomyMeasure.ts';
import type { PlanningGrid } from '../planning/volume.ts';
import { patch, say, set, state, toast } from '../state.ts';
import type { CameraState } from '../state.ts';
import type { CardContent } from '../ui/infoCard.ts';
import type { Plane, PresetName, StentState, Vec3 } from '../types.ts';
import { frameView, sectionFacing, type View } from './navigation.ts';
import { PlanStore, comparePlans, comparisonSentence, snapshot, type PlanSnapshot } from './plans.ts';

export interface CopilotDeps {
  engine: () => EngineContext | null;
  grid: () => PlanningGrid | null;
  frame: () => Frame | null;
  tweenCamera: (to: Partial<CameraState>, ms?: number) => void;
  /** Stop any running camera / plane animation (cancel). */
  stopTweens: () => void;
  showCard: (c: CardContent) => void;
  setPreset: (p: PresetName) => void;
  restoreStent: (st: StentState | null) => void;
  rebuildPalette: () => void;
  noteMeasured: () => void;
}

/** The renderer's vertical field of view (volumeRenderer.ts). */
const FOV_DEG = 42;

export class Copilot {
  readonly plans = new PlanStore();
  /** The plane placed as a viewing section, to notice when it is moved. */
  private section: Plane | null = null;

  constructor(private readonly deps: CopilotDeps) {}

  /* ------------------------------------------------------------ helpers */

  private name(id: number): string {
    return state.data?.meta.labels.find((l) => l.id === id)?.name ?? 'structure';
  }

  /** How a label is spoken; the combined intrahepatic tree stays generic. */
  private spoken(id: number): string {
    const key = state.data?.meta.labels.find((l) => l.id === id)?.key;
    // TotalSegmentator's liver_vessels label does not separate hepatic from
    // portal branches, so it is never named as either.
    if (key === 'hepatic_vessels') return 'intrahepatic vessel';
    return this.name(id).toLowerCase();
  }

  private groupName(key: string, ids: number[]): string {
    return ids.length === 1 ? this.spoken(ids[0]) : key.replace('_', ' ');
  }

  /** World-space bounding-box corners of some labels (for framing). */
  private corners(ids: number[]): Vec3[] {
    const d = state.data!;
    const v = { shape: d.meta.shape, spacing: d.meta.spacing, origin: d.meta.origin, labels: d.labels };
    const idx = voxelsOf(v, ids);
    if (idx.length === 0) return [];
    const [nx, ny] = d.meta.shape;
    const lo: Vec3 = [Infinity, Infinity, Infinity];
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const id of idx) {
      const i = id % nx;
      const j = ((id - i) / nx) % ny;
      const p = [i, j, Math.floor(id / (nx * ny))];
      for (let k = 0; k < 3; k++) {
        const w = d.meta.origin[k] + p[k] * d.meta.spacing[k];
        lo[k] = Math.min(lo[k], w);
        hi[k] = Math.max(hi[k], w);
      }
    }
    return [lo, hi];
  }

  private view(pointsWorld: Vec3[], sideOn?: Vec3): View | null {
    const f = this.deps.frame();
    if (!f || pointsWorld.length === 0) return null;
    return frameView(
      pointsWorld.map((p) => worldToObject(f, p)),
      { fovDeg: FOV_DEG, aspect: window.innerWidth / Math.max(1, window.innerHeight), current: state.camera, sideOn },
    );
  }

  /** Make labels visible (a request to see them overrides hiding). */
  private reveal(ids: number[]): void {
    const vis = { ...state.visible };
    for (const id of ids) {
      const key = state.data?.meta.labels.find((l) => l.id === id)?.key;
      if (key) vis[key] = true;
    }
    set('visible', vis);
    this.deps.rebuildPalette();
  }

  /**
   * Run a navigation with visible progress, the starting view pushed to the
   * history, and that view restored if anything throws.
   */
  private run(busy: string, body: () => void): void {
    if (!state.data) return;
    const before = snapshot(state);
    toast(busy, 'info');
    // Let the toast paint before the distance field runs.
    window.setTimeout(() => {
      try {
        this.plans.pushView(before);
        body();
      } catch (err) {
        console.error('[copilot]', err);
        this.apply(before, false);
        say("Couldn't do that. The view is unchanged.");
      }
    }, 30);
  }

  private showRelationship(aIds: number[], bIds: number[], r: StructureDistance, label: string, extra: Vec3[]): View | null {
    this.reveal([...aIds, ...bIds]);
    set('focus', [...aIds, ...bIds]);
    set('caliper', { a: r.a, b: r.b, mm: r.mm, label });
    const sideOn: Vec3 = [r.b[0] - r.a[0], r.b[1] - r.a[1], r.b[2] - r.a[2]];
    const v = this.view([r.a, r.b, ...extra], Math.hypot(...sideOn) > 0.5 ? sideOn : undefined);
    if (v) this.deps.tweenCamera(v, 650);
    this.deps.noteMeasured();
    return v;
  }

  /** Frame the smaller structure plus the gap; a whole liver would dwarf it. */
  private extraFor(aIds: number[], bIds: number[]): Vec3[] {
    const ca = this.corners(aIds);
    const cb = this.corners(bIds);
    const size = (c: Vec3[]) => (c.length ? Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1], c[1][2] - c[0][2]) : Infinity);
    const small = size(ca) <= size(cb) ? ca : cb;
    return size(small) < 140 ? small : [];
  }

  /* ----------------------------------------------------------- commands */

  /** "Show me the tumour relative to the portal vein" (and "how far …"). */
  relation(a: string, b: string): void {
    const d = state.data;
    if (!d) return;
    const aIds = idsFor(d, a);
    const bIds = idsFor(d, b);
    const missing = !aIds.length ? a : !bIds.length ? b : null;
    if (missing) {
      say(`There is no ${missing.replace('_', ' ')} in this segmentation.`);
      return;
    }
    const an = this.groupName(a, aIds);
    const bn = this.groupName(b, bIds);
    this.run(`Measuring ${an} to ${bn}…`, () => {
      const r = structureDistance(d, aIds, bIds);
      if (!r) {
        this.reveal([...aIds, ...bIds]);
        set('focus', [...aIds, ...bIds]);
        const v = this.view([...this.corners(aIds), ...this.corners(bIds)]);
        if (v) this.deps.tweenCamera(v, 650);
        say(`The ${an} and the ${bn} are more than 6 centimeters apart.`);
        return;
      }
      const label = `${cap(an)} to ${bn}`;
      this.showRelationship(aIds, bIds, r, label, this.extraFor(aIds, bIds));
      const mm = Math.round(r.mm);
      const margin = state.thresholds.marginMin;
      const vesselish = aIds.concat(bIds).some((id) => d.meta.labels.find((l) => l.id === id)?.role === 'vessel');
      this.deps.showCard({
        kicker: 'Relationship',
        title: label,
        rows: [{ label: 'Closest wall-to-wall gap', value: r.touching ? 'in contact' : `${r.mm.toFixed(1)} mm` }],
        notes: [
          'Closest points joined. Edge to edge on the segmentation grid (±1 voxel).',
          ...(vesselish && aIds.some((id) => d.meta.labels.find((l) => l.id === id)?.role === 'tumor')
            ? [r.mm < margin
                ? `Closer than your ${margin} mm margin target on this side.`
                : `Beyond your ${margin} mm margin target.`]
            : []),
        ],
      });
      say(r.touching ? `The ${an} touches the ${bn}.` : `The ${an} is ${mm} millimeter${mm === 1 ? '' : 's'} from the ${bn}.`);
    });
  }

  /** "Show me where the tumour is closest to a major vessel." */
  nearest(a: string): void {
    const d = state.data;
    if (!d) return;
    const aIds = idsFor(d, a);
    if (!aIds.length) {
      say(`There is no ${a.replace('_', ' ')} in this segmentation.`);
      return;
    }
    const vessels = d.meta.labels.filter((l) => l.role === 'vessel').map((l) => l.id);
    if (!vessels.length) {
      say('There are no segmented vessels in this case.');
      return;
    }
    const an = this.groupName(a, aIds);
    this.run(`Searching every segmented vessel for the closest to the ${an}…`, () => {
      const all = nearestAmong(d, aIds, vessels);
      if (!all.length) {
        say(`No segmented vessel lies within 8 centimeters of the ${an}.`);
        return;
      }
      const best = all[0];
      const vn = this.spoken(best.id);
      const label = `${cap(an)} to ${vn}`;
      // The question is about one spot, so frame a 4 cm box around the gap,
      // not the whole tumour: the finding should fill the screen.
      const mid: Vec3 = [(best.a[0] + best.b[0]) / 2, (best.a[1] + best.b[1]) / 2, (best.a[2] + best.b[2]) / 2];
      const box: Vec3[] = [
        [mid[0] - 20, mid[1] - 20, mid[2] - 20],
        [mid[0] + 20, mid[1] + 20, mid[2] + 20],
      ];
      const v = this.showRelationship(aIds, [best.id], best, label, box);
      // A CT section through the gap, facing the camera, unless the surgeon
      // has locked a resection plane (that is theirs; we only move the camera).
      if (v && !state.plane.locked) {
        const sec = sectionFacing(best.a, best.b, v);
        this.section = sec;
        patch('plane', { n: sec.n, d: sec.d, on: true });
        set('viewSection', true);
      }
      this.deps.showCard({
        kicker: 'Closest vessel',
        title: label,
        rows: all.slice(0, 4).map((c, i) => ({
          label: `${i === 0 ? 'Closest: ' : ''}${cap(this.spoken(c.id))}`,
          value: c.touching ? 'in contact' : `${c.mm.toFixed(1)} mm`,
          flag: i === 0 && c.mm < state.thresholds.marginMin,
        })),
        notes: [
          'Every segmented vessel searched; closest points joined, CT section through the gap.',
          ...(d.meta.labels.some((l) => l.key === 'hepatic_vessels')
            ? ['"Intrahepatic vessel" is TotalSegmentator’s combined liver-vessel label: hepatic and portal branches are not separated.']
            : []),
        ],
      });
      const mm = Math.round(best.mm);
      say(best.touching ? `The ${an} touches the ${vn}.` : `Closest vessel: the ${vn}, ${mm} millimeter${mm === 1 ? '' : 's'} from the ${an}.`);
    });
  }

  /** "Focus on the left kidney." */
  focus(structure: string): void {
    const d = state.data;
    if (!d) return;
    const ids = idsFor(d, structure);
    if (!ids.length) {
      say(`There is no ${structure.replace('_', ' ')} in this segmentation.`);
      return;
    }
    const n = this.groupName(structure, ids);
    this.run(`Focusing on the ${n}…`, () => {
      this.reveal(ids);
      set('focus', ids);
      const v = this.view(this.corners(ids));
      if (v) this.deps.tweenCamera(v, 650);
      say(`${cap(n)}.`);
    });
  }

  saveBaseline(): void {
    if (!state.data) return;
    const r = this.plans.save(snapshot(state));
    say(r === 'saved' ? 'Saved as the original plan.' : 'An original plan is already saved. Say: Scrub, confirm, to replace it.');
  }

  confirm(): void {
    say(this.plans.confirm() ? 'Original plan replaced.' : 'Nothing to confirm.');
  }

  restoreBaseline(): void {
    const b = this.plans.baseline(state.caseId);
    if (!b) {
      say('No original plan is saved yet. Say: Scrub, save this plan.');
      return;
    }
    this.plans.pushView(snapshot(state));
    this.apply(b, true);
    const eng = this.deps.engine();
    const m = eng && b.plane.on ? evaluatePlane(eng, b.plane) : null;
    say(
      m && state.data?.meta.kind === 'liver'
        ? `Original plan restored. Margin ${Math.round(m.marginMm)} millimeters, remnant ${Math.round(m.remnantPct)} percent.`
        : 'Original plan restored.',
    );
  }

  compare(): void {
    const b = this.plans.baseline(state.caseId);
    const eng = this.deps.engine();
    if (!b) {
      say('No original plan is saved yet. Say: Scrub, save this plan.');
      return;
    }
    if (!eng || !b.plane.on || !state.plane.on) {
      say(b.plane.on ? 'There is no current cut to compare.' : 'The saved plan has no cut to compare.');
      return;
    }
    const base = { plane: { n: b.plane.n, d: b.plane.d }, metrics: evaluatePlane(eng, b.plane) };
    const cur = { plane: { n: state.plane.n, d: state.plane.d }, metrics: evaluatePlane(eng, state.plane) };
    const g = this.deps.grid();
    const anchor = g?.tumorCentroid() ?? g?.organCentroid() ?? [0, 0, 0];
    const c = comparePlans(base, cur, anchor);
    set('ghostPlane', base.plane);
    const fmt = (x: number, unit: string, dp = 1) => `${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs(x).toFixed(dp)}${unit}`;
    const bm = base.metrics;
    const cm = cur.metrics;
    const margin = (m: typeof bm) => (m.tumorIncomplete ? 'tumour kept' : `${m.marginMm.toFixed(1)} mm`);
    this.deps.showCard({
      kicker: 'Plan comparison',
      title: 'Original / current',
      rows: [
        { label: 'Tumour margin', value: `${margin(bm)} / ${margin(cm)}`, ref: c.marginComparable ? fmt(c.marginMm, ' mm') : 'not comparable' },
        { label: 'Liver remnant', value: `${bm.remnantPct.toFixed(1)} / ${cm.remnantPct.toFixed(1)} %`, ref: `${fmt(c.remnantPts, ' points')}` },
        { label: 'Resected volume', value: `${Math.round(bm.resectedMl)} / ${Math.round(cm.resectedMl)} mL`, ref: fmt(c.resectedMl, ' mL', 0) },
        { label: 'Vessel components crossed', value: `${bm.vesselsCrossed} / ${cm.vesselsCrossed}`, ref: fmt(c.vessels, '', 0) },
        { label: 'Plane change', value: `${c.angleDeg.toFixed(1)}°`, ref: `${fmt(c.shiftMm, ' mm')} from the ${g?.tumorCentroid() ? 'tumour' : 'organ'} centre` },
      ],
      notes: ['Dashed outline: the original plane. Geometric differences only, not a judgement of which plan is safer.'],
    });
    say(comparisonSentence(c));
  }

  previousView(): void {
    const s = this.plans.popView(state.caseId);
    if (!s) {
      say('No previous view.');
      return;
    }
    this.apply(s, true);
    say('Previous view.');
  }

  cancel(): void {
    this.deps.stopTweens();
    const dropped = this.plans.cancelPending();
    set('focus', []);
    set('ghostPlane', null);
    say(dropped ? 'Cancelled. The original plan is unchanged.' : 'Cancelled.');
  }

  /* ---------------------------------------------------------- lifecycle */

  /** Put a snapshot back: same plane through the same engine, same view. */
  apply(s: PlanSnapshot, animate: boolean): void {
    patch('plane', s.plane);
    if (animate) this.deps.tweenCamera(s.camera, 600);
    else set('camera', structuredClone(s.camera));
    set('visible', { ...s.visible });
    set('highlight', s.highlight);
    set('focus', [...s.focus]);
    set('caliper', structuredClone(s.caliper));
    patch('thresholds', s.thresholds);
    set('ghostPlane', null);
    if (s.preset !== state.preset) this.deps.setPreset(s.preset);
    this.deps.restoreStent(s.stent);
    this.section = s.viewSection ? { n: s.plane.n, d: s.plane.d } : null;
    set('viewSection', s.viewSection);
    this.deps.rebuildPalette();
  }

  /** Per frame: a viewing section stops being one once anything moves it. */
  tick(): void {
    if (!state.viewSection) return;
    const s = this.section;
    const p = state.plane;
    const moved = !s || !p.on || Math.abs(p.d - s.d) > 0.01 || Math.abs(p.n[0] - s.n[0]) + Math.abs(p.n[1] - s.n[1]) + Math.abs(p.n[2] - s.n[2]) > 1e-4;
    if (moved) {
      this.section = null;
      set('viewSection', false);
    }
  }

  /** New case: views and the baseline belong to the case they were made in. */
  onCase(): void {
    this.plans.clearHistory();
    this.section = null;
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
