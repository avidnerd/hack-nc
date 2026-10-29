"""Cost guard for the public endpoint (CLAUDE.md section 8): a per-IP rate
limit and a daily budget kill switch.

State is in memory. The backend runs as one Serverless Endpoint replica, so
one process sees every request; a restart resets the counters, which errs on
the side of serving.
"""

from __future__ import annotations

import time
from collections import defaultdict, deque
from dataclasses import dataclass, field

# Nemotron 3 Super on Token Factory, $ per 1M tokens (input, output); same
# prices as distill/eval.py. Our own Nano endpoint is billed per GPU-hour
# whether it is called or not, so its calls add nothing here.
SUPER_PRICE = (0.30, 0.90)


@dataclass
class RateLimiter:
    limit: int
    window_s: float = 60.0
    hits: dict[str, deque[float]] = field(default_factory=lambda: defaultdict(deque))

    def allow(self, key: str, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        q = self.hits[key]
        while q and now - q[0] >= self.window_s:
            q.popleft()
        if len(q) >= self.limit:
            return False
        q.append(now)
        if len(self.hits) > 10_000:  # drop idle keys so memory stays bounded
            for k in [k for k, v in self.hits.items() if not v]:
                del self.hits[k]
        return True


@dataclass
class Budget:
    """Token Factory spend per UTC day. limit_usd <= 0 means no limit."""

    limit_usd: float
    day: str = ""
    spent_usd: float = 0.0

    def _roll(self) -> None:
        today = time.strftime("%Y-%m-%d", time.gmtime())
        if today != self.day:
            self.day, self.spent_usd = today, 0.0

    def exhausted(self) -> bool:
        self._roll()
        return self.limit_usd > 0 and self.spent_usd >= self.limit_usd

    def charge(self, prompt_tokens: int | None, completion_tokens: int | None) -> None:
        self._roll()
        pin, pout = SUPER_PRICE
        self.spent_usd += ((prompt_tokens or 0) * pin + (completion_tokens or 0) * pout) / 1e6


def client_ip(headers: dict[str, str], peer: str | None) -> str:
    # Nebius serves endpoints through a tunnel, so the peer is the proxy; the
    # first X-Forwarded-For hop is the caller.
    fwd = headers.get("x-forwarded-for", "")
    return fwd.split(",")[0].strip() or peer or "unknown"
