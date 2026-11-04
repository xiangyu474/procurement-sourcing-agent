# M4 前端交接说明（给新的前端 agent）

> 这份文件是交接材料。接口事实以 `docs/m4/backend_contract_response.md` 为准（尤其 §5.1–§5.4 和 §6 回执表）；本文件只讲“现在的状态、你要做什么、什么不能做”。
>
> **前端已经做完的部分**：访客会话接入、`/analysis` 的结果展示、刷新后找回任务，都已实现并用真实网关验过。实现细节见 `docs/m4/frontend_implementation.md`（前端从哪个接口取哪块数据、页面上每个结论从哪来、哪些已经在真实网关上验过）。

## 0. 你在做什么

一个采购寻源系统的**前端**。评委打开网页 → 填采购需求 → 系统自动寻源、核验技术指标、给出采购建议 → 下载正式 DOCX 报告。后端（Cloudflare Worker + Python 容器 + D1/R2 + Workflows）已全部上线并通过实网验收；**你接手的是最后一段：让真实浏览器把这条链路跑通并展示对**。

截止日 **2026-11-11**，今天 2026-11-04。

## 1. 仓库与运行方式

- 仓库：`C:\Users\ZZ0DVN672\Desktop\projects\moi\procurement_sourcing_agent`
- 前端目录：`frontend/`（React 19 + Vite 6 + TypeScript）。后端在 `cloudflare/gateway/`（Worker/TypeScript）、`src/procurement_agent/`（Python）、`wrangler.jsonc`（部署配置）。
- **只改 `frontend/`** 和 `docs/m4/` 里的前端说明；`cloudflare/gateway/`、`src/procurement_agent/`、`wrangler.jsonc`、根 `package.json` 是后端共享文件，**不要改**（需要后端改动时在 `docs/m4/backend_contract_response.md` §6 回执表写需求，后端会实现并发布契约）。
- 分支：从 `main` 切自己的分支（例如 `feat/m4-frontend-…`），提交 PR 到 `main`。**合并到 `main` 后约 5 分钟自动部署**（Cloudflare Builds 会构建前端并部署到同一个 Worker），所以合并即上线。
- 本地命令（在 `frontend/`）：
  ```bash
  npm ci
  npm run typecheck
  npm test                 # vitest 单测
  npx playwright install chromium   # 首次需要，装浏览器
  npm run e2e              # playwright（当前是 fixture 假数据）
  npm run dev              # 开发服务器，/api 走 vite 代理
  npm run build            # 生产构建
  ```
- **公开演示地址已上线**：`https://procurement-sourcing-gateway.xiangyu474.workers.dev`（页面与 API 同源，后端就是它）。合并后刷新这个地址即可看到你的改动。

## 2. 后端现在的真实状态（都已实网验收）

| 能力 | 接口 | 说明 |
| --- | --- | --- |
| 访客会话 | `POST /api/session`、`GET /api/session` | 生产已启用。Cookie `__Host-ps_session`，HttpOnly/Secure/SameSite=Lax，24 小时有效。**浏览器不需要任何凭证**。 |
| 项目列表/详情 | `GET /api/projects?limit=50`、`GET /api/projects/{id}` | 按访客隔离：访客只能看到自己的项目。 |
| 需求文字 | `POST /api/projects/{id}/requirement-text` | 提交/更新需求文字。 |
| 需求整理 | `POST /api/projects/{id}/requirement-compile` → `GET /api/projects/{id}/requirement-compile/{compile_id}` | 整理结果 `COMPLETED/FAILED`；`compile_id` 是作业 id。 |
| 历史文件 | `POST /api/projects/{id}/upload-sessions`（purpose=HISTORY）、`POST /api/projects/{id}/history-imports` | 表头不合格现在返回 **422** `history_file_rejected` + 中文 `detail`（不再有异常类名）。 |
| **一次点击分析** | `POST /api/projects/{id}/pipeline`（头 `Idempotency-Key`，体 `{demand_revision, research_budget?}`）→ 202 `{pipeline_id, run_id, demand_revision, status, reused}` | 同一幂等键复用同一任务；`idempotency_conflict` 409、`demand_revision_changed` 409、`no_recognizable_demand` 422、`budget_exhausted` 429。 |
| 进度轮询 | `GET /api/projects/{id}/pipeline/{pipeline_id}` | 见下方字段表。 |
| 刷新后找回任务 | `GET /api/projects/{id}/pipelines?active=true&limit=20` | 返回 `{project_id, pipelines[], has_more}`，`active=true` 包含分析中或报告生成中的任务。**用它代替 sessionStorage 记忆**。 |
| **统一分析结果** | `GET /api/projects/{id}/analysis?pipeline_id=…` 或 `?run_id=…`（二选一） | 见下方字段表。**这是 F2 的唯一数据源**。 |
| 自动报告 | 决策完成后自动生成；`GET /api/projects/{id}/reports/{report_id}`、`GET …/download`；失败重试 `POST /api/projects/{id}/pipeline/{pipeline_id}/report` | 状态 `NOT_STARTED/QUEUED/RUNNING/COMPLETED/FAILED`。 |

