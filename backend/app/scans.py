"""Uploaded scans: a CT goes to the bucket, a vista3d-full Serverless Job
segments it with VISTA-3D, and the app opens the planned case.

    start(file)   -> bucket raw/uploads/<id>.nii.gz, batch json, job create
    status(id)    -> UPLOADED (job queued or loading the model), SEGMENTING,
                     CENTERLINE, READY, or FAILED, with the job's own state
    asset(id, f)  -> one of the case files the app loads, from the bucket

The job (vista/job/vista_job.py) writes out/<case>/status.json as it moves
through its stages, so the stages shown are the job's real ones.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from dataclasses import dataclass
from functools import lru_cache
from typing import BinaryIO

MAX_BYTES = 300 * 1024 * 1024
ASSETS = {"meta.json", "volume.u8", "labels.u8", "centerlines.json", "meshes.json", "meshes.bin"}
_ID = re.compile(r"^upload_[0-9a-f]{12}$")


class ScanError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class JobConfig:
    project: str | None
    bucket: str | None
    bucket_id: str | None
    platform: str
    preset: str
    image: str
    profile: str | None

    @property
    def ready(self) -> bool:
        return bool(self.project and self.bucket and self.bucket_id and os.environ.get("AWS_ACCESS_KEY_ID"))


def job_config() -> JobConfig:
    return JobConfig(
        project=os.environ.get("VISTA_JOB_PROJECT_ID") or None,
        bucket=os.environ.get("NEBIUS_S3_BUCKET") or None,
        bucket_id=os.environ.get("NEBIUS_S3_BUCKET_ID") or None,
        platform=os.environ.get("VISTA_JOB_PLATFORM", "gpu-h100-sxm"),
        preset=os.environ.get("VISTA_JOB_PRESET", "1gpu-16vcpu-200gb"),
        image=os.environ.get("VISTA_JOB_IMAGE", "pytorch/pytorch:2.4.0-cuda12.4-cudnn9-runtime"),
        profile=os.environ.get("NEBIUS_PROFILE") or None,
    )


@lru_cache(maxsize=1)
def s3():
    import boto3

    return boto3.client("s3", endpoint_url=os.environ.get("NEBIUS_S3_ENDPOINT"),
                        region_name=os.environ.get("AWS_DEFAULT_REGION"))


def valid_id(scan_id: str) -> str:
    if not _ID.match(scan_id):
        raise ScanError(404, "no such scan")
    return scan_id


def _nebius(cfg: JobConfig, *args: str) -> dict:
    cmd = ["nebius", *(["--profile", cfg.profile] if cfg.profile else []), *args, "--format", "json"]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise ScanError(502, "job service: " + (out.stderr.strip().splitlines() or ["failed"])[-1][:200])
    return json.loads(out.stdout or "{}")


def save_upload(src: BinaryIO, dst: BinaryIO) -> int:
    """Copy the request body to disk, refusing anything over MAX_BYTES or
    anything that is not a (gzipped) NIfTI."""
    head = src.read(352)
    gz = head[:2] == b"\x1f\x8b"
    # An uncompressed NIfTI-1 header starts with sizeof_hdr = 348.
    if not gz and int.from_bytes(head[:4], "little") != 348:
        raise ScanError(415, "send one .nii or .nii.gz CT")
    dst.write(head)
    n = len(head)
    while chunk := src.read(1 << 20):
        n += len(chunk)
        if n > MAX_BYTES:
            raise ScanError(413, "scans are capped at 300 MB")
        dst.write(chunk)
    return n


def start(src: BinaryIO, name: str | None = None) -> dict:
    cfg = job_config()
    if not cfg.ready:
        raise ScanError(503, "scan service not configured")
    scan_id = f"upload_{uuid.uuid4().hex[:12]}"
    with tempfile.NamedTemporaryFile(suffix=".nii.gz") as tmp:
        size = save_upload(src, tmp)
        tmp.flush()
        # The job reads by suffix; a raw .nii is gzipped so one name fits both.
        tmp.seek(0)
        if tmp.read(2) != b"\x1f\x8b":
            import gzip

            tmp.seek(0)
            with tempfile.NamedTemporaryFile(suffix=".nii.gz") as gz:
                with gzip.GzipFile(fileobj=gz, mode="wb", compresslevel=1) as zf:
                    shutil.copyfileobj(tmp, zf)
                gz.flush()
                s3().upload_file(gz.name, cfg.bucket, f"raw/uploads/{scan_id}.nii.gz")
        else:
            s3().upload_file(tmp.name, cfg.bucket, f"raw/uploads/{scan_id}.nii.gz")
    batch = [{"ct": f"/data/raw/uploads/{scan_id}.nii.gz", "case": scan_id, "name": (name or "Uploaded scan")[:80]}]
    s3().put_object(Bucket=cfg.bucket, Key=f"code/batches/{scan_id}.json", Body=json.dumps(batch).encode())
    job = _nebius(
        cfg, "ai", "job", "create", "--parent-id", cfg.project, "--name", f"vista3d-{scan_id.replace('_', '-')}",
        "--image", cfg.image, "--container-command", "bash",
        "--args", f"/data/code/vista/job/run.sh --batch /data/code/batches/{scan_id}.json",
        "--volume", f"{cfg.bucket_id}:/data:rw", "--platform", cfg.platform, "--preset", cfg.preset,
        "--disk-size", "100Gi", "--shm-size", "16Gi", "--timeout", "1h", "--restart-policy", "never", "--async",
    )
    job_id = job.get("metadata", {}).get("id") or job.get("resource_id") or job.get("metadata", {}).get("resource_id")
    record = {"id": scan_id, "job_id": job_id, "bytes": size, "created": time.time()}
    s3().put_object(Bucket=cfg.bucket, Key=f"out/{scan_id}/job.json", Body=json.dumps(record).encode())
    return {"id": scan_id, "stage": "UPLOADED", "bytes": size, "job_id": job_id}


def _get_json(key: str) -> dict | None:
    cfg = job_config()
    try:
        return json.loads(s3().get_object(Bucket=cfg.bucket, Key=key)["Body"].read())
    except s3().exceptions.NoSuchKey:
        return None


# Job states are asked for at most every few seconds per scan.
_job_cache: dict[str, tuple[float, dict]] = {}


def _job_state(job_id: str) -> dict:
    hit = _job_cache.get(job_id)
    if hit and time.time() - hit[0] < 5:
        return hit[1]
    st = _nebius(job_config(), "ai", "job", "get", job_id).get("status", {})
    _job_cache[job_id] = (time.time(), st)
    return st


def status(scan_id: str) -> dict:
    scan_id = valid_id(scan_id)
    rec = _get_json(f"out/{scan_id}/job.json")
    if rec is None:
        raise ScanError(404, "no such scan")
    elapsed = round(time.time() - rec["created"], 1)
    st = _get_json(f"out/{scan_id}/status.json")
    job = _job_state(rec["job_id"]) if rec.get("job_id") and (st is None or st.get("stage") != "READY") else {}
    job_state = job.get("state")
    out = {"id": scan_id, "elapsed_s": elapsed, "job_state": job_state, "stages": (st or {}).get("stages", {})}
    if st and st.get("stage") == "READY":
        return {**out, "stage": "READY", "gpu": st.get("gpu")}
    run = _get_json(f"out/{scan_id}/vista_run.json")
    if (run and run.get("error")) or job_state in ("FAILED", "CANCELLED", "ERROR"):
        detail = (run or {}).get("error") or (job.get("state_details") or {}).get("message") or "job failed"
        return {**out, "stage": "FAILED", "error": str(detail)[:300]}
    if job_state == "COMPLETED" and not st:
        return {**out, "stage": "FAILED", "error": "job finished without output"}
    return {**out, "stage": (st or {}).get("stage") or "UPLOADED"}


def asset(scan_id: str, name: str):
    scan_id = valid_id(scan_id)
    if name not in ASSETS:
        raise ScanError(404, "no such file")
    cfg = job_config()
    try:
        obj = s3().get_object(Bucket=cfg.bucket, Key=f"out/{scan_id}/assets/{name}")
    except s3().exceptions.NoSuchKey:
        raise ScanError(404, "not ready") from None
    return obj["Body"], obj["ContentLength"]
