/**
 * The complete command surface, as a regex grammar.
 *
 * This file is the contract between speech, keyboard and the LLM fallback:
 * the `Intent` union is the only way anything reaches the application, so a
 * phrase the regexes miss and the model rescues still lands on exactly the
 * same code path as a keypress.
 */

import type { PresetName } from '../types.ts';

export type Intent =
  | { kind: 'window'; preset: PresetName }
  | { kind: 'show'; structure: string; on: boolean }
  | { kind: 'placeStent' }
  | { kind: 'removeDevice' }
  /** Optional limits spoken with the request ("optimize with a 30 mm margin") become the thresholds. */
  | { kind: 'optimize'; marginMm?: number; remnantPct?: number }
  | { kind: 'measure'; what: string }
  | { kind: 'suggest' }
  | { kind: 'outcomes' }
  | { kind: 'lock'; on: boolean }
  | { kind: 'reset' }
  | { kind: 'mode'; mode: 'surgeon' | 'patient' }
  | { kind: 'writePlan' }
  | { kind: 'setThreshold'; name: 'marginMin' | 'remnantMin'; value: number }
  | { kind: 'loadCase'; id: string }
  | { kind: 'nudgeStent'; mm: number }
  | { kind: 'plane'; on: boolean }
  | { kind: 'cut'; orientation: 'sagittal' | 'coronal' | 'axial'; through: string | null; offsetMm: number | null }
  | { kind: 'distance'; a: string; b: string }
  | { kind: 'query'; what: 'margin' | 'remnant' | 'vessels' }
  | { kind: 'relation'; a: string; b: string }
  | { kind: 'nearest'; a: string }
  | { kind: 'focus'; structure: string }
  | { kind: 'savePlan' }
  | { kind: 'confirm' }
  | { kind: 'restorePlan' }
  | { kind: 'comparePlan' }
  | { kind: 'previousView' }
  | { kind: 'cancel' }
  | { kind: 'tutorial' };

/** Every intent kind, for the LLM fallback's JSON schema. */
export const INTENT_KINDS = [
  'window',
  'show',
  'placeStent',
  'removeDevice',
  'optimize',
  'measure',
  'suggest',
  'outcomes',
  'lock',
  'reset',
  'mode',
  'writePlan',
  'setThreshold',
  'loadCase',
  'nudgeStent',
  'plane',
  'cut',
  'distance',
  'query',
  'relation',
  'nearest',
  'focus',
  'savePlan',
  'confirm',
  'restorePlan',
  'comparePlan',
  'previousView',
  'cancel',
  'tutorial',
] as const;

/* --------------------------------------------------------------- wake word */

/**
 * Strip the wake word. Returns null when it is absent, which is what stops
 * ambient conversation in a noisy demo room from driving the app.
 *
 * Speech recognisers routinely hear "scrub" as "scrubs", "scrubbed", "scrab"
 * or "screwed", so the gate is deliberately generous — the cost of a false
 * accept is one wrong command, the cost of a false reject is a dead demo.
 */
const WAKE = /^\s*(?:hey\s+|ok\s+|okay\s+)?(?:scrub(?:s|bed|z|er)?|scrab|skrub|screwed|scrubbing)(?:\s*plus|\s*\+)?\s*[,.:;]?\s*/i;

export function stripWake(raw: string): string | null {
  const m = WAKE.exec(raw);
  if (!m) return null;
  return raw.slice(m[0].length).trim().toLowerCase();
}

/* ----------------------------------------------------------------- helpers */

/** Spoken numbers that a recogniser often spells out instead of digitising. */
const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
};

function parseNumber(s: string): number | null {
  const digits = /-?\d+(?:\.\d+)?/.exec(s);
  if (digits) return parseFloat(digits[0]);
  for (const [word, value] of Object.entries(WORD_NUMBERS)) {
    if (new RegExp(`\\b${word}\\b`).test(s)) return value;
  }
  return null;
}

/** Spoken structure names mapped onto label keys used by the data. */
const STRUCTURE_ALIASES: Record<string, string> = {
  tumor: 'tumor',
  tumour: 'tumor',
  lesion: 'tumor',
  cancer: 'tumor',
  mass: 'tumor',
  liver: 'liver',
  organ: 'liver',
  vessel: 'vessels',
  vessels: 'vessels',
  vein: 'vessels',
  veins: 'vessels',
  'hepatic vein': 'vessels',
  'portal vein': 'portal_vein',
  artery: 'aorta',
  aorta: 'aorta',
  aortic: 'aorta',
  'left kidney': 'kidney_left',
  'right kidney': 'kidney_right',
  'vena cava': 'ivc',
  'inferior vena cava': 'ivc',
  ivc: 'ivc',
  'i v c': 'ivc',
  cava: 'ivc',
  spleen: 'spleen',
  pancreas: 'pancreas',
  pancreatic: 'pancreas',
  nodule: 'tumor',
  kidney: 'kidneys',
  kidneys: 'kidneys',
  renal: 'kidneys',
  bone: 'spine',
  bones: 'spine',
  spine: 'spine',
  skin: 'skin',
  body: 'skin',
  stent: 'stent',
  graft: 'stent',
  everything: 'all',
  all: 'all',
};

