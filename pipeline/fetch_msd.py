"""Fetch selected cases from the MSD Task03_Liver tar without downloading all 28.9 GB.

The archive is a plain (uncompressed) tar served from S3 with HTTP Range support.
A tar has no index, but every member is preceded by a 512-byte header that states
its name and size, so the member list can be walked with one small range request
per entry:  next_header = cur + 512 + ceil(size/512)*512.

Walking the ~400 entries costs ~200 KB.  We then range-download only the members
we actually want.  Label volumes are almost entirely zeros and gzip to ~1-2 MB
each, so we can afford to pull every label, inspect the tumours, and only then
spend ~40 MB on the single image volume we picked.
"""

from __future__ import annotations

import json
import math
import os
import sys
import urllib.request
from pathlib import Path

URL = "https://msd-for-monai.s3-us-west-2.amazonaws.com/Task03_Liver.tar"
HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
INDEX = HERE / "tar_index.json"
BLOCK = 512


def http_range(url: str, start: int, length: int) -> bytes:
    req = urllib.request.Request(url, headers={"Range": f"bytes={start}-{start + length - 1}"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def parse_header(block: bytes) -> tuple[str, int, str] | None:
    """Return (name, size, typeflag) or None for an end-of-archive block."""
    if len(block) < BLOCK or block[:BLOCK] == b"\0" * BLOCK:
        return None
    name = block[0:100].split(b"\0", 1)[0].decode("utf-8", "replace")
    raw_size = block[124:136].split(b"\0", 1)[0].strip()
    size = int(raw_size, 8) if raw_size else 0
    typeflag = chr(block[156]) if block[156] else "0"
    # A ustar "prefix" field can hold a long leading path component.
    prefix = block[345:500].split(b"\0", 1)[0].decode("utf-8", "replace")
    if prefix:
        name = f"{prefix}/{name}"
    return name, size, typeflag


def build_index(url: str) -> list[dict]:
    """Walk every tar header, recording each member's data offset and size."""
    entries: list[dict] = []
    offset = 0
    misses = 0
    while True:
        block = http_range(url, offset, BLOCK)
        parsed = parse_header(block)
        if parsed is None:
            # Two consecutive zero blocks terminate a tar; tolerate one.
            misses += 1
            if misses >= 2:
                break
            offset += BLOCK
            continue
        misses = 0
        name, size, typeflag = parsed
        if typeflag in ("0", "\0"):
            entries.append({"name": name, "offset": offset + BLOCK, "size": size})
        offset += BLOCK + math.ceil(size / BLOCK) * BLOCK
        if len(entries) % 50 == 0 and entries:
            print(f"  ...{len(entries)} members indexed", flush=True)
    return entries


def load_index(url: str) -> list[dict]:
    if INDEX.exists():
        return json.loads(INDEX.read_text())
    print("Walking tar index over HTTP range requests (one-time, ~400 requests)...")
    entries = build_index(url)
    INDEX.write_text(json.dumps(entries, indent=1))
    print(f"Indexed {len(entries)} members -> {INDEX}")
    return entries


def is_real(name: str) -> bool:
    """Skip macOS AppleDouble sidecars (`._foo`) that pollute this archive."""
    return "/._" not in name and not os.path.basename(name).startswith("._")


def fetch(url: str, entry: dict, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size == entry["size"]:
        return dest
    data = http_range(url, entry["offset"], entry["size"])
    if len(data) != entry["size"]:
        raise RuntimeError(f"short read for {entry['name']}: {len(data)} != {entry['size']}")
    dest.write_bytes(data)
    return dest


def main() -> int:
    want = sys.argv[1] if len(sys.argv) > 1 else "labels"
    entries = load_index(URL)
    by_name = {e["name"]: e for e in entries if is_real(e["name"])}

    if want == "labels":
        targets = sorted(n for n in by_name if "/labelsTr/" in n and n.endswith(".nii.gz"))
        print(f"Fetching {len(targets)} label volumes "
              f"({sum(by_name[n]['size'] for n in targets) / 1e6:.0f} MB)")
    else:
        # want is a case id like "liver_17"; grab its image and label volumes.
        targets = [n for n in by_name
                   if n.endswith(f"/imagesTr/{want}.nii.gz") or n.endswith(f"/labelsTr/{want}.nii.gz")]
        if not targets:
            print(f"no members for {want!r}", file=sys.stderr)
            return 1
        print(f"Fetching {len(targets)} members ({sum(by_name[n]['size'] for n in targets) / 1e6:.0f} MB)")

    for i, name in enumerate(targets, 1):
        dest = RAW / Path(name).parent.name / Path(name).name
        fetch(URL, by_name[name], dest)
        print(f"  [{i}/{len(targets)}] {dest.name}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
