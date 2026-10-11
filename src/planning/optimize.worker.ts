/**
 * Runs the 3751-candidate plane search off the main thread, so the volume
 * keeps rendering at full rate while the optimizer thinks.
 */

import { coarseContext, optimizePlane } from './optimize.ts';
import { vesselCrossingsAlong } from './vessels.ts';
import type { EngineContext } from './engine.ts';
import type { CoarseGrid } from './volume.ts';
import type { Plane, Thresholds } from '../types.ts';

export type WorkerIn =
  | {
      type: 'grid';
      /** Ranking grid. */
      grid: CoarseGrid;
      /** Full planning grid and its organ box, for re-scoring the finalists. */
      fine: CoarseGrid;
      fineBox: EngineContext['box'];
      names: [number, string][];
    }
  | { type: 'run'; id: number; plane: Plane; thresholds: Thresholds; directions?: number };

let ctx: EngineContext | null = null;
let fine: EngineContext | null = null;

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  if (msg.type === 'grid') {
    const names = new Map(msg.names);
    ctx = coarseContext(msg.grid, names);
    fine = { grid: msg.fine, box: msg.fineBox, names };
    // Build the fine-grid vessel tables now, while the case loads, so the
    // first "optimize" does not pay for them.
    vesselCrossingsAlong(fine.grid, [1, 0, 0], [0], { box: fine.box });
    return;
  }
  if (!ctx) {
    self.postMessage({ type: 'error', id: msg.id, message: 'no grid loaded' });
    return;
  }
  const result = optimizePlane(ctx, msg.plane, msg.thresholds, msg.directions, fine);
  self.postMessage({ type: 'result', id: msg.id, result });
};
