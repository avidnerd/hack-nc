/**
 * "Scrub, what do you suggest?" and "Scrub, what are the outcomes?"
 *
 * Rule-based and deterministic: no model writes any of this. Suggestions are
 * what follows from the current plan's numbers against the surgeon's own
 * thresholds. Outcomes are PUBLISHED COHORT RATES for the band the plan falls
 * in, shown beside the other band, with the source: never a probability for
 * this patient. docs/CLINICAL.md (§ Outcomes) has the review behind every row
 * and the list of what we deliberately do not claim: no personal risk, no
 * interpolation between bands, no combining odds ratios, no survival from
 * margin millimetres, no oversizing rates (none are pooled).
 *
 * Only figures verified against the abstract or full text are used.
 */

import type { CardContent, CardRow } from '../ui/infoCard.ts';
import type { PlanMetrics, StentState, Thresholds } from '../types.ts';

export interface AdviceFacts {
  caseKind: 'liver' | 'aorta';
  planeOn: boolean;
  metrics: PlanMetrics | null;
  stent: StentState | null;
  thresholds: Thresholds;
}

export interface Advice {
  card: CardContent;
  speech: string;
}

/** The studies the outcome rows quote. */
export const EVIDENCE = {
  schindl: 'Schindl et al., Gut 2005 (n = 104, normal liver)',
  shindoh: 'Shindoh et al., J Am Coll Surg 2013 (n = 107, after portal vein embolization)',
  pawlik: 'Pawlik et al., Ann Surg 2005 (n = 557, colorectal metastases)',
  margonis: 'Margonis et al., Ann Surg 2018 (meta-analysis, 34 studies)',
  stather: 'Stather et al., J Endovasc Ther 2013 (meta-analysis, 16 studies, ~12,000 patients)',
  bernardini: 'Bernardini et al., PLoS One 2022 (6 studies, n = 5,981)',
} as const;

const NOT_A_PREDICTION =
  'Published cohort rates for the band this plan falls in, not a prediction for this patient.';

/* ------------------------------------------------------------- suggestions */

export function suggestions(f: AdviceFacts): Advice {
  return f.caseKind === 'aorta' ? stentSuggestions(f) : liverSuggestions(f);
}

function liverSuggestions(f: AdviceFacts): Advice {
  const m = f.metrics;
  const t = f.thresholds;
  if (!f.planeOn || !m) {
    return {
      card: { kicker: 'Suggestions', title: 'No cut yet', rows: [{ label: 'Place a cut', value: 'open hand', ref: 'Hold an open hand over the liver; the cut follows your palm.' }] },
      speech: 'Place a cut first. Hold an open hand over the liver.',
    };
  }
  const rows: CardRow[] = [];
  const said: string[] = [];
  if (m.tumorIncomplete) {
    rows.push({ label: 'Clear the tumour', value: 'tumour left', flag: true, ref: 'Part of the tumour is on the kept side (R1-like). Move the cut away from it, or say "optimize".' });
    said.push('The cut leaves tumor behind. Move it away from the tumor, or say optimize.');
  } else if (m.marginMm < t.marginMin) {
    rows.push({ label: 'Widen the margin', value: `${m.marginMm.toFixed(1)} mm`, flag: true, ref: `Below your ${t.marginMin} mm target. "Optimize" searches planes within 20° and 15 mm of yours.` });
    said.push(`Margin ${Math.round(m.marginMm)} millimeters is under your ${t.marginMin} millimeter target. Say optimize to search nearby planes.`);
  }
  if (m.vesselsCrossed > 0) {
    const v = m.vesselName?.toLowerCase() ?? 'vessel';
    rows.push({ label: 'Spare or control the vessel', value: `${m.vesselsCrossed} crossed`, flag: true, ref: `The cut divides a ≥5 mm ${v}. Re-angle to spare it, or plan vessel control; a divided hepatic vein can congest the liver it drains.` });
    said.push(`The cut divides a ${v}. Re-angle to spare it or plan to control it.`);
  }
  if (m.remnantPct < t.remnantMin) {
    rows.push({ label: 'Remnant below minimum', value: `${m.remnantPct.toFixed(0)} %`, flag: true, ref: 'Teams consider portal vein embolization first when the standardized remnant is under ~20 % (normal liver), ~30 % (after chemotherapy) or ~40 % (cirrhosis).' });
    said.push('The remnant is below your minimum. Teams would consider portal vein embolization before a cut like this.');
  }
  if (rows.length === 0) {
    rows.push({ label: 'Constraints met', value: 'ready', ref: `Margin ≥${t.marginMin} mm, remnant ≥${t.remnantMin} %, no ≥5 mm vessel divided. Lock it, then "write the plan" or "show the patient".` });
    said.push('This cut meets your margin, remnant and vessel constraints. Lock it, then write the plan.');
  }
  rows.push({ label: 'Not assessable from CT', value: '—', ref: 'Liver function (bilirubin, INR, ICG clearance), background cirrhosis or chemotherapy injury, and Couinaud segment anatomy. Confirm with intraoperative ultrasound.' });
  return {
    card: { kicker: 'Suggestions', title: 'Liver resection plan', rows, foot: 'Rule-based from your thresholds. Research and teaching use only.' },
    speech: said.slice(0, 2).join(' '),
  };
}

