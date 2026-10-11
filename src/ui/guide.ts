/**
 * The parts of the UI that teach the interface while you use it:
 *
 *   hand cursor     where your hand is on screen, shaped by the pose it reads
 *   gesture legend  the five gestures, the active one lit
 *   story rail      the demo's steps for this case, done / next, with the exact
 *                   words or gesture for the next one, so a judge with no
 *                   instructions can walk the whole script
 *   onboarding      a first-run card that disappears on the first hand or key
 */

import { on, state } from '../state.ts';
import type { Pose } from '../types.ts';

interface Step {
  id: string;
  title: string;
  /** What to do next: a gesture or a phrase. */
  hint: string;
  /** A spoken command for the hint chip, if the step is voice-driven. */
  say?: string;
  done: () => boolean;
}

const LEGEND: { pose: Pose; gesture: string; action: string }[] = [
  { pose: 'OPEN', gesture: 'Open hand', action: 'cut' },
  { pose: 'PINCH', gesture: 'Pinch', action: 'rotate (both hands: zoom)' },
  { pose: 'FIST', gesture: 'Fist', action: 'lock' },
  { pose: 'CALIPER', gesture: 'Two fingers', action: 'measure' },
];

const CURSOR_LABEL: Partial<Record<Pose, string>> = {
  OPEN: 'cut',
  PINCH: 'grab',
  FIST: 'lock',
  CALIPER: 'measure',
};

export class Guide {
  private cursor = el('div', 'hand-cursor');
  private cursorTag = el('div', 'hand-cursor-tag');
  private legend = el('div', 'legend');
  private rail = el('nav', 'rail');
  private onboard = el('div', 'onboard');
  private legendItems = new Map<Pose, HTMLElement>();
  private yaw0 = state.camera.yaw;
  private flags = { optimized: false, explained: false, dragged: false, measured: false, evidence: false, windowed: false, turned: false };
  private lastRail = '';

  constructor() {
    this.cursor.append(this.cursorTag);
    document.body.append(this.cursor, this.legend, this.rail, this.onboard);
    this.buildLegend();
    this.buildOnboarding();

    on('cursor', (c) => this.moveCursor(c));
    on('hands', (h) => {
      for (const [pose, item] of this.legendItems) item.classList.toggle('on', h.pose === pose);
      if (h.left || h.right) this.dismissOnboarding();
    });
    on('response', (r) => {
      if (/^Optimized|^Already/.test(r)) this.flags.optimized = true;
    });
    on('mode', (m) => {
      if (m === 'patient') this.flags.explained = true;
      document.body.classList.toggle('patient-mode', m === 'patient');
    });
    // Loading a case sets its default window; only a change away from it counts.
    on('preset', (p) => {
      if (p !== state.data?.meta.defaultPreset) this.flags.windowed = true;
    });
    on('caliper', (c) => {
      if (c.a && c.b) this.flags.measured = true;
    });
    // "Look around" is done after a real turn, not the camera reset on load.
    on('camera', (c) => {
      if (Math.abs(c.yaw - this.yaw0) > 0.3) this.flags.turned = true;
    });
    on('stent', (s) => {
      if (s && !s.seals) this.flags.dragged = true;
    });
    on('data', () => this.resetFlags());
    on('reset', () => this.resetFlags());
    window.addEventListener('keydown', () => this.dismissOnboarding(), { once: true });
    window.addEventListener('pointerdown', () => this.dismissOnboarding(), { once: true });
  }

  /** A measurement or the outcomes card was shown (from the intent handler). */
  note(what: 'measured' | 'evidence'): void {
    this.flags[what] = true;
  }

  /** Called from the main loop; cheap when nothing changed. */
  tick(): void {
    // Each step is checked on its own: measuring or asking for the evidence
    // can happen at any point, so a later step never ticks the earlier ones.
    const steps = this.steps();
    const next = steps.findIndex((s) => !s.done());
    const key = steps.map((s) => (s.done() ? 1 : 0)).join('') + state.caseId + next;
    if (key === this.lastRail) return;
    this.lastRail = key;

    this.rail.innerHTML = '';
    const head = el('div', 'rail-head');
    const kind = state.data?.meta.kind;
    head.textContent = kind === 'aorta' ? 'Stent plan' : kind === 'scan' ? 'Your scan' : 'Liver resection plan';
    this.rail.append(head);
    steps.forEach((s, i) => {
      const row = el('div', `rail-step${s.done() ? ' done' : ''}${i === next ? ' next' : ''}`);
      const dot = el('span', 'rail-dot');
      dot.textContent = String(i + 1);
      const body = el('div', 'rail-body');
      const t = el('div', 'rail-title');
      t.textContent = s.title;
      body.append(t);
      if (i === next) {
        const hint = el('div', 'rail-hint');
        hint.textContent = s.hint;
        body.append(hint);
        if (s.say) {
          const chip = el('div', 'say-chip');
          chip.textContent = `“Scrub, ${s.say}”`;
          body.append(chip);
        }
      }
      row.append(dot, body);
      this.rail.append(row);
    });
    if (next < 0) {
      const done = el('div', 'rail-hint rail-finish');
      done.textContent = 'Plan complete. Say “Scrub, write the plan” to export it.';
      this.rail.append(done);
    }
  }

