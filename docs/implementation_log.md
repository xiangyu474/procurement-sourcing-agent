# Implementation Log

## M0 — Cloudflare deployment and agent smoke (passed)

- Deployed Worker: `https://procurement-sourcing-gateway.xiangyu474.workers.dev`.
- Python Deep Agents Container, Durable Object, Workflows, D1, and private R2 are active. Container images build on Cloudflare Workers Builds; no local Docker/Docker Hub.
- Verified task `202 + run_id`, 70-second browser disconnect, D1 stage events, terminal `FAILED`, idempotency key, internal bearer rejection, and DOCX write/read/download from R2.
- M0 long work was a clearly labelled stage simulation; it did not claim actual supplier research.
- Earlier faults fixed: Pydantic-reserved field name, insufficient `lite` instance, health probe, applied migration altered instead of adding a new migration, and failure state stuck at QUEUED.
- Remaining M0 reliability work: SIGTERM/container termination recovery and exact provider/Cloudflare usage cost measurement.

## M1 — Demand intake, Requirement DSL, optional XLSX history

**Status: local test suite and deployed Cloud API acceptance passed. Repository remains private.**

### Implemented files

- `src/procurement_agent/domain/requirements.py`: versioned Requirement DSL, dynamic attribute keys, whitelisted types/operators, `HARD/PREFERENCE/UNKNOWN`, source provenance, `RESOLVED/AMBIGUOUS/UNSUPPORTED`, planned-price/budget types, conflicts, optional-history state and history row models.
- `src/procurement_agent/ingestion/text.py`: revisioned plain-text input and character-range provenance.
- `src/procurement_agent/ingestion/pptx.py`: extraction of slide text and every table cell with file/slide/shape/table/row/cell locators; no fixed-slide parser assumption.
- `src/procurement_agent/ingestion/pptx_tables.py`: header-driven procurement-line extraction, planned prices and budgets, and source-grounded project-summary quantity conflicts. The Case A 58/63 万台 difference is retained as unresolved.
- `src/procurement_agent/ingestion/xlsx.py`: automatic header scan, aliases, row provenance, stable SHA-256 dataset identity scoped by project, and simulated-supplier namespace isolation.
- `src/procurement_agent/ingestion/compiler.py`: function-calling structured model compilation; strict Pydantic validation; source quotes must match source fragments; bad or incomplete outputs remain unstructured/ambiguous. Pixel basis ambiguity is guarded deterministically.
- `src/procurement_agent/services/demand_intake.py`: independent source compilation, text/PPT conflict detection, optional history, and analysis-version behavior.
- `src/procurement_agent/api/app.py`: internal Container endpoints for demand compilation, private PPTX retrieval and optional XLSX import.
- `cloudflare/gateway/src/index.ts`, `cloudflare/gateway/migrations/0004_m1_demand_intake.sql`: bearer-protected project and input API, private R2 upload, compile/store/read, optional-history import, hash idempotency and demand/analysis revisions.
- Tests/fixtures/scripts include DSL schema and semantics, ingestion, API handlers, migration contract, official regression, live compiler, live official PPT compilation and cloud API acceptance.

### Reproducible local verification

```bash
uv run --python 3.11 python -m pytest -q
# 36 passed
npx tsc --noEmit
# PASS
uv run --python 3.11 python -m compileall -q src scripts tests
# PASS
uv run --python 3.11 python scripts/live_demand_compile.py
# live Genesis: PASS — 100 电源模块, 额定输出功率 >= 7.5 kW is HARD, CAN is PREFERENCE, source locators retained
uv run --python 3.11 python scripts/live_official_demand_compile.py --case 1
# PASS — 14 purchase rows; 58/63 万台 summary conflict retained
uv run --python 3.11 python scripts/live_official_demand_compile.py --case 2
# PASS — 14 purchase rows, no invented technical hard constraints
uv run --python 3.11 python scripts/eval_requirement_semantics.py
# live, gold-labelled semantics: 6/6 PASS
```

Both official XLSX files parse as 1,000 non-empty rows, 38 columns, header row 8. They are explicitly marked synthetic and every imported supplier entity remains `HISTORICAL_SUPPLIER_SIMULATED`. Official files are outside this repository and were not committed.

### Cloudflare M1 acceptance (real API calls)

- M1 Worker deployed from private GitHub through Workers Builds; D1 migration `0004_m1_demand_intake.sql` applied; API bearer secret is configured.
- Anonymous project creation returns 401. Authenticated text-only project → compile → `GET /requirements` returns the same saved compilation, with history `NOT_PROVIDED`.
- Official Case 2 PPTX-only upload → compile → readback passes with 14 line items and no history.
- Official Case A PPTX compile returns 14 line items and retains the 58/63 万台 `DataConflict`; source evidence is preserved.
- Official XLSX upload/import returns 1,000 × 38, header row 8, synthetic true; duplicate import is idempotent and does not increment the project analysis version again.
- Re-importing the identical XLSX into separate projects now produces separate project-scoped dataset IDs. The prior global-hash ID collision was fixed and the full cloud script passes.
- `scripts/verify_m1_cloud_api.py`: **PASS** across auth, text-only save/read, PPT-only save/read, Case A conflict, optional history import and duplicate import.
- Final M1 Worker build version: `7173545a-c6ae-483f-904d-f3a25df48bbd`. Latest code commit: `7fd1570` (remote, private).

### Traces

