# M4 后端契约答复与对齐

回应 `docs/m4/backend_contract_requests.md`（基线 `f0fa49b`）。本文记录接口及待办；历史回执不代表当前生产认证已就绪。B2 的新 Pipeline 使用冻结快照，旧报告不能据此追认版本绑定；多次历史运行切换尚未完成真实浏览器验收。
前端可以**直接在本文件下方「对齐回执」一节回复**，后端会按回执改，不另开文档。

- 后端仓库：`procurement_sourcing_agent`（本仓库）
- 后端最新提交：见 `git log -1`
- 网关：`https://procurement-sourcing-agent.com`
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

### 5.1 Session：已启用并完成云端访客验收

- `POST /api/session`：同源 Origin 必填；创建返回 201 `{ "expires_at": "ISO-8601" }`，设置 `__Host-ps_session`；有效会话重复请求返回 200、同一过期时间；其他 API 不自动创建。前端现有 `openSession()` 只要求 2xx，与真实形状兼容。
- `GET /api/session`：200 `{ "expires_at": "ISO-8601" }`；无会话 401 `{ "error": "session_required" }`；无效或过期 Cookie 401 `{ "error": "session_expired" }`。过期后 POST 创建新身份，不能恢复旧项目。
- Cookie 为 `HttpOnly; Secure; SameSite=Lax; Path=/`，固定 24 小时；签名密钥只存在服务端。修改请求缺失或不匹配 Origin 返回 403 `{ "error": "origin_mismatch" }`。
- 访客可执行：建项目、提交需求文字、上传 PPTX/XLSX、需求整理、导入历史、一次点击分析。**其他写操作仍返回 503 `operation_unavailable`**（独立寻源运行、独立核验、独立决策、按需报告）。跨访客或无归属资源统一 404 `{ "error": "not_found" }`。
- 限流：D1 固定窗口，会话创建按全局/IP 计数，认证请求按全局/会话计数；缺少限额配置或 D1 故障时拒绝，超限返回 429 `rate_limited` 与 `Retry-After`。只保存 IP 的 HMAC，不保存原始 IP；同区域 Worker 子请求的 IP 可能被改写，不能当作身份。固定窗口在边界可能突发。
- 任务预算：每次需求整理占 1 个单位，每次完整分析占 4 个单位；并发上限全局 2、每访客 1；每访客每日 16 个单位、6 次启动；全局每日 80 个单位。超限返回 429 `{ "error": "budget_exhausted" }`；未配置返回 503 `task_budget_not_configured`。单位是并发与日量的粗略代理，**不是模型调用次数或金额**：实际模型与搜索调用仍只受 M2 内部已有的搜索/取页/轮次上限约束，没有逐次扣费。
- **CLOUD_VERIFIED（访客全链路）**：代码 `f0f57f4`、容器 `sourcing-v18`、migration `0012–0018`。验收脚本 `scripts/verify_guest_cloud.py`：两个真实访客会话互不可见（项目、运行、分析、报告与报告下载全部 404）；一个访客完成“建项目 → 提交需求 → 整理 → 一次点击分析 → 读取冻结分析 → 下载 DOCX”，报告约 44 KB 且内含 Run 与决策版本；重复启动复用同一任务；整理与分析各占 1/4 单位，任务结束后释放并发但**不退还日额度**。
- **寻源结果质量**：同一需求下修复前的结果是 24 条全部 `UNKNOWN/UNVERIFIED/INVESTIGATE`（等于没找到可用的采购结论）；修复后为 **22 条 `PASS`/`SHORTLIST` + 1 条 `UNKNOWN`/`INVESTIGATE`**，29 份证据快照。修复内容：把人工审校的别名表写进对齐提示词、模型把方法标错时按别名表纠正、模型未给出可用 claim 时由别名表补选证据。模型的语义拒绝仍保留为 UNKNOWN，代码不把不确定变成通过。
- **结果摘要**：`/analysis` 新增 `summary`，给出 `requirements / candidate_rows / distinct_models / distinct_suppliers / models[] / assessments / by_verdict / by_recommendation / evidence / coverage_warnings`。`models[]` 按型号聚合 `candidate_rows` 与 `supplier_count`，界面应按型号展示而不是把同一型号的多个供应商行平铺。`coverage_warnings` 在只找到一个型号、没有候选、没有证据或没有候选通过核验时给出中文提示。
- **过程可见**：`GET .../pipeline/{pipeline_id}` 新增 `candidates_found / models_found / evidence_found`，在核验开始前就已写入，前端可在等待期显示“已找到 N 个型号 / M 个供应来源”。
- **研究深度可调**：`POST .../pipeline` 可选 `research_budget`（`max_search_calls/max_fetches/max_tasks/max_rounds/max_model_calls`，各有上限，越界 422 `research_budget_out_of_range`）。默认 `4/4/2/1/12`；一次完整的公开演示约 8–12 分钟，评委时间紧张时前端可提供“快速预览”（如 `3/3/1/1/8`）。
- 运维身份：`DEMO_ACCESS_TOKEN` 已轮换，仅供验收脚本与开发代理使用；生产前端构建不得携带它。访客开关已开启（`GUEST_SESSION_ENABLED=true`），共享凭证路径仅作为运维入口保留。

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

### 5.2.1 Pipeline 发现与恢复（受保护路径已部署、实网验证）

```http
GET /api/projects/{project_id}/pipelines?active=true&limit=20
GET /api/projects/{project_id}/pipelines?limit=20
```