function stentSuggestions(f: AdviceFacts): Advice {
  const st = f.stent;
  if (!st) {
    return {
      card: { kicker: 'Suggestions', title: 'No stent yet', rows: [{ label: 'Place the stent', value: '“place the stent”', ref: 'It seats just below the lowest renal artery and sizes itself 15 % over the neck.' }] },
      speech: 'Say place the stent. It seats just below the lowest renal artery.',
    };
  }
  const rows: CardRow[] = [];
  let speech: string;
  const reason = st.failReason ?? '';
  if (/renal/i.test(reason)) {
    rows.push({ label: 'Clear the renal arteries', value: 'covered', flag: true, ref: 'Move the seal distal to the lowest renal (say "optimize"). Where no infrarenal neck is long enough, teams consider fenestrated EVAR or chimney grafts.' });
    speech = 'It covers a renal artery. Say optimize to move it below the renals.';
  } else if (/short/i.test(reason)) {
    rows.push({ label: 'Neck too short', value: `${st.neckMm.toFixed(0)} mm`, flag: true, ref: 'Under 10 mm is outside typical instructions for use; options are fenestrated or branched EVAR, or open repair.' });
    speech = 'The neck is too short for a standard graft. Fenestrated EVAR or open repair would be the options.';
  } else if (/size/i.test(reason)) {
    rows.push({ label: 'Choose another diameter', value: `${st.oversizePct.toFixed(0)} %`, flag: true, ref: 'Typical IFU oversizing is 10–20 % over the outer-wall neck diameter.' });
    speech = 'The device size is outside the 10 to 20 percent oversizing range. Choose another diameter.';
  } else if (/angled/i.test(reason)) {
    rows.push({ label: 'Neck angulation', value: `${st.angulationDeg.toFixed(0)}°`, flag: true, ref: 'Beyond 60° is outside most devices’ IFU and is associated with more type Ia endoleak.' });
    speech = 'The neck is angled beyond most devices’ limits.';
  } else {
    rows.push({ label: 'Within typical IFU ranges', value: 'seals', ref: `Neck ${st.neckMm.toFixed(0)} mm, ${st.oversizePct.toFixed(0)} % oversize, ${st.angulationDeg.toFixed(0)}° angulation, renal arteries clear.` });
    speech = 'The seal is within typical instruction-for-use ranges. A real plan would still need outer-wall sizing on a thin-slice CT.';
  }
  const neckD = st.diameterMm / 1.15;
  if (neckD < 18) {
    rows.push({
      label: 'Small neck',
      value: `${neckD.toFixed(0)} mm`,
      flag: neckD < 17,
      ref: `${neckD < 17 ? 'Below' : 'At'} the lower limit of most devices’ IFU diameter range (17–32 mm). This is lumen; the outer wall reads 3–6 mm larger, so measure that first.`,
    });
  }
  rows.push({ label: 'Not modelled here', value: '—', ref: 'Outer-wall diameter, thrombus and calcium, iliac landing zones and access vessels; a real plan uses thin-slice CTA.' });
  return {
    card: { kicker: 'Suggestions', title: 'Infrarenal stent seal', rows, foot: 'Demonstration anatomy (no aneurysm). Research and teaching use only.' },
    speech,
  };
}

/* ---------------------------------------------------------------- outcomes */

export function outcomes(f: AdviceFacts): Advice {
  return f.caseKind === 'aorta' ? stentOutcomes(f) : liverOutcomes(f);
}

