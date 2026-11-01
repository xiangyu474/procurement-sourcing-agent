"""Run the cloud acceptance from a machine that cannot reach the gateway.

The acceptance itself runs on Cloudflare's side, inside the container, where
the gateway is reachable. This script starts that workflow through the
Cloudflare API and reads the report back from the workflow instance.

This is the way to run the acceptance when the local network blocks
`*.workers.dev`. The other acceptance scripts, `verify_m1_cloud_api.py`,
`verify_m2_cloud_api.py`, `verify_m3_cloud_api.py`, and
`verify_m3_decision_api.py`, drive the same gateway over HTTP and are the
better choice when the network allows it.

Usage:
    uv run --python 3.11 python scripts/run_cloud_acceptance.py
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx

ACCOUNT_ID = "4132e127c982dade9faf4ada66a5b5e0"
WORKFLOW_NAME = "procurement-sourcing-acceptance"
API_ROOT = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}"


def _cloudflare_token() -> str:
    """Read the OAuth token the Cloudflare CLI is signed in with.

    The CLI refreshes the token when it runs, so it is asked first: the token
    in the file can be an hour old, and the API answers 401 for that.
    """
    # The CLI refreshes the token when it makes an authenticated call, so it
    # is asked for the account rather than for its version.
    cf = "cf.cmd" if os.name == "nt" else "cf"
    subprocess.run([cf, "auth", "whoami"], capture_output=True, text=True)
    config = Path(os.path.expandvars(r"%APPDATA%")) / "xdg.config" / "cloudflare" / "config" / "default.json"
    if not config.exists():
        raise SystemExit("The Cloudflare CLI is not signed in; run `cf login` first.")
    data = json.loads(config.read_text(encoding="utf-8"))
    token = data.get("oauth_token") or data.get("token")
    if not token:
        raise SystemExit("The Cloudflare CLI configuration holds no token; run `cf login` first.")
    return str(token)


def _start(client: httpx.Client, title: str) -> str:
    """Start the acceptance workflow and return the instance ID."""
    response = client.post(
        f"{API_ROOT}/workflows/{WORKFLOW_NAME}/instances",
        json={"params": {"title": title}},
    )
    if not response.is_success:
        raise SystemExit(f"the workflow could not be started: {response.status_code} {response.text[:300]}")
    return str(response.json()["result"]["id"])


def _instance(instance_id: str) -> dict:
    """Read one workflow instance with the Cloudflare CLI.

    The CLI keeps its own session, and it refreshes that session when it
    runs. The REST call with the token of the file fails once that token is
    old, so the CLI is asked instead.
    """
    cf = "cf.cmd" if os.name == "nt" else "cf"
    completed = subprocess.run(
        [
            cf,
            "workflows",
            "instances",
            "get",
            instance_id,
            "--workflow-name",
            WORKFLOW_NAME,
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError:
        return {}


def _wait(client: httpx.Client, instance_id: str, timeout: int = 5400) -> dict:
    """Wait for the workflow and return its result."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = _instance(instance_id)
        status = result.get("status")
        if status in {"complete", "errored", "terminated", "cancelled"}:
            return result
        time.sleep(20)
    raise SystemExit("the acceptance did not finish in time")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--title", default="cloud acceptance from the api")
    parser.add_argument("--timeout", type=int, default=10800)
    args = parser.parse_args()

    token = _cloudflare_token()
    headers = {"Authorization": f"Bearer {token}"}
    with httpx.Client(headers=headers, timeout=httpx.Timeout(60)) as client:
        instance_id = _start(client, args.title)
        print(f"the acceptance runs as workflow instance {instance_id}", flush=True)
        result = _wait(client, instance_id, timeout=args.timeout)

    output = result.get("output") or {}
    stages = output.get("stages")
    if isinstance(stages, str):
        try:
            stages = json.loads(stages)
        except json.JSONDecodeError:
            stages = {"raw": stages}
    report = {
        "status": output.get("status", "FAIL"),
        "instance_id": instance_id,
        "workflow_status": result.get("status"),
        "failures": output.get("failures") or [],
        "stages": stages or {},
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