- Live text Requirement DSL compile: LangSmith root trace `01a16f55-4b22-77d5-82c0-ea22d29dfb63`.
- Six gold-labelled semantic cases: `01a170fc-1b2a-72e8-b00f-d19afeac2ff3`, `01a170fa-f34a-768d-87df-99feee6fa9e8`, `01a170fa-c18c-70d8-a739-75cdc61bb743`, `01a170fa-7d4b-734c-a10f-6c5d05b5220f`, `01a170fa-431b-7469-a84c-81e76f0ed9ad`, `01a170fa-0f88-7432-9d40-707a7583f7c8` (all successful).
- Cloudflare Worker/Workflow/container results are recorded in D1 and the Worker Logs; no LLM/search key values are logged or stored in D1/R2.

## M2 — SourcingPlan, Tavily research and Supplier Intelligence

**Status: local vertical slice implemented; migration 0005 applied remotely; Worker/Container deployment and cloud acceptance pending. Do not call M2 complete yet.**

### Local implementation

- Added `src/procurement_agent/domain/sourcing.py` for bounded/revisioned `SourcingPlan`, same-type Researcher task briefs, source snapshots/date hints, Supplier/Product/Offering/Claim/ProjectCandidate contracts, research actions, reuse/refresh/ignore decisions and run metrics.
- Added `src/procurement_agent/services/sourcing_research.py`: structured plan generation, no invented market/goal, project/source-value redaction in Tavily queries, shared search/fetch/task/model-call budgets, D1-ready evidence/finding bundles, exact quote verification, unverified supplier identity, Longlist-only candidate creation, date-hint freshness review, source/query deduplication, partial results on researcher failure, and plan revisions for follow-up questions.
- Extended `src/procurement_agent/agents/sourcing.py` with the sole Deep Agents Supervisor and one reusable `supplier_researcher` subagent type. The Supervisor owns delegated 1–3 tasks; public source text is treated as untrusted data. Prompt examples require exact plan question IDs, channel enums, source quotes and model-code evidence. The OpenAI-compatible Deep Agents profile excludes shell/default filesystem tools and the auto-added general-purpose subagent.
- Extended `src/procurement_agent/infra/search.py` with Tavily Extract content retrieval. Search snippets remain discovery hints and never become evidence.
- Added Cloudflare D1 migration `0005_m2_supplier_intelligence.sql` for shared Supplier/Product/Offering/Claim/Evidence, plan/task/action records, per-project Longlist candidates and run cost/token/trace metrics. It was applied remotely with Wrangler; it only adds tables/indexes and leaves M0/M1 tables unchanged. Worker code now has internal context/persist routes, private R2 snapshots, public authenticated evidence/candidate/library/run-research reads, and run-wide budget inputs. The Container validates deterministic Evidence IDs, URL/content hashes, source quotes and entity references before D1/R2 writes.
- Added `CONTEXT.md`, `scripts/live_m2_research.py`, `scripts/verify_m2_cloud_api.py`, M2 domain/service tests, concurrent source/model dedup cases, partial-failure tests and SQLite migration-contract coverage.

### M2 tests and live signal

- Latest local unit/API/migration suite after the review fixes: **60 passed**.
- `npx tsc --noEmit`: **PASS**; `uv run --python 3.11 python -m compileall -q src scripts tests`: **PASS**; Ruff checks for changed M2 code/tests/scripts: **PASS**.
- Live trials produced both successful research artifacts and correctly reported partials. One earlier bounded trial collected **2 researcher tasks, 4 searches, 3 extracts, 2 suppliers, 3 products and 12 source-supported Claims**, with a plan revision. The latest strict-plan trial returned **PARTIAL / BUDGET_EXHAUSTED** at 15 model calls, with 2 tasks, 4 searches, 4 extracts, 3 candidates and 6 source-supported Claims; two candidates had exact model codes (`IPC501-5M-B`, `T-BC-IP5M-Z-2`) with locatable public datasheet/catalog evidence. It did not claim qualification; source-specific UNKNOWNs remain.
- A separate live attempt timed out at the Genesis endpoint. Partial evidence capture and distinctions between `PARTIAL`, `FAILED`, `MODEL_TIMEOUT`, `RESEARCH_INPUT_REJECTED` and `BUDGET_EXHAUSTED` now have deterministic tests. Per-call model durations, token usage (when returned) and trace run IDs are included in run metrics.

### Deployment still required

- **Not deployed:** migrations 0005 and 0006 are applied, but Worker/gateway M2 code and the updated Container image have not been pushed/deployed. No claim of cloud D1/R2 persistence or cloud reuse is made yet.
- After code review and Workers Builds deployment, run `uv run --python 3.11 python scripts/verify_m2_cloud_api.py` using ignored `.demo_access_token`. It caps each run at 4 searches, 4 fetches, 2 tasks, 2 plan revisions and 15 model calls; it verifies cold start, same-project rerun, cross-project reuse, D1 associations, R2 snapshot/hash/quote readback and project-candidate scope.
- M2 hard-caps model calls and records prompt/completion tokens, per-call duration and trace IDs; the provider does not always report token usage, and exact currency cost remains unverified. Per official Cloudflare Workflows retry guidance, the M2 research step is configured with zero automatic retries so a container failure cannot silently reset its in-memory provider budget; M0 SPIKE keeps its prior bounded retries. Mid-research termination still produces a visible failure, but the cloud partial-output path must be verified.
- At the last read-only secret-name check, Cloudflare did not have a `LANGSMITH_API_KEY` secret. The Worker forwards it only when configured; set the secret without displaying its value before cloud trace acceptance.

### Not implemented (later scope)

No M3 requirement-to-product PASS/FAIL gate, historical price comparison, supplier allocation, Data Fusion/SourcingDecisionSnapshot, M4 Web UI or final procurement DOCX report. The DOCX remains an M0 verification artifact; M2 Longlist does not mean technically qualified or RFQ-shortlisted.
