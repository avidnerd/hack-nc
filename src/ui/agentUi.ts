/**
 * The agent's three pieces of screen: the command palette (`/`), the
 * grounding counter in the top bar, and the "Under the hood" drawer that
 * logs every agent call (model, latency, tools, grounded, escalated).
 */

import { agentLog, onAgentLog, onGrounding, type AgentLogEntry, type GroundingTotals } from '../ai/agentClient.ts';

/** What judges can type without knowing the vocabulary. */
export const PALETTE_EXAMPLES = [
  'optimize the cut with a 10 mm margin',
  'how much liver is left',
  'nudge the plane 5 mm toward the tumor',
  'place a stent',
  'resect',
  'write the plan',
];

export class CommandPalette {
  private root = document.createElement('div');
  private input = document.createElement('input');
  private status = document.createElement('div');
  private busy = false;
  private lastFocus: Element | null = null;

  constructor(private readonly submit: (text: string) => Promise<void>) {
    this.root.className = 'palette';
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Command palette');

    const card = document.createElement('div');
    card.className = 'palette-card';

    const form = document.createElement('form');
    form.className = 'palette-form';
    this.input.type = 'text';
    this.input.className = 'palette-input';
    this.input.placeholder = 'Ask Scrub+ to plan';
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.setAttribute('aria-label', 'Command');
    form.append(this.input);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.run(this.input.value);
    });

    this.status.className = 'palette-status';
    this.status.setAttribute('aria-live', 'polite');

    const label = document.createElement('div');
    label.className = 'palette-label';
    label.textContent = 'Try';
    const list = document.createElement('div');
    list.className = 'palette-suggestions';
    for (const ex of PALETTE_EXAMPLES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'palette-suggestion';
      b.textContent = ex;
      b.addEventListener('click', () => {
        this.input.value = ex;
        void this.run(ex);
      });
      list.append(b);
    }

    const foot = document.createElement('div');
    foot.className = 'palette-foot';
    foot.textContent = 'Enter to send · Esc to close';

    card.append(form, this.status, label, list, foot);
    this.root.append(card);
    // A click on the dimmed backdrop closes it, like Escape.
    this.root.addEventListener('mousedown', (e) => {
      if (e.target === this.root) this.close();
    });
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
    document.body.append(this.root);
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    if (this.isOpen) return;
    this.lastFocus = document.activeElement;
    this.root.hidden = false;
    if (!this.busy) this.setStatus('');
    this.input.focus();
    this.input.select();
  }

  close(): void {
    if (!this.isOpen) return;
    this.root.hidden = true;
    this.input.blur();
    if (this.lastFocus instanceof HTMLElement) this.lastFocus.focus();
  }

  private setStatus(text: string): void {
    this.status.textContent = text;
    this.root.classList.toggle('busy', this.busy);
  }

  private async run(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text || this.busy) return;
    this.busy = true;
    this.input.disabled = true;
    this.setStatus('Working');
    try {
      await this.submit(text);
      this.input.value = '';
      this.busy = false;
      this.setStatus('');
      this.close();
    } catch (err) {
      console.warn('[palette]', err);
      this.busy = false;
      this.setStatus('That did not go through. Try again.');
    } finally {
      this.busy = false;
      this.input.disabled = false;
      this.root.classList.remove('busy');
    }
  }
}

/** `GROUNDED ✓ N · REJECTED M`, hidden until the backend has answered. */
export class GroundingCounter {
  private el = document.createElement('span');

  constructor(parent: HTMLElement) {
    this.el.className = 'grounding';
    this.el.hidden = true;
    this.el.title = 'Agent replies whose every number matched a tool result, and replies rejected for a number that did not';
    parent.append(this.el);
    onGrounding((t) => this.render(t));
  }

  private render(t: GroundingTotals): void {
    this.el.hidden = !t.live;
    this.el.textContent = `GROUNDED ✓ ${t.grounded} · REJECTED ${t.rejected}`;
  }
}

/** The live log of agent calls, closed by default. */
export class UnderTheHood {
  private root = document.createElement('aside');
  private list = document.createElement('ol');
  private empty = document.createElement('div');

  constructor() {
    this.root.className = 'hood';
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Under the hood');
    const head = document.createElement('div');
    head.className = 'hood-head';
    const title = document.createElement('span');
    title.textContent = 'Under the hood';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'hood-close';
    close.textContent = 'Close';
    close.addEventListener('click', () => this.toggle(false));
    head.append(title, close);
    this.empty.className = 'hood-empty';
    this.empty.textContent = 'No agent calls yet. Press / and type a request.';
    this.list.className = 'hood-list';
    this.root.append(head, this.empty, this.list);
    document.body.append(this.root);
    onAgentLog((entries) => this.render(entries));
    this.render(agentLog());
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  toggle(open = !this.isOpen): void {
    this.root.hidden = !open;
  }

  private render(entries: readonly AgentLogEntry[]): void {
    this.empty.hidden = entries.length > 0;
    this.list.innerHTML = '';
    // Newest first.
    for (const e of [...entries].reverse().slice(0, 40)) {
      const li = document.createElement('li');
      li.className = 'hood-row';
      if (e.error) li.classList.add('failed');

      const top = document.createElement('div');
      top.className = 'hood-top';
      const model = document.createElement('span');
      model.className = 'hood-model';
      model.textContent = e.model;
      const meta = document.createElement('span');
      meta.className = 'hood-meta';
      const bits = [e.latency_ms !== null ? `${e.latency_ms} ms` : '—', `round ${e.round}`];
      if (e.escalated) bits.push('escalated');
      meta.textContent = bits.join(' · ');
      top.append(model, meta);

      const tools = document.createElement('div');
      tools.className = 'hood-tools';
      tools.textContent = e.tools.length ? e.tools.join(', ') : e.error ? '' : 'reply';

      const verdict = document.createElement('div');
      verdict.className = 'hood-verdict';
      if (e.error) verdict.textContent = `failed: ${e.error}`;
      else if (e.grounded === true) verdict.textContent = 'grounded ✓';
      else if (e.grounded === false) verdict.textContent = 'grounded ✗';
      verdict.classList.toggle('bad', !!e.error || e.grounded === false);

      const said = document.createElement('div');
      said.className = 'hood-text';
      said.textContent = `“${e.text}”`;

      li.append(top, said, tools, verdict);
      this.list.append(li);
    }
  }
}
