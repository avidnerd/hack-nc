/**
 * Every sentence Scrub+ says that contains a number.
 *
 * Templates are the source of truth: they run with the LLM off and every number
 * comes from the state object. The LLM may only rephrase a finished template
 * (patient narration, plan prose), and the system prompt forbids new claims.
 */

import { CONE_DEG, type OptimizeResult } from '../planning/optimize.ts';
import type { PlanMetrics, StentState, Thresholds } from '../types.ts';
import { complete, llmEnabled } from './llm.ts';

const r0 = (x: number) => Math.round(x);

/* -------------------------------------------------------------- optimizer */

export function optimizeReason(res: OptimizeResult, before: PlanMetrics, after: PlanMetrics, th: Thresholds): string {
  const moved = res.angleDeg >= 0.5 || res.offsetMm >= 0.5;
  if (!moved) {
    return res.feasible
      ? `Already optimal. Margin ${r0(after.marginMm)} millimeters, remnant ${r0(after.remnantPct)} percent.`
      : `No better cut within ${CONE_DEG} degrees. ${constraintFailure(after, th)}`;
  }

  const how =
    res.angleDeg >= 1
      ? `Moved ${r0(res.angleDeg)} degrees`
      : `Moved ${r0(res.offsetMm)} millimeters`;
  let why: string;
  if (res.vessel && before.vesselsCrossed > after.vesselsCrossed) {
    why =
      after.vesselsCrossed === 0
        ? `to clear the ${res.vessel.toLowerCase()}`
        : `to cross fewer vessels, ${before.vesselsCrossed} down to ${after.vesselsCrossed}`;
  }
  else if (before.tumorIncomplete) why = 'to take the whole tumor';
  else if (before.marginMm < th.marginMin && after.marginMm > before.marginMm) why = 'to widen the margin';
  else if (after.remnantPct > before.remnantPct) why = 'to spare more liver';
  else why = 'to meet your constraints';

  const numbers = `Margin ${r0(after.marginMm)} millimeters, remnant ${r0(after.remnantPct)} percent.`;
  if (!res.feasible) return `${how} ${why}, but ${constraintFailure(after, th).toLowerCase()} ${numbers}`;
  return `Optimized. ${how} ${why}. ${numbers}`;
}

function constraintFailure(m: PlanMetrics, th: Thresholds): string {
  if (m.tumorIncomplete) return 'Tumor is still not fully resected.';
  if (m.marginMm < th.marginMin) return `Margin is under ${th.marginMin} millimeters.`;
  if (m.remnantPct < th.remnantMin) return `Remnant is under ${th.remnantMin} percent.`;
  if (m.vesselsCrossed > 0) {
    const v = m.vesselsCrossed;
    return `It still crosses ${v} vessel${v > 1 ? 's' : ''}: I found no cut within ${CONE_DEG} degrees that keeps your margin and remnant and avoids ${v > 1 ? 'them' : 'it'}.`;
  }
  return 'Every constraint is met.';
}

/* ------------------------------------------------------------ patient mode */

/** Turn a percentage into the words a patient would use. */
export function fractionWords(pct: number): string {
  if (pct >= 95) return 'almost all';
  if (pct >= 85) return 'most';
  if (pct >= 70) return 'about three quarters';
  if (pct >= 58) return 'about two thirds';
  if (pct >= 42) return 'about half';
  if (pct >= 28) return 'about a third';
  if (pct >= 18) return 'about a quarter';
  if (pct >= 8) return 'about a tenth';
  if (pct > 0) return 'a small piece';
  return 'none';
}

export interface PatientFacts {
  caseKind: 'liver' | 'aorta' | 'scan';
  metrics: PlanMetrics | null;
  stent: StentState | null;
  /** Organ name, lowercase. */
  organ: string;
}

export interface Callout {
  label: string;
  text: string;
  kind: 'removed' | 'placed' | 'stays';
}

