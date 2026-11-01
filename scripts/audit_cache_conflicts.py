"""Classify the conflicts that the judgement cache recorded.

A conflict is two different answers for the same input. This script groups
them by the cause that can be read off the record: the layer, the rule
version, the model configuration, the source run, and whether the two
answers were written at the same time. The point is to tell a real change of
behaviour apart from two requests that raced for the same empty cache entry.
"""

from __future__ import annotations

import json
import subprocess
from collections import Counter, defaultdict


def query(sql: str) -> list[dict]:
    completed = subprocess.run(
        [
            "npx.cmd",
            "wrangler",
            "d1",
            "execute",
            "DB",
            "--remote",
            "--command",
            sql,
            "--json",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return []
    if not isinstance(payload, list) or not payload:
        return []
    return payload[0].get("results") or []


def main() -> int:
    conflicts = query(
        "SELECT id, layer, input_digest, payload_json, model_config_json, reason_codes_json, "
        "source_run_id, source_project_id, created_at FROM judgment_cache_conflicts"
    )
    stored = query(
        "SELECT layer, input_digest, payload_json, model_config_json, versions_json, "
        "source_run_id, source_project_id, created_at FROM judgment_cache"
    )
    by_digest = {(row["layer"], row["input_digest"]): row for row in stored}
    print(f"conflicts: {len(conflicts)}, stored judgements: {len(stored)}")

    by_layer = Counter(row["layer"] for row in conflicts)
    print("by layer:", dict(by_layer))

    by_run = Counter(row["source_run_id"] or "(none)" for row in conflicts)
    print("by source run:", dict(by_run.most_common()))

    by_model = Counter((row["model_config_json"] or "{}") for row in conflicts)
    print("by model configuration:")
    for model, count in by_model.most_common():
        print(f"  {count:4d}  {model[:160]}")

    same_second = 0
    same_digest_no_stored = 0
    versions_seen: Counter[str] = Counter()
    for row in conflicts:
        key = (row["layer"], row["input_digest"])
        if key not in by_digest:
            same_digest_no_stored += 1
            continue
        first = by_digest[key]
        versions_seen[first.get("versions_json", "")[:120]] += 1
        if first.get("created_at", "")[:16] == (row.get("created_at") or "")[:16]:
            same_second += 1
    print(f"conflicts written within the same minute as the stored answer: {same_second}")
    print(f"conflicts whose input is no longer stored: {same_digest_no_stored}")
    print("by rule version of the stored answer:")
    for version, count in versions_seen.most_common():
        print(f"  {count:4d}  {version}")

    digests = defaultdict(list)
    for row in conflicts:
        digests[(row["layer"], row["input_digest"])].append(row)
    repeated = {key: rows for key, rows in digests.items() if len(rows) > 1}
    print(f"inputs with more than one conflict: {len(repeated)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
