"""VISTA-3D full-scan job (CLAUDE.md section 6.1). Runs on a Nebius Serverless Job.

    python vista/job/vista_job.py --ct /data/raw/imagesTr/liver_24.nii.gz \
        --case msd_liver_24 --name "Liver - MSD Task03 case 24" \
        [--truth /data/raw/labelsTr/liver_24.nii.gz] --out /data/out

Stages (each timed into <out>/<case>/vista_run.json):
    SEGMENTING  NV-Segment-CT (VISTA-3D) with class prompts for the structures
                the app plans on: liver, hepatic tumour, hepatic vessels, IVC,
                portal vein, aorta, both kidneys
    CENTERLINE  pipeline/run.py on VISTA's masks: crop, resample, pack labels,
                aorta centerline, meshes; the same asset format the app loads
    READY       assets copied to <out>/<case>/
With --truth (an MSD label volume), Dice for liver and tumour is added.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import nibabel as nib
import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]

# VISTA-3D class ids, checked against NV-Segment-CT metadata.json on 2026-10-22.
# Keys are the TotalSegmentator mask names pipeline/run.py reads.
VISTA_IDS = {
    "liver": 1,
    "hepatic_tumor": 26,
    "liver_vessels": 25,
    "inferior_vena_cava": 7,
    "portal_vein_and_splenic_vein": 17,
    "aorta": 6,
    "kidney_left": 14,
    "kidney_right": 5,
}


def put(src: Path, dst: Path) -> None:
    """Copy bytes only: the bucket mount refuses chmod/utime, so shutil.copy
    and copytree (which copy permissions) fail on it with EPERM."""
    if src.is_dir():
        dst.mkdir(parents=True, exist_ok=True)
        for f in src.iterdir():
            put(f, dst / f.name)
    else:
        shutil.copyfile(src, dst)


def dice(a: np.ndarray, b: np.ndarray) -> float | None:
    """Overlap of two masks, 2|A and B| / (|A| + |B|), from 0 to 1."""
    s = int(a.sum()) + int(b.sum())
    return None if s == 0 else round(2.0 * int((a & b).sum()) / s, 4)


def load_model(model_dir: Path):
    import torch

    sys.path.insert(0, str(model_dir))
    from hugging_face_pipeline import HuggingFacePipelineHelper  # NV-Segment-CT repo code

    return HuggingFacePipelineHelper("vista3d").init_pipeline(
        str(model_dir / "vista3d_pretrained_model"), device=torch.device("cuda:0")
    )


def segment(pipe, ct: Path, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    pipe([{"image": str(ct), "label_prompt": list(VISTA_IDS.values())}], output_dir=str(out_dir))
    found = sorted(out_dir.rglob("*.nii.gz"), key=lambda p: p.stat().st_mtime)
    if not found:
        raise RuntimeError(f"VISTA-3D wrote no label map under {out_dir}")
    return found[-1]


def split_masks(label_map: Path, seg_dir: Path) -> tuple[Path, dict[str, int]]:
    """VISTA's label map -> one mask file per structure (TotalSegmentator names)
    plus an MSD-style volume (1 liver, 2 tumour) for run.py's --labels."""
    img = nib.load(str(label_map))
    lab = np.rint(np.asanyarray(img.dataobj)).astype(np.int16)
    seg_dir.mkdir(parents=True, exist_ok=True)
    counts = {}
    for name, vid in VISTA_IDS.items():
        m = lab == vid
        counts[name] = int(m.sum())
        if name in ("liver", "hepatic_tumor"):
            continue
        nib.save(nib.Nifti1Image(m.astype(np.uint8), img.affine), str(seg_dir / f"{name}.nii.gz"))
    msd = np.zeros(lab.shape, np.uint8)
    msd[lab == VISTA_IDS["liver"]] = 1
    msd[lab == VISTA_IDS["hepatic_tumor"]] = 2
    msd_path = seg_dir / "liver_tumor_msd.nii.gz"
    nib.save(nib.Nifti1Image(msd, img.affine), str(msd_path))
    return msd_path, counts


