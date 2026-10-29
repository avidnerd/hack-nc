from fastapi.testclient import TestClient

from app import guard, main


def test_rate_limiter_window():
    rl = guard.RateLimiter(2, window_s=60)
    assert rl.allow("a", 0) and rl.allow("a", 1)
    assert not rl.allow("a", 2)
    assert rl.allow("b", 2)  # per key
    assert rl.allow("a", 61)  # the first hit left the window


def test_budget_charges_super_tokens_and_trips():
    b = guard.Budget(limit_usd=1.0)
    assert not b.exhausted()
    b.charge(1_000_000, 0)  # $0.30
    assert not b.exhausted()
    b.charge(0, 1_000_000)  # $0.90
    assert b.exhausted()
    assert not guard.Budget(limit_usd=0).exhausted()  # 0 means no limit


def test_client_ip_takes_first_forwarded_hop():
    assert guard.client_ip({"x-forwarded-for": "1.2.3.4, 10.0.0.1"}, "10.0.0.1") == "1.2.3.4"
    assert guard.client_ip({}, "5.6.7.8") == "5.6.7.8"


def test_agent_endpoint_returns_503_over_budget_then_429(monkeypatch):
    s = main.settings.__class__(**{**main.settings.__dict__, "tf_api_key": "k", "model_super": "m"})
    monkeypatch.setattr(main, "settings", s)
    monkeypatch.setattr(main, "agent_limit", guard.RateLimiter(1))
    spent = guard.Budget(limit_usd=1e-9)
    spent.charge(1, 1)
    monkeypatch.setattr(main, "budget", spent)
    c = TestClient(main.app)
    assert c.post("/api/agent", json={"text": "hi"}).status_code == 503  # passes the limiter, budget spent
    assert c.post("/api/agent", json={"text": "hi"}).status_code == 429  # second hit this minute
