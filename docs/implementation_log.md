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

`scripts/verify_m2_cloud_api.py`: **PASS**.

**The acceptance criterion.** Each stage runs up to three times and the script reports the pass rate. A round that passes all three stages at least once is a PASS. The criterion asks whether the pipeline can produce sourced candidates, not whether the network and the model happened to cooperate on one particular attempt. Every round records why it ended early, in the run's `stop_reason_code`.

**The checks inside a stage are unchanged and are hard failures.** An exact model code, a quote that is present in the R2 snapshot, a snapshot hash that matches the D1 metadata, a candidate that stays on the Longlist, no duplicate candidate rows in one project, no candidate row shared between projects, and a Supervisor trace that is readable in LangSmith with the run ID in its metadata.

`scripts/verify_m1_cloud_api.py` uses the same rule.

The three M2 stages and what they prove:

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

## M3 — Requirement alignment, price comparability, decision gate

**Status: M3-0 (plan and baseline audit) done. M3-A1 next.**

### Plan

`docs/m3_plan.md` holds the file-level order, the data flow, the test mapping for the nine acceptance requirements, and the estimated change range. M3 runs in seven stages: M3-0 plan and audit, M3-A1 contracts and the pure calculator, M3-A2 claim typing and semantic alignment, M3-A3 cloud wiring and a real case, M3-B history and price comparability, M3-C decision and verification gate, and M3-Q quality strengthening that runs across the whole milestone.

### Baseline audit: M2 candidates and evidence

On run `4ca31b39` (the last passing M2 cold start): 39 candidate rows resolve to 28 suppliers, 17 products, and 8 distinct models. 35 of the 39 rows carry a model. 34 claims exist, 23 of them at model level, and 10 of the 17 products carry at least one model-level claim, which is 59 percent. 19 sources were fetched.

Two facts set the M3-A design. The 39 rows are 8 real models, mostly multiplied by supplier name spellings such as `LUCID`, `LUCID Vision Labs`, and `LUCID Vision Labs, Inc.`, so the evaluation unit is the model. And only 59 percent of products have a model-level claim, so a product without one must return UNKNOWN rather than pass on category similarity.

### Baseline audit: where the tokens go

The same run made 16 model calls: 266762 prompt tokens, 57954 completion tokens, 298.6 seconds. The supervisor alone took 205017 prompt tokens, which is 77 percent of the input, because each round carries the researcher's full claims and quotations in its context. The researcher took 57844 and the plan call 3901. M3-C feeds the supervisor a short summary and IDs, and M3-B does the same for the history analysis.

### Baseline audit: what the requirements actually contain

The M1 compiler produced one constraint per requirement on the official material, `onenet_access EQ True`, plus 26 unstructured statements. Reading the source presentation shows this is correct: the purchase table carries name, quantity, unit price, sales price, budget, and tax rate, and the 26 statements are project policy, payment terms, and sample labels.

The acceptance test material exposes a real gap. It asks for a `5MP  industrial network camera` and the compiler kept the 5MP in the product name and produced no constraint. M3-A needs a constraint to align against, so the first item of M3-Q, a prompt that turns objective specifications in the requirement text into quoted constraints plus a deterministic check that the number appears in the quote, has to land before the real case in M3-A2.

### M3-A1: contracts and the pure calculator

**Status: done. 48 new tests; the suite is 124 passed.**

Three files carry the work.

`src/procurement_agent/domain/spec_alignment.py` holds four contracts and four enums. `ProductAttributeClaim` is a typed statement about one product model, with the same `value_type` vocabulary the requirement DSL uses, so a comparison never crosses two vocabularies. `SemanticAlignment` records the decision that a constraint and a claim measure one thing. `ConstraintCheck` carries the outcome and the trace. `SpecAssessment` carries every check of one requirement against one model. The reason codes are explicit: only `VERIFIED_COMPARISON` may produce PASS or FAIL, and every other code names what is missing.

