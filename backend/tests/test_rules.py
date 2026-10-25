"""Rule card lookup: verbatim validation and device matching (no network)."""

from app.engine import device_rules
from app.engine.stent import DEFAULT_LIMITS
from app.rules import same_device, validate

PAGE = "Infrarenal aortic neck treatment diameter range of 19–32 mm and a minimum aortic neck length of 15 mm; Proximal aortic neck angulation ≤ 60°;"
PAGES = {"https://x.test/excluder": PAGE}


def item(value, quote, url="https://x.test/excluder"):
    return {"value": value, "quote": quote, "url": url}


def test_validate_keeps_verbatim_quotes() -> None:
    kept, why = validate("neck_diameter_mm", item([19, 32], "neck treatment diameter range of 19-32 mm"), PAGES)
    assert why is None and kept["value"] == [19, 32]
    kept, _ = validate("neck_angulation_max_deg", item(60, "Proximal aortic neck angulation <= 60°"), PAGES)
    assert kept["value"] == 60


def test_validate_drops_what_the_source_does_not_say() -> None:
    assert validate("neck_length_min_mm", item(10, "a minimum aortic neck length of 10 mm"), PAGES)[1] == "quote not found verbatim in the source"
    assert validate("neck_length_min_mm", item(12, "a minimum aortic neck length of 15 mm"), PAGES)[1] == "[12.0] not in the quote"
    assert "not a search result" in validate("neck_length_min_mm", item(15, "of 15 mm", "https://other.test"), PAGES)[1]
    assert "wrong shape" in validate("oversize_pct", item(15, "of 15 mm"), PAGES)[1]
    long_page = {"https://x.test/excluder": "neck length of 150 mm"}
    assert "outside" in validate("neck_length_min_mm", item(150, "neck length of 150 mm"), long_page)[1]
    # Verbatim but without context: a trial's "4 to 15 mm" cohort is not the device's rule.
    trial = {"https://x.test/excluder": "Neck length: \u2265 4 mm and \u2264 15 mm"}
    assert "does not name" in validate("neck_length_min_mm", item(4, "\u2265 4 mm and \u2264 15 mm"), trial)[1]
    assert validate("oversize_pct", None, PAGES) == (None, None)


def test_sibling_variant_pages_are_skipped() -> None:
    assert same_device("https://www.goremedical.com/products/excluder/specifications", "Gore Excluder")
    assert not same_device("https://goremedical.com/en-emea/products/excluder-conformable/specifications", "Gore Excluder")
    assert same_device("https://goremedical.com/products/excluder-conformable/specifications", "Gore Excluder Conformable")
    assert same_device("https://www.accessdata.fda.gov/cdrh_docs/pdf/P020004.pdf", "Gore Excluder")


def test_find_and_limits() -> None:
    assert device_rules.find("excluder")["id"] == "gore-excluder"
    assert device_rules.find("Gore Excluder AAA Endoprosthesis")["id"] == "gore-excluder"
    assert device_rules.find("generic") is None and device_rules.find("") is None
    lim = device_rules.limits_of(device_rules.find("Gore Excluder"))
    assert (lim.neck_min_mm, lim.neck_diameter_mm, lim.angulation_max_deg, lim.angulation_inclusive) == (15, (19, 32), 60, True)
    # Not stated on the card: the default oversize range, so sizing stays at 15 %.
    assert (lim.oversize_min_pct, lim.oversize_max_pct, lim.oversize) == (10, 20, 0.15)
    assert device_rules.limits_of(None) is DEFAULT_LIMITS and DEFAULT_LIMITS.oversize == 0.15
