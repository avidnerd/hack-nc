/**
 * "What's this?": a VISTA-3D point prompt from the vista3d-point endpoint,
 * turned into a structure the app can show and measure. The mask is on the
 * app's own grid (the endpoint rebuilds HU from this case's volume.u8), so it
 * is written straight into the label volume: background voxels only, so the
 * liver, tumour and vessels the plan measures never change.
 */

import type { CaseData, LabelDef, Vec3 } from '../types.ts';

export interface SegmentReply {
  case_id: string;
  voxels: number;
  volume_ml?: number;
  background_voxels?: number;
  mask?: { bbox: Bbox; bits: string };
  mesh?: { positions: string; indices: string; vertices: number } | null;
  guess?: { id: number; key: string; name: string; overlap: number } | null;
  /** What VISTA-3D's own automatic segmentation calls most of the mask. */
  vista_class?: { id: number; name: string; overlap: number } | null;
  /** VISTA-3D inference on the GPU, and the whole request on the endpoint. */
  seconds: number;
  total_seconds?: number;
  gpu: string;
}

/** The teal the spec gives new VISTA-3D structures. */
export const VISTA_TEAL: Vec3 = [0.18, 0.83, 0.78];

/** World mm -> the voxel index the endpoint prompts with. */
export function voxelAt(data: CaseData, p: Vec3): [number, number, number] | null {
  const { shape, spacing, origin } = data.meta;
  const v = [0, 1, 2].map((a) => Math.round((p[a] - (origin?.[a] ?? 0)) / spacing[a])) as [number, number, number];
  return v.every((x, a) => x >= 0 && x < shape[a]) ? v : null;
}

const bytes = (b64: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function gunzip(b: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const s = new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

type Bbox = [number, number, number, number, number, number];

/** Unpack the endpoint's mask: bounding box bits, x fastest, little-endian. */
export async function decodeMask(reply: SegmentReply): Promise<{ bbox: Bbox; bit: (x: number, y: number, z: number) => boolean } | null> {
  if (!reply.mask) return null;
  const [x0, y0, z0, x1, y1] = reply.mask.bbox;
  const packed = await gunzip(bytes(reply.mask.bits));
  const bx = x1 - x0;
  const by = y1 - y0;
  return {
    bbox: reply.mask.bbox,
    bit: (x, y, z) => {
      const i = x - x0 + bx * (y - y0 + by * (z - z0));
      return ((packed[i >> 3] >> (i & 7)) & 1) === 1;
    },
  };
}

export interface AddedStructure {
  label: LabelDef;
  /** Voxels written into the label volume (background only). */
  written: number;
  mesh: { positions: Float32Array; indices: Uint32Array } | null;
}

/**
 * Add the mask as a new label. Null when it adds almost nothing new (the
 * point was on a structure the case already labels): the caller names that
 * structure instead.
 */
export async function addStructure(data: CaseData, reply: SegmentReply, n: number): Promise<AddedStructure | null> {
  const m = await decodeMask(reply);
  if (!m || !reply.voxels) return null;
  if ((reply.background_voxels ?? 0) < 0.2 * reply.voxels) return null;
  const used = new Set(data.meta.labels.map((l) => l.id));
  let id = 0;
  for (let k = 255; k >= 1; k--) {
    if (!used.has(k)) {
      id = k;
      break;
    }
  }
  if (!id) return null;
  const [nx, ny] = data.meta.shape;
  const [x0, y0, z0, x1, y1, z1] = m.bbox;
  let written = 0;
  for (let z = z0; z < z1; z++) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = x + nx * (y + ny * z);
        if (data.labels[i] === 0 && m.bit(x, y, z)) {
          data.labels[i] = id;
          written++;
        }
      }
    }
  }
  const what = reply.vista_class?.name ?? reply.guess?.name;
  const name = what ? `${what[0].toUpperCase()}${what.slice(1)}, VISTA-3D` : `Structure ${n}, VISTA-3D`;
  const label: LabelDef = { id, key: `vista_${n}`, name, color: VISTA_TEAL, role: 'context' };
  data.meta.labels.push(label);
  const mesh = reply.mesh
    ? {
        positions: new Float32Array(bytes(reply.mesh.positions).buffer),
        indices: new Uint32Array(bytes(reply.mesh.indices).buffer),
      }
    : null;
  return { label, written, mesh };
}
