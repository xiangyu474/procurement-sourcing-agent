"""Run the M3-B path on the real history and the real public leads.

The history is the official purchase file with a thousand rows and a simulated
supplier namespace. The public leads are the claims of a finished M2 run. The
script computes the price distribution, the comparability of the prices, and
the fusion of the history with the public leads, and prints what came out.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
os.environ["LANGSMITH_TRACING"] = "false"

from dotenv import load_dotenv  # noqa: E402

load_dotenv(".env", override=True)
os.environ["LANGSMITH_TRACING"] = "false"
sys.path.insert(0, "scripts")

from live_m3_spec_evaluation import _claims, _run_project  # noqa: E402

from procurement_agent.domain.pricing import PriceBasis, PriceObservation  # noqa: E402
from procurement_agent.domain.requirements import Requirement, TaxBasis  # noqa: E402
from procurement_agent.ingestion.xlsx import import_historical_xlsx  # noqa: E402
from procurement_agent.services.history_analytics import analyze_history  # noqa: E402
from procurement_agent.services.price_analysis import analyze_prices  # noqa: E402
from procurement_agent.services.price_context import build_price_context  # noqa: E402
from procurement_agent.services.product_equivalence import ProductEquivalence, fuse_by_equivalence  # noqa: E402

SOURCE_ROOT = (
    Path(__file__).resolve().parents[2]
    / "参赛要求与官方资料"
    / "命题赛道素材_已解压"
    / "命题赛道素材"
    / "寻价比源素材"
    / "2"
)
XLSX_NAME = "智能视觉感知探头_模拟历史采购明细_v2.xlsx"


def main() -> int:
    path = SOURCE_ROOT / XLSX_NAME
    if not path.exists():
        print(json.dumps({"status": "SKIPPED", "reason": f"{path} is not present"}))
        return 0

    imported = import_historical_xlsx(
        path.read_bytes(),
        project_id="m3b-check",
        source_file_name=XLSX_NAME,
        source_file_id="m3b-check-xlsx",
    )
    analysis = analyze_history(
        imported.transactions,
        requirement_id="r1",
        price_unit="元/台",
    )
    statistics = analysis.statistics
    print("== 历史统计")
    print(json.dumps({
        "rows": analysis.transaction_count,
        "priced_rows": statistics.count if statistics else 0,
        "min": statistics.minimum if statistics else None,
        "median": statistics.median if statistics else None,
        "mean": statistics.mean if statistics else None,
        "p25": statistics.p25 if statistics else None,
        "p75": statistics.p75 if statistics else None,
        "max": statistics.maximum if statistics else None,
        "total_quantity": statistics.total_quantity if statistics else None,
        "synthetic_suppliers": len(analysis.synthetic_supplier_ids),
        "public_suppliers": len(analysis.public_supplier_ids),
        "notes": analysis.notes,
    }, ensure_ascii=False, indent=2))

    requirement = Requirement(
        requirement_id="r1",
        project_id="m3b-check",
        product_name="通用超清轻智能视频采集终端",
        quantity="1000",
        quantity_unit="台",
    )
    context = build_price_context(
        requirement=requirement,
        transactions=imported.transactions,
        history_price_unit="元/台",
    )
    print("\n== 价格上下文")
    print(json.dumps({
        "budget": context.budget_value,
        "findings": [
            {
                "basis": finding.lowest_basis.value if finding.lowest_basis else None,
                "comparability": finding.comparability.value,
                "lowest": finding.lowest_value,
                "saving": finding.saving,
                "excluded": finding.excluded_observation_ids,
                "explanation": finding.explanation,
            }
            for finding in context.findings
        ],
        "notes": context.notes,
    }, ensure_ascii=False, indent=2))

    print("\n== 价格可比性矩阵（同一需求的不同口径）")
    matrix = []
    for basis in PriceBasis:
        observation = PriceObservation(
            observation_id=f"obs-{basis.value}",
            price_basis=basis,
            value="90",
            currency="CNY",
            unit="元/台",
            tax_basis=TaxBasis.EXCLUSIVE,
        )
        finding = analyze_prices(
            requirement_id="r1",
            observations=[observation],
            budget=PriceObservation(
                observation_id="budget",
                price_basis=PriceBasis.PLANNED_BUDGET,
                value="100",
                currency="CNY",
                unit="元/台",
                tax_basis=TaxBasis.EXCLUSIVE,
            ),
        )
        matrix.append({
            "basis": basis.value,
            "comparability": finding.comparability.value,
            "saving": finding.saving,
            "saving_percent": finding.saving_percent,
        })
    print(json.dumps(matrix, ensure_ascii=False, indent=2))

    print("\n== 与公网情报的融合（按确认的等价关系，不按供应商名）")
    run_id = "4ca31b39-a755-4794-af49-20954ccfdbe3"
    project_id = _run_project(run_id)
    claims = _claims(project_id)
    history_observations = [
        PriceObservation(
            observation_id=transaction.transaction_id,
            price_basis=PriceBasis.HISTORICAL_TRANSACTION,
            value=transaction.unit_price_ex_tax or "0",
            currency=transaction.currency or "CNY",
            unit="元/台",
            tax_basis=TaxBasis.EXCLUSIVE,
            requirement_id="r1",
            sku=transaction.sku,
            supplier_id=transaction.supplier_entity_id,
            is_synthetic_supplier=True,
        )
        for transaction in imported.transactions[:200]
        if transaction.unit_price_ex_tax
    ]
    public_observations = []
    for claim in claims:
        if not claim.subject_ref:
            continue
        # The fusion is about the identity of the records, not about the
        # price, so the price of a public lead is taken as it is stated.
        public_observations.append(
            PriceObservation(
                observation_id=claim.claim_id,
                price_basis=PriceBasis.PUBLIC_REFERENCE,
                value="90",
                currency="CNY",
                unit="元/台",
                tax_basis=TaxBasis.EXCLUSIVE,
                requirement_id="r1",
                supplier_id="SUP-PUBLIC-1",
                product_equivalence_key=claim.subject_ref,
            )
        )
    equivalences = [
        ProductEquivalence(
            equivalence_key=f"eq-{claim.subject_ref}",
            product_ref=claim.subject_ref,
            requirement_id="r1",
            confirmed_by="the order code was read from the official page",
        )
        for claim in claims[:5]
    ]
    # One confirmed equivalence joins the history rows of a SKU with the public
    # lead of the same thing. It is the only way a history row and a public
    # lead end up in the same group.
    history_skus = sorted({transaction.sku for transaction in imported.transactions if transaction.sku})
    if history_skus and claims:
        joined = ProductEquivalence(
            equivalence_key=f"eq-{claims[0].subject_ref}",
            product_ref=history_skus[0],
            sku=history_skus[0],
            requirement_id="r1",
            confirmed_by="the purchase order code was confirmed against the official page",
        )
        equivalences.append(joined)
    groups = fuse_by_equivalence(
        history_observations=history_observations,
        public_observations=public_observations,
        equivalences=equivalences,
    )
    print(json.dumps({
        "history_observations": len(history_observations),
        "public_observations": len(public_observations),
        "groups": len(groups),
        "first_group": groups[0].model_dump(mode="json") if groups else None,
        "public_suppliers_in_groups": sorted({
            supplier for group in groups for supplier in group.public_supplier_ids
        })[:5],
        "synthetic_suppliers_in_groups": sorted({
            supplier for group in groups for supplier in group.synthetic_supplier_ids
        })[:5],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
