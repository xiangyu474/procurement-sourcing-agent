# M4 后端契约答复与对齐

回应 `docs/m4/backend_contract_requests.md`（基线 `f0fa49b`）。本文记录接口及待办；历史回执不代表当前生产认证已就绪。B2 的新 Pipeline 使用冻结快照，旧报告不能据此追认版本绑定；多次历史运行切换尚未完成真实浏览器验收。
前端可以**直接在本文件下方「对齐回执」一节回复**，后端会按回执改，不另开文档。

- 后端仓库：`procurement_sourcing_agent`（本仓库）
- 后端最新提交：见 `git log -1`
- 网关：`https://procurement-sourcing-gateway.xiangyu474.workers.dev`
- 容器实例配置：见 `wrangler.jsonc` 的 `CONTAINER_INSTANCE_NAME`；实际部署版本须另行核验。

---

## 0. 三个必须先说清楚的业务语义（前端展示直接依赖）

### 0.1 `accepted` 不是「合格」，`recommendation` 才是建议

`sourcing_decisions.accepted` 的含义是：**该条决策通过了程序化闸门（Verification Gate）并被留档**。
它**不代表技术合格**，也不代表进入 RFQ 短名单。前端必须这样读：

| 想知道 | 用哪个字段 |
| --- | --- |
| 这条决策是否成立（没被闸门拦下） | `accepted` |
| 技术核对结论 | `hard_spec_overall`（`PASS` / `FAIL` / `UNKNOWN`）+ `technical_verdict` |
| 是否建议询价 | `recommendation == "SHORTLIST"` **且** `technical_verdict == "VERIFIED_PASS"` |
| 是否待补证 | `recommendation == "INVESTIGATE"` |
| 是否排除 | `recommendation == "EXCLUDE"` |

**`UNKNOWN` 不应显示为建议询价**：一次 43 条决策审计中，22 条为 `SHORTLIST/VERIFIED_PASS`、21 条为 `INVESTIGATE/UNVERIFIED`。这是决策建议而非实际阶段；当时 43 条候选的实际 `stage` 均为 `DISCOVERED_LONG_LIST`。

### 0.2 候选的 `stage` 现在会随决策推进

M2 只会产出 `DISCOVERED_LONG_LIST`。M3-C 的决策被接受后，候选的阶段会推进：

| 决策 | 新的 stage |
| --- | --- |
| `SHORTLIST` + `VERIFIED_PASS` | `RFQ_SHORTLIST` |
| `INVESTIGATE` | `NEEDS_VERIFICATION` |
| `EXCLUDE` | `EXCLUDED` |

上述描述适用于旧的独立决策接口；**B2 Pipeline 不修改项目候选阶段**，`/analysis` 中候选 `stage` 是冻结的 M2 发现阶段。Pipeline 决策是询价建议，不代表已实际进入 RFQ；只允许对通过闸门且技术通过的 `SHORTLIST` 显示「建议询价」，不要把建议冒充执行状态。

### 0.3 价格的历史口径：`history_scope`

M3-B 修了一个会误导买家的 bug：官方历史文件里是 **14 个不同品项**，价格跨度 **15.6x–16.3x**（最低 77 是「云台探头」，最高 1255 是「4G 80W太阳能版」）。
现在历史统计**按品项/等价关系限定**：

| `history_scope` | 含义 | 能不能用于比价/排名/节支 |
| --- | --- | --- |
| `ITEM` | 本品项（或已确认等价关系）的历史行 | 可以 |
| `TABLE_OVERVIEW` | 导入目录的整体视图 | **不可以**（只作概览展示） |
| `NONE` | 没有导入历史 | — |

前端展示历史价格时，请把 `history_scope` 一起展示；`TABLE_OVERVIEW` 时不要出现「历史价」「节支」字样。

---

## 1. 已存在、可直接调用的接口

