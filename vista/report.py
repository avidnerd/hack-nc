"""VISTA-3D results table for docs/RESULTS.md, from metrics/vista_runs.jsonl.

    python3 vista/report.py            # prints the markdown section
"""

from __future__ import annotations

import json
import statistics as st
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def fmt(v: float | None) -> str:
    return "—" if v is None else f"{v:.3f}"


def section() -> str:
    runs = [json.loads(ln) for ln in (ROOT / "metrics" / "vista_runs.jsonl").read_text().splitlines() if ln.strip()]
    rows = []
    for r in runs:
        shape = "×".join(str(s) for s in r["ct_shape"])
        rows.append(
            f"| {r['case'].removeprefix('msd_liver_')} | {shape} @ {r['ct_spacing'][2]} mm | {fmt(r['dice']['liver'])} "
            f"| {fmt(r['dice']['tumor'])} | {r['truth_tumor_ml']} mL ({r['truth_lesions']}) "
            f"| {r['stages']['segmenting']:.1f} s | {r['stages']['total']:.1f} s | {r['gpu_peak_gb']} GB |"
        )
    liver = [r["dice"]["liver"] for r in runs]
    seg = [r["stages"]["segmenting"] for r in runs]
    total = [r["stages"]["total"] for r in runs]
    gpu = runs[0]["gpu"]
    load = runs[0].get("model_load_s")
    return f"""## VISTA-3D on Nebius (full-scan Serverless Job)

Source: `metrics/vista_runs.jsonl`. One {gpu} on Nebius AI Cloud (eu-north1). Model `nvidia/NV-Segment-CT` (VISTA-3D), class prompts for the 8 structures the app plans on. Dice = 2|A∩B| / (|A|+|B|): the overlap between VISTA-3D's mask and the MSD Task03 reference mask, from 0 (none) to 1 (identical). Liver Dice counts tumour as liver on both sides.

| MSD case | CT grid | Liver Dice | Tumour Dice | Reference tumour (lesions) | VISTA-3D | Scan to app assets | GPU peak |
|---|---|---|---|---|---|---|---|
{chr(10).join(rows)}

- Liver Dice: median {st.median(liver):.3f}, range {min(liver):.3f} to {max(liver):.3f} over {len(runs)} scans.
- Tumour Dice follows lesion size. Lesions under about 1 mL are labelled as liver (Dice 0). A case with no reference tumour shows `—`.
- VISTA-3D inference: median {st.median(seg):.1f} s per scan. Scan to app assets (segmentation, masks, crop, resample, centerline, meshes): median {st.median(total):.1f} s per scan. The model loads once per job ({load} s). Job start (provisioning and image pull) is not included: 4 min 41 s from create to running in both measured smoke runs, which is why the gallery is precomputed.
- Caveat: VISTA-3D's training data includes MSD Task03, so these scans may have been seen in training and the Dice scores may be optimistic.
"""


if __name__ == "__main__":
    print(section())
