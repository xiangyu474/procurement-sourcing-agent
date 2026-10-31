# 数据模型与存储参考

本文是参考文档。读完能回答三个问题：每张表和每个模型为什么存在，谁写它，读它的人会看到什么。

本文不写计划中的模型。未落地的设计不列在这里。

## 范围与计数

数据落在三处：

- **D1** 存结构化事实。表、列、唯一约束。
- **R2** 存原始文件、网页快照正文、标准化历史数据。
- **LangSmith** 存模型与工具的原始轨迹。

重新生成下面的计数：

```bash
cd procurement_sourcing_agent
grep -h "CREATE TABLE IF NOT EXISTS" cloudflare/gateway/migrations/*.sql \
  | sed 's/CREATE TABLE IF NOT EXISTS //;s/ (//' | sort | nl
grep -c "^class " src/procurement_agent/domain/*.py
grep -h "CREATE INDEX IF NOT EXISTS\|CREATE UNIQUE INDEX IF NOT EXISTS" \
  cloudflare/gateway/migrations/*.sql | wc -l
```

当前计数：

| 位置 | 数量 |
|---|---|
| D1 表 | 22 |
| D1 索引 | 19 |
| `domain/requirements.py` 领域类型 | 20，其中 9 个枚举，11 个模型 |
| `domain/sourcing.py` 领域类型 | 30，其中 10 个枚举，20 个模型 |
| `domain/spec_alignment.py` 领域类型 | 12，其中 4 个枚举，8 个模型 |
| `domain/pricing.py` 领域类型 | 7，其中 3 个枚举，4 个模型 |
| `domain/decision.py` 领域类型 | 7，其中 3 个枚举，4 个模型 |
| `domain/units.py` 领域类型 | 2 |
| R2 key 前缀 | 4 |

## 三层存储的分工

| 层 | 存什么 | 不存什么 |
|---|---|---|
| D1 | 需求、情报、证据元数据、候选、运行审计 | 网页正文，模型原始输出 |
| R2 | 上传的原始文件、网页快照正文、标准化历史数据 | 任何需要查询的字段 |
| LangSmith | 每次模型调用、每次工具调用、结构化输出原文 | 可被业务查询的结论 |

三层各有唯一职责，不互相覆盖。结论进 D1，证据原文进 R2，模型怎么想进 LangSmith。

## 生命周期主线

```
项目 projects
  ├─ 输入 source_inputs        （需求文本 / 需求 PPTX / 可选历史 XLSX）
  │    └─ 编译 demand_compilations
  │         └─ 需求条目 Requirement（每条带 requirement_id）
  ├─ 运行 runs
  │    ├─ 计划 sourcing_plans
  │    ├─ 任务 research_tasks
  │    ├─ 动作 research_actions
  │    ├─ 证据 research_evidence   （正文在 R2）
  │    ├─ 成本 research_run_costs
  │    └─ 候选 project_candidates
  │         └─ 候选证据 project_candidate_evidence
  └─ 历史 history_datasets（可选）
```

情报层 `intelligence_products`、`intelligence_suppliers`、`supplier_product_offerings` 不挂在项目下。它们挂在 `workspace_id` 下，全工作区共享。

## 项目与运行

### `projects`

- **设计理念**：项目是"一次寻源委托"的边界。输入、编译、运行、候选都挂在它下面。
- **为什么需要**：三类数据的作用域不同。需求和候选属于单个项目，情报属于整个工作区。需要一个锚点把前两者和后者隔开。
- **怎么用**：`POST /api/projects` 建立。`GET /api/projects/{id}` 读取。
- **预期行为**：`demand_revision` 在每次重新编译后加一。`analysis_version` 在导入的历史数据变化时加一。`history_availability` 取 `NOT_PROVIDED`、`IMPORTED`、`IMPORT_FAILED` 三值之一。

### `runs`

- **设计理念**：一次运行的执行记录。它是幂等键、状态机、成本归属和 LangSmith trace 的连接点。
- **为什么需要**：同一个项目可以跑很多次。没有 run 就无法区分"这次跑出来的"和"上次跑出来的"。
- **怎么用**：`POST /api/projects/{id}/runs` 发起。`idempotency_key` 唯一标识一次业务意图。`GET /api/runs/{id}` 读取状态。
- **预期行为**：`status` 取 `QUEUED`、`RUNNING`、`COMPLETED`、`PARTIAL`、`FAILED`。同一 `idempotency_key` 重复提交返回同一个 run。`last_error` 记录失败原因，迁移 `0003` 新增该列。

### `run_events`

- **设计理念**：运行的阶段流水，让断连的用户能补看进度。
- **为什么需要**：M0 的验收要求浏览器断开后任务继续，且能观察到阶段。状态字段只能给出最终态，给不出过程。
- **怎么用**：Container 调 `POST /internal/runs/{id}/events` 追加。`GET /api/runs/{id}/events` 按时间顺序读取。
- **预期行为**：只追加，不更新。同一 run 的事件按 `created_at` 单调递增。

## 需求输入与编译

### `source_inputs`

- **设计理念**：项目挂载的每个输入文件或文本块的登记处。文件和内容分开。
- **为什么需要**：需求来源可能是多份 PPTX 加一份文本。可选的历史 XLSX 必须和需求分开存放，否则历史里的供应商会污染需求。
- **怎么用**：`POST /api/projects/{id}/upload-sessions` 写入。`purpose` 取 `REQUIREMENT`、`HISTORY`、`SUPPORTING_EVIDENCE`。`source_type` 取 `USER_TEXT`、`INTERNAL_PPTX`、`INTERNAL_XLSX`、`SUPPORTING_FILE`。
- **预期行为**：`UNIQUE(project_id, source_type, revision)` 保证同一类型不会有两个相同版本号。`sha256` 相同的内容重复上传不产生新行。文件本体在 R2，`r2_key` 指向它。`text_content` 只对纯文本填写。

