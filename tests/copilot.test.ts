/**
 * The imaging copilot's deterministic core: camera framing, saved plans and
 * their comparison, the closest-vessel search, and the command grammar.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { validate } from '../src/ai/intentFallback.ts';
import { allVisible, frameView, MAX_PITCH, sectionFacing, yawPitchOf } from '../src/copilot/navigation.ts';
import { PlanStore, comparePlans, comparisonSentence, type PlanSnapshot } from '../src/copilot/plans.ts';
import { cameraDir, dot } from '../src/coords.ts';
import { idsFor, nearestAmong, structureDistance } from '../src/planning/smartMeasure.ts';
import type { CaseData, CaseMeta, LabelDef, PlanMetrics, Vec3 } from '../src/types.ts';
import { parseIntent } from '../src/voice/intents.ts';

/* ------------------------------------------------------------ navigation */

const FOV = 42;

describe('camera framing', () => {
  const pts: Vec3[] = [
    [0.3, 0.1, -0.05],
    [0.36, 0.14, 0.02],
    [0.25, 0.05, -0.1],
  ];

  it('centres the region of interest, not the volume', () => {
    const v = frameView(pts, { fovDeg: FOV, aspect: 1.6, current: { yaw: 0.3, pitch: 0.8 } });
    expect(v.target[0]).toBeCloseTo((0.25 + 0.36) / 2, 6);
    expect(v.target[2]).toBeCloseTo((-0.1 + 0.02) / 2, 6);
  });

  it('keeps every point of interest inside the frustum (no clipping)', () => {
    for (const aspect of [0.6, 1, 1.6, 2.4]) {
      for (const yaw of [0, 1, 2.5, -2]) {
        const v = frameView(pts, { fovDeg: FOV, aspect, current: { yaw, pitch: 0.4 } });
        expect(allVisible(v, pts, FOV, aspect)).toBe(true);
      }
    }
  });

  it('sees a relationship side-on, with the smallest turn from the current view', () => {
    const a: Vec3 = [0, 0, 0];
    const b: Vec3 = [0.05, 0.02, 0.03];
    const u: Vec3 = [0.05, 0.02, 0.03];
    const cur = { yaw: 0.3, pitch: 0.5 };
    const v = frameView([a, b], { fovDeg: FOV, aspect: 1.6, current: cur, sideOn: u });
    const dir = cameraDir(v.yaw, v.pitch);
    const un = Math.hypot(...u);
    // The gap is perpendicular to the view, so its length reads true...
    expect(Math.abs(dot(dir, u) / un)).toBeLessThan(1e-6);
    // ...and the view is still on the same side the camera was.
    expect(dot(dir, cameraDir(cur.yaw, cur.pitch))).toBeGreaterThan(0.5);
  });

  it('never points the camera straight down a pole', () => {
    const v = frameView([[0, 0, 0], [0, 0, 0.05]], { fovDeg: FOV, aspect: 1, current: { yaw: 0, pitch: 1.5 } });
    expect(Math.abs(v.pitch)).toBeLessThanOrEqual(MAX_PITCH);
  });

  it('round-trips yaw and pitch through a direction', () => {
    const d = cameraDir(1.1, -0.4);
    const yp = yawPitchOf(d);
    expect(yp.yaw).toBeCloseTo(1.1, 9);
    expect(yp.pitch).toBeCloseTo(-0.4, 9);
  });

  it('puts the CT section through both ends of the gap, facing the camera', () => {
    const a: Vec3 = [10, 20, 30];
    const b: Vec3 = [14, 22, 30];
    const view = { yaw: 0.7, pitch: 0.3, dist: 0.5, target: [0, 0, 0] as Vec3 };
    const p = sectionFacing(a, b, view);
    expect(dot(p.n, a) - p.d).toBeCloseTo(0, 9);
    expect(dot(p.n, b) - p.d).toBeCloseTo(0, 9);
    expect(dot(p.n, cameraDir(view.yaw, view.pitch))).toBeGreaterThan(0);
  });
});

/* ----------------------------------------------------------------- plans */

const snap = (caseId: string, d: number): PlanSnapshot =>
  ({ caseId, plane: { n: [1, 0, 0], d, on: true, locked: false }, savedAt: 0 }) as unknown as PlanSnapshot;

