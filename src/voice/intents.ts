/**
 * The complete command surface, as a regex grammar.
 *
 * This file is the contract between speech, keyboard and the LLM fallback:
 * the `Intent` union is the only way anything reaches the application, so a
 * phrase the regexes miss and the model rescues still lands on exactly the
 * same code path as a keypress.
 */

import { findCard } from '../devices/deviceRules.ts';
import type { OptimizePriority, PresetName } from '../types.ts';

export type Intent =
  | { kind: 'window'; preset: PresetName }
  | { kind: 'show'; structure: string; on: boolean }
  /** `device`: a rule card id ("size for a Gore Excluder"); the stent is checked against its IFU limits. */
  | { kind: 'placeStent'; device?: string }
  | { kind: 'removeDevice' }
  /**
   * Re-seat the cut. Limits spoken with the request ("with a 30 mm margin")
   * become the thresholds; `priority` says what to give up first; `widen`
   * asks for 5 mm more margin than the cut has now. `preview` (a question:
   * "what if", "is there", "would") outlines the answer without moving
   * anything, and "do it" applies it.
   */
  | {
      kind: 'optimize';
      marginMm?: number;
      remnantPct?: number;
      priority?: Exclude<OptimizePriority, 'balanced'>;
      widen?: boolean;
      preview?: boolean;
    }
  /** Slide the cut along its normal; positive is toward the tumour. */
  | { kind: 'shiftPlane'; mm: number; preview?: boolean }
  | { kind: 'applyPreview' }
  | { kind: 'undo' }
  /** "Why did you move it"; with `about`, what limits that number on the current cut. */
  | { kind: 'explain'; about?: 'margin' | 'remnant' | 'vessels' }
  | { kind: 'measure'; what: string }
  | { kind: 'suggest' }
  | { kind: 'outcomes' }
  | { kind: 'lock'; on: boolean }
  | { kind: 'reset' }
  | { kind: 'mode'; mode: 'surgeon' | 'patient' }
  | { kind: 'writePlan' }
  | { kind: 'setThreshold'; name: 'marginMin' | 'remnantMin'; value: number }
  | { kind: 'loadCase'; id: string }
  /** "What's this?": a VISTA-3D point prompt where the pointer is. */
  | { kind: 'whatsThis' }
  | { kind: 'nudgeStent'; mm: number }
  | { kind: 'plane'; on: boolean }
  /**
   * A described cut. `oblique` faces away from the organ's centre through the
   * structure; with `between`, the cut sits halfway across the gap between
   * `through` and `between`, square to it.
   */
  | {
      kind: 'cut';
      orientation: 'sagittal' | 'coronal' | 'axial' | 'oblique';
      through: string | null;
      offsetMm: number | null;
      between?: string;
    }
  /** Turn the cut as seen on screen: its face leans `dir` by `deg`. */
  | { kind: 'tiltPlane'; dir: TiltDir; deg: number; preview?: boolean }
  /** Square the cut to the nearest of sagittal, coronal, axial. */
  | { kind: 'straightenPlane' }
  | { kind: 'distance'; a: string; b: string }
  | { kind: 'query'; what: 'margin' | 'remnant' | 'vessels' | 'summary' }
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

export type TiltDir = 'left' | 'right' | 'up' | 'down' | 'toward' | 'away' | 'clockwise' | 'counterclockwise';