### 进度接口字段

`GET /api/projects/{id}/pipeline/{pipeline_id}` →
`pipeline_id, project_id, run_id, demand_revision, status, stage, error, decision_version, report_id, report_status, report_error_code, candidates_found, models_found, evidence_found, download_path, stages[{stage,status,started_at,finished_at,error_code}], created_at, updated_at`

- `status`：`QUEUED / RUNNING / COMPLETED / PARTIAL / FAILED`
- `stage`（顶层当前阶段）：`RESEARCHING / EVALUATING / DECIDING / COMPLETED / PARTIAL / FAILED`
- `stages[].stage`：`RESEARCH / EVALUATING / DECIDING`（**与顶层不是同一个枚举**，别混用）
- `candidates_found / models_found / evidence_found` 在核验开始前就已写入，可以用来做等待期的进度文案。

### 分析接口字段

`GET /api/projects/{id}/analysis?pipeline_id=…` →
`project_id, pipeline_id, run_id, demand_revision, research_status, requirements[], candidates[], assessments[], decisions[], price_contexts[], evidence[], summary{}, report{}`

- `summary` = `{requirements, candidate_rows, distinct_models, distinct_suppliers, models[{product_model, product_id, candidate_rows, supplier_count}], assessments, by_verdict, decisions, by_recommendation, evidence, coverage_warnings[]}`
  - **按型号展示**，不要把同一型号的多个供应商平铺。`models[]` 已给出每个型号的供应商数。
  - `coverage_warnings[]` 是后端给的中文提示（如“只找到一个型号”“没有候选通过硬性核验”），直接展示。
- `decisions[]` 里每条有 `display{}`：
  `display = {version, basis:"STRUCTURED_ASSESSMENT_NOT_TRANSLATION", summary_code, summary_zh, gaps[{code,constraint_id,importance,evidence_ids,text_zh}], next_actions[{code,constraint_id,text_zh}], unresolved_question_ids[], untranslated_originals{rationale,gap_count,next_action_count}}`
  - `summary_code` ∈ `RECOMMENDED_INQUIRY_VERIFIED / EVIDENCE_INSUFFICIENT / HARD_REQUIREMENT_FAILED / FURTHER_INVESTIGATION / GATE_REJECTED / ASSESSMENT_UNAVAILABLE / REVIEW_REQUIRED`
  - 原始 `rationale / gaps / next_actions` 是**英文自由文本**，后端没有逐条翻译。展示 `display.*`，并按 `untranslated_originals` 提示“还有原始信息待核对”。**不要自己翻译或猜测原文含义。**
- `price_contexts[]`（按 `requirement_id` 关联需求）：`history_scope` = `ITEM / TABLE_OVERVIEW / NONE`，`overview_is_not_a_baseline` 为 true 时界面**不得出现**“历史价”“节支”。`findings[]` 是各口径的结论，**不要自己算价或算节支**。
- `candidates[].stage` 是 M2 的发现阶段（`DISCOVERED_LONG_LIST` 等），**不是**是否进入 RFQ 的状态。

## 3. 你要做的（按优先级）

### A1（最高优先，先做这个）：把访客会话接进应用

`frontend/src/session/useGuestSession.ts` 已经写好，但 **`App.tsx` 没有使用它**。后果：访客第一次点“开始分析”会拿到 401。

- 生产构建已带 `VITE_GUEST_SESSION=1`（后端在部署命令里设置），所以线上只要 App 用了这个钩子即可。
- 本地开发要测访客路径：删掉 `frontend/.env.local` 里的 `DEMO_ACCESS_TOKEN`（那是后端运维凭证，仅供后端脚本；前端带上它会变成“运维身份”，看不到真实访客行为）。
- 会话失败的处理：`adapter.ts` 已有中文映射（`session_required`/`session_expired`→“会话已失效，请刷新页面。”、`origin_mismatch`→“页面来源不对，请从本站重新打开。”、`rate_limited`、`budget_exhausted`、`not_found`→“找不到这个项目或已无权访问。”）。建议：收到 `session_required/session_expired` 时**自动重新创建一次会话并重试该请求**（只重试一次，避免循环）。
- `useGuestSession` 目前返回 `{ready, error}`，`ready=false` 时应显示加载态而不是报错。

### A2：把 F2 改成消费 `/analysis`

现在前端读的是旧的项目级 `/spec-assessments`、`/decisions`，而 **Pipeline 的结果只存在于 `/analysis`**（旧接口对 Pipeline 项目是 0 行）。

