"""M2 sourcing plans, public intelligence and evidence-ledger contracts.

Public supplier intelligence is reusable research, not procurement qualification.
Project candidates are rebuilt for each run and never inherit another project's
technical or commercial decision.
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime
from enum import StrEnum
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class SourcingGoal(StrEnum):
    NEW_SUPPLIER = "NEW_SUPPLIER"
    ALTERNATE_SOURCE = "ALTERNATE_SOURCE"
    MARKET_BENCHMARK = "MARKET_BENCHMARK"
    QUALIFICATION_PRE_SCREEN = "QUALIFICATION_PRE_SCREEN"
    UNKNOWN = "UNKNOWN"


class ProvenanceType(StrEnum):
    USER_EXPLICIT = "USER_EXPLICIT"
    DOCUMENT_EXPLICIT = "DOCUMENT_EXPLICIT"
    PROJECT_POLICY = "PROJECT_POLICY"
    INFERRED_FOR_REVIEW = "INFERRED_FOR_REVIEW"


class ChannelHint(StrEnum):
    MANUFACTURER_DIRECT = "MANUFACTURER_DIRECT"
    PRODUCT_DATASHEET = "PRODUCT_DATASHEET"
    B2B_DIRECTORY = "B2B_DIRECTORY"
    EXHIBITOR_DIRECTORY = "EXHIBITOR_DIRECTORY"
    COMPETITOR_DISCOVERY = "COMPETITOR_DISCOVERY"
    PUBLIC_CORPORATE_DISCLOSURE = "PUBLIC_CORPORATE_DISCLOSURE"
    OFFICIAL_REGISTRY = "OFFICIAL_REGISTRY"
    GENERAL_WEB = "GENERAL_WEB"


class RequirementAssociationOrigin(StrEnum):
    PLAN_EXPLICIT = "PLAN_EXPLICIT"
    SINGLE_REQUIREMENT_FALLBACK = "SINGLE_REQUIREMENT_FALLBACK"
    SUPERVISOR_FOLLOWUP = "SUPERVISOR_FOLLOWUP"
    UNASSOCIATED_IGNORED = "UNASSOCIATED_IGNORED"


class CandidateStage(StrEnum):
    DISCOVERED_LONG_LIST = "DISCOVERED_LONG_LIST"
    SCREENED = "SCREENED"
    NEEDS_VERIFICATION = "NEEDS_VERIFICATION"
    RFQ_SHORTLIST = "RFQ_SHORTLIST"
    EXCLUDED = "EXCLUDED"


class ResearchRunStatus(StrEnum):
    COMPLETED = "COMPLETED"
    PARTIAL = "PARTIAL"
    FAILED = "FAILED"


class IdentityStatus(StrEnum):
    DISCOVERED_UNVERIFIED = "DISCOVERED_UNVERIFIED"
    OFFICIAL_RECORD_MATCHED = "OFFICIAL_RECORD_MATCHED"
    CONFLICTING = "CONFLICTING"
    UNKNOWN = "UNKNOWN"


class ReuseDecision(StrEnum):
    REUSE = "REUSE"
    REFRESH = "REFRESH"
    IGNORE = "IGNORE"


class ClaimStatus(StrEnum):
    SUPPORTED_BY_SOURCE = "SUPPORTED_BY_SOURCE"
    CONTRADICTED_BY_SOURCE = "CONTRADICTED_BY_SOURCE"
    UNVERIFIED = "UNVERIFIED"
    ASSUMED = "ASSUMED"


class SubjectType(StrEnum):
    SUPPLIER = "SUPPLIER"
    PRODUCT_MODEL = "PRODUCT_MODEL"


class ResearchBudget(BaseModel):
    """Shared, run-level hard caps; researchers do not receive separate budgets."""

    model_config = ConfigDict(extra="forbid")

    max_search_calls: int = Field(default=8, ge=1, le=12)
    max_fetches: int = Field(default=8, ge=1, le=24)
    max_tasks: int = Field(default=3, ge=1, le=3)
    max_rounds: int = Field(default=2, ge=1, le=3)
    max_model_calls: int = Field(default=18, ge=1, le=30)


class ResearchQuestion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question_id: str
    requirement_id: str
    association_origin: RequirementAssociationOrigin = RequirementAssociationOrigin.PLAN_EXPLICIT
    question: str = Field(min_length=8, max_length=500)
    channel: ChannelHint
    expected_evidence: list[str] = Field(min_length=1, max_length=8)
    rationale: str = Field(min_length=8, max_length=600)


class ResearchQuestionProposal(BaseModel):
    """Lenient LLM boundary proposal; canonical ResearchQuestion remains strict."""

    model_config = ConfigDict(extra="ignore")

    question_id: str | None = None
    requirement_id: str | None = None
    question: str = Field(min_length=8, max_length=500)
    channel: ChannelHint
    expected_evidence: list[str] = Field(min_length=1, max_length=8)
    rationale: str = Field(min_length=8, max_length=600)


class ReuseDecisionProposal(BaseModel):
    """LLM output describing whether an existing public lead applies to a Requirement."""

    model_config = ConfigDict(extra="ignore")

    intelligence_id: str
    decision: ReuseDecision
    rationale: str = Field(min_length=8, max_length=500)
    requirement_id: str | None = None


class IntelligenceReuseDecision(BaseModel):
    """Canonical, persisted reuse/refresh/ignore decision with requirement provenance."""

    model_config = ConfigDict(extra="forbid")

    intelligence_id: str
    decision: ReuseDecision
    rationale: str = Field(min_length=8, max_length=500)
    requirement_id: str | None = None
    association_origin: RequirementAssociationOrigin


class SourcingPlanProposal(BaseModel):
    """Lenient LLM boundary proposal; deterministic code creates a strict canonical SourcingPlan."""

    model_config = ConfigDict(extra="ignore")

    goal: SourcingGoal
    goal_origin: ProvenanceType
    target_markets: list[str] = Field(default_factory=list, max_length=10)
    target_markets_origin: ProvenanceType | None = None
    prioritized_requirement_ids: list[str] = Field(min_length=1, max_length=50)
    proposed_channels: list[ChannelHint] = Field(min_length=1, max_length=8)
    research_questions: list[ResearchQuestionProposal] = Field(min_length=1, max_length=12)
    rationale: str = Field(min_length=8, max_length=1500)
    assumptions_for_review: list[str] = Field(default_factory=list, max_length=20)
    missing_material_inputs: list[str] = Field(default_factory=list, max_length=20)
    reuse_decisions: list[ReuseDecisionProposal] = Field(default_factory=list, max_length=50)
    stopping_criteria: list[str] = Field(min_length=1, max_length=12)


class SourcingPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    plan_id: str
    project_id: str
    run_id: str
    plan_revision: int = Field(default=1, ge=1)
    revision_reason: str | None = None
    goal: SourcingGoal
    goal_origin: ProvenanceType
    target_markets: list[str] = Field(default_factory=list, max_length=10)
    target_markets_origin: ProvenanceType | None = None
    prioritized_requirement_ids: list[str] = Field(min_length=1, max_length=50)
    proposed_channels: list[ChannelHint] = Field(min_length=1, max_length=8)
    research_questions: list[ResearchQuestion] = Field(min_length=1, max_length=12)
    rationale: str = Field(min_length=8, max_length=1500)
    assumptions_for_review: list[str] = Field(default_factory=list, max_length=20)
    missing_material_inputs: list[str] = Field(default_factory=list, max_length=20)
    reuse_intelligence_ids: list[str] = Field(default_factory=list, max_length=50)
    refresh_intelligence_ids: list[str] = Field(default_factory=list, max_length=50)
    ignored_intelligence_ids: list[str] = Field(default_factory=list, max_length=50)
    reuse_decisions: list[IntelligenceReuseDecision] = Field(default_factory=list, max_length=100)
    stopping_criteria: list[str] = Field(min_length=1, max_length=12)
    budget: ResearchBudget = Field(default_factory=ResearchBudget)
    created_at: datetime

    @field_validator("created_at")
    @classmethod
    def aware_creation_time(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("created_at must be timezone-aware")
        return value

    @model_validator(mode="after")
    def validate_plan_questions(self) -> SourcingPlan:
        requirement_ids = set(self.prioritized_requirement_ids)
        if any(question.requirement_id not in requirement_ids for question in self.research_questions):
            raise ValueError("research questions must reference a prioritized requirement")
        if any(
            decision.decision != ReuseDecision.IGNORE
            and (decision.requirement_id is None or decision.requirement_id not in requirement_ids)
            for decision in self.reuse_decisions
        ):
            raise ValueError("REUSE/REFRESH decisions must reference a prioritized Requirement")
        if self.plan_revision > 1 and not (self.revision_reason or "").strip():
            raise ValueError("revised plans require a revision_reason")
        if self.target_markets and self.target_markets_origin is None:
            raise ValueError("target market assumptions require a provenance marker")
        return self


class EvidenceRecord(BaseModel):
    """Immutable fetched source metadata; full text is separately persisted to R2."""

    model_config = ConfigDict(extra="forbid")

    evidence_id: str
    workspace_id: str
    source_type: str = "PUBLIC_WEB"
    source_url: str
    normalized_url: str
    title: str = Field(max_length=500)
    publisher: str | None = None
    retrieved_at: datetime
    locator: str
    excerpt: str = Field(min_length=1, max_length=4000)
    content_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    content_date_hints: list[str] = Field(default_factory=list, max_length=20)
    snapshot_text: str = Field(min_length=1, max_length=100_000, exclude=True)
    trust_notes: str = "Public source; statements are attributed to the publisher, not independently verified. Date mentions are unverified hints, not publication dates."

    @field_validator("retrieved_at")
    @classmethod
    def aware_retrieval_time(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("retrieved_at must be timezone-aware")
        return value


class SupplierIntelligenceRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    supplier_id: str
    workspace_id: str
    display_name: str = Field(min_length=1, max_length=300)
    website_domain: str | None = None
    identity_status: IdentityStatus = IdentityStatus.DISCOVERED_UNVERIFIED
    role: str | None = None
    first_observed_at: datetime
    last_observed_at: datetime
    evidence_ids: list[str] = Field(default_factory=list)

    @field_validator("website_domain")
    @classmethod
    def normalized_website_domain(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = canonical_domain(value)
        if normalized is None:
            raise ValueError("website_domain must be a valid public hostname")
        return normalized


class ProductIntelligenceRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    product_id: str
    workspace_id: str
    product_name: str = Field(min_length=1, max_length=300)
    brand: str | None = Field(default=None, max_length=200)
    model: str | None = Field(default=None, max_length=200)
    product_category: str | None = Field(default=None, max_length=200)
    first_observed_at: datetime
    last_observed_at: datetime
    evidence_ids: list[str] = Field(default_factory=list)


class SupplierProductOffering(BaseModel):
    model_config = ConfigDict(extra="forbid")

    offering_id: str
    workspace_id: str
    supplier_id: str
    product_id: str
    relationship_status: str = "UNCONFIRMED"
    evidence_ids: list[str] = Field(min_length=1)


class ClaimDraft(BaseModel):
    """A source-attributed statement, not an independently verified fact."""

    model_config = ConfigDict(extra="forbid")

    claim_id: str
    subject_type: SubjectType
    subject_ref: str
    attribute: str = Field(min_length=1, max_length=120)
    value: str = Field(min_length=1, max_length=1000)
    unit: str | None = Field(default=None, max_length=100)
    evidence_id: str
    source_quote: str = Field(min_length=8, max_length=1000)
    status: ClaimStatus = ClaimStatus.SUPPORTED_BY_SOURCE
    evaluation_method: str = "EXCERPT_MATCH"


class ResearchCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    candidate_id: str
    requirement_id: str
    supplier_id: str
    product_id: str | None = None
    stage: CandidateStage = CandidateStage.DISCOVERED_LONG_LIST
    rationale: str = Field(min_length=8, max_length=1000)
    evidence_ids: list[str] = Field(min_length=1)
    open_questions: list[str] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def do_not_promote_from_research(self) -> ResearchCandidate:
        if self.stage != CandidateStage.DISCOVERED_LONG_LIST:
            raise ValueError("M2 research may create only DISCOVERED_LONG_LIST candidates")
        return self


class ClaimProposal(BaseModel):
    """LLM-proposed claim before deterministic evidence and identity validation."""

    model_config = ConfigDict(extra="forbid")

    attribute: str = Field(min_length=1, max_length=120)
    value: str = Field(min_length=1, max_length=200, description="A specific source statement; do not infer from product category or model similarity.")
    unit: str | None = Field(default=None, max_length=100)
    evidence_id: str = Field(description="Must be an evidence_id returned by fetch_public_source.")
    source_quote: str = Field(min_length=8, max_length=300, description="Short exact substring from this evidence snapshot, not a search snippet or paraphrase.")


class CandidateClaim(BaseModel):
    """Model-facing claim. Unknown fields are ignored so one stray key does not void the answer."""

    model_config = ConfigDict(extra="ignore")

    supplier_name: str = Field(min_length=1, max_length=300, description="Exact supplier/brand name as shown in the cited source.")
    supplier_name_quote: str = Field(min_length=4, max_length=500, description="Verbatim substring of supplier_evidence_id content that contains supplier_name.")
    supplier_website_domain: str | None = Field(default=None, max_length=253, description="Use only when this source is hosted on the supplier's own website; otherwise null.")
    supplier_role_claim: str | None = Field(default=None, max_length=100)
    supplier_evidence_id: str
    product_name: str = Field(min_length=1, max_length=300, description="Product name or exact line title shown by the source, not an invented category.")
    product_name_quote: str = Field(min_length=4, max_length=500, description="Verbatim substring of product_evidence_id content identifying this product/line.")
    brand: str | None = Field(default=None, max_length=200, description="Set only when the source explicitly shows the brand; otherwise null.")
    brand_quote: str | None = Field(default=None, max_length=300, description="Verbatim source substring containing brand; required when brand is set.")
    model: str | None = Field(default=None, max_length=200, description="Exact order/model code only; a family or series name alone is not a model.")
    model_quote: str | None = Field(default=None, max_length=300, description="Short verbatim source substring containing the exact model code; required when model is set.")
    product_category: str | None = Field(default=None, max_length=200)
    product_evidence_id: str
    product_claims: list[ClaimProposal] = Field(default_factory=list, max_length=2)
    supplier_claims: list[ClaimProposal] = Field(default_factory=list, max_length=1)
    rationale: str = Field(min_length=8, max_length=800, description="Keep concise, ideally under 200 characters; state only what the cited sources establish.")
    unresolved_gaps: list[str] = Field(default_factory=list, max_length=6)

    @model_validator(mode="after")
    def exact_model_requires_source_quote(self) -> CandidateClaim:
        if self.model and not self.model_quote:
            raise ValueError("an exact model requires a source quote")
        if self.brand and not self.brand_quote:
            raise ValueError("a brand requires a source quote")
        return self

    @field_validator("supplier_website_domain")
    @classmethod
    def normalized_supplier_domain(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = canonical_domain(value)
        if normalized is None:
            raise ValueError("supplier_website_domain must be a hostname or URL")
        return normalized


class ResearchFindings(BaseModel):
    """Model-facing findings. Unknown fields are ignored so one stray key does not void the answer."""

    model_config = ConfigDict(extra="ignore")

    task_id: str = Field(description="Copy the exact question_id of the delegated SourcingPlan task.")
    research_question: str = Field(description="Copy the exact approved question text from the plan.")
    candidate_claims: list[CandidateClaim] = Field(default_factory=list, max_length=3)
    evidence_ids: list[str] = Field(default_factory=list, max_length=10, description="Only evidence IDs returned by fetch_public_source in this task.")
    product_model_refs: list[str] = Field(default_factory=list, max_length=6)
    unresolved_gaps: list[str] = Field(default_factory=list, max_length=8)
    search_cost: int = Field(default=0, ge=0)
    fetch_cost: int = Field(default=0, ge=0)
    coverage_notes: str = Field(max_length=1200, description="Keep concise, ideally under 200 characters; mention evidence coverage and key gaps only.")
    stage: CandidateStage = CandidateStage.DISCOVERED_LONG_LIST


class ModelCallMetric(BaseModel):
    model_config = ConfigDict(extra="forbid")

    call_id: str
    stage: str
    duration_ms: int = Field(ge=0)
    prompt_tokens: int = Field(default=0, ge=0)
    completion_tokens: int = Field(default=0, ge=0)
    token_usage_observed: bool = False
    error_type: str | None = None


class ResearchAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action_id: str
    run_id: str
    task_id: str
    research_question: str
    channel: ChannelHint
    tool_name: str
    query: str | None = None
    result_refs: list[str] = Field(default_factory=list)
    remaining_gaps: list[str] = Field(default_factory=list)
    decision: str
    cost_search_calls: int = Field(default=0, ge=0)
    cost_fetch_calls: int = Field(default=0, ge=0)
    occurred_at: datetime

    @field_validator("occurred_at")
    @classmethod
    def aware_occurrence_time(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("occurred_at must be timezone-aware")
        return value


class ResearchTask(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_id: str
    research_question: str
    channel: ChannelHint
    requirement_ids: list[str]
    expected_evidence: list[str]
    status: str = "COMPLETED"
    findings: ResearchFindings | None = None


class ResearchRunBundle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    workspace_id: str = "default"
    project_id: str
    run_id: str
    status: ResearchRunStatus = ResearchRunStatus.COMPLETED
    stop_reason_code: str | None = None
    plan: SourcingPlan
    plan_history: list[SourcingPlan] = Field(default_factory=list, max_length=3)
    tasks: list[ResearchTask] = Field(default_factory=list, max_length=3)
    suppliers: list[SupplierIntelligenceRecord] = Field(default_factory=list, max_length=100)
    products: list[ProductIntelligenceRecord] = Field(default_factory=list, max_length=200)
    offerings: list[SupplierProductOffering] = Field(default_factory=list, max_length=300)
    claims: list[ClaimDraft] = Field(default_factory=list, max_length=500)
    evidence: list[EvidenceRecord] = Field(default_factory=list, max_length=50)
    candidates: list[ResearchCandidate] = Field(default_factory=list, max_length=300)
    actions: list[ResearchAction] = Field(default_factory=list, max_length=100)
    search_calls: int = Field(default=0, ge=0)
    fetch_calls: int = Field(default=0, ge=0)
    model_calls: int = Field(default=0, ge=0)
    prompt_tokens: int = Field(default=0, ge=0)
    completion_tokens: int = Field(default=0, ge=0)
    token_usage_observed: bool = False
    model_call_details: list[ModelCallMetric] = Field(default_factory=list, max_length=30)
    trace_run_ids: dict[str, str] = Field(default_factory=dict)
    langsmith_tracing_enabled: bool = False
    reused_intelligence_ids: list[str] = Field(default_factory=list)
    refreshed_intelligence_ids: list[str] = Field(default_factory=list)
    ignored_intelligence_ids: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    completed_at: datetime

    @model_validator(mode="after")
    def ensure_scope_consistency(self) -> ResearchRunBundle:
        if self.status != ResearchRunStatus.COMPLETED and not self.stop_reason_code:
            raise ValueError("partial and failed research runs require a stop_reason_code")
        plans = [self.plan, *self.plan_history]
        if any(plan.project_id != self.project_id or plan.run_id != self.run_id for plan in plans):
            raise ValueError("all plan revisions must match research bundle scope")
        if len({plan.plan_revision for plan in plans}) != len(plans):
            raise ValueError("plan revisions must be unique")
        return self


def canonical_domain(value: str) -> str | None:
    """Normalize a public host for same-site deduplication, never by company name."""
    candidate = value.strip()
    if not candidate:
        return None
    parsed = urlsplit(candidate if "://" in candidate else f"https://{candidate}")
    host = parsed.hostname
    if not host or any(char.isspace() for char in host):
        return None
    try:
        normalized = host.encode("idna").decode("ascii").lower().rstrip(".")
    except UnicodeError:
        return None
    if normalized.startswith("www."):
        normalized = normalized[4:]
    if len(normalized) > 253 or "." not in normalized:
        return None
    return normalized


def normalized_url(value: str) -> str:
    """Canonicalize URL identity while preserving path/query that may identify content."""
    parsed = urlsplit(value.strip())
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ValueError("evidence URL must use http or https")
    host = canonical_domain(parsed.hostname)
    if host is None:
        raise ValueError("evidence URL must use a public hostname")
    port = parsed.port
    netloc = host if port is None or (parsed.scheme.lower(), port) in {("http", 80), ("https", 443)} else f"{host}:{port}"
    path = re.sub(r"/{2,}", "/", parsed.path or "/")
    return f"{parsed.scheme.lower()}://{netloc}{path}" + (f"?{parsed.query}" if parsed.query else "")


def stable_id(prefix: str, *parts: str) -> str:
    """Create a deterministic, scoped id suitable for idempotent D1 upserts."""
    if not re.fullmatch(r"[a-z][a-z0-9]{0,15}", prefix):
        raise ValueError("stable id prefix must be lowercase alphanumeric")
    payload = "\x1f".join(parts).encode("utf-8")
    digest = hashlib.sha256(payload).hexdigest()[:24]
    return f"{prefix}_{digest}"


def content_sha256(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def normalize_model_key(brand: str | None, model: str | None, evidence_id: str) -> str:
    """Deduplicate exact model labels; avoid collapsing candidates with no model."""
    def normalize(value: str) -> str:
        return re.sub(r"[\W_]+", "", value.casefold(), flags=re.UNICODE)

    if model and model.strip():
        return f"model:{normalize(brand or '')}:{normalize(model)}"
    return f"evidence:{evidence_id}"
