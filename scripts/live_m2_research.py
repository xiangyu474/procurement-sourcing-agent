"""Run one tightly bounded live M2 Supervisor/Researcher sourcing trial.

This script uses public search only and prints source URLs/evidence excerpts,
never API credentials. It does not persist to Cloudflare; use the authenticated
cloud API after deploying migration 0005 to verify D1/R2 persistence.
"""

from __future__ import annotations

import argparse
import json
import uuid
from dataclasses import replace

from procurement_agent.domain.requirements import (
    ConstraintOperator,
    ConstraintOrigin,
    Importance,
    Requirement,
    RequirementCompilation,
    RequirementConstraint,
    ValueType,
)
from procurement_agent.infra import load_settings
from procurement_agent.infra.llm import build_chat_model
from procurement_agent.infra.search import TavilyContentProvider, TavilySearchProvider
from procurement_agent.services.sourcing_research import run_sourcing_research


def _compilation(product: str, constraint: str, unit: str) -> RequirementCompilation:
    project_id = "local-m2-live-eval"
    quote = f"{product}，{constraint}{unit}"
    return RequirementCompilation(
        project_id=project_id,
        revision=1,
        source_refs=["user_text:local-m2-live-eval:revision=1:chars=0-120"],
        requirements=[
            Requirement(
                requirement_id="req-live-1",
                project_id=project_id,
                product_name=product,
                product_category=product,
                constraints=[
                    RequirementConstraint(
                        constraint_id="constraint-live-1",
                        requirement_id="req-live-1",
                        attribute_key="resolution",
                        attribute_definition="Image resolution",
                        value_type=ValueType.NUMBER,
                        operator=ConstraintOperator.GTE,
                        value=constraint,
                        unit=unit,
                        importance=Importance.HARD,
                        origin=ConstraintOrigin.USER_EXPLICIT,
                        source_ref="user_text:local-m2-live-eval:revision=1:chars=0-120",
                        source_quote=quote,
                    )
                ],
                source_refs=["user_text:local-m2-live-eval:revision=1:chars=0-120"],
            )
        ],
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Bounded live M2 public sourcing trial")
    parser.add_argument("--product", default="industrial IP camera", help="Public product category only; do not pass internal project details")
    parser.add_argument("--minimum-resolution-mp", default="5")
    parser.add_argument("--max-researchers", type=int, choices=(1, 2, 3), default=1)
    args = parser.parse_args()

    settings = load_settings()
    if not settings.has_llm or not settings.tavily_api_key:
        raise SystemExit("Set GENESIS_* and TAVILY_API_KEY in the local environment before a live M2 run.")
    # Keep this smoke trial intentionally small; production defaults remain in
    # Settings and are shared across all concurrently delegated researchers.
    budgeted = replace(
        settings,
        max_search_calls=min(settings.max_search_calls, 4),
        max_web_fetches=min(settings.max_web_fetches, 4),
        max_concurrent_researchers=min(settings.max_concurrent_researchers, args.max_researchers),
        max_model_calls=min(settings.max_model_calls, 15),
        max_research_rounds=min(settings.max_research_rounds, 2),
    )
    project_id = "local-m2-live-eval"
    run_id = str(uuid.uuid4())
    compilation = _compilation(args.product, args.minimum_resolution_mp, "MP")
    result = __import__("asyncio").run(
        run_sourcing_research(
            model=build_chat_model(budgeted, timeout=180),
            compilation=compilation,
            project_id=project_id,
            run_id=run_id,
            settings=budgeted,
            search_provider=TavilySearchProvider(budgeted.tavily_api_key or ""),
            content_provider=TavilyContentProvider(budgeted.tavily_api_key or ""),
        )
    )
    exact_model_found = any(product.model for product in result.products)
    output = {
        "status": "PASS" if result.candidates and result.evidence and exact_model_found else "PARTIAL",
        "run_status": result.status.value,
        "run_id": run_id,
        "goal": result.plan.goal.value,
        "target_markets": result.plan.target_markets,
        "plan_revision": result.plan.plan_revision,
        "stop_reason_code": result.stop_reason_code,
        "researcher_task_count": len(result.tasks),
        "search_calls": result.search_calls,
        "fetch_calls": result.fetch_calls,
        "model_calls": result.model_calls,
        "prompt_tokens": result.prompt_tokens,
        "completion_tokens": result.completion_tokens,
        "token_usage_observed": result.token_usage_observed,
        "trace_run_ids": result.trace_run_ids,
        "model_call_details": [item.model_dump(mode="json") for item in result.model_call_details],
        "supplier_count": len(result.suppliers),
        "product_count": len(result.products),
        "candidate_count": len(result.candidates),
        "evidence_count": len(result.evidence),
        "claim_count": len(result.claims),
        "candidates": [
            {
                "supplier": supplier.display_name,
                "website_domain": supplier.website_domain,
                "identity_status": supplier.identity_status.value,
                "product": product.product_name,
                "brand": product.brand,
                "model": product.model,
                "stage": candidate.stage.value,
                "evidence": [
                    {
                        "url": evidence.source_url,
                        "title": evidence.title,
                        "retrieved_at": evidence.retrieved_at.isoformat(),
                        "excerpt": evidence.excerpt[:1200],
                        "sha256": evidence.content_sha256,
                    }
                    for evidence in result.evidence
                    if evidence.evidence_id in candidate.evidence_ids
                ],
                "open_questions": candidate.open_questions,
            }
            for candidate in result.candidates
            for supplier in result.suppliers
            if supplier.supplier_id == candidate.supplier_id
            for product in result.products
            if product.product_id == candidate.product_id
        ],
        "supported_by_source_claim_count": len(result.claims),
        "warnings": result.warnings,
    }
    print(json.dumps(output, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
