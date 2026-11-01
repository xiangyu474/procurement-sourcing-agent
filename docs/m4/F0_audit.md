# F0 审计：采购寻源前端

审计对象是仓库当前 `main` 的代码与已部署网关，不是计划文档里的设想。集成基线：

- 提交：`f0fa49bc07714132d2b960fad34cb0b86d720ed0`（`chore: bring the faster container image into service`，2026-10-31）
- 需求编译写入 D1 时的 `compiler_version`：`m1-0.1.0`
- 需求 DSL：`compiler_version` 默认 `req-dsl-1.0`，文档中的 `schema_version` 为 `1.0`（`docs/requirement_dsl.md`）
- 网关迁移：`cloudflare/gateway/migrations/0001` 至 `0008`
- 已部署网关：`https://procurement-sourcing-gateway.xiangyu474.workers.dev`（`wrangler.jsonc` 的 `CONTAINER_GATEWAY_URL`）

本次审计对已部署网关做了三次只读探测，没有创建项目：

- `GET /api/health` 返回 200 `{"status":"ok","service":"procurement-sourcing-gateway"}`，无 `Authorization` 也无 CORS 头
- `POST /api/projects` 不带凭证返回 401 `{"error":"unauthorized"}`，响应里没有 `Access-Control-Allow-Origin`
- `OPTIONS /api/projects` 带 `Origin: http://localhost:5173` 同样 401，没有 CORS 预检头

审计时仓库没有前端应用、没有 React/Vite 应用、没有静态页面。

## 1. 目录与可复用部分

```text
src/procurement_agent/
  api/app.py              容器内 FastAPI，只供网关调用
  domain/                 需求、寻源、技术核对、决策的 Pydantic 模型
  ingestion/              文本 / PPTX / XLSX 解析
  services/               需求整理、寻源、技术核对、决策、价格
  reports/                目前只有 M0 部署验证用的 DOCX 草稿
cloudflare/gateway/
  src/index.ts            唯一的公开 HTTP 入口
  migrations/0001–0008    D1
tests/ scripts/ docs/     后端测试、验收脚本、说明
wrangler.jsonc            Worker、容器、D1、R2、Workflow
package.json              只有网关的 TypeScript 依赖
```

浏览器不能调用 `src/procurement_agent/api/app.py`。那些路由以 `/internal/` 开头，由 Worker 持有内部令牌再转给容器。可复用的是网关已经公开的 JSON 形状，以及领域模型里的状态枚举（见第 2 节）。没有可复用的页面、组件或前端构建。

长任务的进度不是 WebSocket，也不是 SSE。客户端发起后立刻拿到 `202`，再轮询 `GET`。需求整理、寻源、技术核对、决策都是 Cloudflare Workflow，单次请求不扛几分钟的模型调用。

## 2. 已有公开 API 与缺口

除 `GET /api/health` 外，所有 `/api/*` 都要 `Authorization: Bearer <DEMO_ACCESS_TOKEN>`。令牌缺失或不匹配时返回 401 `{"error":"unauthorized"}`；Worker 未配置该变量时返回 503 `{"error":"demo_access_not_configured"}`。错误体一般是 `{"error": "<code>"}`，少数带 `detail`。

下面的路径都在 `cloudflare/gateway/src/index.ts` 的 `fetch` 里。容器内部路由不列入可调用清单。

