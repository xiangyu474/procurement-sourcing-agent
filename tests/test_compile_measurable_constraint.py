"""A compile that states nothing measurable must fail instead of looking empty."""

from __future__ import annotations

from procurement_agent.ingestion.compiler import (
    _has_measurable_constraint,
    _validated_compilation_payload,
)


def test_a_requirement_without_a_constraint_is_still_a_requirement() -> None:
    payload = {
        "requirements": [
            {
                "requirement_id": "r1",
                "product_name": "一批办公椅",
                "quantity": "10",
                "quantity_unit": "把",
                "constraints": [],
            }
        ]
    }
    result = _validated_compilation_payload(payload, project_id="p1", revision=1)
    assert len(result.requirements) == 1
    assert not _has_measurable_constraint(result)