function matchStructure(s: string): string | null {
  // Longest alias first so "portal vein" wins over "vein".
  const keys = Object.keys(STRUCTURE_ALIASES).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (new RegExp(`\\b${k}\\b`).test(s)) return STRUCTURE_ALIASES[k];
  }
  return null;
}

/** Every structure named in the utterance, in spoken order. */
function matchStructures(s: string): string[] {
  const keys = Object.keys(STRUCTURE_ALIASES).sort((a, b) => b.length - a.length);
  const hits: { at: number; key: string; len: number }[] = [];
  for (const k of keys) {
    const re = new RegExp(`\\b${k}\\b`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      // Skip a shorter alias inside a longer one already found ("vein" in "portal vein").
      if (hits.some((h) => m!.index >= h.at && m!.index < h.at + h.len)) continue;
      hits.push({ at: m.index, key: STRUCTURE_ALIASES[k], len: k.length });
    }
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.key);
}

/** "10 millimeters", "1 centimeter", "two centimetres" -> mm. */
function lengthMm(s: string): number | null {
  const m = /(-?\d+(?:\.\d+)?|\b[a-z]+\b)\s*(mm|millimet(?:er|re)s?|cm|centimet(?:er|re)s?)\b/.exec(s);
  if (!m) return null;
  const n = /\d/.test(m[1]) ? parseFloat(m[1]) : parseNumber(m[1]);
  if (n === null) return null;
  return /^c/.test(m[2]) ? n * 10 : n;
}

/** The first number spoken after `word` ("margin of 30" -> 30). */
function numberAfter(s: string, word: string): number | null {
  const i = s.indexOf(word);
  return i < 0 ? null : parseNumber(s.slice(i + word.length));
}

/* ------------------------------------------------------------------ grammar */

/**
 * Match a de-waked utterance against the grammar. Order matters: the more
 * specific patterns come first so "show the patient" is a mode change rather
 * than a request to display a structure called "patient".
 */
