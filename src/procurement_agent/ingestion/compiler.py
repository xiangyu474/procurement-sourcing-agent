"""LLM-backed demand-to-DSL compiler with deterministic provenance checks.

The LLM may interpret natural language, but it cannot invent source
coordinates. Every resolved constraint must cite an exact extracted fragment
and quote a substring of that fragment. Unsupported or ambiguous clauses stay
visible but do not become executable constraints.
"""

from __future__ import annotations

import json
from copy import deepcopy
from dataclasses import dataclass

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage

from procurement_agent.domain.requirements import (
    ConflictValue,
    ConstraintOrigin,
    DataConflict,
    Importance,
    ParseStatus,
    PlannedAmount,
    Requirement,
    RequirementCompilation,
    RequirementConstraint,
    RequirementSourceType,
    SourceFragment,
    UnstructuredRequirement,
)

SYSTEM_PROMPT = """You compile purchasing demand into a small, restricted Requirement DSL.

Rules:
- Extract only requirements explicitly present in the supplied text fragments.
- Every structured Requirement MUST include a non-empty product_name copied verbatim or closely normalized from its cited source. If a procurement object cannot be identified, return an UnstructuredRequirement instead of an incomplete Requirement.
- Put procurement quantity and quantity_unit in the Requirement top-level fields; do not duplicate quantity as a technical constraint.
- Never infer a hard requirement, quantity, target market, delivery date, tax basis,
  product model, or threshold that the source does not state.
- Keep vague statements such as 'industrial grade', 'good reputation', or 'meet
  relevant standards' as unstructured requirements with status UNSUPPORTED or
  AMBIGUOUS; do not invent numeric limits.
- Use HARD only for explicit mandatory language (must, at least, no more than,
  shall, required). 'Prefer', 'ideally', and '最好' are PREFERENCE.
- Set parse_status=AMBIGUOUS if the measured quantity or comparison direction is
  unclear; set UNSUPPORTED if the statement cannot safely fit this DSL.
- Every Requirement and every constraint must cite the exact source locator and
  an exact verbatim source_quote from one supplied fragment. Do not make up page,
  slide, table, row, cell, or character offsets.
- Requirement source refs must use the supplied locators. Preserve the wording,
  quantities, units, comparison operators, and qualifiers faithfully.
- The DSL permits only NUMBER, BOOLEAN, STRING, SET, RANGE and the listed
  operators. Do not emit executable expressions or formulas.
- If an existing requirement/product list is included in the input, attach narrative constraints only to an exact matching product; do not create a new SKU from a project-wide summary quantity.
- Return requirements in the source language. Do not resolve conflicts between
  separate source fragments. If values refer to the same item, measure and scope,
  preserve all exact source quotes/locators as a DataConflict.
- When a PPTX has a detailed procurement table and overview totals, extract every
  table line item and report overview-vs-overview disagreements as conflicts;
  never silently replace detailed per-item entries with a summary total.
"""


@dataclass(frozen=True)
class CompilerResult:
    """Compiled requirements plus nonfatal grounding issues."""

    compilation: RequirementCompilation
    grounding_issues: tuple[str, ...] = ()


