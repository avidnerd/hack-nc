"""vista3d-point Serverless Endpoint: VISTA-3D point-prompt segmentation.

    POST /segment {"case_id": "msd_liver_39", "point": [i, j, k]}
      -> {mask, mesh, voxels, volume_ml, guess, seconds, gpu}

The case is read from the bucket (mounted at /data) as the app itself loads
it: out/<case>/assets/{meta.json, volume.u8, labels.u8}. volume.u8 is turned
back into HU with the case's own huCurve and written as a NIfTI whose affine
is diag(spacing), so the app's voxel index is the prompt point directly and
the mask comes back on the app's grid. The last two cases stay prepared on
local disk.

    mask   bounding box [x0, y0, z0, x1, y1, z1) and the box's bits, x fastest,
           packed little-endian, gzipped, base64
    mesh   marching-cubes surface in world mm: float32 xyz and uint32 indices,
           each base64
    guess  the case label the mask overlaps most, if it covers half the mask
    vista_class  what VISTA-3D calls it: once per case, the automatic
           segmentation of NAMED classes, then the class most of the mask is
"""

from __future__ import annotations

import base64
import gzip
import json
import os
import sys
import tempfile
import time
from collections import OrderedDict
from pathlib import Path

import nibabel as nib
import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from scipy import ndimage

DATA = Path(os.environ.get("DATA_DIR", "/data"))
MODEL_DIR = Path(os.environ.get("VISTA_MODEL_DIR", "/root/NV-Segment-CT"))
WORK = Path(tempfile.mkdtemp(prefix="vista-point-"))
KEEP = 2
# VISTA-3D class ids (NV-Segment-CT metadata.json) used to name a prompted
# structure: the abdominal organs, vessels and muscles a cut can meet.
NAMED = {
    1: "liver", 2: "kidney", 3: "spleen", 4: "pancreas", 5: "right kidney", 6: "aorta", 7: "inferior vena cava",
    8: "right adrenal gland", 9: "left adrenal gland", 10: "gallbladder", 11: "esophagus", 12: "stomach",
    13: "duodenum", 14: "left kidney", 17: "portal vein and splenic vein", 19: "small bowel", 25: "hepatic vessel",
    26: "hepatic tumor", 58: "left iliac artery", 59: "right iliac artery", 62: "colon", 104: "left autochthon",
    105: "right autochthon", 106: "left iliopsoas", 107: "right iliopsoas", 115: "heart",
}

app = FastAPI(title="vista3d-point")
_pipe = None
_gpu = "cpu"
_cases: OrderedDict[str, dict] = OrderedDict()


class SegmentRequest(BaseModel):
    case_id: str = Field(pattern=r"^[A-Za-z0-9_\-]{1,64}$")
    point: list[int] = Field(min_length=3, max_length=3)


def load_model():
    import torch

    if not (MODEL_DIR / "vista3d_pretrained_model" / "model.safetensors").exists():
        from huggingface_hub import snapshot_download

        snapshot_download("nvidia/NV-Segment-CT", local_dir=str(MODEL_DIR), token=os.environ.get("HF_TOKEN"),
                          allow_patterns=["*.py", "*.json", "scripts/*", "vista3d_pretrained_model/model.safetensors"])
    sys.path.insert(0, str(MODEL_DIR))
    from hugging_face_pipeline import HuggingFacePipelineHelper  # NV-Segment-CT repo code

    return HuggingFacePipelineHelper("vista3d").init_pipeline(
        str(MODEL_DIR / "vista3d_pretrained_model"), device=torch.device("cuda:0")
    ), torch.cuda.get_device_name(0)


def u8_to_hu(u8: np.ndarray, curve: list[list[float]]) -> np.ndarray:
    """Invert the pipeline's piecewise-linear HU -> byte curve."""
    xs, ys = zip(*curve)
    return np.interp(u8, xs, ys).astype(np.float32)


def prepare(case_id: str) -> dict:
    """The case's CT as a HU NIfTI on local disk, plus its labels and grid."""
    if case_id in _cases:
        _cases.move_to_end(case_id)
        return _cases[case_id]
    src = DATA / "out" / case_id / "assets"
    if not (src / "meta.json").exists():
        raise HTTPException(404, f"case {case_id} is not in the bucket")
    meta = json.loads((src / "meta.json").read_text())
    nx, ny, nz = meta["shape"]
    # volume.u8 and labels.u8 are x fastest: as numpy C order that is [z, y, x].
    u8 = np.fromfile(src / "volume.u8", np.uint8).reshape(nz, ny, nx).transpose(2, 1, 0)
    labels = np.fromfile(src / "labels.u8", np.uint8).reshape(nz, ny, nx).transpose(2, 1, 0)
    path = WORK / f"{case_id}.nii"
    nib.save(nib.Nifti1Image(u8_to_hu(u8, meta["huCurve"]), np.diag([*meta["spacing"], 1.0])), str(path))
    t = time.perf_counter()
    out_dir = Path(tempfile.mkdtemp(dir=WORK))
    _pipe([{"image": str(path), "label_prompt": sorted(NAMED)}], output_dir=str(out_dir))
    found = sorted(out_dir.rglob("*.nii.gz"))
    classes = np.rint(np.asanyarray(nib.load(str(found[-1])).dataobj)).astype(np.uint8) if found else None
    for f in found:
        f.unlink()
    print(f"[{case_id}] prepared, class map in {time.perf_counter() - t:.1f} s", flush=True)
    entry = {"path": path, "meta": meta, "labels": labels, "classes": classes}
    _cases[case_id] = entry
    while len(_cases) > KEEP:
        _, old = _cases.popitem(last=False)
        old["path"].unlink(missing_ok=True)
    return entry