### `demand_compilations`

- **设计理念**：每次需求编译的完整结果快照，带版本号。
- **为什么需要**：编译是模型参与的过程，同一份输入两次编译结果可能不同。没有版本就无法回答"这条需求是第几版得出的"。
- **怎么用**：`POST /api/projects/{id}/requirement-compile` 写入。`GET /api/projects/{id}/requirements` 读取最新一版。
- **预期行为**：`UNIQUE(project_id, demand_revision)` 保证一个项目的一个版本只有一行。`compilation_json` 存 `DemandIntakeResult` 信封的完整 JSON，含 `requirements`、`conflicts`、`unstructured_requirements`、`issues`。`compiler_version` 记录产出它的编译器版本。编译是模型做的，所以同一份输入两次编译可能不同；需要复现时读回具体版本。

### `history_datasets`

- **设计理念**：可选的内部历史采购数据。单独成表，明确标为模拟数据。
- **为什么需要**：历史采购里的供应商是模拟命名空间，绝不能和公开情报里的真实供应商混在一起。物理分表让这条边界无法被忽略。
- **怎么用**：`POST /api/projects/{id}/history-imports` 写入并同时把标准化 JSON 放进 R2。
- **预期行为**：`UNIQUE(project_id, content_sha256)` 让同一份文件重复导入不产生新行，也不重复抬高 `analysis_version`。`supplier_namespace` 固定为 `HISTORICAL_SUPPLIER_SIMULATED`。`is_synthetic` 记录是否模拟数据。

## 寻源情报

### `intelligence_suppliers`

- **设计理念**：公开观察到的供应商线索。记录名号和域名，不做法律主体认定。
- **为什么需要**：同名公司可能是不同主体，域名相同也不等于已核实。单独存并带 `identity_status`，让"已核实"和"未核实"在数据结构上可区分。
- **怎么用**：`POST /internal/runs/{id}/research-results` 时按 `supplier_id` 幂等 upsert。`GET /api/workspaces/default/suppliers` 读取。
- **预期行为**：`identity_status` 取 `DISCOVERED_UNVERIFIED`、`OFFICIAL_RECORD_MATCHED`、`CONFLICTING`、`UNKNOWN`。同名不同域名不自动合并。`website_domain` 只能取自引用过的网页域名。

### `intelligence_products`

- **设计理念**：公开观察到的产品线索，型号是可选字段。
- **为什么需要**：产品名和型号是两回事。系列名不是型号。分开存并允许 `model` 为空，才能表达"我们知道有这个东西，但没拿到编码"。
- **怎么用**：同 `intelligence_suppliers`，按 `product_id` 幂等 upsert。
- **预期行为**：`model` 为空表示未取得精确编码，不表示推断。`first_observed_at` 记录首次见到的时间，`last_observed_at` 记录最近见到的时间，两者都用于新鲜度判断。

### `supplier_product_offerings`

- **设计理念**：供应商和产品之间的关系，用独立表而不是字段表达。
- **为什么需要**：一家供应商供多个产品，一个产品有多个供应商，这是多对多。放在任一实体里都会丢信息。
- **怎么用**：`UNIQUE(workspace_id, supplier_id, product_id)` 保证不重复。
- **预期行为**：`relationship_status` 默认 `UNCONFIRMED`。官方目录或厂商官网证据才能把它推进到已确认状态。`evidence_ids` 至少一条，关系必须能被引用支撑。

### `research_evidence`

- **设计理念**：一次抓取的网页快照的元数据。正文在 R2，这里只存可查询的部分。
- **为什么需要**：证据是整个 M2 的地基。每条 Claim 都必须指回一条 Evidence，所以 Evidence 需要稳定 ID、可校验哈希和内容寻址的 R2 key。
- **怎么用**：`POST /internal/runs/{id}/research-results` 写入。`GET /api/evidence/{id}` 读取，同时从 R2 取出正文。
- **预期行为**：`UNIQUE(workspace_id, normalized_url, content_sha256)` 让同一页面的相同内容只存一份。`content_sha256` 必须等于 R2 正文的 SHA-256，Worker 写入前会重算并拒绝不匹配的记录。`snapshot_r2_key` 含哈希，同一 URL 的不同内容版本各存一份。`content_date_hints_json` 存网页里出现的日期文本，仅作旧资料提示。

### `intelligence_entity_evidence`

- **设计理念**：实体与证据的多对多关系，单独成表。
- **为什么需要**：同一个供应商可以由多条证据支撑，同一条证据也可以同时支撑供应商和产品。字段塞进实体表会重复。
- **怎么用**：写入研究结果时按 `(workspace_id, entity_type, entity_id, evidence_id)` upsert。
- **预期行为**：`entity_type` 取 `SUPPLIER`、`PRODUCT`、`OFFERING`。主键含证据 ID，所以同一对关系不会重复登记。

### `research_claims`

- **设计理念**：一条有来源支撑的陈述。记录主体、属性、值和状态。
- **为什么需要**：供应商和产品本身不含技术参数。把参数做成 Claim，才能让每条参数都挂一条证据。
- **怎么用**：`subject_type` 取 `SUPPLIER` 或 `PRODUCT_MODEL`。
- **预期行为**：`status` 取 `SUPPORTED_BY_SOURCE`、`CONTRADICTED_BY_SOURCE`、`UNVERIFIED`、`ASSUMED`。`evaluation_method` 默认 `EXCERPT_MATCH`，表示值必须在快照原文里逐字命中。