export function patientCallouts(f: PatientFacts): Callout[] {
  const out: Callout[] = [];
  const m = f.metrics;
  if (m) {
    out.push({
      label: 'Removed',
      text: `The tumor and ${fractionWords(100 - m.remnantPct)} of the ${f.organ} around it`,
      kind: 'removed',
    });
  }
  if (f.stent) {
    out.push({
      label: 'Placed',
      text: `A fabric-covered tube inside the aorta, below the kidney arteries`,
      kind: 'placed',
    });
  }
  if (m) {
    out.push({ label: 'Stays', text: `${cap(fractionWords(m.remnantPct))} of your ${f.organ}, which grows back`, kind: 'stays' });
  } else if (f.stent) {
    out.push({ label: 'Stays', text: 'Blood flow to both kidneys', kind: 'stays' });
  }
  return out;
}

/** "about 1 centimeter" only when it is one; small margins stay in mm. */
function edgeWords(mm: number): string {
  if (mm < 10) return `${Math.max(1, Math.round(mm))} millimeters`;
  const cm = Math.round(mm / 10);
  return `${cm} centimeter${cm > 1 ? 's' : ''}`;
}

/** Two plain sentences. Deterministic; the LLM may only reword them. */
export function patientNarration(f: PatientFacts): string {
  const m = f.metrics;
  const parts: string[] = [];
  if (m) {
    parts.push(
      m.tumorIncomplete
        ? `This cut would remove ${fractionWords(100 - m.remnantPct)} of your ${f.organ} but not all of the tumor, so the plan is not finished.`
        : `We remove the tumor along with ${fractionWords(100 - m.remnantPct)} of your ${f.organ}, ` +
            `keeping a safety edge of about ${edgeWords(m.marginMm)} around it.`,
    );
    parts.push(`${cap(fractionWords(m.remnantPct))} of your ${f.organ} stays, and the liver regrows over the following weeks.`);
  }
  if (f.stent) {
    parts.push(
      `A fabric-covered tube is placed inside your aorta, the body's main artery, just below the arteries to your kidneys, ` +
        `${f.stent.seals ? 'where it seals against healthy vessel wall' : 'though its position still needs adjusting so the kidneys keep their blood supply'}.`,
    );
    if (!m) parts.push('Your blood keeps flowing through it the same way, just inside the tube.');
  }
  if (parts.length === 0) {
    parts.push(`This is a 3D picture of your ${f.organ} built from your CT scan.`);
    parts.push('Your surgeon has not finished planning yet.');
  }
  return parts.slice(0, 2).join(' ');
}

const PATIENT_SYSTEM =
  'Rewrite the text for a patient at a 6th-grade reading level in at most two short sentences. ' +
  'Keep every fact and number exactly as given. Do not add any medical claim, risk, outcome, ' +
  'statistic or advice that is not in the text. Reply with the rewritten text only.';

/** Template first; optional LLM rewording, discarded if it changes a number. */
export async function patientNarrationText(f: PatientFacts): Promise<string> {
  const base = patientNarration(f);
  if (!llmEnabled()) return base;
  const out = await complete(PATIENT_SYSTEM, base);
  return out && sameNumbers(base, out) ? out.trim() : base;
}

