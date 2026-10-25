"""One agent turn against Nemotron 3 Super on Token Factory.

One call = one round. The browser (or the Python engine, for eval and data
generation) executes the returned tool calls and sends the results back in
`history`; the round with no tool calls is the final one, and its text goes
through ground_check (ground.py) before anyone sees it:

    pass            -> returned as is
    fail            -> logged, regenerated once with the allowed numbers listed
    fail again      -> replaced by a template sentence built from the tool results

route_turn is the router (CLAUDE.md section 4.3): our Nano-LoRA endpoint
first, Nemotron 3 Super when Nano is unconfigured, fails, times out, returns
an invalid call, or plans more than two calls in one round.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Protocol

from . import ground
from .config import REPO, Settings
from .tools import tool_specs, validate_call

PROMPT_VERSION = "agent_v1"
SYSTEM_PROMPT = (REPO / "prompts" / f"{PROMPT_VERSION}.md").read_text()

# Served model names on the scrub-nano endpoint (distill/serve/launch.sh).
NANO_BASE_NAME = os.environ.get("NANO_BASE_NAME", "base")
NANO_LORA_NAME = os.environ.get("NANO_LORA_NAME", "scrub")


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
    done: bool = False
    assistant_message: dict[str, Any] | None = None
    escalated: bool = False
    escalation_reason: str | None = None
    grounding: dict[str, Any] | None = None

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


def build_messages(
    text: str, state: dict[str, Any] | None, history: list[dict[str, Any]] | None, model: str | None = None
) -> list[dict[str, Any]]:
    # DECISION: one system message. Nemotron Nano's chat template renders only
    # messages[0] as system and silently drops any later system message, so
    # the state rides in the first one for every model.
    system = SYSTEM_PROMPT
    if state:
        system += "\n\nCurrent state (from get_state):\n" + json.dumps(state, separators=(",", ":"))
    if model in (NANO_BASE_NAME, NANO_LORA_NAME):
        # Nano 9B v2 reasons unless told not to; the LoRA was trained this way
        # (distill/job/train.py) and the agent runs without a reasoning trace.
        system = system.rstrip() + "\n/no_think"
    messages: list[dict[str, Any]] = [{"role": "system", "content": system}, {"role": "user", "content": text}]
    messages.extend(history or [])
    return messages


def tool_results_in(history: list[dict[str, Any]] | None) -> list[tuple[str, Any]]:
    """(tool name, parsed result) for every tool message in this turn's history."""
    names: dict[str, str] = {}
    out: list[tuple[str, Any]] = []
    for m in history or []:
        for tc in m.get("tool_calls") or []:
            names[tc.get("id", "")] = tc.get("function", {}).get("name", "")
        if m.get("role") == "tool":
            try:
                body = json.loads(m.get("content") or "null")
            except json.JSONDecodeError:
                body = None
            out.append((names.get(m.get("tool_call_id", ""), "tool"), body))
    return out


def _complete(client: ChatClient, model: str, messages: list[dict[str, Any]], timeout_s: float, tool_choice: str = "auto") -> Any:
    # The tools stay attached on the rewrite round (tool_choice "none"): some
    # servers reject a history with tool messages and no tool definitions.
    return client.chat.completions.create(
        model=model,
        messages=messages,
        tools=tool_specs(),
        tool_choice=tool_choice,
        temperature=0,
        # DECISION: 2048, not 512. Super reasons before it answers; after long tool
        # results 512 tokens went to reasoning and the reply came back empty.
        max_tokens=2048,
        timeout=timeout_s,
    )


