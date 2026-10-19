"""Scrub+ v2 backend. Deployed as a Nebius Serverless Endpoint (CPU)."""

from __future__ import annotations

from functools import lru_cache

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from pydantic import BaseModel, Field

from . import agent, config
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


class AgentRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    state: dict | None = None


@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "token_factory": bool(settings.tf_api_key),
        "model_super": settings.model_super,
        "tools": len(tool_specs()),
        "prompt_version": agent.PROMPT_VERSION,
    }


@app.post("/api/agent")
def run_agent(req: AgentRequest) -> dict:
    if not settings.tf_api_key or not settings.model_super:
        raise HTTPException(503, "Token Factory not configured (NEBIUS_TF_API_KEY, NEBIUS_TF_MODEL_SUPER)")
    try:
        result = agent.run_turn(tf_client(), settings.model_super, req.text, req.state, settings.super_timeout_s)
    except Exception as e:  # network, timeout, provider error: the client falls back to the regex grammar
        agent.log_request(settings, req.text, None, error=type(e).__name__)
        raise HTTPException(502, f"agent failed: {type(e).__name__}") from e
    agent.log_request(settings, req.text, result)
    return result.to_json()