def b64(a: np.ndarray) -> str:
    return base64.b64encode(a.tobytes()).decode()


def pack_mask(mask: np.ndarray) -> dict:
    nz = np.argwhere(mask)
    lo, hi = nz.min(0), nz.max(0) + 1
    box = mask[lo[0]:hi[0], lo[1]:hi[1], lo[2]:hi[2]]
    bits = np.packbits(box.ravel(order="F"), bitorder="little")
    return {"bbox": [*map(int, lo), *map(int, hi)], "bits": base64.b64encode(gzip.compress(bits.tobytes(), 6)).decode()}


def surface(mask: np.ndarray, spacing: list[float], origin: list[float]) -> dict | None:
    from skimage import measure

    nz = np.argwhere(mask)
    lo = np.maximum(nz.min(0) - 1, 0)
    hi = nz.max(0) + 2
    sub = np.pad(mask[lo[0]:hi[0], lo[1]:hi[1], lo[2]:hi[2]], 1).astype(np.float32)
    sub = ndimage.gaussian_filter(sub, 0.8)
    if sub.max() < 0.5:
        return None
    verts, faces, _, _ = measure.marching_cubes(sub, 0.5)
    world = (verts - 1 + lo) * np.asarray(spacing) + np.asarray(origin)
    return {"positions": b64(world.astype(np.float32)), "indices": b64(faces.astype(np.uint32).ravel()),
            "vertices": int(len(world))}


@app.on_event("startup")
def startup() -> None:
    global _pipe, _gpu
    t = time.perf_counter()
    _pipe, _gpu = load_model()
    print(f"VISTA-3D loaded in {time.perf_counter() - t:.1f} s on {_gpu}", flush=True)


@app.get("/health")
def health() -> dict:
    return {"ok": _pipe is not None, "gpu": _gpu, "cases": list(_cases)}


@app.post("/segment")
def segment(req: SegmentRequest) -> dict:
    import torch

    t_all = time.perf_counter()
    case = prepare(req.case_id)
    meta, labels = case["meta"], case["labels"]
    i, j, k = req.point
    if not all(0 <= p < n for p, n in zip(req.point, meta["shape"])):
        raise HTTPException(400, "point is outside the volume")

    t = time.perf_counter()
    out_dir = Path(tempfile.mkdtemp(dir=WORK))
    _pipe([{"image": str(case["path"]), "points": [[i, j, k]], "point_labels": [1]}], output_dir=str(out_dir))
    torch.cuda.synchronize()
    seconds = round(time.perf_counter() - t, 2)
    found = sorted(out_dir.rglob("*.nii.gz"))
    if not found:
        raise HTTPException(500, "VISTA-3D wrote no mask")
    pred = np.asanyarray(nib.load(str(found[-1])).dataobj)
    for f in found:
        f.unlink()
    raw = (pred > 0) & (pred < 255)
    # The structure under the finger: the connected piece that holds the point.
    comp, _ = ndimage.label(raw)
    if comp[i, j, k] == 0:
        return {"case_id": req.case_id, "voxels": 0, "seconds": seconds, "gpu": _gpu,
                "total_seconds": round(time.perf_counter() - t_all, 2)}
    mask = comp == comp[i, j, k]

    voxels = int(mask.sum())
    vx_ml = float(np.prod(meta["spacing"])) / 1000.0
    ids, counts = np.unique(labels[mask], return_counts=True)
    guess = None
    names = {lab["id"]: lab for lab in meta["labels"]}
    for lid, c in sorted(zip(ids.tolist(), counts.tolist()), key=lambda x: -x[1]):
        if lid and lid in names and c / voxels >= 0.5:
            guess = {"id": lid, "key": names[lid]["key"], "name": names[lid]["name"], "overlap": round(c / voxels, 3)}
            break
    vista_class = None
    if case["classes"] is not None and case["classes"].shape == mask.shape:
        cids, ccounts = np.unique(case["classes"][mask], return_counts=True)
        best = max(((c, n) for c, n in zip(cids.tolist(), ccounts.tolist()) if c in NAMED), key=lambda x: x[1], default=None)
        if best and best[1] / voxels >= 0.3:
            vista_class = {"id": best[0], "name": NAMED[best[0]], "overlap": round(best[1] / voxels, 3)}
    return {
        "case_id": req.case_id,
        "point": req.point,
        "vista_class": vista_class,
        "voxels": voxels,
        "volume_ml": round(voxels * vx_ml, 1),
        "background_voxels": int((mask & (labels == 0)).sum()),
        "mask": pack_mask(mask),
        "mesh": surface(mask, meta["spacing"], meta.get("origin", [0, 0, 0])),
        "guess": guess,
        "seconds": seconds,
        "gpu": _gpu,
        "total_seconds": round(time.perf_counter() - t_all, 2),
    }