describe('saved plans', () => {
  it('never replaces the baseline without an explicit confirmation', () => {
    const s = new PlanStore(10_000);
    expect(s.save(snap('liver', 1), 0)).toBe('saved');
    expect(s.save(snap('liver', 2), 100)).toBe('confirm');
    expect(s.baseline('liver')!.plane.d).toBe(1);
    expect(s.confirm(200)).toBe(true);
    expect(s.baseline('liver')!.plane.d).toBe(2);
  });

  it('lets a pending replace expire or be cancelled', () => {
    const s = new PlanStore(1000);
    s.save(snap('liver', 1), 0);
    s.save(snap('liver', 2), 0);
    expect(s.confirm(5000)).toBe(false);
    expect(s.baseline('liver')!.plane.d).toBe(1);
    s.save(snap('liver', 3), 0);
    expect(s.cancelPending()).toBe(true);
    expect(s.confirm(10)).toBe(false);
    expect(s.baseline('liver')!.plane.d).toBe(1);
  });

  it('keeps one baseline per case and steps back through views of that case', () => {
    const s = new PlanStore();
    s.save(snap('liver', 1));
    expect(s.baseline('aorta')).toBeNull();
    s.pushView(snap('liver', 10));
    s.pushView(snap('aorta', 20));
    s.pushView(snap('liver', 11));
    expect(s.popView('liver')!.plane.d).toBe(11);
    expect(s.popView('liver')!.plane.d).toBe(10);
    expect(s.popView('liver')).toBeNull();
  });
});

const metrics = (o: Partial<PlanMetrics>): PlanMetrics => ({
  remnantPct: 60, resectedMl: 500, healthyRemnantMl: 700, marginMm: 10, tumorIncomplete: false,
  vesselsCrossed: 1, vesselName: null, vesselId: 0, nearestVesselMm: 5, nearestVesselId: 0, ...o,
});

describe('plan comparison', () => {
  const base = { plane: { n: [1, 0, 0] as Vec3, d: 0 }, metrics: metrics({}) };
  const cur = { plane: { n: [1, 0, 0] as Vec3, d: -4 }, metrics: metrics({ remnantPct: 64.2, marginMm: 12.1, vesselsCrossed: 0, resectedMl: 450 }) };

  it('is current minus baseline, from the engine numbers', () => {
    const c = comparePlans(base, cur, [10, 0, 0]);
    expect(c.remnantPts).toBeCloseTo(4.2, 9);
    expect(c.marginMm).toBeCloseTo(2.1, 9);
    expect(c.vessels).toBe(-1);
    expect(c.resectedMl).toBe(-50);
    expect(c.angleDeg).toBeCloseTo(0, 9);
    // The cut moved 4 mm further from the anchor at x = 10.
    expect(c.shiftMm).toBeCloseTo(4, 9);
  });

  it('says what changed, and nothing about which plan is better', () => {
    const t = comparisonSentence(comparePlans(base, cur, [10, 0, 0]));
    expect(t).toBe(
      'Compared with the saved plan, the current plane keeps 4.2 percentage points more liver, changes the measured margin by plus 2.1 millimeters, and intersects 1 fewer segmented vessel component.',
    );
    expect(t).not.toMatch(/safe|better|optimal|recommend|worse/i);
  });

  it('refuses to compare margins when either plan leaves tumour behind', () => {
    const c = comparePlans(base, { ...cur, metrics: metrics({ tumorIncomplete: true, marginMm: 0 }) }, [0, 0, 0]);
    expect(c.marginComparable).toBe(false);
    expect(comparisonSentence(c)).toMatch(/not comparable/);
  });
});

/* -------------------------------------------------------- closest vessel */

/** Tumour box x 10..19; portal vein at x 30..39 (10 mm away); IVC x 23..25 (3 mm). */
function vessels(): CaseData {
  const shape: Vec3 = [50, 20, 20];
  const labels = new Uint8Array(shape[0] * shape[1] * shape[2]);
  for (let z = 5; z < 15; z++)
    for (let y = 5; y < 15; y++)
      for (let x = 0; x < 50; x++) {
        const id = x >= 10 && x < 20 ? 2 : x >= 30 && x < 40 ? 4 : x >= 23 && x < 26 && y < 8 ? 3 : 0;
        if (id) labels[x + 50 * (y + 20 * z)] = id;
      }
  const L = (id: number, key: string, role: LabelDef['role']): LabelDef => ({ id, key, name: key, color: [1, 1, 1], role });
  const meta = {
    id: 't', name: 't', kind: 'liver', shape, spacing: [1, 1, 1], origin: [0, 0, 0],
    labels: [L(2, 'tumor', 'tumor'), L(3, 'ivc', 'vessel'), L(4, 'portal_vein', 'vessel')],
  } as unknown as CaseMeta;
  return { meta, volume: new Uint8Array(labels.length), labels, centerlines: null, meshes: null };
}

