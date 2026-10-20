"""The planning grid, ported from src/planning/volume.ts.

A case's label volume is majority-downsampled until it holds at most
2 * 128^3 voxels (`planning_factor`), exactly as the browser does, so every
number the Python engine computes is computed on the same voxels the HUD
reads. The optimizer additionally ranks on a coarser copy (`coarsen`) sized
by organ voxel count.

Arrays are flat and x-fastest, `idx = i + nx * (j + ny * k)`, matching
`labels.u8` and the TS typed arrays. Voxel-centre coordinates are stored as
float32 (the TS `Float32Array` lookups) and promoted to float64 for the plane
arithmetic, so a voxel lands on the same side of a plane in both engines.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path
from typing import Any

import numpy as np
from scipy import ndimage

from ..config import REPO

DATA_ROOT = REPO / "public" / "data"

# Same budget as PLANNING_MAX_VOXELS in volume.ts.
PLANNING_MAX_VOXELS = 2 * 128**3


def planning_factor(shape: tuple[int, int, int]) -> int:
    f = 1
    while math.ceil(shape[0] / f) * math.ceil(shape[1] / f) * math.ceil(shape[2] / f) > PLANNING_MAX_VOXELS:
        f += 1
    return f


def majority_downsample(src: np.ndarray, src_shape: tuple[int, int, int], factor: int,
                        dst_shape: tuple[int, int, int]) -> np.ndarray:
    """Block-reduce a flat label grid to the most common non-zero id per block.

    Ties go to the HIGHER id, as in volume.ts: label ids are ordered so thin or
    important structures (tumour 2, vessels 3+) sit above the organ around them.
    Vectorised per label id; a case has a handful of ids, so this is a few
    passes over the volume rather than a Python loop per block.
    """
    sx, sy, sz = src_shape
    dx, dy, dz = dst_shape
    if factor == 1 and (sx, sy, sz) == (dx, dy, dz):
        return src.copy()
    vol = src.reshape(sz, sy, sx)
    padded = np.zeros((dz * factor, dy * factor, dx * factor), dtype=np.uint8)
    padded[:sz, :sy, :sx] = vol
    blocks = padded.reshape(dz, factor, dy, factor, dx, factor)
    best = np.zeros((dz, dy, dx), dtype=np.uint8)
    best_count = np.zeros((dz, dy, dx), dtype=np.int32)
    for lid in np.unique(vol):
        if lid == 0:
            continue
        c = (blocks == lid).sum(axis=(1, 3, 5), dtype=np.int32)
        # Ascending ids with >= hands a tie to the higher id.
        win = (c > 0) & (c >= best_count)
        best[win] = lid
        best_count[win] = c[win]
    return best.reshape(-1)


def edt3d(seed: np.ndarray, shape: tuple[int, int, int], spacing: tuple[float, float, float]) -> np.ndarray:
    """Exact Euclidean distance (mm) from every voxel to the nearest seed voxel.

    scipy's EDT is exact like the Felzenszwalb-Huttenlocher transform in
    edt.ts; with no seed every distance is +inf, as there.
    """
    nx, ny, nz = shape
    if not seed.any():
        return np.full(nx * ny * nz, np.inf, dtype=np.float32)
    d = ndimage.distance_transform_edt(~seed.reshape(nz, ny, nx).astype(bool), sampling=(spacing[2], spacing[1], spacing[0]))
    return d.astype(np.float32).reshape(-1)


def axis_coords(n: int, spacing: float, origin: float) -> np.ndarray:
    return (origin + np.arange(n, dtype=np.float64) * spacing).astype(np.float32)


@dataclass
class Grid:
    """The fields the metric functions read (the TS `CoarseGrid` interface)."""

    nx: int
    ny: int
    nz: int
    spacing: tuple[float, float, float]
    origin: tuple[float, float, float]
    labels: np.ndarray
    organ_ids: tuple[int, int]
    vessel_ids: frozenset[int]
    voxel_mm3: float = field(init=False)
    voxel_diag: float = field(init=False)

    def __post_init__(self) -> None:
        s = self.spacing
        self.voxel_mm3 = s[0] * s[1] * s[2]
        self.voxel_diag = math.hypot(*s)
        self.xs = axis_coords(self.nx, s[0], self.origin[0])
        self.ys = axis_coords(self.ny, s[1], self.origin[1])
        self.zs = axis_coords(self.nz, s[2], self.origin[2])
        organ_id, tumor_id = self.organ_ids
        lab = self.labels
        is_organ = (lab == organ_id) | (lab == tumor_id)
        self.organ_idx = np.flatnonzero(is_organ)
        self.tumor_idx = np.flatnonzero(lab == tumor_id)
        self.vessel_idx = np.flatnonzero(np.isin(lab, list(self.vessel_ids)) & ~is_organ)
        self.organ_xyz = self.coords(self.organ_idx)
        self.tumor_xyz = self.coords(self.tumor_idx)
        self.vessel_xyz = self.coords(self.vessel_idx)

    @property
    def shape(self) -> tuple[int, int, int]:
        return (self.nx, self.ny, self.nz)

    def ijk(self, idx: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        i = idx % self.nx
        j = (idx // self.nx) % self.ny
        k = idx // (self.nx * self.ny)
        return i, j, k

    def coords(self, idx: np.ndarray) -> np.ndarray:
        """World-mm centres of flat indices, (n, 3) float64 from the float32 lookups."""
        i, j, k = self.ijk(idx)
        return np.stack([self.xs[i], self.ys[j], self.zs[k]], axis=1).astype(np.float64)

    @cached_property
    def dist_tumor(self) -> np.ndarray:
        seed = np.zeros(self.labels.size, dtype=bool)
        seed[self.tumor_idx] = True
        return edt3d(seed, self.shape, self.spacing)

    @cached_property
    def organ_box(self) -> tuple[tuple[int, int, int], tuple[int, int, int]] | None:
        """Inclusive voxel bounding box of the organ, or None without one."""
        if self.organ_idx.size == 0:
            return None
        i, j, k = self.ijk(self.organ_idx)
        return (int(i.min()), int(j.min()), int(k.min())), (int(i.max()), int(j.max()), int(k.max()))

    @property
    def organ_ml(self) -> float:
        return self.organ_idx.size * self.voxel_mm3 / 1000

    @property
    def tumor_ml(self) -> float:
        return self.tumor_idx.size * self.voxel_mm3 / 1000

    def centroid(self, xyz: np.ndarray) -> np.ndarray | None:
        return None if len(xyz) == 0 else xyz.mean(axis=0)

    def organ_centroid(self) -> np.ndarray | None:
        return self.centroid(self.organ_xyz)

    def tumor_centroid(self) -> np.ndarray | None:
        return self.centroid(self.tumor_xyz)

    def coarsen(self, target_organ_voxels: int = 8000) -> Grid:
        """A coarser copy for ranking optimizer candidates (volume.ts `coarsen`).

        Sized by organ voxel count, so every case pays about the same per
        candidate.
        """
        extra = max(1, math.ceil(math.cbrt(self.organ_idx.size / target_organ_voxels)))
        nx, ny, nz = (math.ceil(n / extra) for n in self.shape)
        labels = majority_downsample(self.labels, self.shape, extra, (nx, ny, nz))
        return Grid(nx, ny, nz, tuple(s * extra for s in self.spacing), self.origin, labels,
                    self.organ_ids, self.vessel_ids)


@dataclass
class Case:
    """One case loaded from public/data/<id>/, with its planning grids."""

    id: str
    meta: dict[str, Any]
    labels_full: np.ndarray
    centerlines: dict[str, Any] | None
    grid: Grid
    factor: int

    @property
    def kind(self) -> str:
        return self.meta.get("kind", "scan")

    @cached_property
    def coarse(self) -> Grid:
        return self.grid.coarsen()

    @cached_property
    def label_by_key(self) -> dict[str, dict[str, Any]]:
        return {lab["key"]: lab for lab in self.meta["labels"]}

    @cached_property
    def names(self) -> dict[int, str]:
        return {lab["id"]: lab["name"] for lab in self.meta["labels"]}

    @property
    def keys(self) -> list[str]:
        return [lab["key"] for lab in self.meta["labels"]]


def label_roles(meta: dict[str, Any]) -> tuple[int, int, frozenset[int]]:
    """Organ id, tumour id and vessel ids, with volume.ts's fallbacks (1, 2, role=vessel)."""
    labels = meta["labels"]
    organ = next((lab["id"] for lab in labels if lab["role"] == "organ"), 1)
    tumor = next((lab["id"] for lab in labels if lab["role"] == "tumor"), 2)
    vessels = meta.get("vesselIds") or [lab["id"] for lab in labels if lab["role"] == "vessel"]
    return organ, tumor, frozenset(vessels)