def process(pipe, ct_src: Path, case: str, name: str | None, truth: Path | None, out: Path, gpu: str) -> dict:
    import torch

    t_all = time.perf_counter()
    run: dict = {"case": case, "ct": ct_src.name, "gpu": gpu, "stages": {}}
    case_out = out / case
    case_out.mkdir(parents=True, exist_ok=True)

    def status(now: str) -> None:
        # The stage the job is in now; /api/scans shows it as the progress stage.
        (case_out / "status.json").write_text(json.dumps({"stage": now, **run}))

    def stage(label: str, t0: float, now: str) -> None:
        run["stages"][label] = round(time.perf_counter() - t0, 2)
        status(now)
        print(f"[{case}] {label} {run['stages'][label]} s", flush=True)

    status("SEGMENTING")

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        # Inputs are copied off the bucket mount first: nibabel seeks a lot.
        ct = tmp / ct_src.name
        shutil.copy(ct_src, ct)

        t = time.perf_counter()
        torch.cuda.reset_peak_memory_stats()
        label_map = segment(pipe, ct, tmp / "vista")
        torch.cuda.synchronize()
        run["gpu_peak_gb"] = round(torch.cuda.max_memory_allocated() / 1e9, 2)
        stage("segmenting", t, "CENTERLINE")

        msd_path, counts = split_masks(label_map, tmp / "seg")
        run["voxels"] = counts
        put(label_map, case_out / "vista_labels.nii.gz")

        if truth:
            gt = np.asanyarray(nib.load(str(truth)).dataobj).astype(np.uint8)
            pr = np.asanyarray(nib.load(str(msd_path)).dataobj).astype(np.uint8)
            if gt.shape == pr.shape:
                # Liver Dice counts the tumour as liver on both sides (MSD convention).
                run["dice"] = {"liver": dice(gt >= 1, pr >= 1), "tumor": dice(gt == 2, pr == 2)}
            else:
                run["dice_error"] = f"shape {pr.shape} != truth {gt.shape}"
            print(f"[{case}] dice {run.get('dice') or run.get('dice_error')}", flush=True)

        # pipeline/run.py writes into <repo>/public/data/<case>; give it a scratch repo.
        t = time.perf_counter()
        work = tmp / "repo"
        shutil.copytree(REPO / "pipeline", work / "pipeline", ignore=shutil.ignore_patterns("raw", "out", "*.json"))
        cmd = [sys.executable, str(work / "pipeline" / "run.py"), case, "--kind", "liver",
               "--ct", str(ct), "--labels", str(msd_path), "--seg", str(tmp / "seg")]
        if name:
            cmd += ["--name", name]
        log = subprocess.run(cmd, capture_output=True, text=True)
        (case_out / "pipeline.log").write_text(log.stdout + log.stderr)
        if log.returncode != 0:
            run["error"] = "pipeline failed: " + (log.stderr.strip().splitlines() or ["?"])[-1][:300]
            (case_out / "vista_run.json").write_text(json.dumps(run, indent=1))
            print(log.stdout[-2000:], log.stderr[-2000:], flush=True)
            return run
        stage("centerline", t, "CENTERLINE")

        dest = case_out / "assets"
        put(work / "public" / "data" / case, dest)
        run["volumes_ml"] = json.loads((dest / "meta.json").read_text()).get("truth")

    run["stages"]["total"] = round(time.perf_counter() - t_all, 2)
    (case_out / "vista_run.json").write_text(json.dumps(run, indent=1))
    (case_out / "status.json").write_text(json.dumps({"stage": "READY", **run}))
    print(json.dumps(run), flush=True)
    return run


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ct", type=Path)
    ap.add_argument("--case")
    ap.add_argument("--name", default=None)
    ap.add_argument("--truth", type=Path, default=None)
    ap.add_argument("--batch", type=Path, help="JSON list of {ct, case, name?, truth?}; the model loads once")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--model-dir", type=Path, default=Path(os.environ.get("VISTA_MODEL_DIR", "/root/NV-Segment-CT")))
    args = ap.parse_args()

    import torch

    jobs = json.loads(args.batch.read_text()) if args.batch else [{"ct": str(args.ct), "case": args.case, "name": args.name, "truth": str(args.truth) if args.truth else None}]
    gpu = torch.cuda.get_device_name(0)

    t = time.perf_counter()
    if not (args.model_dir / "vista3d_pretrained_model" / "model.safetensors").exists():
        from huggingface_hub import snapshot_download

        # DECISION: weights go to the container's local disk. The bucket mount
        # does not allow the rename the HF downloader does (EPERM). Only the
        # safetensors checkpoint is fetched, not the two .pt copies.
        snapshot_download("nvidia/NV-Segment-CT", local_dir=str(args.model_dir), token=os.environ.get("HF_TOKEN"),
                          allow_patterns=["*.py", "*.json", "scripts/*", "vista3d_pretrained_model/model.safetensors"])
    pipe = load_model(args.model_dir)
    model_load_s = round(time.perf_counter() - t, 2)
    print(f"model loaded in {model_load_s} s on {gpu}", flush=True)

    runs = []
    for j in jobs:
        try:
            r = process(pipe, Path(j["ct"]), j["case"], j.get("name"), Path(j["truth"]) if j.get("truth") else None, args.out, gpu)
        except Exception as e:  # one bad scan must not lose the batch
            r = {"case": j["case"], "error": f"{type(e).__name__}: {e}"[:400]}
            print(json.dumps(r), flush=True)
        r["model_load_s"] = model_load_s
        runs.append(r)
    # One file per job: the bucket mount does not support appending.
    with (args.out / f"vista_runs_{int(time.time())}.jsonl").open("w") as f:
        for r in runs:
            f.write(json.dumps({"ts": time.time(), **r}) + "\n")
    return 0 if all("error" not in r for r in runs) else 1


if __name__ == "__main__":
    raise SystemExit(main())