function liverOutcomes(f: AdviceFacts): Advice {
  const m = f.metrics;
  if (!f.planeOn || !m) {
    return {
      card: { kicker: 'Outcomes', title: 'No cut yet', rows: [] , notes: ['Place a cut, then ask again.'] },
      speech: 'Place a cut first, then ask about outcomes.',
    };
  }
  const rows: CardRow[] = [];
  const low = m.remnantPct < 26.6;
  rows.push({
    label: `Remnant ${m.remnantPct.toFixed(0)} %: ${low ? 'below' : 'above'} 26.6 %`,
    value: low ? '10 in 22' : '1 in 82',
    flag: low,
    ref: `Severe liver dysfunction: 45.5 % below vs 1.2 % above a 26.6 % remnant. ${EVIDENCE.schindl}.`,
  });
  rows.push({
    label: 'Standardized remnant ≤20 % vs >20 %',
    value: '27 % vs 5 %',
    ref: `Hepatic insufficiency 3 in 11 vs 5 in 96. Needs a body-size-based liver volume, which a CT alone does not give. ${EVIDENCE.shindoh}.`,
  });
  if (m.tumorIncomplete) {
    rows.push({
      label: 'Margin: tumour left (R1-like)',
      value: '11 % vs ≤5 %',
      flag: true,
      ref: `Recurrence at the cut surface, positive vs negative margins; 5-year survival 17 % vs 62–71 %. ${EVIDENCE.pawlik}.`,
    });
  } else {
    const wide = m.marginMm >= 10;
    rows.push({
      label: `Margin ${m.marginMm.toFixed(0)} mm: ${wide ? '≥10 mm' : 'clear, under 10 mm'}`,
      value: wide ? 'RR 0.91' : 'similar',
      ref: wide
        ? `≥10 mm vs <10 mm: modestly better 5-year survival (relative risk 0.91). ${EVIDENCE.margonis}.`
        : `Clear margins of 1–9 mm and ≥10 mm had similar recurrence (39–41 % vs 39 %) and survival. ${EVIDENCE.pawlik}.`,
    });
  }
  rows.push({
    label: `Vessels crossed: ${m.vesselsCrossed}`,
    value: 'no rate',
    ref: 'No published rate maps a vessel count to outcome. A divided hepatic vein congests the liver it drains (~20–40 % per major vein).',
  });
  const band = low ? 'below' : 'above';
  return {
    card: {
      kicker: 'Outcomes · published cohorts',
      title: 'What similar plans led to',
      rows,
      notes: [NOT_A_PREDICTION, 'Validated risk tools (MELD, ALBI, ICG clearance, ACS NSQIP) need lab values a CT does not carry.'],
    },
    speech:
      `In a published cohort, patients with a remnant ${band} 26.6 percent had severe liver dysfunction in ${low ? 'about 45' : 'about 1'} in 100. ` +
      'These are cohort rates, not a prediction for this patient.',
  };
}

function stentOutcomes(f: AdviceFacts): Advice {
  const st = f.stent;
  if (!st) {
    return {
      card: { kicker: 'Outcomes', title: 'No stent yet', rows: [], notes: ['Place the stent, then ask again.'] },
      speech: 'Place the stent first, then ask about outcomes.',
    };
  }
  const neckD = st.diameterMm / 1.15;
  // Stather's hostile neck: length <15 mm, diameter >28 mm and/or angle >60°.
  const hostile = st.neckMm < 15 || neckD > 28 || st.angulationDeg > 60;
  const angled = st.angulationDeg >= 60;
  const renal = /renal/i.test(st.failReason ?? '');
  const rows: CardRow[] = [
    {
      label: `Neck ${hostile ? 'hostile' : 'not hostile'} (length, diameter, angle)`,
      value: hostile ? 'OR 2.92' : 'reference',
      flag: hostile,
      ref: `Hostile necks: 30-day type I endoleak odds ratio 2.92; 30-day mortality 3.5 % vs 2.4 %; migration 1.6 % vs 0.9 %. ${EVIDENCE.stather}.`,
    },
    {
      label: `Angulation ${st.angulationDeg.toFixed(0)}°: ${angled ? '≥60°' : '<60°'}`,
      value: angled ? '4.0 %' : '1.8 %',
      flag: angled,
      ref: `Type Ia endoleak at 30 days, 4.0 % (≥60°) vs 1.8 % (<60°); at 3 years 5.6 % vs 2.6 %. ${EVIDENCE.bernardini}.`,
    },
    {
      label: `Oversize ${st.oversizePct.toFixed(0)} %`,
      value: 'no rate',
      ref: 'No pooled rates by oversizing band exist; 10–20 % is the range reviews call relatively safe.',
    },
  ];
  if (renal) {
    rows.push({
      label: 'Renal artery covered',
      value: 'no rate',
      flag: true,
      ref: 'Covering a renal artery without revascularisation is associated with dialysis and lower survival; we found no rate we could verify.',
    });
  }
  return {
    card: {
      kicker: 'Outcomes · published cohorts',
      title: 'What similar seals led to',
      rows,
      notes: [NOT_A_PREDICTION, 'Lumen-based sizing on demonstration anatomy without an aneurysm.'],
    },
    speech: hostile
      ? 'This neck falls in the hostile band, where published cohorts saw about three times the odds of early type one endoleak.'
      : 'This neck is outside the hostile band. In published cohorts, early type one a endoleak was about 2 in 100 with angles under 60 degrees.',
  };
}