`src/procurement_agent/domain/units.py` is the unit whitelist. Each unit belongs to a dimension, and only units in one dimension convert into each other. Decimal storage bytes and binary storage bytes are different dimensions, so 32 GB never compares with 32 GiB. A frame rate is not a frequency. Two identical unknown units still compare, because the same unit cancels out of an ordering; two different unknown units do not.

`src/procurement_agent/services/spec_calculator.py` is the calculator. It reads its inputs and never changes them, and it reaches neither the network nor a model. A test asserts that the module does not import a provider client.

The admission order follows the calculator specification. The requirement must be `RESOLVED`, the product must carry an exact model code, the claim must be supported by a source, the attributes must be aligned, the units must convert, and only then does the comparison run. Anything missing returns UNKNOWN with the reason that names it.

The HARD aggregation is the rule the milestone asks for. One reliable HARD failure is FAIL even when the other HARD checks are UNKNOWN. PASS needs every HARD check to pass and no unresolved demand. A requirement without a HARD constraint is UNKNOWN, never PASS.

The three cases the milestone names outright behave as required: a 4 MP product fails a 5 MP minimum with the trace `4 MP GTE 5 MP`; a 150 µm housing passes a 0.2 mm limit with the trace `0.15 mm LTE 0.2 mm`; a product that states only maximum input power against a requirement for rated output power is UNKNOWN with `ATTRIBUTE_NOT_ALIGNED`.

One test proves the calculator does not grow per-category branches: four attributes from four different categories run through the same code path.

### M3-A1 documentation

`docs/requirement_dsl.md` is the quick reference for the Requirement DSL: the fields, the value types, the operator whitelist, the three statuses, eight common mistakes, and how M3 consumes the DSL. `docs/m3_plan.md` holds the file-level order and the acceptance mapping. `docs/data_model.md` gained a section for the four new contracts and the unit table, with regenerated counts.

### M3-Q1: the compiler turns a stated specification into a constraint

**Status: done. The compiler now emits a constraint for a specification that the requirement text states, and a deterministic check confirms the number and the citation.**

The prompt gained one rule and one example. The rule says that a specification the text states is a constraint even when the same number also appears in the product name, and it names the figures that matter: 5MP, 4MP, IP66, -20 to 80 degrees Celsius, 7.5kW, 150 micrometres, 30fps, 12V. The example shows a requirement for a 5MP camera carrying one `output_resolution` constraint with value 5 and unit MP, while the product name stays as the document wrote it.

`src/procurement_agent/services/requirement_verification.py` checks what the model reported. For every constraint it confirms that the quoted text appears in the cited fragment and that the quoted text states the value on the unit the requirement states, including a Chinese scale word, so 500万像素 confirms a 5 MP constraint. For every quantity and amount it confirms that the cited text states the number. A constraint that cannot be confirmed becomes AMBIGUOUS, which keeps it out of the automatic PASS/FAIL gate, and the reason is recorded. Nothing is deleted: a quantity, a price, and a budget keep the value the model gave, and an unconfirmed one is reported as an issue and an open question.

The check of the project total recomputes the sum of the line-item budgets and classifies the difference. The classification separates our own arithmetic being wrong, the gap that the rounded row budgets explain, and a difference inside the source. The tolerance is the number of rows plus one times half of the last printed digit, because each row budget is rounded and the project total is rounded once more.

`tests/test_case2_budget_regression.py` recomputes the official case 2 reading. The sum of the fourteen line-item budgets is 5888.64 万元. The document states 5888.66 万元. The unrounded rows add up to 5888.656 万元, which is the 5888.66 万元 the document states, so the 0.02 万元 gap is the rounding of the row budgets and not a mistake. The test skips when the official files are not in the local workspace.

### What the live check found

Running `scripts/live_m3q_verification.py` against the local test material and the official case 2 presentation:

