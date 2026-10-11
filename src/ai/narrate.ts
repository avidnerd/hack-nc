/**
 * Every sentence Scrub+ says that contains a number.
 *
 * Templates are the source of truth: they run with the LLM off and every number
 * comes from the state object. The LLM may only rephrase a finished template
 * (patient narration, plan prose), and the system prompt forbids new claims.
 */

import { CONE_DEG, OFFSET_MM, type OptimizeResult } from '../planning/optimize.ts';
import type { OptimizePriority, PlanMetrics, StentState, Thresholds } from '../types.ts';
import { complete, llmEnabled } from './llm.ts';

const r0 = (x: number) => Math.round(x);

/* -------------------------------------------------------------- optimizer */

export interface ReplyOptions {
  /** A what-if: the answer is outlined, not applied. */
  preview?: boolean;
  priority?: OptimizePriority;
  /** How the question was framed, for a preview's opening ("With a 20 millimeter margin"). */
  ask?: string;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
/** "an 8", "an 11", "a 10": the article as the number is spoken. */
const aN = (n: number) => (/^(8|11|18)/.test(String(n)) ? `an ${n}` : `a ${n}`);

/** "margin 8 to 12 millimeters, remnant 63 percent, no vessels crossed" */
export function changeLine(before: PlanMetrics, after: PlanMetrics): string {
  const parts: string[] = [];
  if (after.tumorIncomplete) parts.push('tumor not fully removed');
  else {
    const b = r0(before.marginMm);
    const a = r0(after.marginMm);
    parts.push(before.tumorIncomplete || b === a ? `margin ${a} millimeters` : `margin ${b} to ${a} millimeters`);
  }
  const rb = r0(before.remnantPct);
  const ra = r0(after.remnantPct);
  parts.push(rb === ra ? `remnant ${ra} percent` : `remnant ${rb} to ${ra} percent`);
  const vb = before.vesselsCrossed;
  const va = after.vesselsCrossed;
  if (vb !== va) parts.push(`vessels crossed ${vb} to ${va}`);
  else parts.push(va === 0 ? 'no vessels crossed' : `crosses ${plural(va, 'vessel')}`);
  return parts.join(', ');
}

function vesselPhrase(m: PlanMetrics): string {
  const name = m.vesselName?.toLowerCase();
  if (!name) return plural(m.vesselsCrossed, 'vessel');
  return m.vesselsCrossed > 1 ? `the ${name} and ${plural(m.vesselsCrossed - 1, 'other vessel')}` : `the ${name}`;
}

/** What the result still misses, in one or two short sentences ('' when nothing). */
function shortfall(before: PlanMetrics, after: PlanMetrics, th: Thresholds, priority: OptimizePriority): string {
  if (after.tumorIncomplete) return 'Part of the tumor is still on the side that stays.';
  const out: string[] = [];
  if (after.marginMm < th.marginMin) {
    out.push(
      priority === 'vessels' && after.vesselsCrossed < before.vesselsCrossed
        ? `To spare the vessels the margin drops under ${th.marginMin} millimeters.`
        : `The margin is still under ${th.marginMin} millimeters.`,
    );
  }
  if (after.remnantPct < th.remnantMin) out.push(`The remnant is under ${th.remnantMin} percent.`);
  if (after.vesselsCrossed > 0) {
    out.push(
      priority === 'vessels'
        ? `It still crosses ${vesselPhrase(after)}: no cut within ${CONE_DEG} degrees avoids it without leaving tumor or going under your remnant.`
        : `It still crosses ${vesselPhrase(after)}; avoiding it costs margin. Say "spare the vessels" to trade margin for it.`,
    );
  }
  return out.join(' ');
}

function motive(before: PlanMetrics, after: PlanMetrics, th: Thresholds, res: OptimizeResult): string {
  if (before.tumorIncomplete && !after.tumorIncomplete) return 'to take the whole tumor';
  if (after.vesselsCrossed < before.vesselsCrossed) {
    return after.vesselsCrossed === 0 && res.vessel ? `to clear the ${res.vessel.toLowerCase()}` : 'to cross fewer vessels';
  }
  if (before.marginMm < th.marginMin && after.marginMm > before.marginMm) return 'to widen the margin';
  if (after.remnantPct > before.remnantPct + 0.5) return 'to keep more liver';
  if (after.marginMm > before.marginMm + 0.5) return 'to widen the margin';
  return 'to meet your targets';
}

/**
 * The optimizer's spoken answer: what moved and why, the numbers before and
 * after, and what is still missed. Every number comes from the metrics.
 */
export function optimizeReason(
  res: OptimizeResult,
  before: PlanMetrics,
  after: PlanMetrics,
  th: Thresholds,
  o: ReplyOptions = {},
): string {
  const priority = o.priority ?? 'balanced';
  const moved = res.angleDeg >= 0.5 || res.offsetMm >= 0.5;
  const left = shortfall(before, after, th, priority);
  const met = left === '';
  const how = res.angleDeg >= 1 ? `${r0(res.angleDeg)} degrees` : `${Math.max(1, r0(res.offsetMm))} millimeters`;

  if (o.preview) {
    const head = o.ask ?? 'Searching near your cut';
    if (!moved) return `${head}, nothing within ${CONE_DEG} degrees beats your cut. ${cap(changeLine(after, after))}.${left ? ' ' + left : ''}`;
    return (
      `${head}, the best cut is ${how} from yours: ${changeLine(before, after)}.` +
      `${left ? ' ' + left : ' Every target is met.'} It's outlined; say "do it" to use it.`
    );
  }
  if (!moved) {
    return met
      ? `Your cut already meets every target: ${changeLine(after, after)}.`
      : `Your cut is already the best within ${CONE_DEG} degrees. ${left}`;
  }
  return `${met ? 'Optimized: moved' : 'Moved'} ${how} ${motive(before, after, th, res)}. ${cap(changeLine(before, after))}.${left ? ' ' + left : ''}`;
}

/**
 * When the search had to start from its own cut (no cut, a cut that missed
 * the liver, or nothing near the surgeon's cut that works): say so, then the
 * numbers, against the surgeon's cut when there was a usable one.
 */
export function restartReply(
  note: string,
  before: PlanMetrics | null,
  after: PlanMetrics,
  th: Thresholds,
  priority: OptimizePriority = 'balanced',
  preview = false,
): string {
  const left = shortfall(before ?? after, after, th, priority);
  return (
    `${note} ${cap(changeLine(before ?? after, after))}.${left ? ' ' + left : ' Every target is met.'}` +
    (preview ? ` It's outlined; say "do it" to use it.` : '')
  );
}

/** The answer to "why": what was wrong, what the search weighs, what it found. */
export function optimizeExplanation(res: OptimizeResult, th: Thresholds, priority: OptimizePriority = 'balanced'): string {
  const b = res.before;
  const wrong: string[] = [];
  if (b.tumorIncomplete) wrong.push('left part of the tumor behind');
  else if (b.marginMm < th.marginMin) wrong.push(`had ${aN(r0(b.marginMm))} millimeter margin, under your ${th.marginMin}`);
  if (b.remnantPct < th.remnantMin) wrong.push(`kept ${r0(b.remnantPct)} percent, under your ${th.remnantMin}`);
  if (b.vesselsCrossed > 0) wrong.push(`crossed ${vesselPhrase(b)}`);
  const start = wrong.length ? `Your cut ${wrong.join(', and ')}.` : 'Your cut met every target.';
  const order =
    priority === 'vessels'
      ? 'whole tumor, your remnant, no vessels, then your margin'
      : priority === 'remnant'
        ? 'whole tumor, your margin and remnant, fewer vessels, then the most liver kept'
        : 'whole tumor, your margin and remnant, fewer vessels, then staying close to your cut';
  return (
    `${start} I tried ${res.candidates} flat cuts within ${CONE_DEG} degrees and ${OFFSET_MM} millimeters of it, ranked by ${order}. ` +
    `The pick: ${changeLine(b, res.after)}. Real resections follow liver segments; this is a planar approximation.`
  );
}

/** "Is this cut OK": each number against its target, without calling anything safe. */
export function planSummary(m: PlanMetrics, th: Thresholds): string {
  if (m.tumorIncomplete) return 'Part of the tumor is on the side that stays, so this cut does not remove it. Say "optimize" to fix it.';
  const marginOk = m.marginMm >= th.marginMin;
  const remnantOk = m.remnantPct >= th.remnantMin;
  const parts = [
    `Margin ${r0(m.marginMm)} millimeters, ${marginOk ? 'meets' : 'under'} your ${th.marginMin}.`,
    `Remnant ${r0(m.remnantPct)} percent, ${remnantOk ? 'above' : 'under'} your ${th.remnantMin}.`,
    m.vesselsCrossed === 0 ? 'No vessels crossed.' : `Crosses ${vesselPhrase(m)}.`,
  ];
  const ok = marginOk && remnantOk && m.vesselsCrossed === 0;
  parts.push(ok ? 'Every target is met.' : 'Say "optimize" to look for a better cut.');
  return parts.join(' ');
}

/** The answer to "move the cut 5 mm closer to the tumor". */
export function shiftReply(mm: number, before: PlanMetrics, after: PlanMetrics, preview: boolean): string {
  const where = `${r0(Math.abs(mm))} millimeters ${mm > 0 ? 'closer to' : 'further from'} the tumor`;
  return preview
    ? `${cap(where)}: ${changeLine(before, after)}. It's outlined; say "do it" to move it.`
    : `Moved ${where}. ${cap(changeLine(before, after))}.`;
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

