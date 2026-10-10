/**
 * Hero orchestration: load the volume, then let scroll drive a cutting plane
 * through the torso. The sweep is tuned against this case's anatomy, computed
 * from the label volume at load (never hard-coded): the plane opens the body,
 * reaches the liver, exposes the tumour, then stops 3 mm short of the first
 * hepatic vessel, which brightens to the accent as the cut approaches it.
 * That is the same situation as the app's Moment 3.
 */

import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

import { cameraDir, type Vec3 } from '@app/coords.ts';

import { HeroRenderer, loadHero, type HeroData } from './renderer.ts';

gsap.registerPlugin(ScrollTrigger);

const DEG = Math.PI / 180;
/** The sweep's plane normal: toward the patient's right flank, from above. */
const CUT_YAW = 60 * DEG;
const CUT_PITCH = 20 * DEG;
/**
 * The camera sits well off the plane normal, so the cut is seen at an angle:
 * a face-on cut reads as a fade, an oblique one reads as an incision.
 */
const VIEW_YAW = 18 * DEG;
const VIEW_PITCH = 30 * DEG;
/** Stop this far in front of the first hepatic vessel, in mm. */
const VESSEL_GAP_MM = 3;

interface Sweep {
  n: Vec3;
  start: number;
  liver: number;
  tumor: number;
  stop: number;
}

/** Where along the sweep normal each structure first meets the plane. */
function planSweep(data: HeroData): Sweep {
  const { meta, labels } = data;
  const [nx, ny, nz] = meta.shape;
  const [sx, sy, sz] = meta.spacing;
  const n = cameraDir(CUT_YAW, CUT_PITCH);
  const id = (key: string) => meta.labels.find((l) => l.key === key)?.id ?? -1;
  const liverId = id('liver');
  const tumorId = id('tumor');
  const vesselId = id('hepatic_vessels');

  let start = -Infinity;
  let liver = -Infinity;
  let tumor = -Infinity;
  let vessel = -Infinity;
  for (let k = 0, o = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++, o++) {
        const l = labels[o];
        const v = data.volume[o];
        if (v < 40 && l === 0) continue; // air
        const d = n[0] * (meta.origin[0] + i * sx) + n[1] * (meta.origin[1] + j * sy) + n[2] * (meta.origin[2] + k * sz);
        if (d > start) start = d;
        if (l === liverId && d > liver) liver = d;
        else if (l === tumorId && d > tumor) tumor = d;
        else if (l === vesselId && d > vessel) vessel = d;
      }
  return { n, start: start + 4, liver, tumor, stop: vessel + VESSEL_GAP_MM };
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Scroll progress 0..1 to plane offset: body, liver, tumour, vessel. */
function sweepAt(s: Sweep, p: number): number {
  const stops: [number, number][] = [
    [0.08, s.start],
    [0.5, s.liver - 2],
    [0.78, Math.min(s.tumor - 8, (s.tumor + s.stop) / 2)],
    [1.0, s.stop],
  ];
  if (p <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [p1, d1] = stops[i];
    const [p0, d0] = stops[i - 1];
    if (p <= p1) return d0 + (d1 - d0) * smooth(p0, p1, p);
  }
  return s.stop;
}

export async function mountHero(root: HTMLElement): Promise<void> {
  const canvas = root.querySelector<HTMLCanvasElement>('[data-hero-canvas]')!;
  const counter = root.querySelector<HTMLElement>('[data-hero-loading]')!;
  const handBtn = root.querySelector<HTMLButtonElement>('[data-hand-button]');
  const handNote = root.querySelector<HTMLElement>('[data-hand-note]');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // The pin exists before the volume arrives, so the page does not jump when
  // it loads. It sorts first because it is first on the page but created last.
  let progress = reduced ? 1 : 0;
  let onScroll = () => {};
  if (!reduced) {
    ScrollTrigger.create({
      trigger: root,
      start: 'top top',
      end: '+=200%',
      pin: true,
      scrub: true,
      refreshPriority: 1,
      onUpdate: (st) => {
        progress = st.progress;
        onScroll();
      },
    });
    ScrollTrigger.sort();
    ScrollTrigger.refresh();
  }

  let data: HeroData;
  try {
    data = await loadHero('/data/liver/lo/', (f) => {
      counter.textContent = `LOADING VOLUME ${Math.round(f * 100)}%`;
    });
  } catch (err) {
    console.warn('[hero] volume failed to load', err);
    counter.textContent = 'VOLUME UNAVAILABLE';
    return;
  }

  const hero = new HeroRenderer(canvas, data);
  const sweep = planSweep(data);
  const c = data.meta.stats.liver.centroid;
  const pivot: Vec3 = [c[0] + data.meta.origin[0], c[1] + data.meta.origin[1], c[2] + data.meta.origin[2]];
  hero.yaw = VIEW_YAW;
  hero.pitch = VIEW_PITCH;

  let hand: import('./hand.ts').HandSession | null = null;

  const applyScroll = () => {
    const d = sweepAt(sweep, progress);
    hero.setPlane(progress > 0.08, sweep.n, d);
    // Glow ramps over the last stretch: tumour exposed, vessel 3 mm away.
    const g = smooth(sweep.liver - 4, sweep.stop, d);
    hero.setVesselGlow(g * g);
  };
  applyScroll();
  onScroll = () => {
    if (!hand?.steering) applyScroll();
  };

  new ResizeObserver(() => hero.resize()).observe(canvas);

  // Render only while the hero is on screen.
  let visible = true;
  new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(root);

  const t0 = performance.now();
  let logged = false;
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    if (!visible) return;
    // The one perpetual motion on the page: a slow, small turn.
    if (!reduced && !hand?.steering) hero.yaw = VIEW_YAW + Math.sin((now - t0) * 0.00011) * 9 * DEG;
    hand?.tick(now);
    hero.render();
    if (import.meta.env.DEV && !logged && now - t0 > 4000) {
      logged = true;
      console.info('[hero] frame', hero.stats);
    }
  };
  requestAnimationFrame(loop);

  counter.hidden = true;
  root.dataset.ready = '';

  // The first level is 4 mm in-plane so the page paints fast; the 2 mm level
  // streams in behind it and replaces it in place. A failure just keeps lo.
  const idle = (cb: () => void) => ('requestIdleCallback' in window ? requestIdleCallback(cb, { timeout: 1500 }) : setTimeout(cb, 300));
  idle(() => {
    loadHero('/data/liver/hi/')
      .then((hi) => {
        hero.upgrade(hi);
        root.dataset.hires = '';
      })
      .catch((err) => console.warn('[hero] high-resolution volume unavailable', err));
  });

  if (handBtn && handNote) {
    handBtn.hidden = false;
    handBtn.addEventListener('click', async () => {
      if (hand) {
        hand.stop();
        hand = null;
        root.removeAttribute('data-hand');
        handBtn.textContent = 'Use your hand';
        applyScroll();
        return;
      }
      handBtn.disabled = true;
      handNote.textContent = 'Starting camera. Frames stay on this device.';
      const { startHand } = await import('./hand.ts');
      hand = await startHand(hero, pivot);
      handBtn.disabled = false;
      if (!hand) {
        handNote.textContent = 'No camera available. Scroll drives the cut instead.';
        return;
      }
      root.dataset.hand = '';
      handBtn.textContent = 'Stop camera';
      handNote.textContent = 'Hold up an open hand. Tilt it to tilt the cut.';
    });
  }
}
