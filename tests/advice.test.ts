/**
 * Suggestions and outcomes: rule-based, sourced, and never a personal risk.
 */

import { describe, expect, it } from 'vitest';

import { outcomes, suggestions, type AdviceFacts } from '../src/ai/advice.ts';
import { DEFAULT_THRESHOLDS } from '../src/state.ts';
import type { PlanMetrics, StentState } from '../src/types.ts';

const metrics = (o: Partial<PlanMetrics>): PlanMetrics => ({
  remnantPct: 70,
  resectedMl: 300,
  healthyRemnantMl: 800,
  marginMm: 12,
  tumorIncomplete: false,
  vesselsCrossed: 0,
  vesselName: null,
  vesselId: 0,
  nearestVesselMm: 20,
  nearestVesselId: 0,
  ...o,
});

const liver = (m: Partial<PlanMetrics>): AdviceFacts => ({
  caseKind: 'liver',
  planeOn: true,
  metrics: metrics(m),
  stent: null,
  thresholds: DEFAULT_THRESHOLDS,
});

const stent = (o: Partial<StentState>): AdviceFacts => ({
  caseKind: 'aorta',
  planeOn: false,
  metrics: null,
  stent: {
    s0: 148, lengthMm: 25, diameterMm: 23, neckMm: 25, neckMeanMm: 20, oversizePct: 15, angulationDeg: 10,
    seals: true, verdict: 'Seals.', failReason: null, ...o,
  },
  thresholds: DEFAULT_THRESHOLDS,
});

describe('suggestions', () => {
  it('a clean plan meets its constraints', () => {
    const a = suggestions(liver({}));
    expect(a.card.rows[0].label).toBe('Constraints met');
  });

  it('names each violated constraint, worst first', () => {
    const a = suggestions(liver({ marginMm: 6, vesselsCrossed: 1, vesselName: 'Hepatic vessel', remnantPct: 25 }));
    const labels = a.card.rows.map((r) => r.label);
    expect(labels.slice(0, 3)).toEqual(['Widen the margin', 'Spare or control the vessel', 'Remnant below minimum']);
    expect(a.speech).toMatch(/optimize/);
  });

  it('points a renal coverage at a distal seat or fenestrated EVAR', () => {
    const a = suggestions(stent({ seals: false, failReason: 'Right renal artery covered' }));
    expect(a.card.rows[0].ref).toMatch(/fenestrated/);
  });
});

describe('outcomes', () => {
  it('quotes the cohort band the plan falls in, never a personal probability', () => {
    for (const f of [liver({ remnantPct: 20 }), liver({ remnantPct: 60 }), stent({}), stent({ neckMm: 9 })]) {
      const a = outcomes(f);
      expect(a.card.notes?.[0]).toMatch(/not a prediction for this patient/);
      expect(a.speech).not.toMatch(/\byour risk\b/i);
      for (const r of a.card.rows) expect(r.ref ?? '').toMatch(/(19|20)\d\d|no (published )?rate|reviews/i);
    }
  });

  it('switches bands at the published cutpoints', () => {
    expect(outcomes(liver({ remnantPct: 26 })).card.rows[0].value).toBe('10 in 22');
    expect(outcomes(liver({ remnantPct: 27 })).card.rows[0].value).toBe('1 in 82');
    expect(outcomes(stent({ neckMm: 14 })).card.rows[0].flag).toBe(true);
    expect(outcomes(stent({ neckMm: 16 })).card.rows[0].flag).toBe(false);
  });

  it('a kept tumour is reported as R1-like, not as a margin', () => {
    const a = outcomes(liver({ tumorIncomplete: true, marginMm: 0 }));
    expect(a.card.rows.some((r) => /R1-like/.test(r.label))).toBe(true);
  });
});