/** Every intent kind, for the LLM fallback's JSON schema. */
export const INTENT_KINDS = [
  'window',
  'show',
  'placeStent',
  'removeDevice',
  'optimize',
  'shiftPlane',
  'tiltPlane',
  'straightenPlane',
  'applyPreview',
  'undo',
  'explain',
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
  // "twenty five": tens before units, or the units word alone would win.
  const compound = /\b(twenty|thirty|forty|fifty)[ -](one|two|three|four|five|six|seven|eight|nine)\b/.exec(s);
  if (compound) return WORD_NUMBERS[compound[1]] + WORD_NUMBERS[compound[2]];
  for (const [word, value] of Object.entries(WORD_NUMBERS).sort((a, b) => b[1] - a[1])) {
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
  'hepatic vessel': 'hepatic_vessels',
  'hepatic vessels': 'hepatic_vessels',
  'intrahepatic vessel': 'hepatic_vessels',
  'intrahepatic vessels': 'hepatic_vessels',
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

/** A number spoken right after `word` ("margin of 30", "margin to fifteen"); null otherwise. */
function numberAfter(s: string, word: string): number | null {
  const m = new RegExp(String.raw`\b${word}\s+(?:of|to|at|around|about|is|was|were|be|set to|=)?\s*([a-z0-9.]+(?:[ -](?:five|one|two|three|four|six|seven|eight|nine))?)`).exec(s);
  return m ? parseNumber(m[1]) : null;
}

const VESSEL_WORDS = String.raw`(vessels?|veins?|arter(?:y|ies)|portal|hepatic|ivc|vena cava|vasculature)`;

/** What a planning request asks for, beyond "optimize". */
function planOptions(s: string): Omit<Extract<Intent, { kind: 'optimize' }>, 'kind' | 'preview'> {
  const out: Omit<Extract<Intent, { kind: 'optimize' }>, 'kind' | 'preview'> = {};
  if (/\bmargin\b/.test(s)) {
    const mm = lengthMm(s) ?? numberAfter(s, 'margin');
    if (mm !== null && mm > 0) out.marginMm = mm;
  }
  const pct = /(\d+(?:\.\d+)?)\s*(?:%|percent)/.exec(s);
  if (pct && /\b(remnant|remaining|left|liver|keep|keeping|kept|spare|save)\b/.test(s)) out.remnantPct = parseFloat(pct[1]);
  if (
    new RegExp(String.raw`\b(spare|spares|sparing|avoid|avoids|avoiding|miss|misses|clear|clears|protect|save|without (crossing|cutting|hitting|touching)|(do not|don'?t|doesn'?t|not|never|no) (cross|cut|hit|touch)\w*)\b.*\b${VESSEL_WORDS}\b`).test(s) ||
    new RegExp(String.raw`\b(no|zero|fewer|less) ${VESSEL_WORDS}\b`).test(s) ||
    new RegExp(String.raw`\b${VESSEL_WORDS} first\b`).test(s) ||
    new RegExp(String.raw`\b(further|farther|away|clear|distance) (from|of)\b.*\b${VESSEL_WORDS}\b`).test(s)
  ) {
    out.priority = 'vessels';
  } else if (
    /\b(more|most|maximum|max|maximi[sz]e|bigger|larger)\b.*\b(liver|remnant|tissue)\b/.test(s) ||
    /\b(liver|remnant)\b.*\b(first|bigger|larger)\b/.test(s)
  ) {
    out.priority = 'remnant';
  }
  if (
    /\b(bigger|wider|larger|more|increase|widen|maximi[sz]e|better|safer)\b.*\bmargin\b|\bmargin\b.*\b(bigger|wider|larger)\b/.test(s) ||
    /\bmore (breathing )?(room|space|clearance|distance)\b.*\btumou?r\b|\btumou?r\b.*\bmore (breathing )?(room|space|clearance|distance)\b/.test(s)
  ) {
    out.widen = true;
  }
  return out;
}

/** A question about a different plan, not an order to make it. */
const HYPOTHETICAL =
  /\b(what if|what would|what happens|what about|would|could|is there|are there|is it possible|possible to|how much .* (with|if)|can (i|we) (get|have|do)|any way)\b/;

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
  if (/^(what'?s|what is) (this|that|here)$|^(segment|identify|label) (this|that|here|it)$/.test(s)) return { kind: 'whatsThis' };
  if (/\b(tutorial|practi[cs]e|teach me|how do i use|show me how)\b/.test(s)) return { kind: 'tutorial' };
  if (/\b(compare|comparison|versus|difference between)\b/.test(s)) return { kind: 'comparePlan' };
  // Undo is about the cut first (an optimize, a "do it"); with nothing to
  // undo there, main.ts falls back to the previous view.
  if (
    /^(undo|revert|put it back)\b/.test(s) ||
    /\bundo (that|it|this|the (optimi[sz]ation|change|move|cut|last))\b/.test(s) ||
    /\b(go back|return|revert|back) to (my|the old|the previous|the last|my old|my own) (cut|plane)\b/.test(s) ||
    /\b(put|move) (it|the (cut|plane)) back\b/.test(s)
  ) {
    return { kind: 'undo' };
  }
  if (/\b(previous|last) view\b|\b(go )?back to the (previous|last)\b/.test(s)) {
    return { kind: 'previousView' };
  }
  if (/^(do it|do that|apply( it| that| this| the (cut|preview|suggestion))?|use (it|that|this)( one| cut| plane)?|go ahead|yes,? do (it|that)|make it so|accept( it| that)?|take it|let'?s do (it|that)|sounds good,? do it)$/.test(s)) {
    return { kind: 'applyPreview' };
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
    if (/\b(show|display|view|see|look at|visuali[sz]e)\b/.test(s) && named.length >= 2 && !/\b(cut|plane|slice)\b.*\bbetween\b/.test(s) && /\b(relative to|in relation to|relationship|relation|next to|against|with respect to|and)\b/.test(s)) {
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

  /* --- planning conversation (before queries and outcomes, which share
         "what", "how much" and "what if") ---------------------------------- */
  {
    const limiting =
      /\bwhat('s| is| are) (limiting|stopping|holding back|constraining|preventing)\b/.test(s) ||
      /\bwhy (is|isn'?t|can'?t|won'?t|doesn'?t|does)\b/.test(s) ||
      /\b(can'?t|cannot) (you )?(get|make|widen|avoid|keep)\b/.test(s);
    // "The trade-off between margin and vessels" is answered by what sparing
    // the vessels would cost.
    if (/\b(trade-?offs?|cost of sparing|price of)\b/.test(s)) {
      if (new RegExp(String.raw`\b${VESSEL_WORDS}\b`).test(s)) return { kind: 'explain', about: 'vessels' };
      if (/\bmargin\b/.test(s)) return { kind: 'explain', about: 'margin' };
      if (/\b(remnant|liver)\b/.test(s)) return { kind: 'explain', about: 'remnant' };
    }
    if (limiting) {
      if (/\bmargin\b/.test(s)) return { kind: 'explain', about: 'margin' };
      if (/\b(remnant|liver left|more liver)\b/.test(s)) return { kind: 'explain', about: 'remnant' };
      if (new RegExp(String.raw`\b${VESSEL_WORDS}\b`).test(s)) return { kind: 'explain', about: 'vessels' };
    }
    if (
      /\b(why|how come|what made you)\b/.test(s) && /\b(move|moved|change|changed|pick|picked|choose|chose|that|it|this cut|the cut|tilt|tilted)\b/.test(s) ||
      /\bexplain (the|that|your|this)? ?(cut|change|move|choice|decision|optimi[sz]ation|result)\b/.test(s) ||
      limiting
    ) {
      return { kind: 'explain' };
    }
  }
  if (
    /\b(is|does) (this|the|my) (cut|plane|plan) (safe|ok|okay|good|acceptable|fine|reasonable|work|look (ok|okay|good|right))\b/.test(s) ||
    /\bhow (does|is) (this|the|my) (cut|plane|plan) (look|looking|doing)\b/.test(s) ||
    /\b(assess|evaluate|check|review|grade) (this|the|my) (cut|plane|plan)\b/.test(s) ||
    /^(status|summary of the cut|where are we)$/.test(s)
  ) {
    return { kind: 'query', what: 'summary' };
  }
  if (/\b(how close|how far|distance)\b/.test(s) && /\b(cut|plane)\b/.test(s) && /\btumou?r\b/.test(s)) {
    return { kind: 'query', what: 'margin' };
  }
  {
    const hypothetical = HYPOTHETICAL.test(s);
    const mm = lengthMm(s);
    const toward = /\b(closer|toward|towards|nearer|into)\b/.test(s);
    const away = /\b(away|further|farther|back from)\b/.test(s);
    if (/\b(move|moved|shift|shifted|slide|push|pushed|bring|brought|put|nudge|nudged)\b/.test(s) && /\b(cut|plane|it)\b/.test(s) && mm !== null && (toward || away)) {
      return { kind: 'shiftPlane', mm: toward ? mm : -mm, ...(hypothetical ? { preview: true } : {}) };
    }
    // Tilting by voice, as seen on screen.
    if (/\b(tilt|tilted|angle|angled|rotate|rotated|turn|turned|swing|lean|tip|pivot)\b/.test(s) && /\b(cut|plane|slice|it)\b/.test(s)) {
      const dir: TiltDir | null = /\b(counter-?clockwise|anti-?clockwise)\b/.test(s)
        ? 'counterclockwise'
        : /\bclockwise\b/.test(s)
          ? 'clockwise'
          : /\bleft\b/.test(s)
            ? 'left'
            : /\bright\b/.test(s)
              ? 'right'
              : /\b(up|upward|upwards|higher|head)\b/.test(s)
                ? 'up'
                : /\b(down|downward|downwards|lower|feet|foot)\b/.test(s)
                  ? 'down'
                  : /\b(toward|towards) (me|us|the camera|the viewer)\b/.test(s)
                    ? 'toward'
                    : /\b(away from (me|us|the camera)|back|backwards?)\b/.test(s)
                      ? 'away'
                      : null;
      if (dir) {
        const deg = /(\d+(?:\.\d+)?|\b[a-z]+\b)\s*(?:degrees?|deg)\b/.exec(s);
        const n = deg ? (/\d/.test(deg[1]) ? parseFloat(deg[1]) : parseNumber(deg[1])) : null;
        const amount = n ?? (/\b(a (little )?bit|slightly|a touch|a little|a hair)\b/.test(s) ? 5 : 10);
        return { kind: 'tiltPlane', dir, deg: Math.min(45, amount), ...(hypothetical ? { preview: true } : {}) };
      }
    }
    if (/\b(straighten|square( it)? up|level|align)\b.*\b(cut|plane|it)\b|\bmake (it|the cut|the plane) (straight|square|level)\b/.test(s)) {
      return { kind: 'straightenPlane' };
    }
    // Described cuts without an anatomical plane: "a cut 15 mm from the
    // tumor", "an oblique cut", "a cut between the tumor and the portal vein".
    if (/\b(cut|plane|slice)\b/.test(s) && !/\b(sagittal|coronal|axial|transverse|horizontal|frontal)\b/.test(s)) {
      const named = matchStructures(s).filter((k) => k !== 'stent');
      if (/\bbetween\b/.test(s) && named.length >= 2) {
        return { kind: 'cut', orientation: 'oblique', through: named[0], offsetMm: null, between: named[1] };
      }
      const describing = /\b(make|place|put|give me|cut|create|draw|add|do|start with|try|want|need|show)\b/.test(s);
      if (/\boblique\b/.test(s) || (describing && mm !== null && /\b(from|off|away|clear|around|margin|beside)\b/.test(s))) {
        return { kind: 'cut', orientation: 'oblique', through: named[0] ?? null, offsetMm: mm };
      }
    }
    const opts = planOptions(s);
    const asked = /\b(optimi[sz]e|optimi[sz]ation|fix|improve|correct|re-?plan|re-?optimi[sz]e|better (cut|plane|one)|do better|best (cut|plane|one)|as good as (you|it) can|best you can|best possible|(find|get|give me|is there|are there) (a|an|the|any) ?\w* (cut|plane))\b/.test(s);
    const steering = opts.priority !== undefined || opts.widen === true;
    const limits = opts.marginMm !== undefined || opts.remnantPct !== undefined;
    // "set margin to 8" is a threshold, not a search; it is handled below.
    if (asked || steering || (limits && hypothetical)) {
      return { kind: 'optimize', ...opts, ...(hypothetical ? { preview: true } : {}) };
    }
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
  // "size for a Gore Excluder", "place an Excluder": a device with a rule card.
  const named = /\b(size|sizing|fit|place|deploy|put|use|try|stent|graft)\b.*?\b(?:for|with|an?|the)\s+(.+)$/.exec(s);
  if (named) {
    const words = named[2].split(/\s+/);
    for (let n = words.length; n > 0; n--) {
      const card = findCard(words.slice(0, n).join(' '));
      if (card) return { kind: 'placeStent', device: card.id };
    }
  }
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

  /* --- optimizer (the stent case's "optimize", and anything the planning
         block above let through) ----------------------------------------- */
  if (/\b(optimi[sz]e|fix|improve|better|correct|re-?plan|replan)\b/.test(s)) {
    return { kind: 'optimize' };
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
    // From the match on, so "twenty five" is read whole, not as "twenty".
    const value = parseNumber(s.slice(thresholdMatch.index + thresholdMatch[0].length - thresholdMatch[2].length));
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
  // Whole-command forms only: "stay further from the vein" is a planning
  // request, not "lock".
  if (/^(unlock|release|let go|free it|unfreeze)( it| that| the (cut|plane))?$|\bunlock\b/.test(s)) return { kind: 'lock', on: false };
  if (/^(lock|hold|freeze)( it| that| this| the (cut|plane))?( there| still| in place)?$|^(stay|stay there|stay put|keep it there)$|\block (it|the (cut|plane))\b/.test(s)) {
    return { kind: 'lock', on: true };
  }

  /* --- reset ------------------------------------------------------------- */
  if (/\b(reset|start over|clear|start again|from scratch)\b/.test(s)) return { kind: 'reset' };

  /* --- cutting plane: only an explicit on/off. A question that merely
         mentions the cut falls through to the LLM instead of silently
         switching the plane on. ------------------------------------------- */
  if (/\b(cut|slice|plane)\b/.test(s)) {
    if (/\b(hide|turn off|switch off|remove|disable|get rid of|no|stop|cancel)\b.*\b(cut|slice|plane)\b|\b(cut|slice|plane) (off|away)\b/.test(s)) {
      return { kind: 'plane', on: false };
    }
    if (/^(the )?(cutting )?(cut|slice|plane)( on)?$/.test(s) || /\b(show|turn on|switch on|enable|bring back|give me|add|start|put in)\b.*\b(cut|slice|plane)\b|\b(cut|slice|plane) on\b/.test(s)) {
      return { kind: 'plane', on: true };
    }
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
  ['what if the margin were 20 mm', 'outline the best cut for it; "do it" applies'],
  ['spare the vessels / keep more liver', 'optimize with that priority'],
  ['why did you move it', 'explain the last change'],
  ['undo', 'put your cut back'],
  ['a cut 15 mm from the tumour', 'oblique cut, facing away from the organ'],
  ['cut between the tumour and the portal vein', 'halfway across the gap'],
  ['tilt the cut 10 degrees left', 'also up, down, clockwise; "a bit" is 5'],
  ['straighten the cut', 'square it to the nearest standard plane'],
  ['is this cut ok', 'every number against its target'],
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
