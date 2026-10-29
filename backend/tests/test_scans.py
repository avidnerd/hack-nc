import gzip
import io
import json

import pytest
from fastapi.testclient import TestClient

from app import guard, main, scans


class FakeS3:
    class exceptions:
        class NoSuchKey(Exception):
            pass

    def __init__(self):
        self.objects: dict[str, bytes] = {}

    def upload_file(self, path, bucket, key):
        self.objects[key] = open(path, "rb").read()

    def put_object(self, Bucket, Key, Body):
        self.objects[Key] = Body

    def get_object(self, Bucket, Key):
        if Key not in self.objects:
            raise self.exceptions.NoSuchKey(Key)
        b = self.objects[Key]
        return {"Body": io.BytesIO(b), "ContentLength": len(b)}


@pytest.fixture
def env(monkeypatch):
    for k, v in {"VISTA_JOB_PROJECT_ID": "project-x", "NEBIUS_S3_BUCKET": "b", "NEBIUS_S3_BUCKET_ID": "bucket-x",
                 "AWS_ACCESS_KEY_ID": "k"}.items():
        monkeypatch.setenv(k, v)
    fake = FakeS3()
    monkeypatch.setattr(scans, "s3", lambda: fake)
    calls = []
    states = {"state": "RUNNING"}

    def nebius(cfg, *args):
        calls.append(args)
        if args[:3] == ("ai", "job", "create"):
            return {"metadata": {"id": "aijob-1"}}
        return {"status": dict(states)}

    monkeypatch.setattr(scans, "_nebius", nebius)
    scans._job_cache.clear()
    return fake, calls, states


NIFTI = (348).to_bytes(4, "little") + bytes(400)


def test_start_uploads_gzipped_ct_and_creates_the_job(env):
    fake, calls, _ = env
    r = scans.start(io.BytesIO(NIFTI), "My CT")
    sid = r["id"]
    assert scans._ID.match(sid) and r["job_id"] == "aijob-1" and r["stage"] == "UPLOADED"
    assert gzip.decompress(fake.objects[f"raw/uploads/{sid}.nii.gz"]) == NIFTI  # raw .nii is gzipped
    assert json.loads(fake.objects[f"code/batches/{sid}.json"])[0]["case"] == sid
    args = calls[0]
    assert "--volume" in args and "bucket-x:/data:rw" in args
    assert f"/data/code/vista/job/run.sh --batch /data/code/batches/{sid}.json" in args


def test_save_upload_rejects_non_nifti_and_oversize(monkeypatch):
    with pytest.raises(scans.ScanError) as e:
        scans.save_upload(io.BytesIO(b"hello world" * 40), io.BytesIO())
    assert e.value.status == 415
    monkeypatch.setattr(scans, "MAX_BYTES", 500)
    with pytest.raises(scans.ScanError) as e:
        scans.save_upload(io.BytesIO(b"\x1f\x8b" + bytes(2000)), io.BytesIO())
    assert e.value.status == 413


def test_status_follows_the_job_through_its_stages(env):
    fake, _, states = env
    sid = scans.start(io.BytesIO(NIFTI))["id"]
    assert scans.status(sid)["stage"] == "UPLOADED"  # job running, no status.json yet
    fake.objects[f"out/{sid}/status.json"] = json.dumps({"stage": "SEGMENTING"}).encode()
    assert scans.status(sid)["stage"] == "SEGMENTING"
    fake.objects[f"out/{sid}/status.json"] = json.dumps({"stage": "READY", "stages": {"segmenting": 5.1}, "gpu": "H100"}).encode()
    s = scans.status(sid)
    assert s["stage"] == "READY" and s["stages"]["segmenting"] == 5.1
    with pytest.raises(scans.ScanError):
        scans.status("../etc/passwd")


def test_status_reports_a_failed_job(env):
    fake, _, states = env
    sid = scans.start(io.BytesIO(NIFTI))["id"]
    states.update(state="FAILED", state_details={"message": "Container exited with non-zero exit code."})
    scans._job_cache.clear()
    s = scans.status(sid)
    assert s["stage"] == "FAILED" and "non-zero" in s["error"]


def test_assets_are_whitelisted(env):
    fake, _, _ = env
    fake.objects["out/upload_0123456789ab/assets/meta.json"] = b"{}"
    body, n = scans.asset("upload_0123456789ab", "meta.json")
    assert body.read() == b"{}" and n == 2
    with pytest.raises(scans.ScanError):
        scans.asset("upload_0123456789ab", "pipeline.log")


def test_upload_endpoint_is_rate_limited(env, monkeypatch):
    monkeypatch.setattr(main, "scans_limit", guard.RateLimiter(1, window_s=3600))
    c = TestClient(main.app)
    hdr = {"content-type": "application/octet-stream"}
    assert c.post("/api/scans", content=NIFTI, headers=hdr).status_code == 200
    assert c.post("/api/scans", content=NIFTI, headers=hdr).status_code == 429
    sid = "upload_0123456789ab"
    env[0].objects[f"out/{sid}/assets/meta.json"] = b'{"shape":[1,1,1]}'
    r = c.get(f"/api/scans/{sid}/assets/meta.json")
    assert r.status_code == 200 and r.json()["shape"] == [1, 1, 1]