/** True when `b` contains exactly the digits-numbers of `a`, so no figure changed. */
export function sameNumbers(a: string, b: string): boolean {
  const nums = (s: string) => (s.match(/\d+(?:\.\d+)?/g) ?? []).sort().join(',');
  return nums(a) === nums(b);
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* --------------------------------------------------------------- plan note */

export interface PlanFacts {
  caseName: string;
  caseKind: 'liver' | 'aorta' | 'scan';
  structures: string[];
  plane: { n: [number, number, number]; d: number; on: boolean };
  metrics: PlanMetrics | null;
  stent: StentState | null;
  pressureDrop: number | null;
  thresholds: Thresholds;
  organMl: number;
  tumorMl: number;
  when: Date;
}

export const LIMITATIONS =
  'Research prototype built on open research datasets; not a medical device and not for clinical use. ' +
  'Cuts are planar, whereas real liver resections follow Couinaud segmental anatomy; the optimizer only ' +
  'searches planes near the one the surgeon chose, against margin, remnant and vessel constraints the ' +
  'surgeon sets. Volumes come from automatic segmentations resampled to a 1.5 mm grid and evaluated on a ' +
  'coarser planning grid. Hand depth is estimated from apparent hand size. Resected volumes predicted ' +
  'from CT typically differ from specimen volumes by 10 to 20 percent. Remnant is a volume, not a measure ' +
  'of liver function. Stent rules are a simplified subset of typical EVAR instructions-for-use ranges ' +
  'applied to a non-aneurysmal demonstration aorta, sized on the lumen rather than the outer wall; renal ' +
  'ostia are estimated from kidney hilum level, and flow is a qualitative 1D continuity and Poiseuille ' +
  'model, not CFD.';

/** plan.md, generated entirely from the state object. */
export function planMarkdown(f: PlanFacts): string {
  const L: string[] = [];
  const fx = (x: number, d = 1) => x.toFixed(d);
  L.push(`# Scrub+ surgical plan`, '');
  L.push(`- **Case:** ${f.caseName}`);
  L.push(`- **Generated:** ${f.when.toISOString()}`);
  L.push(`- **Structures:** ${f.structures.join(', ')}`);
  L.push(`- **Organ volume:** ${fx(f.organMl, 0)} mL${f.tumorMl > 0 ? `, tumour ${fx(f.tumorMl)} mL` : ''}`);
  L.push('');
  if (f.plane.on && f.metrics) {
    const m = f.metrics;
    const [a, b, c] = f.plane.n;
    L.push(`## Resection plane`, '');
    L.push(`Plane: ${fx(a, 4)}·x + ${fx(b, 4)}·y + ${fx(c, 4)}·z = ${fx(f.plane.d, 2)} (world mm; resected side n·x − d > 0)`, '');
    L.push(`| Measure | Value | Threshold |`, `|---|---|---|`);
    L.push(`| Remnant | ${fx(m.remnantPct)} % | ≥ ${f.thresholds.remnantMin} % |`);
    L.push(`| Resected volume | ${fx(m.resectedMl, 0)} mL | |`);
    L.push(`| Healthy remnant | ${fx(m.healthyRemnantMl, 0)} mL | |`);
    L.push(`| Margin | ${m.tumorIncomplete ? '0 (tumour not fully resected)' : `${fx(m.marginMm)} mm`} | ≥ ${f.thresholds.marginMin} mm |`);
    L.push(`| Vessels crossed | ${m.vesselsCrossed}${m.vesselName ? ` (largest: ${m.vesselName})` : ''} | 0 (${f.thresholds.vesselPenalty}) |`);
    L.push('');
  }
  if (f.stent) {
    const s = f.stent;
    L.push(`## Stent graft`, '');
    L.push(`| Measure | Value | Rule |`, `|---|---|---|`);
    L.push(`| Length | ${fx(s.lengthMm, 0)} mm | |`);
    L.push(`| Diameter | ${fx(s.diameterMm)} mm | 15 % over neck |`);
    L.push(`| Oversize | ${fx(s.oversizePct)} % | 10 – 20 % |`);
    L.push(`| Proximal neck | ${fx(s.neckMm)} mm | ≥ 10 mm |`);
    L.push(`| Neck angulation | ${fx(s.angulationDeg)}° | < 60° |`);
    L.push(`| Position | ${fx(s.s0)} mm from proximal centerline | seated below the lowest renal ostium |`);
    if (f.pressureDrop !== null) L.push(`| Relative pressure drop | ${fx(f.pressureDrop, 0)} (native = 100) | |`);
    L.push('', `**Verdict:** ${s.verdict}`, '');
  }
  if (!(f.plane.on && f.metrics) && !f.stent) L.push('_No plane or device placed yet._', '');
  L.push(`## Limitations`, '', LIMITATIONS, '');
  return L.join('\n');
}
