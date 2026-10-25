/**
 * Keyboard access to every intent.
 *
 * This is the mandatory fallback: if the webcam is refused or the room is too
 * loud for the recogniser, a judge can still perform the whole script from the
 * keys, because each shortcut dispatches the same `Intent` the voice layer
 * would have produced.
 */

import type { Intent } from '../voice/intents.ts';
import { state, set, patch, toast } from '../state.ts';

export type IntentSink = (intent: Intent, source: 'key' | 'voice' | 'llm') => void;

/** Rows for the `?` overlay. */
export const SHORTCUT_HELP: [string, string][] = [
  ['1 – 4', 'soft / bone / lung / liver window'],
  ['T', 'highlight the tumour'],
  ['S', 'place the stent'],
  ['O', 'optimize'],
  ['L', 'lock / unlock'],
  ['M', 'measure'],
  ['A', 'suggestions'],
  ['E', 'published outcomes'],
  ['J', 'tumour relative to the portal vein'],
  ['N', 'where the tumour is closest to a vessel'],
  ['B', 'save as the original plan (Shift+B confirms a replace)'],
  ['U', 'show the original plan'],
  ['Y', 'compare this cut with the original'],
  ['Backspace', 'previous view'],
  ['Esc', 'cancel'],
  ['[  ]', 'nudge the stent'],
  ['P', 'patient view'],
  ['W', 'write the plan'],
  ['C', 'switch case'],
  ['X', 'cutting plane on / off'],
  ['R', 'reset'],
  ['D', 'play the recorded demo'],
  ['K', 'anatomy / CT volume view'],
  ['H', 'gesture tutorial (practice object)'],
  ['G', 'case gallery (VISTA-3D on Nebius)'],
  ['I', 'upload a CT (.nii / .nii.gz, optional label map); or drop the files'],
  ['Shift+G', 'teach gestures (labelled recording)'],
  ['V', 'webcam preview'],
  ['F', 'fullscreen'],
  ['/', 'command palette: type a request for the agent'],
  ['?', 'this overlay'],
];

export interface KeyboardHooks {
  dispatch: IntentSink;
  /** Starts the recorded-landmark playback (`D`). */
  playDemo: () => void;
  /** Prompted, labelled gesture recording for fine-tuning (`Shift+G`). */
  teach: () => void;
  /** Switches between the anatomy meshes and the ray-marched CT (`K`). */
  toggleView: () => void;
  /** Starts/stops the landmark recorder (`shift+D`). */
  toggleRecorder: () => void;
  /** Opens the gesture tutorial on the practice object (`H`). */
  tutorial: () => void;
  /** Opens the CT upload picker (`I`, for import). */
  upload: () => void;
  /** Opens the typed command palette (`/`). */
  palette: () => void;
  /** Opens the case gallery (`g`). */
  gallery: () => void;
}

export function installKeyboard(hooks: KeyboardHooks): void {
  window.addEventListener('keydown', (e) => {
    // Never steal keys from a focused input (the plan-note filename prompt).
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const d = hooks.dispatch;

    switch (e.key) {
      /* --- window presets ------------------------------------------------ */
      case '1': d({ kind: 'window', preset: 'soft' }, 'key'); break;
      case '2': d({ kind: 'window', preset: 'bone' }, 'key'); break;
      case '3': d({ kind: 'window', preset: 'lung' }, 'key'); break;
      case '4': d({ kind: 'window', preset: 'liver' }, 'key'); break;

      /* --- structures ---------------------------------------------------- */
      case 't':
      case 'T':
        d({ kind: 'show', structure: 'tumor', on: true }, 'key');
        break;

      /* --- device -------------------------------------------------------- */
      case 's':
      case 'S':
        d(state.stent ? { kind: 'removeDevice' } : { kind: 'placeStent' }, 'key');
        break;
      case '[': d({ kind: 'nudgeStent', mm: -5 }, 'key'); break;
      case ']': d({ kind: 'nudgeStent', mm: 5 }, 'key'); break;

      /* --- planning ------------------------------------------------------ */
      case 'o':
      case 'O':
        d({ kind: 'optimize' }, 'key');
        break;
      case 'l':
      case 'L':
        d({ kind: 'lock', on: !state.plane.locked }, 'key');
        break;
      case 'm':
      case 'M':
        d({ kind: 'measure', what: 'tumor' }, 'key');
        break;
      case 'a':
      case 'A':
        d({ kind: 'suggest' }, 'key');
        break;
      case 'e':
      case 'E':
        d({ kind: 'outcomes' }, 'key');
        break;
      /* --- copilot -------------------------------------------------------- */
      case 'j':
      case 'J':
        d({ kind: 'relation', a: 'tumor', b: 'portal_vein' }, 'key');
        break;
      case 'n':
      case 'N':
        d({ kind: 'nearest', a: 'tumor' }, 'key');
        break;
      case 'b':
        d({ kind: 'savePlan' }, 'key');
        break;
      case 'B':
        d({ kind: 'confirm' }, 'key');
        break;
      case 'u':
      case 'U':
        d({ kind: 'restorePlan' }, 'key');
        break;
      case 'y':
      case 'Y':
        d({ kind: 'comparePlan' }, 'key');
        break;
      case 'Backspace':
        d({ kind: 'previousView' }, 'key');
        break;
      case 'x':
      case 'X':
        d({ kind: 'plane', on: !state.plane.on }, 'key');
        break;

      /* --- presentation -------------------------------------------------- */
      case 'p':
      case 'P':
        d({ kind: 'mode', mode: state.mode === 'patient' ? 'surgeon' : 'patient' }, 'key');
        break;
      case 'w':
      case 'W':
        d({ kind: 'writePlan' }, 'key');
        break;
      case 'c':
      case 'C':
        d({ kind: 'loadCase', id: state.caseId === 'liver' ? 'aorta' : 'liver' }, 'key');
        break;
      case 'r':
      case 'R':
        d({ kind: 'reset' }, 'key');
        break;

      /* --- harness ------------------------------------------------------- */
      case 'd':
        hooks.playDemo();
        break;
      case 'D':
        hooks.toggleRecorder();
        break;
      case 'g':
        hooks.gallery();
        break;
      case 'G':
        hooks.teach();
        break;
      case 'k':
      case 'K':
        hooks.toggleView();
        break;
      case 'h':
      case 'H':
        hooks.tutorial();
        break;
      case 'i':
      case 'I':
        hooks.upload();
        break;
      case 'v':
      case 'V':
        set('showWebcam', !state.showWebcam);
        break;
      case 'f':
      case 'F':
        void toggleFullscreen();
        break;
      case '?':
        set('showHelp', !state.showHelp);
        break;
      case '/':
        if (state.showHelp) set('showHelp', false);
        hooks.palette();
        break;
      case 'Escape':
        if (state.showHelp) set('showHelp', false);
        else d({ kind: 'cancel' }, 'key');
        break;

      /* --- mouse-free plane nudging, handy when demoing one-handed ------- */
      case 'ArrowUp': nudgePlane(+2); break;
      case 'ArrowDown': nudgePlane(-2); break;

      default:
        return;
    }
    e.preventDefault();
  });
}

/** Slide the plane along its own normal by `mm`. */
function nudgePlane(mm: number): void {
  if (!state.plane.on || state.plane.locked) return;
  patch('plane', { d: state.plane.d + mm });
}

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    toast('Fullscreen was blocked by the browser', 'bad');
  }
}