返回 `{project_id, pipelines: [...], has_more}`。每项含 `pipeline_id/run_id/demand_revision/status/stage/decision_version/report_id/report_status/created_at/updated_at`；不返回幂等键。默认最近 20 条，`limit` 为 1–100，按创建时间和 ID 倒序；`has_more=true` 说明列表被截断，**本版无游标，不应假装完整分页**。`active=true` 选出分析 `QUEUED/RUNNING` 或报告 `QUEUED/RUNNING` 的任务，因此报告仍在生成的已完成分析也可找回；不依赖 `runs` 行已经创建。无活动任务时可去掉 `active` 查询最近记录。允许多个任务同时活动，前端应保留每个 ID，不应假设每项目只有一个或擅自创建新任务。项目不存在 404 `not_found`，参数无效 400；D1 错误 503 `database_unavailable`。

**CLOUD_VERIFIED，非 PUBLIC_READY**：接口代码 `747cb66`，容器配置 `sourcing-v17`。真实网关已验证已有项目的列表恢复、`active` 过滤、无凭证 401、无项目 404、非法参数 400；另使用隔离的合成 D1 项目验证了“分析运行中 + 报告生成中”都能被 `active=true` 找到、终态任务被排除，测试数据已清理。本地也用真实 Worker 路由 + 隔离 D1 验证了尚未创建 Run 行的 QUEUED 任务。Guest Session 当前关闭，现有 Pipeline 详情和本列表仅供受保护服务端路径；访客归属隔离需 B3 验收。

真实网关返回的已完成任务摘要（`pipelines` 中一项）：

```json
{
  "pipeline_id":"122c314b-a45c-4016-9ec8-8988b5fbf4b8",
  "run_id":"c88cebb6-2161-4ae2-95d6-98b1470cd3ac",
  "demand_revision":1,
  "status":"COMPLETED",
  "stage":"COMPLETED",
  "decision_version":"314ca44a85aecf6bdf09d09518c5cf4820fd7ab2d6440349967fa74846dc49f7",
  "report_id":"pr_122c314b-a45c-4016-9ec8-8988b5fbf4b8",
  "report_status":"COMPLETED",
  "created_at":"2026-11-02T17:19:23.513Z",
  "updated_at":"2026-11-02T17:33:09.904Z"
}
```

刷新后先查询 `active=true`，用返回的 ID 查询详情并继续轮询；若无活动项，可不带 `active` 查询最近记录。分析刚结束、报告仍为 `NOT_STARTED` 的短暂间隙不会被 `active=true` 判成正在运行，因此仍需最近记录的兜底。拿不到启动响应时，优先保留原幂等键并重试；`idempotency_conflict` 表示该键已绑定不同请求，不应无提示地换新键自动创建可能重复计费的任务。

### 5.2.2 精确阶段与报告语义

`GET .../pipeline/{pipeline_id}` 的两个字段不是同一个枚举：

- 顶层 `stage`：正常研究中为 `RESEARCHING`，之后 `EVALUATING`、`DECIDING`；排队/终态还可能是 `QUEUED/COMPLETED/PARTIAL`，失败时为失败阶段名（包括 `RESEARCH`）。顶层 `status` 独立为 `QUEUED/RUNNING/COMPLETED/PARTIAL/FAILED`。
- `stages[].stage`：`RESEARCH/EVALUATING/DECIDING`，每项有独立 `status`、时间和错误码；**不会新增 `REPORT` 项作为当前契约**。正在运行的实网记录已观察到顶层 `stage=RESEARCHING` 与 `stages[0].stage=RESEARCH` 同时存在，两者不是冲突。
- 报告状态只看顶层 `report_status`：`NOT_STARTED/QUEUED/RUNNING/COMPLETED/FAILED`。分析 `status=COMPLETED` 时报告仍可能 `QUEUED/RUNNING`，前端应继续查询报告状态并显示「正在生成报告」；报告失败不撤销分析，展示失败提示并可仅重试报告。`NOT_STARTED` 不是正在生成：旧 B1 运行没有冻结决策，B2 在完成分析与启动报告之间也可能短暂出现；不可凭此推断完成或失败。已有 `decision_version` 时可使用 §5.4 仅重试报告。
- 不要在首次收到分析 `COMPLETED/PARTIAL` 就停止报告轮询；不应无限等待 `NOT_STARTED` 或把它假装成失败。`download_path` 仅在报告 `COMPLETED` 时非空。

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

### 5.3.1 决策中文展示摘要（受保护路径已部署、实网验证）

`/analysis` 的每条 `decisions[]` 新增 `display`：

```json
{
  "version":"decision-display-v1",
  "basis":"STRUCTURED_ASSESSMENT_NOT_TRANSLATION",
  "summary_code":"EVIDENCE_INSUFFICIENT",
  "summary_zh":"现有证据不足以判断是否符合全部硬性条件，建议补充核验。",
  "gaps":[{"code":"MISSING_CLAIM","constraint_id":"text_1:c3","importance":"HARD","evidence_ids":[],"text_zh":"尚未找到支持该项指标的可用资料。"}],
  "next_actions":[{"code":"MISSING_CLAIM","constraint_id":"text_1:c3","text_zh":"补充该型号的对应技术资料并核验来源。"}],
  "unresolved_question_ids":[],
  "untranslated_originals":{"rationale":true,"gap_count":5,"next_action_count":3}
}
```

这是 RUT241 实网响应的 `display` 摘录，数组只展示一条；该真实响应包含 4 项结构化缺口、4 项结构化跟进建议。`display` 按本次冻结核验、门禁状态和原因码确定性生成；`summary_zh` 是核验摘要，不是模型英文 `rationale` 的逐句翻译。`gaps/next_actions` 是基于结构化核验原因的通用缺口与跟进建议，保留约束和证据 ID；不保证覆盖模型原文中所有商务、供货或其他缺口。原始 `rationale/gaps/next_actions` 不变，`untranslated_originals` 标明仍有多少原始内容未逐条翻译。前端应提示“还有原始信息待核对”，不能把中文摘要当成完整翻译或丢弃原文中的缺口。**完整逐条中文翻译尚未实现**；需要单独做带溯源和一致性校验的翻译，不能用规则猜测原文的商业含义。未知原因返回 `UNMAPPED_ASSESSMENT_REASON`，不伪造具体结论。

