/**
 * Page-wide motion. Every effect here explains something: gestures step
 * through one at a time, and the moment clips loop on screen while their HUD
 * numbers follow the playback.
 * With reduced motion, none of this runs and every sequence shows its final
 * frame.
 */

import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';

gsap.registerPlugin(ScrollTrigger);

/**
 * The clips are recorded at a deliberate pace; on the page they play faster
 * so a scroll step never waits on them. The glove motions read best at 1.75x,
 * the copilot's camera moves at 1.4x.
 */
const RATE = { stepper: 1.75, copilot: 1.4 };
function setRates(): void {
  const apply = (sel: string, rate: number) =>
    document.querySelectorAll<HTMLVideoElement>(`${sel} video`).forEach((v) => {
      v.defaultPlaybackRate = rate;
      v.playbackRate = rate;
      v.addEventListener('play', () => (v.playbackRate = rate));
    });
  apply('[data-stepper]', RATE.stepper);
  apply('[data-copilot]', RATE.copilot);
}

export function initMotion(): void {
  setRates();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const desktop = matchMedia('(min-width: 1024px)').matches;

  if (reduced) return;
  document.documentElement.classList.add('motion');

  const lenis = new Lenis({ lerp: 0.2 });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);

  playWhenVisible(desktop);
  if (desktop) {
    document.querySelectorAll<HTMLElement>('[data-stepper]').forEach(pinStepper);
    document.querySelectorAll<HTMLElement>('[data-copilot]').forEach(pinCopilot);
  }

  addEventListener('load', () => ScrollTrigger.refresh());
}

/**
 * Loops play only while on screen. On desktop the pinned
 * sequences play their own clips one at a time, so they are left to them.
 */
function playWhenVisible(desktop: boolean): void {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const v = e.target as HTMLVideoElement;
      if (e.isIntersecting) void v.play().catch(() => {});
      else v.pause();
    }
  });
  document.querySelectorAll<HTMLVideoElement>('video[data-autoplay]').forEach((v) => {
    if (desktop && v.closest('[data-stepper], [data-copilot]')) return;
    io.observe(v);
  });
}

/** One item per scroll step, pinned (gestures, voice copilot). */
function pinStepper(root: HTMLElement): void {
  root.dataset.pinned = '';
  const steps = [...root.querySelectorAll<HTMLElement>('[data-step]')];
  const frames = [...root.querySelectorAll<HTMLElement>('[data-frame]')];
  let current = -1;
  // Only the sequence on screen decodes video; the other one stays paused.
  let visible = false;

  const sync = () =>
    frames.forEach((f, j) => {
      const v = f.querySelector('video');
      if (!v) return;
      if (visible && j === current) void v.play().catch(() => {});
      else v.pause();
    });

  const show = (i: number) => {
    if (i === current) return;
    current = i;
    steps.forEach((s, j) => (j === i ? s.setAttribute('aria-current', 'step') : s.removeAttribute('aria-current')));
    frames.forEach((f, j) => f.classList.toggle('on', j === i));
    sync();
  };
  show(0);
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    sync();
  }).observe(root);

  ScrollTrigger.create({
    trigger: root,
    start: 'top top',
    end: `+=${steps.length * 45}%`,
    pin: true,
    onUpdate: (st) => show(Math.min(steps.length - 1, Math.floor(st.progress * steps.length))),
  });
}

/**
 * The copilot stage, pinned: each scroll step types a command, plays the app's
 * response once from the start, and pins the annotation when the measurement
 * appears in the clip (data-at, recorded by the capture script).
 */
function pinCopilot(root: HTMLElement): void {
  root.dataset.pinned = '';
  const steps = [...root.querySelectorAll<HTMLElement>('[data-cstep]')];
  const count = root.querySelector<HTMLElement>('[data-ccount]');
  let current = -1;
  let visible = false;
  let watching = 0;

  const watch = (step: HTMLElement, v: HTMLVideoElement) => {
    cancelAnimationFrame(watching);
    const at = Number(step.dataset.at ?? 0.4);
    const tick = () => {
      if (v.duration && v.currentTime / v.duration >= at) step.classList.add('landed');
      else watching = requestAnimationFrame(tick);
    };
    watching = requestAnimationFrame(tick);
  };

  const start = (i: number) => {
    const step = steps[i];
    const v = step.querySelector('video');
    step.classList.remove('typed', 'landed');
    void step.offsetWidth; // restart the typing transition
    step.classList.add('typed');
    if (!v) {
      step.classList.add('landed');
      return;
    }
    v.loop = false;
    v.currentTime = 0;
    if (visible) void v.play().catch(() => {});
    watch(step, v);
  };

  const show = (i: number) => {
    if (i === current) return;
    current = i;
    steps.forEach((s, j) => {
      if (j === i) s.setAttribute('aria-current', 'step');
      else {
        s.removeAttribute('aria-current');
        s.querySelector('video')?.pause();
      }
    });
    if (count) count.textContent = String(i + 1);
    start(i);
  };
  show(0);
  new IntersectionObserver(([e]) => {
    const was = visible;
    visible = e.isIntersecting;
    const v = steps[current]?.querySelector('video');
    if (!v) return;
    if (visible && !was) start(current);
    else if (!visible) v.pause();
  }).observe(root);

  ScrollTrigger.create({
    trigger: root,
    start: 'top top',
    end: `+=${steps.length * 60}%`,
    pin: true,
    onUpdate: (st) => show(Math.min(steps.length - 1, Math.floor(st.progress * steps.length))),
  });
}

