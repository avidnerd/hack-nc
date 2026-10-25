import { describe, expect, it } from 'vitest';

import { validate } from '../src/ai/intentFallback.ts';
import { optimizeReason, patientNarration, planMarkdown, planSummary, sameNumbers, shiftReply } from '../src/ai/narrate.ts';
import type { OptimizeResult } from '../src/planning/optimize.ts';
import { DEFAULT_THRESHOLDS } from '../src/state.ts';
import { parseIntent, stripWake } from '../src/voice/intents.ts';

describe('wake word', () => {
  it.each([
    ['Scrub, place the stent', 'place the stent'],
    ['scrub plus bone window', 'bone window'],
    ['Scrubs optimize', 'optimize'],
    ['hey scrub show the patient', 'show the patient'],
  ])('%s', (raw, cmd) => expect(stripWake(raw)).toBe(cmd));

  it('ignores speech without it', () => {
    expect(stripWake('place the stent')).toBeNull();
    expect(stripWake('I think we should optimize')).toBeNull();
  });
});

// Every example phrase from the spec's intent table (§6.6).
describe('intent grammar', () => {
  it.each([
    ['bone window', { kind: 'window', preset: 'bone' }],
    ['soft tissue', { kind: 'window', preset: 'soft' }],
    ['lung window', { kind: 'window', preset: 'lung' }],
    ['liver window', { kind: 'window', preset: 'liver' }],
    ['show the tumor', { kind: 'show', structure: 'tumor', on: true }],
    ['show vessels', { kind: 'show', structure: 'vessels', on: true }],
    ['show the aorta', { kind: 'show', structure: 'aorta', on: true }],
    ['hide skin', { kind: 'show', structure: 'skin', on: false }],
    ['place the stent', { kind: 'placeStent' }],
    ['deploy a stent', { kind: 'placeStent' }],
    ['put in a stent', { kind: 'placeStent' }],
    ['remove the stent', { kind: 'removeDevice' }],
    ['optimize', { kind: 'optimize' }],
    ['fix the plane', { kind: 'optimize' }],
    ['find a better cut', { kind: 'optimize' }],
    ['is it possible to optimize the plane within a 30mm margin of the tumor', { kind: 'optimize', marginMm: 30, preview: true }],
    ['optimize with a margin of fifteen', { kind: 'optimize', marginMm: 15 }],
    ['optimize keeping 35 percent remnant and a 1 cm margin', { kind: 'optimize', marginMm: 10, remnantPct: 35 }],
    ['measure the neck', { kind: 'measure', what: 'neck' }],
    ['measure the left kidney', { kind: 'measure', what: 'kidney_left' }],
    ['how wide is the vena cava', { kind: 'measure', what: 'ivc' }],
    ['measure the portal vein', { kind: 'measure', what: 'portal_vein' }],
    ['make a sagittal cut through the tumor', { kind: 'cut', orientation: 'sagittal', through: 'tumor', offsetMm: null }],
    ['coronal cut 10 millimeters from the tumor', { kind: 'cut', orientation: 'coronal', through: 'tumor', offsetMm: 10 }],
    ['axial slice 2 centimeters from the tumour', { kind: 'cut', orientation: 'axial', through: 'tumor', offsetMm: 20 }],
    ['transverse cut at the renal arteries', { kind: 'cut', orientation: 'axial', through: 'renal_arteries', offsetMm: null }],
    ['how far is the tumor from the portal vein', { kind: 'distance', a: 'tumor', b: 'portal_vein' }],
    ['distance between the aorta and the vena cava', { kind: 'distance', a: 'aorta', b: 'ivc' }],
    ['how close is the portal vein', { kind: 'distance', a: 'tumor', b: 'portal_vein' }],
    ["what's the margin", { kind: 'query', what: 'margin' }],
    ['how much liver is left', { kind: 'query', what: 'remnant' }],
    ['which vessels does it cross', { kind: 'query', what: 'vessels' }],
    ["what's the diameter of the tumor", { kind: 'measure', what: 'tumor' }],
    ['what do you suggest', { kind: 'suggest' }],
    ['any recommendations', { kind: 'suggest' }],
    ['what are the risks', { kind: 'outcomes' }],
    ['simulate the outcome', { kind: 'outcomes' }],
    ['what would happen after this cut', { kind: 'outcomes' }],
    ['measure the tumor', { kind: 'measure', what: 'tumor' }],
    ['how big is the tumor', { kind: 'measure', what: 'tumor' }],
    ['lock', { kind: 'lock', on: true }],
    ['hold it', { kind: 'lock', on: true }],
    ['unlock', { kind: 'lock', on: false }],
    ['reset', { kind: 'reset' }],
    ['start over', { kind: 'reset' }],
    ['show the patient', { kind: 'mode', mode: 'patient' }],
    ['patient view', { kind: 'mode', mode: 'patient' }],
    ['back to surgeon view', { kind: 'mode', mode: 'surgeon' }],
    ['write the plan', { kind: 'writePlan' }],
    ['summarize', { kind: 'writePlan' }],
    ['set margin to 8 millimeters', { kind: 'setThreshold', name: 'marginMin', value: 8 }],
    ['remnant minimum 25 percent', { kind: 'setThreshold', name: 'remnantMin', value: 25 }],
    ['load the liver case', { kind: 'loadCase', id: 'liver' }],
    ['load the aorta case', { kind: 'loadCase', id: 'aorta' }],
  ])('"%s"', (phrase, intent) => expect(parseIntent(phrase)).toEqual(intent));

  // Natural planning talk, from a session of typed what-ifs.
  it.each([
    ['what if I wanted a 20 millimeter margin', { kind: 'optimize', marginMm: 20, preview: true }],
    ['how much liver would be left with a 2 centimeter margin', { kind: 'optimize', marginMm: 20, preview: true }],
    ['what if the margin were fifteen and we kept 50 percent', { kind: 'optimize', marginMm: 15, remnantPct: 50, preview: true }],
    ['optimize but keep at least 40 percent of the liver', { kind: 'optimize', remnantPct: 40 }],
    ['is there a cut that avoids all the vessels', { kind: 'optimize', priority: 'vessels', preview: true }],
    ['can we spare the hepatic vein', { kind: 'optimize', priority: 'vessels' }],
    ['optimize without crossing any vessels even if the margin is smaller', { kind: 'optimize', priority: 'vessels' }],
    ['can the cut be angled to stay further from the portal vein', { kind: 'optimize', priority: 'vessels' }],
    ['optimize for maximum remnant', { kind: 'optimize', priority: 'remnant' }],
    ['can you make the margin bigger', { kind: 'optimize', widen: true }],
    ['give the tumor more breathing room', { kind: 'optimize', widen: true }],
    ["what's the best cut", { kind: 'optimize' }],
    ['what if I move the plane 5 millimeters closer to the tumor', { kind: 'shiftPlane', mm: 5, preview: true }],
    ['move the cut 3 millimeters away from the tumor', { kind: 'shiftPlane', mm: -3 }],
    ['do it', { kind: 'applyPreview' }],
    ['use that one', { kind: 'applyPreview' }],
    ['undo', { kind: 'undo' }],
    ['go back to my cut', { kind: 'undo' }],
    ['go back to the previous view', { kind: 'previousView' }],
    ['why did you move the plane', { kind: 'explain' }],
    ['how come it tilted like that', { kind: 'explain' }],
    ["what's limiting the margin", { kind: 'explain', about: 'margin' }],
    ["why can't you avoid the vessel", { kind: 'explain', about: 'vessels' }],
    ["what's the tradeoff between margin and vessels here", { kind: 'explain', about: 'vessels' }],
    ['is this cut safe', { kind: 'query', what: 'summary' }],
    ['how close is the cut to the tumor', { kind: 'query', what: 'margin' }],
    ['set margin to twenty five', { kind: 'setThreshold', name: 'marginMin', value: 25 }],
  ])('"%s"', (phrase, intent) => expect(parseIntent(phrase)).toEqual(intent));

  // Placing and steering the cut by voice alone.
  it.each([
    ['tilt the cut 10 degrees to the left', { kind: 'tiltPlane', dir: 'left', deg: 10 }],
    ['angle the plane down a bit', { kind: 'tiltPlane', dir: 'down', deg: 5 }],
    ['rotate it clockwise 20 degrees', { kind: 'tiltPlane', dir: 'clockwise', deg: 20 }],
    ['tilt it counterclockwise', { kind: 'tiltPlane', dir: 'counterclockwise', deg: 10 }],
    ['tilt it fifteen degrees toward me', { kind: 'tiltPlane', dir: 'toward', deg: 15 }],
    ['what if I tilt the cut 15 degrees up', { kind: 'tiltPlane', dir: 'up', deg: 15, preview: true }],
    ['straighten the cut', { kind: 'straightenPlane' }],
    ['make a cut 15 millimeters from the tumor', { kind: 'cut', orientation: 'oblique', through: 'tumor', offsetMm: 15 }],
    ['give me an oblique cut', { kind: 'cut', orientation: 'oblique', through: null, offsetMm: null }],
    ['cut between the tumor and the portal vein', { kind: 'cut', orientation: 'oblique', through: 'tumor', offsetMm: null, between: 'portal_vein' }],
    ['make a sagittal cut 12 millimeters from the tumor', { kind: 'cut', orientation: 'sagittal', through: 'tumor', offsetMm: 12 }],
    ['show me the tumor relative to the portal vein', { kind: 'relation', a: 'tumor', b: 'portal_vein' }],
  ])('"%s"', (phrase, intent) => expect(parseIntent(phrase)).toEqual(intent));

  it('a question that only mentions the cut does not switch the plane on', () => {
    expect(parseIntent('is the cut too close to anything')).toBeNull();
    expect(parseIntent('show the cut')).toEqual({ kind: 'plane', on: true });
    expect(parseIntent('hide the plane')).toEqual({ kind: 'plane', on: false });
  });

  it('names a device with a rule card', () => {
    const gore = { kind: 'placeStent', device: 'gore-excluder' };
    expect(parseIntent('size for a gore excluder')).toEqual(gore);
    expect(parseIntent('size for a Gore Excluder please')).toEqual(gore);
    expect(parseIntent('place an excluder')).toEqual(gore);
    expect(parseIntent('try a gore excluder graft')).toEqual(gore);
    // No card for the device, or no device: the plain placement.
    expect(parseIntent('place the stent')).toEqual({ kind: 'placeStent' });
    expect(parseIntent('place a nellix stent')).toEqual({ kind: 'placeStent' });
  });

  it('returns null for nonsense', () => {
    expect(parseIntent('what a lovely day')).toBeNull();
  });
});

