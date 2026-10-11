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

const ease = gsap.parseEase('0.65, 0, 0.35, 1') ?? ((t: number) => t);

export function initMotion(): void {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const desktop = matchMedia('(min-width: 1024px)').matches;

  if (reduced) {
    finalFrames();
    return;
  }
  document.documentElement.classList.add('motion');

  const lenis = new Lenis({ lerp: 0.12 });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);

  playWhenVisible(desktop);
  if (desktop) document.querySelectorAll<HTMLElement>('[data-stepper]').forEach(pinStepper);
  moments();

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
    if (desktop && v.closest('[data-stepper]')) return;
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
    end: `+=${steps.length * 80}%`,
    pin: true,
    onUpdate: (st) => show(Math.min(steps.length - 1, Math.floor(st.progress * steps.length))),
  });
}

/**
 * Each moment: the clip loops while on screen and the HUD numbers follow its
 * playback position, moving from their before value to their after value over
 * the middle of the take. Reading currentTime is free; seeking a 1920 px VP9
 * clip on every scroll tick is not, so nothing here ever seeks.
 */
function moments(): void {
  document.querySelectorAll<HTMLElement>('[data-moment]').forEach((m) => {
    const video = m.querySelector<HTMLVideoElement>('video');
    const nums = [...m.querySelectorAll<HTMLElement>('.v[data-from][data-to]')];
    const verdicts = m.querySelector<HTMLElement>('.verdicts');
    const verdictEls = [...m.querySelectorAll<HTMLElement>('[data-verdict]')];
    if (verdicts) verdicts.dataset.live = '';

    const apply = (p: number) => {
      const k = ease(Math.min(1, Math.max(0, (p - 0.3) / 0.4)));
      for (const el of nums) {
        const from = Number(el.dataset.from);
        const to = Number(el.dataset.to);
        const n = el.querySelector('.n');
        if (n) n.textContent = (from + (to - from) * k).toFixed(Number(el.dataset.digits ?? 0));
      }
      // Each verdict shows from the point in the clip where the app says it.
      let idx = 0;
      verdictEls.forEach((v, j) => {
        if (p >= Number(v.dataset.at ?? 0)) idx = j;
      });
      verdictEls.forEach((v, j) => v.classList.toggle('on', j === idx));
    };
    apply(0);

    if (video) {
      const follow = () => {
        if (video.paused) return;
        if (video.duration) apply(video.currentTime / video.duration);
        requestAnimationFrame(follow);
      };
      video.addEventListener('play', follow);
    } else {
      // No clip yet: the numbers play once when the section arrives.
      ScrollTrigger.create({
        trigger: m,
        start: 'top 70%',
        once: true,
        onEnter: () => {
          const o = { p: 0 };
          gsap.to(o, { p: 1, duration: 2.4, ease: 'none', onUpdate: () => apply(o.p) });
        },
      });
    }
  });
}

/** Reduced motion: every sequence at its end state, nothing animates. */
function finalFrames(): void {
  document.querySelectorAll<HTMLElement>('.v[data-from][data-to]').forEach((el) => {
    const n = el.querySelector('.n');
    if (n) n.textContent = Number(el.dataset.to).toFixed(Number(el.dataset.digits ?? 0));
  });
}
