"""Surface meshes for the anatomy view, built from a processed case.

    python pipeline/meshes.py liver      (reads public/data/liver/, writes meshes.json + meshes.bin)

Every labelled structure gets a smooth isosurface (Gaussian-smoothed mask,
marching cubes at 0.5, Taubin-smoothed). Two context surfaces come from the CT
itself: the skin (HU > -350, largest component) and bone (HU > 220, minus
contrast-filled vessels). Coordinates are world millimetres, identical to the
planning engine's, so meshes, cut plane and numbers line up exactly.

meshes.bin layout: every structure's float32 xyz positions, then every
structure's uint32 triangle indices; meshes.json gives the offsets.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage, sparse
from skimage.measure import marching_cubes

HERE = Path(__file__).resolve().parent
PUBLIC = HERE.parent / "public" / "data"


def u8_to_hu(u8: np.ndarray, curve: list[list[int]]) -> np.ndarray:
    xs = np.array([p[0] for p in curve], dtype=np.float32)
    ys = np.array([p[1] for p in curve], dtype=np.float32)
    return np.interp(u8.astype(np.float32), xs, ys)


def largest_component(mask: np.ndarray) -> np.ndarray:
    lab, n = ndimage.label(mask)
    if n <= 1:
        return mask
    sizes = ndimage.sum(mask, lab, range(1, n + 1))
    return lab == (int(np.argmax(sizes)) + 1)


def drop_small(mask: np.ndarray, min_vox: int) -> np.ndarray:
    lab, n = ndimage.label(mask)
    if n == 0:
        return mask
    sizes = ndimage.sum(mask, lab, range(1, n + 1))
    keep = np.zeros(n + 1, bool)
    keep[1:] = sizes >= min_vox
    return keep[lab]


def taubin(verts: np.ndarray, faces: np.ndarray, iters: int = 12, lam: float = 0.5, mu: float = -0.53) -> np.ndarray:
    """Taubin smoothing: shrink-free Laplacian smoothing over the mesh graph."""
    n = len(verts)
    i = np.concatenate([faces[:, 0], faces[:, 1], faces[:, 2], faces[:, 1], faces[:, 2], faces[:, 0]])
    j = np.concatenate([faces[:, 1], faces[:, 2], faces[:, 0], faces[:, 0], faces[:, 1], faces[:, 2]])
    adj = sparse.coo_matrix((np.ones(len(i), np.float32), (i, j)), shape=(n, n)).tocsr()
    adj.data[:] = 1.0
    deg = np.asarray(adj.sum(axis=1)).ravel()
    deg[deg == 0] = 1
    v = verts.astype(np.float64)
    for _ in range(iters):
        for f in (lam, mu):
            avg = adj @ v / deg[:, None]
            v = v + f * (avg - v)
    return v.astype(np.float32)


def surface(mask: np.ndarray, spacing: np.ndarray, sigma: float, step: int, smooth: int):
    if mask.sum() < 20:
        return None
    # Pad so surfaces touching the grid edge close instead of leaving holes.
    m = np.pad(mask.astype(np.float32), 2)
    m = ndimage.gaussian_filter(m, sigma)
    try:
        verts, faces, _, _ = marching_cubes(m, 0.5, spacing=tuple(spacing), step_size=step, allow_degenerate=False)
    except (ValueError, RuntimeError):
        return None
    verts -= 2 * spacing  # undo the padding
    if smooth:
        verts = taubin(verts, faces, smooth)
    return verts.astype(np.float32), faces.astype(np.uint32)


def build(case: str) -> None:
    d = PUBLIC / case
    meta = json.loads((d / "meta.json").read_text())
    nx, ny, nz = meta["shape"]
    sp = np.array(meta["spacing"], dtype=np.float64)
    labels = np.fromfile(d / "labels.u8", np.uint8).reshape(nz, ny, nx).transpose(2, 1, 0)
    hu = u8_to_hu(np.fromfile(d / "volume.u8", np.uint8).reshape(nz, ny, nx).transpose(2, 1, 0), meta["huCurve"])

    by_key = {l["key"]: l for l in meta["labels"]}
    jobs: list[tuple[str, np.ndarray, float, int, int]] = []

    # The organ surface includes everything segmented inside it (tumour and its
    # vessels overwrite liver voxels in the packed volume), so it stays closed.
    inner = [by_key[k]["id"] for k in ("liver", "tumor", "hepatic_vessels") if k in by_key]
    for l in meta["labels"]:
        if l["key"] == "liver":
            jobs.append(("liver", np.isin(labels, inner), 1.2, 1, 10))
        elif l["role"] == "tumor":
            jobs.append((l["key"], labels == l["id"], 0.9, 1, 6))
        elif l["role"] == "vessel":
            jobs.append((l["key"], drop_small(labels == l["id"], 30), 0.8, 1, 6))
        else:
            jobs.append((l["key"], labels == l["id"], 1.1, 1, 8))

    body = largest_component(hu > -350)
    body = ndimage.binary_fill_holes(body)
    jobs.append(("skin", body, 2.0, 2, 10))

    vessels = np.isin(labels, meta.get("vesselIds", []))
    bone = (hu > 220) & ~ndimage.binary_dilation(vessels, iterations=2) & body
    bone = drop_small(bone, 400)
    # Oral contrast fills bowel loops above the 220 HU bone threshold. Bone has
    # a dense cortex and bowel contrast does not (liver_8: every bone component
    # peaks at 680-1360 HU, every contrast loop at 555 HU or less), so keep
    # only components that reach 650 HU somewhere.
    cc, n = ndimage.label(bone)
    if n:
        peak = ndimage.maximum(hu, cc, np.arange(1, n + 1))
        bone = np.isin(cc, np.nonzero(peak >= 650)[0] + 1)
    jobs.append(("bone", bone, 0.9, 1, 4))

    positions: list[np.ndarray] = []
    indices: list[np.ndarray] = []
    table = []
    voff = 0
    ioff = 0
    # Smoothing widths and steps were tuned on ~1.6 mm voxels. Keep them the
    # same in millimetres on finer grids, and sample the big context surfaces
    # (skin, bone) more coarsely there so the mesh stays light; organs, tumour
    # and vessels keep every voxel, which is the point of the finer grid.
    scale = 1.6 / float(sp.mean())
    for key, mask, sigma, step, smooth in jobs:
        if key in ("skin", "bone"):
            step = max(step, math.ceil(step * scale))
        res = surface(mask, sp, sigma * scale, step, smooth)
        if res is None:
            print(f"  - {key}: empty")
            continue
        v, f = res
        positions.append(v.ravel())
        indices.append(f.ravel())
        table.append({
            "key": key,
            "label": by_key[key]["id"] if key in by_key else 0,
            "vertexOffset": voff, "vertexCount": len(v),
            "indexOffset": ioff, "indexCount": f.size,
        })
        voff += len(v)
        ioff += f.size
        print(f"  + {key}: {len(f)} triangles")

    pos = np.concatenate(positions).astype(np.float32)
    idx = np.concatenate(indices).astype(np.uint32)
    with open(d / "meshes.bin", "wb") as fh:
        fh.write(pos.tobytes())
        fh.write(idx.tobytes())
    (d / "meshes.json").write_text(json.dumps({
        "positionsBytes": int(pos.nbytes), "indicesBytes": int(idx.nbytes), "meshes": table,
    }, indent=1))
    print(f"wrote {d / 'meshes.bin'} ({(pos.nbytes + idx.nbytes) / 1e6:.1f} MB)")


if __name__ == "__main__":
    for c in sys.argv[1:] or ["liver", "aorta"]:
        print(f"[meshes] {c}")
        build(c)
