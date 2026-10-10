"""Recompute the renal ostia of an already-published case in place.

    python pipeline/ostia.py aorta

Reads public/data/<case>/{meta.json,labels.u8,centerlines.json} and rewrites
`renalOstia` with run.renal_ostia, so a change to the estimate does not need
the full TotalSegmentator pass again.
"""

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from run import PUBLIC, renal_ostia  # noqa: E402


def main(case: str) -> None:
    d = PUBLIC / case
    meta = json.loads((d / "meta.json").read_text())
    nx, ny, nz = meta["shape"]
    labels = np.fromfile(d / "labels.u8", np.uint8).reshape(nz, ny, nx).transpose(2, 1, 0)
    cl = json.loads((d / "centerlines.json").read_text())
    aorta = cl["vessels"].get("aorta")
    if not aorta:
        print(f"{case}: no aorta centerline")
        return
    cl["renalOstia"] = renal_ostia(
        aorta, {"left": labels == 6, "right": labels == 7}, np.array(meta["spacing"]), np.zeros(3)
    )
    (d / "centerlines.json").write_text(json.dumps(cl))
    print(f"{case}: {cl['renalOstia']}")


if __name__ == "__main__":
    for c in sys.argv[1:]:
        main(c)
