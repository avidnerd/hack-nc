/**
 * Last resort for a command the regex grammar missed: ask the LLM to map the
 * utterance onto one of the fixed intents, as constrained JSON, and validate
 * the answer strictly. Anything off-schema is discarded; the model can pick a
 * command, never invent one.
 */

import { resolveCaseId } from '../caseLoader.ts';
import type { PresetName } from '../types.ts';
import type { Intent } from '../voice/intents.ts';
import { complete, llmEnabled } from './llm.ts';

const SYSTEM = `You map a surgeon's spoken command to exactly one intent for a surgical planning app.
Reply with ONE JSON object and nothing else. Allowed objects:
{"kind":"window","preset":"soft"|"bone"|"lung"|"liver"}
{"kind":"show","structure":"tumor"|"liver"|"vessels"|"portal_vein"|"hepatic_vessels"|"aorta"|"kidneys"|"all","on":true|false}
{"kind":"placeStent"}
{"kind":"removeDevice"}
{"kind":"optimize"}
{"kind":"measure","what":"tumor"|"neck"|"liver"|"aorta"|"kidneys"|"kidney_left"|"kidney_right"|"portal_vein"|"ivc"}
{"kind":"suggest"}
{"kind":"outcomes"}
{"kind":"lock","on":true|false}
{"kind":"reset"}
{"kind":"mode","mode":"surgeon"|"patient"}
{"kind":"writePlan"}
{"kind":"setThreshold","name":"marginMin"|"remnantMin","value":number}
{"kind":"loadCase","id":"liver"|"aorta"}
{"kind":"nudgeStent","mm":number}
{"kind":"plane","on":true|false}
{"kind":"cut","orientation":"sagittal"|"coronal"|"axial","through":"tumor"|"liver"|"aorta"|"kidneys"|"renal_arteries"|null,"offsetMm":number|null}
{"kind":"distance","a":"tumor"|"portal_vein"|"ivc"|"aorta"|"vessels"|"liver"|"kidneys","b":"tumor"|"portal_vein"|"ivc"|"aorta"|"vessels"|"liver"|"kidneys"}
{"kind":"query","what":"margin"|"remnant"|"vessels"}
{"kind":"relation","a":"tumor"|"portal_vein"|"ivc"|"aorta"|"vessels"|"hepatic_vessels"|"liver"|"kidneys"|"kidney_left"|"kidney_right","b":"tumor"|"portal_vein"|"ivc"|"aorta"|"vessels"|"hepatic_vessels"|"liver"|"kidneys"|"kidney_left"|"kidney_right"}
{"kind":"nearest","a":"tumor"|"liver"|"kidneys"}
{"kind":"focus","structure":"tumor"|"portal_vein"|"ivc"|"aorta"|"vessels"|"hepatic_vessels"|"liver"|"kidneys"|"kidney_left"|"kidney_right"}
{"kind":"savePlan"}
{"kind":"confirm"}
{"kind":"restorePlan"}
{"kind":"comparePlan"}
{"kind":"previousView"}
{"kind":"cancel"}
{"kind":"tutorial"}
{"kind":"none"}
Use {"kind":"none"} if the command matches nothing.`;

const PRESETS: PresetName[] = ['soft', 'bone', 'lung', 'liver'];

export async function intentFromLlm(utterance: string): Promise<Intent | null> {
  if (!llmEnabled()) return null;
  const raw = await complete(SYSTEM, utterance);
  if (!raw) return null;
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return null;
  try {
    return validate(JSON.parse(m[0]) as Record<string, unknown>);
  } catch {
    return null;
  }
}

/** Accept only well-formed intents; exported for tests. */
export function validate(o: Record<string, unknown>): Intent | null {
  const bool = (v: unknown) => (typeof v === 'boolean' ? v : null);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  switch (o.kind) {
    case 'window':
      return PRESETS.includes(o.preset as PresetName) ? { kind: 'window', preset: o.preset as PresetName } : null;
    case 'show': {
      const on = bool(o.on);
      return typeof o.structure === 'string' && on !== null ? { kind: 'show', structure: o.structure, on } : null;
    }
    case 'placeStent':
    case 'removeDevice':
    case 'optimize':
    case 'reset':
    case 'writePlan':
    case 'suggest':
    case 'outcomes':
    case 'savePlan':
    case 'restorePlan':
    case 'comparePlan':
    case 'previousView':
    case 'cancel':
    case 'tutorial':
      return { kind: o.kind };
    // Confirming an overwrite is destructive: only an explicit spoken
    // "confirm" (the regex grammar) may do it, never a model's guess.
    case 'confirm':
      return null;
    case 'relation':
      return typeof o.a === 'string' && typeof o.b === 'string' ? { kind: 'relation', a: o.a, b: o.b } : null;
    case 'nearest':
      return { kind: 'nearest', a: typeof o.a === 'string' ? o.a : 'tumor' };
    case 'focus':
      return typeof o.structure === 'string' ? { kind: 'focus', structure: o.structure } : null;
    case 'measure':
      return { kind: 'measure', what: typeof o.what === 'string' ? o.what : 'tumor' };
    case 'cut': {
      const orientations = ['sagittal', 'coronal', 'axial'] as const;
      const orientation = orientations.find((x) => x === o.orientation);
      if (!orientation) return null;
      return {
        kind: 'cut',
        orientation,
        through: typeof o.through === 'string' ? o.through : null,
        offsetMm: num(o.offsetMm),
      };
    }
    case 'distance':
      return typeof o.a === 'string' && typeof o.b === 'string' ? { kind: 'distance', a: o.a, b: o.b } : null;
    case 'query':
      return o.what === 'margin' || o.what === 'remnant' || o.what === 'vessels' ? { kind: 'query', what: o.what } : null;
    case 'lock':
    case 'plane': {
      const on = bool(o.on);
      return on === null ? null : { kind: o.kind, on };
    }
    case 'mode':
      return o.mode === 'surgeon' || o.mode === 'patient' ? { kind: 'mode', mode: o.mode } : null;
    case 'setThreshold': {
      const value = num(o.value);
      return (o.name === 'marginMin' || o.name === 'remnantMin') && value !== null
        ? { kind: 'setThreshold', name: o.name, value }
        : null;
    }
    case 'loadCase': {
      const id = typeof o.id === 'string' ? resolveCaseId(o.id) : null;
      return id ? { kind: 'loadCase', id } : null;
    }
    case 'nudgeStent': {
      const mm = num(o.mm);
      return mm === null ? null : { kind: 'nudgeStent', mm: Math.max(-40, Math.min(40, mm)) };
    }
    default:
      return null;
  }
}
