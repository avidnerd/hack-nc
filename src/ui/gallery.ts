/**
 * The gallery (`g` key, "Gallery" button): MSD liver scans that VISTA-3D
 * segmented on a Nebius Serverless Job, precomputed so nobody waits on a cold
 * GPU. Each card shows that scan's own measured numbers from
 * metrics/vista_runs.jsonl: Dice against the reference mask and seconds of
 * VISTA-3D inference.
 */

import type { GalleryEntry } from '../caseLoader.ts';

export class Gallery {
  private root = document.createElement('div');
  private list = document.createElement('div');
  private status = document.createElement('div');
  private entries: GalleryEntry[] | null = null;
  private busy = false;
  private lastFocus: Element | null = null;

  constructor(
    private readonly fetchEntries: () => Promise<GalleryEntry[]>,
    private readonly open_: (id: string) => Promise<void>,
  ) {
    this.root.className = 'palette gallery';
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Case gallery');

    const card = document.createElement('div');
    card.className = 'palette-card';
    const title = document.createElement('div');
    title.className = 'gallery-title';
    title.textContent = 'Case gallery';
    const sub = document.createElement('div');
    sub.className = 'palette-label';
    sub.textContent = 'MSD liver CTs segmented by VISTA-3D on Nebius. Dice: overlap with the reference mask, 0 to 1.';
    this.list.className = 'gallery-list';
    this.status.className = 'palette-status';
    this.status.setAttribute('aria-live', 'polite');
    const foot = document.createElement('div');
    foot.className = 'palette-foot';
    foot.textContent = 'Click a case to open it · Esc to close';
    card.append(title, sub, this.status, this.list, foot);
    this.root.append(card);

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

  toggle(): void {
    if (this.isOpen) this.close();
    else void this.open();
  }

  async open(): Promise<void> {
    if (this.isOpen) return;
    this.lastFocus = document.activeElement;
    this.root.hidden = false;
    if (this.entries) {
      this.focusFirst();
      return;
    }
    this.status.textContent = 'Loading gallery';
    try {
      this.entries = await this.fetchEntries();
      this.status.textContent = '';
      this.render(this.entries);
      this.focusFirst();
    } catch (err) {
      console.warn('[gallery]', err);
      this.status.textContent = 'The gallery could not be loaded.';
    }
  }

  close(): void {
    if (!this.isOpen) return;
    this.root.hidden = true;
    if (this.lastFocus instanceof HTMLElement) this.lastFocus.focus();
  }

  private focusFirst(): void {
    this.list.querySelector<HTMLButtonElement>('button')?.focus();
  }

  private render(entries: GalleryEntry[]): void {
    this.list.replaceChildren(
      ...entries.map((e) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'gallery-case';
        const name = document.createElement('span');
        name.className = 'gallery-name';
        name.textContent = e.name;
        const facts = document.createElement('span');
        facts.className = 'gallery-facts';
        const tumor = e.tumorMl > 0 ? `tumour ${e.tumorMl.toFixed(1)} mL` : 'no tumour segmented';
        facts.textContent = `liver ${Math.round(e.organMl)} mL · ${tumor} · Dice ${e.diceLiver.toFixed(3)} · VISTA-3D ${e.vistaS.toFixed(1)} s`;
        b.append(name, facts);
        b.addEventListener('click', () => void this.pick(e.id, b));
        return b;
      }),
    );
  }

  private async pick(id: string, b: HTMLButtonElement): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.root.classList.add('busy');
    b.setAttribute('aria-busy', 'true');
    this.status.textContent = 'Opening case';
    try {
      await this.open_(id);
      this.status.textContent = '';
      this.close();
    } catch (err) {
      console.warn('[gallery]', err);
      this.status.textContent = 'That case could not be loaded.';
    } finally {
      this.busy = false;
      this.root.classList.remove('busy');
      b.removeAttribute('aria-busy');
    }
  }
}