def compile_requirement_fragments(
    *,
    project_id: str,
    fragments: list[SourceFragment],
    model: BaseChatModel,
    revision: int = 1,
    context_requirements: list[dict[str, str]] | None = None,
) -> CompilerResult:
    """Compile fragments to the constrained DSL and enforce source grounding."""
    if not fragments:
        return CompilerResult(
            compilation=RequirementCompilation(
                requirements=[],
                unstructured_requirements=[],
                issues=["No non-empty demand source was provided."],
            )
        )

    allowed = {fragment.locator: fragment for fragment in fragments}
    prompt = {
        "project_id": project_id,
        "revision": revision,
        "known_requirement_items": context_requirements or [],
        "fragments": [
            {
                "source_id": f.source_id,
                "source_type": f.source_type.value,
                "locator": f.locator,
                "text": f.text,
            }
            for f in fragments
        ],
    }
    structured_model = model.with_structured_output(
        RequirementCompilation,
        method="function_calling",
        include_raw=True,
    )
    response = structured_model.invoke(
        [
            SystemMessage(content=SYSTEM_PROMPT),
            HumanMessage(content=json.dumps(prompt, ensure_ascii=False)),
        ]
    )
    raw = _validated_compilation_payload(response)

    raw.project_id = project_id
    raw.revision = revision
    raw.compiler_version = "req-dsl-1.0"
    issues: list[str] = list(raw.issues)
    root_source_refs = [ref for ref in raw.source_refs if ref in allowed]
    if len(root_source_refs) != len(raw.source_refs):
        issues.append("Compiler returned one or more unknown top-level source locators.")
    raw.source_refs = root_source_refs
    for requirement in raw.requirements:
        requirement.project_id = project_id
        requirement.revision = revision
        source_refs = [ref for ref in requirement.source_refs if ref in allowed]
        if len(source_refs) != len(requirement.source_refs):
            issues.append(f"Requirement {requirement.requirement_id}: discarded unknown source locator.")
        requirement.source_refs = source_refs
        if not source_refs:
            requirement.parse_status = ParseStatus.AMBIGUOUS
            requirement.open_questions.append("No verifiable source locator was returned by the compiler.")

        for constraint in requirement.constraints:
            _ground_constraint(constraint, allowed, issues)
            _mark_ambiguous_resolution_basis(constraint, issues)
            expected_origin = _origin_for_source(constraint.source_ref, allowed)
            if expected_origin is None:
                constraint.importance = (
                    constraint.importance
                    if constraint.origin != ConstraintOrigin.INFERRED_FOR_REVIEW
                    else constraint.importance
                )
                constraint.parse_status = ParseStatus.AMBIGUOUS
            elif constraint.origin != ConstraintOrigin.INFERRED_FOR_REVIEW:
                # Source type is deterministic; do not let a model label a PPT
                # statement as user-entered text or vice versa.
                constraint.origin = expected_origin
            if constraint.origin == ConstraintOrigin.INFERRED_FOR_REVIEW and constraint.importance == Importance.HARD:
                constraint.importance = Importance.UNKNOWN
                constraint.parse_status = ParseStatus.AMBIGUOUS
                constraint.validation_issues.append("Inferred constraints cannot be upgraded to HARD.")
                issues.append(
                    f"Constraint {constraint.constraint_id}: inferred HARD downgraded to UNKNOWN."
                )

        if any(c.parse_status != ParseStatus.RESOLVED for c in requirement.constraints):
            if requirement.parse_status == ParseStatus.RESOLVED:
                requirement.parse_status = ParseStatus.AMBIGUOUS

    for item in raw.unstructured_requirements:
        if item.source_ref not in allowed or not _quote_is_grounded(item.source_quote, allowed.get(item.source_ref)):
            item.source_ref = None
            item.source_quote = None
            item.parse_status = ParseStatus.AMBIGUOUS
            item.reason = "Compiler citation did not match any supplied source fragment. " + item.reason
            issues.append("An unstructured requirement had a non-verifiable citation.")

    grounded_conflicts = []
    for conflict in raw.conflicts:
        grounded_values = [
            value
            for value in conflict.values_with_source
            if value.source_ref in allowed
            and _quote_is_grounded(value.source_quote, allowed.get(value.source_ref))
            and all(ref in allowed for ref in (value.source_refs or [value.source_ref]))
        ]
        if len(grounded_values) < 2:
            issues.append(
                f"Conflict {conflict.conflict_id}: fewer than two source-grounded values; discarded."
            )
            continue
        conflict.project_id = project_id
        conflict.values_with_source = grounded_values
        grounded_conflicts.append(conflict)
    raw.conflicts = grounded_conflicts
    raw.issues = issues
    return CompilerResult(compilation=raw, grounding_issues=tuple(issues))


