import json
from pathlib import Path


def test_requirement_semantics_fixture_has_explicit_gold_labels():
    path = Path(__file__).parent / "fixtures" / "requirement_semantics.json"
    cases = json.loads(path.read_text(encoding="utf-8"))
    assert len(cases) >= 6
    assert len({case["case_id"] for case in cases}) == len(cases)
    assert {case["gold"]["expect"] for case in cases} == {"constraint", "ambiguous", "unsupported"}
    for case in cases:
        assert case["input"].strip()
        assert case["gold"]
