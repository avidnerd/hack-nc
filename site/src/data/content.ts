/**
 * Every fact on the site, in one place. References carry only what the
 * sources were given as (authors, venue, year); titles are not filled in from
 * memory. Formulas and the AI table are lifted
 * from the app README ("The math", "What is AI and what is not"), so the page
 * can never claim a formula the code does not use. A `null` number renders as
 * an em-width dash: it means "not measured yet", never "zero".
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
 * Clips are the app's own renders from scripts/gesture-gifs.ts (docs/gifs).
 * The app's gesture map (src/input/handControl.ts). It differs from early
 * drafts: any open hand cuts, and rotation moved to pinch-and-drag.
 */
export const GESTURES = [
  { key: 'open', label: 'Open hand cuts', line: 'The plane takes your palm’s angle and passes under your hand. Tilt the hand, the cut tilts.', asset: 'cut' },
  { key: 'pinch', label: 'Pinch grabs', line: 'Pinch and drag to turn the body. Pinch the stent to slide it along the aorta.', asset: 'rotate' },
  { key: 'caliper', label: 'Two index fingers measure', line: 'Both index fingers become a caliper, read in millimetres on the cut face.', asset: 'measure' },
  { key: 'fist', label: 'A fist locks', line: 'Close the hand and the cut freezes. The resected piece lifts away.', asset: 'lock' },
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
 * Moment 3 cut on the current liver data). Resected volume waits for a
 * recording to be read from.
 */
export const MOMENTS = [
  {
    key: 'stent',
    title: 'Place and predict',
    line: '“Scrub, place the stent.” The graft seats below the lowest renal artery, sizes itself 15% over the neck, and says whether it seals. Drag it higher and it turns red.',
    asset: 'stent',
    // 41 mm is what the stent engine reports in docs/video/stent.webm (aorta case 8).
    hud: [{ label: 'Neck', from: 41, to: 41, unit: 'mm' }] as HudValue[],
    verdicts: [
      { text: 'Seals', tone: 'accent' },
      { text: 'Won’t seal: renal arteries covered', tone: 'danger' },
    ],
  },
  {
    key: 'optimize',
    title: 'Optimize',
    line: 'The plane you left 6 mm from the tumour, across a hepatic vessel, re-seats itself. It searches 3,751 nearby cuts and stays as close to yours as the constraints allow.',
    asset: 'optimize',
    hud: [
      { label: 'Margin', from: 6.3, to: 10.2, unit: 'mm', digits: 1 },
      { label: 'Vessels', from: 2, to: 0, unit: '' },
      { label: 'Remnant', from: 74, to: 72, unit: '%' },
    ] as HudValue[],
    verdicts: [],
  },
  {
    key: 'resect',
    title: 'Resect',
    line: 'Close your hand to lock the cut. The block that holds the tumour lifts out, with its volume.',
    asset: 'lock',
    hud: [{ label: 'Resected', from: null, to: null, unit: 'mL' }] as HudValue[],
    verdicts: [],
  },
];

export const FORMULAS: [string, string][] = [
  ['REMNANT %', 'liver voxels with n·x − d ≤ 0 ÷ all liver voxels × 100, on the planning grid: 228 × 196 × 56 voxels of 2.0 mm'],
  ['RESECTED mL', 'resected liver voxels × voxel volume ÷ 1000'],
  ['MARGIN mm', 'min EDT_tumour over kept-side liver voxels within one voxel diagonal of the cut. Our own Felzenszwalb–Huttenlocher EDT'],
  ['VESSELS', '6-connected vessel components within one voxel diagonal of the plane, inside the liver box, ≥ 120 mm³'],
  ['CALIPER mm', '|A − B|, fingertip rays intersected with the cut plane'],
  ['NECK mm', 'arc length from the stent’s proximal end over which lumen ø stays within ±10% of the first 15 mm'],
  ['STENT ø', '1.15 × mean lumen ø over the proximal 15 mm. Oversize must be 10–20%'],
  ['ANGULATION', 'angle between centerline tangents 15 mm apart, < 60°'],
  ['FLOW', 'v(s) = Q ÷ πr(s)², ΔP = Σ 8μ·ds ÷ πr⁴. 1D continuity + Poiseuille, not CFD'],
  ['OPTIMIZER', 'remnant − 1000·[margin < min] − 1000·[remnant < min] − 200·vessels − 0.3·Δangle − 0.3·Δd, over 121 normals × 31 offsets'],
];

export const AI_TABLE: [string, string][] = [
  ['Hand landmarks', 'MediaPipe model, on device'],
  ['Segmentations', 'TotalSegmentator, offline, shipped as label volumes'],
  ['Voice to command', 'Regex first. LLM only on a miss, closed schema, 1.5 s timeout'],
  ['Patient narration', 'Template. LLM may reword, discarded if any number changes'],
];

export const NOT_AI: string[] = [
  'Plane, depth, rotation',
  'Every number on screen',
  'Optimizer search',
  'Stent sizing, verdict, flow',
  'Plan note',
];

export const LIMITS: string[] = [
  'Depth comes from apparent hand size. A relative control, corrected by eye.',
  'Cuts are planar. Real liver resections follow Couinaud segments.',
  'Flow is 1D continuity + Poiseuille, not CFD.',
  'Stent rules are simplified EVAR sealing-zone logic, not device selection.',
  'Research datasets and automatic segmentations. Not a medical device.',
];

/** Fill these before shipping; empty values are simply not rendered. */
export const LINKS = {
  app: null as string | null,
  github: null as string | null,
  devpost: null as string | null,
  video: null as string | null,
};
export const TEAM: string[] = [];