def _validated_compilation_payload(response: object) -> RequirementCompilation:
    """Validate provider output, normalizing only JSON numbers to DSL strings.

    Some OpenAI-compatible endpoints serialize JSON numbers as numeric scalars
    despite the DSL contract requiring decimal strings. This adapter converts
    those scalars before strict Pydantic validation; the domain model itself
    remains strict for all callers and persisted payloads.
    """
    if isinstance(response, RequirementCompilation):
        return response

    payload: object = response
    if isinstance(response, dict) and "raw" in response and "parsed" in response:
        if isinstance(response.get("parsed"), RequirementCompilation):
            return response["parsed"]
        raw_message = response.get("raw")
        calls = getattr(raw_message, "tool_calls", None) or []
        if calls:
            payload = calls[0].get("args")
        else:
            content = getattr(raw_message, "content", None)
            if isinstance(content, str):
                try:
                    payload = json.loads(content)
                except json.JSONDecodeError as exc:
                    raise ValueError("Requirement compiler returned neither a parsed schema nor JSON tool arguments") from exc

    if not isinstance(payload, dict):
        raise ValueError("Requirement compiler output must be a JSON object")
    normalized = deepcopy(payload)
    issues: list[str] = []
    recovered_unstructured: list[dict[str, Any]] = []
    root_requirement_fields = {
        "requirement_id", "product_name", "match_key", "source_product_code", "quantity",
        "quantity_unit", "planned_unit_price", "planned_sales_unit_price", "planned_total_budget",
        "tax_rate", "constraints", "source_refs", "parse_status", "open_questions",
    }
    _normalize_list_fields(
        normalized,
        ("source_refs", "requirements", "unstructured_requirements", "conflicts", "open_questions", "issues"),
    )
    if "product_category" in normalized and "project_category" not in normalized:
        normalized["project_category"] = normalized.pop("product_category")

    if not normalized.get("requirements") and "product_name" in normalized and any(
        key in normalized for key in ("requirement_id", "source_product_code", "quantity", "constraints")
    ):
        root_requirement = {
            key: normalized.pop(key) for key in list(normalized) if key in root_requirement_fields
        }
        normalized["requirements"] = [root_requirement]
    elif normalized.get("requirements") and isinstance(normalized["requirements"], list):
        # Some providers duplicate the single-item requirement at the root and
        # in the requirements array. Merge only when the association is
        # unambiguous (exactly one nested item); otherwise discard the flattened
        # copies with an audit issue rather than attaching them to the wrong SKU.
        root_fields_present = root_requirement_fields.intersection(normalized)
        if root_fields_present and len(normalized["requirements"]) == 1:
            nested = normalized["requirements"][0]
            for key in root_fields_present:
                value = normalized.pop(key)
                if key == "constraints" and isinstance(value, list):
                    nested[key] = list(nested.get(key, [])) + value
                else:
                    nested.setdefault(key, value)
        elif root_fields_present:
            for key in root_fields_present:
                normalized.pop(key, None)
            issues.append("Discarded flattened root requirement fields because multiple requirement items were returned.")
    elif "product_name" in normalized and "project_scope" not in normalized:
        normalized["project_scope"] = normalized.pop("product_name")

    valid_requirements: list[dict[str, Any]] = []
    for index, raw_requirement in enumerate(normalized.get("requirements", [])):
        requirement = _sanitize_model_payload(raw_requirement, Requirement, "Requirement", issues)
        if "name" in raw_requirement and "product_name" not in requirement:
            requirement["product_name"] = raw_requirement["name"]
        _normalize_list_fields(requirement, ("source_refs", "constraints", "open_questions"))
        quantity = requirement.get("quantity")
        if isinstance(quantity, (int, float)) and not isinstance(quantity, bool):
            requirement["quantity"] = str(quantity)

        valid_constraints: list[dict[str, Any]] = []
        for constraint_index, raw_constraint in enumerate(requirement.get("constraints", [])):
            constraint = _sanitize_model_payload(
                raw_constraint, RequirementConstraint, "RequirementConstraint", issues
            )
            value = constraint.get("value")
            if (
                constraint.get("value_type") == "NUMBER"
                and isinstance(value, (int, float))
                and not isinstance(value, bool)
            ):
                constraint["value"] = str(value)
            try:
                RequirementConstraint.model_validate(constraint)
                valid_constraints.append(constraint)
            except Exception as exc:
                quote = raw_constraint.get("source_quote")
                ref = raw_constraint.get("source_ref")
                text = str(raw_constraint.get("attribute_definition") or raw_constraint.get("attribute_key") or quote or "")
                recovered_unstructured.append(
                    {
                        "text": text,
                        "source_ref": ref,
                        "source_quote": quote,
                        "parse_status": "UNSUPPORTED" if not raw_constraint.get("operator") else "AMBIGUOUS",
                        "reason": f"Constraint did not satisfy the restricted DSL schema: {type(exc).__name__}.",
                    }
                )
                issues.append(
                    f"Requirement[{index}].constraints[{constraint_index}] could not be safely compiled; retained as unstructured."
                )
        requirement["constraints"] = valid_constraints

        for amount_field in ("planned_unit_price", "planned_sales_unit_price", "planned_total_budget"):
            amount = requirement.get(amount_field)
            if isinstance(amount, dict):
                amount = _sanitize_model_payload(amount, PlannedAmount, "PlannedAmount", issues)
                amount_value = amount.get("value")
                if isinstance(amount_value, (int, float)) and not isinstance(amount_value, bool):
                    amount["value"] = str(amount_value)
                requirement[amount_field] = amount
        try:
            Requirement.model_validate(requirement)
            valid_requirements.append(requirement)
        except Exception as exc:
            issues.append(
                f"Requirement[{index}] did not satisfy the requirement schema; it was not promoted to a SKU ({type(exc).__name__})."
            )
            source_refs = requirement.get("source_refs") or []
            source_ref = source_refs[0] if source_refs else None
            source_quote = requirement.get("source_quote")
            if source_ref and source_quote:
                recovered_unstructured.append(
                    {
                        "text": requirement.get("product_name") or "Unparsed demand item",
                        "source_ref": source_ref,
                        "source_quote": source_quote,
                        "parse_status": "AMBIGUOUS",
                        "reason": "Compiler output did not meet the Requirement schema.",
                    }
                )
            else:
                # Preserve each source-grounded clause even if the model
                # omitted the item name or emitted an incomplete constraint.
                # Do not upgrade it to a Requirement/SKU without an explicit
                # procurement object.
                for raw_constraint in raw_requirement.get("constraints", []):
                    ref = raw_constraint.get("source_ref")
                    quote = raw_constraint.get("source_quote")
                    if ref and quote:
                        recovered_unstructured.append(
                            {
                                "text": quote,
                                "source_ref": ref,
                                "source_quote": quote,
                                "parse_status": "AMBIGUOUS",
                                "reason": "Source-grounded clause retained because product_name was missing or the Requirement schema was incomplete.",
                            }
                        )

    valid_unstructured: list[dict[str, Any]] = []
    for index, raw_item in enumerate(normalized.get("unstructured_requirements", []) + recovered_unstructured):
        item = _sanitize_model_payload(raw_item, UnstructuredRequirement, "UnstructuredRequirement", issues)
        try:
            UnstructuredRequirement.model_validate(item)
            valid_unstructured.append(item)
        except Exception as exc:
            issues.append(f"UnstructuredRequirement[{index}] was discarded due to invalid shape ({type(exc).__name__}).")

    valid_conflicts: list[dict[str, Any]] = []
    for index, raw_conflict in enumerate(normalized.get("conflicts", [])):
        conflict = _sanitize_model_payload(raw_conflict, DataConflict, "DataConflict", issues)
        _normalize_list_fields(conflict, ("values_with_source",))
        values = []
        for raw_value in conflict.get("values_with_source", []):
            value = _sanitize_model_payload(raw_value, ConflictValue, "ConflictValue", issues)
            try:
                ConflictValue.model_validate(value)
                values.append(value)
            except Exception as exc:
                issues.append(f"Conflict[{index}] contained an invalid value citation ({type(exc).__name__}).")
        conflict["values_with_source"] = values
        try:
            DataConflict.model_validate(conflict)
            valid_conflicts.append(conflict)
        except Exception as exc:
            issues.append(f"Conflict[{index}] was discarded due to invalid shape ({type(exc).__name__}).")

    normalized["requirements"] = valid_requirements
    normalized["unstructured_requirements"] = valid_unstructured
    normalized["conflicts"] = valid_conflicts
    _normalize_list_fields(normalized, ("issues", "source_refs", "open_questions"))
    root_fields = set(RequirementCompilation.model_fields)
    unknown_root_fields = sorted(set(normalized) - root_fields)
    for field_name in unknown_root_fields:
        issues.append(f"Discarded unsupported top-level compiler field: {field_name}")
        normalized.pop(field_name, None)
    normalized["issues"] = list(normalized.get("issues", [])) + issues
    return RequirementCompilation.model_validate(normalized)