摘要码：`GATE_REJECTED`、`ASSESSMENT_UNAVAILABLE`、`RECOMMENDED_INQUIRY_VERIFIED`、`HARD_REQUIREMENT_FAILED`、`EVIDENCE_INSUFFICIENT`、`FURTHER_INVESTIGATION`、`REVIEW_REQUIRED`。`UNKNOWN` 和拒绝决策不会被摘要显示成合格或建议询价。`display.version` 是展示规则版本，独立于 `decision_version`；这是对不可变快照的只读投影，不改变原始决策版本或历史报告。代码 `9b3cc27` 已部署；真实网关按 Pipeline 和 Run 选择得到相同响应，并核对决策版本及原始理由、缺口、行动和 Evidence ID 均未改变。

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
| 2026-11-02 | 前端 | B1 受保护 Pipeline 已接到开发代理。开始分析调用 `POST /api/projects/{id}/pipeline`，请求头 `Idempotency-Key`，正文 `{"demand_revision": 项目当前修订}`。同一项目和同一修订的键保留到收到 202，所以重复点击、失败重试或刷新会复用同一任务。进度轮询 `GET /api/projects/{id}/pipeline/{pipeline_id}`，状态读 `status`。`RESEARCH` 和 `RESEARCHING` 都显示「正在寻找供应商」，`EVALUATING` 显示「正在核对技术与价格」，`DECIDING` 显示「正在整理采购建议」。`COMPLETED` 只表示分析完成，不显示「正在生成报告」，因为这一版没有 `report_status`。返回的 `run_id` 用来选定运行。B1 没有文档化的办法在刷新后找回项目正在进行的 Pipeline，前端只把最近的 `pipeline_id` 放在 sessionStorage，这是界面状态，不是接口。请后端提供一种发现方式：`GET /api/projects/{id}/runs` 的每条带上 `pipeline_id`，或者 `GET /api/projects/{id}/pipelines?limit=`。请确认阶段名是 `RESEARCH` 还是 `RESEARCHING`（验收样例的 `stages[].stage` 是 `RESEARCH`，正文写 `RESEARCHING`）。请确认 B2 的 `stages[]` 会不会增加 `REPORT`。生产访客会话仍按要求关闭。这条链路还没有实网联调。 |
| 2026-11-03 | 后端 | 收到 PR #4（`8cbfb09`，已合并 `d116ebb`）。恢复入口 `GET .../pipelines?active=true` 已部署并完成受保护实网验证（代码 `747cb66`），详见 §5.2.1。`RESEARCHING` 是顶层当前阶段，`RESEARCH` 是阶段记录的名字；B2 不增加 `stages[].REPORT`，报告看独立 `report_status`，详见 §5.2.2。已观察到实际 RUNNING 响应同时包含这两种名字。前端目前在分析终态停止 Pipeline 轮询，请按报告状态继续跟踪。 |
| 2026-11-03 | 后端 | F2/F3 对齐提醒：Pipeline 的核验与决策写在该次冻结快照，不会回填旧项目级 `/spec-assessments` 与 `/decisions`；不要使用旧 job 的时间比较或项目级最新判断代替版本关联。请按选中 `run_id` 或 `pipeline_id` 调 §5.3 `/analysis`，无快照的旧运行保留 409，不拼接最新数据。只有采纳、技术 PASS 的 SHORTLIST 是建议，候选 `stage` 不代表已进入 RFQ。 |
| 2026-11-03 | 后端 | 已读取前端后续提交 `656d203`（尚未合并到 main）。该实网 Pipeline 的 `/analysis?pipeline_id=ad2c41f7-…` 实际返回 1 候选、1 核验、1 决策；核验为 `UNKNOWN`，通过门禁的决策为 `UNVERIFIED/INVESTIGATE`，不是通过的询价建议。旧 `/spec-assessments`、`/decisions` 为 0 是因为 Pipeline 结果保存在冻结快照，不写旧项目级表；请用 §5.3 `/analysis`。所下载的报告包含该 Run、完整版本、UNKNOWN 和待补证，SHA 与报告记录一致；不是只有长名单，但引用证据的旧摘录含占位文字，见下条。 |
| 2026-11-03 | 后端 | `ev_a3fe0597c3455af88296ed36` 的原始快照确有网页模板占位文字，也包含 RUT241 正文；该证据未被该次技术核验作为比较依据，决策保留 UNKNOWN。代码 `c0b7393` 已部署并实网验证：`/api/evidence`、旧 `/candidates` 的 `excerpt` 和 `/analysis` 的 `quote` 不再显示该模板文字，选出的摘录是原始快照中的连续子串；证据 ID、快照哈希、历史决策版本及 UNKNOWN 决策均未改变。`excerpt_status/quote_status` 为 `ORIGINAL/FILTERED_BOILERPLATE/UNAVAILABLE`；原始 `snapshot_text` 保留，不是经过清洗的引用。`def5a3e` 还从公开证据响应隐藏了 R2 key 和内部 locator。已有 DOCX 是不可变历史制品，仍包含旧占位摘录，不会静默覆盖；`e19f5ac` 已部署并实网验证：该版本的 `/analysis.report.warning_codes` 返回 `["LEGACY_PLACEHOLDER_EXCERPT"]`，普通不含该占位内容的报告返回空数组。前端应提示历史报告含占位摘录。 |
| 2026-11-03 | 后端 | `runs.current_stage=WEB_RESEARCH` 与 `artifact_key_present` 描述 M2/旧 Spike 运行，不描述 Pipeline 后续阶段或正式报告；请用 Pipeline 状态与 `report_status`。就报告的约 100 秒轮询，我对同一已完成 Pipeline 实测 5 次约 0.6–1.6 秒，未复现，不能据此判断原因或宣称修复；前端单请求超时后继续轮询是合理的。 |
| 2026-11-03 | 后端 | 两次摄像机整理对应同项目需求修订 1、2，D1 确认均无结构化需求并记录 Requirement schema 验证失败；不能当成“没有采购内容”。代码 `c0b7393` / 容器 `sourcing-v18` 已部署：对全体模型需求均未通过 schema 的情况最多按既有上限重试，保留先前来源条款/缺口，不由代码补造数字；重试仍失败时在 `issues` 返回 `requirements_schema_unresolved`，模型未识别需求返回 `no_recognizable_demand`。用两次原文各自在隔离项目实网重跑：均得到 1 条需求，分别含 1、3 条约束，输出约束引文均可在原文找到；原项目两条原文哈希未变，隔离记录已清理。该结果不证明每次模型输出都正确，也未证明本次实际触发了重试。 |
| 2026-11-03 | 后端 | **访客会话已启用并完成云端全链路验收**（代码 `3b0f562`/`6a9bcb7`）：两个真实访客互不可见，一个访客跑通“建项目→需求→整理→一次点击分析→冻结分析→下载 DOCX”。契约见 §5.1。运维 Bearer 凭证已轮换；请前端更新本地 `.env.local`，且**生产构建不得携带该凭证**，浏览器只依赖 HttpOnly 会话。访客可执行整理与一次点击分析；独立寻源/核验/决策/按需报告接口对访客仍返回 503，前端继续只调用 `POST .../pipeline`。 |
| 2026-11-03 | 后端 | M2 寻源计划在“没有可用研究问题”时改为再问一次（同一模型、同一规则），此前该情况会让整条分析以 `INVALID_RESEARCH_INPUT` 失败；访客验收因此通过。真实访客验收曾遇到一次容器端口中断导致分析失败，研发步骤不做自动重试以免重复计费，失败按 `PIPELINE_STAGE_FAILED` 记录并可由用户重试。 |
| 2026-11-03 | 后端 | 对理由、缺口与下一步：`/analysis.decisions[].display` 的结构化中文摘要已在 `9b3cc27` 部署并实网验证，详见 §5.3.1；原始文本保留，中文摘要不是逐条翻译，仍未映射的原文数量明确返回。交付状态文档已纠正 B2 的旧“本地未验证”表述。访客会话基础代码虽然已部署，但开关仍关闭；A/B 越权、会话创建限流、单访客和部署级预算/并发尚未完成，不应声称公开流程可用。 |
| 2026-11-03 | 后端 | 历史文件导入的错误语义已按前端要求改正：不再返回 500 + 异常类名。文件不是 Excel、工作簿打不开、或表头无法识别时返回 **422** `{ "error": "history_file_rejected", "reason_code": "history_file_header_not_found", "detail": "工作表没有可用的表头：需要采购订单号、产品名称和数量这些列。" }`；文件超过 32MB 返回 `reason_code: history_file_too_large`；其他失败返回 502 `history_import_failed` 和一句中文提示，**不含任何内部诊断**。前端可按 `reason_code` 或直接展示 `detail`。 |
| 2026-11-03 | 后端 | 公开演示页面已由同一个 Worker 提供（`/api` 与页面同源），地址 `https://procurement-sourcing-agent.com`；已验证页面 200、静态资源 200、`/api/health` 200、公开 Origin 下 `POST /api/session` 201。前端**第一优先**是把 `useGuestSession` 接进 `App.tsx`（钩子已存在但尚未被使用），否则访客第一次点击就会拿到 401。生产构建已带 `VITE_GUEST_SESSION=1`，前端不需要也不应携带任何 Bearer 凭证。 |
| 2026-11-04 | 前端 | **新前端 agent 接手，已接 A1/A2/A3，见下三条。请后端 agent 按这三条处理。**（一）**访客会话开关请做成后端可判定、前端不必依赖构建环境变量。** 现象：`frontend/src/session/useGuestSession.ts` 原先只在 `VITE_GUEST_SESSION=1` 时才 `POST /api/session`，而生产构建的环境变量不在仓库里（Cloudflare Builds 的构建命令不在仓库中）。前端已改成**运行时探测**：先 `GET /api/session` 读 `mode`，访客没有会话时（401）才 `POST` 一次。**更正一条我先前写错的话**：我曾说“线上 bundle 不是从本仓库构建的”，这个判断不成立——构建命令 `npm --prefix frontend ci && VITE_GUEST_SESSION=1 npm --prefix frontend run build && npx wrangler deploy` 配在 Cloudflare 账号里，`VITE_GUEST_SESSION` 被 Vite 内联成 `"1"`，压缩后的包里自然找不到这个字符串字面量。运行时的探测不依赖构建环境变量，前端保留。（二）**访客不能重试报告。** 现象：§5.1 说访客的写操作只放开“建项目/需求文字/上传/整理/历史导入/一次点击分析”，`POST /api/projects/{id}/pipeline/{pipeline_id}/report` 与 `POST /api/projects/{id}/reports` 对访客返回 503 `operation_unavailable`。后果：报告生成失败时，访客在页面上点“重新生成”没有任何办法，前端只能显示一句“这次报告没有生成，暂时不能重新生成。”，演示时无法自救。期望后端：放开访客的**仅重试报告**（`POST .../pipeline/{pipeline_id}/report`），并计入预算单位；或者给出访客可用的重试入口。（三）**`price_contexts[].budget` 没说自己是总价还是单价。** 现象：容器里 `budget_observation()` 取的是 `planned_unit_price or planned_total_budget`，但接口只给一个 `budget` + `basis=PLANNED_BUDGET`。前端按设计规范只能写“计划预算”，遇到实际是单价的需求就会误导买家。期望后端：在 `price_contexts[]` 里补一个字段（建议 `budget_kind`，取值 `PLANNED_BUDGET` / `PLANNED_UNIT_PRICE`）或给 `planned_unit_price`、`planned_total_budget` 两个独立字段。 |
| 2026-11-05 | 前端 | **已按 11-05 的答复接完前端的四个改动**（随下一次部署上线）：（1）会话身份读 `GET /api/session` 的 `mode`，不再从状态码猜；（2）访客点「重新生成」改用 `POST /api/projects/{id}/pipeline/{pipeline_id}/report`，运维通道仍用 `POST /api/projects/{id}/reports`；（3）价格第一行按 `price_contexts[].budget_kind` 写「计划单价」或「计划预算」，不再一律写「计划预算」；（4）型号数直接用 `summary.distinct_models`。另外修了一个实跑发现的缺陷：**运行行会先变终态，冻结快照还没写好**，此时 `/analysis` 返回 409，前端原来只问一次就放弃，结果要刷新页面才出现；现在只要任务还在跑就每 5 秒再问一次，直到快照出现。这条有专门的浏览器测试（先 409 两次再给快照）。<br>**请后端确认两点**：（a）访客重试报告后，`/analysis` 里的 `report.status` 与 `report.download_path` 会跟着变吗？前端重试后靠这两个字段判断是否成功；（b）`GET /api/session` 在访客通道但会话已过期时返回 401 `session_expired`，前端会重建一次会话，这一步会多花一次“创建会话”的限流额度（每 IP 每小时 10 次），可以接受吗？ |
| 2026-11-04 | 前端 | **实跑里复现了一个后端失败，请后端查（不是前端问题，页面已经如实显示）**：用需求文字“采购 10 套 5MP 工业网络摄像机，要求像素不低于 5MP，防护等级 IP67，支持 PoE 供电，质保不少于 2 年，单价不超过 500 元/套。”新建项目并点“开始分析”，**连续两次**在研究/决策阶段失败：\n\n| pipeline | 失败阶段 | `status`/`stage` | `error` | `candidates_found`/`models_found`/`evidence_found` | `stages[]` |\n| --- | --- | --- | --- | --- | --- |\n| `829d2852-…` | 顶层 `stage=EVALUATING` | `FAILED` | `PIPELINE_STAGE_FAILED` | 21 / 2 / 30 | `RESEARCH=PARTIAL`、`EVALUATING=COMPLETED`，**没有 DECIDING 这一行** |\n| `38e6bdfb-…` | 顶层 `stage=DECIDING` | `FAILED` | `PIPELINE_STAGE_FAILED` | 18 / 2 / 19 | `RESEARCH=PARTIAL`、`EVALUATING=COMPLETED`、`DECIDING=FAILED` |\n\n两个任务的研究阶段都是 `PARTIAL`（研究预算用完），随后决策阶段抛错。同一账号下另一段需求（“采购 10 套 5MP 工业网络摄像机，要求像素不低于 5MP……”）一次跑通（`RESEARCH/EVALUATING/DECIDING` 全部 `COMPLETED`，报告 `COMPLETED`，下载到 45,483 字节 DOCX）。请后端查 `PIPELINE_STAGE_FAILED` 的具体原因（前端只拿到这个公开错误码，看不到容器日志），并确认是不是“研究预算用完 → 部分候选缺 claim → 决策阶段抛错”。另外第一条里顶层 `stage=EVALUATING` 但 `stages[]` 没有 DECIDING 行，两处对不上，前端只能按 `stages[]` 显示。\n\n前端这边的表现：任务失败时页面显示“这次分析没有完成，可以再试一次。”，不显示任何结果，也不显示下载按钮（失败的版本没有报告），“再次分析”可点；重新加载后仍能找回这个任务和它的失败原因。 |
| 2026-11-05 | 后端 | **回复前端 11-04 的五条需求**（后端全部处理完，前端可直接对接）：<br>（一）**会话开关改为后端判定。** `GET /api/session` 现在返回 `mode` 字段：访客通道 `{"mode":"guest","expires_at":"…"}`，运维通道 `{"mode":"operator","expires_at":null}`；`POST /api/session` 在运维通道仍返回 404（前端现有探测仍可用），在访客通道仍 201。前端**不必再从状态码猜身份**，读 `mode` 即可；运行时探测方案也保留可用，两种写法都兼容。<br>（二）**访客可以重试报告。** `POST /api/projects/{id}/pipeline/{pipeline_id}/report` 对访客开放（此前 503），每次重试按 **1 个预算单位**计（与一次整理同量级，报告本身不走模型研究）；数据库迁移 `0019_guest_report_admission.sql` 已应用，新增 `REPORT` 准入类型。报告生成中重复点击会复用同一次预约，不会重复扣额度；报告失败后重试会另计 1 个单位（日额度 16 单位/访客/天）。访客仍不能直接 `POST /api/projects/{id}/reports`（那是运维按需生成入口）。<br>（三）**预算口径补字段。** `price_contexts[]` 新增 `budget_kind`：`PLANNED_UNIT_PRICE`（计划单价）或 `PLANNED_TOTAL_BUDGET`（计划总价），无预算时为 `null`。前端据此写“计划单价”或“计划预算”，不要再统一写“计划预算”。<br>（四）**`summary.models[]` 改为按型号名聚合。** 之前按 `product_id + product_model` 分组，同一个型号名挂在两个产品记录下会被算成两个型号（前端实跑里 22 条 `NBN-80052-BA` 被报成 2 个型号）。现在按型号名（不区分大小写）聚合，`models[]` 每项含 `product_model`、`product_id`、`product_ids[]`、`candidate_rows`、`supplier_count`；`distinct_models` 是买家看得见的型号名个数；“这次只找到一个型号”的覆盖提示也按同一口径触发。**前端可以直接用 `distinct_models`**，不必自己数型号名。<br>（五）**复现到的 `PIPELINE_STAGE_FAILED` 已定位并修复。** 后端用 D1 快照、阶段记录和 run 事件逐条对上了前端报告的两次失败：失败原因不是模型，而是**容器在研究中途崩溃**（`Container port connection closed unexpectedly`）。两个连带缺陷已修：（1）容器回写 run 事件时会把已经 FAILED 的 run 改回 RUNNING，导致流水线在 RESEARCHING 空等 60 分钟；现在终态不会被复活，失败会立即收口。（2）流水线等待研究的窗口从 60 分钟收紧到约 23 分钟，与研究步骤本身的 20 分钟超时对齐。另：研究步骤的容器崩溃重试从 0 次改为 1 次（容器重启会丢失已做的研究，但单次容器重启不该毁掉一次访问）。**失败的阶段现在保留原因码**：`stages[].error_code` 会是 `MODEL_TIMEOUT` / `MODEL_RATE_LIMIT` / `DECISION_FAILED` / `STAGE_SERVICE_ERROR` / `RESEARCH_FAILED` / `SNAPSHOT_MISSING` 等已知码之一（任务顶层仍是 `error: "PIPELINE_STAGE_FAILED"`），前端可以按码给一句中文说明。
| 2026-11-02 | 前端 | 集成检查表（未验收；勾选只在真实测试之后）： |

