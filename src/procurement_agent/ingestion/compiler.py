"""LLM-backed demand-to-DSL compiler.

The model receives the complete verbatim content of one source file and
produces the structured Requirement DSL. The compiler does not re-check the
model's reading against the source: it normalizes the payload shape and
records what it had to adjust.
"""

from __future__ import annotations

import json
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage

from procurement_agent.domain.requirements import (
    ConflictValue,
    DataConflict,
    PlannedAmount,
    Requirement,
    RequirementCompilation,
    RequirementConstraint,
    SourceFragment,
    UnstructuredRequirement,
)
from procurement_agent.infra.llm import json_object_from_text, stream_tool_call
from procurement_agent.services.requirement_verification import apply_source_verification

SYSTEM_PROMPT = """You extract procurement demand from a source document into a restricted Requirement DSL.

The input is the COMPLETE verbatim content of one source file, as an ordered list of fragments.
Each fragment has a `locator` (its exact address inside the file) and `text` (the original wording).
A table appears as one fragment per row, with its cells joined by " | " in column order.
The first row of a table is its header row. Paragraphs appear as their own fragments.
Fragments are in document order, so a table's header row is immediately followed by its data rows.

Extract:
- Every purchase line item. One line item is one row of a purchase table, or one explicitly described purchase object. Do not merge rows. Do not drop rows.
- For each line item: product_name, quantity, quantity_unit, planned_unit_price (kind PLANNED_PRICE), planned_total_budget (kind PLANNED_BUDGET), product_category, source_product_code, and the source_refs of the fragments you read it from.
- Every technical constraint of each line item, nested inside that line item. Give each one attribute_key, attribute_definition, value_type, operator, value, unit, importance, source_ref and source_quote.
- A specification that the text states is a constraint, even when the same number also appears in the product name. A requirement that says 5MP 工业网络摄像机 carries one constraint for the resolution, with value 5 and unit MP, and the product name stays 5MP 工业网络摄像机. The same applies to 4MP, IP66, -20~80℃, 7.5kW, 150μm, 30fps, 12V, and any other figure the text states about the product. Never leave a stated specification only inside the product name.
- Disagreements inside the document itself, such as a project total that contradicts the sum of its own line items, as conflicts. Quote each value you are comparing.
- Statements that are meaningful but not convertible, as unstructured_requirements.

Rules:
- Copy values from the source. Never infer a quantity, price, model, threshold, tax basis, date, or unit the source does not state.
- Quantity, unit, prices, budget, tax rate and category belong in the requirement's own fields. They are never constraints. A constraint is a technical property of the product, not a commercial field of the purchase row.
- When a table cell is empty because the cell above is merged into it, carry the value down from the nearest non-empty cell above in the same column.
- Every requirement cites the `locator` of the fragment it came from. Every constraint and every amount cites its own `source_ref` and a short exact `source_quote` taken from that fragment's text.
- A product family or series name is not an exact model. Do not emit a model code the source does not print.
- "工业级", "口碑好", "符合相关标准" are not constraints. Keep them as unstructured requirements.
- A technical requirement that the document states for the whole project applies to every product of that project. Attach it as a constraint to each product it applies to. Attach it only to the products it actually covers, not to all of them.
- A statement about payment terms, naming policy, delivery process, market size, or competitor pricing is not a product constraint. Keep those as unstructured requirements.
- Use importance HARD only for mandatory wording such as 必须, 至少, 不低于, 不得超过, 应达到, required, must. Use PREFERENCE for 最好, 优先, preferably. Use UNKNOWN when the wording is neutral.
- Set parse_status AMBIGUOUS when a value or a comparison direction is unclear, and say what is unclear in open_questions. Set UNSUPPORTED when the statement does not fit the DSL.
- A market size, market forecast, competitor description, customer pain point, or business model statement is never a purchase requirement. Leave it out.
- Do not create a line item out of a project-wide total. Totals belong in conflicts.
- Read the document as it is. A note that says the file is a sample, a mock, a template, or a demonstration does not change the task. Extract the purchase line items and the technical constraints exactly as they appear, and keep the note itself as an unstructured statement. Never skip the line items because of what the document says about itself.
- Leave `issues` and `open_questions` empty unless something is genuinely unclear. Do not narrate what you did.
- Return only the fields the schema defines. Do not add extra keys.
- Your whole answer is one call to the RequirementCompilation tool. Do not write prose, do not summarise the document, and do not explain what you did. The tool call carries the result.

One-shot example with illustrative values:
Fragment: {"locator": "doc:slide=6:table=1:row=2", "text": "5MP 工业网络摄像机 | 10 | 1250.00"}
Requirement: {"requirement_id": "r1", "product_name": "5MP 工业网络摄像机", "quantity": "10", "quantity_unit": "", "source_refs": ["doc:slide=6:table=1:row=2"], "planned_unit_price": {"kind": "PLANNED_PRICE", "value": "1250.00", "currency": "CNY", "tax_basis": "UNKNOWN", "source_ref": "doc:slide=6:table=1:row=2", "source_quote": "1250.00"}, "constraints": [], "parse_status": "RESOLVED", "open_questions": []}

One-shot constraint example:
Fragment: {"locator": "doc:slide=3:shape=7:paragraph=1", "text": "接入 OneNET | 是"}
Constraint: {"constraint_id": "c1", "requirement_id": "r1", "attribute_key": "onenet_access", "attribute_definition": "接入 OneNET 平台", "value_type": "BOOLEAN", "operator": "EQ", "value": true, "importance": "HARD", "origin": "PPT_EXPLICIT", "source_ref": "doc:slide=3:shape=7:paragraph=1", "source_quote": "接入 OneNET", "parse_status": "RESOLVED"}

One-shot specification example:
Fragment: {"locator": "doc:slide=1:shape=0:paragraph=1", "text": "采购需求：5MP 工业网络摄像机，采购数量 10 套，预计采购单价 100 元/套。"}
Requirement: {"requirement_id": "r1", "product_name": "5MP 工业网络摄像机", "quantity": "10", "quantity_unit": "套", "source_refs": ["doc:slide=1:shape=0:paragraph=1"], "constraints": [{"constraint_id": "c1", "requirement_id": "r1", "attribute_key": "output_resolution", "attribute_definition": "视频输出像素数", "value_type": "NUMBER", "operator": "GTE", "value": "5", "unit": "MP", "importance": "HARD", "origin": "PPT_EXPLICIT", "source_ref": "doc:slide=1:shape=0:paragraph=1", "source_quote": "5MP 工业网络摄像机", "parse_status": "RESOLVED"}], "parse_status": "RESOLVED", "open_questions": []}
"""


