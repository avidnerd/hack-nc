"""Every metric for one cutting plane: a port of src/planning/{remnant,margin,
vessels,engine}.ts.

A plane is `dot(n, x) = d` in world mm; the RESECTED side is `dot(n, x) - d > 0`.

    remnant %       = kept organ voxels / organ voxels x 100   (organ = organ + tumour)
    resected mL     = resected organ voxels x voxel mm^3 / 1000
    margin mm       = min distance-to-tumour over organ voxels on the kept side
                      within one voxel diagonal of the plane (the cut surface);
                      0 when any tumour voxel is kept (incomplete resection)
    vessels crossed = 6-connected components of vessel voxels within one voxel
                      diagonal of the plane, inside the organ's bounding box
                      padded by 3 voxels, of at least VESSEL_MIN_MM3

All of it is numpy over the precomputed voxel coordinate lists, with the same
float32-coordinate, float64-arithmetic plane test as the TS loops.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from scipy import ndimage
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

from .grid import Grid

# Smallest straddling component that counts as a vessel crossed (vessels.ts).
VESSEL_MIN_MM3 = 120.0
BOX_PAD_VOX = 3


@dataclass
class Plane:
    n: tuple[float, float, float]
    d: float

    def to_json(self) -> dict[str, Any]:
        return {"n": list(self.n), "d": self.d}


@dataclass
class Metrics:
    remnant_pct: float
    resected_ml: float
    healthy_remnant_ml: float
    margin_mm: float
    tumor_incomplete: bool
    vessels_crossed: int
    vessel_name: str | None = None
    vessel_id: int = 0
    nearest_vessel_mm: float = math.inf
    nearest_vessel_id: int = 0
    vessel_cuts: list[dict[str, Any]] = field(default_factory=list)


def normalize(v: Any) -> tuple[float, float, float]:
    a = np.asarray(v, dtype=np.float64)
    length = math.sqrt(float(a @ a))
    if length <= 1e-9:
        return (0.0, 0.0, 1.0)
    return (float(a[0] / length), float(a[1] / length), float(a[2] / length))


def angle_deg(a: Any, b: Any) -> float:
    na, nb = normalize(a), normalize(b)
    c = na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2]
    return math.acos(max(-1.0, min(1.0, c))) * 180 / math.pi


def project(xyz: np.ndarray, n: Any) -> np.ndarray:
    """n . x for each row, summed left to right like the TS expression."""
    return n[0] * xyz[:, 0] + n[1] * xyz[:, 1] + n[2] * xyz[:, 2]


def remnant(g: Grid, plane: Plane) -> dict[str, float]:
    sd_org = project(g.organ_xyz, plane.n) - plane.d
    kept = int((sd_org <= 0).sum())
    tumor_kept = int((project(g.tumor_xyz, plane.n) - plane.d <= 0).sum())
    total = g.organ_idx.size
    ml = g.voxel_mm3 / 1000
    return {
        "remnant_pct": 100 * kept / total if total > 0 else 0.0,
        "resected_ml": (total - kept) * ml,
        "healthy_remnant_ml": (kept - tumor_kept) * ml,
        "tumor_kept": tumor_kept,
    }


def margin(g: Grid, plane: Plane, tumor_kept: int) -> tuple[float, bool]:
    """(margin mm, tumour incomplete). +inf when there is no tumour or no cut surface."""
    if g.tumor_idx.size == 0:
        return math.inf, False
    if tumor_kept > 0:
        return 0.0, True
    sd = project(g.organ_xyz, plane.n) - plane.d
    face = (sd <= 0) & (sd >= -g.voxel_diag)
    if not face.any():
        return math.inf, False
    return float(g.dist_tumor[g.organ_idx[face]].min()), False


# ------------------------------------------------------------------ vessels


def _box_vessels(g: Grid) -> dict[str, np.ndarray]:
    """Vessel voxels inside the padded organ box, with coordinates and 6-neighbour edges. Cached."""
    cache = g.__dict__.setdefault("_box_vessels", None)
    if cache is not None:
        return cache
    idx = g.vessel_idx
    box = g.organ_box
    if box is not None:
        i, j, k = g.ijk(idx)
        (li, lj, lk), (hi, hj, hk) = box
        p = BOX_PAD_VOX
        keep = (i >= li - p) & (i <= hi + p) & (j >= lj - p) & (j <= hj + p) & (k >= lk - p) & (k <= hk + p)
        idx = idx[keep]
    xyz = g.coords(idx)
    # Edges between face neighbours that are both box vessel voxels.
    pos = np.full(g.labels.size, -1, dtype=np.int64)
    pos[idx] = np.arange(idx.size)
    i, j, k = g.ijk(idx)
    ea, eb = [], []
    for ok, step in ((i < g.nx - 1, 1), (j < g.ny - 1, g.nx), (k < g.nz - 1, g.nx * g.ny)):
        a = np.flatnonzero(ok)
        b = pos[idx[a] + step]
        hit = b >= 0
        ea.append(a[hit])
        eb.append(b[hit])
    out = {"idx": idx, "xyz": xyz, "ea": np.concatenate(ea), "eb": np.concatenate(eb)}
    g.__dict__["_box_vessels"] = out
    return out


def vessels(g: Grid, plane: Plane, names: dict[int, str]) -> dict[str, Any]:
    """computeVessels: crossed count, largest crossed vessel, nearest vessel, cut points."""
    bv = _box_vessels(g)
    if bv["idx"].size == 0:
        return {"crossed": 0, "largest_id": 0, "nearest_mm": math.inf, "nearest_id": 0, "cuts": []}
    sd = project(bv["xyz"], plane.n) - plane.d
    ad = np.abs(sd)
    a_near = int(np.argmin(ad))
    nearest_mm = float(ad[a_near])
    nearest_id = int(g.labels[bv["idx"][a_near]])
    strad = bv["idx"][ad < g.voxel_diag]
    if strad.size == 0:
        return {"crossed": 0, "largest_id": 0, "nearest_mm": nearest_mm, "nearest_id": nearest_id, "cuts": []}

    # Label the straddling voxels on their own bounding box. ndimage's default
    # structure is face (6-) connectivity, and its raster order numbers
    # components by their lowest flat index: the order computeVessels meets them.
    i, j, k = g.ijk(strad)
    sub = np.zeros((k.max() - k.min() + 1, j.max() - j.min() + 1, i.max() - i.min() + 1), dtype=bool)
    sub[k - k.min(), j - j.min(), i - i.min()] = True
    comp, n_comp = ndimage.label(sub)
    lab_of = comp[k - k.min(), j - j.min(), i - i.min()]
    sizes = np.bincount(lab_of, minlength=n_comp + 1)
    xyz = g.coords(strad)
    crossed = 0
    largest_vox = 0
    largest_id = 0
    cuts = []
    for c in range(1, n_comp + 1):
        if sizes[c] * g.voxel_mm3 < VESSEL_MIN_MM3:
            continue
        crossed += 1
        members = lab_of == c
        # Named after whichever label contributes most of the component.
        comp_id = int(np.bincount(g.labels[strad[members]]).argmax())
        p = xyz[members].mean(axis=0)
        cuts.append({"p": [float(p[0]), float(p[1]), float(p[2])], "id": comp_id})
        if sizes[c] > largest_vox:
            largest_vox = int(sizes[c])
            largest_id = comp_id
    return {"crossed": crossed, "largest_id": largest_id, "nearest_mm": nearest_mm, "nearest_id": nearest_id, "cuts": cuts}


def vessel_crossings_along(g: Grid, n: Any, ds: np.ndarray) -> np.ndarray:
    """Vessels crossed by every plane n.x = d for d in `ds` (vesselCrossingsAlong).

    Same rules as `vessels`. All offsets are solved in one graph: a node is
    (offset, voxel) for each voxel in that offset's band, edges join face
    neighbours in the same band, and connected components are counted per
    offset. One sparse connected-components call per direction.
    """
    bv = _box_vessels(g)
    ds = np.asarray(ds, dtype=np.float64)
    if bv["idx"].size == 0:
        return np.zeros(ds.size, dtype=np.int64)
    band = g.voxel_diag
    t = project(bv["xyz"], n)
    sel = np.flatnonzero((t > ds.min() - band) & (t < ds.max() + band))
    if sel.size == 0:
        return np.zeros(ds.size, dtype=np.int64)
    ts = t[sel]
    member = (ts[None, :] > ds[:, None] - band) & (ts[None, :] < ds[:, None] + band)  # (K, S)
    local = np.full(bv["idx"].size, -1, dtype=np.int64)
    local[sel] = np.arange(sel.size)
    la, lb = local[bv["ea"]], local[bv["eb"]]
    keep = (la >= 0) & (lb >= 0)
    la, lb = la[keep], lb[keep]

    node = np.full(member.shape, -1, dtype=np.int64)
    node[member] = np.arange(int(member.sum()))
    n_nodes = int(member.sum())
    if n_nodes == 0:
        return np.zeros(ds.size, dtype=np.int64)
    ka, ea = np.nonzero(member[:, la] & member[:, lb])
    rows = node[ka, la[ea]]
    cols = node[ka, lb[ea]]
    graph = coo_matrix((np.ones(rows.size, dtype=np.int8), (rows, cols)), shape=(n_nodes, n_nodes))
    _, comp = connected_components(graph, directed=False)
    sizes = np.bincount(comp)
    node_k = np.nonzero(member)[0]
    comp_k = np.empty(sizes.size, dtype=np.int64)
    comp_k[comp] = node_k
    min_voxels = VESSEL_MIN_MM3 / g.voxel_mm3
    big = sizes >= min_voxels
    return np.bincount(comp_k[big], minlength=ds.size)


# -------------------------------------------------------------------- engine


def evaluate_plane(g: Grid, plane: Plane, names: dict[int, str]) -> Metrics:
    """engine.ts evaluatePlane with every option on."""
    r = remnant(g, plane)
    m, incomplete = margin(g, plane, r["tumor_kept"])
    v = vessels(g, plane, names)
    return Metrics(
        remnant_pct=r["remnant_pct"],
        resected_ml=r["resected_ml"],
        healthy_remnant_ml=r["healthy_remnant_ml"],
        # A plane that misses the organ has no cut surface and no margin: 0, not inf.
        margin_mm=m if math.isfinite(m) else 0.0,
        tumor_incomplete=incomplete,
        vessels_crossed=v["crossed"],
        vessel_name=names.get(v["largest_id"]) if v["largest_id"] > 0 else None,
        vessel_id=v["largest_id"],
        nearest_vessel_mm=v["nearest_mm"],
        nearest_vessel_id=v["nearest_id"],
        vessel_cuts=v["cuts"],
    )