- 读 `summary`（型号分组、判定分布、覆盖提示）、`decisions[].display`（中文摘要）、`price_contexts[]`（口径）、`report{}`（报告状态）。
- 用 `candidate_id` / `product_candidate_id` / `requirement_id` 做关联，**不要用名称或数组下标**。
- “建议询价”的判定必须满足：`accepted === true && recommendation === "SHORTLIST" && technical_verdict === "VERIFIED_PASS" && hard_spec_overall === "PASS"`。
- 切换到更早的 Run 时，用 `?run_id=` 取那次运行的冻结结果，**不要混用最新**（这是后端特意做的版本冻结）。

### A3：刷新后恢复任务

用 `GET /api/projects/{id}/pipelines?active=true` 找进行中的任务（当前前端把 `pipeline_id` 放在 sessionStorage，只是界面状态，刷新/换标签页就丢）。

### A4：报告三态

已有 `view/report.ts` 的 `reportPhase`/`reportButtonLabel`：决策未完成→不可下载；报告生成中→“正在生成报告”；有报告→“下载这一版”；失败→简短提示 + 可重新生成（`POST /api/projects/{id}/pipeline/{pipeline_id}/report`）。请核对它与后端 `report_status` 的对应关系。

### A5：真实浏览器端到端

在真实网关上跑一遍并留存截图/录屏：建项目 → 填需求 → 整理 → 点“开始分析” → 进度文案 → 结果展示 → 下载 DOCX → 刷新页面恢复 → 切换旧 Run 不混数据。
`frontend/e2e/` 目前的用例是 **fixture 假数据**（`frontend/e2e/fixture.ts`），**不能作为验收证据**；可以另加一组针对真实网关的用例（需要 `VITE_GUEST_SESSION=1`），或至少手工跑通并记录。

### A6：更新集成检查表

`docs/m4/backend_contract_response.md` §6 末尾有五项检查表，**只勾你已经用真实浏览器验证过的项**，并注明验证方式。

## 4. 硬规则

1. **不要在前端重算**技术判定、价格口径、节支、建议档位——后端已给结构化结论，前端只做展示。
2. **不要展示内部字段**：`r2_key`、`normalized_r2_key`、内部 locator、`SUPERVISOR:` 之类阶段名、token 数。后端在访客模式下已隐藏大部分；前端也不要把它们显示出来。
3. **不泄露凭证**：浏览器包里不能有 Bearer 凭证；生产构建不带 `DEMO_ACCESS_TOKEN`。运维凭证已被轮换，只存在于后端本地文件和 Worker 密钥里。
4. **保持现在的极简工作区**：不加营销文案、不加说明性段落、不加嵌套卡片或装饰性看板、不重设计页面。错误用一句中文。
5. **共享文件不要改**（网关、Python、wrangler、根 package.json）。需要后端改动就在 §6 回执表写清楚：现象、期望的字段名、要补什么。
6. **区分事实与推断**：夹具测试 ≠ 生产验收；`LOCAL_IMPLEMENTED` ≠ `CLOUD_VERIFIED` ≠ `PUBLIC_READY`。汇报时写清哪一档。

## 5. 和后端怎么协作

- 唯一对齐通道：`docs/m4/backend_contract_response.md`（§5 契约、§6 回执表）。后端 agent 在另一个 pi session，**不会自动看到你的改动**，所以把你的需求写进 §6 回执表，并在汇报里点名。
- 后端会按 §6 回执逐条答复并发布新契约；契约发布后前端再接入，接完在 §6 标注“已接入”。
- 后端可用：`docs/m4/backend_delivery_status.md`（当前状态与已知边界）、`docs/TODO.md` 第八节（交付盘点表）。

## 6. 现在就能验证的东西（已实网跑通，可作为你的对照基线）

- 一次访客完整链路：建项目 → 提交需求 → 整理 → 一次点击分析 → 读取冻结分析 → 下载 DOCX（44 KB，含 Run 与决策版本）；同一幂等键重复启动复用同一任务；两个访客互不可见（项目/运行/分析/报告/下载全部 404）。
- 该次结果：22 条 `PASS`/`SHORTLIST` + 1 条 `UNKNOWN`/`INVESTIGATE`，29 份证据，3 个型号 / 23 个供应来源。
- 耗时：一次完整分析约 8–12 分钟（研究占大头）。前端可给“快速预览”：`POST …/pipeline` 带 `research_budget`（如 `{"max_search_calls":3,"max_fetches":3,"max_tasks":1,"max_rounds":1,"max_model_calls":8}`）。

## 7. 第一天建议动作

1. 读 `docs/m4/backend_contract_response.md` 的 §5.1–§5.4（会话、Pipeline、Analysis、报告）和 §6 最后几行（后端最近的答复）。
2. 跑 `npm ci && npm run typecheck && npm test` 确认基线绿。
3. 做 A1（会话接入 `App.tsx`），本地用真实网关跑一遍“建项目→开始分析”。
4. 做 A2（消费 `/analysis` + 型号分组 + `display` 中文摘要）。
5. 把过程中发现的契约缺口写进 §6 回执表。