def run_turn(
    client: ChatClient,
    model: str,
    text: str,
    state: dict[str, Any] | None,
    timeout_s: float,
    history: list[dict[str, Any]] | None = None,
    metrics_dir: Path | None = None,
) -> AgentResult:
    messages = build_messages(text, state, history, model)

    t0 = time.perf_counter()
    resp = _complete(client, model, messages, timeout_s)
    msg = resp.choices[0].message
    usage = getattr(resp, "usage", None)
    prompt_tokens = getattr(usage, "prompt_tokens", None)
    completion_tokens = getattr(usage, "completion_tokens", None)

    calls: list[ToolCall] = []
    for tc in msg.tool_calls or []:
        args, errors = validate_call(tc.function.name, tc.function.arguments)
        calls.append(ToolCall(id=tc.id, name=tc.function.name, arguments=args, errors=errors))

    if calls:
        assistant = {
            "role": "assistant",
            "content": msg.content,
            "tool_calls": [
                {"id": tc.id, "type": "function", "function": {"name": tc.function.name, "arguments": tc.function.arguments or "{}"}}
                for tc in msg.tool_calls
            ],
        }
        return AgentResult(
            model=model,
            latency_ms=round((time.perf_counter() - t0) * 1000),
            tool_calls=calls,
            text=msg.content,
            valid=all(not c.errors for c in calls),
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            done=False,
            assistant_message=assistant,
        )

    # Final round: the text must be grounded in this turn's tool results.
    results = tool_results_in(history)
    bodies = [b for _, b in results]
    reply = (msg.content or "").strip()
    check = ground.ground_check(reply, bodies, text)
    rejected = 0
    fallback = False
    turn_id = f"{time.time():.6f}"
    if metrics_dir:
        ground.log(metrics_dir, {"kind": "check", "turn": turn_id, "attempt": 1, "model": model, "text": reply, "passed": check.passed, "rejected": check.rejected})
    if not check.passed:
        rejected += 1
        allowed = ", ".join(ground.allowed_numbers(bodies, text)) or "none"
        retry = messages + [
            {"role": "assistant", "content": reply},
            {
                "role": "user",
                "content": f"Your reply used numbers that no tool returned: {', '.join(check.rejected)}. "
                f"Rewrite it in one or two sentences using only these numbers: {allowed}.",
            },
        ]
        resp2 = _complete(client, model, retry, timeout_s, tool_choice="none")
        usage2 = getattr(resp2, "usage", None)
        if prompt_tokens is not None:
            prompt_tokens += getattr(usage2, "prompt_tokens", 0) or 0
        if completion_tokens is not None:
            completion_tokens += getattr(usage2, "completion_tokens", 0) or 0
        reply = (resp2.choices[0].message.content or "").strip()
        check = ground.ground_check(reply, bodies, text)
        if metrics_dir:
            ground.log(metrics_dir, {"kind": "check", "turn": turn_id, "attempt": 2, "model": model, "text": reply, "passed": check.passed, "rejected": check.rejected})
        if not check.passed:
            rejected += 1
            fallback = True
            reply = ground.template_reply(results)
            check = ground.ground_check(reply, bodies, text)
    if metrics_dir:
        ground.log(metrics_dir, {"kind": "final", "turn": turn_id, "model": model, "passed": check.passed, "fallback": fallback, "rejected_attempts": rejected})

    return AgentResult(
        model=model,
        latency_ms=round((time.perf_counter() - t0) * 1000),
        tool_calls=[],
        text=reply,
        valid=True,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        done=True,
        grounding={"checked": True, "passed": check.passed, "rejected": rejected, "fallback": fallback, "numbers": check.numbers},
    )


# Rounds that plan more calls than this go to Super (section 4.3: multi-step).
MAX_NANO_CALLS = 2


def route_turn(
    nano: tuple[ChatClient, str, float] | None,
    super_: tuple[ChatClient, str, float],
    text: str,
    state: dict[str, Any] | None,
    history: list[dict[str, Any]] | None = None,
    metrics_dir: Path | None = None,
) -> AgentResult:
    """One round through the router. `nano` and `super_` are (client, model, timeout_s)."""
    reason = None
    if nano is not None:
        client, model, timeout_s = nano
        try:
            r = run_turn(client, model, text, state, timeout_s, history=history, metrics_dir=metrics_dir)
            if not r.valid:
                reason = "invalid_call"
            elif len(r.tool_calls) > MAX_NANO_CALLS:
                reason = "multi_step"
            elif r.done and r.grounding and r.grounding.get("fallback"):
                reason = "ungrounded"
            else:
                return r
        except Exception as e:  # timeout, connection, endpoint stopped
            reason = type(e).__name__
    client, model, timeout_s = super_
    r = run_turn(client, model, text, state, timeout_s, history=history, metrics_dir=metrics_dir)
    r.escalated = nano is not None
    r.escalation_reason = reason
    return r


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
        "escalated": result.escalated if result else False,
        "escalation_reason": result.escalation_reason if result else None,
        "done": result.done if result else None,
        "error": error,
    }
    with (settings.metrics_dir / "agent_requests.jsonl").open("a") as f:
        f.write(json.dumps(row) + "\n")