### `claim_evidence_links`

- **设计理念**：Claim 和证据的多对多关系，带上引用原文。
- **为什么需要**：一条 Claim 可能由多条证据支撑，引用原文必须和关系存在在一起，否则查不出"这句话是从哪抄的"。
- **怎么用**：`source_quote` 必须是快照正文里的连续子串，Worker 写入前会做归一化包含检查，不通过就整批拒绝。
- **预期行为**：主键含 `source_quote`，同一条 Claim 对同一条证据的两种引用会存成两行。证据记录是 upsert，不会被删除，所以关联行长期保留。

### `research_evidence_tasks`

- **设计理念**：证据与研究任务的关联表。
- **为什么需要**：一条 Evidence 可能被多个任务用到，也可能是上一个项目留下的。要能回答"这条证据是哪个任务在什么时候抓的"。
- **怎么用**：写入研究结果时按 `(workspace_id, run_id, task_id, evidence_id)` 插入。
- **预期行为**：只覆盖本次运行。历史运行的关联保留在旧 `run_id` 下。

## 计划、任务与动作

### `sourcing_plans`

- **设计理念**：每次运行的寻源计划，带修订号，可回溯。
- **为什么需要**：研究是分轮的。第一轮发现证据缺口后要追加问题。修订号让"这是第几版计划、为什么改的"有据可查。
- **怎么用**：`POST /internal/runs/{id}/research-results` 写入。`GET /api/projects/{id}/sourcing-plan` 读取。
- **预期行为**：`UNIQUE(workspace_id, run_id, plan_revision)` 保证一个版本一行。`plan_json` 存完整 `SourcingPlan`，含 `research_questions`、`reuse_decisions`、`budget`。每条非 `IGNORE` 的复用决策必须指向一个存在的需求，否则整份计划被拒。

### `research_tasks`

- **设计理念**：主管代理派出的每一个研究任务，及其结构化产出。
- **为什么需要**：一次运行可能有多个任务并行。任务级产出是判断"哪条结论来自哪个问题"的唯一依据。
- **怎么用**：`findings_json` 存 `ResearchFindings`，含候选主张、证据 ID、型号引用和未解决的缺口。
- **预期行为**：`status` 取 `COMPLETED` 或 `NO_STRUCTURED_FINDINGS`。`findings_json` 可为空，表示任务跑了但没交出合格结构化结果。

### `research_actions`

- **设计理念**：每一次工具调用的审计行。
- **为什么需要**：预算要能核对，失败要能定位，还要能证明"这个网址是被拒绝的，不是我漏抓的"。
- **怎么用**：`tool_name` 记 `tavily.search`、`tavily.extract`、`fetch_public_source` 等。`decision` 记 `RESULTS_FOUND`、`NO_RESULTS`、`REUSED_FETCHED_SOURCE`、`RESEARCH_INPUT_REJECTED` 和各类供应商失败码。
- **预期行为**：`query` 可为空。被拒绝的抓取只记动作不记网址，网址可能含私有值。`cost_search_calls` 和 `cost_fetch_calls` 分别是 0 或 1，供运行级预算核对。

### `research_run_costs`

- **设计理念**：一次运行的成本与结果摘要。
- **为什么需要**：模型调用次数、token、耗时、trace 都需要在运行结束后一次读出，而不是事后从日志拼。
- **怎么用**：`GET /api/runs/{id}/research` 返回的 `metrics` 来自这张表。
- **预期行为**：`status` 取 `COMPLETED`、`PARTIAL`、`FAILED`。`stop_reason_code` 记停止原因，例如 `BUDGET_EXHAUSTED`、`MODEL_TIMEOUT`、`MODEL_RATE_LIMIT`、`RESEARCH_INPUT_REJECTED`、`NO_FETCHED_EVIDENCE`。`model_call_details_json` 存每次模型调用的耗时、token 和错误类型。`trace_run_ids_json` 存 LangSmith trace ID。`token_usage_observed` 标记供应商是否真的返回了 token 数。迁移 `0006` 新增 `langsmith_tracing_enabled` 列。

## 候选

### `project_candidates`

- **设计理念**：某个项目某条需求下的一个供应商产品候选，带阶段。
- **为什么需要**：情报是工作区级的，候选是项目级的。这一层把"公开情报"翻译成"这份需求下可以考虑的供应商"，并且强制指明需求。
- **怎么用**：`GET /api/projects/{id}/candidates` 读取，可按 `run_id` 过滤。
- **预期行为**：`UNIQUE(workspace_id, project_id, requirement_id, supplier_id, COALESCE(product_id, ''))` 保证同一四元组只有一行。`requirement_id` 不可为空。`stage` 在 M2 期间只允许 `DISCOVERED_LONG_LIST`，更靠后的阶段留给 M3。`first_seen_run_id` 和 `last_seen_run_id` 记录这个候选最早和最近出现在哪次运行。

### `project_candidate_evidence`

- **设计理念**：候选与证据的多对多关系。
- **为什么需要**：一个候选可能由多条证据支撑。分开存能查"这个候选被哪几个来源支持"。
- **怎么用**：随 `project_candidates` 一起写入。
- **预期行为**：主键含 `evidence_id`，同一对关系不重复登记。候选的当前阶段由 `project_candidates.stage` 表达，关联行本身不随阶段变化删除。

## R2 对象

四个 key 前缀。