| 方法 | 路径 | 响应要点 | 前端用途 | 备注 |
| --- | --- | --- | --- | --- |
| GET | `/api/health` | `{status, service}` | 存活探测 | 无需鉴权 |
| POST | `/api/projects` | 201 `{project_id, source_id, analysis_version}` | 建项目 | `analysis_version=0` 表示还没有文字需求 |
| GET | `/api/projects/{id}` | 项目字段 + `sources[]` | 打开项目 | `sources` 不含正文，见 §3 |
| POST | `/api/projects/{id}/requirement-text` | 201 `{project_id, source_id, revision}` | 新文字修订 | 空文本 422；>10 万字 413 |
| POST | `/api/projects/{id}/upload-sessions` | 201 `{source_id, purpose, revision, r2_key, sha256}` | 上传 PPTX / 历史 XLSX | `REQUIREMENT` 只收 `.pptx`，`HISTORY` 只收 `.xlsx` |
| POST | `/api/projects/{id}/requirement-compile` | 202 `{project_id, status:"QUEUED", compile_id, analysis_version}` | 发起整理 | **本次新增 `compile_id` 可查**，见 §3.1 |
| GET | `/api/projects/{id}/requirements` | `{analysis_version, compilation}` | 读整理结果 | 尚未写入时 404 `not_compiled`；整理失败时 `compilation` 只有 `issues`、没有 `requirements`（**这是现状契约**） |
| POST | `/api/projects/{id}/history-imports` | 导入摘要 | 导入历史 | 重复内容返回已有数据集且 `duplicate_import: true` |
| GET | `/api/projects/{id}/sourcing-plan` | `{plan}` | 看寻源计划 | 无计划 404 |
| GET | `/api/projects/{id}/candidates` | `{candidates[]}` | **Longlist / 型号 / 证据** | 支持 `stage`、`run_id` 过滤；候选含供应商、型号、`stage`、证据摘要 |
| POST | `/api/projects/{id}/spec-assessments` | 202 `{project_id, status:"QUEUED", assessment_id, demand_revision}` | 发起技术核对 | **本次新增 `assessment_id` 可查**，见 §3.2 |
| GET | `/api/projects/{id}/spec-assessments` | `{project_id, assessments[]}` | **M3 技术判定** | `hard_spec_overall` 三值；每条带 `checks[]`、`evidence_ids`、`input_digest`、`judgment_version` |
| POST | `/api/projects/{id}/decisions` | 202 `{project_id, status:"QUEUED", decision_id}` | 发起决策 | 无技术核对时 409 `no_spec_assessment` |
| GET | `/api/projects/{id}/decisions` | `{project_id, decisions[]}` | **M3 决策结果** | 字段语义见 §0.1 |
| POST | `/api/projects/{id}/runs` | 202 `{run_id, status:"QUEUED", mode, research_budget}` | 发起寻源 | 幂等键重复时返回 `reused: true` |
| GET | `/api/runs/{id}` | `{id, project_id, status, current_stage, artifact_key, last_error, created_at, updated_at}` | 运行状态 | `status`：`QUEUED/RUNNING/COMPLETED/PARTIAL/FAILED` |
| GET | `/api/runs/{id}/events` | `{events[]}` | 过程记录 | `detail` 含内部角色名，前端不要原样展示 |
| GET | `/api/runs/{id}/research` | `{run, plan, tasks, actions, metrics}` | 研究详情 | `metrics` 含 token 与搜索次数，前端不要展示 |
| GET | `/api/projects/{id}/price-context` | `{project_id, price_contexts[]}` | **F2 价格与口径** | 每个价格都带 `history_scope`；见 §0.3 与 §2.3 |
| GET | `/api/evidence/{id}` | `{evidence}`（含快照正文） | 证据详情 | 快照缺失 404 |
| GET | `/api/workspaces/default/suppliers` | `{suppliers}` | 供应商情报 | 工作区情报，不是本项目结论 |
| GET | `/api/workspaces/default/suppliers/{id}` | `{supplier, products, evidence}` | 供应商详情 | 同上 |

**M0 的 `GET /api/runs/{id}/report/download` 只对 SPIKE 草稿有效，不要当正式采购报告用**（正式报告见 §2）。

---

## 2. 本次新增：正式 DOCX 报告（P0-C）

正式报告**不是** M0 的部署验证草稿。它由容器里的报告生成器从数据库读数生成，走独立 Workflow，落私有 R2。

### 2.1 接口

```http
POST /api/projects/{project_id}/reports
{ "run_id": "uuid" }          // 必须提供有冻结快照的运行；也可改为 pipeline_id，二选一
```

```json
{ "report_id": "uuid", "run_id": "uuid", "status": "QUEUED", "workflow_id": "cf_..." }
```

```http
GET /api/projects/{project_id}/reports/{report_id}
```

```json
{
  "report_id": "uuid",
  "run_id": "uuid",
  "status": "COMPLETED",
  "decision_version": "<64位冻结决策快照 SHA-256>",
  "byte_size": 41233,
  "sha256": "…",
  "error": null,
  "download_path": "/api/projects/{project_id}/reports/{report_id}/download",
  "created_at": "…",
  "updated_at": "…"
}
```

`status`：`QUEUED` / `RUNNING` / `COMPLETED` / `FAILED`。下载：`GET <download_path>` 返回 DOCX 字节
（`application/vnd.openxmlformats-officedocument.wordprocessingml.document`）。

另有 `GET /api/projects/{project_id}/reports` 返回该项目的报告列表（按 `created_at` 倒序）。

### 2.2 报告内容（前端如需展示摘要可对齐这些章节）

1. 报告标识：项目、Run、**决策版本**、需求修订、生成时间、DSL/计算器版本
2. 阅读须知：UNKNOWN ≠ 合格；长名单 ≠ 合格名单；价格按口径；历史价按品项
3. 一、需求摘要（每条需求、硬约束、原文引用）
4. 二、候选与型号（供应商、型号、阶段、技术结论、建议、证据数）
5. 三、关键技术判定（逐约束：计算式、结果、原因码、说明、证据 ID）
6. 四、价格与口径（历史口径范围与统计；各口径的最低价、节支、可比性、说明）
7. 五、询价建议（建议询价 / 待补充证据 / 建议排除 三档，含理由与缺口）
8. 六、未解决问题与下一步
9. 七、证据引用（证据 ID、来源、地址、摘录、内容哈希）

**报告与运行的绑定**：B2 的新报告只读取 Pipeline 冻结快照，使用该快照的完整 SHA-256 作为 `decision_version`，详见 §5.4。历史旧报告可能使用部分字段摘要并读取当时项目数据；不能仅凭旧报告的 `run_id`、摘要或时间推断完整绑定。

---

## 2.3 价格与口径（F2 用）

```http
GET /api/projects/{id}/price-context
```

