"""Runtime configuration, read once from the environment (and ../.env in dev).

Model ids are never hardcoded: they come from env vars filled with the ids
returned by Token Factory's GET /v1/models (see docs/PLATFORM_NOTES.md).
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

REPO = Path(__file__).resolve().parents[2]
load_dotenv(REPO / ".env")


@dataclass(frozen=True)
class Settings:
    tf_api_key: str | None
    tf_base_url: str
    model_super: str | None
    super_timeout_s: float
    nano_base_url: str | None
    nano_api_key: str | None
    nano_model: str
    nano_timeout_s: float
    metrics_dir: Path
    allowed_origins: list[str]


def load() -> Settings:
    return Settings(
        tf_api_key=os.environ.get("NEBIUS_TF_API_KEY") or None,
        # DECISION: base URL is an env var with the documented default, so a
        # rename of the Token Factory host is a config change, not a code change.
        tf_base_url=os.environ.get("NEBIUS_TF_BASE_URL", "https://api.tokenfactory.nebius.com/v1/"),
        model_super=os.environ.get("NEBIUS_TF_MODEL_SUPER") or None,
        super_timeout_s=float(os.environ.get("SUPER_TIMEOUT_S", "6.0")),
        # The scrub-nano endpoint (distill/serve/launch.sh). Unset: Super only.
        nano_base_url=os.environ.get("NANO_BASE_URL") or None,
        nano_api_key=os.environ.get("NANO_API_KEY") or None,
        nano_model=os.environ.get("NANO_ROUTER_MODEL", "scrub"),
        nano_timeout_s=float(os.environ.get("NANO_TIMEOUT_S", "1.5")),
        metrics_dir=Path(os.environ.get("METRICS_DIR", str(REPO / "metrics"))),
        allowed_origins=[o for o in re.split(r"[,\s]+", os.environ.get("ALLOWED_ORIGINS", "http://localhost:5173")) if o],
    )
