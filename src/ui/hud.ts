/**
 * All DOM the user reads: the numbers panel, mode badge, transcript line,
 * toasts, tracking indicators and the help overlay.
 *
 * Numbers tween rather than snapping, because a number that jumps looks like a
 * glitch while a number that travels looks like a measurement.
 */

import { on, state, type ToastTone } from '../state.ts';
import { clamp, easeInOut } from '../coords.ts';
import { SHORTCUT_HELP } from '../input/keyboard.ts';
import { GESTURE_HELP } from '../input/tuning.ts';
import { VOICE_HELP } from '../voice/intents.ts';

/** How long a number takes to travel to its new value. */
const TWEEN_MS = 420;

interface NumberCell {
  root: HTMLElement;
  valueEl: HTMLElement;
  unitEl: HTMLElement;
  noteEl: HTMLElement;
  /** Tween bookkeeping. */
  from: number;
  to: number;
  startedAt: number;
  decimals: number;
  blank: boolean;
  /** Value bar with a threshold tick; null for cells without one. */
  bar: { fill: HTMLElement; tick: HTMLElement; max: number } | null;
}

export class Hud {
  private cells = new Map<string, NumberCell>();
  private numbersEl = document.getElementById('numbers') as HTMLElement;
  private calloutsEl = document.getElementById('callouts') as HTMLElement;
  private toastsEl = document.getElementById('toasts') as HTMLElement;
  private transcriptEl = document.getElementById('transcript') as HTMLElement;
  private responseEl = document.getElementById('response') as HTMLElement;
  private badgeEl = document.getElementById('mode-badge') as HTMLElement;
  private caseEl = document.getElementById('case-name') as HTMLElement;
  private handStatus = document.getElementById('hand-status') as HTMLElement;
  private handL = document.getElementById('hand-l') as HTMLElement;
  private handR = document.getElementById('hand-r') as HTMLElement;
  private micStatus = document.getElementById('mic-status') as HTMLElement;
  private poseBadge = document.getElementById('pose-badge') as HTMLElement;
  private bannerEl = document.getElementById('banner') as HTMLElement;
  private helpEl = document.getElementById('help') as HTMLElement;
  private camwrap = document.getElementById('camwrap') as HTMLElement;

  private responseTimer = 0;

  constructor() {
    this.buildCells();
    this.buildHelp();
    this.subscribe();
    this.addHelpHint();
  }

  /* ----------------------------------------------------------- construction */

  private buildCells(): void {
    this.numbersEl.innerHTML = '';
    // REMNANT and MARGIN carry the liver story; VESSELS is the constraint;
    // NECK only appears once a device exists.
    this.addCell('remnant', 'Liver remnant', '%', 0, 100);
    this.addCell('margin', 'Tumour margin', 'mm', 1, 20);
    this.addCell('vessels', 'Vessels crossed', '', 0, 0);
    this.addCell('neck', 'Seal zone (neck)', 'mm', 0, 40);
    this.addCell('flow', 'Flow resistance', '', 0, 150);
    this.setCellVisible('neck', false);
    this.setCellVisible('flow', false);
  }

  private addCell(key: string, label: string, unit: string, decimals: number, barMax: number): void {
    const root = document.createElement('div');
    root.className = 'num';

    const line = document.createElement('div');
    const valueEl = document.createElement('span');
    valueEl.className = 'num-value dim';
    valueEl.textContent = '--';
    const unitEl = document.createElement('span');
    unitEl.className = 'num-unit';
    unitEl.textContent = unit;
    line.append(valueEl, unitEl);

    const labelEl = document.createElement('div');
    labelEl.className = 'num-label';
    labelEl.textContent = label;

    const noteEl = document.createElement('div');
    noteEl.className = 'num-note';

    let bar: NumberCell['bar'] = null;
    const barEl = document.createElement('div');
    barEl.className = 'num-bar';
    if (barMax > 0) {
      const fill = document.createElement('div');
      fill.className = 'num-bar-fill';
      const tick = document.createElement('div');
      tick.className = 'num-bar-tick';
      barEl.append(fill, tick);
      bar = { fill, tick, max: barMax };
    }

    root.append(labelEl, line, barEl, noteEl);
    this.numbersEl.append(root);

    this.cells.set(key, {
      root,
      valueEl,
      unitEl,
      noteEl,
      from: 0,
      to: 0,
      startedAt: 0,
      decimals,
      blank: true,
      bar,
    });
  }

  private planeShown = false;

  /**
   * Show the cards the current case is about: the liver numbers for a
   * resection, the seal zone and flow for a stent. A cut in the aorta case is
   * a viewing section, not a resection, so it brings no liver numbers (there
   * is no tumour to have a margin from).
   */
  private layoutCells(): void {
    const aorta = state.data?.meta.kind === 'aorta';
    this.planeShown = state.plane.on;
    // A copilot viewing section is not a resection either.
    // The numbers describe a cut, so they appear once there is one.
    const liver = state.data?.meta.kind === 'liver' && state.plane.on && !state.viewSection;
    for (const k of ['remnant', 'margin', 'vessels']) this.setCellVisible(k, liver);
    this.setCellVisible('neck', !!state.stent);
    this.setCellVisible('flow', aorta && state.flowDrop !== null);
  }