  private steps(): Step[] {
    const s = state;
    if (s.data?.meta.kind === 'scan') {
      return [
        { id: 'turn', title: 'Look around', hint: 'Pinch and drag to turn the scan', done: () => this.flags.turned },
        { id: 'cut', title: 'Slice through it', hint: 'Open your hand: the cut follows your palm', say: 'make an axial cut', done: () => s.plane.on },
        { id: 'window', title: 'Change the window', hint: 'Bone, lung or soft tissue', say: 'bone window', done: () => this.flags.windowed },
        { id: 'measure', title: 'Measure something', hint: 'Two index fingers, or click two points', done: () => this.flags.measured },
      ];
    }
    if (s.data?.meta.kind === 'aorta') {
      return [
        { id: 'measure', title: 'Measure the aorta', hint: 'Diameter against the aneurysm threshold', say: 'measure the aorta', done: () => this.flags.measured },
        { id: 'place', title: 'Place the stent', hint: 'Seats below the renal arteries, sizes itself', say: 'place the stent', done: () => !!s.stent || this.flags.dragged },
        { id: 'drag', title: 'Try a bad position', hint: 'Pinch the stent and drag it up, toward the renal arteries', done: () => this.flags.dragged },
        { id: 'fix', title: 'Let it fix the seal', hint: 'Finds the nearest sealing position', say: 'optimize', done: () => this.flags.optimized },
        { id: 'evidence', title: 'Check the evidence', hint: 'Published outcomes for necks like this one', say: 'what are the outcomes', done: () => this.flags.evidence },
        { id: 'tell', title: 'Explain it', hint: 'Plain-language view for the patient', say: 'show the patient', done: () => this.flags.explained },
      ];
    }
    return [
      { id: 'measure', title: 'Measure the tumour', hint: 'RECIST diameter and volume', say: 'measure the tumor', done: () => this.flags.measured },
      { id: 'cut', title: 'Place a cut', hint: 'Open your hand: the cut follows your palm', done: () => s.plane.on },
      { id: 'opt', title: 'Optimize the cut', hint: 'Clears vessels, restores the margin', say: 'optimize', done: () => this.flags.optimized },
      { id: 'lock', title: 'Lock it', hint: 'Make a fist: the piece lifts away', done: () => s.plane.locked },
      { id: 'evidence', title: 'Check the evidence', hint: 'Published outcomes for plans like this', say: 'what are the outcomes', done: () => this.flags.evidence },
      { id: 'tell', title: 'Explain it', hint: 'Plain-language view for the patient', say: 'show the patient', done: () => this.flags.explained },
    ];
  }

  private resetFlags(): void {
    this.yaw0 = state.camera.yaw;
    this.flags = { optimized: false, explained: false, dragged: false, measured: false, evidence: false, windowed: false, turned: false };
    this.lastRail = '';
  }

  private moveCursor(c: typeof state.cursor): void {
    if (!c) {
      this.cursor.classList.remove('show');
      return;
    }
    this.cursor.classList.add('show');
    this.cursor.style.transform = `translate(${c.x * window.innerWidth}px, ${c.y * window.innerHeight}px)`;
    this.cursor.dataset.pose = c.pose;
    this.cursorTag.textContent = CURSOR_LABEL[c.pose] ?? '';
  }

  private buildLegend(): void {
    for (const g of LEGEND) {
      const item = el('div', 'legend-item');
      const gesture = el('span', 'legend-gesture');
      gesture.textContent = g.gesture;
      const label = el('span', 'legend-label');
      label.textContent = g.action;
      item.append(gesture, label);
      this.legend.append(item);
      this.legendItems.set(g.pose, item);
    }
  }

  private buildOnboarding(): void {
    this.onboard.innerHTML = `
      <div class="onboard-card">
        <div class="onboard-title">Raise a hand to begin</div>
        <div class="onboard-sub">The webcam follows your hands and the microphone listens for “Scrub”, so you never have to touch the computer.</div>
        <div class="onboard-grid">
          <div>Open hand<br><em>cut</em></div>
          <div>Pinch and drag<br><em>rotate</em></div>
          <div>Fist<br><em>lock</em></div>
          <div>Two fingers<br><em>measure</em></div>
        </div>
        <div class="onboard-foot">No camera? Drag with the mouse. Press <kbd>?</kbd> for every control.</div>
      </div>`;
  }

  private dismissOnboarding(): void {
    if (this.onboard.classList.contains('gone')) return;
    this.onboard.classList.add('gone');
    setTimeout(() => this.onboard.remove(), 600);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}