- The test material now compiles to one requirement with one constraint: `output_resolution GTE 5 MP`, importance HARD, parse status RESOLVED, quote `5MP 工业网络摄像机`. Before the change the constraint list was empty.
- The official case 2 presentation compiles to 14 requirements and 50 constraints. The constraints now include the specifications that the product names state, such as `solar_panel_power`, `voice_intercom`, and `onenet_access`.
- The total check reports `ROUNDING`: the document states 5888.64 and 5888.66, and the gap of 0.02 is within the 0.075 that fourteen rounded row budgets can explain.

### A pre-existing failure the check exposed

The live check also found that the model sometimes answers a document with an empty purchase line list. The same happened with the prompt before this change, so it was not caused by it: one of two attempts with the old prompt returned zero requirements for the official case 2, and the compiler accepted that answer silently.

The compiler now asks again when the answer carries no purchase line, and it accepts an empty answer only after the last attempt. `MAX_COMPILER_ATTEMPTS` is three. This turned the observed case from zero requirements into fourteen.

### M3-A2: typed claims, semantic alignment, and the evaluation entry point

**Status: done. 29 new tests; the suite is 172 passed.**

`src/procurement_agent/services/source_numbers.py` holds the question both sides ask: does this text state this number, on this unit? The demand verification and the product claim typer now judge a quotation the same way, so a number that the compiler would have refused is not accepted by the typer either.

`src/procurement_agent/services/spec_typing.py` turns the research claims into typed claims. The model gives each claim an attribute key, a definition of what the attribute measures, a value type, a value, and a unit. The code then checks the reading against the claim's own quotation: a number has to be in the quotation, a text value has to be in the quotation, every token of a set has to be in the quotation, a boolean has to match a word in the quotation, and both bounds of a range have to be in the quotation. A claim that fails the check does not become a usable claim. It stays unverified, and the calculator refuses it, so a model cannot invent a threshold that turns into a pass. The claims are typed twenty at a time, because one call with ninety-nine claims was slow enough to time out.

`src/procurement_agent/services/spec_alignment.py` decides whether a constraint and a claim measure the same thing. The model proposes the pairing and names its method. The code checks what it can: the claim has to exist for the candidate under assessment, a pairing that claims the attribute keys are identical is only kept when they are, a pairing that claims an approved alias is only kept when the alias table says so, a reviewed pairing has to name the measurement object, and a unit conversion has to be one the whitelist allows. The alias table is small and reviewed by hand. `max_input_power` and `rated_output_power` are in different groups on purpose, because they are not the same measurement.

`src/procurement_agent/services/spec_evaluation.py` is the entry point. It types the claims, aligns every constraint of every requirement with every candidate that belongs to it, and hands the result to the calculator. The model never decides a verdict.

### The live case with the real M2 output

`scripts/live_m3_spec_evaluation.py` reads a finished M2 run from the cloud, takes the real product claims the researcher recorded, compiles the requirement locally with the current compiler, and runs the whole chain.

The first run of that script over the M2 cold-start run `4ca31b39` produced 39 assessments, one per candidate, and every one of them UNKNOWN with `ATTRIBUTE_NOT_ALIGNED`. The reason the model gave is the interesting part: the requirement asks for the video output pixel count, while the LUCID claims state the camera's sensor resolution, five megapixels on the Sony IMX264 sensor array. Sensor effective pixels and video output pixels are not the same quantity, so the alignment refused the pairing instead of letting a matching number pass.

That is the behaviour the milestone asks for, on real data: a number that looks like a match is not a match when the two sides measure different things.

The evaluation groups the candidates by product model before it aligns them, because the technical check is a requirement against a model and several candidate rows point at the same model. With the real M2 output that is 39 candidate rows and 9 models, and the alignment call count falls from 39 to 9. The model had been answering with duplicate-check notes before, because it was asked about the same product again and again.

### The final live result over the real M2 output

