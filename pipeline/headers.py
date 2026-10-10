"""Read only the NIfTI headers (cheap - no pixel decompression) to find the
cases worth analysing properly.

Slice thickness dominates how a case looks once it is resampled to isotropic
voxels: a 5 mm acquisition has to be interpolated 3x in z and ends up streaky,
while a sub-2 mm one stays crisp. Filtering on that first cuts the expensive
label analysis down to a handful of candidates.
"""

import json
from pathlib import Path

import nibabel as nib

LAB = Path(__file__).resolve().parent / "raw" / "labelsTr"

rows = []
for f in sorted(LAB.glob("*.nii.gz")):
    try:
        h = nib.load(str(f)).header
        z = h.get_zooms()[:3]
        shape = h.get_data_shape()[:3]
        rows.append(
            {
                "case": f.name.replace(".nii.gz", ""),
                "spacing": [round(float(v), 3) for v in z],
                "shape": [int(v) for v in shape],
                "slice_mm": round(float(z[2]), 3),
                "extent_z_mm": round(float(z[2]) * shape[2], 1),
            }
        )
    except Exception as exc:
        print(f"skip {f.name}: {exc}")

rows.sort(key=lambda r: r["slice_mm"])
Path(__file__).resolve().parent.joinpath("headers.json").write_text(json.dumps(rows, indent=1))

thin = [r for r in rows if r["slice_mm"] <= 1.5]
print(f"{len(rows)} cases; {len(thin)} with slices <= 1.5 mm\n")
print(f"{'case':<12}{'slice':>7}{'in-plane':>10}{'shape':>22}{'z extent':>10}")
for r in rows[:40]:
    print(f"{r['case']:<12}{r['slice_mm']:>7}{r['spacing'][0]:>10}"
          f"{str(r['shape']):>22}{r['extent_z_mm']:>10}")
print(f"\n-> {len(thin)} thin-slice candidates written to headers.json")