def _normalize_list_fields(payload: dict[str, Any], fields: tuple[str, ...]) -> None:
    """Accept JSON-stringified arrays from non-strict OpenAI-compatible APIs."""
    for field in fields:
        value = payload.get(field, [])
        if isinstance(value, str):
            try:
                decoded = json.loads(value)
                payload[field] = decoded if isinstance(decoded, list) else [value]
            except json.JSONDecodeError:
                payload[field] = [value] if value.strip() else []


def _sanitize_model_payload(payload: Any, model: type, label: str, issues: list[str]) -> dict[str, Any]:
    """Discard unrecognized model keys, but make each discard auditable."""
    if not isinstance(payload, dict):
        raise ValueError(f"{label} compiler output must be an object")
    allowed = set(model.model_fields)
    discarded = sorted(set(payload) - allowed)
    if discarded:
        issues.append(f"Discarded unsupported {label} fields: {', '.join(discarded)}")
    return {key: value for key, value in payload.items() if key in allowed}


def _mark_ambiguous_resolution_basis(
    constraint: RequirementConstraint,
    issues: list[str],
) -> None:
    """Keep megapixel constraints UNKNOWN when the measured pixel basis is unstated.

    Camera resolution may mean sensor effective pixels or video-output pixels.
    The DSL spec explicitly requires this distinction to remain ambiguous unless
    the source states the measurement basis.
    """
    attribute = constraint.attribute_key.casefold()
    context = " ".join(
        [constraint.attribute_definition, constraint.source_quote or "", constraint.unit or ""]
        + [str(value) for value in constraint.qualifiers.values()]
    ).casefold()
    resolution_like = (
        "resolution" in attribute
        or "pixel" in attribute
        or "分辨率" in context
        or "像素" in context
        or (constraint.unit or "").casefold() == "mp"
    )
    if not resolution_like or constraint.parse_status != ParseStatus.RESOLVED:
        return
    explicit_bases = (
        "输出分辨率", "视频输出", "视频分辨率", "视频输出像素",
        "传感器有效像素", "有效像素", "sensor effective", "image sensor", "video output",
    )
    if any(term in context for term in explicit_bases):
        return
    constraint.attribute_key = "resolution_unspecified"
    constraint.parse_status = ParseStatus.AMBIGUOUS
    constraint.validation_issues.append(
        "Pixel/resolution measurement basis is unspecified (sensor effective pixels vs video output)."
    )
    issues.append(
        f"Constraint {constraint.constraint_id}: resolution measurement basis unspecified; kept AMBIGUOUS."
    )


def _ground_constraint(
    constraint: RequirementConstraint,
    allowed: dict[str, SourceFragment],
    issues: list[str],
) -> None:
    """Remove unverifiable citations and downgrade the constraint safely."""
    fragment = allowed.get(constraint.source_ref or "")
    if fragment is None or not _quote_is_grounded(constraint.source_quote, fragment):
        constraint.source_ref = None
        constraint.source_quote = None
        constraint.parse_status = ParseStatus.AMBIGUOUS
        constraint.validation_issues.append("Compiler citation did not match source text.")
        issues.append(f"Constraint {constraint.constraint_id}: citation failed source-grounding check.")


def _quote_is_grounded(quote: str | None, fragment: SourceFragment | None) -> bool:
    return bool(quote and fragment and quote in fragment.text)


def _origin_for_source(
    locator: str | None,
    allowed: dict[str, SourceFragment],
) -> ConstraintOrigin | None:
    fragment = allowed.get(locator or "")
    if not fragment:
        return None
    if fragment.source_type == RequirementSourceType.USER_TEXT:
        return ConstraintOrigin.USER_EXPLICIT
    if fragment.source_type == RequirementSourceType.INTERNAL_PPTX:
        return ConstraintOrigin.PPT_EXPLICIT
    return None