describe('closest-vessel search', () => {
  it('finds the nearest vessel and agrees with the pairwise distance', () => {
    const d = vessels();
    const all = nearestAmong(d, idsFor(d, 'tumor'), [3, 4]);
    expect(all.map((c) => c.id)).toEqual([3, 4]);
    expect(all[0].mm).toBeCloseTo(3, 6);
    expect(all[1].mm).toBeCloseTo(10, 6);
    for (const c of all) expect(c.mm).toBeCloseTo(structureDistance(d, idsFor(d, 'tumor'), [c.id])!.mm, 6);
  });

  it('returns nothing rather than inventing a vessel', () => {
    const d = vessels();
    expect(nearestAmong(d, idsFor(d, 'kidney_left'), [3, 4])).toEqual([]);
    expect(idsFor(d, 'aorta')).toEqual([]);
  });
});

const dir = resolve(__dirname, '..', 'public/data/liver');
const liver: CaseData | null = existsSync(resolve(dir, 'meta.json'))
  ? {
      meta: JSON.parse(readFileSync(resolve(dir, 'meta.json'), 'utf8')) as CaseMeta,
      volume: new Uint8Array(0),
      labels: new Uint8Array(readFileSync(resolve(dir, 'labels.u8'))),
      centerlines: null,
      meshes: null,
    }
  : null;

describe.skipIf(!liver)('closest vessel on the real liver', () => {
  it('ranks every segmented vessel and the winner matches a direct pairwise measurement', () => {
    const d = liver!;
    const vesselIds = d.meta.labels.filter((l) => l.role === 'vessel').map((l) => l.id);
    const all = nearestAmong(d, idsFor(d, 'tumor'), vesselIds);
    expect(all.length).toBeGreaterThan(0);
    for (let i = 1; i < all.length; i++) expect(all[i].mm).toBeGreaterThanOrEqual(all[i - 1].mm);
    const direct = structureDistance(d, idsFor(d, 'tumor'), [all[0].id], 80)!;
    expect(all[0].mm).toBeCloseTo(direct.mm, 6);
  });
});

/* --------------------------------------------------------------- grammar */

describe('copilot grammar', () => {
  it.each([
    ['show me the tumor relative to the portal vein', { kind: 'relation', a: 'tumor', b: 'portal_vein' }],
    ['show the relationship between the aorta and the vena cava', { kind: 'relation', a: 'aorta', b: 'ivc' }],
    ['show me where the tumor is closest to a major vessel', { kind: 'nearest', a: 'tumor' }],
    ['where is the tumor closest to a vessel', { kind: 'nearest', a: 'tumor' }],
    ['focus on the left kidney', { kind: 'focus', structure: 'kidney_left' }],
    ['zoom in on the portal vein', { kind: 'focus', structure: 'portal_vein' }],
    ['save this plan', { kind: 'savePlan' }],
    ['save this as my original plan', { kind: 'savePlan' }],
    ['confirm', { kind: 'confirm' }],
    ['show me the original plan', { kind: 'restorePlan' }],
    ['go back to the original plan', { kind: 'restorePlan' }],
    ['compare this cut to the original plan', { kind: 'comparePlan' }],
    ['compare this cut with the original', { kind: 'comparePlan' }],
    ['go back to the previous view', { kind: 'previousView' }],
    ['cancel', { kind: 'cancel' }],
    ['never mind', { kind: 'cancel' }],
  ])('%s', (text, want) => expect(parseIntent(text)).toEqual(want));

  it('leaves the existing commands where they were', () => {
    expect(parseIntent('write the plan')).toEqual({ kind: 'writePlan' });
    expect(parseIntent('export the plan')).toEqual({ kind: 'writePlan' });
    expect(parseIntent('back to surgeon view')).toEqual({ kind: 'mode', mode: 'surgeon' });
    expect(parseIntent('show the tumor')).toEqual({ kind: 'show', structure: 'tumor', on: true });
    expect(parseIntent('how far is the tumor from the portal vein')).toEqual({ kind: 'distance', a: 'tumor', b: 'portal_vein' });
  });

  it('accepts typed copilot commands from the LLM, but never a confirmation', () => {
    expect(validate({ kind: 'relation', a: 'tumor', b: 'portal_vein' })).toEqual({ kind: 'relation', a: 'tumor', b: 'portal_vein' });
    expect(validate({ kind: 'relation', a: 'tumor' })).toBeNull();
    expect(validate({ kind: 'comparePlan' })).toEqual({ kind: 'comparePlan' });
    // Replacing a baseline is destructive; only an explicit spoken "confirm" may.
    expect(validate({ kind: 'confirm' })).toBeNull();
  });
});
