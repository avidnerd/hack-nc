"""Scrub+ v2 backend. Deployed as a Nebius Serverless Endpoint (CPU)."""

from __future__ import annotations

from functools import lru_cache

import os
import tempfile

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from openai import OpenAI
from pydantic import BaseModel, Field

from . import agent, config, ground, guard, rules, scans
from .engine import device_rules
from .tools import tool_specs

settings = config.load()
app = FastAPI(title="Scrub+ backend", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_methods=["GET", "POST"],
    allow_headers=["content-type"],
)


# Per-IP requests per minute, and Token Factory dollars per UTC day (0: none).
agent_limit = guard.RateLimiter(int(os.environ.get("AGENT_RPM", "30")))
rules_limit = guard.RateLimiter(int(os.environ.get("RULES_RPM", "3")))
budget = guard.Budget(float(os.environ.get("DAILY_BUDGET_USD", "0")))
# Each upload starts an H100 job: a few per IP per hour, and a cap per day for everyone.
scans_limit = guard.RateLimiter(int(os.environ.get("SCANS_PER_HOUR", "3")), window_s=3600)
scans_daily = guard.RateLimiter(int(os.environ.get("SCANS_PER_DAY", "20")), window_s=86400)
point_limit = guard.RateLimiter(int(os.environ.get("POINT_RPM", "12")))
POINT_URL = os.environ.get("POINT_BASE_URL", "").rstrip("/")
POINT_KEY = os.environ.get("POINT_API_KEY", "")


def _limit(limiter: guard.RateLimiter, request: Request) -> None:
    ip = guard.client_ip(dict(request.headers), request.client.host if request.client else None)
    if not limiter.allow(ip):
        raise HTTPException(429, "rate limited")


@lru_cache(maxsize=1)
def tf_client() -> OpenAI:
    return OpenAI(api_key=settings.tf_api_key, base_url=settings.tf_base_url, max_retries=0)


@lru_cache(maxsize=1)
def nano_client() -> OpenAI | None:
    if not settings.nano_base_url:
        return None
    return OpenAI(api_key=settings.nano_api_key or "none", base_url=settings.nano_base_url, max_retries=0)


class AgentRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    state: dict | None = None
    # Assistant and tool messages already exchanged in this turn (OpenAI format).
    history: list[dict] | None = Field(default=None, max_length=24)


@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "token_factory": bool(settings.tf_api_key),
        "model_super": settings.model_super,
        "nano": bool(settings.nano_base_url),
        "tools": len(tool_specs()),
        "prompt_version": agent.PROMPT_VERSION,
        "scans": scans.job_config().ready,
        "segment_point": bool(POINT_URL),
    }


@app.post("/api/agent")
def run_agent(req: AgentRequest, request: Request) -> dict:
    if not settings.tf_api_key or not settings.model_super:
        raise HTTPException(503, "Token Factory not configured (NEBIUS_TF_API_KEY, NEBIUS_TF_MODEL_SUPER)")
    _limit(agent_limit, request)
    # Over budget, the client falls back to the regex grammar, as on any 503.
    if budget.exhausted():
        raise HTTPException(503, "daily budget reached")
    try:
        nano = nano_client()
        result = agent.route_turn(
            (nano, settings.nano_model, settings.nano_timeout_s) if nano else None,
            (tf_client(), settings.model_super, settings.super_timeout_s),
            req.text, req.state, history=req.history, metrics_dir=settings.metrics_dir,
        )
    except Exception as e:  # network, timeout, provider error: the client falls back to the regex grammar
        agent.log_request(settings, req.text, None, error=type(e).__name__)
        raise HTTPException(502, f"agent failed: {type(e).__name__}") from e
    agent.log_request(settings, req.text, result)
    if result.model == settings.model_super:
        budget.charge(result.prompt_tokens, result.completion_tokens)
    return result.to_json()


@app.get("/api/grounding")
def grounding() -> dict:
    return ground.totals(settings.metrics_dir)


@app.get("/api/rules")
def device_rules_card(device: str, request: Request) -> dict:
    """A device's rule card: the committed one, else a live Tavily + Super lookup (cached to data/device_rules/)."""
    device = device.strip()[:120]
    if not device:
        raise HTTPException(400, "device is required")
    card = device_rules.find(device)
    if card is not None:
        return card
    _limit(rules_limit, request)
    if budget.exhausted():
        raise HTTPException(503, "daily budget reached")
    try:
        card = rules.lookup(device, settings)
    except Exception as e:  # Tavily or Token Factory down: the client keeps the default rules
        raise HTTPException(502, f"rule lookup failed: {type(e).__name__}") from e
    budget.charge(card["usage"]["prompt_tokens"], card["usage"]["completion_tokens"])
    return card


@app.post("/api/scans")
async def upload_scan(request: Request, name: str | None = None) -> dict:
    """Body: one CT as .nii or .nii.gz (raw bytes, at most 300 MB)."""
    if not scans.job_config().ready:
        raise HTTPException(503, "scan service not configured")
    if int(request.headers.get("content-length") or 0) > scans.MAX_BYTES:
        raise HTTPException(413, "scans are capped at 300 MB")
    _limit(scans_limit, request)
    if not scans_daily.allow("all"):
        raise HTTPException(503, "daily scan limit reached")
    with tempfile.TemporaryFile() as body:
        n = 0
        async for chunk in request.stream():
            n += len(chunk)
            if n > scans.MAX_BYTES:
                raise HTTPException(413, "scans are capped at 300 MB")
            body.write(chunk)
        body.seek(0)
        try:
            return await run_in_threadpool(scans.start, body, name)
        except scans.ScanError as e:
            raise HTTPException(e.status, str(e)) from e


@app.get("/api/scans/{scan_id}")
def scan_status(scan_id: str) -> dict:
    try:
        return scans.status(scan_id)
    except scans.ScanError as e:
        raise HTTPException(e.status, str(e)) from e


@app.get("/api/scans/{scan_id}/assets/{name}")
def scan_asset(scan_id: str, name: str) -> StreamingResponse:
    try:
        body, size = scans.asset(scan_id, name)
    except scans.ScanError as e:
        raise HTTPException(e.status, str(e)) from e
    kind = "application/json" if name.endswith(".json") else "application/octet-stream"
    return StreamingResponse(iter(lambda: body.read(1 << 20), b""), media_type=kind, headers={"content-length": str(size)})


class PointRequest(BaseModel):
    case_id: str = Field(pattern=r"^[A-Za-z0-9_\-]{1,64}$")
    point: list[int] = Field(min_length=3, max_length=3)


@app.post("/api/segment-point")
def segment_point(req: PointRequest, request: Request) -> dict:
    """VISTA-3D point prompt on the vista3d-point endpoint (vista/point/server.py)."""
    if not POINT_URL:
        raise HTTPException(503, "segmentation service not configured")
    _limit(point_limit, request)
    import httpx

    try:
        # The first call on a case prepares its volume on the GPU box: allow for it.
        r = httpx.post(f"{POINT_URL}/segment", json=req.model_dump(), timeout=60,
                       headers={"authorization": f"Bearer {POINT_KEY}"} if POINT_KEY else {})
    except httpx.HTTPError as e:  # cold or stopped endpoint: the client says it is warming up
        raise HTTPException(503, f"segmentation service unavailable: {type(e).__name__}") from e
    if r.status_code != 200:
        raise HTTPException(503 if r.status_code >= 500 else r.status_code, f"segmentation service: {r.status_code}")
    return r.json()
