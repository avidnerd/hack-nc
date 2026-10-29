import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { addStructure, decodeMask, voxelAt, type SegmentReply } from '../src/ai/segmentPoint.ts';
import type { CaseData } from '../src/types.ts';

/** A 4x3x2 case with one liver voxel at (0,0,0). */
function tinyCase(): CaseData {
  const labels = new Uint8Array(4 * 3 * 2);
  labels[0] = 1;
  return {
    meta: {
      id: 'msd_liver_0', name: 't', kind: 'liver', shape: [4, 3, 2], spacing: [2, 2, 2], origin: [10, 0, 0],
      huRange: [-1000, 2000], huCurve: [[0, -1000], [255, 2000]],
      labels: [{ id: 1, key: 'liver', name: 'Liver', color: [1, 0, 0], role: 'organ' }],
      vesselIds: [], windowPresets: {} as never, defaultPreset: 'soft',
    },
    volume: new Uint8Array(24), labels, centerlines: null, meshes: null,
  };
}

/** Pack a box mask the way vista/point/server.py does: x fastest, little-endian bits, gzip, base64. */
function pack(bits: number[]): string {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => {
    if (b) out[i >> 3] |= 1 << (i & 7);
  });
  return gzipSync(out).toString('base64');
}

describe('segment_point mask', () => {
  it('maps world mm to the voxel index and rejects points outside', () => {
    const d = tinyCase();
    expect(voxelAt(d, [12, 2, 2])).toEqual([1, 1, 1]);
    expect(voxelAt(d, [0, 0, 0])).toBeNull();
  });

  it('decodes the box bits x fastest', async () => {
    // Box x 0..2, y 0..1, z 0..1: bits for (0,0,0) and (1,0,0).
    const m = await decodeMask({ mask: { bbox: [0, 0, 0, 2, 1, 1], bits: pack([1, 1]) } } as SegmentReply);
    expect(m!.bit(0, 0, 0)).toBe(true);
    expect(m!.bit(1, 0, 0)).toBe(true);
  });

  it('writes a new teal label into background voxels only', async () => {
    const d = tinyCase();
    // Box x 0..2, y 0..1, z 0..2: (0,0,0) is liver, the other three are background.
    const reply = { case_id: 'msd_liver_0', voxels: 4, volume_ml: 0.032, background_voxels: 3, seconds: 1.2, gpu: 'H100',
      mask: { bbox: [0, 0, 0, 2, 1, 2], bits: pack([1, 1, 1, 1]) }, mesh: null, guess: null } as SegmentReply;
    const added = await addStructure(d, reply, 1);
    expect(added!.written).toBe(3);
    expect(d.labels[0]).toBe(1); // the liver voxel is untouched
    expect(d.labels[1]).toBe(added!.label.id);
    expect(d.labels[1 + 4 * 3]).toBe(added!.label.id); // (1,0,1)
    expect(added!.label).toMatchObject({ key: 'vista_1', name: 'Structure 1, VISTA-3D', role: 'context' });
    expect(d.meta.labels).toHaveLength(2);
  });

  it('adds nothing when the mask is mostly a labelled structure', async () => {
    const d = tinyCase();
    const reply = { case_id: 'x', voxels: 10, background_voxels: 1, seconds: 1, gpu: 'H100',
      mask: { bbox: [0, 0, 0, 1, 1, 1], bits: pack([1]) }, guess: { id: 1, key: 'liver', name: 'Liver', overlap: 0.9 } } as SegmentReply;
    expect(await addStructure(d, reply, 1)).toBeNull();
  });
});
