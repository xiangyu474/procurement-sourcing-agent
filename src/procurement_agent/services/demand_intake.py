"""M1 demand intake orchestration: source compilation + optional history.

The model compiles each source document on its own. No web research,
calculator, supplier scoring, decision gate, or report rendering is performed
here. Those belong to later milestones.
"""

from __future__ import annotations

import re
from collections import defaultdict
from typing import Any

from langchain_core.language_models import BaseChatModel

from procurement_agent.domain.requirements import (
    DemandIntakeResult,
    HistoryAvailability,
    HistoryImportResult,
    Requirement,
    RequirementSourceType,
    SourceFragment,
)
from procurement_agent.ingestion.compiler import compile_requirement_fragments


def build_demand_intake(
    *,
    project_id: str,
    fragments: list[SourceFragment],
    model: BaseChatModel | None,
    analysis_version: int = 1,
    history_import: HistoryImportResult | None = None,
) -> DemandIntakeResult:
    """Compile every demand source with the model and merge the results."""
    groups: dict[tuple[RequirementSourceType, str], list[SourceFragment]] = defaultdict(list)
    for fragment in fragments:
        groups[(fragment.source_type, fragment.source_id)].append(fragment)

    requirements: list[Requirement] = []
    unstructured: list[Any] = []
    all_conflicts: list[Any] = []
    issues: list[str] = []

    for index, ((source_type, _source_id), source_fragments) in enumerate(groups.items(), start=1):
        if model is None:
            raise RuntimeError("A configured chat model is required to compile demand sources.")
        result = compile_requirement_fragments(
            project_id=project_id,
            fragments=source_fragments,
            model=model,
            revision=analysis_version,
        )
        compilation = result.compilation
        issues.extend(compilation.issues)
        prefix = "text" if source_type == RequirementSourceType.USER_TEXT else "pptx"
        _namespace_requirement_ids(compilation.requirements, f"{prefix}_{index}")

        requirements.extend(compilation.requirements)
        unstructured.extend(compilation.unstructured_requirements)
        all_conflicts.extend(compilation.conflicts)

    unique_unstructured: dict[tuple[str | None, str | None, str], Any] = {}
    for item in unstructured:
        unique_unstructured.setdefault((item.source_ref, item.source_quote, item.text), item)

    return DemandIntakeResult(
        project_id=project_id,
        analysis_version=analysis_version,
        source_refs=[fragment.locator for fragment in fragments],
        requirements=requirements,
        conflicts=all_conflicts,
        unstructured_requirements=list(unique_unstructured.values()),
        history_availability=(
            HistoryAvailability.IMPORTED if history_import else HistoryAvailability.NOT_PROVIDED
        ),
        history_dataset_id=history_import.dataset_id if history_import else None,
        issues=list(dict.fromkeys(issues)),
    )


def bump_analysis_version(current_version: int, *, new_history_hash: str, known_history_hashes: set[str]) -> int:
    """Increment a project's analysis version only for newly imported history.

    Existing reports/snapshots are not modified; the caller creates a new run
    using the returned version.
    """
    return current_version + 1 if new_history_hash not in known_history_hashes else current_version


def _normalize_name(value: str) -> str:
    return re.sub(r"[\W_]+", "", value.casefold(), flags=re.UNICODE)


def _namespace_requirement_ids(requirements: list[Requirement], prefix: str) -> None:
    """Prevent model-generated IDs from colliding across independent sources."""
    for requirement in requirements:
        old_id = requirement.requirement_id
        new_id = f"{prefix}:{old_id}"
        requirement.requirement_id = new_id
        for constraint in requirement.constraints:
            constraint.constraint_id = f"{prefix}:{constraint.constraint_id}"
            constraint.requirement_id = new_id
        if requirement.match_key is None:
            requirement.match_key = _normalize_name(requirement.product_name)