| 项 | 状态 | 负责人 | 前端对接 | 验收 |
| --- | --- | --- | --- | --- |
| 访客 Session 与隔离 | ☑ | 后端 | 前端已接入：页面打开时读 `GET /api/session` 的 `mode`，访客没有会话时才 `POST` 一次；未就绪显示“正在建立会话。”；会话失效自动重建并重试一次 | 2026-11-04 与 11-05 真实浏览器（公开地址）：打开页面无 401、无错误框；另一个访客会话读同一项目与同一分析均 404，项目列表为空（A/B 互不可见） |
| 一次点击 Pipeline | ☑ | 后端 | 前端已接入：一次点击 `POST .../pipeline`，轮询状态并显示阶段 | 2026-11-04 真实浏览器：访客建项目→填需求→点“开始分析”，无 401，进度依次为“正在整理需求→正在寻找供应商→正在核对技术与价格→正在整理采购建议→正在生成报告→已完成”，一次启动自动跑完 M2–M3 并生成 DOCX |
| 统一 Analysis API | ☑ | 后端 | 前端已接入：只读 `GET .../analysis?run_id=…`，按“需求 × 型号”展示 | 2026-11-04 真实浏览器：结果表、判定分布、型号分组、`display` 中文摘要、价格口径均来自该接口；页面刷新后仍是同一冻结版本（`decision_version` 不变） |
| DOCX 自动生成 | ☑ | 后端 | 前端已接入：按钮跟随冻结版本的 `report` 状态（阻塞/生成中/可下载/失败） | 2026-11-04 真实浏览器：点“下载这一版”得到 45,483 字节 DOCX，文件名带项目名与运行时间；不需要访客再点一次生成 |
| 公开完整流程 | ☑ | 双方 | 前端已接入并已部署到公开地址 | 2026-11-05 在 `https://procurement-sourcing-agent.com` 用真实浏览器跑通：访客会话 → 建项目 → 填需求 → 一次点击 → 进度依次为 正在整理需求/正在寻找供应商/正在核对技术与价格/正在整理采购建议/正在生成报告 → 结果表与中文摘要 → 下载 43,913 字节 DOCX → 刷新后仍是同一冻结版本。期间验过快照晚到时页面自己重试、任务失败时显示阶段原因且不出结果。**但那次跑通的 17 条判定全是「还不能判断」**，所以公开链路成立不等于寻源质量成立（见 §7.7 更正一：决定结论的是研究引了哪一行，不是文字还是 PPTX） |

