"""One agent turn against Nemotron 3 Super on Token Factory.

M0 scope: send the request with the tool schemas, return the model's tool calls
validated against shared/tools.json. The browser executes the tools (the engine
lives there); the multi-turn loop, router and ground_check arrive in M1 and M3.
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Protocol

from .config import REPO, Settings
from .tools import tool_specs, validate_call

PROMPT_VERSION = "agent_v1"
SYSTEM_PROMPT = (REPO / "prompts" / f"{PROMPT_VERSION}.md").read_text()


class ChatClient(Protocol):
    """The slice of openai.OpenAI that we use; tests pass a fake."""

    @property
    def chat(self) -> Any: ...


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any] | None
    errors: list[str] = field(default_factory=list)


@dataclass
class AgentResult:
    model: str
    latency_ms: int
    tool_calls: list[ToolCall]
    text: str | None
    valid: bool
    prompt_tokens: int | None
    completion_tokens: int | None
    prompt_version: str = PROMPT_VERSION

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


def run_turn(client: ChatClient, model: str, text: str, state: dict[str, Any] | None, timeout_s: float) -> AgentResult:
    messages: list[dict[str, Any]] = [{"role": "system", "content": SYSTEM_PROMPT}]
    if state:
        messages.append({"role": "system", "content": "Current state (from get_state):\n" + json.dumps(state, separators=(",", ":"))})
    messages.append({"role": "user", "content": text})

    t0 = time.perf_counter()
    resp = client.chat.completions.create(
        model=model,
        messages=messages,
        tools=tool_specs(),
        tool_choice="auto",
        temperature=0,
        max_tokens=512,
        timeout=timeout_s,
    )
    latency_ms = round((time.perf_counter() - t0) * 1000)

    msg = resp.choices[0].message
    calls: list[ToolCall] = []
    for tc in msg.tool_calls or []:
        args, errors = validate_call(tc.function.name, tc.function.arguments)
        calls.append(ToolCall(id=tc.id, name=tc.function.name, arguments=args, errors=errors))
    usage = getattr(resp, "usage", None)
    return AgentResult(
        model=model,
        latency_ms=latency_ms,
        tool_calls=calls,
        text=msg.content,
        valid=all(not c.errors for c in calls),
        prompt_tokens=getattr(usage, "prompt_tokens", None),
        completion_tokens=getattr(usage, "completion_tokens", None),
    )


def log_request(settings: Settings, text: str, result: AgentResult | None, error: str | None = None) -> None:
    settings.metrics_dir.mkdir(parents=True, exist_ok=True)
    row = {
        "ts": time.time(),
        "text": text,
        "model": result.model if result else settings.model_super,
        "latency_ms": result.latency_ms if result else None,
        "prompt_tokens": result.prompt_tokens if result else None,
        "completion_tokens": result.completion_tokens if result else None,
        "tools": [c.name for c in result.tool_calls] if result else [],
        "valid": result.valid if result else False,
        "escalated": False,
        "error": error,
    }
    with (settings.metrics_dir / "agent_requests.jsonl").open("a") as f:
        f.write(json.dumps(row) + "\n")