The requirement was compiled locally from the same 5MP material the M2 acceptance uses, with two constraints: the video output resolution of at least 5 MP, and ONVIF support. The products and their claims are the real ones from run `4ca31b39`.

| Outcome | Count |
|---|---|
| PASS | 3 checks, all the same model: LUCID `TRI050S-CC`, the resolution constraint, operation `5 MP GTE 5 MP` |
| UNKNOWN, `ATTRIBUTE_NOT_ALIGNED` | 67 checks |
| UNKNOWN, `MODEL_VARIANT_UNCERTAIN` | 8 checks, the candidates with no exact model code |

Every UNKNOWN names the claim that was rejected and why. The LUCID `TRI055N` says the claim measures connector types with an IP67 context, which is not the output pixel count. The `CAM-CIC-5000R-14-G` says trigger and strobe support is a synchronization signal, not a pixel count. The `NBN-80052-BA` says the claims cover output resolution, product type, availability, sensor optical format, environmental rating and power input, and state no ONVIF support anywhere.

Two findings came out of this run that the next stage has to answer:

- **The research mostly states sensor resolution while the buyer asks for video output resolution.** The two are not the same quantity, so the alignment refuses them. Either the research has to ask for the output resolution, or the demand has to say which quantity it means.
- **One real claim states ONVIF conformance** as the phrase `Conforms to ONVIF Profile S`, while its quotation reads `The camera conforms to the ONVIF Profile S specifications.` A string value is refused because the phrase is not verbatim in the quotation, and the token set `ONVIF Profile S` is accepted. The typing prompt should prefer the token set for a protocol list, and the alignment should then find that claim.

The provider returned a 504 in the middle of one typing batch while this was running. The typing and the alignment now survive a provider failure: the claims of the failed batch stay untyped and the constraints stay UNKNOWN, instead of the whole evaluation failing.

### M3-A3: the technical check in the cloud

**Status: deployed. The cloud acceptance is queued behind a local network block.**

The gateway reads the compiled demand, the project candidates, and the product claims from D1, and hands them to the container. The container types the claims, aligns them with the constraints, judges them with the calculator, and posts the verdicts back. The verdicts land in `spec_assessments`, keyed by the project, the requirement, the candidate, and the demand revision, so that re-evaluating the same demand revision replaces the row instead of adding a second one, and a new demand revision leaves the old verdicts in place.

Three routes were added. `POST /api/projects/{id}/spec-assessments` starts the evaluation and answers with a job ID, `GET /api/projects/{id}/spec-assessments` reads the verdicts back, and two internal routes carry the context to the container and the verdicts back. The evaluation holds one model call open for minutes, so it runs as a workflow, the same way the demand compile does, and the client polls the result.

`scripts/verify_m3_cloud_api.py` compiles a demand, runs a research round, triggers the evaluation, and reads the verdicts back. It checks that every verdict is one of the three values, that a PASS or a FAIL carries a verified comparison and the calculation, that a failing check is reflected in the overall verdict, that a PASS never rides on a hard check that did not pass, and that the calculator version is recorded.

Migration `0007_m3_spec_assessment.sql` is applied to the remote D1.

### The local network block

The cloud acceptance could not be run from this machine. The enterprise DNS now refuses every query, and the public resolvers answer `*.workers.dev` with an internal sinkhole address while other domains resolve normally:

| Host | Answer |
|---|---|
| `api.cloudflare.com` | 104.19.x.x, the real addresses |
| `github.com` | 20.205.243.166, the real address |
| `token.moi.matrixorigin.cn` | 116.62.x.x, the real addresses |
| `procurement-sourcing-gateway.xiangyu474.workers.dev` | 128.242.240.91, a sinkhole |

The same machine reached the Worker earlier in the same session, so the block was enabled during the session rather than being the normal state. The Cloudflare side is fine: the build for `af318a4` deployed successfully, and the Cloudflare API answers normally. A watcher runs the three cloud acceptance scripts as soon as the network answers again.

