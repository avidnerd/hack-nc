/**
 * Every fact on the site, in one place. References carry only what the
 * sources were given as (authors, venue, year); titles are not filled in from
 * memory. Feature descriptions follow the app README; formulas, validation
 * and limits live there, not here.
 */

export interface Source {
  id: number;
  text: string;
  href?: string;
}

export const SOURCES: Source[] = [
  { id: 1, text: 'Childers & Maggard-Gibbons. JAMA Surgery, 2018.', href: 'https://pubmed.ncbi.nlm.nih.gov/29490366/' },
  { id: 2, text: 'Hansen et al., 2013.' },
  { id: 3, text: 'Reese et al. HPB, 2025.' },
];

/**
 * The app's gesture map (src/input/handControl.ts): any open hand cuts, and
 * rotation is pinch-and-drag. Clips are the app's own renders
 * (scripts/gesture-gifs.ts, docs/video).
 */
export const GESTURES = [
  {
    key: 'open',
    label: 'Open hand',
    line: 'Cuts. The plane follows your palm.',
    asset: 'cut',
  },
  {
    key: 'pinch',
    label: 'Pinch',
    line: 'Turns the body, or slides the stent.',
    asset: 'rotate',
  },
  {
    key: 'caliper',
    label: 'Two index fingers',
    line: 'Measures, in millimetres.',
    asset: 'measure',
  },
  {
    key: 'fist',
    label: 'Fist',
    line: 'Locks the cut and lifts the piece out.',
    asset: 'lock',
  },
] as const;

export interface HudValue {
  label: string;
  from: number | null;
  to: number | null;
  unit: string;
  digits?: number;
}

/**
 * Optimize numbers are what the app shows in docs/video/optimize.webm (the
 * Moment 3 cut on the current liver data). Verdict `at` is the fraction of
 * docs/video/stent.webm at which the app announces it.
 */
export const MOMENTS = [
  {
    key: 'stent',
    title: 'Place a stent graft',
    line: '“Scrub, place the stent.” It sizes itself and says whether it seals. Too high, and it covers the kidneys’ arteries.',
    asset: 'stent',
    hud: [] as HudValue[],
    verdicts: [
      { text: 'Seals', tone: 'accent', at: 0.1 },
      { text: 'Won’t seal: renal arteries covered', tone: 'danger', at: 0.66 },
    ],
  },
  {
    key: 'optimize',
    title: 'Optimize the cut',
    line: '“Scrub, optimize.” Out of 3,751 nearby planes it picks the closest one that clears the tumour and spares the vessels.',
    asset: 'optimize',
    hud: [
      { label: 'Margin', from: 6.3, to: 10.2, unit: 'mm', digits: 1 },
      { label: 'Vessels cut', from: 2, to: 0, unit: '' },
      { label: 'Liver kept', from: 74, to: 72, unit: '%' },
    ] as HudValue[],
    verdicts: [] as { text: string; tone: string; at: number }[],
  },
];

/**
 * The voice copilot (README "the copilot", "smart measurement", "measure,
 * suggest, outcomes"). `say` is the phrase after the wake word; each clip in
 * docs/video sends exactly that phrase through the app's speech grammar, and
 * the figures quoted are the ones on screen in that clip.
 */
export const COPILOT = [
  {
    say: 'show me the tumor relative to the portal vein',
    line: 'Measures the gap and turns to face it. 28.3 mm.',
    asset: 'relation',
  },
  {
    say: 'show me where the tumor is closest to a major vessel',
    line: 'Checks every vessel, shows the nearest. 4.8 mm.',
    asset: 'nearest',
  },
  {
    say: 'measure the tumor',
    line: 'The radiologist’s measurement. 66.6 × 52.8 mm.',
    asset: 'measure-tumor',
  },
  {
    say: 'compare this cut to the original plan',
    line: 'Your saved plan beside the new cut. +3.9 mm margin.',
    asset: 'compare',
  },
  {
    say: 'what are the outcomes',
    line: 'Published rates for plans like this one, with the study.',
    asset: 'outcomes',
  },
];

/** Fill these before shipping; empty values are simply not rendered. */
export const LINKS = {
  app: '/app/' as string | null,
  github: null as string | null,
  devpost: null as string | null,
  video: null as string | null,
};
export const TEAM: string[] = [];