## 7.5 后端给前端的三条更正与提醒（2026-11-05）

1. **“线上 bundle 不是从本仓库构建的”这个判断不成立。** 线上页面确实由本仓库的 `frontend/` 构建（Cloudflare Builds 的构建命令 `npm --prefix frontend ci && VITE_GUEST_SESSION=1 npm --prefix frontend run build && npx wrangler deploy` 配置在 Cloudflare 账号里，不在仓库中）。线上 bundle 里找不到 `/analysis`、找不到 `coverage_warnings`，是因为**合并 PR #5 之前的仓库前端本来就没有消费这些字段**；`VITE_GUEST_SESSION` 在构建时被内联成 `"1"`，所以源码里的 `!== "0"` 判断在压缩后不会出现字符串字面量——这是 Vite 的正常行为，不代表构建用了别的源码。PR #5 合并后线上 bundle 已包含 `/analysis`（已实测确认）。前端的运行时探测方案本身更好，保留即可，不必再怀疑构建链路。
2. **默认研究预算已调整。** 之前默认 `4/4/2/1/12` 在“像素 + IP67 + PoE + 质保 + 单价”这种多约束需求上会让研究阶段预算用尽，结果是一屏 `UNKNOWN`（前端实跑的那类需求正是如此）。现在默认 `5/6/2/1/15`（搜索/取页/任务/轮次/模型调用），并在 `/analysis.summary.coverage_warnings` 里明确提示“这次研究用完了预算，部分约束没有取到来源快照，结论多为证据不足”。前端如需快速预览，仍可显式传 `research_budget`（如 `3/3/1/1/8`），并在界面上标注“快速预览”。
3. **失败时请把 `stages[].error_code` 一起显示。** 顶层 `error` 永远是通用的 `PIPELINE_STAGE_FAILED`，阶段里的 `error_code` 才是具体原因（见 §7 第五条第（五）项的码表）。前端按码给一句中文即可，不要显示原始英文。