| 方法 | 路径 | 请求 | 成功响应 | 说明 |
| --- | --- | --- | --- | --- |
| GET | `/api/health` | 无 | `{status, service}` | 无需凭证 |
| POST | `/api/projects` | `{title?, requirement_text?}` | 201 `{project_id, source_id, analysis_version}` | 无文字时 `source_id` 为 null，`analysis_version` 为 0。标题缺省为「未命名寻源项目」 |
| GET | `/api/projects/{id}` | 无 | 项目字段加 `sources[]` | `sources` 含 `id, purpose, source_type, revision, filename, media_type, sha256, created_at`。不含正文 |
| POST | `/api/projects/{id}/requirement-text` | `{text}` | 201 `{project_id, source_id, revision}` | 新的文字修订。空文本 422 `requirement_text_required`，超过 10 万字 413 |
| POST | `/api/projects/{id}/upload-sessions` | `multipart`：`purpose` + `file` | 201 `{source_id, purpose, revision, r2_key, sha256}` | `REQUIREMENT` 只收 `.pptx`，`HISTORY` 只收 `.xlsx`。否则 415 `unsupported_file_for_purpose`。大小需在 1 字节到 32MB |
| POST | `/api/projects/{id}/requirement-compile` | 空 | 202 `{project_id, status:"QUEUED", compile_id, analysis_version}` | 异步。没有文字也没有 PPTX 时 422 |
| GET | `/api/projects/{id}/requirements` | 无 | `{analysis_version, compilation}` | 尚未写入时 404 `not_compiled`。`compilation` 是 `DemandIntakeResult`：`requirements`, `unstructured_requirements`, `conflicts`, `issues`, `history_availability` 等。整理失败时网关仍写入一行，形状是 `{project_id, analysis_version, issues:[...]}`，没有 `requirements` |
| POST | `/api/projects/{id}/history-imports` | `{source_id}` | 导入摘要，含 `dataset_id, row_count, column_count, header_row, is_synthetic, duplicate_import, warnings, analysis_version` | 同步调用容器。重复内容返回已有数据集且 `duplicate_import: true`。这是可选步骤，不导入也能寻源 |
| GET | `/api/projects/{id}/sourcing-plan` | 可选 `run_id` | `{plan}` | 无计划时 404 |
| GET | `/api/projects/{id}/candidates` | 可选 `stage`, `run_id` | `{candidates[]}` | 候选含供应商、型号、`stage`、证据摘要。M2 只创建 `DISCOVERED_LONG_LIST` |
| POST | `/api/projects/{id}/spec-assessments` | `{requirement_ids?, candidate_ids?}` | 202 `{project_id, status:"QUEUED", assessment_id, demand_revision}` | 需求未整理时 409 |
| GET | `/api/projects/{id}/spec-assessments` | 无 | `{project_id, assessments[]}` | `hard_spec_overall` 为 `PASS` / `FAIL` / `UNKNOWN`。进行中与失败都可能只是空数组 |
| POST | `/api/projects/{id}/decisions` | `{requirement_ids?}` | 202 `{project_id, status:"QUEUED", decision_id}` | 没有技术核对时 409 `no_spec_assessment` |
| GET | `/api/projects/{id}/decisions` | 无 | `{project_id, decisions[]}` | `recommendation` 为 `SHORTLIST` / `INVESTIGATE` / `EXCLUDE`；`accepted` 表示闸门是否留下。被拒的决策也在 |
| POST | `/api/projects/{id}/runs` | `{mode?, idempotency_key?, duration_seconds?, research_budget?}` | 202 `{run_id, status:"QUEUED", mode, research_budget}`；重复键返回已有 `{run_id, status, reused:true}` | 默认 `mode=SOURCING`。当前需求修订没有整理结果时 422 `demand_not_compiled`。没有采购条目时 422 `no_recognizable_demand` 或 `structured_requirement_required_for_m2` |
| GET | `/api/runs/{id}` | 无 | `{id, project_id, status, current_stage, artifact_key, last_error, created_at, updated_at}` | `status`：`QUEUED` / `RUNNING` / `COMPLETED` / `PARTIAL` / `FAILED`。`PARTIAL` 的原因码不在这行里，`last_error` 只在失败时写入 |
| GET | `/api/runs/{id}/events` | 无 | `{events:[{stage, detail, created_at}]}` | 阶段事件。部分 `detail` 含内部角色名，界面不能原样展示 |
| GET | `/api/runs/{id}/research` | 无 | `{run, plan, tasks, actions, metrics}` | `metrics.stop_reason_code` 是部分完成的原因。同对象还有搜索次数和 token，界面不能展示 |
| GET | `/api/runs/{id}/report/download` | 无 | DOCX 字节 | 仅当该次运行的 `artifact_key` 有值。寻源路径的 research 响应不写这个字段 |
| GET | `/api/evidence/{id}` | 无 | `{evidence}`，含快照正文 | 快照缺失 404 |
| GET | `/api/workspaces/default/suppliers` | `q`, `limit` | `{suppliers}` | 工作区情报，不是本项目结论 |
| GET | `/api/workspaces/default/suppliers/{id}` | 无 | `{supplier, products, evidence}` | 同上 |