export function parseIntent(text: string): Intent | null {
  const s = text.trim().toLowerCase().replace(/[.!?]+$/, '');
  if (!s) return null;

  /* --- copilot: plans, views, navigation (first: their words overlap the
         mode, plan-note and show rules below) ------------------------------ */
  if (/^(cancel|stop|never ?mind|abort|forget it|clear( that| it| the view)?)$/.test(s)) return { kind: 'cancel' };
  if (/^(confirm|yes|yes,? (replace|overwrite)( it)?|overwrite( it)?|replace it|confirm (save|overwrite|it))$/.test(s)) {
    return { kind: 'confirm' };
  }
  if (/\b(tutorial|practi[cs]e|teach me|how do i use|show me how)\b/.test(s)) return { kind: 'tutorial' };
  if (/\b(compare|comparison|versus|difference between)\b/.test(s)) return { kind: 'comparePlan' };
  if (/\b(previous|last) view\b|\bundo( that| the view)?\b|\b(go )?back to the (previous|last)\b/.test(s)) {
    return { kind: 'previousView' };
  }
  if (/\b(save|store|bookmark|mark)\b/.test(s) && /\b(plan|baseline|original|view|this|cut)\b/.test(s) && !/\b(write|export|download|note|file)\b/.test(s)) {
    return { kind: 'savePlan' };
  }
  if (/\b(original|baseline|saved)\b/.test(s) && /\b(show|restore|back|return|load|go|bring|open)\b/.test(s)) {
    return { kind: 'restorePlan' };
  }
  if (/\b(closest|nearest)\b/.test(s) && /\b(vessels?|veins?|arter(y|ies)|vasculature)\b/.test(s)) {
    const named = matchStructures(s).filter((k) => k !== 'vessels' && k !== 'stent');
    return { kind: 'nearest', a: named[0] ?? 'tumor' };
  }
  {
    const named = matchStructures(s).filter((k) => k !== 'stent');
    if (/\b(show|display|view|see|look at|visuali[sz]e)\b/.test(s) && named.length >= 2 && /\b(relative to|in relation to|relationship|relation|next to|against|with respect to|and)\b/.test(s)) {
      return { kind: 'relation', a: named[0], b: named[1] };
    }
    if (/\b(focus|zoom( in)?|cent(er|re)|fly|frame|take me|go)\b.*\b(on|to|at|in)\b/.test(s) && named.length === 1) {
      return { kind: 'focus', structure: named[0] };
    }
  }

  /* --- modes (before `show`, which would otherwise swallow them) --------- */
  if (/\b(show|explain|tell)\b.*\b(patient|family|them)\b/.test(s) || /\bpatient (view|mode)\b/.test(s)) {
    return { kind: 'mode', mode: 'patient' };
  }
  if (/\b(surgeon|clinical|technical|back)\b.*\b(view|mode)\b/.test(s) || /\bgo back\b/.test(s)) {
    return { kind: 'mode', mode: 'surgeon' };
  }

  /* --- named cuts ("make a sagittal cut 10 mm from the tumor") ---------- */
  const orient = /\b(sagittal|coronal|axial|transverse|horizontal|frontal)\b/.exec(s);
  if (orient && /\b(cut|plane|slice|section|view)\b/.test(s)) {
    const o = orient[1];
    const orientation = o === 'sagittal' ? 'sagittal' : o === 'coronal' || o === 'frontal' ? 'coronal' : 'axial';
    const offsetMm = /\b(from|off|away|clear|margin|beside|next to)\b/.test(s) ? lengthMm(s) : null;
    const named = matchStructures(s).filter((k) => k !== 'stent');
    const through = /\brenal arter/.test(s) ? 'renal_arteries' : (named[0] ?? null);
    return { kind: 'cut', orientation, through, offsetMm };
  }

  /* --- distance between structures ("how far is the tumor from the IVC") - */
  if (/\b(how far|distance|gap|clearance|how close|space between)\b/.test(s)) {
    const named = matchStructures(s).filter((k) => k !== 'stent');
    if (named.length >= 2) return { kind: 'distance', a: named[0], b: named[1] };
    // One structure: measured from the tumour, the usual question.
    if (named.length === 1 && named[0] !== 'tumor') return { kind: 'distance', a: 'tumor', b: named[0] };
  }

  /* --- questions about the live plan ------------------------------------- */
  if (/\b(what|what's|how much|how many|which|tell me)\b/.test(s)) {
    if (/\bmargin\b/.test(s)) return { kind: 'query', what: 'margin' };
    if (/\b(remnant|left|remain|remaining|stays?|keep)\b/.test(s)) return { kind: 'query', what: 'remnant' };
    if (/\b(cross|crossing|cut through|divide|divided|hit)\b/.test(s)) return { kind: 'query', what: 'vessels' };
  }

  /* --- window presets ---------------------------------------------------- */
  if (/\bbone\b/.test(s)) return { kind: 'window', preset: 'bone' };
  // "lung tumour" is a structure, not the lung window.
  if (/\blung\b/.test(s) && !/\b(tumou?r|nodule|cancer|lesion)\b/.test(s)) return { kind: 'window', preset: 'lung' };
  if (/\bsoft\b|\bsoft tissue\b/.test(s)) return { kind: 'window', preset: 'soft' };
  if (/\bliver (window|preset)\b/.test(s)) return { kind: 'window', preset: 'liver' };

  /* --- device ------------------------------------------------------------ */
  if (/\b(place|deploy|put|insert|drop|add)\b.*\b(stent|graft|device)\b/.test(s)) {
    return { kind: 'placeStent' };
  }
  if (/\b(remove|take out|delete|undeploy|pull)\b.*\b(stent|graft|device)\b/.test(s)) {
    return { kind: 'removeDevice' };
  }
  if (/\b(move|nudge|slide|push)\b.*\b(up|proximal|higher)\b/.test(s)) {
    return { kind: 'nudgeStent', mm: -5 };
  }
  if (/\b(move|nudge|slide|push)\b.*\b(down|distal|lower)\b/.test(s)) {
    return { kind: 'nudgeStent', mm: 5 };
  }

  /* --- advice (before the optimizer, whose words overlap) ---------------- */
  if (/\b(outcomes?|risks?|simulate|what (if|happens|would happen)|complications?|evidence|prognosis)\b/.test(s)) {
    return { kind: 'outcomes' };
  }
  if (/\b(suggest(ion)?s?|recommend(ation)?s?|advice|advise|what should (i|we) do|what next|next step|thoughts)\b/.test(s)) {
    return { kind: 'suggest' };
  }

  /* --- optimizer --------------------------------------------------------- */
  if (/\b(optimi[sz]e|fix|improve|better|correct|re-?plan|replan)\b/.test(s)) {
    const opt: Intent = { kind: 'optimize' };
    if (/\bmargin\b/.test(s)) {
      const mm = lengthMm(s) ?? numberAfter(s, 'margin');
      if (mm !== null) opt.marginMm = mm;
    }
    if (/\b(remnant|remaining|left)\b/.test(s)) {
      const pct = /(\d+(?:\.\d+)?)\s*(?:%|percent)/.exec(s);
      if (pct) opt.remnantPct = parseFloat(pct[1]);
    }
    return opt;
  }

  /* --- plan note --------------------------------------------------------- */
  if (/\b(write|save|export|generate|summari[sz]e|summary)\b/.test(s)) {
    return { kind: 'writePlan' };
  }

  /* --- thresholds (before `measure`, which also mentions millimetres) ---- */
  const thresholdMatch =
    /\b(?:set|make|use|change)?\s*(margin|remnant)\b.*?(-?\d+(?:\.\d+)?|\b(?:ten|twelve|fifteen|twenty|twenty five|thirty|forty|fifty|eight|five)\b)/.exec(
      s,
    );
  if (thresholdMatch && /\b(set|make|minimum|at least|to)\b/.test(s)) {
    const value = parseNumber(thresholdMatch[2]);
    if (value !== null) {
      return {
        kind: 'setThreshold',
        name: thresholdMatch[1] === 'margin' ? 'marginMin' : 'remnantMin',
        value,
      };
    }
  }

  /* --- case switching ---------------------------------------------------- */
  if (/\b(load|open|switch|go to|bring up)\b/.test(s)) {
    if (/\baort/.test(s) || /\bstent case\b/.test(s)) return { kind: 'loadCase', id: 'aorta' };
    if (/\bliver\b/.test(s) || /\bresection\b/.test(s)) return { kind: 'loadCase', id: 'liver' };
  }

  /* --- measurement ------------------------------------------------------- */
  if (/\b(measure|how (big|long|wide|large)|size of|diameter|what size)\b/.test(s)) {
    const what = matchStructure(s) ?? (/\bneck\b/.test(s) ? 'neck' : 'tumor');
    return { kind: 'measure', what };
  }

  /* --- lock -------------------------------------------------------------- */
  if (/\b(unlock|release|let go|free)\b/.test(s)) return { kind: 'lock', on: false };
  if (/\b(lock|hold|freeze|stay|keep it there)\b/.test(s)) return { kind: 'lock', on: true };

  /* --- reset ------------------------------------------------------------- */
  if (/\b(reset|start over|clear|start again|from scratch)\b/.test(s)) return { kind: 'reset' };

  /* --- cutting plane ----------------------------------------------------- */
  if (/\b(cut|slice|plane)\b/.test(s)) {
    if (/\b(off|away|hide|stop|cancel|no)\b/.test(s)) return { kind: 'plane', on: false };
    return { kind: 'plane', on: true };
  }

  /* --- visibility (last: the broadest patterns) -------------------------- */
  const hide = /\b(hide|remove|turn off|without)\b/.test(s);
  const show = /\b(show|display|highlight|where|find|reveal|turn on)\b/.test(s);
  if (hide || show) {
    const structure = matchStructure(s);
    if (structure) return { kind: 'show', structure, on: !hide };
  }

  return null;
}

/** Rows for the `?` overlay. */
export const VOICE_HELP: [string, string][] = [
  ['bone window', 'switch CT window/level'],
  ['show the tumour', 'highlight a structure'],
  ['hide the skin', 'turn a structure off'],
  ['place the stent', 'deploy and size a graft'],
  ['optimize', 're-seat the cut or the stent'],
  ['measure the kidney', 'standard measurement + normal range'],
  ['show me the tumour relative to the portal vein', 'fly to it, measure, highlight'],
  ['where is the tumour closest to a vessel', 'search every vessel, show the gap'],
  ['focus on the left kidney', 'fly to one structure'],
  ['save this plan / show me the original plan', 'baseline plan'],
  ['compare this cut to the original', 'side-by-side numbers'],
  ['go back to the previous view', 'undo the last navigation'],
  ['sagittal cut 10 mm from the tumour', 'place a named plane'],
  ['how far is the tumour from the portal vein', 'closest wall-to-wall gap'],
  ['what’s the margin', 'ask the live plan'],
  ['what do you suggest', 'next steps for this plan'],
  ['what are the outcomes', 'published rates for this plan’s band'],
  ['set margin to 8', 'change a threshold'],
  ['show the patient', 'plain-language view'],
  ['write the plan', 'download plan.md'],
  ['lock', 'freeze the plane'],
  ['reset', 'back to the start'],
];