| 前缀 | 内容 |
|---|---|
| `workspaces/default/projects/{projectId}/inputs/{sourceId}/{sourceId}.{ext}` | 用户上传的原始文件 |
| `workspaces/default/projects/{projectId}/reports/{runId}/{name}` | 运行产出的报告文件 |
| `workspaces/default/projects/{projectId}/history/{datasetId}/normalized.json` | 标准化后的历史采购数据 |
| `workspaces/default/intelligence/evidence/{evidenceId}/{contentSha256}.txt` | 网页快照正文 |

- **设计理念**：证据快照的 key 里带内容哈希。同一 URL 的不同内容版本各存一份，互不覆盖。
- **预期行为**：`GET /api/evidence/{id}` 先读 D1 元数据，再从 R2 取正文，返回的正文哈希必须等于 `content_sha256`。

## 需求领域模型

定义在 `src/procurement_agent/domain/requirements.py`。

### `SourceFragment`

- **设计理念**：源文件里的一段文字或一行表格，带精确坐标。
- **为什么需要**：任何从文件里读到的内容都要能指回原位。坐标是后续引文校验的锚。
- **怎么用**：解析器产出它，编译器把它整体交给模型。
- **预期行为**：`locator` 形如 `pptx:slide=6:table=1:row=3` 或 `user_text:rev_1:line_1:span_0_20`。表格按行切分，单元格原文用 ` | ` 连接，被合并单元格留空。

### `Requirement`

- **设计理念**：一条采购行。结构化的、可比较的、不依赖历史数据的最小单位。
- **为什么需要**：整个系统的下游都以需求为主键。候选要挂需求，约束要挂需求，比价要按需求比。需求不稳定，下游全部失效。
- **怎么用**：`requirements` 数组里的每一项。`requirement_id` 是全系统的连接键。
- **预期行为**：`quantity` 和 `planned_unit_price` 是顶层字段，不重复做成技术约束。`constraints` 初始为空，由编译阶段补入。`source_refs` 指向源坐标。`parse_status` 为 `AMBIGUOUS` 时必须带 `open_questions`。

### `RequirementConstraint`

- **设计理念**：需求上的一条可执行约束，带来源。
- **为什么需要**：约束是 M3 规格门禁的输入。它必须同时说明"要什么"和"哪句话说的"，否则门禁无法解释结论。
- **怎么用**：`attribute_key` 是动态键，`value` 按 `value_type` 解读。
- **预期行为**：`importance` 取 `HARD`、`PREFERENCE`、`UNKNOWN`。`parse_status` 为 `RESOLVED` 时必须带 `source_ref` 和 `source_quote`。`value_type` 只允许 `NUMBER`、`BOOLEAN`、`STRING`、`SET`、`RANGE`。运算符只允许 `GTE`、`LTE`、`EQ`、`NE`、`IN`、`CONTAINS`、`RANGE_COVERS`。

### `PlannedAmount`

- **设计理念**：一个带口径的金额。
- **为什么需要**：单价、销量价、预算三者不能混。含税与不含税差一个数量级。
- **怎么用**：`Requirement` 上的 `planned_unit_price`、`planned_sales_unit_price`、`planned_total_budget`。
- **预期行为**：`kind` 区分用途。`tax_basis` 取 `INCLUSIVE`、`EXCLUSIVE`、`UNKNOWN`，来源没写就留 `UNKNOWN`。`source_quote` 是单元格原文。

### `RequirementCompilation`

- **设计理念**：一次编译的全部产出，含冲突和非结构化需求。
- **为什么需要**：编译可能得出互相矛盾的结果。把冲突摊在同一个结果里，读者才能看到"系统知道自己不确定"。
- **怎么用**：`DemandIntakeResult` 里内嵌它。`GET /api/projects/{id}/requirements` 返回的是外层信封。
- **预期行为**：`unstructured_requirements` 承接"工业级""口碑好"这类无法安全落成约束的话。`conflicts` 承接来源之间的矛盾，例如 Case A 的 58 万台与 63 万台。

### `ConflictValue` 与 `DataConflict`

- **设计理念**：把矛盾本身当成一条数据来存。
- **为什么需要**：矛盾是采购场景的常态。丢掉矛盾等于替用户做了决定。
- **怎么用**：`values_with_source` 每项带自己的 `source_ref` 和 `source_quote`。
- **预期行为**：`status` 为 `UNRESOLVED` 时不做任何取舍。`severity` 为 `REVIEW_SCOPE` 表示需要人来定范围。

### `UnstructuredRequirement`

- **设计理念**：一句有意义但无法安全落成 DSL 的话。
- **为什么需要**：给模型一个"我不知道"的出口。没有它，模型会被迫编造数值。
- **怎么用**：编译阶段产出，不进入可执行约束。
- **预期行为**：`parse_status` 取 `UNSUPPORTED` 或 `AMBIGUOUS`。`reason` 说明为什么无法落成。

### `HistoricalTransaction` 与 `HistoryImportResult`

- **设计理念**：一行历史采购记录和一次导入的结果摘要。
- **为什么需要**：历史数据是可选输入。它需要自己独立的表示和命名空间，不能复用公开情报的模型。
- **怎么用**：`import_historical_xlsx` 产出。
- **预期行为**：`supplier_entity_id` 一律以 `HISTORICAL_SUPPLIER_SIMULATED:` 开头。`is_synthetic` 为真。`header_row`、`row_count`、`column_count` 记录解析事实。

### `DemandIntakeResult`