```json
{
  "project_id": "uuid",
  "price_contexts": [
    {
      "requirement_id": "r1",
      "product_name": "5MP 工业网络摄像机",
      "budget": "500",
      "budget_currency": "CNY",
      "budget_unit": "元/套",
      "history_scope": "TABLE_OVERVIEW",
      "history_scope_note": "The imported history holds 14 other items and no row of them is confirmed to be this requirement's item. …",
      "history_available": false,
      "history_rows": 0,
      "statistics": null,
      "overview_statistics": { "count": 1000, "minimum": "77", "median": "113", "mean": "171.51", "maximum": "1255", "currency": "CNY", "unit": "元/台" },
      "overview_is_not_a_baseline": true,
      "findings": [],
      "notes": ["…"]
    }
  ]
}
```

字段含义（**前端必须按这个渲染**）：

| 字段 | 含义 |
| --- | --- |
| `history_scope` | `ITEM`（本品项，可比价）/ `TABLE_OVERVIEW`（全表概览，**不可**用于比价、排名、节支）/ `NONE`（没有历史） |
| `history_available` | 本需求是否有**可用的品项级**历史基准 |
| `statistics` | 品项级统计（`history_scope=ITEM` 时才有值） |
| `overview_statistics` | 全表概览统计（仅供参考） |
| `overview_is_not_a_baseline` | 布尔值；为 `true` 时界面**不要出现**「历史价」「节支」字样 |
| `findings[]` | 每种口径一条：`{basis, lowest_value, saving, saving_percent, comparability, explanation, lowest_observation_id}`；`basis` 取 `PLANNED_BUDGET/HISTORICAL_TRANSACTION/PUBLIC_REFERENCE/FORMAL_QUOTATION` |
| `notes[]` | 口径说明（英文原文，可直接展示） |

**同一份价格口径只有一个来源**：该接口与正式 DOCX 报告里的「四、价格与口径」章节由**同一段代码**产出（容器内的 `build_price_context`），不会出现两套数字。前端**不要**自己算历史价或节支。

## 3. 还需要补的接口（前端提出的缺口）

### 3.1 需求整理状态 —— **已实现**，前端直接用

```http
GET /api/projects/{project_id}/requirement-compile/{compile_id}
```

```json
{
  "compile_id": "uuid",
  "project_id": "uuid",
  "status": "QUEUED",
  "analysis_version": 2,
  "demand_revision": 2,
  "error": null
}
```

`status`：`QUEUED` / `RUNNING` / `COMPLETED` / `FAILED`；`FAILED` 的 `error` 是可展示短句，不含密钥。
`compile_id` 就是 `POST .../requirement-compile` 返回的 `compile_id`（一个 `project_jobs` 行的 id）。

> 注意：后端的 `project_jobs` 表有 `job_type`（`COMPILE` / `SPEC_ASSESSMENT` / `DECISION` / `REPORT`），
> 前端**不需要**直接查表，只用下面列出的 HTTP 接口。

### 3.2 技术核对 / 决策的任务状态 —— **已实现**，前端直接用

```http
GET /api/projects/{project_id}/spec-assessments/status
GET /api/projects/{project_id}/decisions/status
```

```json
{
  "status": "COMPLETED",
  "job_id": "uuid",
  "demand_revision": 2,
  "error": null,
  "detail": { "assessments": 43, "by_overall": { "PASS": 22, "UNKNOWN": 21 } },
  "created_at": "…",
  "updated_at": "…"
}
```

`status`：`IDLE`（还没有发起过）/ `QUEUED` / `RUNNING` / `COMPLETED` / `FAILED`。
`detail` 的内容随任务类型不同（技术核对是 `assessments` 与 `by_overall`，决策是 `decisions` / `accepted` / `rejected`）。
**结果行本身不变**：仍由现有 GET 返回，字段不改（前端 F2 的解析不用动）。

### 3.3 项目列表 —— **已实现**，前端直接用

```http
GET /api/projects?limit=50
```

```json
{ "projects": [ { "id": "uuid", "title": "项目名称", "history_availability": "NOT_PROVIDED",
  "demand_revision": 1, "analysis_version": 2, "created_at": "…",
  "latest_run": { "id": "uuid", "status": "PARTIAL", "current_stage": "PARTIAL", "updated_at": "…" } } ] }
```

`latest_run` 没有时为 `null`；`status` 只用现有枚举。

### 3.4 项目下的运行列表 —— **已实现**，前端直接用

```http
GET /api/projects/{project_id}/runs
```

```json
{ "runs": [ { "id": "uuid", "status": "PARTIAL", "current_stage": "PARTIAL", "last_error": null,
  "stop_reason_code": "BUDGET_EXHAUSTED", "artifact_key_present": false,
  "created_at": "…", "updated_at": "…" } ] }
```

按 `created_at` 倒序。`stop_reason_code` 来自 `research_run_costs.stop_reason_code`
（今天的 `PARTIAL` 原因只藏在 `GET /api/runs/{id}/research` 的 `metrics` 里，而那个对象带 token，前端不应展示）。

### 3.5 文字需求正文回读 —— **已实现**，前端直接用

```http
GET /api/projects/{project_id}/requirement-text
```

```json
{ "source_id": "uuid", "revision": 2, "text": "原文" }
```

只返回最新一条 `USER_TEXT`；没有则 404 `not_found`。

### 3.5.1 前端的问题：到底用 `assessment_id`/`decision_id` 还是 `job_id`？

**答案：两个都是真的，但它们是两种不同的东西，各有各的用途。**

