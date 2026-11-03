"""Exercise guest isolation against the real Worker and isolated local D1/R2.

Usage: uv run --python 3.11 python scripts/verify_guest_isolation_local.py
No production credentials, resources, or network access are used.
"""

from __future__ import annotations

import concurrent.futures
import hashlib
import hmac
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
SECRET = "local-guest-test-secret-" * 3
ORIGIN = "https://guest.example.test"


def cookie(session_id: str) -> str:
    signature = hmac.new(SECRET.encode(), session_id.encode(), hashlib.sha256).hexdigest()
    return f"__Host-ps_session={session_id}.{signature}"


def main() -> int:
    if not NPX:
        raise SystemExit("npx not found")
    with tempfile.TemporaryDirectory(prefix="guest-isolation-", ignore_cleanup_errors=True) as temp:
        directory = Path(temp)
        state = directory / "state"
        config = directory / "wrangler.json"
        config.write_text(json.dumps({
            "name": "guest-isolation-test",
            "main": str(ROOT / "cloudflare/gateway/src/index.ts"),
            "compatibility_date": "2026-10-13", "compatibility_flags": ["nodejs_compat"],
            "d1_databases": [{"binding": "DB", "database_name": "guest-test", "database_id": "00000000-0000-0000-0000-000000000002", "migrations_dir": str(ROOT / "cloudflare/gateway/migrations")}],
            "r2_buckets": [{"binding": "BUCKET", "bucket_name": "guest-test-bucket"}],
            "vars": {"GUEST_SESSION_ENABLED": "true", "GUEST_SESSION_SECRET": SECRET, "GUEST_PUBLIC_ORIGIN": ORIGIN,
                     "GUEST_SESSION_GLOBAL_PER_HOUR": "4", "GUEST_SESSION_IP_PER_HOUR": "2",
                     "GUEST_GLOBAL_REQUESTS_PER_MINUTE": "500", "GUEST_SESSION_REQUESTS_PER_MINUTE": "40",
                     "GUEST_TASK_GLOBAL_CONCURRENT": "2", "GUEST_TASK_SESSION_CONCURRENT": "1",
                     "GUEST_TASK_GLOBAL_DAILY_UNITS": "20", "GUEST_TASK_SESSION_DAILY_UNITS": "8",
                     "GUEST_TASK_SESSION_DAILY_STARTS": "4",
                     "PIPELINE_ENABLED": "true", "DEMO_ACCESS_TOKEN": "local-test-only"},
        }), encoding="utf-8")
        environment = {**os.environ, "WRANGLER_SEND_METRICS": "false"}
        common = ["--config", str(config), "--persist-to", str(state), "--local"]
        subprocess.run([NPX, "wrangler", "d1", "migrations", "apply", "DB", *common], cwd=ROOT, env=environment, check=True, capture_output=True, text=True, encoding="utf-8", errors="replace")
        a, b, burst_session = "a" * 64, "b" * 64, "c" * 64
        context = json.dumps({"project_id": "p1", "pipeline_id": "pipe1", "run_id": "r1", "demand_revision": 1,
            "requirements": [], "candidates": [], "assessments": [], "decisions": [], "price_contexts": [], "evidence": []}, separators=(",", ":"))
        version = hashlib.sha256(context.encode()).hexdigest()
        source = b"A source snapshot for the local guest isolation test."
        digest = hashlib.sha256(source).hexdigest()
        seed = f"""
        INSERT INTO guest_sessions(id,created_at,expires_at,last_seen_at) VALUES ('{a}','2026','2099-01-01T00:00:00.000Z','2026'),('{b}','2026','2099-01-01T00:00:00.000Z','2026'),('{burst_session}','2026','2099-01-01T00:00:00.000Z','2026');
        INSERT INTO projects(id,title,created_at,session_id) VALUES ('p1','A','2026','{a}'),('p2','B','2026','{b}'),('old','legacy','2026',NULL);
        INSERT INTO runs(id,project_id,status,current_stage,artifact_key,last_error,created_at,updated_at) VALUES ('r1','p1','COMPLETED','SUPERVISOR: WEB_RESEARCH','private/r2/key','private exception secret','2026','2026'),('r2','p2','RUNNING','WEB_RESEARCH',NULL,NULL,'2026','2026');
        INSERT INTO run_events(id,run_id,stage,detail,created_at) VALUES ('event1','r1','SUPERVISOR: WEB_RESEARCH','private SourcingPlan secret','2026');
        INSERT INTO research_run_costs(workspace_id,project_id,run_id,status,stop_reason_code,search_calls,fetch_calls,model_calls,prompt_tokens,completion_tokens,candidate_count,evidence_count,reused_intelligence_count,refreshed_intelligence_count,ignored_intelligence_count,warnings_json,updated_at)
            VALUES ('default','p1','r1','COMPLETED','SUPERVISOR_RESEARCHER_ERROR',1,1,1,123,456,1,1,0,0,0,'["private warning"]','2026');
        INSERT INTO project_jobs(id,workspace_id,project_id,job_type,status,error,detail_json,created_at,updated_at)
            VALUES ('compile1','default','p1','COMPILE','FAILED','private exception secret','{{"analysis_version":1,"demand_revision":1,"workflow_id":"private-workflow"}}','2026','2026');
        INSERT INTO demand_compilations(id,project_id,demand_revision,analysis_version,compiler_version,compilation_json,source_refs_json,created_at)
            VALUES ('demand1','p1',1,1,'test','{{"project_id":"p1","issues":["private exception secret"]}}','[]','2026');
        INSERT INTO research_evidence(id,workspace_id,source_type,source_url,normalized_url,title,retrieved_at,locator,excerpt,content_sha256,snapshot_r2_key,trust_notes,first_run_id,last_run_id)
            VALUES ('ev1','default','PUBLIC_WEB','https://example.test/a','https://example.test/a','source','2026','local','source','{digest}','evidence/ev1','test','r1','r1');
        INSERT INTO research_evidence_tasks(workspace_id,run_id,task_id,evidence_id) VALUES ('default','r1','task','ev1');
        INSERT INTO project_pipelines(id,workspace_id,project_id,run_id,demand_revision,status,stage,decision_version,report_id,report_status,created_at,updated_at)
            VALUES ('pipe1','default','p1','r1',1,'COMPLETED','COMPLETED','{version}','report1','COMPLETED','2026','2026');
        INSERT INTO project_pipelines(id,workspace_id,project_id,run_id,demand_revision,status,stage,created_at,updated_at)
            VALUES ('pipe2','default','p2','r2',1,'RUNNING','RESEARCHING','2026','2026');
        INSERT INTO pipeline_snapshots(pipeline_id,snapshot_type,payload_json,sha256,created_at) VALUES ('pipe1','FINAL_CONTEXT','{context}','{version}','2026');
        INSERT INTO project_reports(id,workspace_id,project_id,run_id,status,r2_key,created_at,updated_at) VALUES ('report1','default','p1','r1','COMPLETED','reports/report1','2026','2026'),('report2','default','p2','r2','COMPLETED','reports/report2','2026','2026');
        """
        seed_file = directory / "seed.sql"
        seed_file.write_text(seed, encoding="utf-8")
        subprocess.run([NPX, "wrangler", "d1", "execute", "DB", *common, "--file", str(seed_file)], cwd=ROOT, env=environment, check=True, capture_output=True, text=True, encoding="utf-8", errors="replace")
        for path, body in (("evidence/ev1", source), ("reports/report1", b"PK synthetic report")):
            body_file = directory / f"object-{path.split('/')[-1]}"
            body_file.write_bytes(body)
            subprocess.run([NPX, "wrangler", "r2", "object", "put", f"guest-test-bucket/{path}", *common, "--file", str(body_file)], cwd=ROOT, env=environment, check=True, capture_output=True, text=True, encoding="utf-8", errors="replace")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        cmd = [NPX, "wrangler", "dev", "--config", str(config), "--persist-to", str(state), "--local", "--ip", "127.0.0.1", "--port", str(port), "--inspector-port", "0", "--log-level", "error"]
        log = (directory / "worker.log").open("w", encoding="utf-8")
        process = subprocess.Popen(cmd, cwd=ROOT, env=environment, stdout=log, stderr=subprocess.STDOUT)
        try:
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=5, trust_env=False) as client:
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
                    raise RuntimeError("local Wrangler did not start")
                assert client.get("/api/session").status_code == 401
                assert client.post("/api/session").status_code == 403
                assert client.post("/api/session", headers={"origin": "https://bad.example.test"}).status_code == 403
                new = client.post("/api/session", headers={"origin": ORIGIN, "cf-connecting-ip": "198.51.100.1"})
                assert new.status_code == 201
                new_cookie = new.headers["set-cookie"]
                for attribute in ("HttpOnly", "Secure", "SameSite=Lax", "Path=/"):
                    assert attribute in new_cookie
                again = client.post("/api/session", headers={"origin": ORIGIN, "cookie": new_cookie.split(";")[0]})
                assert again.status_code == 200 and "set-cookie" not in again.headers
                second = client.post("/api/session", headers={"origin": ORIGIN, "cf-connecting-ip": "198.51.100.1"})
                assert second.status_code == 201
                limited = client.post("/api/session", headers={"origin": ORIGIN, "cf-connecting-ip": "198.51.100.1"})
                assert limited.status_code == 429 and limited.json()["error"] == "rate_limited"
                assert int(limited.headers["retry-after"]) > 0
                # The operator token is a separate, server-side identity; a browser
                # without it must not fall back to it.
                assert client.get("/api/projects").status_code == 401
                assert client.get("/api/projects", headers={"authorization": "Bearer wrong"}).status_code == 401
                assert client.get("/api/projects", headers={"authorization": "Bearer local-test-only"}).status_code == 200
                ha = {"cookie": cookie(a)}
                hb = {"cookie": cookie(b)}
                assert [p["id"] for p in client.get("/api/projects", headers=ha).json()["projects"]] == ["p1"]
                assert [p["id"] for p in client.get("/api/projects", headers=hb).json()["projects"]] == ["p2"]
                for path in ("/api/projects/p1", "/api/projects/p1/runs", "/api/runs/r1", "/api/evidence/ev1", "/api/projects/p1/analysis?pipeline_id=pipe1", "/api/projects/p1/reports/report1", "/api/projects/p1/reports/report1/download"):
                    own = client.get(path, headers=ha)
                    assert own.status_code == 200, (path, own.status_code, own.text)
                    assert client.get(path, headers=hb).status_code == 404, path
                # The guest can read their own pipeline after refresh, but no
                # expensive operation is enabled until quota safety is complete.
                for path in ("/api/projects/p1/pipelines", "/api/projects/p1/pipeline/pipe1"):
                    own = client.get(path, headers=ha)
                    assert own.status_code == 200, (path, own.status_code, own.text)
                    assert client.get(path, headers=hb).status_code == 404, path
                assert client.get("/api/projects/old", headers=ha).status_code == 404
                run = client.get("/api/runs/r1", headers=ha).json()
                assert run["artifact_key"] is None and run["last_error"] is None
                assert run["current_stage"] == "WEB_RESEARCH" and "private" not in json.dumps(run)
                summary = client.get("/api/projects/p1/runs", headers=ha).json()["runs"][0]
                assert summary["stop_reason_code"] == "RESEARCH_EXECUTION_FAILED"
                assert summary["current_stage"] == "WEB_RESEARCH" and "private" not in json.dumps(summary)
                research = client.get("/api/runs/r1/research", headers=ha).json()
                assert research["metrics"]["candidate_count"] == 1
                assert "prompt_tokens" not in research["metrics"] and "private" not in json.dumps(research)
                event = client.get("/api/runs/r1/events", headers=ha).json()["events"][0]
                assert event["stage"] == "WEB_RESEARCH" and "detail" not in event and "private" not in json.dumps(event)
                compile_job = client.get("/api/projects/p1/requirement-compile/compile1", headers=ha).json()
                assert compile_job["error"] == "COMPILE_FAILED" and "private" not in json.dumps(compile_job)
                requirements = client.get("/api/projects/p1/requirements", headers=ha).json()
                assert requirements["compilation"]["issues"] == ["COMPILE_FAILED"] and "private" not in json.dumps(requirements)
                assert client.get("/api/projects/p1/pipeline/pipe2", headers=ha).status_code == 404
                assert client.get("/api/projects/p1/analysis?pipeline_id=pipe2", headers=ha).status_code == 404
                assert client.get("/api/projects/p1/reports/report2", headers=ha).status_code == 404
                assert client.get("/api/projects/p1/reports/report2/download", headers=ha).status_code == 404
                assert client.get("/api/runs/r2", headers=ha).status_code == 404
                assert client.get("/internal/projects/p1/inputs/unknown", headers={"authorization": "Bearer local-test-only"}).status_code == 401
                assert client.post("/api/projects/p1/requirement-text", headers=ha, json={"text": "test"}).status_code == 403
                assert client.post("/api/projects/p1/requirement-text", headers={**hb, "origin": ORIGIN}, json={"text": "test"}).status_code == 404
                # A visitor may start the demo work; the server-side budget decides.
                compile = client.post("/api/projects/p1/requirement-compile", headers={**ha, "origin": ORIGIN}, json={})
                assert compile.status_code in (202, 409, 422, 429, 503), compile.text
                budget = client.post("/api/projects/p1/pipeline", headers={**ha, "origin": ORIGIN, "idempotency-key": "local-check"}, json={"demand_revision": 1})
                assert budget.status_code in (202, 409, 422, 429, 503), budget.text
                started = client.post("/api/projects/p1/pipeline", headers={**ha, "origin": ORIGIN}, json={"demand_revision": 1})
                assert started.status_code in (202, 400, 409, 422, 429, 503), (started.status_code, started.text)
                # Give the fixed-minute window enough time to run this burst.
                if time.time() % 60 > 40:
                    time.sleep(61 - time.time() % 60)
                limited_request = None
                for _ in range(42):
                    result = client.get("/api/session", headers={"cookie": new_cookie.split(";")[0]})
                    if result.status_code == 429:
                        limited_request = result
                        break
                    assert result.status_code == 200
                assert limited_request is not None and limited_request.json()["error"] == "rate_limited"
                assert int(limited_request.headers["retry-after"]) > 0
                if time.time() % 60 > 35:
                    time.sleep(61 - time.time() % 60)
                with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
                    statuses = list(pool.map(lambda _i: client.get("/api/session", headers={"cookie": cookie(burst_session)}).status_code, range(60)))
                assert statuses.count(200) == 40 and statuses.count(429) == 20, statuses
                print("PASS: real local Worker guest session, A/B isolation, Origin, creation/request limits, budget-admitted visitor writes and closed operator-only writes")
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