_CACHE: dict[tuple[str, str], Case] = {}


def load_case(case_id: str, root: Path = DATA_ROOT) -> Case:
    """Load (once per process) a case's meta, labels and centerlines and build its grid."""
    key = (str(root), case_id)
    if key in _CACHE:
        return _CACHE[key]
    d = root / case_id
    if not (d / "meta.json").exists():
        raise FileNotFoundError(f"no case {case_id!r} under {root}")
    meta = json.loads((d / "meta.json").read_text())
    shape = tuple(int(v) for v in meta["shape"])
    labels = np.fromfile(d / "labels.u8", dtype=np.uint8)
    if labels.size != shape[0] * shape[1] * shape[2]:
        raise ValueError(f"{case_id}: labels.u8 has {labels.size} voxels, shape implies {np.prod(shape)}")
    cl_path = d / "centerlines.json"
    centerlines = json.loads(cl_path.read_text()) if cl_path.exists() else None

    f = planning_factor(shape)
    dst = tuple(math.ceil(n / f) for n in shape)
    organ, tumor, vessels = label_roles(meta)
    grid = Grid(*dst, tuple(float(s) * f for s in meta["spacing"]), tuple(float(o) for o in meta["origin"]),
                majority_downsample(labels, shape, f, dst), (organ, tumor), vessels)
    case = Case(case_id, meta, labels, centerlines, grid, f)
    _CACHE[key] = case
    return case
