"""Turn a CT volume plus segmentations into the four files the browser loads.

Usage:
    python pipeline/run.py liver  --ct raw/imagesTr/liver_72.nii.gz \
                                  --labels raw/labelsTr/liver_72.nii.gz \
                                  --seg raw/seg/liver_72 raw/seg_vessels/liver_72
    python pipeline/run.py aorta  --ct ... --seg ...

Outputs into public/data/<case>/:
    volume.u8         windowed CT, one byte per voxel, x-fastest
    labels.u8         packed structure ids, same grid
    meta.json         grid, spacing, HU curve, label table, window presets
    centerlines.json  aorta centerline with per-point lumen radius
and  pipeline/out/<case>/truth.json, the numpy ground truth vitest asserts on.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import nibabel as nib
import numpy as np
from scipy import ndimage

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
PUBLIC = REPO / "public" / "data"
OUT = HERE / "out"

# Target geometry. 1.5 mm isotropic keeps a torso inside a 256^3 texture, which
# is 16 MB per volume - small enough to ship and to upload to the GPU quickly.
TARGET_SPACING = 1.5
MAX_DIM = 256

# --------------------------------------------------------------------------
# HU -> uint8 transfer curve.
#
# A linear ramp over [-1000, 2000] HU would give the liver window (W150/L30,
# i.e. -45..105 HU) only about 13 distinct byte values, which bands visibly on
# a projector. This piecewise curve spends most of the byte range on soft
# tissue, where every clinically interesting window lives, and compresses air
# and bone where a few coarse steps are indistinguishable anyway.
#
# Segments: air/lung, soft tissue, bone. The shader inverts the same curve.
# --------------------------------------------------------------------------
HU_CURVE: list[tuple[int, int]] = [
    (0, -1000),   # air
    (40, -200),   # fat / lung boundary        -> 20.0 HU per step below here
    (215, 300),   #  soft tissue               ->  2.9 HU per step
    (255, 2000),  # cortical bone and metal    -> 42.5 HU per step
]

WINDOW_PRESETS = {
    "soft": {"w": 400, "l": 40},
    "bone": {"w": 1800, "l": 400},
    "lung": {"w": 1500, "l": -600},
    "liver": {"w": 150, "l": 30},
}

# The packed label table. Ids are the byte values written into labels.u8.
# `src` names the TotalSegmentator mask file (without .nii.gz) that supplies it.
LABELS: list[dict] = [
    {"id": 1, "key": "liver", "name": "Liver", "color": [0.74, 0.42, 0.36], "role": "organ", "src": "liver"},
    {"id": 2, "key": "tumor", "name": "Tumour", "color": [1.0, 0.36, 0.2], "role": "tumor", "src": None},
    {"id": 3, "key": "ivc", "name": "Inferior vena cava", "color": [0.29, 0.62, 0.9], "role": "vessel", "src": "inferior_vena_cava"},
    {"id": 4, "key": "portal_vein", "name": "Portal vein", "color": [0.34, 0.82, 0.78], "role": "vessel", "src": "portal_vein_and_splenic_vein"},
    {"id": 5, "key": "aorta", "name": "Aorta", "color": [0.93, 0.33, 0.42], "role": "vessel", "src": "aorta"},
    {"id": 6, "key": "kidney_left", "name": "Left kidney", "color": [0.62, 0.55, 0.85], "role": "context", "src": "kidney_left"},
    {"id": 7, "key": "kidney_right", "name": "Right kidney", "color": [0.62, 0.55, 0.85], "role": "context", "src": "kidney_right"},
    # From TotalSegmentator's `liver_vessels` task: the intrahepatic hepatic
    # and portal branches a resection plane actually has to avoid.
    {"id": 8, "key": "hepatic_vessels", "name": "Hepatic vessel", "color": [0.36, 0.74, 0.98], "role": "vessel", "src": "liver_vessels"},
]

# Which ids the planning engine treats as vessels to avoid.
VESSEL_IDS = [3, 4, 5, 8]


def hu_to_u8(hu: np.ndarray) -> np.ndarray:
    """Apply the piecewise HU -> uint8 curve."""
    us = np.array([p[0] for p in HU_CURVE], dtype=np.float32)
    hs = np.array([p[1] for p in HU_CURVE], dtype=np.float32)
    # np.interp needs increasing x, which hs is by construction.
    out = np.interp(hu, hs, us)
    return np.clip(np.rint(out), 0, 255).astype(np.uint8)


def u8_to_hu(u8: np.ndarray) -> np.ndarray:
    """Inverse of `hu_to_u8`, for checking round-trip error."""
    us = np.array([p[0] for p in HU_CURVE], dtype=np.float32)
    hs = np.array([p[1] for p in HU_CURVE], dtype=np.float32)
    return np.interp(u8.astype(np.float32), us, hs)


def canonical(img: nib.Nifti1Image) -> nib.Nifti1Image:
    """Reorient to RAS so every case has the same anatomical axis order."""
    return nib.as_closest_canonical(img)


def resample(
    data: np.ndarray, spacing: np.ndarray, target: float, order: int, max_dim: int = MAX_DIM
) -> tuple[np.ndarray, np.ndarray]:
    """Resample to `target` mm isotropic, then cap any axis at `max_dim`."""
    out_shape = np.maximum(1, np.rint(np.array(data.shape) * spacing / target)).astype(int)
    # If the body is too long for the texture, coarsen uniformly rather than
    # cropping, so the whole torso stays in frame.
    over = out_shape.max() / max_dim
    if over > 1.0:
        out_shape = np.maximum(1, np.rint(out_shape / over)).astype(int)
    zoom = out_shape / np.array(data.shape)
    res = ndimage.zoom(data, zoom, order=order, prefilter=order > 1)
    new_spacing = np.array(data.shape) * spacing / np.array(res.shape)
    return res, new_spacing


def body_bbox(ct_hu: np.ndarray, spacing: np.ndarray, pad_mm: float = 12.0) -> tuple[slice, ...]:
    """Bounding box of the patient, so we do not spend texture on empty air."""
    body = ndimage.binary_fill_holes(ct_hu > -500)
    # Keep only the largest component: the table and arms-off artefacts go away.
    lab, n = ndimage.label(body)
    if n > 1:
        sizes = ndimage.sum(body, lab, range(1, n + 1))
        body = lab == (int(np.argmax(sizes)) + 1)
    idx = np.array(np.nonzero(body))
    if idx.size == 0:
        return tuple(slice(0, s) for s in ct_hu.shape)
    lo = idx.min(axis=1)
    hi = idx.max(axis=1) + 1
    pad = np.rint(pad_mm / spacing).astype(int)
    lo = np.maximum(0, lo - pad)
    hi = np.minimum(np.array(ct_hu.shape), hi + pad)
    return tuple(slice(int(a), int(b)) for a, b in zip(lo, hi))


def crop_to_region(
    mask: np.ndarray, spacing: np.ndarray, pad_mm: float, shape: tuple[int, ...]
) -> tuple[slice, ...]:
    """Bounding box of `mask` grown by `pad_mm`, clipped to `shape`."""
    idx = np.array(np.nonzero(mask))
    if idx.size == 0:
        return tuple(slice(0, s) for s in shape)
    lo = idx.min(axis=1)
    hi = idx.max(axis=1) + 1
    pad = np.rint(pad_mm / spacing).astype(int)
    lo = np.maximum(0, lo - pad)
    hi = np.minimum(np.array(shape), hi + pad)
    return tuple(slice(int(a), int(b)) for a, b in zip(lo, hi))


def load_seg(seg_dirs: list[Path] | None, name: str | None, shape: tuple[int, ...]) -> np.ndarray | None:
    """Load one TotalSegmentator mask from the first output directory that has it."""
    if not seg_dirs or name is None:
        return None
    for cand in [d / f"{name}{ext}" for d in seg_dirs for ext in (".nii.gz", ".nii")]:
        if cand.exists():
            img = canonical(nib.load(str(cand)))
            data = np.asanyarray(img.dataobj) > 0
            if data.shape != shape:
                print(f"  ! {name} is {data.shape}, expected {shape}; skipping")
                return None
            return data
    return None


# --------------------------------------------------------------------------
# centerline
# --------------------------------------------------------------------------


def skeleton_longest_path(mask: np.ndarray) -> list[tuple[int, int, int]]:
    """Longest path through a 3D skeleton, found with two BFS sweeps.

    The skeleton of a tube is very nearly a path graph, so the standard
    double-BFS trick for tree diameter gives the vessel's full length without
    needing a general graph library.
    """
    from skimage.morphology import skeletonize

    skel = skeletonize(mask)
    pts = np.array(np.nonzero(skel)).T
    if len(pts) < 4:
        return []

    index = {tuple(p): i for i, p in enumerate(map(tuple, pts))}
    # 26-neighbourhood adjacency.
    offsets = [
        (dx, dy, dz)
        for dx in (-1, 0, 1)
        for dy in (-1, 0, 1)
        for dz in (-1, 0, 1)
        if (dx, dy, dz) != (0, 0, 0)
    ]
    adj: list[list[int]] = [[] for _ in pts]
    for p, i in index.items():
        for o in offsets:
            q = (p[0] + o[0], p[1] + o[1], p[2] + o[2])
            j = index.get(q)
            if j is not None:
                adj[i].append(j)

    def bfs(start: int) -> tuple[int, list[int]]:
        prev = {start: -1}
        order = [start]
        head = 0
        while head < len(order):
            u = order[head]
            head += 1
            for v in adj[u]:
                if v not in prev:
                    prev[v] = u
                    order.append(v)
        far = order[-1]
        path = []
        cur = far
        while cur != -1:
            path.append(cur)
            cur = prev[cur]
        return far, path[::-1]

    # Start from the skeleton point with the most extreme coordinate so the
    # first BFS reliably lands on an end of the largest component.
    far1, _ = bfs(int(np.argmin(pts[:, 2])))
    _, path = bfs(far1)
    return [tuple(int(c) for c in pts[i]) for i in path]


def build_centerline(
    mask: np.ndarray, spacing: np.ndarray, origin: np.ndarray, step_mm: float = 2.0
) -> list[dict]:
    """Skeletonise, take the longest path, resample, smooth, measure radius."""
    path = skeleton_longest_path(mask)
    if len(path) < 4:
        return []

    pts_mm = np.array([[p[i] * spacing[i] + origin[i] for i in range(3)] for p in path])

    # Lumen radius is the distance transform of the mask sampled on the axis:
    # the largest inscribed sphere, which is the usual radius definition here.
    # The volume's top and bottom faces are crop planes, not vessel wall: pad
    # the mask by repeating its edge slices so the EDT does not read the cut
    # as a narrowing.
    pz = 32
    padded = np.pad(mask, ((0, 0), (0, 0), (pz, pz)), mode="edge")
    edt = ndimage.distance_transform_edt(padded, sampling=spacing)[:, :, pz:-pz]
    radii = np.array([edt[p] for p in path])

    # DECISION: skeletonize leaves short spurs that run sideways across a flat
    # end cap, where the inscribed radius tapers to nothing (liver_8: 3.8 mm
    # against an 8.7 mm median, at one height). Trim end points thinner than
    # 0.75 x the median so the flow model does not paint them as a stenosis.
    med = float(np.median(radii))
    lo, hi = 0, len(path)
    while lo < hi - 2 and radii[lo] < 0.75 * med:
        lo += 1
    while hi > lo + 2 and radii[hi - 1] < 0.75 * med:
        hi -= 1
    path, radii, pts_mm = path[lo:hi], radii[lo:hi], pts_mm[lo:hi]

    # Resample to a uniform step along arc length.
    seg = np.linalg.norm(np.diff(pts_mm, axis=0), axis=1)
    s = np.concatenate([[0.0], np.cumsum(seg)])
    total = float(s[-1])
    if total < step_mm * 4:
        return []
    s_new = np.arange(0.0, total, step_mm)
    pts_r = np.stack([np.interp(s_new, s, pts_mm[:, i]) for i in range(3)], axis=1)
    rad_r = np.interp(s_new, s, radii)

    # Moving average: the skeleton staircases on the voxel grid, and an
    # unsmoothed tangent makes the stent tube kink.
    def smooth(a: np.ndarray, k: int) -> np.ndarray:
        if len(a) < k:
            return a
        kern = np.ones(k) / k
        pad = k // 2
        padded = np.pad(a, (pad, pad), mode="edge")
        return np.convolve(padded, kern, mode="same")[pad : pad + len(a)]

    for i in range(3):
        pts_r[:, i] = smooth(pts_r[:, i], 7)
    rad_r = smooth(rad_r, 5)

    # Tangents by central difference on the smoothed polyline.
    tangents = np.gradient(pts_r, axis=0)
    norms = np.linalg.norm(tangents, axis=1, keepdims=True)
    tangents = tangents / np.maximum(norms, 1e-9)

    return [
        {
            "p": [round(float(v), 3) for v in pts_r[i]],
            "r": round(float(rad_r[i]), 3),
            "t": [round(float(v), 4) for v in tangents[i]],
        }
        for i in range(len(s_new))
    ]


def renal_ostia(centerline: list[dict], kidneys: dict[str, np.ndarray | None],
                spacing: np.ndarray, origin: np.ndarray) -> list[dict]:
    """Approximate each renal artery origin.

    TotalSegmentator's free model does not segment the renal arteries. The
    renal artery runs from the aorta to the kidney's hilum, roughly level or
    slightly downhill, so we take the centerline point at the cranio-caudal
    level of the hilum (the mean of the kidney's most medial 10 % of voxels).

    DECISION: an earlier version used the centerline point nearest the
    kidney's 3D centroid. The centroid sits lateral and low, so that pulled
    the estimate 20-25 mm caudal, towards the bifurcation, which is the unsafe
    direction for "does the graft cover the renals". Arteries usually arise at
    or slightly above the hilum, so this estimate errs low by a few mm at most;
    the README documents it as an approximation.
    """
    if not centerline:
        return []
    axis = np.array([c["p"] for c in centerline])
    out = []
    for side, mask in kidneys.items():
        if mask is None or not mask.any():
            continue
        pts = np.array(np.nonzero(mask)).T * spacing + origin
        lateral = np.abs(pts[:, 0] - axis[:, 0].mean())
        hilum = pts[lateral <= np.percentile(lateral, 10)].mean(axis=0)
        j = int(np.argmin(np.abs(axis[:, 2] - hilum[2])))
        out.append({"p": [round(float(v), 3) for v in axis[j]], "side": side})
    return out


# --------------------------------------------------------------------------
# ground truth
# --------------------------------------------------------------------------


def majority_downsample(labels: np.ndarray, factor: int) -> np.ndarray:
    """Block-reduce a label grid by taking the most common non-zero id.

    The browser builds its planning grid the same way, so truth computed here
    is directly comparable to what vitest measures there.
    """
    shape = np.array(labels.shape)
    out_shape = np.ceil(shape / factor).astype(int)
    pad = out_shape * factor - shape
    padded = np.pad(labels, [(0, int(p)) for p in pad], mode="constant")
    blocks = padded.reshape(
        out_shape[0], factor, out_shape[1], factor, out_shape[2], factor
    ).transpose(0, 2, 4, 1, 3, 5).reshape(*out_shape, factor**3)

    counts = np.zeros((*out_shape, 256), dtype=np.uint16)
    flat = counts.reshape(-1, 256)
    idx = np.repeat(np.arange(flat.shape[0]), factor**3)
    np.add.at(flat, (idx, blocks.reshape(-1)), 1)
    counts[..., 0] = 0  # background only wins if nothing else is present

    # On a tie the HIGHER label id wins. The table is ordered so that thin or
    # clinically important structures sit above the bulk organ they live
    # inside (tumour 2 and vessels 3-5 above liver 1), which stops a vessel
    # from being averaged out of existence by the parenchyma around it.
    # argmax takes the first maximum, so search a reversed view.
    rev = counts[..., ::-1]
    best = (255 - rev.argmax(axis=-1)).astype(np.uint8)
    has = counts.max(axis=-1) > 0

    out = np.zeros(out_shape, dtype=np.uint8)
    out[has] = best[has]
    return out


def plane_metrics(
    labels: np.ndarray, spacing: np.ndarray, origin: np.ndarray,
    n: np.ndarray, d: float, vessel_ids: list[int],
) -> dict:
    """The same four formulas the browser uses, in numpy, as the test oracle."""
    nx, ny, nz = labels.shape
    xs = np.arange(nx) * spacing[0] + origin[0]
    ys = np.arange(ny) * spacing[1] + origin[1]
    zs = np.arange(nz) * spacing[2] + origin[2]
    # Signed distance to the plane for every voxel, built separably.
    sd = (
        n[0] * xs[:, None, None] + n[1] * ys[None, :, None] + n[2] * zs[None, None, :] - d
    )

    organ = labels == 1
    tumor = labels == 2
    # The tumour sits inside the organ, so "organ" for volume purposes is both.
    whole = organ | tumor

    vx_ml = float(np.prod(spacing)) / 1000.0
    total = int(whole.sum())
    kept = whole & (sd <= 0)
    resected = whole & (sd > 0)

    remnant_pct = 100.0 * int(kept.sum()) / max(total, 1)
    resected_ml = int(resected.sum()) * vx_ml

    tumor_kept = int((tumor & (sd <= 0)).sum())

    # Margin: distance from the cut surface to the tumour, measured on the kept
    # side only. Voxels within one voxel-diagonal of the plane are the cut face.
    diag = float(np.linalg.norm(spacing))
    if tumor.any():
        dist_tumor = ndimage.distance_transform_edt(~tumor, sampling=spacing)
        face = (np.abs(sd) < diag) & (sd <= 0) & whole
        margin = float(dist_tumor[face].min()) if face.any() else float("inf")
    else:
        margin = float("inf")
    if tumor_kept > 0:
        margin = 0.0

    # Vessels crossed: connected components of vessel voxels straddling the cut,
    # restricted to the organ's bounding box so unrelated vasculature elsewhere
    # in the torso is not counted.
    vessels = np.isin(labels, vessel_ids)
    if whole.any():
        bb = crop_to_region(whole, spacing, 10.0, labels.shape)
        box = np.zeros_like(vessels)
        box[bb] = True
        vessels = vessels & box
    straddle = vessels & (np.abs(sd) < diag)
    comp, n_all = ndimage.label(straddle)
    # Only components the size of a 5 mm vessel crossing the cut band count;
    # identical to VESSEL_MIN_MM3 in src/planning/vessels.ts.
    sizes = ndimage.sum(straddle, comp, range(1, n_all + 1)) if n_all else np.array([])
    n_comp = int((np.asarray(sizes) * np.prod(spacing) >= 120.0).sum())

    return {
        "remnantPct": round(remnant_pct, 3),
        "resectedMl": round(resected_ml, 3),
        "marginMm": round(margin, 3) if np.isfinite(margin) else -1.0,
        "tumorIncomplete": tumor_kept > 0,
        "vesselsCrossed": int(n_comp),
    }


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("case", help="output case id, e.g. liver or aorta")
    ap.add_argument("--ct", required=True, type=Path)
    ap.add_argument("--labels", type=Path, help="MSD label volume (1 liver, 2 tumour)")
    ap.add_argument("--seg", type=Path, nargs="+",
                    help="TotalSegmentator output directories (total task, liver_vessels task)")
    ap.add_argument("--name", help="display name for the HUD")
    ap.add_argument("--kind", default=None, choices=["liver", "aorta"])
    # DECISION: the liver case ships at its native 1.0 mm (512 cap) instead of
    # 1.5 mm / 256: the old cap threw away ~80 % of the voxels of a scan that
    # was already near diagnostic resolution. The planning grid is coarsened
    # separately (voxel budget), so the numbers stay fast either way.
    ap.add_argument("--spacing", type=float, default=TARGET_SPACING, help="isotropic output spacing, mm")
    ap.add_argument("--max-dim", type=int, default=MAX_DIM, help="cap on any output axis, voxels")
    args = ap.parse_args()

    kind = args.kind or ("liver" if args.case.startswith("liver") else "aorta")

    print(f"[1/7] loading {args.ct}")
    ct_img = canonical(nib.load(str(args.ct)))
    ct = np.asanyarray(ct_img.dataobj).astype(np.float32)
    spacing = np.abs(np.array(ct_img.header.get_zooms()[:3], dtype=np.float64))
    print(f"      {ct.shape} at {spacing.round(3)} mm")

    # --- assemble the label grid at native resolution ---------------------
    packed = np.zeros(ct.shape, dtype=np.uint8)

    if args.labels and args.labels.exists():
        msd = np.asanyarray(canonical(nib.load(str(args.labels))).dataobj).astype(np.uint8)
        if msd.shape != ct.shape:
            print(f"      ! label shape {msd.shape} != CT {ct.shape}", flush=True)
        else:
            packed[msd == 1] = 1
            packed[msd == 2] = 2
            print(f"      MSD: liver {int((msd==1).sum())} vox, tumour {int((msd==2).sum())} vox")

    print(f"[2/7] merging TotalSegmentator masks from {args.seg}")
    for spec in LABELS:
        mask = load_seg(args.seg, spec["src"], ct.shape)
        if mask is None:
            continue
        if spec["id"] == 1 and (packed == 1).any():
            continue  # MSD's liver is the reference for the liver case
        # Vessels are written last-wins over context, but never over the tumour.
        packed[mask & (packed != 2)] = spec["id"]
        print(f"      + {spec['key']}: {int(mask.sum())} vox")

    # --- crop ------------------------------------------------------------
    print("[3/7] cropping")
    # Crop laterally to the whole patient (plus a little air) but slab in the
    # cranio-caudal direction around the structure of interest.
    #
    # Cropping the in-plane axes to the organ instead would saw straight
    # through the torso and leave a flat face of cut tissue hanging in space,
    # which reads as a rendering bug rather than as anatomy. A z-slab is what
    # every abdominal CT already looks like, so it reads correctly.
    body = body_bbox(ct, spacing, pad_mm=10.0)

    roi = packed == 1 if kind == "liver" else packed == 5
    kidneys = (packed == 6) | (packed == 7)
    if kind == "aorta" and roi.any() and kidneys.any():
        # DECISION: an infrarenal stent plan needs the aorta from just below
        # its bifurcation to above the renal arteries, not the whole thoracic
        # aorta a chest-abdomen-pelvis scan carries. Slab from 30 mm under the
        # aorta's lowest slice to 40 mm over the kidneys' top.
        za = np.nonzero(roi.any(axis=(0, 1)))[0]
        zk = np.nonzero(kidneys.any(axis=(0, 1)))[0]
        lo = max(0, int(za.min() - 30.0 / spacing[2]))
        hi = min(ct.shape[2], int(zk.max() + 40.0 / spacing[2]) + 1)
        zb = slice(max(lo, body[2].start), min(hi, body[2].stop))
    elif roi.any():
        pad = 70.0 if kind == "liver" else 45.0
        zb = crop_to_region(roi, spacing, pad, ct.shape)[2]
        # Intersect only the z extent; keep the full body in x and y.
        zb = slice(max(zb.start, body[2].start), min(zb.stop, body[2].stop))
    else:
        zb = body[2]

    bb = (body[0], body[1], zb)
    ct = ct[bb]
    packed = packed[bb]
    origin_native = np.array([bb[i].start * spacing[i] for i in range(3)])
    print(f"      -> {ct.shape}")

    # --- resample --------------------------------------------------------
    print(f"[4/7] resampling to {args.spacing} mm isotropic (cap {args.max_dim})")
    ct_r, sp_r = resample(ct, spacing, args.spacing, order=1, max_dim=args.max_dim)
    lab_r, _ = resample(packed, spacing, args.spacing, order=0, max_dim=args.max_dim)
    if lab_r.shape != ct_r.shape:
        # order=0 zoom can land one voxel off; trim both to the common shape.
        shp = tuple(min(a, b) for a, b in zip(ct_r.shape, lab_r.shape))
        ct_r = ct_r[: shp[0], : shp[1], : shp[2]]
        lab_r = lab_r[: shp[0], : shp[1], : shp[2]]
    print(f"      -> {ct_r.shape} at {sp_r.round(3)} mm")

    # --- encode ----------------------------------------------------------
    print("[5/7] encoding")
    vol_u8 = hu_to_u8(ct_r)
    err = np.abs(u8_to_hu(vol_u8) - np.clip(ct_r, -1000, 2000))
    soft = (ct_r > -200) & (ct_r < 300)
    print(f"      HU round-trip error: soft tissue mean {err[soft].mean():.2f} HU, "
          f"max {err[soft].max():.2f} HU")

    out_dir = PUBLIC / args.case
    out_dir.mkdir(parents=True, exist_ok=True)
    # x-fastest ordering is what a Data3DTexture expects, and numpy's default
    # C order over (x, y, z) gives z-fastest, hence the transpose.
    vol_u8.transpose(2, 1, 0).ravel(order="C").tofile(out_dir / "volume.u8")
    lab_r.astype(np.uint8).transpose(2, 1, 0).ravel(order="C").tofile(out_dir / "labels.u8")

    present = sorted(set(int(v) for v in np.unique(lab_r)) - {0})
    label_table = [
        {k: v for k, v in spec.items() if k != "src"}
        for spec in LABELS
        if spec["id"] in present
    ]
    print(f"      labels present: {[s['key'] for s in label_table]}")

    # --- centerline ------------------------------------------------------
    print("[6/7] centerline")
    centerlines: dict = {"vessels": {}, "renalOstia": []}
    aorta = lab_r == 5
    if aorta.sum() > 200:
        cl = build_centerline(aorta, sp_r, origin_native * 0 + 0.0)
        if cl:
            centerlines["vessels"]["aorta"] = cl
            length = len(cl) * 2.0
            radii = [c["r"] for c in cl]
            print(f"      aorta: {len(cl)} points, {length:.0f} mm, "
                  f"radius {min(radii):.1f}-{max(radii):.1f} mm")
            centerlines["renalOstia"] = renal_ostia(
                cl,
                {"left": lab_r == 6, "right": lab_r == 7},
                sp_r,
                np.zeros(3),
            )
            print(f"      renal ostia: {len(centerlines['renalOstia'])}")
    else:
        print("      no aorta mask; skipping")

    meta = {
        "id": args.case,
        "name": args.name or f"{kind.title()} — {args.ct.stem.replace('.nii', '')}",
        "kind": kind,
        # Written in the texture's axis order.
        "shape": [int(s) for s in lab_r.shape],
        "spacing": [round(float(s), 5) for s in sp_r],
        "origin": [0.0, 0.0, 0.0],
        "huRange": [HU_CURVE[0][1], HU_CURVE[-1][1]],
        "huCurve": [[int(u), int(h)] for u, h in HU_CURVE],
        "labels": label_table,
        "vesselIds": [i for i in VESSEL_IDS if i in present],
        "windowPresets": WINDOW_PRESETS,
        # Soft-tissue windowing reads best on the anatomy view's CT cut face.
        "defaultPreset": "soft",
        "centerline": "aorta" if centerlines["vessels"] else None,
    }

    # --- ground truth ----------------------------------------------------
    print("[7/7] ground truth")
    vx_ml = float(np.prod(sp_r)) / 1000.0
    organ = (lab_r == 1) | (lab_r == 2)
    tumor = lab_r == 2
    truth: dict = {
        "case": args.case,
        "shape": meta["shape"],
        "spacing": meta["spacing"],
        "organVolumeMl": round(float(organ.sum()) * vx_ml, 3),
        "tumorVolumeMl": round(float(tumor.sum()) * vx_ml, 3),
    }
    if tumor.any():
        com = np.array(ndimage.center_of_mass(tumor))
        truth["tumorCentroidMm"] = [round(float(com[i] * sp_r[i]), 3) for i in range(3)]

        # Two fixed test planes, so vitest exercises both branches of the
        # margin rule rather than only the degenerate one. Both are
        # deterministic functions of the data.
        #
        #   clean  - sits CLEAR_MM proximal to the nearest tumour voxel, so the
        #            tumour is fully resected and the margin is a real positive
        #            distance the TypeScript must reproduce.
        #   throughTumor - passes through the tumour centroid, so margin is 0
        #            and `tumorIncomplete` is true.
        tumor_x_mm = np.nonzero(tumor)[0] * sp_r[0]
        clear_mm = 12.0
        n = np.array([1.0, 0.0, 0.0])

        d_clean = float(tumor_x_mm.min()) - clear_mm
        truth["testPlane"] = {"n": [1.0, 0.0, 0.0], "d": round(d_clean, 3)}
        truth["full"] = plane_metrics(lab_r, sp_r, np.zeros(3), n, d_clean, meta["vesselIds"])

        d_through = float(com[0] * sp_r[0])
        truth["testPlaneThroughTumor"] = {"n": [1.0, 0.0, 0.0], "d": round(d_through, 3)}
        truth["throughTumor"] = plane_metrics(
            lab_r, sp_r, np.zeros(3), n, d_through, meta["vesselIds"]
        )

        # And the same plane on the planning grid the browser uses (same voxel
        # budget rule as planningFactor() in src/planning/volume.ts), so
        # the vitest comparison is apples to apples.
        factor = 1
        while np.prod([int(np.ceil(s / factor)) for s in lab_r.shape]) > 2 * 128**3:
            factor += 1
        lab_p = majority_downsample(lab_r, factor)
        sp_p = sp_r * factor
        truth["planningFactor"] = factor
        truth["planningShape"] = [int(s) for s in lab_p.shape]
        truth["planningSpacing"] = [round(float(s), 5) for s in sp_p]
        truth["planning"] = plane_metrics(
            lab_p, sp_p, np.zeros(3), n, d_clean, meta["vesselIds"]
        )
        truth["planningThroughTumor"] = plane_metrics(
            lab_p, sp_p, np.zeros(3), n, d_through, meta["vesselIds"]
        )
        print(f"      full grid:     {truth['full']}")
        print(f"      planning grid: {truth['planning']}")
        print(f"      through tumour: {truth['planningThroughTumor']}")

    meta["truth"] = {
        k: truth[k] for k in ("organVolumeMl", "tumorVolumeMl") if k in truth
    }

    (out_dir / "meta.json").write_text(json.dumps(meta, indent=1))
    (out_dir / "centerlines.json").write_text(json.dumps(centerlines))

    tdir = OUT / args.case
    tdir.mkdir(parents=True, exist_ok=True)
    (tdir / "truth.json").write_text(json.dumps(truth, indent=1))
    fixtures = REPO / "tests" / "fixtures"
    fixtures.mkdir(parents=True, exist_ok=True)
    (fixtures / f"{args.case}.truth.json").write_text(json.dumps(truth, indent=1))

    # Surface meshes for the anatomy view, from the files just written.
    import meshes  # noqa: E402  (pipeline/ is on sys.path when run as a script)
    meshes.build(args.case)

    mb = (out_dir / "volume.u8").stat().st_size / 1e6
    print(f"\nwrote {out_dir}  ({mb:.1f} MB per volume)")
    print(f"      organ {truth['organVolumeMl']:.0f} mL, tumour {truth['tumorVolumeMl']:.1f} mL")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
