/**
 * Main-thread handle on the optimizer worker. Falls back to running the search
 * inline if the worker cannot start, because a slower optimize beats none.
 */

import { coarseContext, optimizeAround, optimizePlane, type OptimizeResult, type SearchBounds } from './optimize.ts';
import type { EngineContext } from './engine.ts';
import type { PlanningGrid } from './volume.ts';
import type { Plane, Thresholds } from '../types.ts';
import type { WorkerIn } from './optimize.worker.ts';

type WorkerOut =
  | { type: 'result'; id: number; result: OptimizeResult }
  | { type: 'error'; id: number; message: string };

export class OptimizerClient {
  private worker: Worker | null = null;
  private inline: EngineContext | null = null;
  private inlineFine: EngineContext | null = null;
  private nextId = 1;
  private pending = new Map<number, (r: OptimizeResult | null) => void>();

  constructor() {
    try {
      this.worker = new Worker(new URL('./optimize.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<WorkerOut>) => {
        const done = this.pending.get(e.data.id);
        this.pending.delete(e.data.id);
        if (e.data.type === 'error') console.warn('[optimize] worker:', e.data.message);
        done?.(e.data.type === 'result' ? e.data.result : null);
      };
    } catch (err) {
      console.warn('[optimize] worker unavailable, running inline', err);
    }
  }

  /** Hand the worker this case's ranking and planning grids. Call once per case load. */
  setGrid(grid: PlanningGrid, fine: EngineContext): void {
    const coarse = grid.coarsen();
    const names: [number, string][] = [...grid.labelById].map(([id, l]) => [id, l.name]);
    this.inline = coarseContext(coarse, new Map(names));
    this.inlineFine = fine;
    // Only the fields the metric functions read cross the boundary.
    const g = fine.grid;
    const fineGrid = {
      nx: g.nx, ny: g.ny, nz: g.nz, spacing: g.spacing, origin: g.origin,
      voxelMm3: g.voxelMm3, voxelDiag: g.voxelDiag, xs: g.xs, ys: g.ys, zs: g.zs,
      organIdx: g.organIdx, tumorIdx: g.tumorIdx, vesselIdx: g.vesselIdx,
      distTumor: g.distTumor, labels: g.labels,
    };
    this.worker?.postMessage({ type: 'grid', grid: coarse, fine: fineGrid, fineBox: fine.box, names } satisfies WorkerIn);
  }

  /**
   * `local` refines near `plane`; `wide` finds the best cut anywhere around the
   * tumour. `bounds` narrows the local search.
   */
  run(
    plane: Plane | null,
    thresholds: Thresholds,
    mode: 'local' | 'wide' = 'local',
    bounds?: SearchBounds,
  ): Promise<OptimizeResult | null> {
    if (!this.worker) {
      const ctx = this.inline;
      if (!ctx) return Promise.resolve(null);
      return Promise.resolve(
        mode === 'wide' || !plane
          ? optimizeAround(ctx, plane, thresholds, this.inlineFine)
          : optimizePlane(ctx, plane, thresholds, undefined, this.inlineFine, bounds),
      );
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.worker!.postMessage({ type: 'run', id, plane, thresholds, mode, bounds } satisfies WorkerIn);
    });
  }
}
