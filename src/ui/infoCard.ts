/**
 * The card that answers "measure the …", "what do you suggest" and "what
 * happens if": a title, rows of value + reference, and the caveats that
 * change how to read them. It fades in, stays long enough to read aloud, and
 * fades out on its own, because nobody in gloves should have to close it.
 */

import { on } from '../state.ts';

export interface CardRow {
  label: string;
  value: string;
  ref?: string;
  /** Outside the reference range / failing: drawn amber. */
  flag?: boolean;
}

export interface CardContent {
  kicker: string;
  title: string;
  rows: CardRow[];
  notes?: string[];
  /** Small print under the notes, e.g. the source line. */
  foot?: string;
  /** Source links (rule cards), opened in a new tab. */
  links?: { label: string; href: string }[];
  /** Override how long the card stays up. */
  showMs?: number;
}

const SHOW_MS = 16000;

export class InfoCard {
  private el = document.createElement('aside');
  private timer = 0;

  constructor() {
    this.el.className = 'info-card';
    this.el.setAttribute('aria-live', 'polite');
    document.body.append(this.el);
    on('mode', (m) => m === 'patient' && this.hide());
    on('data', () => this.hide());
    on('reset', () => this.hide());
  }

  show(c: CardContent): void {
    this.el.replaceChildren();
    const k = div('info-kicker', c.kicker);
    const t = div('info-title', c.title);
    this.el.append(k, t);
    for (const r of c.rows) {
      const row = div(`info-row${r.flag ? ' flag' : ''}`);
      row.append(div('info-label', r.label), div('info-value', r.value));
      if (r.ref) row.append(div('info-ref', r.ref));
      this.el.append(row);
    }
    for (const n of c.notes ?? []) this.el.append(div('info-note', n));
    if (c.foot) this.el.append(div('info-foot', c.foot));
    for (const l of c.links ?? []) {
      const a = document.createElement('a');
      a.className = 'info-link';
      a.href = l.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = l.label;
      this.el.append(a);
    }
    this.el.classList.add('show');
    document.body.classList.add('card-open');
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.hide(), c.showMs ?? SHOW_MS);
  }

  hide(): void {
    this.el.classList.remove('show');
    document.body.classList.remove('card-open');
  }
}

function div(cls: string, text?: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}
