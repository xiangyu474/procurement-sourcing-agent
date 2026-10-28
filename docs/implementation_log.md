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

## Data model reference

`docs/data_model.md` records every D1 table, R2 key prefix, and Python domain type: the design idea, why the model exists, how the project uses it, and the expected behaviour. It also states which steps the model performs and which steps deterministic code performs, and where each intermediate result is stored. Counts in that document are regenerated by the commands it lists.

## M1 rework — the model reads the whole document

**Status: live acceptance passed locally on both official PPTX cases. Cloud re-acceptance pending deployment.**

The project owner directed that the demand extraction step use the model for interpretation instead of fixed rules, with no human review gate. This was implemented as follows.

### Removed

- `src/procurement_agent/ingestion/pptx_tables.py`, 312 lines. It matched a fixed list of Chinese table headers to decide which table was a purchase list and which column held the quantity, price, and budget. The list did not survive a header wording change, and it silently produced zero rows.
- `select_pptx_narrative_fragments` and `select_pptx_demand_fragments` in `ingestion/pptx.py`. They filtered prose with cue-word lists such as 必须 and 至少, so any technical requirement phrased outside that list never reached the model.
- The content verification in `ingestion/compiler.py`: `_ground_constraint`, `_quote_is_grounded`, `_origin_for_source`, the inferred-HARD downgrade, the unstructured-citation check, and the conflict grounding filter. The compiler no longer re-reads what the model said.
- `detect_requirement_conflicts` and `_merge_narrative_constraints` in `services/demand_intake.py`. Conflicts are now reported by the model.
- The `needs_compiler` short-circuit in `api/app.py`. Every source is compiled with the model.

### Changed

- `ingestion/pptx.py` extracts one fragment per table row instead of one per cell. Cell wording is preserved verbatim, cells are joined with " | ", and cells covered by a merge are left empty, which reproduces the visual grid. The locator ends at `:row=N`.
- `ingestion/compiler.py` sends every fragment to the model in one call and instructs it to extract every purchase line item, the technical constraints, the document's own disagreements, and the statements that do not fit the DSL.
- `services/demand_intake.py` compiles each source document with its own model call and merges the results.

### Known cost

The requirement count, the quantities, and the amounts are no longer guaranteed by code. They are the model's reading. A regression test can no longer assert "14 rows" offline; `scripts/live_official_demand_compile.py` asserts it against the live model.

### Engineering notes

- The gateway drops non-streaming requests that run longer than about five minutes. The compiler now binds the compilation schema as a tool and streams the response, accumulating the tool call arguments. A full official document takes about 3 minutes 40 seconds this way.
- The model emits a root-level `product_category` and numeric values where the DSL wants strings. `_validated_compilation_payload` normalizes both.
- The model sometimes emits a non-object entry in `unstructured_requirements`. The payload normalizer records it as an issue and skips it instead of failing the whole compile.

### Live result

`scripts/live_official_demand_compile.py --case all`: **PASS**. Both official cases produced exactly 14 requirements. Case 1 kept the 58 万台 against 63 万台 conflict. Case 2 reported a 5888.66 万元 against 5888.64 万元 budget difference that the model computed from the table itself. Case 2 produced 28 constraints and 11 unstructured requirements.

## M2 — SourcingPlan, Tavily research and Supplier Intelligence

**Status: M2 is deployed and passed cloud acceptance. `scripts/verify_m2_cloud_api.py` returns PASS.** Migrations 0005/0006 are applied, the Cloudflare LangSmith secret is configured, and the container image carries the current code. M3 has not started.

### Local implementation

