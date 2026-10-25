import pytest

from app.engine import device_rules


@pytest.fixture(autouse=True)
def device_rule_cards(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch):
    """Rule cards on, except for the distill tests, which run on the default rules
    the training data was verified against (distill/loop.py sets SCRUB_DEVICE_RULES=0
    for the whole process once it is imported)."""
    monkeypatch.setenv("SCRUB_DEVICE_RULES", "0" if request.module.__name__.endswith("test_distill") else "1")
    device_rules.reload()
    yield
    device_rules.reload()
