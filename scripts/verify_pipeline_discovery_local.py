"""Exercise the actual Worker discovery/status routes against isolated local D1.

Usage: uv run --python 3.11 python scripts/verify_pipeline_discovery_local.py
This starts a private local Wrangler server, seeds only temporary local data,
and never accesses Cloudflare resources or uses a production credential.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
NPX = shutil.which("npx.cmd" if os.name == "nt" else "npx")


def main() -> int:
    if not NPX:
        raise SystemExit("npx not found")
    with tempfile.TemporaryDirectory(prefix="pipeline-discovery-", ignore_cleanup_errors=True) as temp:
        directory = Path(temp)
        state = directory / "state"
        config = directory / "wrangler.json"
        config.write_text(json.dumps({
            "name": "pipeline-discovery-test",
            "main": str(ROOT / "cloudflare/gateway/src/index.ts"),
            "compatibility_date": "2026-10-13",
            "compatibility_flags": ["nodejs_compat"],
            "d1_databases": [{
                "binding": "DB", "database_name": "discovery-test",
                "database_id": "00000000-0000-0000-0000-000000000001",
                "migrations_dir": str(ROOT / "cloudflare/gateway/migrations"),
            }],
            "vars": {"PIPELINE_ENABLED": "true", "DEMO_ACCESS_TOKEN": "local-test-only"},
        }), encoding="utf-8")
        environment = {**os.environ, "WRANGLER_SEND_METRICS": "false"}
        common = ["--config", str(config), "--persist-to", str(state), "--local"]
        subprocess.run([NPX, "wrangler", "d1", "migrations", "apply", "DB", *common], cwd=ROOT, env=environment, check=True, capture_output=True, text=True, encoding="utf-8", errors="replace")
        seed = """
        INSERT INTO projects(id,title,created_at) VALUES ('p1','test','2026');
        INSERT INTO project_pipelines(id,workspace_id,project_id,run_id,demand_revision,status,stage,report_status,created_at,updated_at)
            VALUES ('queued','default','p1','not-yet-created',1,'QUEUED','QUEUED','NOT_STARTED','2026-01-03','2026-01-03');
        INSERT INTO project_pipelines(id,workspace_id,project_id,run_id,demand_revision,status,stage,report_status,created_at,updated_at)
            VALUES ('reporting','default','p1','r2',1,'COMPLETED','COMPLETED','RUNNING','2026-01-02','2026-01-02');
        INSERT INTO project_pipelines(id,workspace_id,project_id,run_id,demand_revision,status,stage,report_status,created_at,updated_at)
            VALUES ('research','default','p1','r3',1,'RUNNING','RESEARCHING','NOT_STARTED','2026-01-01','2026-01-01');
        INSERT INTO pipeline_stages(pipeline_id,stage,status,started_at) VALUES ('research','RESEARCH','RUNNING','2026-01-01');
        """
        seed_file = directory / "seed.sql"
        seed_file.write_text(seed, encoding="utf-8")
        seeded = subprocess.run([NPX, "wrangler", "d1", "execute", "DB", *common, "--file", str(seed_file)], cwd=ROOT, env=environment, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if seeded.returncode:
            raise RuntimeError(f"local D1 seed failed: {seeded.stderr[-1000:]}")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        cmd = [NPX, "wrangler", "dev", "--config", str(config), "--persist-to", str(state), "--local", "--ip", "127.0.0.1", "--port", str(port), "--inspector-port", "0", "--log-level", "error"]
        log = (directory / "worker.log").open("w", encoding="utf-8")
        process = subprocess.Popen(cmd, cwd=ROOT, env=environment, stdout=log, stderr=subprocess.STDOUT)
        base = f"http://127.0.0.1:{port}"
        try:
            with httpx.Client(base_url=base, timeout=5, trust_env=False) as client:
                for _ in range(60):
                    if process.poll() is not None:
                        log.flush()
                        raise RuntimeError(f"local Wrangler exited: {(directory / 'worker.log').read_text(encoding='utf-8', errors='replace')[-3000:]}")
                    try:
                        if client.get("/api/health").status_code == 200:
                            break
                    except httpx.HTTPError:
                        pass
                    time.sleep(1)
                else:
                    log.flush()
                    raise RuntimeError(f"local Wrangler did not start: {(directory / 'worker.log').read_text(encoding='utf-8', errors='replace')[-3000:]}")
                path = "/api/projects/p1/pipelines"
                assert client.get(path).status_code == 401
                headers = {"authorization": "Bearer local-test-only"}
                active = client.get(path, params={"active": "true"}, headers=headers)
                assert active.status_code == 200, active.text
                body = active.json()
                assert [item["pipeline_id"] for item in body["pipelines"]] == ["queued", "reporting", "research"]
                assert body["pipelines"][0]["run_id"] == "not-yet-created"
                assert body["pipelines"][1]["report_status"] == "RUNNING"
                assert client.get(path, params={"limit": "0"}, headers=headers).status_code == 400
                assert client.get("/api/projects/other/pipelines", headers=headers).status_code == 404
                detail = client.get("/api/projects/p1/pipeline/research", headers=headers)
                assert detail.status_code == 200, detail.text
                assert detail.json()["stage"] == "RESEARCHING"
                assert detail.json()["stages"][0]["stage"] == "RESEARCH"
                print("PASS: real local Worker routes, isolated D1, auth, queued recovery, report activity and stage names")
        finally:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, check=False)
            else:
                process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
            log.close()
            time.sleep(2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
