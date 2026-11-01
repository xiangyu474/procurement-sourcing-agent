"""Read the results of the recent acceptance workflow instances.

The local script cannot reach the API with the token of the file once that
token is old, so the Cloudflare CLI is asked for the instances and their
results.
"""

from __future__ import annotations

import json
import subprocess
import sys


def cf(*args: str) -> str:
    completed = subprocess.run(
        ["cf.cmd" if sys.platform.startswith("win") else "cf", *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    return completed.stdout


def main() -> int:
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 6
    instances = json.loads(
        cf("workflows", "instances", "list", "--workflow-name", "procurement-sourcing-acceptance", "--per-page", str(limit))
        or "[]"
    )
    for instance in instances[:limit]:
        instance_id = instance.get("id", "")
        detail = json.loads(
            cf("workflows", "instances", "get", instance_id, "--workflow-name", "procurement-sourcing-acceptance")
            or "{}"
        )
        output = detail.get("output") or {}
        stages = output.get("stages")
        if isinstance(stages, str):
            try:
                stages = json.loads(stages)
            except json.JSONDecodeError:
                stages = {"raw": stages}
        stages = stages or {}
        print(
            json.dumps(
                {
                    "instance": instance_id[:20],
                    "started": instance.get("started_on"),
                    "ended": instance.get("ended_on"),
                    "status": output.get("status"),
                    "failures": output.get("failures") or [],
                    "requirements": stages.get("requirements"),
                    "candidates": stages.get("candidates"),
                    "by_overall": stages.get("by_overall"),
                    "decisions": stages.get("decisions"),
                    "accepted": stages.get("accepted"),
                    "rejected": stages.get("rejected"),
                    "report_status": stages.get("report_status"),
                    "report_bytes": stages.get("report_bytes"),
                    "decision_version": stages.get("decision_version"),
                },
                ensure_ascii=False,
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