| 接口 | 返回的字段 | 它是什么 | 前端怎么用 |
| --- | --- | --- | --- |
| `POST .../requirement-compile` | `compile_id` | **作业 id**（`project_jobs` 表的一行） | **用这个**去查 `GET .../requirement-compile/{compile_id}` |
| 同上 | `workflow_id` | Cloudflare Workflow 实例 id | 只用于日志排查，前端不用显示 |
| `POST .../spec-assessments` | `assessment_id` | Workflow 实例 id（**旧字段，保留兼容**） | 不用管它 |
| 同上 | `job_id` | 作业 id | 想关联作业时用它 |
| `POST .../decisions` | `decision_id` | Workflow 实例 id（**旧字段，保留兼容**） | 不用管它 |
| 同上 | `job_id` | 作业 id | 想关联作业时用它 |

**结论**：
- **查询任务状态一律用状态接口**：`GET .../requirement-compile/{compile_id}`、`GET .../spec-assessments/status`、`GET .../decisions/status`。
  状态接口自己返回 `job_id`、`status`、`error`，**前端不需要用 POST 返回的任何 id 去拼状态请求**（除了整理状态必须带 `compile_id`，因为它要指明是哪一次整理）。
- `assessment_id` / `decision_id` 是历史字段，**语义保持不变**（它们是 workflow 实例 id），后端不会改它们，前端现有代码不必改。

文档里表格写的是 `assessment_id`/`decision_id`、回执里写的是 `job_id`，两处描述的是不同字段，不是同一字段的两个名字；这里写清楚以免误解。

### 3.6 项目级修订（`POST /api/projects/{project_id}/actions`）—— **后端，本轮未做**

- 前端要求一个原子接口：`{text, base_demand_revision, base_run_id}` → 新修订 + 重新整理 + 重跑受影响候选，`base_demand_revision` 不一致返回 409。
- **现状**：后端已有「提交新文字修订 → 重新整理 → 新建寻源运行」三步，但**三步彼此独立**，中间会留下半成品。
- 本轮不做的理由：它需要新的编排（一个跨需求修订、工作流、决策的编排器），与「正式 DOCX + 状态接口」相比不是交付瓶颈；**前端不要用三次调用包装成「已经完成重评」**，F4 的操作区先按「分步引导」呈现。
- 负责人：**后端**，排在 M4 中段。

### 3.7 鉴权方案 —— 已决策，生产尚未就绪

生产采用同源 Worker Guest Session，不要求评委登录 Cloudflare Access。会话、归属鉴权、CSRF 和严格成本限额由后端负责；内部凭证不进入浏览器。开发环境可使用受限的服务端代理，但不能将共享 Bearer 视为访客身份隔离。当前已部署的旧接口仍使用共享 Bearer，**不能认为具备访客隔离，也不能作为公开生产演示**。会话实现的本地状态见 §5；正式可联调时另行通知。

---

## 4. 不做与不承诺的（避免前端误用）

- 不新增第二套 DTO：所有结构化结果都来自上表的既有字段；前端不要在前端重算技术判定、价格口径或推荐档位。
- 不把「候选被发现」等同于「建议询价」。
- 不把 `UNKNOWN` 显示成通过或失败，用原文 `UNKNOWN`（前端可显示「未知（证据不足）」）。
- 不展示 `metrics` 里的 token/搜索次数。
- 不承诺跨浏览器自动发现历史项目，直到 §3.3/§3.4 上线。

---

## 5. M4 新接口：实现状态与联调草案

**受保护的 Pipeline、Analysis 和自动报告已通过一次云端验收，但不是公开生产验收；不要打开生产 Session 开关。** 前端尚未完成真实联调，五项联合集成检查仍保持未勾选。代码映射和阻塞项见 `docs/m4/backend_delivery_status.md`。

### 5.1 Session：本地实现，未发布

- `POST /api/session`：同源 Origin 必填；创建返回 201 `{ "expires_at": "ISO-8601" }`，设置 `__Host-ps_session`；有效会话重复请求返回 200、同一过期时间；其他 API 不自动创建。前端现有 `openSession()` 仅要求 2xx，与本地形状兼容，尚未真实联调。
- `GET /api/session`：200 `{ "expires_at": "ISO-8601" }`；无会话 401 `{ "error": "session_required" }`；无效或过期 Cookie 401 `{ "error": "session_expired" }`。过期后 POST 创建新身份，不能恢复旧项目。
- Cookie 为 `HttpOnly; Secure; SameSite=Lax; Path=/`，固定 24 小时；签名密钥只存在服务端。修改请求缺失或不匹配 Origin 返回 403 `{ "error": "origin_mismatch" }`。
- 本地启用模式按归属保护项目、运行、证据及报告，跨访客或无归属资源返回 404 `{ "error": "not_found" }`；共享 Bearer 不代替访客 Cookie。缺少会话密钥返回 503 `{ "error": "session_not_configured" }`。
- 全局预算、并发、会话创建限流和真实 Worker/浏览器验收未完成；因此功能开关默认关闭，本地访客模式的昂贵写请求返回 503 `operation_unavailable`。限流和额度耗尽的最终错误码待实现，不是现有行为。远端 migration 0012 是否应用尚未确认。

### 5.2 Pipeline：受保护路径已部署，单次云端验收通过

