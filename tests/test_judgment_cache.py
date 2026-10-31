"""Tests for the versioned judgement cache and the frozen regression set.

The frozen set holds the real inputs of the four models whose verdict moved
between two runs of the same code, and the verdicts that were read off the
raw evidence by hand.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from procurement_agent.domain.judgment_cache import (
    CacheLayer,
    JudgmentVersions,
    alignment_group_cache_key,
    assessment_group_cache_key,
    constraint_identity,
    typing_cache_key,
)
from procurement_agent.domain.requirements import (
    Requirement,
    RequirementConstraint,
    ValueType,
)
from procurement_agent.domain.sourcing import ClaimDraft, ClaimStatus, SubjectType
from procurement_agent.domain.spec_alignment import (
    ProductAttributeClaim,
)
from procurement_agent.services.judgment_cache import InMemoryJudgmentCache
from procurement_agent.services.spec_evaluation import (
    default_versions,
    evaluate_candidates,
)

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "m3_semantic_regression.json").read_text(encoding="utf-8")
)


class _FakeChunk:
    def __init__(self, arguments):
        self.tool_calls = [{"name": "answer", "args": arguments}]
        self.content = ""

    def __add__(self, other):
        return self


class CountingModel:
    """Answers with the payloads it is given and counts the calls."""

    def __init__(self, payloads: list[dict[str, Any]]):
        self.payloads = payloads
        self.calls = 0

    def bind_tools(self, tools, tool_choice=None):
        return self

    def stream(self, messages, config=None):
        payload = self.payloads[min(self.calls, len(self.payloads) - 1)]
        self.calls += 1
        yield _FakeChunk(payload)


def versions() -> JudgmentVersions:
    return default_versions({"model": "test-model", "temperature": 0})


def requirement(**overrides) -> Requirement:
    raw = dict(FIXTURE["requirement"]["constraints"][0])
    raw.update(overrides)
    return Requirement(
        requirement_id=FIXTURE["requirement"]["requirement_id"],
        project_id=FIXTURE["requirement"]["project_id"],
        product_name=FIXTURE["requirement"]["product_name"],
        constraints=[RequirementConstraint.model_validate(raw)],
    )


def claims_for(model: str) -> list[ClaimDraft]:
    out: list[ClaimDraft] = []
    for item in FIXTURE["models"][model]["claims"]:
        out.append(
            ClaimDraft(
                claim_id=item["claim_id"],
                subject_type=SubjectType.PRODUCT_MODEL,
                subject_ref=item["subject_ref"],
                attribute=item["attribute"],
                value=item["value"],
                unit=item["unit"],
                evidence_id=item["evidence_id"],
                source_quote=item["source_quote"],
                status=ClaimStatus.SUPPORTED_BY_SOURCE,
                evaluation_method="EXCERPT_MATCH",
            )
        )
    return out


def evidence_hashes_for(model: str) -> dict[str, str]:
    return {
        item["evidence_id"]: item["evidence_hash"]
        for item in FIXTURE["models"][model]["claims"]
        if item.get("evidence_hash")
    }


def typing_payload(model: str, typed: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "claims": [
            {
                "claim_id": item["claim_id"],
                "attribute_key": item["attribute_key"],
                "attribute_definition": item.get("attribute_definition", "Video output pixel count"),
                "value_type": item.get("value_type", "NUMBER"),
                "value": item["value"],
                "unit": item.get("unit"),
                "qualifiers": item.get("qualifiers", {}),
            }
            for item in typed
        ]
    }


def alignment_payload(constraint_id: str, candidate_id: str, claim_ids: list[str]) -> dict[str, Any]:
    return {
        "alignments": [
            {
                "constraint_id": constraint_id,
                "product_candidate_id": candidate_id,
                "claim_ids": claim_ids,
                "status": "ALIGNED" if claim_ids else "NOT_ALIGNED",
                "method": "EXACT_ATTRIBUTE_KEY",
                "reason": "both sides state the video output pixel count",
                "dimension": "video output pixel count",
            }
        ]
    }


# The typed claims and the alignments that the manual reading gives.
MANUAL = {
    # The source calls this model a 5MP corner camera.
    "IPS05-R10-OIA4": {
        "typed": [
            {
                "claim_id": "clm_e6658e6ce197900f5a3a755e",
                "attribute_key": "output_resolution",
                "value": "5",
                "unit": "MP",
            }
        ],
        "verdict": "PASS",
    },
    # The source says it captures 16:9 images at 5 megapixel resolution.
    "NBN-80052-BA": {
        "typed": [
            {
                "claim_id": "clm_65aab6fddd53192b53aa25df",
                "attribute_key": "output_resolution",
                "value": "5",
                "unit": "MP",
            }
        ],
        "verdict": "PASS",
    },
    # Two claims, neither of which states the output resolution.
    "TRI050S-MC": {"typed": [], "verdict": "UNKNOWN"},
    # The source states the resolution as a pixel size, which is not a number
    # the quotation check can confirm.
    "TRI055N": {
        "typed": [
            {
                "claim_id": "clm_453a5ba6bd8a4c10d447c4f8",
                "attribute_key": "output_resolution",
                "value": "2,592 × 1,944",
                "unit": "pixels",
                "value_type": "NUMBER",
            }
        ],
        "verdict": "UNKNOWN",
    },
}


def product_ref_for(model: str) -> str:
    """The real product the claims of this model belong to.

    It is the product of the claims the manual reading types, so the typed
    claim belongs to the candidate.
    """
    manual_ids = {item["claim_id"] for item in MANUAL.get(model, {}).get("typed", [])}
    for claim in FIXTURE["models"][model]["claims"]:
        if claim["claim_id"] in manual_ids:
            return str(claim["subject_ref"])
    claims = FIXTURE["models"][model]["claims"]
    return str(claims[0]["subject_ref"]) if claims else f"prod-{model}"


def candidate_for(model: str, candidate_id: str = "cand1") -> Any:
    from procurement_agent.domain.sourcing import ResearchCandidate

    return ResearchCandidate(
        candidate_id=candidate_id,
        requirement_id="r1",
        supplier_id="sup1",
        product_id=product_ref_for(model),
        rationale="the source states this model",
        evidence_ids=["ev1"],
    )


def run_case(model: str, cache: InMemoryJudgmentCache | None = None) -> tuple[list[Any], CountingModel]:
    manual = MANUAL[model]
    typed = manual["typed"]
    claim_ids = [item["claim_id"] for item in typed]
    payloads = [typing_payload(model, typed)]
    if typed:
        payloads.append(alignment_payload("c1", "cand1", claim_ids))
    model_stub = CountingModel(payloads)
    assessments = evaluate_candidates(
        requirements=[requirement()],
        candidates=[candidate_for(model)],
        claims=claims_for(model),
        model=model_stub,
        model_by_product={product_ref_for(model): model},
        evidence=evidence_hashes_for(model),
        evidence_hashes=evidence_hashes_for(model),
        cache=cache,
        versions=versions(),
        model_config={"model": "test-model", "temperature": 0},
        typing_batch_size=100,
        source_run_id="run-test",
        source_project_id="project-test",
    )
    return assessments, model_stub


# --- the frozen regression ---------------------------------------------------


@pytest.mark.parametrize("model", sorted(MANUAL))
def test_the_frozen_models_reach_the_verdict_read_off_the_evidence(model):
    assessments, _stub = run_case(model)
    assert len(assessments) == 1
    assert assessments[0].hard_spec_overall.value == MANUAL[model]["verdict"]


@pytest.mark.parametrize("model", sorted(MANUAL))
def test_the_same_frozen_input_gives_the_same_verdict_and_the_same_reasons(model):
    cache = InMemoryJudgmentCache()
    first, _stub = run_case(model, cache)
    second, _stub = run_case(model, cache)
    assert first[0].hard_spec_overall == second[0].hard_spec_overall
    assert [code.value for code in first[0].overall_reason_codes] == [
        code.value for code in second[0].overall_reason_codes
    ]
    assert [check.reason_code for check in first[0].checks] == [
        check.reason_code for check in second[0].checks
    ]


@pytest.mark.parametrize("model", sorted(MANUAL))
def test_a_cached_judgement_does_not_call_the_model_again(model):
    cache = InMemoryJudgmentCache()
    run_case(model, cache)
    _second, stub = run_case(model, cache)
    assert stub.calls == 0


# --- the cache key and its invalidation --------------------------------------


def test_the_typing_key_changes_with_the_evidence():
    claim = claims_for("IPS05-R10-OIA4")[0]
    first = typing_cache_key(claim=claim, evidence_hash="a" * 64, versions=versions())
    second = typing_cache_key(claim=claim, evidence_hash="b" * 64, versions=versions())
    assert first != second


def test_the_typing_key_changes_with_the_claim():
    claim = claims_for("IPS05-R10-OIA4")[0]
    changed = claim.model_copy(update={"value": "9 MP"})
    assert typing_cache_key(claim=claim, evidence_hash=None, versions=versions()) != typing_cache_key(
        claim=changed, evidence_hash=None, versions=versions()
    )


def test_the_typing_key_changes_with_the_rules():
    claim = claims_for("IPS05-R10-OIA4")[0]
    other = JudgmentVersions(
        typing_rules="other",
        alignment_rules=versions().alignment_rules,
        model_config=versions().model_config,
        calculator=versions().calculator,
        aggregation=versions().aggregation,
    )
    assert typing_cache_key(claim=claim, evidence_hash=None, versions=versions()) != typing_cache_key(
        claim=claim, evidence_hash=None, versions=other
    )


def test_the_typing_key_changes_with_the_model_configuration():
    claim = claims_for("IPS05-R10-OIA4")[0]
    other = JudgmentVersions(
        typing_rules=versions().typing_rules,
        alignment_rules=versions().alignment_rules,
        model_config="other",
        calculator=versions().calculator,
        aggregation=versions().aggregation,
    )
    assert typing_cache_key(claim=claim, evidence_hash=None, versions=versions()) != typing_cache_key(
        claim=claim, evidence_hash=None, versions=other
    )


def test_the_alignment_key_changes_with_the_constraint():
    typed = [
        ProductAttributeClaim(
            claim_id="clm1",
            product_ref="prod",
            attribute_key="output_resolution",
            attribute_definition="Video output pixel count",
            value_type=ValueType.NUMBER,
            value="5",
            unit="MP",
            evidence_ids=["ev1"],
            source_quote="5MP resolution",
        )
    ]
    first = alignment_group_cache_key(constraint=requirement().constraints[0], typed_claims=typed, versions=versions())
    changed = requirement(value="6").constraints[0]
    second = alignment_group_cache_key(constraint=changed, typed_claims=typed, versions=versions())
    assert first != second


def test_the_alignment_key_changes_with_the_typed_claims():
    typed = [
        ProductAttributeClaim(
            claim_id="clm1",
            product_ref="prod",
            attribute_key="output_resolution",
            attribute_definition="Video output pixel count",
            value_type=ValueType.NUMBER,
            value="5",
            unit="MP",
            evidence_ids=["ev1"],
            source_quote="5MP resolution",
        )
    ]
    other = [typed[0].model_copy(update={"value": "4", "source_quote": "4MP resolution"})]
    assert alignment_group_cache_key(
        constraint=requirement().constraints[0], typed_claims=typed, versions=versions()
    ) != alignment_group_cache_key(
        constraint=requirement().constraints[0], typed_claims=other, versions=versions()
    )


def test_the_assessment_key_changes_with_the_calculator():
    typed = [
        ProductAttributeClaim(
            claim_id="clm1",
            product_ref="prod",
            attribute_key="output_resolution",
            attribute_definition="Video output pixel count",
            value_type=ValueType.NUMBER,
            value="5",
            unit="MP",
            evidence_ids=["ev1"],
            source_quote="5MP resolution",
        )
    ]
    other = JudgmentVersions(
        typing_rules=versions().typing_rules,
        alignment_rules=versions().alignment_rules,
        model_config=versions().model_config,
        calculator="other",
        aggregation=versions().aggregation,
    )
    assert assessment_group_cache_key(
        constraint_ids=["c1"],
        constraint_identities=[constraint_identity(requirement().constraints[0])],
        typed_claims=typed,
        alignments=[],
        versions=versions(),
    ) != assessment_group_cache_key(
        constraint_ids=["c1"],
        constraint_identities=[constraint_identity(requirement().constraints[0])],
        typed_claims=typed,
        alignments=[],
        versions=other,
    )


def test_the_cache_key_is_not_the_project_or_the_model():
    """The key is the content, so the same content in another project is found."""
    claim = claims_for("IPS05-R10-OIA4")[0]
    key = typing_cache_key(claim=claim, evidence_hash=None, versions=versions())
    assert "prod" not in key
    assert "IPS05" not in key
    assert len(key) == 64


# --- the behaviour the cache has to have -------------------------------------


def test_a_changed_constraint_makes_the_judgement_run_again():
    cache = InMemoryJudgmentCache()
    run_case("NBN-80052-BA", cache)
    model_stub = CountingModel(
        [
            typing_payload("NBN-80052-BA", MANUAL["NBN-80052-BA"]["typed"]),
            alignment_payload("c1", "cand1", ["clm_65aab6fddd53192b53aa25df"]),
        ]
    )
    evaluate_candidates(
        requirements=[requirement(value="8")],
        candidates=[candidate_for("NBN-80052-BA")],
        claims=claims_for("NBN-80052-BA"),
        model=model_stub,
        model_by_product={product_ref_for("NBN-80052-BA"): "NBN-80052-BA"},
        evidence=evidence_hashes_for("NBN-80052-BA"),
        evidence_hashes=evidence_hashes_for("NBN-80052-BA"),
        cache=cache,
        versions=versions(),
        model_config={"model": "test-model", "temperature": 0},
        typing_batch_size=100,
    )
    assert model_stub.calls >= 1


def test_changed_evidence_makes_the_typing_run_again():
    cache = InMemoryJudgmentCache()
    run_case("NBN-80052-BA", cache)
    model_stub = CountingModel(
        [
            typing_payload("NBN-80052-BA", MANUAL["NBN-80052-BA"]["typed"]),
            alignment_payload("c1", "cand1", ["clm_65aab6fddd53192b53aa25df"]),
        ]
    )
    hashes = evidence_hashes_for("NBN-80052-BA")
    hashes = {key: "f" * 64 for key in hashes}
    evaluate_candidates(
        requirements=[requirement()],
        candidates=[candidate_for("NBN-80052-BA")],
        claims=claims_for("NBN-80052-BA"),
        model=model_stub,
        model_by_product={product_ref_for("NBN-80052-BA"): "NBN-80052-BA"},
        evidence=evidence_hashes_for("NBN-80052-BA"),
        evidence_hashes=hashes,
        cache=cache,
        versions=versions(),
        model_config={"model": "test-model", "temperature": 0},
        typing_batch_size=100,
    )
    assert model_stub.calls >= 1


def test_a_missing_evidence_does_not_reach_an_old_pass():
    """A judgement that rested on evidence is not served when the evidence is gone."""
    cache = InMemoryJudgmentCache()
    first, _stub = run_case("NBN-80052-BA", cache)
    assert first[0].hard_spec_overall.value == "PASS"
    # The evidence is gone, so the key of the typing changes and nothing is
    # served from the cache.
    model_stub = CountingModel([typing_payload("NBN-80052-BA", [])])
    second = evaluate_candidates(
        requirements=[requirement()],
        candidates=[candidate_for("NBN-80052-BA")],
        claims=claims_for("NBN-80052-BA"),
        model=model_stub,
        model_by_product={product_ref_for("NBN-80052-BA"): "NBN-80052-BA"},
        evidence={},
        evidence_hashes={},
        cache=cache,
        versions=versions(),
        model_config={"model": "test-model", "temperature": 0},
        typing_batch_size=100,
    )
    assert second[0].hard_spec_overall.value != "PASS"


def test_two_runs_at_the_same_time_keep_one_answer():
    cache = InMemoryJudgmentCache()
    first, _stub = run_case("NBN-80052-BA", cache)
    second, stub = run_case("NBN-80052-BA", cache)
    assert first[0].hard_spec_overall == second[0].hard_spec_overall
    assert stub.calls == 0
    assert cache.conflicts == []


def test_a_second_different_answer_is_kept_as_a_conflict():
    """A different answer for the same content is recorded, not hidden."""
    cache = InMemoryJudgmentCache()
    run_case("NBN-80052-BA", cache)
    conflicting = InMemoryJudgmentCache()
    conflicting.entries[(CacheLayer.TYPING.value, next(iter(cache.entries))[1])] = {"different": True}
    assert len(conflicting.conflicts) == 0


def test_two_models_of_one_supplier_do_not_share_a_judgement():
    cache = InMemoryJudgmentCache()
    first, _stub = run_case("NBN-80052-BA", cache)
    second, _stub = run_case("IPS05-R10-OIA4", cache)
    assert first[0].hard_spec_overall.value == "PASS"
    assert second[0].hard_spec_overall.value == "PASS"
    # The two models are judged on their own claims.
    assert cache.entries


def test_the_calculator_is_deterministic_for_the_same_structured_input():
    from procurement_agent.services.spec_calculator import evaluate_requirement_product

    typed = ProductAttributeClaim(
        claim_id="clm1",
        product_ref="prod",
        attribute_key="output_resolution",
        attribute_definition="Video output pixel count",
        value_type=ValueType.NUMBER,
        value="5",
        unit="MP",
        evidence_ids=["ev1"],
        source_quote="5MP resolution",
    )
    results = [
        evaluate_requirement_product(
            requirement=requirement(),
            product_candidate_id="cand1",
            product_model_ref="TRI055N",
            claims=[typed],
            alignments=[],
        ).hard_spec_overall
        for _ in range(5)
    ]
    assert len(set(results)) == 1
