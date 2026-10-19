"""Agent tool schemas, loaded from shared/tools.json, and argument validation."""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from jsonschema import Draft202012Validator

from .config import REPO

TOOLS_PATH = REPO / "shared" / "tools.json"


@lru_cache(maxsize=1)
def tool_specs() -> list[dict[str, Any]]:
    return json.loads(TOOLS_PATH.read_text())["tools"]


@lru_cache(maxsize=1)
def _validators() -> dict[str, Draft202012Validator]:
    return {t["function"]["name"]: Draft202012Validator(t["function"]["parameters"]) for t in tool_specs()}


def validate_call(name: str, raw_args: str | dict[str, Any] | None) -> tuple[dict[str, Any] | None, list[str]]:
    """Parse and validate one tool call. Returns (args, errors); args is None when unusable."""
    v = _validators().get(name)
    if v is None:
        return None, [f"unknown tool {name!r}"]
    if raw_args is None or raw_args == "":
        args: Any = {}
    elif isinstance(raw_args, str):
        try:
            args = json.loads(raw_args)
        except json.JSONDecodeError as e:
            return None, [f"{name}: arguments are not JSON ({e.msg})"]
    else:
        args = raw_args
    if not isinstance(args, dict):
        return None, [f"{name}: arguments must be an object"]
    errors = [f"{name}: {'/'.join(map(str, e.path)) or '(root)'}: {e.message}" for e in v.iter_errors(args)]
    return (args if not errors else None), errors