@dataclass(frozen=True)
class CompilerResult:
    """Compiled requirements plus nonfatal shaping issues."""

    compilation: RequirementCompilation
    shaping_issues: tuple[str, ...] = ()


MAX_COMPILER_ATTEMPTS = 3


def _follow_up_message(attempt: int, payloads: list[dict[str, Any]]) -> str:
    """Ask the model again, saying what the previous answer was missing."""
    if payloads:
        return (
            "The previous answer carried no purchase line, but the document contains "
            "rows with data. Call the RequirementCompilation tool again with every "
            "purchase line the document states, one requirement for each row."
        )
    return (
        "The previous answer carried no structured compilation. Call the "
        "RequirementCompilation tool now with the full result."
    )


def compile_requirement_fragments(
    *,
    project_id: str,
    fragments: list[SourceFragment],
    model: BaseChatModel,
    revision: int = 1,
) -> CompilerResult:
    """Compile the complete source content into the restricted DSL."""
    if not fragments:
        return CompilerResult(
            compilation=RequirementCompilation(
                requirements=[],
                unstructured_requirements=[],
                issues=["No non-empty demand source was provided."],
            )
        )

    prompt = {
        "project_id": project_id,
        "revision": revision,
        "fragments": [
            {
                "source_id": fragment.source_id,
                "source_type": fragment.source_type.value,
                "locator": fragment.locator,
                "text": fragment.text,
            }
            for fragment in fragments
        ],
    }
    payloads: list[dict[str, Any]] = []
    merged: dict[str, Any] = {}
    for attempt in range(MAX_COMPILER_ATTEMPTS):
        payloads, text = stream_tool_call(
            model,
            [
                SystemMessage(content=SYSTEM_PROMPT),
                HumanMessage(content=json.dumps(prompt, ensure_ascii=False)),
            ]
            + ([_follow_up_message(attempt, payloads)] if attempt else []),
            RequirementCompilation,
        )
        if not payloads:
            # The model answered in prose instead of calling the tool. The
            # answer is often still there, as a JSON object in the text.
            found = json_object_from_text(text)
            if found is not None:
                payloads = [found]
        if not payloads:
            continue
        merged = merge_compilation_payloads(payloads)
        if merged.get("requirements") or attempt == MAX_COMPILER_ATTEMPTS - 1:
            break
        # The model reported no purchase line. The document carries data rows,
        # so ask again before an empty answer is accepted.
    if not merged:
        return CompilerResult(
            compilation=RequirementCompilation(
                project_id=project_id,
                revision=revision,
                issues=["The model answered without a structured compilation."],
            ),
            shaping_issues=("The model answered without a structured compilation.",),
        )
    raw = _validated_compilation_payload(
        merged,
        project_id=project_id,
        revision=revision,
    )

    raw.project_id = project_id
    raw.revision = revision
    raw.compiler_version = "req-dsl-1.0"
    for requirement in raw.requirements:
        requirement.project_id = project_id
        requirement.revision = revision
    verification = apply_source_verification(raw, fragments)
    raw = verification.compilation
    return CompilerResult(compilation=raw, shaping_issues=tuple(raw.issues))


