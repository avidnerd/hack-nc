/**
 * The first-run tutorial: a carousel that teaches each gesture on the
 * practice object and checks the user's hands before moving on.
 *
 * Every slide has a live check against the real tracking state, not a timer:
 * a hand in view (and not at the frame's edge), the object turned by a pinch,
 * zoomed with two hands, cut with an open palm, locked with a fist, measured
 * with two fingers. While the user tries, a status line says which pose it
 * actually sees and, when it is the wrong one, what to change. Each slide
 * also names the mouse/keyboard equivalent, so the tutorial works without a
 * camera, and it can be skipped at any time.
 */

import { on, state } from '../state.ts';
import type { Pose } from '../types.ts';

export type FinishChoice = 'liver' | 'aorta' | 'upload';

export interface TutorialHooks {
  /** Load the practice object (resolves when it is on screen). */
  loadPractice: () => Promise<void>;
  /** Leave the tutorial for a case, or for the upload picker. */
  finish: (choice: FinishChoice) => void;
}

interface Slide {
  title: string;
  body: string;
  /** Mouse / keyboard equivalent. */
  alt: string;
  /** The pose this slide is practising, for live feedback. */
  pose?: Pose;
  /** Has the user done it? Called every frame while the slide is shown. */
  done?: (start: Start) => boolean;
}

interface Start {
  yaw: number;
  pitch: number;
  dist: number;
}

const POSE_WORDS: Record<Pose, string> = {
  IDLE: 'a relaxed hand',
  OPEN: 'an open hand',
  PINCH: 'a pinch',
  FIST: 'a fist',
  CALIPER: 'two pointing fingers',
  LOST: 'no hand',
};

/** What to change when the camera sees `seen` but the slide wants `want`. */
function correction(want: Pose, seen: Pose): string {
  if (want === 'PINCH') return seen === 'OPEN' ? 'Touch your thumb and index fingertip together.' : 'Keep the other fingers loose, thumb on index.';
  if (want === 'OPEN') return seen === 'FIST' || seen === 'PINCH' ? 'Spread all five fingers, palm toward the screen.' : 'Flatten your hand and face the palm to the camera.';
  if (want === 'FIST') return 'Curl every finger into your palm.';
  if (want === 'CALIPER') return 'Use both hands: point one index finger up on each.';
  return '';
}

const SLIDES: Slide[] = [
  {
    title: 'Show your hand',
    body: 'Hold one hand up in front of the camera, about an arm’s length away.',
    alt: 'No camera? Press Next: every step also works with the mouse.',
    done: () => !!state.cursor && edgeHint() === '',
  },
  {
    title: 'Pinch and drag to turn',
    body: 'Touch thumb and index together, then drag sideways. The object turns like it is in your fingers.',
    alt: 'Mouse: drag.',
    pose: 'PINCH',
    done: (s) => Math.abs(state.camera.yaw - s.yaw) + Math.abs(state.camera.pitch - s.pitch) > 0.7,
  },
  {
    title: 'Two pinches to zoom',
    body: 'Pinch with both hands, then pull them apart to come closer (push together to back off).',
    alt: 'Mouse: scroll.',
    pose: 'PINCH',
    done: (s) => Math.abs(state.camera.dist - s.dist) / s.dist > 0.2,
  },
  {
    title: 'Open hand to cut',
    body: 'Flatten your hand over the object. The cut follows your palm; tilt it to tilt the cut.',
    alt: 'Keyboard: X turns the cut on; shift-drag moves it.',
    pose: 'OPEN',
    done: () => state.plane.on,
  },
  {
    title: 'Fist to lock',
    body: 'Make a fist. The cut freezes and the piece lifts away. A second fist unlocks it.',
    alt: 'Keyboard: L.',
    pose: 'FIST',
    done: () => state.plane.locked,
  },
  {
    title: 'Two fingers to measure',
    body: 'Point one index finger up on each hand. The distance between them appears in millimetres, snapping to edges.',
    alt: 'Mouse: click two points.',
    pose: 'CALIPER',
    done: () => !!state.caliper.a && !!state.caliper.b && state.caliper.mm > 0,
  },
  {
    title: 'Voice commands',
    body: 'Everything else is a sentence that starts with “Scrub”, for example “Scrub, show me the tumor relative to the portal vein” or “Scrub, bone window”.',
    alt: 'Press ? any time for every command and key.',
  },
];

/** Advice when the hand sits too near the frame edge (tracking drops there). */
function edgeHint(): string {
  const c = state.cursor;
  if (!c) return '';
  if (c.x < 0.08 || c.x > 0.92 || c.y < 0.08 || c.y > 0.92) return 'Move your hand toward the middle of the camera view.';
  return '';
}