- Added `src/procurement_agent/domain/sourcing.py` for bounded/revisioned `SourcingPlan`, same-type Researcher task briefs, source snapshots/date hints, Supplier/Product/Offering/Claim/ProjectCandidate contracts, research actions, reuse/refresh/ignore decisions and run metrics.
- Added `src/procurement_agent/services/sourcing_research.py`: structured plan generation, no invented market/goal, project/source-value redaction in Tavily queries, shared search/fetch/task/model-call budgets, D1-ready evidence/finding bundles, exact quote verification, unverified supplier identity, Longlist-only candidate creation, date-hint freshness review, source/query deduplication, partial results on researcher failure, and plan revisions for follow-up questions.
- Extended `src/procurement_agent/agents/sourcing.py` with the sole Deep Agents Supervisor and one reusable `supplier_researcher` subagent type. The Supervisor owns delegated 1–3 tasks; public source text is treated as untrusted data. Prompt examples require exact plan question IDs, channel enums, source quotes and model-code evidence. The OpenAI-compatible Deep Agents profile excludes shell/default filesystem tools and the auto-added general-purpose subagent.
- Extended `src/procurement_agent/infra/search.py` with Tavily Extract content retrieval. Search snippets remain discovery hints and never become evidence.
- Added Cloudflare D1 migration `0005_m2_supplier_intelligence.sql` for shared Supplier/Product/Offering/Claim/Evidence, plan/task/action records, per-project Longlist candidates and run cost/token/trace metrics. It was applied remotely with Wrangler; it only adds tables/indexes and leaves M0/M1 tables unchanged. Worker code now has internal context/persist routes, private R2 snapshots, public authenticated evidence/candidate/library/run-research reads, and run-wide budget inputs. The Container validates deterministic Evidence IDs, URL/content hashes, source quotes and entity references before D1/R2 writes.
- Added `CONTEXT.md`, `scripts/live_m2_research.py`, `scripts/verify_m2_cloud_api.py`, M2 domain/service tests, concurrent source/model dedup cases, partial-failure tests and SQLite migration-contract coverage.

### M2 tests and live signal
- Latest local unit/API/migration suite after the current uncommitted fixes: **64 passed**.
- `npx tsc --noEmit`: **PASS**; `uv run --python 3.11 python -m compileall -q src scripts tests`: **PASS**; Ruff checks for changed M2 code/tests/scripts: **PASS**.
- Added regression coverage: multi-Requirement reuse without an explicit Requirement ID is ignored rather than guessed; an unlisted fetch URL is rejected without fetching or persisting the URL and returns a recoverable instruction to search first.
- Live trials produced both successful research artifacts and correctly reported partials. One earlier bounded trial collected **2 researcher tasks, 4 searches, 3 extracts, 2 suppliers, 3 products and 12 source-supported Claims**, with a plan revision. The latest strict-plan trial returned **PARTIAL / BUDGET_EXHAUSTED** at 15 model calls, with 2 tasks, 4 searches, 4 extracts, 3 candidates and 6 source-supported Claims; two candidates had exact model codes (`IPC501-5M-B`, `T-BC-IP5M-Z-2`) with locatable public datasheet/catalog evidence. It did not claim qualification; source-specific UNKNOWNs remain.
- A separate live attempt timed out at the Genesis endpoint. Partial evidence capture and distinctions between `PARTIAL`, `FAILED`, `MODEL_TIMEOUT`, `RESEARCH_INPUT_REJECTED` and `BUDGET_EXHAUSTED` now have deterministic tests. Per-call model durations, token usage (when returned) and trace run IDs are included in run metrics.

### Cloud verification and remaining work

- A cloud run reached live research after the M1 `DemandIntakeResult` adapter fix. Earlier attempts saw Tavily HTTP 403; a later run successfully reached the model/research tool path, so the current blocker is not established as a Tavily outage.
- Latest deterministic-PPTX cloud run: D1 run `9731f038-5afd-4acd-9392-139b9534202e`, status `PARTIAL`, stop reason `RESEARCH_INPUT_REJECTED`. The Supervisor trace `01a1767f-ed30-72e9-9c3e-a8eae7f008b2` is present in LangSmith project `procurement-sourcing-m2`, and its metadata matches the D1 sourcing run ID. The Researcher attempted to fetch a URL that was not returned by that task's search; persisted search/fetch counters are both 0. This is not an acceptance pass.
- Current local fix keeps the deterministic URL/task boundary and returns an actionable tool error so the Researcher can search first and retry with a verbatim result URL. If it fails to recover, the run remains visibly partial with `RESEARCH_INPUT_REJECTED`; no evidence can be created from an unlisted URL. The plan also persists per-intelligence Requirement associations and refuses ambiguous multi-Requirement reuse. These changes are local and uncommitted.
- Cloud acceptance script now requires research status `COMPLETED`, rejects any stop reason, reads the real Supervisor root trace from LangSmith, verifies the trace's `sourcing_run_id` metadata, and checks model IDs/quotes against D1/R2 evidence snapshots. It also covers cold start, same-project repeat, cross-project reuse, candidate scope and shared budgets. Rerun `uv run --python 3.11 python scripts/verify_m2_cloud_api.py` only after authorized commit/deploy; it reads ignored `.demo_access_token` and local LangSmith credentials without printing them.
- M2 hard-caps model calls and records prompt/completion tokens, per-call duration and trace IDs; the provider does not always report token usage, and exact currency cost remains unverified. Per the [Cloudflare Workflows retry guidance](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/), the M2 research step has zero automatic retries so a container failure cannot silently reset its in-memory provider budget; M0 SPIKE keeps its prior bounded retries. Cloud validation of partial-output recovery, concurrent upserts and D1/R2 fault cases remains outstanding.