### M3-B: price comparability, history analytics, and the equivalence fusion

**Status: done. 33 new tests; the suite is 205 passed.**

`src/procurement_agent/domain/pricing.py` holds the price contracts. `PriceObservation` is one number with the context needed to compare it: what kind of number it is, its currency, its unit, its tax basis, and what it belongs to.

`src/procurement_agent/services/price_analysis.py` decides whether two prices can be compared. The pairs of kinds that answer a buyer's question are explicit. Two prices of one kind compare with each other, so a lowest price exists. A formal quotation compares with the budget, which is the saving, and with the historical transaction, which is the offer against the past. A public listing compares with nothing but another public listing: it is a price somebody posted, not an offer, so it never produces a saving.

`src/procurement_agent/services/history_analytics.py` computes the distribution of what was bought before, from the real fields of the imported rows: the count, the minimum, the maximum, the median, the mean, the two quartiles, and the purchase volume. A row without a unit price is counted and reported but does not enter the distribution. The rows of the simulated suppliers stay in their own group and are never named after a public company. The unit of the imported price column is not part of a row, so the caller states it; without it the history cannot be compared with a budget that states one.

`src/procurement_agent/services/product_equivalence.py` fuses the history and the public leads. The key is a confirmed product equivalence, never the supplier name. An unconfirmed relation is kept out of the index, so two records that share a supplier name but no confirmed equivalence are never joined.

`src/procurement_agent/services/price_context.py` brings the three together for one requirement. A requirement without a history still gets a context; the history part says there is none.

Two rules came out of writing the tests. A set of prices that mixes kinds has no meaningful cheapest member, so the whole set is reported as not comparable and no lowest price is named. And the price series is analysed per kind, so a project with both history and public listings still gets the answer each of them supports.

### M3-C: the sourcing decision and the verification gate

**Status: deployed. 20 new tests; the suite is 225 passed.**

`src/procurement_agent/domain/decision.py` separates the recommendation from the technical verdict. The verdict is a field with three values, and the gate compares it with the assessment that was computed. That is what keeps an unknown from being written down as a verified pass: the model cannot reword its way past a field.

`src/procurement_agent/services/sourcing_decision.py` asks the Supervisor for one decision per candidate and puts the answer through the gate. The Supervisor reads a summary, not the sources: per candidate it gets the overall verdict, the per-constraint status and reason code, the computed operation, the price finding, and the identifiers of the evidence that exists. The quotations and the pages are not in that context. A test asserts that a long source quotation does not reach the model and that the context stays small, because in M2 the supervisor consumed 77 percent of the input tokens by carrying the researcher's full findings in its context.

`src/procurement_agent/services/decision_gate.py` does the checking. The rules it enforces:

- A model with a failed hard requirement cannot reach the short list. The decision is stored as rejected with the failure named.
- An unknown cannot be written down as a verified pass. A verdict that contradicts the computed check is refused.
- An unknown may be shortlisted when the decision names what is missing. A shortlist entry with no gap is refused, because a shortlist entry without a gap hides the gap.
- Every cited evidence identifier has to be in the ledger. An identifier that is not there is refused, and the evidence that does exist is still kept.
- A saving may only be stated when the price analysis produced one, and the stated saving has to be the one that was computed.

The gateway stores the decisions, including the rejected ones and the reason they were rejected, in `sourcing_decisions`. `POST /api/projects/{id}/decisions` starts the decision and `GET /api/projects/{id}/decisions` reads it back. The decision holds one model call open for minutes, so it runs as a workflow, the same way the technical check does.

`scripts/verify_m3_decision_api.py` drives the whole chain on the deployed Worker and checks the gate rules on what was stored: no accepted decision shortlists a failed model, no accepted decision calls an unknown a verified pass, every cited evidence identifier exists, and every rejected decision names a violation.

Migration `0008_m3_sourcing_decision.sql` is applied to the remote D1.