const DONE_KEY = 'scrub.tutorialDone';

export function tutorialDone(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === '1';
  } catch {
    return false;
  }
}

function markDone(): void {
  try {
    localStorage.setItem(DONE_KEY, '1');
  } catch {
    /* private window: the tutorial simply shows again next time */
  }
}

export class Tutorial {
  private root = document.createElement('section');
  private i = 0;
  private start: Start = { yaw: 0, pitch: 0, dist: 1 };
  private passedAt = 0;
  private raf = 0;
  private active = false;

  constructor(private readonly hooks: TutorialHooks) {
    this.root.className = 'tutorial';
    this.root.setAttribute('aria-live', 'polite');
    on('reset', () => this.active && this.capture());
  }

  get running(): boolean {
    return this.active;
  }

  async open(): Promise<void> {
    if (this.active) return;
    this.active = true;
    document.body.append(this.root);
    document.body.classList.add('tutorial-on');
    await this.hooks.loadPractice();
    this.go(0);
    const loop = () => {
      if (!this.active) return;
      this.tick();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  close(choice: FinishChoice): void {
    this.active = false;
    cancelAnimationFrame(this.raf);
    this.root.remove();
    document.body.classList.remove('tutorial-on');
    markDone();
    this.hooks.finish(choice);
  }

  private capture(): void {
    this.start = { yaw: state.camera.yaw, pitch: state.camera.pitch, dist: state.camera.dist };
  }

  private go(i: number): void {
    this.i = Math.max(0, Math.min(SLIDES.length - 1, i));
    this.passedAt = 0;
    this.capture();
    this.render();
  }

  /** Per frame: live feedback, and advance a moment after success. */
  private tick(): void {
    const s = SLIDES[this.i];
    const status = this.root.querySelector<HTMLElement>('.tut-status');
    if (!status) return;
    if (s.done?.(this.start)) {
      if (!this.passedAt) {
        this.passedAt = performance.now();
        status.className = 'tut-status ok';
        status.textContent = 'Done.';
        this.root.querySelector('.tut-dot.on')?.classList.add('done');
      } else if (performance.now() - this.passedAt > 1100) {
        this.go(this.i + 1);
      }
      return;
    }
    const hint = edgeHint();
    const seen = state.cursor?.pose ?? (state.hands.left || state.hands.right ? state.hands.pose : null);
    let text: string;
    let tone = '';
    if (!seen && state.inputMode === 'hands') {
      text = 'I don’t see a hand yet.';
    } else if (hint) {
      text = hint;
      tone = 'warn';
    } else if (s.pose && seen && seen !== s.pose) {
      text = `I see ${POSE_WORDS[seen]}. ${correction(s.pose, seen)}`;
      tone = 'warn';
    } else if (s.pose && seen === s.pose) {
      text = `I see ${POSE_WORDS[seen]}. Now ${s.title.toLowerCase().replace(/^.*? to /, '')}.`;
      tone = 'good';
    } else {
      text = state.inputMode === 'hands' ? (seen ? `I see ${POSE_WORDS[seen]}.` : '') : 'Camera off: use the mouse or keys below.';
    }
    status.className = `tut-status ${tone}`;
    status.textContent = text;
  }

  private render(): void {
    const s = SLIDES[this.i];
    const last = this.i === SLIDES.length - 1;
    this.root.innerHTML = '';
    const card = el('div', 'tut-card');
    const kicker = el('div', 'tut-kicker', `Practice, step ${this.i + 1} of ${SLIDES.length}`);
    const title = el('div', 'tut-title', s.title);
    const body = el('div', 'tut-body', s.body);
    const status = el('div', 'tut-status', '');
    const alt = el('div', 'tut-alt', s.alt);
    const dots = el('div', 'tut-dots');
    SLIDES.forEach((_, k) => dots.append(el('span', `tut-dot${k < this.i ? ' done' : ''}${k === this.i ? ' on' : ''}`)));
    const nav = el('div', 'tut-nav');
    const back = button('Back', () => this.go(this.i - 1), this.i === 0);
    const skip = button('Skip tutorial', () => this.close('liver'));
    nav.append(back, skip);
    if (!last) nav.append(button('Next', () => this.go(this.i + 1), false, true));
    card.append(kicker, title, body, status, alt, dots, nav);
    if (last) {
      const pick = el('div', 'tut-pick');
      pick.append(
        button('Liver case', () => this.close('liver'), false, true),
        button('Aorta case', () => this.close('aorta')),
        button('Upload a CT…', () => this.close('upload')),
      );
      card.append(pick);
    }
    this.root.append(card);
  }
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text: string, onClick: () => void, disabled = false, primary = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `tut-btn${primary ? ' primary' : ''}`;
  b.textContent = text;
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}