  private setCellVisible(key: string, shown: boolean): void {
    const c = this.cells.get(key);
    if (c) c.root.style.display = shown ? '' : 'none';
  }

  /* ------------------------------------------------------------ subscriptions */

  private subscribe(): void {
    on('metrics', () => this.syncNumbers());
    on('viewSection', () => this.layoutCells());
    on('stent', () => {
      this.layoutCells();
      this.syncNumbers();
    });
    on('flowDrop', () => this.syncNumbers());
    on('plane', (p) => {
      if (p.on !== this.planeShown) this.layoutCells();
    });
    on('thresholds', () => this.syncNumbers());

    on('mode', (m) => {
      this.badgeEl.textContent = m === 'patient' ? 'Patient' : 'Surgeon';
      this.badgeEl.classList.toggle('patient', m === 'patient');
      this.numbersEl.classList.toggle('hidden', m === 'patient');
      this.calloutsEl.hidden = m !== 'patient';
    });

    on('data', (d) => {
      if (d) this.caseEl.textContent = d.meta.name;
      this.layoutCells();
    });

    on('hands', (h) => {
      this.handL.classList.toggle('on', h.left);
      this.handR.classList.toggle('on', h.right);
      this.handStatus.classList.toggle('active', h.left || h.right);
      this.handStatus.classList.toggle('lost', h.pose === 'LOST');
      this.poseBadge.textContent = h.pose;
    });

    on('listening', (v) => this.micStatus.classList.toggle('listening', v));

    on('transcript', (t) => {
      this.transcriptEl.textContent = t ? `“${t}”` : '';
      this.transcriptEl.classList.toggle('show', !!t);
    });

    on('response', (r) => this.showResponse(r));

    on('toast', ({ text, tone }) => this.toast(text, tone));

    on('showWebcam', (v) => this.camwrap.classList.toggle('hidden', !v));
    on('showHelp', (v) => {
      this.helpEl.hidden = !v;
    });

    on('caliper', (c) => this.syncCaliper(c.mm, !!(c.a && c.b)));

    on('reset', () => {
      this.calloutsEl.innerHTML = '';
      this.showResponse('');
      for (const c of this.cells.values()) {
        c.blank = true;
        c.valueEl.textContent = '--';
        c.valueEl.className = 'num-value dim';
        c.noteEl.textContent = '';
        delete c.root.dataset.tone;
        if (c.bar) c.bar.fill.style.width = '0%';
      }
      this.setCellVisible('neck', false);
    });
  }

  /* ----------------------------------------------------------- numbers panel */

  /** Re-target every tween from the current state. Cheap; call freely. */
  syncNumbers(): void {
    const m = state.metrics;
    const th = state.thresholds;

    if (m) {
      this.retarget('remnant', m.remnantPct, m.remnantPct < th.remnantMin ? 'bad' : 'ok');
      this.retarget(
        'margin',
        m.marginMm,
        m.tumorIncomplete || m.marginMm <= 0 ? 'bad' : m.marginMm < th.marginMin ? 'warn' : 'ok',
      );
      this.retarget('vessels', m.vesselsCrossed, m.vesselsCrossed > 0 ? 'warn' : 'ok');

      const marginCell = this.cells.get('margin');
      if (marginCell) {
        marginCell.noteEl.textContent = m.tumorIncomplete ? 'tumour not fully resected' : '';
      }
      const vesselCell = this.cells.get('vessels');
      if (vesselCell) {
        vesselCell.noteEl.textContent = m.vesselName ?? '';
        vesselCell.noteEl.style.color = m.vesselsCrossed > 0 ? '' : 'var(--ink-faint)';
      }
    }

    if (state.flowDrop !== null) {
      this.setCellVisible('flow', state.data?.meta.kind === 'aorta');
      this.retarget('flow', state.flowDrop, state.flowDrop > 100.5 ? 'warn' : 'ok');
      const fc = this.cells.get('flow');
      if (fc) fc.noteEl.textContent = state.stent ? 'Native vessel = 100. Illustrative 1D model, not CFD.' : 'Native vessel. Illustrative 1D model.';
    }

    // Threshold ticks: where "safe" starts on each bar.
    this.setTick('flow', 100);
    this.setTick('remnant', th.remnantMin);
    this.setTick('margin', th.marginMin);
    this.setTick('neck', 10);

    const s = state.stent;
    if (s) {
      this.retarget('neck', s.neckMm, s.seals ? 'ok' : 'bad');
      const cell = this.cells.get('neck');
      if (cell) cell.noteEl.textContent = `${s.diameterMm.toFixed(0)} mm device, ${s.oversizePct.toFixed(0)}% oversize`;
    }
  }

  private setTick(key: string, at: number): void {
    const b = this.cells.get(key)?.bar;
    if (b) b.tick.style.left = `${clamp(at / b.max, 0, 1) * 100}%`;
  }