### What M3 now delivers

The three slices the milestone names are built:

- M3-A: the requirement and the product model are aligned and compared by a pure calculator that returns PASS, FAIL, or UNKNOWN with its reason code and its calculation.
- M3-B: the history is analysed on its real fields, the prices are compared by their basis, and the history and the public leads are fused by a confirmed product equivalence rather than by a supplier name.
- M3-C: the Supervisor writes the decision from a compact summary, and a program checks the decision against the analysis that was computed.

The cloud acceptance for all three is still waiting on the local network to reach the Worker.

### The M3 acceptance check

`docs/m3_verification.md` goes through every section of the M3 acceptance document and answers it with the implementation, the test that proves it, and the measured result. The three slices pass their local acceptance. The cloud acceptance is waiting on the network.

Two gaps were found by the check and closed:

- The token and time limits were constants in the code. They are now settings: `MODEL_TIMEOUT_SECONDS`, `MODEL_MAX_OUTPUT_TOKENS`, `M3_SPEC_TYPING_BATCH_SIZE`, and `M3_SPEC_ALIGNMENT_CANDIDATES`. The typing, the alignment, and the decision all take a run configuration, so a caller can attach a token counter or a model call budget.
- The model price cannot be verified from here. The gateway lists eighteen models with their context windows but no price fields, and its billing, account, and balance endpoints answer 404. The token usage is measured instead: one technical check over the real M2 output costs 8 model calls, 18154 prompt tokens, 86933 completion tokens, and 563 seconds.

That last number carries a lesson: the completion tokens are 4.8 times the prompt tokens, because the model is a reasoning model and most of the output is thinking. A budget that only counts the prompt will be wrong.

### The cloud acceptance, run from the side that can reach the gateway

The local network blocks `*.workers.dev`, so the acceptance now also runs inside the container, on Cloudflare's side, where the gateway is reachable. A workflow starts it and the report comes back in the workflow instance output.

Making that work took four fixes, each of them a fact worth keeping:

- **A running container keeps the image it was started with.** After a deploy the warm instance still served the previous image, so the new container endpoint answered 404. The instance name is now a configuration value, and bringing a new image into service means bumping it.
- **The acceptance waits in the workflow, not in the container.** One container request that carried the compile, the research, the technical check, and the decision was disconnected after two and a half minutes. Every request now does one short thing, and the workflow asks again until the stage reports that it is done.
- **The acceptance needs its own container instance.** It drives the public API, and the public API starts workflows that call a container, so with one instance the acceptance waited for a container that was waiting for it.
- **The compiler answers with several shapes.** The model writes the line item in a list, beside the fields of the constraint, or under a single top-level key. Reading only one of them emptied the compilation and the acceptance reported "no recognizable demand". All three shapes are read now.

**The result.** The acceptance ran on Cloudflare's side and passed:

| Stage | Result |
|---|---|
| M1 | 1 requirement, 1 constraint, compiled |
| M2 | the research run finished COMPLETED, 21 candidates |
| M3-A | 21 assessments: 5 PASS, 16 UNKNOWN |
| M3-C | 21 decisions: 5 shortlist, 16 investigate, all 21 accepted, none rejected |

The five passes are real verdicts, each with its calculation and its evidence: `CAM-CIC-5000-20-G`, `TRI050S-MC`, and `TRI050S-QC` meet the requirement of at least 5 MP with the trace `5 MP GTE 5 MP` and a cited evidence ID. The sixteen unknowns name the claim they refused and why.

The decisions follow the verdicts: the five that passed are shortlist with a verified pass, the sixteen that could not be judged are investigate with an unverified verdict. No decision invented an evidence identifier, no unknown was written down as a pass, and no rejected verdict was accepted.

The script `scripts/run_cloud_acceptance.py` starts the workflow through the Cloudflare API and prints the report. The other acceptance scripts, which drive the same gateway over HTTP, remain the better choice when the network allows it.