- **设计理念**：M1 编译的落库信封。
- **为什么需要**：迁移 `0004` 之后，`demand_compilations.compilation_json` 存的是这个信封而不是裸的 `RequirementCompilation`。信封把 `analysis_version`、`history_availability`、`history_dataset_id` 和 `issues` 一起固化。
- **怎么用**：Container 返回它，Worker 整份存进 `compilation_json`。
- **预期行为**：M2 读需求时必须先剥掉这层信封再解析。`tests/test_m2_storage_contract.py` 有对应回归测试。

### 需求侧的 9 个枚举

`RequirementSourceType`、`InputPurpose`、`ParseStatus`、`Importance`、`ConstraintOrigin`、`ValueType`、`ConstraintOperator`、`TaxBasis`、`HistoryAvailability`。

- **设计理念**：把"可能出现的状态"列成封闭集合，代码里不允许出现集合外的值。
- **为什么需要**：这些值决定下游行为。`ParseStatus` 决定一条需求能否进入门禁，`Importance` 决定硬约束还是偏好，`TaxBasis` 决定金额怎么比。开放字符串会让这些判断退化成字符串比较。
- **怎么用**：全部是 `StrEnum`，直接以字符串落库和落 JSON。
- **预期行为**：新增取值要同时改枚举和消费它的分支。表定义里的 `CHECK` 约束是第二道防线。

## 寻源领域模型

定义在 `src/procurement_agent/domain/sourcing.py`。

### `SourcingPlan` 与 `SourcingPlanProposal`

- **设计理念**：一份带版本、可解释的研究计划。提案宽松，落库严格。
- **为什么需要**：计划要同时满足两件事。给模型留出表达空间，让它能提出研究问题。给下游留出确定性，让每个问题都挂到一条真实需求上。这两件事用同一个模型做不到，所以拆成提案和正式两个类型。
- **怎么用**：`build_sourcing_plan` 用模型产出 `SourcingPlanProposal`，再用确定性代码生成 `SourcingPlan`。
- **预期行为**：`SourcingPlan` 的 `model_config` 是 `extra="forbid"`。校验器要求每个研究问题指向一个 `prioritized_requirement_ids` 里的需求，每条非 `IGNORE` 的复用决策也指向一个存在的需求。`target_markets` 为空时 `target_markets_origin` 为 `None`。`created_at` 必须带时区。

### `ResearchQuestion` 与 `ResearchQuestionProposal`

- **设计理念**：一个研究问题的正式形式和提案形式。
- **为什么需要**：模型有时会漏写 `requirement_id`。正式形式不允许缺，提案形式允许。
- **怎么用**：漏写且项目只有一条需求时回填，记 `SINGLE_REQUIREMENT_FALLBACK`。多条需求时不猜，整条丢弃并记 `issues`。
- **预期行为**：`question_id` 是任务 ID 的唯一来源。研究代理调工具时必须逐字使用这个 ID。

### `ReuseDecisionProposal` 与 `IntelligenceReuseDecision`

- **设计理念**：模型对旧线索的判断，以及落库时的正式决定。
- **为什么需要**：提案是模型说的，落库决定是系统认定的。模型可能漏写需求 ID，也可能写了本项目不存在的 ID。落库前必须重新判定。
- **怎么用**：模型对每条旧线索给 `REUSE`、`REFRESH`、`IGNORE` 和一句理由。
- **预期行为**：`requirement_id` 为空且项目只有一条需求时回填，记 `SINGLE_REQUIREMENT_FALLBACK`。为空且有多条需求时改为 `IGNORE`，记 `UNASSOCIATED_IGNORED`。指向不存在的需求时改为 `IGNORE`。旧线索过期时 `REUSE` 会被降级成 `REFRESH`。没有模型的判断时默认 `IGNORE`，同样记 `UNASSOCIATED_IGNORED`。

### `EvidenceRecord`

- **设计理念**：一条网页快照，含哈希和内容地址。
- **为什么需要**：Evidence ID 要能由内容确定地算出来，否则两次运行会存出两条内容相同的记录，引用会指向不同副本。
- **怎么用**：抓取成功后产生。`evidence_id` 形如 `ev_` 加 24 位十六进制。
- **预期行为**：ID 由规范化 URL 和内容哈希确定性地算出。`content_sha256` 等于 R2 正文的 SHA-256。`trust_notes` 记录这条证据的局限。

### `SupplierIntelligenceRecord` 与 `ProductIntelligenceRecord`

- **设计理念**：工作区级的供应商和产品线索。
- **为什么需要**：线索要跨项目复用，复用就要求它不能带项目字段。
- **怎么用**：写入研究结果时 upsert。
- **预期行为**：`ProductIntelligenceRecord.model` 可以为空。`SupplierIntelligenceRecord.website_domain` 会做规范化校验，不是合法主机名就拒绝。

### `SupplierProductOffering`

- **设计理念**：供应商与产品的关系，附证据。
- **为什么需要**：关系本身需要证据支撑，不能只靠两张表的名字相近。
- **怎么用**：写入研究结果时 upsert。
- **预期行为**：`evidence_ids` 至少一条。`relationship_status` 默认 `UNCONFIRMED`。

### `ClaimDraft` 与 `ClaimProposal`

- **设计理念**：一条结论的正式形式和模型提案形式。
- **为什么需要**：模型提案的引文长度上限是 300 字符，落库的引文上限是 1000 字符。合并会让模型在写的时候就被正式格式卡住。
- **怎么用**：模型提 `ClaimProposal`，系统验证后落 `ClaimDraft`。
- **预期行为**：`source_quote` 必须在快照正文里逐字命中，Worker 写入前会检查。`status` 取 `SUPPORTED_BY_SOURCE`、`CONTRADICTED_BY_SOURCE`、`UNVERIFIED`、`ASSUMED`。

