"""Read the frozen assessment of a pipeline straight from the database.

Usage: uv run --python 3.11 python scripts/read_pipeline_spec.py <pipeline_id>

The gateway is often unreachable from a development machine, but the frozen
snapshot is in the database, and the database can be read with any Cloudflare
API client. This prints what the run actually concluded.
"""

from __future__ import annotations

import collections
import json
import subprocess
import sys

DATABASE_ID = "3a67c338-107f-4053-b678-109dd218773c"


def query(sql: str) -> list[dict[str, object]]:
    result = subprocess.run(
        ["cf.cmd", "d1", "query", DATABASE_ID, "--sql", sql],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if result.returncode != 0:
        raise SystemExit(f"the database query failed: {result.stderr[:300]}")
    payload = result.stdout[result.stdout.find("{"):]
    payload = payload[: payload.rfind("}") + 1]
    return json.loads(payload).get("results", [])


def main() -> int:
    if len(sys.argv) < 2:
        raise SystemExit("usage: read_pipeline_spec.py <pipeline_id>")
    pipeline_id = sys.argv[1]
    rows = query(
        "SELECT payload_json FROM pipeline_snapshots "
        f"WHERE pipeline_id = '{pipeline_id}' AND snapshot_type = 'SPEC_RESULTS'"
    )
    if not rows:
        print("this pipeline has no frozen assessment yet")
        return 0
    data = json.loads(str(rows[0]["payload_json"]))
    verdicts: collections.Counter[str] = collections.Counter()
    reasons: collections.Counter[str] = collections.Counter()
    examples: dict[str, str] = {}
    for entry in data.get("assessments", []):
        assessment = entry.get("assessment") or {}
        verdicts[str(assessment.get("hard_spec_overall"))] += 1
        for check in assessment.get("checks", []):
            code = str(check.get("reason_code"))
            reasons[code] += 1
            examples.setdefault(code, str(check.get("explanation") or "")[:520])
    print("verdicts:", dict(verdicts))
    print("reason codes:", dict(reasons))
    for code, text in list(examples.items())[:4]:
        print(f"  * {code}: {text}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