运行阶段名来自容器实际上报的事件：`QUEUED`、`INGESTING`、`INTERNAL_ANALYSIS`、`WEB_RESEARCH`、`MATCHING`、`VALIDATING`、`REPORTING`、`PARTIAL`、`FAILED`。寻源正常结束时 `status=COMPLETED` 且 `current_stage=WEB_RESEARCH`，这只表示公开寻源结束，不是技术合格，也不是中选。

候选阶段（`CandidateStage`）：`DISCOVERED_LONG_LIST`、`SCREENED`、`NEEDS_VERIFICATION`、`RFQ_SHORTLIST`、`EXCLUDED`。决策推荐值是另一套：`SHORTLIST`、`INVESTIGATE`、`EXCLUDE`。技术核对是 `PASS` / `FAIL` / `UNKNOWN`。历史数据是 `NOT_PROVIDED` / `IMPORTED` / `IMPORT_FAILED`。价格类型在领域模型里分开：`PLANNED_PRICE`、`HISTORICAL_TRANSACTION`、`PUBLIC_REFERENCE`、`FORMAL_QUOTATION`、`HYPOTHETICAL`。前端不发明新值。

缺失、因而不能假装已经接通的能力：

1. 没有 `GET /api/projects`。服务端项目列表不存在。
2. 没有 `GET /api/projects/{id}/runs`。换一台浏览器打开项目编号时，发现不了已有运行。
3. `GET /api/projects/{id}` 不返回文字需求正文，刷新后不能把原文填回输入框。
4. `compile_id` 没有查询接口。进行中只能看到 `GET requirements` 的 404；失败被写进 compilation 文档，没有独立的 `QUEUED/RUNNING/FAILED`。
5. 技术核对与决策的 Workflow 失败不写公开状态。`GET` 为空无法区分「还在跑」和「失败了」。
6. 寻源运行不生成正式 DOCX。`reports/__init__.py` 只有 M0 草稿，且只由 `/internal/execute`（`mode=SPIKE`）上传。下载接口因此对正常寻源运行会 404 `artifact_not_ready`。
7. 没有「一句话修订需求并重评受影响候选」的单一接口。现有能力是再提交一段文字、重新整理、再启动一次寻源，三次调用彼此独立。
8. 没有 CORS，Worker 也不托管前端静态文件。浏览器不能直接请求 `workers.dev`。

`BLOCKED_BY_BACKEND` 的最小契约见 `docs/m4/backend_contract_requests.md`。

## 3. 前端框架

仓库里没有 React 或 Vite 应用。网关是 Cloudflare Worker 上的 TypeScript，用 `tsc` 做类型检查，不打包页面。

F1 使用 Vite + React + TypeScript，放在独立的 `frontend/`，不改根目录的网关 `package.json`。理由：

- 组件、路由和测试都轻，没有服务端渲染、没有数据库、没有第二套 API
- 构建产物是静态文件，以后可以由同一个 Worker 同源托管
- 与网关同为 TypeScript，但工程分开，避免把 DOM 类型混进 Worker
- 不引入 Next.js 或其他全栈框架，避免再起一个 Node 服务和一套路由约定

浏览器只访问相对路径 `/api`。开发与预览由 Vite 把 `/api` 代理到网关。代理进程可以读取环境变量 `DEMO_ACCESS_TOKEN` 并写到出站请求上。这个变量不会进入前端包，页面也不提供粘贴凭证的输入框。模型密钥、检索密钥和 `x-internal-token` 不出现在浏览器代码里。

## 4. 页面布局

一个工作区，两栏，不做营销页。

- 左栏「项目」：名称输入和「创建」；已打开项目只显示名称和状态；编号输入和「打开」。列表来自本机记录，再用 `GET /api/projects/{id}` 刷新。这不是服务端全量列表。
- 右栏：项目名称；需求文字；PPTX；可选历史 XLSX；收到上传响应后才显示「已接收」；历史文件另有「导入历史数据」。主按钮「开始寻源」会先整理需求，再 `POST .../runs`。
- 进度：当前状态、运行编号、异常时的一句说明。过程记录默认折起，只显示阶段和时间，不显示原始事件正文。
- 没有首屏口号、KPI 卡片、装饰图、嵌套卡片。`PARTIAL` 和失败才出现说明。`UNKNOWN` 不在 F1 展示；F2 必须按原值显示，不能画成通过或失败。
- 桌面端左栏固定、右栏内容最宽约 880px。窄屏改为上下排列。长名称允许断行，不把侧栏撑开。