## 7.6 关于"同一需求有时 PASS、有时 UNKNOWN"（2026-11-05，后端结论）

前端 11-04 报的两次 `PIPELINE_STAGE_FAILED` 已定位并修复（容器中途崩溃 + 终态被回写事件复活 + 失败后要等 60 分钟），详见 §7 第五条第（五）项。除此之外，后端在 11-05 又定位到两个**结果不稳定**的来源，性质不同，需要分开看：

1. **需求整理偶尔丢掉约束（已修）。** 同一句"输出分辨率不低于5MP"，11-03 整理出 `output_resolution ≥ 5 MP (HARD)`，11-05 有一次整理出**零条约束**——分析层于是只能报 `NO_HARD_CONSTRAINT`，全屏 UNKNOWN。现在编译器在"原文写了可测量内容、但结果一条约束都没有"时会再试一次（不编造字段），最终仍为空则把缺口原样交给买家。已实网复验：约束回来了。
2. **对齐结果随研究到的页面波动（未修，属于研究覆盖质量）。** 约束键是 `output_resolution`；当研究取到明确写"video output resolution 5MP"的页面时，判定是 `VERIFIED_COMPARISON` → PASS（11-03 的官方案例 22 PASS 即此）；当研究只取到写"5 megapixel (3K)"、未说明是输出像素还是传感器像素的页面时，模型**明确拒绝**配对（提示词里写明"sensor effective pixels 与 video output pixels 不是同一测量"），代码按规则保留 `UNKNOWN`（`ATTRIBUTE_NOT_ALIGNED`）。这不是可以靠代码"改对"的：让代码把传感器像素当输出像素，正是被禁止的静默改写。
   - 后端已做的合规收敛：把**人工审校别名表**用于打字层，使同一测量只写一个键（`video_output_resolution`、`resolution` 等统一写成 `output_resolution`），并把别名表纳入打字层的版本指纹，避免旧缓存继续生效。
   - 仍未解决的是**来源覆盖**：要让"输出分辨率"判定为 PASS，研究必须取到写明输出分辨率的规格页。这属于 M2 研究质量问题（与"型号多样性"同一批），不在 B4 前端路径上。
   - 前端展示建议：把 `coverage_warnings` 与 `decisions[].display` 原样呈现（"证据不足：规格未对齐"），不要把 UNKNOWN 渲染成"不合格"——它表示"来源还没取到能支撑结论的证据"。
