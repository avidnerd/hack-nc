"""Sanity-check a packed case: look for dense planar structures (scanner table,
positioning pads) and print per-slice statistics."""
import json
import sys
from pathlib import Path

import numpy as np

case = sys.argv[1] if len(sys.argv) > 1 else "liver"
root = Path(__file__).resolve().parent.parent / "public" / "data" / case
meta = json.loads((root / "meta.json").read_text())
nx, ny, nz = meta["shape"]

vol = np.fromfile(root / "volume.u8", dtype=np.uint8).reshape(nz, ny, nx)
lab = np.fromfile(root / "labels.u8", dtype=np.uint8).reshape(nz, ny, nx)

curve = np.array(meta["huCurve"], dtype=float)
hu = np.interp(vol.astype(float), curve[:, 0], curve[:, 1])

print(f"{case}: shape(z,y,x)={vol.shape}  u8 range {vol.min()}-{vol.max()}")
print(f"HU range {hu.min():.0f} .. {hu.max():.0f}")
print(f"labels present: {sorted(set(np.unique(lab).tolist()))}")

# Fraction of each axis-slice that is "tissue or denser". A table or a pad
# shows up as a slab that is dense across a whole slice far from the body.
soft = hu > -200
for name, axis in (("z", 0), ("y", 1), ("x", 2)):
    frac = soft.mean(axis=tuple(a for a in range(3) if a != axis))
    hot = np.where(frac > 0.25)[0]
    print(f"\n{name}: dense fraction per slice, {len(frac)} slices")
    print("  " + " ".join(f"{v:.2f}" for v in frac[:: max(1, len(frac) // 24)]))
    if len(hot):
        print(f"  slices over 25% dense: {hot.min()}..{hot.max()}")

# Where is the liver, in voxel coordinates?
for lid in sorted(set(np.unique(lab).tolist()) - {0}):
    idx = np.array(np.nonzero(lab == lid))
    lo, hi = idx.min(1), idx.max(1)
    print(f"label {lid}: z {lo[0]}-{hi[0]}  y {lo[1]}-{hi[1]}  x {lo[2]}-{hi[2]}  "
          f"({int((lab == lid).sum())} vox)")