F2 再在同一右栏下列出候选（供应商、型号、阶段、证据），F3 再放下载。F1 不放这两块，避免把空数据画成已完成。

## 5. F1–F4 的文件顺序

F1（本分支）：

- `frontend/package.json`、`vite.config.ts`、`proxyAuth.ts`、`index.html`、`tsconfig.json`
- `frontend/src/api/types.ts`、`client.ts`、`adapter.ts`
- `frontend/src/storage.ts`、`workspace/poll.ts`、`workspace/useWorkspace.ts`、`workspace/labels.ts`
- `frontend/src/components/ProjectNav.tsx`、`RunPanel.tsx`、`App.tsx`、`styles.css`
- 对应的 `*.test.ts(x)` 与 `frontend/e2e/`

F2，只读，接口已经存在：

- `frontend/src/api/results.ts`：candidates、evidence、spec-assessments、decisions 的窄解析
- `frontend/src/components/CandidateTable.tsx`、`CandidateDetail.tsx`
- 阶段用候选上的 `stage`，技术结论用 `hard_spec_overall`，推荐用 `recommendation` 且必须同时看 `accepted`

F3，等正式报告接口：

- `frontend/src/components/ReportDownload.tsx`
- 只在报告状态为可下载时给出链接，并带上当前看到的运行编号

F4：

- 若后端提供项目操作接口，再加一个明确的操作区，绑定 `demand_revision` 和 `run_id`
- 在此之前不增加对话输入来假装状态已更新。F1 的文字框就是需求正文，提交后能在来源列表里看到新修订

## 6. 与后端的边界

前端改 `frontend/` 和这两份 `docs/m4/` 文档。不改 `cloudflare/gateway/`、`wrangler.jsonc`、`Dockerfile`、`src/procurement_agent/`、迁移和根 `package.json`。

需要后端实施的共享区变更（前端未改这些文件）：

1. 在 `wrangler.jsonc` 增加静态资源，把 `frontend/dist` 挂到 Worker。`cloudflare/gateway/src/index.ts` 对非 `/api`、非 `/internal` 的 GET 返回该资源，并回退到 `index.html`。这样页面与 API 同源，不需要 CORS。
2. 不要把 `DEMO_ACCESS_TOKEN` 下发到浏览器。同源部署后，凭证校验仍留在 Worker：用 Cloudflare Access 的身份，或由 Worker 签发 HttpOnly 会话。在那之前，本地 `vite dev` / `vite preview` 用进程环境变量注入凭证。
3. 若短期必须把页面放在另一个域名，才给网关加 CORS 白名单，并仍然不要把模型密钥放到浏览器。这比第 1 条差，因为浏览器还是得持有访问凭证。

契约缺口不在共享文件里实现，列在 `backend_contract_requests.md`。前端按本文件第 2 节的真实响应解析；解析失败视为 `invalid_response`，不补造成功数据。

F1 对整理失败的判断使用网关现有行为：`compiler` 失败时仍插入 `demand_compilations`，JSON 只有 `issues`、没有 `requirements`。这是当前契约，不是新接口。

## 7. 最小可用版本的工作量

最小可用版本是：能建项目、提交文字或 PPTX、可选历史文件、看到真实运行状态、看到该次运行的候选与证据、在正式报告真实生成后下载。按接口边界拆开，不用日历估算。

- F1 只调用已经存在的项目、上传、整理、运行和事件接口。范围是一个独立前端工程、类型化客户端、状态展示和测试。本分支完成这一段。
- F2 是只读展示。候选、证据、技术核对、决策的 GET 已在同一提交里。工作是按返回字段呈现，不新增判定规则。
- F3 被正式 DOCX 挡住。下载路由存在，但寻源运行不写 `artifact_key`。
- 跨浏览器的项目列表和「打开编号后看到最近一次运行」要等两个 GET。在那之前，本机记录只能恢复这台浏览器自己点过的项目。
- 一句话修订并重评是另一个写接口，不能用现有三次调用包装成已经完成。