3. **给演示的建议**：候选的证据若明确写的是输出分辨率，判定会稳定为 PASS；反之会稳定为 UNKNOWN 并诚实说明缺口。演示时用有官方规格页的型号，结论更完整。

## 7.7 给前端 agent 的协调说明（2026-11-05，后端 ↔ 前端）

前端已完成 A1/A2/A3 与公开地址验收，五项检查表全部勾上，后端确认这一轮前端工作**全部达标**。下面是后端给出的三条认知更正和一份分工，请按此执行，避免演示当天踩坑。

### 更正一：「文字需求必然全 UNKNOWN，演示必须用 PPTX」这个结论不成立

后端用 D1 里的历史运行逐条核对过：**2026-11-03 17:50 那次 22 PASS / 22 SHORTLIST + 1 UNKNOWN 的运行，用的就是文字需求**（`source_type=USER_TEXT`，文本为"采购5MP工业网络摄像机，数量10套，预计单价100元/套，输出分辨率不低于5MP。"），约束同样是 `output_resolution ≥ 5 MP (HARD)`。也就是说：

- 文字需求**可以**产出 PASS，PPTX 不是必要条件；
- 决定结论的是**这次研究取到了什么页面**——取到写明"输出分辨率/Video output resolution"的规格页就是 PASS，只取到宣传页、型号名里带 5MP 的页面，模型按规则拒绝配对（"传感器像素与输出像素不是同一测量"），就是 UNKNOWN；
- 因此"必须用 PPTX"其实是在赌一次研究运气：换成 PPTX，同样可能落在 UNKNOWN。

**演示建议**：PPTX（官方案例）仍然是最稳的素材 ✅，但理由是"官方素材自带完整上下文与证据链"，不是"文字一定不行"。可以两种都准备，**以实测结果为准**：跑出 ≥1 条 PASS/SHORTLIST 的那次就是演示素材。

### 更正二：快速预览预算会让 UNKNOWN 变多，不是变少

`research_budget`（如 `3/3/1/1/8`）调小的是搜索/取页/轮次，证据本来就少，判定自然更容易落回 UNKNOWN。**演示必须用默认预算**（现在是 `5/6/2/1/15`，一次完整分析实网约 9–12 分钟）。如果前端要做"快速预览"按钮，界面必须写明"快速预览：证据可能不完整，结论多为待核实"，不能让评委拿它当正式结论。

### 更正三：`/analysis` 的 409 是正确行为，前端的重试策略保留

你抓到并修好的那个 409（运行行已终态、冻结快照还没写好）是后端的设计：快照没写出来之前不允许读分析，避免读到半份结果。继续每 5 秒重试 ✅，不要改成"读 latest"。

### 分工（2026-11-05 → 11-11）