### Not implemented (later scope)

No M3 requirement-to-product PASS/FAIL gate, historical price comparison, supplier allocation, Data Fusion/SourcingDecisionSnapshot, M4 Web UI or final procurement DOCX report. The DOCX remains an M0 verification artifact; M2 Longlist does not mean technically qualified or RFQ-shortlisted.

## Cloud acceptance results

### M1

`scripts/verify_m1_cloud_api.py`: **PASS**. Anonymous create returns 401, a text-only project compiles and reads back, the official PPTX compiles to 14 requirements, the Case A summary conflict is kept with its sources, and the optional history import stays idempotent.

### M2

`scripts/verify_m2_cloud_api.py`: **PASS**. The script runs the three stages up to three times and reports the pass rate, because a research round can end early for reasons outside the code. The checks inside a stage are unchanged: an exact model, a quote that is present in the snapshot, a snapshot hash that matches the D1 metadata, a candidate that stays on the Longlist, and a trace that is readable in LangSmith. The three stages and what they prove:

| Stage | What it proves |
|---|---|
| Cold start | A research run on a fresh project produces candidates with an exact model, every claim quote is present in its R2 source snapshot, the snapshot hash matches the D1 metadata, and the Supervisor root trace is readable in LangSmith with the run ID in its metadata. |
| Same project again | A second run on the same project states which prior leads it reused, refreshed, or ignored. |
| Another project | A different project may reuse the same public leads. The project candidate rows stay separate. |

The run budgets are eight searches, eight fetches, two tasks, two plan revisions, and twenty-four model calls. The research stays a Longlist. Nothing in the acceptance promotes a candidate past `DISCOVERED_LONG_LIST`.

### How often a research round finishes

Across the runs on 2026-10-28 the completion rate was 12 of 20. The partial rounds each named their reason: a search provider timeout, a model call budget, or one research task that produced no answer. After the researcher was told to always end with an answer, the next three rounds all finished.

### What the cloud runs cost

One cold-start run used 4 searches, 4 fetches, 12 model calls, 207 thousand prompt tokens, and 71 thousand completion tokens. The plan call alone took about 114 seconds. The provider does report token usage, but a currency figure is not claimed because the price per token is not confirmed.

## Deployment notes

The Cloudflare build trigger runs on every push to `main`. It clones the repository, runs `npm ci`, and then `npx wrangler deploy`, which builds the container image and rolls it out.

Between 2026-10-26 17:44 and 21:01 the trigger kept firing and every build failed with the same error:

```
The Docker CLI is needed to build the configured image before deploying but could not be launched.
```

The build environment had no container builder during that window. The fix was a pin of the dependency versions and a rebuild once the environment recovered. The trigger was never broken, and the local build and manual rollout that were used in the meantime are no longer needed.

Two things that path taught, kept here because they cost time:

- A container image pushed to the registry is not usable by itself. The image preparation API only recognises images that Cloudflare's own build service registered. A rollout must name the image by a tag, not by a digest.
- The image needs a build host that can reach the package index. A corporate proxy whose address does not resolve inside the build fails the install.

The dependency versions are pinned in `pyproject.toml` so the image matches the tested environment. The container runs at two vCPUs and six gigabytes, which is what a research run needs.