### `CandidateClaim`

- **设计理念**：一个供应商加一个产品的完整主张，带双份引文。
- **为什么需要**：供应商和产品通常来自不同页面。分开引文才能各自追溯。
- **怎么用**：研究代理在 `ResearchFindings.candidate_claims` 里产出。
- **预期行为**：填了 `model` 就必须填 `model_quote`，填了 `brand` 就必须填 `brand_quote`，否则校验失败。`supplier_website_domain` 只在来源就是该供应商官网时才填。

### `ResearchCandidate`

- **设计理念**：一个进入项目的候选供应商产品，带阶段。
- **为什么需要**：候选是"情报"到"这个项目的采购清单"的翻译结果。它必须带需求 ID，阶段必须能表达成熟度。
- **怎么用**：写入 `project_candidates` 表。
- **预期行为**：模型校验器禁止 `stage` 超过 `DISCOVERED_LONG_LIST`。`evidence_ids` 至少一条。`open_questions` 记录还需要核实什么。

### `ResearchFindings`

- **设计理念**：研究代理交回来的结构化结果。
- **为什么需要**：模型必须交回固定 schema，否则下游无法确定性地消费。
- **怎么用**：作为 `ToolStrategy(ResearchFindings)` 的响应格式。
- **预期行为**：`task_id` 必须逐字等于计划里的 `question_id`。`research_question` 会被归一化到计划里的原文。`candidate_claims` 最多 3 条。

### `ResearchBudget`

- **设计理念**：运行级的硬上限，所有任务共享。
- **为什么需要**：不给上限，一次异常运行就能烧掉大量搜索和模型调用。
- **怎么用**：每个任务和每个工具调用都检查同一份预算。
- **预期行为**：五个上限分别是搜索 8、抓取 8、任务 3、轮次 2、模型调用 18，实际取值取配置与硬上限的较小值。触顶时运行标记 `PARTIAL / BUDGET_EXHAUSTED`。

### `ModelCallMetric`、`ResearchAction`、`ResearchTask`、`ResearchRunBundle`

- **设计理念**：分别是单次模型调用的度量、一次工具调用的动作、一次研究任务、一次运行的全部产出。
- **为什么需要**：把这四层分开，才能分别回答"模型慢在哪"、"工具做了什么"、"哪条结论出自哪个问题"、"这次运行整体怎么样"。
- **怎么用**：`ModelCallMetric` 进 `research_run_costs.model_call_details_json`。`ResearchAction` 进 `research_actions`。`ResearchTask` 进 `research_tasks`。`ResearchRunBundle` 是 Container 交给 Worker 的完整载荷。
- **预期行为**：`ModelCallMetric` 记 `duration_ms`、token 数和 `error_type`。`ResearchAction.decision` 记动作结果分类。`ResearchTask.status` 取 `COMPLETED` 或 `NO_STRUCTURED_FINDINGS`。`ResearchRunBundle` 的 `plan`、`plan_history`、`tasks`、`evidence`、`candidates`、`metrics` 一起返回。

### 寻源侧的 10 个枚举

`SourcingGoal`、`ProvenanceType`、`ChannelHint`、`RequirementAssociationOrigin`、`CandidateStage`、`ResearchRunStatus`、`IdentityStatus`、`ReuseDecision`、`ClaimStatus`、`SubjectType`。

- **设计理念**：把研究流程里所有需要分支判断的状态收敛成封闭集合。
- **为什么需要**：`ChannelHint` 决定研究走哪条渠道，`CandidateStage` 决定候选成熟度，`ProvenanceType` 决定一个结论是用户明说的还是模型猜的。这些判断一旦走字符串比较，边界就会松动。
- **怎么用**：`StrEnum`，以字符串落库。
- **预期行为**：`ProvenanceType` 的 `INFERRED_FOR_REVIEW` 表示待人工确认。`RequirementAssociationOrigin` 的四个值分别对应"计划明写"、"单需求回填"、"主管追问"、"无关联被忽略"。

## 规格对齐领域模型

M3-A 把需求侧和产品侧接到同一套值类型上，中间只隔一层对齐。

### `ProductAttributeClaim`

- **设计理念**：一个具体产品型号的、带类型的、带来源的属性陈述。
- **为什么需要**：M2 的 `ClaimDraft` 只有自由文本的 `attribute` 和 `value`，没法直接比较。类型化之后，需求侧和产品侧用同一套 `value_type`、同一套单位和同一套算子，比较才成立。
- **怎么用**：`claim_id` + `product_candidate_id` + `product_model_ref` 定位到型号；`attribute_key` 与 `attribute_definition` 说明量的是什么；`value`/`unit` 是值；`evidence_ids` + `source_quote` 是出处；`claim_status` 说明来源是支持、否证、还是未核实。
- **预期行为**：`claim_status` 为 `SUPPORTED_BY_SOURCE` 时必须带至少一个证据 ID。`attribute_key` 必须是小写无空格标识符。`extraction_status` 不是 `RESOLVED` 时不参与自动比较。

### `SemanticAlignment`

- **设计理念**：一条需求约束和一条产品声明「量的是不是同一个东西」的判定。
- **为什么需要**：`额定输出功率` 和 `最大输入功率` 名字相近，含义不同。没有这一层，比较器会把 8 kW 的最大输入功率当成满足 7.5 kW 额定输出功率。
- **怎么用**：`constraint_id` 与 `claim_ids` 指向两侧；`status` 是 `ALIGNED` / `NOT_ALIGNED` / `AMBIGUOUS` / `CONFLICTING`；`method` 说明判定来源；`dimension` 记录测量对象；`unit_conversion` 记录换算依据。
- **预期行为**：`ALIGNED` 必须列出参与比较的声明。`NOT_ALIGNED` 与 `AMBIGUOUS` 一律判 UNKNOWN，不能降级成 PASS。

