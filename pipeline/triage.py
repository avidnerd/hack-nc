"""Fast first pass over the label volumes: no distance transforms, just
component statistics, so a candidate case can be chosen in seconds."""
import json, sys
from pathlib import Path
import nibabel as nib, numpy as np
from scipy import ndimage

LAB = Path(__file__).resolve().parent / "raw" / "labelsTr"
rows = []
files = sorted(LAB.glob("*.nii.gz"))
for i, f in enumerate(files, 1):
    try:
        img = nib.load(str(f))
        sp = np.abs(np.asarray(img.header.get_zooms()[:3], float))
        d = np.asanyarray(img.dataobj).astype(np.uint8)
        liver, tumor = d >= 1, d == 2
        nl, nt = int(liver.sum()), int(tumor.sum())
        if nl == 0 or nt == 0:
            continue
        vml = float(np.prod(sp)) / 1000.0
        comp, n = ndimage.label(tumor)
        sizes = ndimage.sum(tumor, comp, range(1, n + 1))
        big = float(sizes.max())
        sig = int((sizes > 0.05 * big).sum())
        diam = 2.0 * ((3.0 * big * np.prod(sp)) / (4 * np.pi)) ** (1 / 3)
        lc = np.array(ndimage.center_of_mass(liver))
        tc = np.array(ndimage.center_of_mass(comp == int(sizes.argmax()) + 1))
        idx = np.array(np.nonzero(liver))
        ext = (idx.max(1) - idx.min(1)) / 2.0
        ext[ext == 0] = 1
        periph = float(np.linalg.norm((tc - lc) / ext))
        rows.append(dict(case=f.name.replace(".nii.gz", ""), shape=[int(x) for x in d.shape],
                         spacing=[round(float(s), 3) for s in sp],
                         liver_ml=round(nl * vml, 1), tumor_ml=round(nt * vml, 2),
                         diam=round(diam, 1), lesions=sig, periph=round(periph, 3),
                         frac=round(nt / nl, 4)))
    except Exception as e:
        print("skip", f.name, e, file=sys.stderr)
    if i % 25 == 0:
        print(f"...{i}/{len(files)}", flush=True)

# Single compact lesion, 30-55 mm across, well off-centre, sane liver volume.
def score(r):
    s = -abs(r["diam"] - 42) * 1.2 - (r["lesions"] - 1) * 40 + r["periph"] * 45
    if r["diam"] < 25: s -= 200
    if r["frac"] > 0.10: s -= 200
    if not (900 <= r["liver_ml"] <= 2600): s -= 120
    return round(s, 1)

for r in rows:
    r["score"] = score(r)
rows.sort(key=lambda r: -r["score"])
Path(__file__).resolve().parent.joinpath("triage.json").write_text(json.dumps(rows, indent=1))
print(f"\n{'case':<12}{'score':>7}{'diam':>7}{'les':>5}{'periph':>8}{'liverML':>9}{'frac':>7}  shape")
for r in rows[:18]:
    print(f"{r['case']:<12}{r['score']:>7}{r['diam']:>7}{r['lesions']:>5}{r['periph']:>8}"
          f"{r['liver_ml']:>9}{r['frac']:>7}  {r['shape']}")
