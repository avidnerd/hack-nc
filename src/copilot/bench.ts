/**
 * Workflow benchmark instrumentation.
 *
 *   window.scrub.bench.start('distance', 'manual' | 'copilot')
 *
 * starts a task: the clock runs and every interaction counts (key, click,
 * scroll, spoken command, hand-pose change) until the task's completion
 * predicate holds, then the result is logged and kept in `results`. The same
 * harness times a person doing the task by hand or with the copilot, so a
 * usability study can use it directly; scripts/benchmark.mjs uses it for the
 * reproducible technical benchmark (machine latency, not human performance).
 *
 * "Correct" is judged against an independent recomputation of the answer,
 * never against what the copilot itself drew.
 */

import { idsFor, nearestAmong, structureDistance } from '../planning/smartMeasure.ts';
import { on, state } from '../state.ts';
import type { PlanStore } from './plans.ts';

export type TaskId = 'distance' | 'nearest' | 'restore' | 'compare';
export type BenchMode = 'manual' | 'copilot';

export interface BenchResult {
  task: TaskId;
  mode: BenchMode;
  ms: number;
  interactions: number;
  correct: boolean;
  /** Why it counted as done (or the answer it found). */
  detail: string;
}

export const TASK_TEXT: Record<TaskId, string> = {
  distance: 'Find and measure the minimum distance between the tumour and the portal vein.',
  nearest: "Locate the tumour's closest segmented vessel and its distance.",
  restore: 'Restore the saved surgical planning view.',
  compare: 'Compare the current resection plane with the saved one.',
};

const TOL_MM = 0.6;

export class Bench {
  readonly results: BenchResult[] = [];
  private run: { task: TaskId; mode: BenchMode; t0: number; n: number; truth: number | null; truthName: string } | null = null;

  constructor(private readonly plans: PlanStore) {
    const count = () => {
      if (this.run) this.run.n++;
    };
    window.addEventListener('keydown', count, true);
    window.addEventListener('pointerdown', count, true);
    window.addEventListener('wheel', count, { capture: true, passive: true });
    let pose = '';
    on('hands', (h) => {
      if (h.pose !== pose && h.pose !== 'IDLE' && h.pose !== 'LOST') count();
      pose = h.pose;
    });
  }

  /** A spoken or LLM-parsed command (keys are counted by the listener). */
  countVoice(): void {
    if (this.run) this.run.n++;
  }

  get active(): TaskId | null {
    return this.run?.task ?? null;
  }

  start(task: TaskId, mode: BenchMode): string {
    const d = state.data;
    let truth: number | null = null;
    let truthName = '';
    if (d && task === 'distance') {
      truth = structureDistance(d, idsFor(d, 'tumor'), idsFor(d, 'portal_vein'))?.mm ?? null;
    } else if (d && task === 'nearest') {
      const vessels = d.meta.labels.filter((l) => l.role === 'vessel').map((l) => l.id);
      const best = nearestAmong(d, idsFor(d, 'tumor'), vessels)[0];
      truth = best?.mm ?? null;
      truthName = best ? (d.meta.labels.find((l) => l.id === best.id)?.key ?? '') : '';
    }
    this.run = { task, mode, t0: performance.now(), n: 0, truth, truthName };
    return TASK_TEXT[task];
  }

  cancel(): void {
    this.run = null;
  }

  /** Per frame: has the running task been completed? */
  tick(): BenchResult | null {
    const r = this.run;
    if (!r) return null;
    const verdict = this.check(r.task, r.truth, r.truthName);
    if (!verdict) return null;
    const res: BenchResult = {
      task: r.task,
      mode: r.mode,
      ms: Math.round(performance.now() - r.t0),
      interactions: r.n,
      correct: verdict.correct,
      detail: verdict.detail,
    };
    this.run = null;
    this.results.push(res);
    console.info('[bench]', JSON.stringify(res));
    return res;
  }

  /** Done when the requested answer is on screen; correct when it is right. */
  private check(task: TaskId, truth: number | null, truthName: string): { correct: boolean; detail: string } | null {
    const c = state.caliper;
    switch (task) {
      case 'distance': {
        if (!c.a || !c.b) return null;
        const names = (c.label ?? '').toLowerCase();
        if (!names.includes('tumour') || !names.includes('portal')) return null;
        return { correct: truth !== null && Math.abs(c.mm - truth) <= TOL_MM, detail: `${c.mm.toFixed(1)} mm (truth ${truth?.toFixed(1)})` };
      }
      case 'nearest': {
        if (!c.a || !c.b || !c.label) return null;
        const label = c.label.toLowerCase();
        const nameOk = truthName === 'hepatic_vessels' ? label.includes('intrahepatic') : label.includes(truthName.replace('_', ' '));
        if (!label.includes('tumour')) return null;
        return { correct: truth !== null && nameOk && Math.abs(c.mm - truth) <= TOL_MM, detail: `${c.label} ${c.mm.toFixed(1)} mm (truth ${truthName} ${truth?.toFixed(1)})` };
      }
      case 'restore': {
        const b = this.plans.baseline(state.caseId);
        if (!b) return null;
        const p = state.plane;
        const same =
          p.on === b.plane.on && Math.abs(p.d - b.plane.d) < 1e-6 &&
          p.n.every((x, i) => Math.abs(x - b.plane.n[i]) < 1e-6) &&
          Math.abs(state.camera.dist - b.camera.dist) < 1e-3 &&
          Math.abs(state.camera.yaw - b.camera.yaw) < 1e-3 &&
          Math.abs(state.camera.pitch - b.camera.pitch) < 1e-3;
        return same ? { correct: true, detail: 'plane and camera match the saved plan' } : null;
      }
      case 'compare': {
        const kicker = document.querySelector('.info-card.show .info-kicker')?.textContent ?? '';
        if (!/plan comparison/i.test(kicker) || !state.ghostPlane) return null;
        return { correct: true, detail: 'comparison panel and both planes shown' };
      }
    }
  }
}
