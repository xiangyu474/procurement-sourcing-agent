"""Versioned, source-grounded procurement requirement DSL.

M1 only defines and validates this DSL. It deliberately does not evaluate
supplier claims or calculate PASS/FAIL; that is a later milestone.
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class RequirementSourceType(StrEnum):
    """Supported demand sources."""

    USER_TEXT = "USER_TEXT"
    INTERNAL_PPTX = "INTERNAL_PPTX"


class InputPurpose(StrEnum):
    """Why a file or text record was attached to a project."""

    REQUIREMENT = "REQUIREMENT"
    HISTORY = "HISTORY"
    SUPPORTING_EVIDENCE = "SUPPORTING_EVIDENCE"


class ParseStatus(StrEnum):
    """Whether a natural-language requirement can be represented safely."""

    RESOLVED = "RESOLVED"
    AMBIGUOUS = "AMBIGUOUS"
    UNSUPPORTED = "UNSUPPORTED"


class Importance(StrEnum):
    """Priority explicitly stated by a user or document."""

    HARD = "HARD"
    PREFERENCE = "PREFERENCE"
    UNKNOWN = "UNKNOWN"


class ConstraintOrigin(StrEnum):
    """Provenance category for a requirement constraint."""

    USER_EXPLICIT = "USER_EXPLICIT"
    PPT_EXPLICIT = "PPT_EXPLICIT"
    PROJECT_POLICY = "PROJECT_POLICY"
    INFERRED_FOR_REVIEW = "INFERRED_FOR_REVIEW"


class ValueType(StrEnum):
    """Allowed value types in the restricted DSL."""

    NUMBER = "NUMBER"
    BOOLEAN = "BOOLEAN"
    STRING = "STRING"
    SET = "SET"
    RANGE = "RANGE"


class ConstraintOperator(StrEnum):
    """Explicitly supported operators; no arbitrary expression execution."""

    GTE = "GTE"
    LTE = "LTE"
    EQ = "EQ"
    NE = "NE"
    IN = "IN"
    CONTAINS = "CONTAINS"
    RANGE_COVERS = "RANGE_COVERS"


class TaxBasis(StrEnum):
    """Whether a stated planned amount is tax-inclusive."""

    INCLUSIVE = "INCLUSIVE"
    EXCLUSIVE = "EXCLUSIVE"
    UNKNOWN = "UNKNOWN"


class HistoryAvailability(StrEnum):
    """Whether a project has imported internal purchase history."""

    NOT_PROVIDED = "NOT_PROVIDED"
    IMPORTED = "IMPORTED"
    IMPORT_FAILED = "IMPORT_FAILED"


class SourceFragment(BaseModel):
    """A small, precisely located text fragment passed to the compiler."""

    model_config = ConfigDict(extra="forbid")

    source_id: str
    source_type: RequirementSourceType
    locator: str
    text: str
    revision: int = 1


class RequirementConstraint(BaseModel):
    """One atomic, source-grounded requirement in the restricted DSL."""

    model_config = ConfigDict(extra="forbid")

    constraint_id: str
    requirement_id: str
    schema_version: str = "1.0"
    attribute_key: str
    attribute_definition: str
    value_type: ValueType
    operator: ConstraintOperator
    value: Any
    unit: str | None = None
    qualifiers: dict[str, str | int | bool] = Field(default_factory=dict)
    importance: Importance = Importance.UNKNOWN
    origin: ConstraintOrigin
    source_ref: str | None = None
    source_quote: str | None = None
    parse_status: ParseStatus = ParseStatus.RESOLVED
    revision: int = 1
    validation_issues: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_restricted_value(self) -> "RequirementConstraint":
        """Reject values/operators outside the constrained DSL."""
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", self.attribute_key):
            raise ValueError("attribute_key must be a normalized snake_case identifier")
        if self.parse_status == ParseStatus.RESOLVED and (
            not self.source_ref or not self.source_ref.strip()
            or not self.source_quote or not self.source_quote.strip()
        ):
            raise ValueError("resolved constraints require source_ref and source_quote")
        if self.origin == ConstraintOrigin.INFERRED_FOR_REVIEW and self.importance == Importance.HARD:
            raise ValueError("inferred constraints cannot be marked HARD")

        allowed = {
            ValueType.NUMBER: {ConstraintOperator.GTE, ConstraintOperator.LTE, ConstraintOperator.EQ, ConstraintOperator.NE},
            ValueType.BOOLEAN: {ConstraintOperator.EQ, ConstraintOperator.NE},
            ValueType.STRING: {ConstraintOperator.EQ, ConstraintOperator.NE, ConstraintOperator.IN},
            ValueType.SET: {ConstraintOperator.CONTAINS, ConstraintOperator.IN},
            ValueType.RANGE: {ConstraintOperator.RANGE_COVERS},
        }
        if self.operator not in allowed[self.value_type]:
            raise ValueError(f"operator {self.operator} is invalid for {self.value_type}")

        if self.value_type == ValueType.NUMBER:
            _decimal_string(self.value, "NUMBER value")
        elif self.value_type == ValueType.BOOLEAN and not isinstance(self.value, bool):
            raise ValueError("BOOLEAN value must be a JSON boolean")
        elif self.value_type == ValueType.STRING and not isinstance(self.value, str):
            if self.operator != ConstraintOperator.IN or not _string_list(self.value):
                raise ValueError("STRING value must be text; IN requires a list of strings")
        elif self.value_type == ValueType.SET and not _string_list(self.value):
            raise ValueError("SET value must be a non-empty list of strings")
        elif self.value_type == ValueType.RANGE:
            _validate_range(self.value)
        return self


def _decimal_string(value: Any, label: str) -> Decimal:
    """Parse a finite decimal from the DSL's canonical string format."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be stored as a decimal string")
    try:
        result = Decimal(value)
    except InvalidOperation as exc:
        raise ValueError(f"{label} is not a valid decimal string") from exc
    if not result.is_finite():
        raise ValueError(f"{label} must be finite")
    return result