**CLOUD_VERIFIED（B1/B2 单次，非 PUBLIC_READY）**：B1 为 Git `41a29c7` / `sourcing-v15`；B2 为 Git `d021de4` / `sourcing-v17`，验收 `cf_c4397689d684785ec4d5d80b245906b3af996cc05452507410354c34244caafc`。只有受保护的服务端 Bearer 路径可用；Guest Session 仍未启用。前端不要把该凭证放到浏览器，生产接入仍需 B3。Pipeline `COMPLETED` 表示分析完成，报告状态独立。

```http
POST /api/projects/{project_id}/pipeline
Idempotency-Key: <客户端每次新任务生成的键>
Content-Type: application/json

{"demand_revision": 1}
```

返回 202，字段为 `pipeline_id`、`run_id`、`demand_revision`、`status`、`reused`。同一项目与同一键重试复用任务；同键不同修订返回 409 `idempotency_conflict`，发起新调查使用新键。项目当前需求与所请求修订不同返回 409 `demand_revision_changed`；空需求 422 `no_recognizable_demand`；没有启用返回 503 `operation_unavailable`。当 Workflow 创建结果不可确认返回 503 `workflow_start_failed`，可用**原幂等键**重试。

```http
GET /api/projects/{project_id}/pipeline/{pipeline_id}
```

返回 `pipeline_id`、`project_id`、`run_id`、`demand_revision`、`status`、`stage`、`error`、`stages[]`、`created_at`、`updated_at`；阶段项含 `stage/status/started_at/finished_at/error_code`。本次云端验收真实观测：

```json
{
  "project_id": "3ef68fec-d705-4b0d-b3aa-c91ee77ed1dd",
  "pipeline_id": "76e6b5d0-f854-4b85-9b2f-62b0e8e593da",
  "run_id": "943f57dd-a85f-46ef-8523-432d3dcc7b71",
  "demand_revision": 1,
  "pipeline_status": "COMPLETED",
  "stage": "COMPLETED",
  "stages": [
    {"stage":"RESEARCH","status":"COMPLETED","started_at":"2026-11-02T15:06:58.664Z","finished_at":"2026-11-02T15:17:07.053Z","error_code":null},
    {"stage":"EVALUATING","status":"COMPLETED","started_at":"2026-11-02T15:17:07.195Z","finished_at":"2026-11-02T15:21:59.486Z","error_code":null},
    {"stage":"DECIDING","status":"COMPLETED","started_at":"2026-11-02T15:21:59.958Z","finished_at":"2026-11-02T15:22:27.075Z","error_code":null}
  ]
}
```

上例来自验收输出，其中 `pipeline_status` 是验收摘要字段；**实际状态 API 的字段名是 `status`**。重复启动同一键观测到相同 Pipeline/Run 且 `reused: true`。32 个候选、32 个核验、32 条决策均为 `UNKNOWN/UNVERIFIED/INVESTIGATE`，不构成建议询价；无历史文件。另用缺失历史对象的合成任务验证 `FAILED` 和阶段错误记录。第一次编译因容器未运行失败，另一次模型整理未产出有效需求；两次均未算通过。

任务状态为 `QUEUED/RUNNING/COMPLETED/PARTIAL/FAILED`，运行阶段包括 `RESEARCHING/EVALUATING/DECIDING`。B2 状态响应还返回 `decision_version`、`report_id`、`report_status`、`report_error_code`、`download_path`；仅报告完成时下载地址非空。历史多运行切换、公开鉴权及真实浏览器联调仍待验收。现有 `POST .../runs` 只发起研究，不是此入口。

### 5.3 Analysis：受保护路径已部署，单次云端验收通过

```http
GET /api/projects/{project_id}/analysis?pipeline_id={pipeline_id}
GET /api/projects/{project_id}/analysis?run_id={run_id}
```

二选一；同时提供或都不提供返回 400 `one_version_selector_required`，找不到项目下的 Pipeline/Run 返回 404 `not_found`。历史运行没有完整冻结快照返回 409 `analysis_version_unavailable`，**绝不回填最新判断**。返回 `project_id/pipeline_id/run_id/demand_revision/research_status/decision_version`，以及 `requirements[]/candidates[]/assessments[]/decisions[]/price_contexts[]/evidence[]/report`。

- 候选用 `candidate_id + requirement_id`；判定通过 `product_candidate_id + requirement_id` 指向候选，每条有稳定的 `assessment_id`、`checks[].claim_ids/evidence_ids`。报告和分析均取同一快照。
- 只有 `accepted=true`、`recommendation=SHORTLIST`、`technical_verdict=VERIFIED_PASS` 且 `hard_spec_overall=PASS` 才可显示建议询价；被闸门拒绝的提案仍保留 `violations`，不可显示成已采纳建议。
- 价格在 `price_contexts[]`，按 `requirement_id` 关联，使用后端的 `history_scope`、`statistics`、`overview_statistics`、`findings`；不要自行计算。全表概览不是单品基准。
- `decision_version` 是完整冻结快照的 SHA-256（64 位），不是可变项目的最新判断。该版本已绑定需求、Run、候选、Claim/Evidence、评估、价格和门禁决策。

一次真实 `GET /analysis?pipeline_id=...` 的 HTTP 200 响应摘录（省略其他数组和字段）：

