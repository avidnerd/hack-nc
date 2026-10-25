"""Gallery manifest and assets from the vista3d-full job output.

    python3 vista/gallery.py            # pull assets from the private bucket,
                                        # write public/data/gallery.json and
                                        # gzipped assets to public/data/gallery/

The manifest (committed) carries each case's measured numbers from
metrics/vista_runs.jsonl. The assets (about 20 MB per case raw, gitignored)
are gzipped like the hosted build's; the hosted app reads them from
VITE_GALLERY_URL.
"""

from __future__ import annotations

import gzip
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "data" / "gallery"
MANIFEST = ROOT / "public" / "data" / "gallery.json"
BINARIES = ("volume.u8", "labels.u8", "meshes.bin")


def env() -> dict[str, str]:
    e = dict(os.environ)
    for ln in (ROOT / ".env").read_text().splitlines():
        if "=" in ln and not ln.lstrip().startswith("#"):
            k, v = ln.split("=", 1)
            e.setdefault(k.strip(), v.strip())
    return e


def main() -> int:
    runs = [json.loads(ln) for ln in (ROOT / "metrics" / "vista_runs.jsonl").read_text().splitlines() if ln.strip()]
    runs = [r for r in runs if "error" not in r]
    e = env()
    stage = ROOT / "pipeline" / "out" / "gallery_raw"
    for r in runs:
        subprocess.run(
            ["aws", "s3", "sync", f"s3://{e['NEBIUS_S3_BUCKET']}/out/{r['case']}/assets", str(stage / r["case"]),
             "--endpoint-url", e["NEBIUS_S3_ENDPOINT"], "--only-show-errors"],
            check=True, env=e,
        )

    cases = []
    for r in runs:
        src, dst = stage / r["case"], OUT / r["case"]
        dst.mkdir(parents=True, exist_ok=True)
        for f in src.iterdir():
            if f.name in BINARIES:
                with f.open("rb") as fi, (dst / f"{f.name}.gz").open("wb") as raw, \
                        gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=9, mtime=0) as fo:
                    shutil.copyfileobj(fi, fo)
            else:
                shutil.copyfile(f, dst / f.name)
        meta = json.loads((src / "meta.json").read_text())
        cases.append({
            "id": r["case"],
            "name": meta["name"],
            "organMl": meta["truth"]["organVolumeMl"],
            "tumorMl": meta["truth"]["tumorVolumeMl"],
            "diceLiver": r["dice"]["liver"],
            "diceTumor": r["dice"]["tumor"],
            "vistaS": r["stages"]["segmenting"],
            "gpu": r["gpu"],
        })
    MANIFEST.write_text(json.dumps({"source": "metrics/vista_runs.jsonl", "cases": cases}, indent=1) + "\n")
    mb = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file()) / 1e6
    print(f"{len(cases)} cases -> {MANIFEST.relative_to(ROOT)}; assets {mb:.0f} MB in {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