def _string_list(value: Any) -> bool:
    return isinstance(value, list) and bool(value) and all(isinstance(item, str) and item for item in value)


def _validate_range(value: Any) -> None:
    """Validate a closed DSL range without evaluating it."""
    if not isinstance(value, dict) or set(value) - {
        "lower", "upper", "lower_inclusive", "upper_inclusive"
    }:
        raise ValueError("RANGE value must contain only lower/upper and inclusivity flags")
    if value.get("lower") is None and value.get("upper") is None:
        raise ValueError("RANGE requires at least one bound")
    for bound in ("lower", "upper"):
        if value.get(bound) is not None:
            _decimal_string(value[bound], f"RANGE {bound}")
    for flag in ("lower_inclusive", "upper_inclusive"):
        if flag in value and not isinstance(value[flag], bool):
            raise ValueError(f"RANGE {flag} must be a boolean")


class PlannedAmount(BaseModel):
    """A planned unit price or budget, never a historical/public quotation."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["PLANNED_PRICE", "PLANNED_BUDGET", "PLANNED_SALES_PRICE"] = "PLANNED_PRICE"
    value: str
    currency: str = "CNY"
    unit: str | None = None
    tax_basis: TaxBasis = TaxBasis.UNKNOWN
    tax_rate: str | None = None
    source_ref: str
    source_quote: str

    @model_validator(mode="after")
    def validate_value(self) -> "PlannedAmount":
        _decimal_string(self.value, "planned amount")
        return self


class Requirement(BaseModel):
    """A single procurement line item, independent of optional history."""

    model_config = ConfigDict(extra="forbid")

    requirement_id: str
    project_id: str
    revision: int = 1
    match_key: str | None = None
    product_name: str
    product_category: str | None = None
    source_product_code: str | None = None
    quantity: str | None = None
    quantity_unit: str | None = None
    planned_unit_price: PlannedAmount | None = None
    planned_sales_unit_price: PlannedAmount | None = None
    planned_total_budget: PlannedAmount | None = None
    tax_rate: str | None = None
    constraints: list[RequirementConstraint] = Field(default_factory=list)
    source_refs: list[str] = Field(default_factory=list)
    parse_status: ParseStatus = ParseStatus.RESOLVED
    open_questions: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_quantity(self) -> "Requirement":
        if self.quantity is not None:
            _decimal_string(self.quantity, "quantity")
        return self


class UnstructuredRequirement(BaseModel):
    """A meaningful demand statement that cannot safely become a DSL constraint."""

    model_config = ConfigDict(extra="forbid")

    text: str
    source_ref: str | None = None
    source_quote: str | None = None
    parse_status: ParseStatus = ParseStatus.UNSUPPORTED
    reason: str


class RequirementCompilation(BaseModel):
    """Structured compiler output prior to source-grounding checks."""

    model_config = ConfigDict(extra="forbid")

    project_id: str | None = None
    revision: int = 1
    project_scope: str | None = None
    project_category: str | None = None
    parse_status: ParseStatus | None = None
    source_refs: list[str] = Field(default_factory=list)
    requirements: list[Requirement] = Field(default_factory=list)
    unstructured_requirements: list[UnstructuredRequirement] = Field(default_factory=list)
    conflicts: list["DataConflict"] = Field(default_factory=list)
    open_questions: list[str] = Field(default_factory=list)
    compiler_version: str = "req-dsl-1.0"
    issues: list[str] = Field(default_factory=list)


class ConflictValue(BaseModel):
    """One conflicting value and its source locator(s)."""

    value: str
    source_ref: str
    source_quote: str
    source_refs: list[str] = Field(default_factory=list)


class DataConflict(BaseModel):
    """Explicit conflict between project requirement sources."""

    model_config = ConfigDict(extra="forbid")

    conflict_id: str
    project_id: str
    requirement_id: str | None = None
    field: str
    values_with_source: list[ConflictValue]
    severity: str = "REVIEW_REQUIRED"
    status: str = "UNRESOLVED"


class HistoricalTransaction(BaseModel):
    """A single internally imported row with its immutable source coordinate."""

    transaction_id: str
    dataset_id: str
    project_id: str
    source_row_ref: str
    order_id: str | None = None
    line_id: str | None = None
    order_date: str | None = None
    sku: str | None = None
    product_name: str | None = None
    specification: str | None = None
    supplier_code: str | None = None
    supplier_display_name: str | None = None
    supplier_entity_id: str | None = None
    supplier_namespace: str
    is_synthetic_supplier: bool
    quantity: str | None = None
    unit_price_ex_tax: str | None = None
    amount_ex_tax: str | None = None
    tax_rate: str | None = None
    tax_amount: str | None = None
    amount_inc_tax: str | None = None
    currency: str | None = None
    raw_values: dict[str, Any] = Field(default_factory=dict)


class HistoryImportResult(BaseModel):
    """Summary of one independent history workbook import."""

    dataset_id: str
    project_id: str
    source_file_name: str
    sha256: str
    sheet_name: str
    header_row: int
    column_count: int
    row_count: int
    is_synthetic: bool
    supplier_namespace: str
    schema_mapping_version: str
    duplicate_import: bool = False
    warnings: list[str] = Field(default_factory=list)
    transactions: list[HistoricalTransaction] = Field(default_factory=list)


class DemandIntakeResult(BaseModel):
    """Canonical M1 result for demand plus independently optional history."""

    project_id: str
    analysis_version: int
    source_refs: list[str] = Field(default_factory=list)
    requirements: list[Requirement] = Field(default_factory=list)
    conflicts: list[DataConflict] = Field(default_factory=list)
    unstructured_requirements: list[UnstructuredRequirement] = Field(default_factory=list)
    history_availability: HistoryAvailability = HistoryAvailability.NOT_PROVIDED
    history_dataset_id: str | None = None
    issues: list[str] = Field(default_factory=list)