### `ConstraintCheck`

- **设计理念**：一条约束对一个型号的判定结果和过程。
- **为什么需要**：结论必须可复算。「为什么是 FAIL」要能一眼看出比较了什么。
- **怎么用**：`status` 是 `PASS`/`FAIL`/`UNKNOWN`；`reason_code` 说明原因；`operation` 是比较过程；`normalized_actual`/`normalized_required`/`unit` 是归一化后的值；`evidence_ids` 与 `source_refs` 指回来源。
- **预期行为**：只有 `VERIFIED_COMPARISON` 能给 PASS 或 FAIL。其余原因码一律是 UNKNOWN，并写明缺什么。

### `SpecAssessment`

- **设计理念**：一条需求对一个型号的完整评价。
- **为什么需要**：M3 的技术门禁以「需求 × 型号」为最小单位，不是以供应商为单位。同一家的两个型号要分开评价。
- **怎么用**：`checks` 是逐条结果；`hard_spec_overall` 是硬约束汇总；`overall_reason_codes` 说明汇总的理由；`calculator_version` 记录用了哪版计算器。
- **预期行为**：汇总规则是「有一条可靠的 HARD FAIL 就是 FAIL；全部 HARD PASS 才是 PASS；没有 HARD 约束或还有未决需求时是 UNKNOWN」。`PREFERENCE` 不参与汇总。`evaluated_at` 必须带时区。

### `spec_assessments` 表

- **设计理念**：一条需求对一个型号的技术核验结果，连同它的计算过程和引用的证据。
- **为什么需要**：结论要能被复核，也要在需求修订后仍然留着旧版本。
- **怎么用**：唯一键是「项目 + 需求 + 候选 + 需求修订号」。同一修订号重算覆盖旧行；需求修订后新增行，旧行不动。
- **预期行为**：`hard_spec_overall` 只允许 `PASS`/`FAIL`/`UNKNOWN`。`assessment_json` 里是逐条判定、计算过程和原因码。`evidence_ids_json` 是这次判定引用过的证据。

## 决策领域模型

M3-C 把「模型建议」和「闸门判定」分开。

### `DecisionProposal`

- **设计理念**：Supervisor 对一个候选的建议。
- **为什么需要**：建议和结论必须分开存，否则一个被拒的建议和被采纳的建议看起来一样。
- **怎么用**：`recommendation` 是 `SHORTLIST`/`INVESTIGATE`/`EXCLUDE`；`technical_verdict` 是 `VERIFIED_PASS`/`VERIFIED_FAIL`/`UNVERIFIED`；`evidence_ids`、`claimed_lowest_observation_id`、`claimed_saving` 是可以被核对的引用。
- **预期行为**：未知字段被忽略，不让一个多余的键毁掉整批回答。

### `SourcingDecision`

- **设计理念**：闸门放行之后才能写下的决策。
- **为什么需要**：每个决策都要能回答「凭什么」。
- **怎么用**：`accepted` 说明有没有被放行；`violations` 列出被拒的原因；`technical_verdict` 与 `hard_spec_overall` 一起说明技术结论的来源。
- **预期行为**：被放行的决策没有 violation，被拒的决策至少有一个 violation。时间戳必须带时区。

### `GateViolation`

- **设计理念**：一条具体的违规。
- **为什么需要**：「被拒了」不够，必须说清是被哪一条规则拦下的。
- **怎么用**：`code` 是机器可读的枚举，`subject` 指到具体的候选，`message` 是一句人话。
- **预期行为**：覆盖硬约束 FAIL 进短名单、未知被写成已核实、虚构证据 ID、虚构节支、无评估可判、无缺口却进短名单、结论与计算不符这几类。

## 价格领域模型

M3-B 把「一个价格数字」和「两个价格能不能比」拆开。

### `PriceObservation`

- **设计理念**：一个价格数字，连同比价所需的口径。
- **为什么需要**：同一个数字可能是预算、历史成交价、网页挂牌价或正式报价。只给数字不给口径，比价就是胡说。
- **怎么用**：`price_basis` 说明它是哪一类；`currency`、`unit`、`tax_basis` 说明它的尺度；`requirement_id`、`sku`、`product_equivalence_key` 说明它对应什么。
- **预期行为**：`value` 必须是十进制字符串。`is_synthetic_supplier` 标记这一行是否来自模拟历史。

### `PriceComparison` 与 `PriceFinding`

- **设计理念**：比价的结果，和「这个需求的价格分析」。
- **为什么需要**：不可比时必须说清差在哪，并且不给最低价、不给节支率。
- **怎么用**：`PriceComparison` 是两个价格的比较；`PriceFinding` 是一条需求的价格结论，含最低价、节支、被排除的观察值和理由。
- **预期行为**：只有 `VERIFIED` 级的比较才会给出差额和百分比。`PriceFinding` 的 `lowest_value` 只在价格同口径时出现，`saving` 只在最低价和预算可比时出现。

### `PriceStatistics` 与 `HistoryAnalysis`

- **设计理念**：历史价分布，和一个需求的历史上下文。
- **为什么需要**：买家要知道「以前买过多少、什么价」，但没有历史时也要能继续。
- **怎么用**：`PriceStatistics` 是同一口径下的分布（最小、最大、中位、均值、四分位、采购量）；`HistoryAnalysis` 是这一条需求的历史。
- **预期行为**：没有历史时 `available` 为 False。模拟供应商单独列出，永不并入公网企业。

