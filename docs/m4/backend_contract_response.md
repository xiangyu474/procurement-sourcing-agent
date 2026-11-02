# M4 后端契约答复与对齐

回应 `docs/m4/backend_contract_requests.md`（基线 `f0fa49b`）。本文只写**后端现在真实提供什么**、**还缺什么**、**谁来做、用什么数据结构**。
前端可以**直接在本文件下方「对齐回执」一节回复**，后端会按回执改，不另开文档。

- 后端仓库：`procurement_sourcing_agent`（本仓库）
- 后端最新提交：见 `git log -1`
- 网关：`https://procurement-sourcing-gateway.xiangyu474.workers.dev`
- 容器镜像版本：`wrangler.jsonc` 的 `CONTAINER_INSTANCE_NAME`（当前 `sourcing-v10`）

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

**`UNKNOWN` 永远不会进入建议询价**：实测 43 条决策中，22 条 `SHORTLIST/VERIFIED_PASS`、21 条 `INVESTIGATE/UNVERIFIED`、0 条把 UNKNOWN 写进短名单。

### 0.2 候选的 `stage` 现在会随决策推进

M2 只会产出 `DISCOVERED_LONG_LIST`。M3-C 的决策被接受后，候选的阶段会推进：

| 决策 | 新的 stage |
| --- | --- |
| `SHORTLIST` + `VERIFIED_PASS` | `RFQ_SHORTLIST` |
| `INVESTIGATE` | `NEEDS_VERIFICATION` |
| `EXCLUDE` | `EXCLUDED` |

未被闸门接受的决策**不改变**候选阶段。所以前端可以直接用 `GET /api/projects/{id}/candidates?stage=RFQ_SHORTLIST` 取询价短名单。

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
{ "run_id": "uuid" }          // 可选；给了就固定为这次运行的决策集合
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
  "decision_version": "3f2a9c1b7d0e4a55",
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

**报告与「运行」的绑定**：`decision_version` 是本次决策集合内容的摘要（`sha256` 前 16 位）。同一个 `report_id` 永远对应同一份文档，之后再跑新的寻源不会改变它。

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

### 3.7 鉴权方案 —— 后端给方案，前端按方案做（两端共同确认）

- **开发/联调**：前端 Vite 代理进程读环境变量 `DEMO_ACCESS_TOKEN`，把 `Authorization: Bearer` 加在**出站请求**上。token 不进浏览器包、不进前端源码、不提交仓库（`.env.local` 需在 `frontend/.gitignore` 中）。
- **生产**：页面与 API **同源**（前端构建产物由同一个 Worker 托管，走相对路径 `/api`，不需要 CORS）。凭证校验留在 Worker：
  - 首选 Cloudflare Access（身份层在网关之前，浏览器拿不到 `DEMO_ACCESS_TOKEN`）；
  - 备选 Worker 签发 HttpOnly 会话 Cookie。
- **红线**：`DEMO_ACCESS_TOKEN` 不出现在浏览器包、浏览器可见响应、公开生产配置、任何 Git 提交里。
- 负责人：**后端**负责 Worker 侧（同源托管 + 校验），**前端**负责不落 token；**待前端确认**：是否接受 Cloudflare Access 作为生产身份层。

---

## 4. 不做与不承诺的（避免前端误用）

- 不新增第二套 DTO：所有结构化结果都来自上表的既有字段；前端不要在前端重算技术判定、价格口径或推荐档位。
- 不把「候选被发现」等同于「建议询价」。
- 不把 `UNKNOWN` 显示成通过或失败，用原文 `UNKNOWN`（前端可显示「未知（证据不足）」）。
- 不展示 `metrics` 里的 token/搜索次数。
- 不承诺跨浏览器自动发现历史项目，直到 §3.3/§3.4 上线。

---

## 5. 对齐回执（请前端 agent 在这里回复）

> 后端会按这里的回复改代码并更新本节。请写清楚：同意/不同意、需要后端补的字段、期望的字段名、前端已实现的适配。

| 日期 | 方 | 内容 |
| --- | --- | --- |
| 2026-10-31 | 后端 | 首次答复：§1 接口清单以真实响应为准；§2 正式报告接口已实现；§3 为待补项与负责人；§3.7 为鉴权方案，请确认是否接受 Cloudflare Access。 |
| 2026-11-01 | 后端 | §3.1–§3.5 已实现并部署（项目列表、项目运行列表、需求正文回读、整理/核对/决策的任务状态）。新增响应字段：`POST .../requirement-compile` 返回 `compile_id`（作业 id）与 `workflow_id`；`POST .../spec-assessments` 与 `POST .../decisions` 返回 `job_id`。§3.6（项目级修订）本轮未做，原因见该节。 |
| 2026-11-01 | 后端 | **答复前端来信**：① `assessment_id`/`decision_id` 是 workflow 实例 id（保留兼容，不改语义），`job_id`/`compile_id` 是作业 id；**查状态一律用状态接口**，详见 §3.5.1。② F2 需要 `history_scope`，此前没有公开接口能拿到——已新增 `GET /api/projects/{id}/price-context`（§2.3），与正式报告的价格章节同源。③ F1/F2/F3/F4 的工作拆分与后端现状一致：F1 用新接口、F2 用候选+核对+决策+价格口径、F3 接报告生成/状态/下载并显示决策版本、F4 做成分步引导。④ 生产鉴权仍待确认：推荐同源托管 + Cloudflare Access（§3.7）。 |
|  |  |  |
