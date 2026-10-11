/**
 * Loads a case from public/data/<id>/ : meta.json describes the grid, then two
 * raw uint8 volumes (CT intensity and packed labels) and an optional
 * centerline file stream in alongside it.
 *
 * The volumes are plain `.u8` blobs rather than NIfTI or PNG so the browser
 * does zero decoding: the bytes arrive in exactly the layout the
 * `Data3DTexture` wants, which is what keeps the load under a couple of
 * seconds.
 */

import type { CaseData, CaseMeta, CenterlineData, MeshEntry, MeshSet } from './types.ts';
import { setLoading } from './state.ts';

const DATA_ROOT = 'data';

export class CaseLoadError extends Error {
  constructor(
    message: string,
    readonly cause_?: unknown,
  ) {
    super(message);
    this.name = 'CaseLoadError';
  }
}

// DECISION: the hosted build (scripts/build-web.mjs) ships each binary as a
// gzipped `<name>.gz` and sets this flag; static hosts do not compress
// octet-streams, and gzip cuts a case from ~50 MB to ~18 MB. The dev server
// keeps serving the raw files.
const GZ_DATA = import.meta.env.VITE_DATA_GZ === '1';

/**
 * Fetch `<url>.gz` and inflate it. Some hosts send `.gz` files with
 * `Content-Encoding: gzip`, in which case the browser has already inflated
 * them, so the gzip magic bytes decide whether there is anything left to do.
 */
async function fetchGzipBytes(
  url: string,
  onProgress?: (received: number, total: number) => void,
): Promise<Uint8Array> {
  const bytes = await fetchRawBytes(`${url}.gz`, onProgress);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const inflated = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(inflated).arrayBuffer());
}

/** Fetch a case binary, gzipped or raw depending on the build. */
function fetchBytes(
  url: string,
  onProgress?: (received: number, total: number) => void,
): Promise<Uint8Array> {
  return GZ_DATA ? fetchGzipBytes(url, onProgress) : fetchRawBytes(url, onProgress);
}

/** Fetch with a progress callback driven by Content-Length. */
async function fetchRawBytes(
  url: string,
  onProgress?: (received: number, total: number) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(url);
  if (!res.ok) throw new CaseLoadError(`${res.status} ${res.statusText} for ${url}`);

  const total = Number(res.headers.get('Content-Length') ?? 0);
  if (!res.body || !total) {
    // No streaming info available (dev server with compression, say) — just
    // take the whole buffer.
    const buf = await res.arrayBuffer();
    onProgress?.(buf.byteLength, buf.byteLength);
    return new Uint8Array(buf);
  }

  const out = new Uint8Array(total);
  const reader = res.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.length > out.length) {
      // Server lied about the length; fall back to a copy we grow ourselves.
      const rest = [out.subarray(0, received), value];
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        rest.push(r.value);
      }
      const size = rest.reduce((n, c) => n + c.length, 0);
      const more = new Uint8Array(size);
      let off = 0;
      for (const chunk of rest) {
        more.set(chunk, off);
        off += chunk.length;
      }
      onProgress?.(size, size);
      return more;
    }
    out.set(value, received);
    received += value.length;
    onProgress?.(received, total);
  }
  return out;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new CaseLoadError(`${res.status} ${res.statusText} for ${url}`);
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new CaseLoadError(`${url} is not valid JSON`, err);
  }
}

function expectedVoxels(meta: CaseMeta): number {
  return meta.shape[0] * meta.shape[1] * meta.shape[2];
}

/**
 * Load one case. Progress is reported through `setLoading` so the boot screen
 * reflects real bytes rather than a fake animation.
 */
export async function loadCase(id: string): Promise<CaseData> {
  const base = `${DATA_ROOT}/${id}`;

  setLoading('Reading case header', 4);
  const meta = await fetchJson<CaseMeta>(`${base}/meta.json`);
  if (!meta.shape || meta.shape.length !== 3) {
    throw new CaseLoadError(`${base}/meta.json has no valid "shape"`);
  }
  const want = expectedVoxels(meta);

  // The two volumes are the same size, so weight the bar evenly between them.
  setLoading('Loading CT volume', 8);
  const volume = await fetchBytes(`${base}/volume.u8`, (got, total) => {
    setLoading('Loading CT volume', 8 + 42 * (got / Math.max(total, 1)));
  });
  if (volume.length !== want) {
    throw new CaseLoadError(
      `volume.u8 is ${volume.length} bytes but meta.shape implies ${want}`,
    );
  }

  setLoading('Loading segmentations', 52);
  const labels = await fetchBytes(`${base}/labels.u8`, (got, total) => {
    setLoading('Loading segmentations', 52 + 36 * (got / Math.max(total, 1)));
  });
  if (labels.length !== want) {
    throw new CaseLoadError(
      `labels.u8 is ${labels.length} bytes but meta.shape implies ${want}`,
    );
  }

  // Centerlines only exist for cases that carry a device target.
  let centerlines: CenterlineData | null = null;
  if (meta.centerline) {
    setLoading('Loading centerlines', 90);
    try {
      centerlines = await fetchJson<CenterlineData>(`${base}/centerlines.json`);
    } catch (err) {
      // A missing centerline costs us the stent, not the whole demo.
      console.warn('[loader] no centerlines for', id, err);
    }
  }

  // Surface meshes drive the default anatomy view. Without them the app still
  // works, falling back to the volume ray-marcher.
  let meshes: MeshSet | null = null;
  try {
    setLoading('Loading anatomy', 94);
    const table = await fetchJson<{ positionsBytes: number; meshes: MeshEntry[] }>(`${base}/meshes.json`);
    const bin = await fetchBytes(`${base}/meshes.bin`);
    const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
    meshes = {
      entries: table.meshes,
      positions: new Float32Array(buf, 0, table.positionsBytes / 4),
      indices: new Uint32Array(buf, table.positionsBytes),
    };
  } catch (err) {
    console.warn('[loader] no meshes for', id, '- using volume rendering', err);
  }

  setLoading('Ready', 100);
  return { meta, volume, labels, centerlines, meshes };
}

/** The case list shown by `C` and by "load the liver case". */
export interface CaseEntry {
  id: string;
  label: string;
  /** Words the voice grammar accepts for this case. */
  aliases: string[];
}

export const CASES: CaseEntry[] = [
  { id: 'liver', label: 'Liver', aliases: ['liver', 'resection', 'first', 'case a', 'a'] },
  { id: 'aorta', label: 'Aorta', aliases: ['aorta', 'aortic', 'stent', 'second', 'case b', 'b'] },
];

export function resolveCaseId(spoken: string): string | null {
  const s = spoken.toLowerCase().trim();
  for (const c of CASES) {
    if (c.id === s) return c.id;
    if (c.aliases.some((a) => s.includes(a))) return c.id;
  }
  return null;
}