describe('LLM fallback validation', () => {
  it('accepts well-formed intents', () => {
    expect(validate({ kind: 'placeStent' })).toEqual({ kind: 'placeStent' });
    expect(validate({ kind: 'window', preset: 'bone' })).toEqual({ kind: 'window', preset: 'bone' });
    expect(validate({ kind: 'setThreshold', name: 'marginMin', value: 7 })).toEqual({
      kind: 'setThreshold',
      name: 'marginMin',
      value: 7,
    });
  });

  it('rejects anything off-schema', () => {
    expect(validate({ kind: 'none' })).toBeNull();
    expect(validate({ kind: 'window', preset: 'brain' })).toBeNull();
    expect(validate({ kind: 'deleteEverything' })).toBeNull();
    expect(validate({ kind: 'setThreshold', name: 'marginMin', value: 'ten' })).toBeNull();
  });
});

describe('narration templates', () => {
  const metrics = {
    remnantPct: 64,
    resectedMl: 420,
    healthyRemnantMl: 800,
    marginMm: 12,
    tumorIncomplete: false,
    vesselsCrossed: 0,
    vesselName: null,
    vesselId: 0,
    nearestVesselMm: 9,
    nearestVesselId: 8,
  };

  it('patient narration uses plain words, two sentences', () => {
    const text = patientNarration({ caseKind: 'liver', metrics, stent: null, organ: 'liver' });
    expect(text).toContain('about a third of your liver');
    expect(text).toContain('About two thirds of your liver stays');
    expect(text.split('. ').length).toBeLessThanOrEqual(2);
  });

  it('an LLM rewrite that changes a number is detected', () => {
    expect(sameNumbers('margin 12 mm, remnant 64 %', 'a 12 mm edge; 64 % stays')).toBe(true);
    expect(sameNumbers('margin 12 mm', 'margin 15 mm')).toBe(false);
  });

  it('plan note carries every number from state', () => {
    const md = planMarkdown({
      caseName: 'Liver',
      caseKind: 'liver',
      structures: ['Liver', 'Tumour'],
      plane: { n: [1, 0, 0], d: 120, on: true },
      metrics,
      stent: null,
      pressureDrop: null,
      thresholds: DEFAULT_THRESHOLDS,
      organMl: 1313,
      tumorMl: 6.3,
      when: new Date('2026-10-11T12:00:00Z'),
    });
    expect(md).toContain('| Remnant | 64.0 % | ≥ 30 % |');
    expect(md).toContain('| Margin | 12.0 mm | ≥ 10 mm |');
    expect(md).toContain('## Limitations');
  });

  type Metrics = Omit<typeof metrics, 'vesselName'> & { vesselName: string | null };
  const crossed: Metrics = { ...metrics, marginMm: 8, remnantPct: 62, vesselsCrossed: 1, vesselName: 'Hepatic vein', vesselId: 5 };
  const result = (after: Metrics, angle: number): OptimizeResult => ({
    plane: { n: [1, 0, 0], d: 0 },
    before: crossed,
    after,
    angleDeg: angle,
    offsetMm: 0,
    feasible: after.vesselsCrossed === 0 && after.marginMm >= 10,
    violated: ['margin', 'vessels'],
    vessel: 'Hepatic vein',
    candidates: 3751,
    ms: 300,
  });

  it('optimize reply gives before and after, and what is still missed', () => {
    const after = { ...crossed, marginMm: 10.2, remnantPct: 63 };
    const line = optimizeReason(result(after, 6), crossed, after, DEFAULT_THRESHOLDS);
    expect(line).toMatch(/^Moved 6 degrees to widen the margin\. Margin 8 to 10 millimeters, remnant 62 to 63 percent, crosses 1 vessel\./);
    expect(line).toContain('still crosses the hepatic vein');
    expect(line).toContain('spare the vessels');
  });

  it('a vessels-first reply names the margin it gave up', () => {
    const after = { ...crossed, marginMm: 4, remnantPct: 71, vesselsCrossed: 0, vesselName: null, vesselId: 0 };
    const line = optimizeReason(result(after, 20), crossed, after, DEFAULT_THRESHOLDS, { priority: 'vessels' });
    expect(line).toContain('to clear the hepatic vein');
    expect(line).toContain('vessels crossed 1 to 0');
    expect(line).toContain('To spare the vessels the margin drops under 10 millimeters');
  });

  it('a what-if reply is outlined and waits for "do it"', () => {
    const after = { ...crossed, marginMm: 21, remnantPct: 59 };
    const line = optimizeReason(result(after, 19), crossed, after, { ...DEFAULT_THRESHOLDS, marginMin: 20 }, { preview: true, ask: 'With a 20 millimeter margin' });
    expect(line).toMatch(/^With a 20 millimeter margin, the best cut is 19 degrees from yours: margin 8 to 21 millimeters/);
    expect(line).toMatch(/say "do it" to use it\.$/);
  });

  it('summary and shift replies read every number from the metrics', () => {
    expect(planSummary(crossed, DEFAULT_THRESHOLDS)).toBe(
      'Margin 8 millimeters, under your 10. Remnant 62 percent, above your 30. Crosses the hepatic vein. Say "optimize" to look for a better cut.',
    );
    expect(shiftReply(-3, crossed, { ...crossed, marginMm: 11, remnantPct: 59 }, false)).toBe(
      'Moved 3 millimeters further from the tumor. Margin 8 to 11 millimeters, remnant 62 to 59 percent, crosses 1 vessel.',
    );
  });
});
