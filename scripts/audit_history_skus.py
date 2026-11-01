"""Audit the official history files: how many items, and how wide the price spread is.

The official files carry several items in one sheet. This script prints, per
item, how many rows it has and how wide its price spread is, so the report can
state what a table-wide number would hide.
"""

from __future__ import annotations

import collections
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from procurement_agent.ingestion.xlsx import import_historical_xlsx  # noqa: E402

MATERIALS = ROOT.parent / "参赛要求与官方资料/命题赛道素材_已解压/命题赛道素材/寻价比源素材"
FILES = (
    ("1", "智能视频采集终端_历史采购明细_v1.xlsx"),
    ("2", "智能视觉感知探头_模拟历史采购明细_v2.xlsx"),
)


def main() -> int:
    for folder, name in FILES:
        path = MATERIALS / folder / name
        imported = import_historical_xlsx(
            path.read_bytes(),
            project_id="audit",
            source_file_name=path.name,
            source_file_id=f"audit-{folder}",
        )
        rows = imported.transactions
        by_sku: dict[str, list] = collections.defaultdict(list)
        for row in rows:
            by_sku[row.sku or "unknown"].append(row)
        print(f"=== {folder}/{name}")
        print(f"    rows={len(rows)} items={len(by_sku)} synthetic={imported.is_synthetic} header_row={imported.header_row}")
        all_prices = [float(row.unit_price_ex_tax) for row in rows if row.unit_price_ex_tax]
        if all_prices:
            print(f"    table-wide: min={min(all_prices)} max={max(all_prices)} spread={max(all_prices) / min(all_prices):.1f}x")
        for sku, members in sorted(by_sku.items(), key=lambda item: -len(item[1])):
            prices = [float(row.unit_price_ex_tax) for row in members if row.unit_price_ex_tax]
            sample = members[0]
            low = min(prices) if prices else None
            high = max(prices) if prices else None
            print(
                f"    {sku} n={len(members):4d} price={low}~{high} "
                f"| {sample.product_name} | {sample.specification}"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
