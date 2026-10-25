"""Scrub+ v2 backend. Deployed as a Nebius Serverless Endpoint (CPU)."""

from __future__ import annotations

from functools import lru_cache

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from pydantic import BaseModel, Field

from . import agent, config, ground, rules
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
    }


@app.post("/api/agent")
def run_agent(req: AgentRequest) -> dict:
    if not settings.tf_api_key or not settings.model_super:
        raise HTTPException(503, "Token Factory not configured (NEBIUS_TF_API_KEY, NEBIUS_TF_MODEL_SUPER)")
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
    return result.to_json()


@app.get("/api/grounding")
def grounding() -> dict:
    return ground.totals(settings.metrics_dir)


@app.get("/api/rules")
def device_rules_card(device: str) -> dict:
    """A device's rule card: the committed one, else a live Tavily + Super lookup (cached to data/device_rules/)."""
    device = device.strip()[:120]
    if not device:
        raise HTTPException(400, "device is required")
    card = device_rules.find(device)
    if card is not None:
        return card
    try:
        return rules.lookup(device, settings)
    except Exception as e:  # Tavily or Token Factory down: the client keeps the default rules
        raise HTTPException(502, f"rule lookup failed: {type(e).__name__}") from e