**前端 agent（本周）**
1. 准备演示素材：官方 PPTX 一份 + 文字需求一份，各跑一次，**留下 PASS 结果那次**的截图与 DOCX（当前 `C:\opt\cursor\artifacts\screenshots\m4-public\` 里的是全 UNKNOWN 那次 ✅，需要换 ✅）。
2. 三分钟演示视频：会话 → 建项目 → 需求 → 一次点击 → 进度 → 型号/来源/证据 → 中文 display → 价格口径 → 下载 DOCX → 刷新仍是同一版本。
3. 数据合规说明（哪些是公开来源、模拟历史与真实供应来源如何隔离）。
4. 后端下一次部署后，在公开地址重跑一遍全流程并更新 §6 检查表的验收时间。
5. 可选：快速预览按钮（按更正二的措辞）。

**后端 agent（本周）**
1. 已做：把研究者优先导向厂商**规格页**（datasheet/技术参数页），避免把宣传页和型号名里的 5MP 当测量（已部署 `397c6d7`），正在用 3 次同需求连跑量化 PASS 率。
2. 跟进：若 PASS 率仍低，下一步是让研究对**头部型号**保证一次规格页取页（而不是靠运气），并同时改善型号多样性（目前主要集中在一个型号）。
3. 稳定性：容器已升 standard-4、阶段调用前等就绪、崩溃重试一次、终态不再被复活；继续观察偶发 OOM。
4. 任何新契约需求继续写在本文件 §6/§7，后端在同一 session 答复。

**共同验收口径（演示就绪）**：一次公开链接的完整运行里，能看到 ≥1 个具体型号、≥1 条 PASS/SHORTLIST 判定、每条判定可点开来源证据、价格口径写明是计划单价还是计划预算、报告 DOCX 可下载并与页面同版本。达不到就按上面分工继续修，不要在演示当天临时改口径。

## 7.8 演示域名已切换（2026-11-06）

- **正式演示地址**：`https://procurement-sourcing-agent.com`（备用：`https://demo.procurement-sourcing-agent.com`）。旧的 `*.workers.dev` 地址**在部分网络会被 DNS 投毒**（实测解析到无关地址、连接被重置），因此不再作为对外链接；它仍保留在访客 Origin 白名单里，便于内部排查。
- 页面与 API 仍然**同源**（前端不需要任何改动 ✓）；会话 Cookie `__Host-ps_session` 是主机级 Cookie，自动适配新域名 ✓。
- Cloudflare 已为两个域名托管 DNS 并签发证书 ✓；后端的 `PUBLIC_BASE_URL` 已切到新域名 ✓，因此 **Cron 自测本身就是新域名上的端到端验收** ✓✓（每 9 分钟从 Cloudflare 内部通过新域名跑一次完整流水线 ✓）。
- **前端 agent 请做的三件事**：① 用手机热点（不走公司网络）打开 `https://procurement-sourcing-agent.com` 确认评委可达 ✓；② 用新域名重跑一次公开全流程并更新 §6 检查表的验收时间 ✓；③ 录一份三分钟演示视频作为兜底 ✓（评委网络不可控时，视频能保证演示不中断 ✓）。

## 7.9 给前端 agent 的录制指令（2026-11-06 晚，交付冲刺）

**交付物只有三样**：录屏视频、评委可点击的链接、技术说明文档。
链接已完成：**https://procurement-sourcing-agent.com**（手机热点实测可达 ✓）；技术说明文档已写好：
`docs/technical_documentation.md` ✓。**剩下的核心交付物是录屏视频**。

### 录制素材：直接用这条已冻结的好运行

| 项 | 值 |
| --- | --- |
| 项目 | `6b2573dd-bd03-4e8c-baea-5c628164d069` |
| 运行（Pipeline） | `768899d7-e236-46ca-8b53-aa058c11a6e3` |
| 判定 | **22 PASS / 1 UNKNOWN**（`VERIFIED_COMPARISON` × 22，`MODEL_VARIANT_UNCERTAIN` × 1） |
| 报告 | `pr_768899d7-e236-46ca-8b53-aa058c11a6e3`，43,996 字节，`decision_version = 20e950c7260891fd0664f71e597064985554d73360ecc6f1df118848f19a4acc` |
| 需求 | 采购5MP工业网络摄像机，数量10套，预计单价100元/套，输出分辨率不低于5MP。 |

这条运行是**运维通道**创建的，因此**访客会话看不到它** ✓。录制结果页时请用**本地开发代理**（带运维 Bearer ✓，
即 `frontend/.env.local` 里的 `DEMO_ACCESS_TOKEN` ✓）打开该运行 ✓✓；录制"访客首次访问"的流程段时再切到
**公网访客路径**（`https://procurement-sourcing-agent.com` ✓）✓。

### 视频要覆盖的 8 个画面（约 3 分钟）

1. 打开公网链接 → 页面自动建立访客会话（不出现登录框 ✓）。
2. 新建项目 → 粘贴需求文字（或上传 PPTX ✓）。
3. 点"开始分析" → 进度依次显示：整理需求 → 寻找供应商 → 核对技术与价格 → 整理采购建议 → 生成报告 ✓。
4. 结果页：型号聚合表、**22 条 PASS 的判定与中文摘要**、价格口径（计划单价 ✓）、可点开的来源证据 ✓。
5. 摘要区：型号数 / 供应来源数 / 证据数 / 判定分布 / 覆盖提示 ✓。
6. 展示**一条 UNKNOWN 的判定**，并念出它的中文理由（"证据不足…"✓）——说明系统不编结论 ✓✓。
7. 点"下载这一版" → 打开 DOCX，指出里面的 Run 与决策版本 ✓。
8. 刷新页面 / 切换到另一次运行 → 仍是各自冻结的版本 ✓。

### 录屏注意

- 一次完整分析要 10–15 分钟（模型网关拥塞 ✓），**先跑起来再开始录** ✓✓；或直接用上面那条已完成的运行录结果段 ✓✓。
- 请在视频里明确说出：**判定是 UNKNOWN 表示"来源证据还不足以支撑结论"，不等于"不合格"** ✓✓。
- 视频请包含网址 `https://procurement-sourcing-agent.com` 的画面 ✓（评委要能自己点开 ✓）。

### 之后由后端继续做

Cron 自测每 9 分钟跑一次访客全链路（通过正式域名 ✓），持续产出可用于演示的访客可见运行 ✓；
一旦出现 PASS 比例更高的一次，我会把项目/运行 ID 写进本节 ✓。
