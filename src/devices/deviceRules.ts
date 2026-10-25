/**
 * Device rule cards: a stent graft's sizing limits from its instructions for
 * use, with the quote and URL behind each one (CLAUDE.md section 7).
 *
 * Committed cards in data/device_rules/ are bundled, so the hosted demo works
 * without Tavily or a backend. Cards fetched live from the backend's
 * /api/rules are added for the session. The Python twin is
 * backend/app/engine/device_rules.py; name matching and limits must agree.
 */

import { DEFAULT_LIMITS, type Limits } from './stent.ts';

export const FIELDS = ['neck_length_min_mm', 'neck_diameter_mm', 'neck_angulation_max_deg', 'oversize_pct'] as const;
export type Field = (typeof FIELDS)[number];

export interface Sourced<T> {
  value: T;
  quote: string;
  url: string;
}

export interface RuleCard {
  id: string;
  device: string;
  aliases?: string[];
  fetched?: string;
  fields: {
    neck_length_min_mm?: Sourced<number>;
    neck_diameter_mm?: Sourced<[number, number]>;
    neck_angulation_max_deg?: Sourced<number>;
    oversize_pct?: Sourced<[number, number]>;
  };
}

const FILLER = new Set([
  'aaa', 'endoprosthesis', 'stent', 'graft', 'stentgraft', 'endovascular', 'system', 'device', 'the', 'a', 'an',
  'abdominal', 'aortic', 'bifurcated', 'for', 'r', 'tm',
]);

const cards = new Map<string, RuleCard>();
for (const mod of Object.values(import.meta.glob<RuleCard>('../../data/device_rules/*.json', { eager: true, import: 'default' }))) {
  cards.set(mod.id, mod);
}

export function normName(name: string): string {
  return (name ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !FILLER.has(w))
    .join(' ');
}

/** Add a card fetched live (backend /api/rules) for the rest of the session. */
export function addCard(card: RuleCard): void {
  cards.set(card.id, card);
}

/** The card for a device name or id: exact id, then an alias, then a unique id containing every word. */
export function findCard(name: string | null | undefined): RuleCard | null {
  if (!name) return null;
  const key = normName(name);
  if (!key) return null;
  const exact = cards.get(key.replaceAll(' ', '-'));
  if (exact) return exact;
  for (const c of cards.values()) {
    if ((c.aliases ?? []).some((a) => normName(a) === key)) return c;
  }
  const words = key.split(' ');
  const hits = [...cards.values()].filter((c) => {
    const id = new Set(c.id.split('-'));
    return words.every((w) => id.has(w));
  });
  return hits.length === 1 ? hits[0] : null;
}

export function limitsOf(card: RuleCard | null): Limits {
  if (!card) return DEFAULT_LIMITS;
  const f = card.fields;
  const d = DEFAULT_LIMITS;
  return {
    neckMinMm: f.neck_length_min_mm ? f.neck_length_min_mm.value : d.neckMinMm,
    oversizeMinPct: f.oversize_pct ? f.oversize_pct.value[0] : d.oversizeMinPct,
    oversizeMaxPct: f.oversize_pct ? f.oversize_pct.value[1] : d.oversizeMaxPct,
    angulationMaxDeg: f.neck_angulation_max_deg ? f.neck_angulation_max_deg.value : d.angulationMaxDeg,
    angulationInclusive: !!f.neck_angulation_max_deg,
    neckDiameterMm: f.neck_diameter_mm ? [f.neck_diameter_mm.value[0], f.neck_diameter_mm.value[1]] : null,
    source: `ifu:${card.id}`,
  };
}

/** The device's limits: its card's, else the default simplified EVAR rules. */
export function limitsFor(deviceId: string | null | undefined): Limits {
  return limitsOf(findCard(deviceId));
}

/** The lookup_device_rules result, identical to the Python executor's. */
export function cardJson(card: RuleCard): Record<string, unknown> {
  const f = card.fields as Record<Field, Sourced<unknown> | undefined>;
  const have = FIELDS.filter((k) => f[k]);
  return {
    device_id: card.id,
    device: card.device,
    rules: Object.fromEntries(have.map((k) => [k, f[k]!.value])),
    not_found: FIELDS.filter((k) => !f[k]),
    sources: have.map((k) => ({ field: k, url: f[k]!.url, quote: f[k]!.quote })),
    rules_source: `ifu:${card.id}`,
    fetched: card.fetched ?? null,
  };
}