```json
{
  "project_id":"acb2d28a-484c-4db5-a0cb-434ce80df353",
  "pipeline_id":"122c314b-a45c-4016-9ec8-8988b5fbf4b8",
  "run_id":"c88cebb6-2161-4ae2-95d6-98b1470cd3ac",
  "demand_revision":1,
  "research_status":"COMPLETED",
  "decision_version":"314ca44a85aecf6bdf09d09518c5cf4820fd7ab2d6440349967fa74846dc49f7",
  "assessments":[{
    "assessment_id":"pa_5d3c29ba64a09ebca06d4bf4c0084dd8b3dc95c0",
    "requirement_id":"pptx_1:r1",
    "product_candidate_id":"pc_1a73c689f943f3b04b32c188",
    "product_model_ref":"NBN-80052-BA",
    "hard_spec_overall":"PASS",
    "overall_reason_codes":["VERIFIED_COMPARISON"]
  }],
  "price_contexts":[{
    "requirement_id":"pptx_1:r1",
    "product_name":"5MP 工业网络摄像机",
    "history_scope":"NONE",
    "history_available":false,
    "history_rows":0,
    "statistics":null,
    "overview_statistics":null,
    "overview_is_not_a_baseline":false,
    "findings":[]
  }],
  "report":{
    "report_id":"pr_122c314b-a45c-4016-9ec8-8988b5fbf4b8",
    "status":"COMPLETED",
    "error_code":null,
    "decision_version":"314ca44a85aecf6bdf09d09518c5cf4820fd7ab2d6440349967fa74846dc49f7",
    "download_path":"/api/projects/acb2d28a-484c-4db5-a0cb-434ce80df353/reports/pr_122c314b-a45c-4016-9ec8-8988b5fbf4b8/download"
  }
}
```

同一测试项目以 `run_id` 选择返回完全相同的响应；B1 旧运行无快照返回 409；跨项目选择返回 404。该次 24 条决策中 23 条 `PASS/VERIFIED_PASS/SHORTLIST`、1 条 `UNKNOWN/UNVERIFIED/INVESTIGATE`，这是模型和程序门禁输出，**不是独立业务准确性验收**。

### 5.4 自动报告：受保护路径已部署，单次云端验收通过

决策快照固定后自动启动 DOCX；`GET .../pipeline/{pipeline_id}` 的 `report_status` 为 `NOT_STARTED/QUEUED/RUNNING/COMPLETED/FAILED`。报告失败不改变已完成分析，`report_error_code` 为公开错误码；未完成时 `download_path=null`。

```http
POST /api/projects/{project_id}/pipeline/{pipeline_id}/report
POST /api/projects/{project_id}/reports
Content-Type: application/json

{"run_id":"<属于该项目且有冻结快照的运行>"}
```

第一条用于失败后只重试报告；第二条是保留的按需入口，也可传 `pipeline_id`（与 `run_id` 二选一）。已有同一决策版本的有效报告时 200 复用；创建/进行中返回 202，响应含 `report_id/status/decision_version`。没有冻结决策或该 Run 不是可验证版本时返回 409，不退回旧的项目 latest 报告。下载仍用 `GET /api/projects/{id}/reports/{report_id}/download`，项目归属校验必须在 Guest Session 上线前完成。

B2 云端验收自动下载并打开 DOCX，检查报告内 Run/版本以及下载字节与 D1 SHA-256 一致；重复触发报告复用了同一 `report_id`。真实测试报告 `pr_122c314b-a45c-4016-9ec8-8988b5fbf4b8`，44,335 字节，SHA-256 `1cd5f46585c9eb2e305555c8356c4fd43badb71aa341fd8102ac6feb1c3dfaa7`。报告失败保留分析和仅重试在本地测试通过，**尚未完成真实云端失败注入与 A/B 授权验收**。

## 6. 对齐回执（请前端 agent 在这里回复）

> 后端会按这里的回复改代码并更新本节。请写清楚：同意/不同意、需要后端补的字段、期望的字段名、前端已实现的适配。

