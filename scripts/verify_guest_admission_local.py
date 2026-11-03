"""Exercise atomic guest admission under concurrent local Worker requests.

Usage: uv run --python 3.11 python scripts/verify_guest_admission_local.py
This is a test-only Worker with isolated local D1. The admission primitive is
not wired to public tasks and does not enforce provider spend.
"""

from __future__ import annotations

import concurrent.futures
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
    with tempfile.TemporaryDirectory(prefix="guest-admission-", ignore_cleanup_errors=True) as temp:
        directory = Path(temp)
        state = directory / "state"
        config = directory / "wrangler.json"
        config.write_text(json.dumps({
            "name": "guest-admission-test", "main": str(ROOT / "cloudflare/gateway/test/guest_admission_local_worker.ts"),
            "compatibility_date": "2026-10-13", "compatibility_flags": ["nodejs_compat"],
            "d1_databases": [{"binding": "DB", "database_name": "admission-test", "database_id": "00000000-0000-0000-0000-000000000003", "migrations_dir": str(ROOT / "cloudflare/gateway/migrations")}],
        }), encoding="utf-8")
        environment = {**os.environ, "WRANGLER_SEND_METRICS": "false"}
        common = ["--config", str(config), "--persist-to", str(state), "--local"]
        subprocess.run([NPX, "wrangler", "d1", "migrations", "apply", "DB", *common], cwd=ROOT, env=environment, check=True, capture_output=True, text=True, encoding="utf-8", errors="replace")
        seed = """
        INSERT INTO guest_sessions(id,created_at,expires_at,last_seen_at) VALUES ('a','2026','2099-01-01T00:00:00.000Z','2026'),('b','2026','2099-01-01T00:00:00.000Z','2026'),('c','2026','2099-01-01T00:00:00.000Z','2026');
        INSERT INTO projects(id,title,created_at,session_id) VALUES ('p-a','A','2026','a'),('p-b','B','2026','b'),('p-c','C','2026','c');
        """
        seed_file = directory / "seed.sql"
        seed_file.write_text(seed, encoding="utf-8")
        subprocess.run([NPX, "wrangler", "d1", "execute", "DB", *common, "--file", str(seed_file)], cwd=ROOT, env=environment, check=True, capture_output=True, text=True, encoding="utf-8", errors="replace")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        cmd = [NPX, "wrangler", "dev", "--config", str(config), "--persist-to", str(state), "--local", "--ip", "127.0.0.1", "--port", str(port), "--inspector-port", "0", "--log-level", "error"]
        log = (directory / "worker.log").open("w", encoding="utf-8")
        process = subprocess.Popen(cmd, cwd=ROOT, env=environment, stdout=log, stderr=subprocess.STDOUT)
        try:
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=15, trust_env=False) as client:
                for _ in range(60):
                    if process.poll() is not None:
                        log.flush()
                        raise RuntimeError(f"local Wrangler exited: {(directory / 'worker.log').read_text(encoding='utf-8', errors='replace')[-3000:]}")
                    try:
                        if client.get("/").status_code == 404:
                            break
                    except httpx.HTTPError:
                        pass
                    time.sleep(1)
                else:
                    raise RuntimeError("local Wrangler did not start")
                policy = {"globalConcurrent": 2, "sessionConcurrent": 1, "globalDailyUnits": 100, "sessionDailyUnits": 100, "sessionDailyStarts": 100}
                tasks = [{"sessionId": "abc"[i % 3], "projectId": f"p-{'abc'[i % 3]}", "operationId": f"task-{i}",
                          "kind": "PIPELINE", "requestHash": f"hash-{i}", "units": 1} for i in range(30)]
                def reserve(task: dict) -> dict:
                    response = client.post("/", json={"task": task, "policy": policy})
                    response.raise_for_status()
                    return response.json()
                with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
                    results = list(pool.map(reserve, tasks))
                accepted = [task for task, result in zip(tasks, results, strict=True) if result["kind"] == "CREATED"]
                assert len(accepted) == 2, results
                assert len({task["sessionId"] for task in accepted}) == 2
                assert reserve(accepted[0])["kind"] == "REUSED"
                assert reserve({**accepted[0], "requestHash": "different"})["kind"] == "CONFLICT"
                assert reserve({**accepted[0], "sessionId": "c", "projectId": "p-c"})["kind"] == "DENIED"
                print("PASS: isolated real Worker/D1 concurrent admission, per-session/global caps and retry identity")
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