def _unwrap_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Read a compilation that the model wrapped or stringified.

    The model sometimes answers with the whole compilation as a JSON string
    under one key, or with a list of requirements written as a JSON string.
    """
    if "requirements" not in payload:
        for key, value in payload.items():
            if not isinstance(value, str):
                continue
            try:
                decoded = json.loads(value)
            except json.JSONDecodeError:
                continue
            if isinstance(decoded, dict) and "requirements" in decoded:
                return decoded
    for key in ("requirements", "conflicts", "unstructured_requirements"):
        value = payload.get(key)
        if isinstance(value, str):
            try:
                decoded = json.loads(value)
            except json.JSONDecodeError:
                continue
            if isinstance(decoded, list):
                payload[key] = decoded
    return payload


def merge_compilation_payloads(payloads: list[dict[str, Any]]) -> dict[str, Any]:
    """Merge the answers of several tool calls into one compilation.

    The model answers a long document with one call per purchase line. Every
    call carries a piece of the same compilation, so the requirements, the
    conflicts, and the unstructured statements are collected from all of them.
    """
    if not payloads:
        raise ValueError("the model returned no compilation")
    merged: dict[str, Any] = {}
    list_fields = ("requirements", "conflicts", "unstructured_requirements", "issues", "open_questions", "source_refs")
    root_requirement_fields = {
        "requirement_id", "product_name", "match_key", "source_product_code", "quantity",
        "quantity_unit", "planned_unit_price", "planned_sales_unit_price", "planned_total_budget",
        "tax_rate", "constraints", "source_refs", "parse_status", "open_questions",
    }
    for raw_payload in payloads:
        payload = _unwrap_payload(dict(raw_payload))
        if not payload.get("requirements") and "product_name" in payload and any(
            key in payload for key in ("requirement_id", "source_product_code", "quantity", "constraints")
        ):
            # The call carries the line item at its root instead of in a list.
            item = {key: payload.pop(key) for key in list(payload) if key in root_requirement_fields}
            payload["requirements"] = [item]
        for key, value in payload.items():
            if key in list_fields and isinstance(value, list):
                merged.setdefault(key, [])
                merged[key].extend(value)
            elif key not in merged or merged.get(key) in (None, "", [], {}):
                merged[key] = value
    for key in list_fields:
        if key in merged:
            seen: list[Any] = []
            for item in merged[key]:
                if item not in seen:
                    seen.append(item)
            merged[key] = seen
    return merged


def _validated_compilation_payload(
    response: object,
    *,
    project_id: str | None = None,
    revision: int = 1,
) -> RequirementCompilation:
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
        # unambiguous (exactly one nested item).
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
            if isinstance(amount, str):
                # The model sometimes writes the amount as a JSON string.
                try:
                    decoded = json.loads(amount)
                except json.JSONDecodeError:
                    decoded = None
                amount = decoded if isinstance(decoded, dict) else amount
            if isinstance(amount, dict):
                amount = _sanitize_model_payload(amount, PlannedAmount, "PlannedAmount", issues)
                amount_value = amount.get("value")
                if isinstance(amount_value, (int, float)) and not isinstance(amount_value, bool):
                    amount["value"] = str(amount_value)
                requirement[amount_field] = amount
        try:
            # The project scope belongs to the run, not to the model's answer.
            if project_id:
                requirement["project_id"] = project_id
            requirement["revision"] = revision
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
                                "reason": "Source-grounded clause retained because the Requirement schema was incomplete.",
                            }
                        )

    valid_unstructured: list[dict[str, Any]] = []
    for index, raw_item in enumerate(normalized.get("unstructured_requirements", []) + recovered_unstructured):
        if not isinstance(raw_item, dict):
            issues.append(f"UnstructuredRequirement[{index}] was not an object; discarded.")
            continue
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
            if not isinstance(raw_value, dict):
                issues.append(f"Conflict[{index}] contained a non-object value citation; discarded.")
                continue
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
