"""M1 demand intake orchestration: source compilation + optional history.

No web research, calculator, supplier scoring, decision gate, or report
rendering is performed here. Those belong to later milestones.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import defaultdict
from typing import Any

from langchain_core.language_models import BaseChatModel

from procurement_agent.domain.requirements import (
    ConflictValue,
    DataConflict,
    DemandIntakeResult,
    HistoryAvailability,
    HistoryImportResult,
    ParseStatus,
    Requirement,
    RequirementCompilation,
    RequirementSourceType,
    SourceFragment,
)
from procurement_agent.ingestion.compiler import compile_requirement_fragments
from procurement_agent.domain.requirements import UnstructuredRequirement
from procurement_agent.ingestion.pptx import select_pptx_narrative_fragments
from procurement_agent.ingestion.pptx_tables import (
    extract_requirement_rows_from_pptx,
    extract_summary_quantity_conflicts,
)


def build_demand_intake(
    *,
    project_id: str,
    fragments: list[SourceFragment],
    model: BaseChatModel | None,
    analysis_version: int = 1,
    history_import: HistoryImportResult | None = None,
) -> DemandIntakeResult:
    """Compile demand while keeping structured PPT tables deterministic.

    Text-only demand is compiled by the LLM. For PPTX, purchase-plan tables
    are parsed by their actual header semantics; the LLM handles only relevant
    narrative fragments and may attach a constraint to a known table item, but
    it cannot create a new SKU from a project-wide summary total.
    """
    groups: dict[tuple[RequirementSourceType, str], list[SourceFragment]] = defaultdict(list)
    for fragment in fragments:
        groups[(fragment.source_type, fragment.source_id)].append(fragment)

    requirements: list[Requirement] = []
    unstructured: list[UnstructuredRequirement] = []
    all_conflicts: list[DataConflict] = []
    issues: list[str] = []
    compile_index = 0

    for (source_type, _source_id), source_fragments in groups.items():
        table_requirements: list[Requirement] = []
        compile_fragments = source_fragments
        known_items: list[dict[str, str]] | None = None

        if source_type == RequirementSourceType.INTERNAL_PPTX:
            table_requirements = extract_requirement_rows_from_pptx(
                source_fragments,
                project_id=project_id,
                revision=analysis_version,
            )
            all_conflicts.extend(extract_summary_quantity_conflicts(source_fragments, project_id=project_id))
            if table_requirements:
                compile_fragments = select_pptx_narrative_fragments(source_fragments)
                known_items = [
                    {
                        "requirement_id": requirement.requirement_id,
                        "product_name": requirement.product_name,
                        "match_key": requirement.match_key or _normalize_name(requirement.product_name),
                    }
                    for requirement in table_requirements
                ]
            else:
                # Other PPT layouts may have demand as prose or nonstandard
                # tables; preserve the whole bounded source for DSL compilation.
                compile_fragments = source_fragments

        requirements.extend(table_requirements)
        if not compile_fragments:
            continue

        if model is None:
            raise RuntimeError("A configured chat model is required to compile natural-language demand fragments.")
        compile_index += 1
        result = compile_requirement_fragments(
            project_id=project_id,
            fragments=compile_fragments,
            model=model,
            revision=analysis_version,
            context_requirements=known_items,
        )
        compilation = result.compilation
        issues.extend(result.grounding_issues)
        issues.extend(compilation.issues)
        prefix = "text" if source_type == RequirementSourceType.USER_TEXT else "pptx"
        _namespace_requirement_ids(compilation.requirements, f"{prefix}_{compile_index}")

        if table_requirements and known_items is not None:
            _merge_narrative_constraints(
                table_requirements=table_requirements,
                narrative_requirements=compilation.requirements,
                fragments=compile_fragments,
                unstructured=unstructured,
                issues=issues,
            )
        else:
            requirements.extend(compilation.requirements)

        unstructured.extend(compilation.unstructured_requirements)
        all_conflicts.extend(compilation.conflicts)

    conflicts_by_id = {conflict.conflict_id: conflict for conflict in all_conflicts}
    for conflict in detect_requirement_conflicts(project_id, requirements):
        conflicts_by_id.setdefault(conflict.conflict_id, conflict)
    issues = list(dict.fromkeys(issues))
    unique_unstructured: dict[tuple[str | None, str | None, str], UnstructuredRequirement] = {}
    for item in unstructured:
        unique_unstructured.setdefault((item.source_ref, item.source_quote, item.text), item)

    return DemandIntakeResult(
        project_id=project_id,
        analysis_version=analysis_version,
        source_refs=[fragment.locator for fragment in fragments],
        requirements=requirements,
        conflicts=list(conflicts_by_id.values()),
        unstructured_requirements=list(unique_unstructured.values()),
        history_availability=(
            HistoryAvailability.IMPORTED if history_import else HistoryAvailability.NOT_PROVIDED
        ),
        history_dataset_id=history_import.dataset_id if history_import else None,
        issues=issues,
    )


def _merge_narrative_constraints(
    *,
    table_requirements: list[Requirement],
    narrative_requirements: list[Requirement],
    fragments: list[SourceFragment],
    unstructured: list[UnstructuredRequirement],
    issues: list[str],
) -> None:
    """Attach narrative DSL only to an exact known table line item."""
    known = {
        requirement.match_key or _normalize_name(requirement.product_name): requirement
        for requirement in table_requirements
    }
    known.update({_normalize_name(requirement.product_name): requirement for requirement in table_requirements})
    source_by_locator = {fragment.locator: fragment for fragment in fragments}
    for narrative in narrative_requirements:
        key = narrative.match_key or _normalize_name(narrative.product_name)
        target = known.get(key) or known.get(_normalize_name(narrative.product_name))
        if target:
            target.constraints.extend(narrative.constraints)
            target.source_refs = list(dict.fromkeys(target.source_refs + narrative.source_refs))
            target.open_questions.extend(narrative.open_questions)
            if narrative.parse_status != ParseStatus.RESOLVED:
                target.parse_status = ParseStatus.AMBIGUOUS
            for constraint in narrative.constraints:
                constraint.requirement_id = target.requirement_id
            continue

        # Never turn a whole-project headline into an extra pseudo-SKU. Keep it
        # visible as an unstructured review item with its source locator.
        locator = narrative.source_refs[0] if narrative.source_refs else None
        source_fragment = source_by_locator.get(locator or "")
        if source_fragment:
            unstructured.append(
                UnstructuredRequirement(
                    text=narrative.product_name,
                    source_ref=source_fragment.locator,
                    source_quote=source_fragment.text,
                    parse_status=ParseStatus.AMBIGUOUS,
                    reason="Narrative demand could not be aligned to an explicit purchase-plan line item.",
                )
            )
            issues.append(
                f"Narrative item {narrative.product_name!r} was retained for review and not created as a new SKU."
            )
        else:
            issues.append(f"Narrative item {narrative.product_name!r} had no verifiable source locator.")


def bump_analysis_version(current_version: int, *, new_history_hash: str, known_history_hashes: set[str]) -> int:
    """Increment a project's analysis version only for newly imported history.

    Existing reports/snapshots are not modified; the caller creates a new run
    using the returned version.
    """
    return current_version + 1 if new_history_hash not in known_history_hashes else current_version


def detect_requirement_conflicts(
    project_id: str,
    requirements: list[Requirement],
) -> list[DataConflict]:
    """Find explicit quantity/attribute disagreements for the same demand item."""
    groups: dict[str, list[Requirement]] = defaultdict(list)
    for requirement in requirements:
        key = requirement.match_key or _normalize_name(requirement.product_name)
        if key:
            groups[key].append(requirement)

    conflicts: list[DataConflict] = []
    for match_key, matches in groups.items():
        if len(matches) < 2:
            continue
        quantity_values = [r for r in matches if r.quantity is not None]
        if len({r.quantity for r in quantity_values}) > 1:
            values = [
                ConflictValue(
                    value=r.quantity or "",
                    source_ref=r.source_refs[0] if r.source_refs else "",
                    source_quote=_source_quote_for_requirement(r),
                )
                for r in quantity_values
            ]
            conflicts.append(
                _make_conflict(project_id, match_key, "quantity", values)
            )

        attrs: dict[str, list[tuple[Requirement, Any]]] = defaultdict(list)
        for requirement in matches:
            for constraint in requirement.constraints:
                attrs[constraint.attribute_key].append((requirement, constraint))
        for attribute, pairs in attrs.items():
            # A conflict is between separate source records, not duplicate
            # constraints repeated inside one source.
            if len({requirement.requirement_id for requirement, _ in pairs}) < 2:
                continue
            signatures = {
                json.dumps(
                    {
                        "operator": constraint.operator.value,
                        "value_type": constraint.value_type.value,
                        "value": constraint.value,
                        "unit": constraint.unit,
                        "qualifiers": constraint.qualifiers,
                    },
                    sort_keys=True,
                    ensure_ascii=False,
                    default=str,
                )
                for _, constraint in pairs
            }
            if len(signatures) <= 1:
                continue
            values = [
                ConflictValue(
                    value=(
                        f"{constraint.operator.value} {json.dumps(constraint.value, ensure_ascii=False, default=str)}"
                        f" {constraint.unit or ''}"
                    ).strip(),
                    source_ref=constraint.source_ref or "",
                    source_quote=constraint.source_quote or "",
                )
                for _, constraint in pairs
            ]
            conflicts.append(_make_conflict(project_id, match_key, attribute, values))
    return conflicts


def _make_conflict(
    project_id: str,
    requirement_key: str,
    field: str,
    values: list[ConflictValue],
) -> DataConflict:
    digest = hashlib.sha256(
        f"{project_id}|{requirement_key}|{field}|".encode()
        + "|".join(v.source_ref + v.value for v in values).encode()
    ).hexdigest()[:20]
    return DataConflict(
        conflict_id=f"conflict_{digest}",
        project_id=project_id,
        requirement_id=requirement_key,
        field=field,
        values_with_source=values,
    )


def _normalize_name(value: str) -> str:
    return re.sub(r"[\W_]+", "", value.casefold(), flags=re.UNICODE)


def _source_quote_for_requirement(requirement: Requirement) -> str:
    for constraint in requirement.constraints:
        if constraint.source_quote:
            return constraint.source_quote
    return requirement.product_name


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
