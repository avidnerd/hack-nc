import { describe, expect, it } from 'vitest';

import { validate } from '../src/ai/intentFallback.ts';
import { patientNarration, planMarkdown, sameNumbers } from '../src/ai/narrate.ts';
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
    ['is it possible to optimize the plane within a 30mm margin of the tumor', { kind: 'optimize', marginMm: 30 }],
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
});