### `judgment_cache` 与 `judgment_cache_conflicts`

- **设计理念**：把语义判定存下来，同一份内容只判一次。
- **为什么需要**：语义判断在这个端点上不确定，同一份数据跑两次会给出不同答案。
- **怎么用**：`input_digest` 是内容的哈希（声明 + 证据哈希 + 规则版本；约束 + 已类型化声明 + 规则版本；对齐 + 已类型化声明 + 计算器版本 + 聚合规则版本）。`payload_json` 是结果。`versions_json`、`model_config_json`、`evidence_hashes_json`、`source_run_id` 让每条判定可追溯。
- **预期行为**：同一 digest **第一个写入的答案生效**（`ON CONFLICT DO NOTHING`），并发不会互相覆盖。同一 digest 出现**不同答案**时写进 `judgment_cache_conflicts`，不覆盖、不隐藏。判定版本在 `spec_assessments.judgment_version`，同内容重跑保持版本，显式复核产生新版本并保留旧判断与复核原因。

### 单位换算表

- **设计理念**：一份白名单，决定哪些单位能换算到同一刻度。
- **为什么需要**：150 μm 和 0.2 mm 能比，32 GB 和 32 GiB 不能比，5 MP 和 5 px 能比。单位规则写死在代码里，不靠模型判断。
- **怎么用**：`domain/units.py` 的 `unit_spec` 查一个单位的维度和换算系数；`convert_between` 做换算；`units_compatible` 判断两侧是否同刻度。
- **预期行为**：十进制存储字节和二进制存储字节是两个维度，不互相换算。帧率和频率是两个维度。一边有单位一边没有单位，不判可比。两个相同的未知单位仍可比，同一个刻度会抵消。

## 模型参与哪一步

这是整个系统最容易误解的地方，所以单列一节。

| 阶段 | 模型做 | 确定性代码做 |
|---|---|---|
| 需求抽取 | 读完整份文档，产出采购行、技术约束、冲突、非结构化需求 | 按行切分原文、归一化 JSON 形状、合并多个工具调用、编号 |
| 寻源计划 | 提研究问题、给旧线索判断 | 校验问题挂到哪条需求，判定复用关联，限定预算 |
| 主管调度 | 派任务、决定是否追问 | 工具边界校验、预算扣减、任务路由 |
| 研究代理 | 提候选主张和引文 | 校验引文在快照里，校验型号有型号引文 |
| 落库 | 不参与 | 重算快照哈希，校验引文，校验范围 |

需求抽取这一层不引用固定表头词表，也不复核模型读到的数字。原文全文进模型，模型给出它的理解。代价是需求条数、数量和金额都不再由代码保证，这些结论的出处是模型。

编译阶段读回模型返回的每一个工具调用。长文档下模型会一行需求一次调用，只读第一次会丢掉其余行。模型有时把整个编译包在一个字段里当作 JSON 字符串，或把金额写成 JSON 字符串，这两种形状都会被读回。

需求编译在 Workflow 中执行，不在 Worker 请求里执行。模型读完一整份文档需要几分钟，Worker 请求撑不住这么久。客户端发起编译后轮询结果。

M2 的证据层仍然是确定性的。网页快照的哈希、引文是否在快照里、型号是否配有型号引文，都由代码判定。

研究层的工具失败不中断整轮研究。越界抓取、预算用尽、页面读不出来，都作为可执行指令回到研究器手里。研究器答成散文而不是结构化工具调用时，系统会带着已抓到的来源再问一次，这次强制要求工具调用。

## 中间结果在哪里

模型的每一步中间结果分三处。

**D1 里存校验之后的结果。**

| 内容 | 位置 |
|---|---|
| 编译后的需求、冲突、issues | `demand_compilations.compilation_json` |
| 寻源计划含复用决策 | `sourcing_plans.plan_json` |
| 研究任务的结构化产出 | `research_tasks.findings_json` |
| 每一次工具调用 | `research_actions` |
| 模型调用耗时、token、trace | `research_run_costs` |
| 候选与证据 | `project_candidates`、`project_candidate_evidence` |
| 技术核验结果 | `spec_assessments`（带判定版本） |
| 缓存的语义判定 | `judgment_cache`、`judgment_cache_conflicts` |
| 采购决策与闸门结果 | `sourcing_decisions` |

**R2 里存原文。** 上传的文件、网页快照正文、标准化历史数据。

**LangSmith 里存模型和工具的原始轨迹。** 每次模型调用、每次工具调用、每次子代理任务都是一条 run，带这些 metadata：

| metadata | 含义 |
|---|---|
| `sourcing_run_id` | D1 里的 run ID |
| `sourcing_project_id` | D1 里的 project ID |
| `sourcing_plan_id` | 本次运行的计划 ID |
| `research_phase` | `PLAN` 或 `SUPERVISOR` |
| `lc_agent_name` | `sourcing_supervisor` 或 `supplier_researcher` |

在 LangSmith 的 `procurement-sourcing-m2` 项目里按 `sourcing_run_id` 过滤，就能取到某一次运行的全部轨迹。

**只在 LangSmith 里有的东西。** 模型的原始输出原文。校验器丢弃的字段、被拒绝的抓取网址、以及不落库的中间推理，都只在这里能看见。

**刻意不存的东西。** 被拒绝的抓取网址不落库，`research_actions` 里只留一条 `RESEARCH_INPUT_REJECTED` 动作。搜索结果摘要不落库，也不进证据。`search_public_web` 返回的摘要只作为发现线索使用。