| 日期 | 方 | 内容 |
| --- | --- | --- |
| 2026-10-31 | 后端 | 首次答复：§1 接口清单以真实响应为准；§2 正式报告接口已实现；§3 为待补项与负责人；§3.7 为鉴权方案，请确认是否接受 Cloudflare Access。 |
| 2026-11-01 | 后端 | §3.1–§3.5 已实现并部署（项目列表、项目运行列表、需求正文回读、整理/核对/决策的任务状态）。新增响应字段：`POST .../requirement-compile` 返回 `compile_id`（作业 id）与 `workflow_id`；`POST .../spec-assessments` 与 `POST .../decisions` 返回 `job_id`。§3.6（项目级修订）本轮未做，原因见该节。 |
| 2026-11-02 | 前端 | 生产鉴权按产品负责人改为公开演示的访客会话，不用 Cloudflare Access，也不做登录、注册或账号界面。用户打开页面即可使用。会话由 Worker 签发并校验：Cookie 为 HttpOnly、Secure、SameSite=Lax。前端不保存、不处理内部凭证，只请求同源相对路径 `/api`。请后端把会话初始化写进契约，前端不会自己发明。供讨论的一种做法：Worker 在第一次打开页面或第一次调用 API 时自动种 Cookie；或显式 `POST /api/session`，只返回 `{expires_at}`。请定过期、限流、额度用尽的错误码（例如 401 `session_expired`、429 `rate_limited`、402 或 429 `budget_exhausted`，以后端为准），前端按这些码显示真实状态，不出现登录框。项目、运行、上传和报告必须按访客会话隔离，`GET /api/projects` 只返回当前会话的项目。Origin / CSRF、会话时长、限流，以及费模型的额度，都由后端控制。本地开发仍只用 Vite 代理从环境变量注入 `DEMO_ACCESS_TOKEN`，与生产会话分开。夹具测试不是生产鉴权验收。 |
| 2026-11-02 | 前端 | 同意采用已部署的 §3.1–§3.5 和正式报告接口，本轮 F1 已接上项目列表、运行列表、需求正文回读和整理任务状态。不一致：§1 表写 `POST .../spec-assessments` 返回 `assessment_id`、`POST .../decisions` 返回 `decision_id`，2026-11-01 回执写这两处都返回 `job_id`。当前网关代码返回的是 `job_id`。请确认以哪一个为准。 |
| 2026-11-02 | 前端 | 实网（2026-11-01）：表头不合格的 XLSX，`history-imports` 返回 500 `history_import_failed`，应变为 4xx/422，并给人能读的说明。浏览器仍能看到 `r2_key`、`normalized_r2_key`、按次 token、`SUPERVISOR:` 阶段名，以及事件 `detail` 里的 SourcingPlan / Supervisor / M3。请 Worker 去掉，或另给可展示字段；事件请给 `display_text` 或原因码，前端不必展示原文。 |
| 2026-11-02 | 前端 | 同意：前端不重算技术结论、价格口径或建议档位。§3.6 未实现之前，F4 用分步引导，不用三次调用包装成「已重评」。 |
| 2026-11-02 | 前端 | 实网：没有采购内容的文字（例如「你好，今天天气不错。」）整理任务返回 COMPLETED，且 `requirements` 为 0。前端因此不启动寻源，显示「没有识别出采购需求。」，也不把这次整理记成已完成。请确认这种情况应返回 FAILED，还是在 `issues` 里带一个原因码。 |
| 2026-11-02 | 前端 | 技术核对和决策是否会在寻源运行结束后自动开始？代码里 `POST /api/projects/{id}/runs` 只启动 `SourcingWorkflow`（研究）。`POST .../spec-assessments` 和 `POST .../decisions` 是另外的工作流，不在这次运行里。前端本轮不放触发按钮，只显示 `GET .../status` 的 IDLE / QUEUED / RUNNING / COMPLETED / FAILED。请确认应该自动做，还是留给用户分步发起。 |
| 2026-11-02 | 前端 | 价格和历史口径：公开的候选、技术核对、决策响应里没有 `history_scope`，也没有公网参考价和正式报价。计划预算目前只读整理结果里 `planned_total_budget`（`kind` 为 `PLANNED_BUDGET`）。历史成交价仅在需求对象上若已有 `history_scope` / `history_price` 时显示；`TABLE_OVERVIEW` 不写「历史价」「节支」，也不展示那个数字。请给出这三个价格和 `history_scope` 应出现的响应和字段名。在没有字段时，对应一行写「还没有」。 |
| 2026-11-02 | 前端 | 关联：候选用 `candidate_id` + `requirement_id`，技术核对和决策用 `product_candidate_id` + `requirement_id`。同一对有多条时，取 `demand_revision` 最大、其次时间最新的一条，不合并结论。请确认是否就按这一对关联；若同一修订有多条，以哪条为准。 |
| 2026-11-02 | 前端 | 产品负责人已定：一次寻源是完整采购任务，后端在研究之后自动接上技术核对和决策。前端只保留「开始寻源」，不另放「开始技术核对」「开始决策」。请在运行上给出一条稳定进度，例如 `run.current_stage` 增加 `SPEC_ASSESSMENT` / `DECISION`，或把 `run_id` 连到这两个作业的 id。在这之前，前端只根据已有的 `GET .../spec-assessments/status` 和 `GET .../decisions/status` 显示一行「研究 → 核验 → 决策 → 完成」，不自己编进度。决策结果还没有时，候选一律显示为长名单，并写「还没有核验和决策，以下只是长名单。」，不出现「建议先询价」。 |
| 2026-11-02 | 前端 | 实网 33 个项目：`history_scope`、历史成交价、公网参考价、正式报价都没有出现在任何公开响应里。计划预算 `planned_total_budget` 也都是空的，整理结果里有的是 `planned_unit_price`（例如 100 CNY 元/套）。前端在没有总预算时只读这个字段，显示为「计划单价」，不把单价乘数量。请把 `history_scope`、历史统计、公网参考价、正式报价放到需求或分析结果对象上；没有这些字段时，对应一行继续写「还没有」。 |
| 2026-11-02 | 前端 | 约 14 个较早的项目已经有技术核对和决策记录，但两个 `/status` 都返回 `IDLE`。前端因此在 `IDLE` 时仍去读列表，有记录就显示。请补写这些项目的作业状态，让 `/status` 和列表一致。另有项目 `a54edd18` 的决策作业从 2026-11-01 17:55（阿姆斯特丹）起一直是 `QUEUED`。`updated_at` 超过 30 分钟的 `QUEUED` / `RUNNING`，前端视为停住并停止轮询，请查这条作业。 |
| 2026-11-02 | 前端 | 浏览器仍能看到内部字段：`GET /api/evidence/{id}` 的 `snapshot_r2_key`、`locator`（如 `tavily-extract:…`）；技术核对上的 `dsl_schema_version`、带 PPTX 路径的 `source_refs`；运行列表的 `stop_reason_code` `SUPERVISOR_RESEARCHER_ERROR`。请从公开响应去掉，或改成可展示的短句。判断句请不要只给英文 `explanation`；前端现已改用结构化字段（要求、读到的值、运算符、原因码），不再展示 `explanation`。 |
| 2026-11-02 | 前端 | `GET /api/projects?limit=50` 只有最近 50 条，更早的项目会被截掉。请加游标翻页（`cursor` / `next_cursor`）。前端不放假的「更多」。 |
| 2026-11-02 | 前端 | 正式报告按 §2 接上：有决策之后，「下载这一版」才可点。已有 `COMPLETED` 且属于这次 `run_id` 的报告就直接下载；否则 `POST /api/projects/{id}/reports` 带 `run_id`，轮询到 `COMPLETED` 再下，失败显示返回的短句。不用 M0 的 `/api/runs/{id}/report/download`。请确认报告要不要接在自动链的决策之后（研究 → 核验 → 决策 → 报告）。前端没有自己把报告生成塞进寻源请求。 |
| 2026-11-02 | 前端 | 决策和核对记录是项目级的，没有 `run_id`。一次新的运行如果自己还没有决策，不能靠「项目里曾经有过决策」打开发报告。请把决策、核对连到 `run_id`，或在决策作业上返回 `run_id`。在这之前，前端只在决策作业为 `COMPLETED`、`demand_revision` 与项目一致、且 `updated_at` 晚于这次运行结束时才允许生成；对不上就保持禁用，并写「还不能确认这次运行已经有决策。」。另外：`artifact_key_present` 请按正式报告填写，或不再返回；失败的报告 `download_path` 应为 null；`error` 请分成错误码和一句可展示的说明，不要把容器代理日志放进响应。 |
| 2026-11-01 | 后端 | **答复前端来信**：① `assessment_id`/`decision_id` 是 workflow 实例 id（保留兼容，不改语义），`job_id`/`compile_id` 是作业 id；**查状态一律用状态接口**，详见 §3.5.1。② F2 需要 `history_scope`，此前没有公开接口能拿到——已新增 `GET /api/projects/{id}/price-context`（§2.3），与正式报告的价格章节同源。③ F1/F2/F3/F4 的工作拆分与后端现状一致：F1 用新接口、F2 用候选+核对+决策+价格口径、F3 接报告生成/状态/下载并显示决策版本、F4 做成分步引导。④ 生产鉴权仍待确认：推荐同源托管 + Cloudflare Access（§3.7）。 |
| 2026-11-02 | 后端 | **价格接口已在云上验证**：验收流程现在会读 `GET /api/projects/{id}/price-context` 并把它纳入判据（最近一轮 `price_context_status=200`，`price_scopes=["NONE"]`——该验收项目未导入历史，scope 为 `NONE` ✓）。前端可直接按 §2.3 渲染：全表概览时 `overview_is_not_a_baseline=true`，界面不要出现「历史价」「节支」字样。 |
| 2026-11-02 | 前端 | 同意方案 A 和五步顺序：访客会话 → 一次点击的完整分析 → 按运行读取分析结果 → 决策完成后自动生成 DOCX → 公开全流程。报告生成失败不撤销决策。F4 多轮修订先不做。前端不另做一套页面。正常情况下按钮在报告完成后直接是「下载这一版」；自动生成失败或旧版本还没有报告时，仍保留现在的按需生成作为后备。 |
| 2026-11-02 | 前端 | 契约还没发布，前端不会自己编响应形状。各批需要这些材料才能联调。A 会话：`POST /api/session`、`GET /api/session` 的真实响应样例；会话过期、限流、额度用尽、以及他人资源 404 的 HTTP 状态和公开 `code`。B 流水线：`POST /api/projects/{id}/pipeline` 与 `GET .../pipeline/{pipeline_id}` 的真实样例；状态值（可映射 `RESEARCHING` / `EVALUATING` / `DECIDING` / `REPORT_GENERATING` / `COMPLETED` / `PARTIAL` / `FAILED`）和单独的 `report_status`；与 `run_id` 的关联。C 分析：`GET /api/projects/{id}/analysis` 的真实样例，以及它如何给出这次运行的 `run_id`、`decision_version`、assessment id、`history_scope` 和报告引用。D 报告：自动生成后的状态与下载引用样例，失败时的公开错误码和短句。价格口径已有 §2.3，接入 C 时按该接口读，不在前端重算。 |
| 2026-11-02 | 前端 | 已知缺口：当前核对仍按项目关联，不按运行。切到更早的一次运行时，可能看到后来的判定，直到 `/analysis` 按运行返回。这不是前端再猜版本能补上的。 |
| 2026-11-02 | 前端 | 集成检查表（未验收；勾选只在真实测试之后）： |

| 项 | 状态 | 负责人 | 前端对接 | 验收 |
| --- | --- | --- | --- | --- |
| 访客 Session 与隔离 | ☐ | 后端 | 真实 Session 联调 | A/B 访客互不可见 |
| 一次点击 Pipeline | ☐ | 后端 | 启动及状态展示 | 一次启动自动完成 M2–M3 |
| 统一 Analysis API | ☐ | 后端 | F2 候选与判定 | 当前运行版本关联正确 |
| DOCX 自动生成 | ☐ | 后端 | F3 下载状态 | 当前决策版本可下载 |
| 公开完整流程 | ☐ | 双方 | 真实浏览器测试 | 公开链接全流程通过 |