  private retarget(key: string, to: number, tone: 'ok' | 'warn' | 'bad'): void {
    const c = this.cells.get(key);
    if (!c) return;
    const current = c.blank ? to : this.currentValue(c);
    c.from = current;
    c.to = to;
    c.startedAt = performance.now();
    c.blank = false;
    c.valueEl.className = `num-value${tone === 'ok' ? '' : ' ' + tone}`;
    c.root.dataset.tone = tone;
  }

  private currentValue(c: NumberCell): number {
    const t = clamp((performance.now() - c.startedAt) / TWEEN_MS, 0, 1);
    return c.from + (c.to - c.from) * easeInOut(t);
  }

  /** Advance the number tweens. Called from the main loop. */
  tick(): void {
    for (const c of this.cells.values()) {
      if (c.blank) continue;
      const t = clamp((performance.now() - c.startedAt) / TWEEN_MS, 0, 1);
      const v = c.from + (c.to - c.from) * easeInOut(t);
      c.valueEl.textContent = v.toFixed(c.decimals);
      if (c.bar) c.bar.fill.style.width = `${clamp(v / c.bar.max, 0, 1) * 100}%`;
    }
    // Let the response line fade on its own schedule.
    if (this.responseTimer && performance.now() > this.responseTimer) {
      this.responseEl.classList.remove('show');
      this.responseTimer = 0;
    }
    if (state.transcript && performance.now() - state.transcriptAt > 3000) {
      this.transcriptEl.classList.remove('show');
    }
  }

  private syncCaliper(mm: number, active: boolean): void {
    // The caliper borrows the MARGIN slot's note line so the panel keeps a
    // stable shape; the 3D label carries the live number.
    const cell = this.cells.get('margin');
    if (!cell) return;
    if (active) cell.noteEl.textContent = `caliper ${mm.toFixed(1)} mm`;
    else if (cell.noteEl.textContent?.startsWith('caliper')) cell.noteEl.textContent = '';
  }

  /* ------------------------------------------------------------------ text */

  private showResponse(text: string): void {
    this.responseEl.textContent = text;
    this.responseEl.classList.toggle('show', !!text);
    // Long sentences need longer on screen; patient narration is two sentences.
    this.responseTimer = text ? performance.now() + 2600 + text.length * 45 : 0;
  }

  toast(text: string, tone: ToastTone = 'info'): void {
    const el = document.createElement('div');
    el.className = `toast ${tone}`;
    el.textContent = text;
    this.toastsEl.append(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 320);
    }, 2400);
  }

  banner(text: string | null): void {
    this.bannerEl.hidden = !text;
    if (text) this.bannerEl.textContent = text;
  }

  /** Patient mode's three callouts. */
  setCallouts(items: { label: string; text: string; kind: 'removed' | 'placed' | 'stays' }[]): void {
    this.calloutsEl.innerHTML = '';
    for (const it of items) {
      const root = document.createElement('div');
      root.className = `callout ${it.kind}`;
      const l = document.createElement('div');
      l.className = 'callout-label';
      l.textContent = it.label;
      const t = document.createElement('div');
      t.className = 'callout-text';
      t.textContent = it.text;
      root.append(l, t);
      this.calloutsEl.append(root);
    }
  }

  /* ------------------------------------------------------------ help overlay */

  private buildHelp(): void {
    // Keys and gestures read as key caps; spoken phrases read as quotes.
    const section = (title: string, rows: [string, string][], spoken = false) => {
      const h = document.createElement('h2');
      h.textContent = title;
      const grid = document.createElement('div');
      grid.className = 'help-grid';
      for (const [k, v] of rows) {
        const kb = document.createElement(spoken ? 'q' : 'kbd');
        kb.textContent = k;
        const d = document.createElement('div');
        d.textContent = v;
        grid.append(kb, d);
      }
      return [h, grid];
    };

    this.helpEl.innerHTML = '';
    const cols = document.createElement('div');
    cols.className = 'help-cols';
    const left = document.createElement('div');
    const right = document.createElement('div');

    left.append(...section('Gestures', GESTURE_HELP));
    left.append(...section('Mouse', [
      ['drag', 'rotate'],
      ['shift + drag', 'move the cutting plane'],
      ['right-drag', 'tilt the cutting plane'],
      ['scroll', 'zoom'],
      ['click ×2', 'caliper between two points'],
    ]));
    right.append(...section('Voice (start with “Scrub”)', VOICE_HELP, true));
    right.append(...section('Keyboard', SHORTCUT_HELP));

    cols.append(left, right);

    const title = document.createElement('h2');
    title.textContent = 'Scrub+ controls';
    this.helpEl.append(title, cols);
  }

  private addHelpHint(): void {
    const hint = document.createElement('div');
    hint.className = 'help-hint';
    hint.textContent = '? for controls';
    document.body.append(hint);
  }

  /** Called once the first case is on the GPU. */
  hideLoader(): void {
    const el = document.getElementById('loader');
    if (!el) return;
    el.classList.add('gone');
    setTimeout(() => el.remove(), 560);
  }
}
