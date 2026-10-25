/**
 * The device rule card: each limit from the device's instructions for use,
 * the quote it was read from and a link to the page, or "not found" with the
 * default rule that stays in force.
 */

import type { RuleCard } from '../devices/deviceRules.ts';
import { DEFAULT_LIMITS } from '../devices/stent.ts';
import type { CardContent, CardRow } from './infoCard.ts';

const d = DEFAULT_LIMITS;
const ROWS = [
  { key: 'neck_length_min_mm', label: 'Neck length', fmt: (v: number) => `≥ ${v} mm`, dflt: `≥ ${d.neckMinMm} mm` },
  { key: 'neck_diameter_mm', label: 'Neck diameter', fmt: (v: number[]) => `${v[0]} to ${v[1]} mm`, dflt: 'not checked' },
  { key: 'neck_angulation_max_deg', label: 'Angulation', fmt: (v: number) => `≤ ${v}°`, dflt: `< ${d.angulationMaxDeg}°` },
  { key: 'oversize_pct', label: 'Oversize', fmt: (v: number[]) => `${v[0]} to ${v[1]} %`, dflt: `${d.oversizeMinPct} to ${d.oversizeMaxPct} %` },
] as const;

export function ruleCardContent(card: RuleCard): CardContent {
  const f = card.fields as Record<string, { value: never; quote: string; url: string } | undefined>;
  const rows: CardRow[] = ROWS.map((r) => {
    const item = f[r.key];
    return item
      ? { label: r.label, value: r.fmt(item.value), ref: 'IFU' }
      : { label: r.label, value: r.dflt, ref: 'not found, default', flag: true };
  });
  const urls = [...new Set(ROWS.map((r) => f[r.key]?.url).filter((u): u is string => !!u))];
  return {
    kicker: 'Device rules · Tavily · Nemotron',
    title: card.device,
    rows,
    notes: ROWS.flatMap((r) => (f[r.key] ? [`"${f[r.key]!.quote}"`] : [])),
    foot: `Every value is a verbatim quote from the source${card.fetched ? `, fetched ${card.fetched}` : ''}. Simplified IFU rules, not a sizing chart.`,
    links: urls.map((u) => ({ label: shortUrl(u), href: u })),
    showMs: 24000,
  };
}

function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, '')}${x.pathname}`;
  } catch {
    return u;
  }
}
