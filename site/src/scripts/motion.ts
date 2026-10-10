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
  if (desktop) pinGestures();
  else revealTranscript(document.querySelector('[data-transcript]'));
  moments();

  addEventListener('load', () => ScrollTrigger.refresh());
}

/**
 * Loops play only while on screen. On desktop the pinned gesture sequence
 * plays its own clips one at a time, so they are left to it.
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
    if (desktop && v.closest('[data-gestures]')) return;
    io.observe(v);
  });
}

function revealTranscript(el: Element | null): void {
  if (!el) return;
  ScrollTrigger.create({ trigger: el, start: 'top 85%', once: true, onEnter: () => el.classList.add('in') });
}

/** One gesture per scroll step, pinned. */
function pinGestures(): void {
  const root = document.querySelector<HTMLElement>('[data-gestures]');
  if (!root) return;
  root.dataset.pinned = '';
  const steps = [...root.querySelectorAll<HTMLElement>('[data-step]')];
  const frames = [...root.querySelectorAll<HTMLElement>('[data-frame]')];
  const transcript = root.querySelector('[data-transcript]');
  let current = -1;

  const show = (i: number) => {
    if (i === current) return;
    current = i;
    steps.forEach((s, j) => (j === i ? s.setAttribute('aria-current', 'step') : s.removeAttribute('aria-current')));
    frames.forEach((f, j) => {
      f.classList.toggle('on', j === i);
      const v = f.querySelector('video');
      if (!v) return;
      if (j === i) void v.play().catch(() => {});
      else v.pause();
    });
  };
  show(0);

  ScrollTrigger.create({
    trigger: root,
    start: 'top top',
    end: `+=${steps.length * 80}%`,
    pin: true,
    onUpdate: (st) => {
      // The last 15 % of the pin holds the final gesture while the
      // transcript line arrives.
      const p = Math.min(0.999, st.progress / 0.85);
      show(Math.floor(p * steps.length));
      if (st.progress > 0.85) transcript?.classList.add('in');
    },
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
      const idx = Math.min(verdictEls.length - 1, Math.floor(p * verdictEls.length));
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
