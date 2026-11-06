# 采购寻源比价助理 · 技术说明文档

> 面向评委与评审的完整技术说明：系统做了什么、为什么这样做、如何证明它真的在算、它的边界在哪里、
> 如何复现。文中每个数字都对应仓库里的可执行证据或云端验收记录；未经验证的推测一律标注为"未验证"。

- 演示地址：**https://procurement-sourcing-agent.com**（备用 `https://demo.procurement-sourcing-agent.com`）
- 仓库：<https://github.com/xiangyu474/procurement-sourcing-agent>
- 文档基线：`main` 分支，提交 `35f67a1` 及之后的部署

---

## 1. 一页读懂

采购人员给出一段文字需求或一份 PPTX，系统完成五件事：

| 步骤 | 做什么 | 产物 |
| --- | --- | --- |
| **需求整理** | 把自然语言拆成结构化品项与可核验的技术约束 | 需求 DSL（品项 + 约束 + 计划价） |
| **公开寻源** | 在公开网络找候选供应商与具体型号，抓取真实页面快照 | 候选清单 + 来源快照 + 哈希 |
| **技术核验** | 逐条约束、逐条声明比对，模型判断语义、代码判断数值 | `PASS` / `FAIL` / `UNKNOWN` 判定与原因码 |
| **价格分析** | 分开处理计划价、历史价、公开价，口径不可比就明说 | 价格口径与"不可比"结论 |
| **采购建议** | 按硬约束门禁给出建议/排除，并说明缺口 | 决策 + 中文摘要 + 可下载 DOCX 报告 |

**系统最重要的一个设计选择**：它不会为了给结论而编结论。缺证据就是 `UNKNOWN`，来源只写了传感器像素
就不会被当成输出分辨率，硬约束不满足就不会因为价格低而通过。下面第 4 节给出这套语义的完整定义与
可验证的不变量。

---

## 2. 系统架构

### 2.1 组件与职责

```
浏览器（React + Vite，静态资源由同一 Worker 同源提供）
   │  HttpOnly 会话 Cookie，无任何凭证进入浏览器
   ▼
Cloudflare Worker（网关，TypeScript）
   ├── 访客会话 / 归属校验 / 限流 / 预算预约
   ├── 需求、项目、流水线、分析、报告的读写接口
   ├── 冻结快照的存储与版本指纹
   └── Cloudflare Workflows（编排）
          ├── 采购流水线 Workflow：寻源 → 核验 → 决策 → 冻结
          └── 报告 Workflow：DOCX 生成与 R2 落盘
                  │
                  ▼
        Python 容器（FastAPI，Deep Agents + LangGraph）
           ├── 需求整理 Agent（结构化输出 + Schema 校验）
           ├── 寻源 Supervisor / Researcher（Tavily 搜索与抓取）
           ├── 技术核验：打字 → 语义对齐 → 确定性计算器
           └── 采购建议 + 报告生成（python-docx）
                  │
                  ▼
        Cloudflare D1（业务数据、快照、判定缓存、审计）
        Cloudflare R2（来源快照、DOCX 报告；私有）
        LangSmith（追踪，容器内上报）
```

### 2.2 一次访客点击的完整链路

1. 浏览器打开页面 → `POST /api/session` → Worker 签发 `__Host-ps_session`（HttpOnly / Secure / SameSite=Lax / 24 小时）。
2. 访客建项目、提交需求文字或上传 PPTX/XLSX → 数据落 D1，文件落 R2。
3. 访客点"开始分析" → `POST /api/projects/{id}/pipeline` → Worker 做幂等预约与预算预约 → 创建 Workflow 实例。
4. Workflow 依次执行：
   - **RESEARCH**：容器内跑寻源 Agent，把候选、声明、来源快照写回网关；
   - **EVALUATING**：按冻结的候选与声明做打字 → 语义对齐 → 计算器判定；
   - **DECIDING**：按硬约束门禁给出采购建议；
   - **FREEZE**：把需求修订、候选、声明、核验、决策、价格口径与各快照哈希合成一份**不可变快照**，其 SHA-256 即 `decision_version`。
5. 决策冻结后，报告 Workflow 自动生成 DOCX 并写 R2；报告失败不影响已冻结的分析。
6. 前端用 `GET /api/projects/{id}/analysis?pipeline_id=…` 读同一份冻结快照；刷新、切历史运行都读同一版本。

### 2.3 为什么是这套技术栈

- **Cloudflare Containers + Worker**：重模型推理与高并发网关分离，容器自带 GPU/CPU 配额与冷启动语义，Worker 负责强一致写（单条 D1 条件写入实现原子预约）。
- **Workflows**：长任务的步骤边界、重试与持久化由平台保证；失败阶段被记录而不是静默。
- **D1 快照 + R2 大文件**：判定输入（需求、候选、证据）用内容寻址的哈希冻结在 D1，原始快照与报告放 R2。
- **Deep Agents**：寻源需要"Supervisor 委派 + 多个研究员并行 + 预算约束"，这是典型的 deepagents 场景。

---

## 3. 数据模型（摘要）

完整定义见 `docs/data_model.md`，关键表与用途：

| 表 | 用途 | 关键约束 |
| --- | --- | --- |
| `projects` / `source_inputs` | 项目与需求输入 | 访客项目带 `session_id` 归属 |
| `demand_compilations` | 每次需求整理的 DSL 快照 | 与 `demand_revision` 一一对应 |
| `project_pipelines` / `pipeline_stages` | 流水线与阶段状态 | 阶段错误码可见，不吞原因 |
| `pipeline_snapshots` | 冻结输入与输出 | `(pipeline_id, snapshot_type)` 唯一，先写者赢 |
| `project_candidates` / `project_candidate_evidence` | 候选与来源证据关联 | 证据必须可回溯到 R2 快照 |
| `research_claims` / `claim_evidence_links` | 公开来源中的声明 | 每条声明绑定来源引文与证据 ID |
| `spec_assessments` / `sourcing_decisions` | 核验与决策 | 拒绝的决策必须写明 `violations` |
| `judgment_cache` / `judgment_cache_conflicts` | 打字/对齐/判定三层缓存 | 键含输入与规则版本；冲突保留不覆盖 |
| `guest_sessions` / `guest_task_admissions` / `*_request_windows` | 访客会话与预算 | 条件写入原子预约 |

---

## 4. 核心判定语义（本系统与"看起来能用"的玩具系统的区别）

### 4.1 三态判定与硬约束

每个约束对每个型号产生一个检查：

- `PASS`：模型确认**语义上是同一个测量**，代码完成数值比较且满足要求；
- `FAIL`：语义一致且数值不满足（例如要求 ≥5MP，来源写 3MP）；
- `UNKNOWN`：无法确认——缺来源、引文只写了别的测量、单位不可比、来源自相矛盾。

聚合规则：任一 HARD 约束 `FAIL` 即整体 `FAIL`；任一 HARD 约束 `UNKNOWN` 即整体 `UNKNOWN`（不允许用其余通过项掩盖不确定）；全部 HARD 约束通过且无未解析需求才是 `PASS`。

### 4.2 三层判定与各自的职责

| 层 | 谁做 | 产出 | 为什么这样分 |
| --- | --- | --- | --- |
| 打字 | 模型 | 声明的属性键、值、单位、引文 | 只有模型能把"页面上的一句话"变成结构化测量 |
| 对齐 | 模型 + 人工审校别名表 | "需求属性 ↔ 声明属性"是否为同一测量 | 语义判断必须由模型做，**但**只有人工审校的别名表可以纠正模型的标注 |
| 计算 | 纯代码 | 单位换算、数值比较、硬约束聚合 | 数值判断不能交给模型，也不能由模型改写来源里的数字 |

### 4.3 不变量（代码与测试保证）

1. **来源引文必须逐字**：`claims` 的数值必须能在其 `source_quote` 中找到；不能找到就降级为 `UNVERIFIED`。
2. **不用产品名里的数字当测量**：目录标题里的 "5MP" 是商品名，不是分辨率；引文必须点名它测量的量。
3. **人工审校的别名表**：只有同义组内的键（例如 `output_resolution` 与 `video_output_resolution`）可以被互相替代；`sensor_resolution` **不在**该组内，传感器像素永远不能当输出像素。
4. **多值不靠模型拍板**：当多个来源给出同一测量的不同值时，模型必须说明这是"多值"还是"角色不明"；前者由代码判断"是否每个值都满足要求"（取最保守的最小值），后者保持 `UNKNOWN`。
5. **价格口径隔离**：`PLANNED_PRICE` / `HISTORICAL_TRANSACTION` / `PUBLIC_REFERENCE` / `FORMAL_QUOTATION` 不可比时给 `NOT_COMPARABLE`，不输出"最低价""节支比例"。
6. **历史价格不是单品基准**：只有人工确认的等价关系才能把历史行归到当前品项；仅同名不够。表级分布只能作为概览，明确标记"不是基准"。
7. **模拟历史与真实企业隔离**：官方模拟历史供应商始终是独立命名空间，不与同名真实企业合并。
8. **硬约束不可被低价抵消**：`SHORTLIST` 必须同时满足 `accepted`、建议档位、`VERIFIED_PASS`、`hard_spec_overall = PASS`。

这些不变量的实现与测试见 `tests/test_judgment_guards.py`、`tests/test_history_scope.py`、`tests/test_price_context.py`、
`cloudflare/gateway/test/decision_display.test.ts`、`cloudflare/gateway/test/pipeline_summary.test.ts`。

### 4.4 中文摘要的边界

`/analysis` 返回的 `decisions[].display` 是**基于结构化原因码生成的中文摘要**（版本
`decision-display-v1`），不是逐句翻译。原始英文 `rationale/gaps/next_actions` 一字不改地保留，并用
`untranslated_originals` 明确告诉前端有多少原文尚未中文化。前端只展示摘要，并提示"还有原始信息待核对"。

---

## 5. 公开接口契约

完整契约见 `docs/m4/backend_contract_response.md`（§5）与 `docs/m4/frontend_implementation.md`（前端如何消费）。

| 接口 | 说明 |
| --- | --- |
| `POST /api/session` / `GET /api/session` | 访客会话；`GET` 返回 `mode`（`guest` / `operator`），后端判定身份，前端不猜 |
| `POST /api/projects` | 建项目（访客可用） |
| `POST /api/projects/{id}/requirement-text` | 提交需求文字 |
| `POST /api/projects/{id}/requirement-compile` → `GET .../{compile_id}` | 需求整理作业与状态 |
| `POST /api/projects/{id}/upload-sessions` / `POST .../history-imports` | 上传与历史导入（历史导入失败返回 422 + 中文原因，不返回异常类名） |
| `POST /api/projects/{id}/pipeline` | 一次点击分析；支持 `Idempotency-Key` 与可选 `research_budget` |
| `GET /api/projects/{id}/pipeline/{pipeline_id}` | 进度、阶段、失败原因码、候选/型号/证据计数、报告状态 |
| `GET /api/projects/{id}/pipelines?active=true` | 刷新后找回进行中的任务（不依赖浏览器状态） |
| `GET /api/projects/{id}/analysis?pipeline_id=…`（或 `?run_id=…`） | **统一分析接口**：冻结的需求、候选、核验、决策、价格口径、证据、摘要、报告状态 |
| `POST /api/projects/{id}/pipeline/{pipeline_id}/report` | 报告重试（访客可用，计 1 个预算单位） |
| `GET /api/projects/{id}/reports/{report_id}` / `.../download` | 报告状态与下载（校验归属与内容哈希） |

错误语义：`404 not_found`（跨访客访问一律 404，不泄露资源存在性）、`409`（需求版本已变 / 幂等冲突 / 快照未就绪）、
`422`（需求无法识别 / 预算越界 / 历史文件不可用）、`429`（限流 / 预算耗尽）、`503`（能力未开启）。

---

## 6. 工程保障

### 6.1 测试基线（本次交付实测）

| 层 | 数量 | 命令 |
| --- | --- | --- |
| Python（领域、判定、报告、接口、回归） | **326 通过** | `uv run --python 3.11 python -m pytest -q` |
| Node（网关、访客会话、准入、快照、摘要、判定展示） | **72 通过** | `npm run check` |
| 前端（单测 + Playwright） | 69 单测 / 23 E2E | `cd frontend && npm test && npm run e2e` |
| 静态检查 | Ruff、tsc、Worker dry-run 全通过 | `ruff check .` / `npx tsc --noEmit` |

另有官方素材回归套件（`tests/test_official_history_regression.py`、`tests/test_official_m1_regression.py`），
把官方案例的结果固化成回归断言。

### 6.2 安全与滥用防护

- **访客身份**：HttpOnly 签名 Cookie，浏览器不持有任何凭证；运维 Bearer 仅存在服务端。
- **归属隔离**：访客只能看到自己会话创建的项目、运行、分析、报告；跨访客访问一律 404。
- **限流**：会话创建按全局/IP 固定窗口计数；已认证请求按全局/会话计数，超限 429 + `Retry-After`。
- **预算预约**：D1 单条条件写入原子完成并发与日额度判定（整理 1 单位、分析 4 单位、报告重试 1 单位；
  全局并发 2、每访客并发 1、每访客每日 16 单位 / 6 次启动、全局每日 80 单位）。单位是**并发与日量的
  粗粒度代理，不是金额，也不是模型调用次数**；实际调用仍受 M2 内部既有搜索/取页/轮次上限约束。
- **Origin 校验**：访客写操作只接受登记过的来源；生产域、两个自有域与本地开发端口在白名单内。

### 6.3 可追溯与审计

- 每个外部事实带来源 URL、抓取时间、内容 SHA-256 与逐字引文；引文里的数字与声明值必须一致。
- 冻结快照内容寻址：需求修订、候选、声明、核验、决策、价格口径与各快照哈希一起被 `decision_version` 覆盖。
- 三层判定缓存记录输入摘要与规则版本；**内容不同则保留冲突记录，不覆盖先写者**。
- 报告生成独立于判定：报告失败不回滚已冻结的分析，可单独重试。

---

## 7. 里程碑与验收证据

| 里程碑 | 内容 | 验收方式与证据 |
| --- | --- | --- |
| M0 | Worker / Container / DO / Workflow / D1 / R2 全链路打通 | `docs/m4/F0_audit.md` |
| M1 | 需求整理、来源数字核验、官方素材回归 | `tests/test_official_m1_regression.py`；官方 14 品项案例与预算舍入差回归固化 |
| M2 | 有来源支撑的候选发现、预算与部分失败语义 | `docs/m2` 相关脚本；寻源失败与预算耗尽有独立错误码 |
| M3 | typed claims、语义对齐、确定性计算器、采购建议、门禁 | `docs/m3_verification.md`；缓存冷热对照（16 次冷调用 → 0 次热调用，结果一致）证明缓存稳定，**不**证明语义正确 |
| M4/B1 | 一次点击的完整 Pipeline | 云端验收 `cf_361ade…`：同键复用同一 Pipeline/Run，三阶段完成 |
| M4/B2 | 冻结决策版本 + 自动 DOCX | 云端验收 `cf_c4397…`：24 候选/核验/决策，44,335 字节 DOCX，版本与 SHA 核对 |
| M4/B3 | 访客 Session、隔离、限流、预算 | `scripts/verify_guest_cloud.py` 实测：A/B 互不可见、一次点击跑完、报告 44 KB 可下载 |
| M4/B4 | 前后端真实浏览器联合验收 | 前端在公开地址完成：访客会话 → 建项目 → 一次点击 → 进度 → 结果与中文摘要 → 下载 DOCX → 刷新仍是同一冻结版本 |

---

## 8. 已知限制与风险（不掩盖）

1. **公开链接的网络可达性**：`workers.dev` 在部分网络会被 DNS 投毒，因此正式地址改为自有域名
   `procurement-sourcing-agent.com`（已用手机热点在普通民用网络验证可达）。仍建议提交录屏视频作为兜底。
2. **判定比例受"来源是否写明所问测量"支配**：页面只写 "Effective Camera Resolution"（传感器有效像素）时，
   判定为 `UNKNOWN` 是**语义正确**的行为；只有取到规格书里写明输出分辨率的那一行，才会 `PASS`。
   报告中的中文摘要会明确说明是"证据不足"还是"不合格"。
3. **PDF 抽取不完整**：规格书 PDF 经检索服务抽取后常只有约 2 千字符，规格表可能缺失；系统已改为
   每个任务最多取两个规格书页并优先标注规格书结果，但仍会偶发取不到。
4. **模型网关延迟**：在网关拥塞时，一次完整分析可能需要 10–15 分钟（评估阶段最慢）。系统不因此缩短研究，
   以免用更少证据换更快结论；演示以录屏形式提交，不依赖现场实时性。
5. **预算单位不是金额**：见 6.2；没有做逐次模型调用计费。
6. **访客并发上限为 2**：同一时刻最多两条访客流水线占用容器实例；自测任务会自动让路。
7. **型号多样性**：同一型号可能由多个供应商重复提供，页面按型号聚合展示；主动扩大型号覆盖属于后续优化项。

---

## 9. 部署、复现与运维

### 9.1 部署

- GitHub `main` 推送触发 Cloudflare Builds：构建前端静态资源 → 构建容器镜像 → 部署 Worker（同一账号、同一构建）。
- D1 迁移在 `cloudflare/gateway/migrations/`，按编号顺序应用（当前 20 个）。
- 容器实例按流水线分配（每条流水线独立实例），避免两个访问互相拖垮；实例额度 8。

### 9.2 复现验收

```bash
# 单元与网关测试
uv run --python 3.11 python -m pytest -q     # 326
npm run check                                 # 72
cd frontend && npm test && npm run e2e        # 69 + 23

# 云端访客全链路（两个访客互不可见 + 一次点击 + 报告下载）
uv run --python 3.11 python scripts/verify_guest_cloud.py

# 读取某次冻结判定（网络受限时用数据库直读）
uv run --python 3.11 python scripts/read_pipeline_spec.py <pipeline_id>
```

### 9.3 持续自测

Worker 内置 Cron 触发器（每 9 分钟）：在 Cloudflare 内部通过**正式域名**启动一次完整访客流水线，
结果写入 D1（项目标题 `SELFTEST 判定稳定性`）。这样即使开发机网络受限，验收回路也不停。

---

## 10. 演示指引

1. 打开 **https://procurement-sourcing-agent.com** → 自动建立访客会话（不需要登录）。
2. 粘贴需求文字或上传 PPTX → "开始分析" → 进度依次显示整理需求、寻找供应商、核对技术与价格、
   整理采购建议、生成报告。
3. 结果页展示：按**需求 × 型号**聚合的候选表、每条判定的中文摘要与缺口、价格口径（计划单价/计划预算）、
   可点开的来源证据，以及型号数、供应商数、证据数与覆盖提示。
4. "下载这一版"得到 DOCX（含 Run 与决策版本），页面上显示的版本与报告内一致。
5. 刷新页面或切换历史运行：仍是各自冻结的版本，不混入最新结果。

录制视频时建议同时展示一条 `UNKNOWN` 与一条 `PASS` 的判定，并说明前者是"来源还没取到能支撑结论的证据"，
这正是本系统与只会输出结论的系统的区别。

---

## 11. 附录：代码位置

| 关注点 | 位置 |
| --- | --- |
| 网关路由、访客分支、预算 | `cloudflare/gateway/src/index.ts`、`guest_session.ts`、`guest_admission.ts` |
| 流水线编排、冻结快照 | `cloudflare/gateway/src/pipeline_workflow.ts`、`pipeline_store.ts`、`pipeline_final.ts` |
| 分析投影与摘要 | `cloudflare/gateway/src/pipeline_analysis.ts`、`pipeline_summary.ts`、`decision_display.ts` |
| 报告工作流 | `cloudflare/gateway/src/pipeline_report.ts` |
| 容器 API | `src/procurement_agent/api/app.py` |
| 寻源 Agent 与提示词 | `src/procurement_agent/agents/sourcing.py`、`services/sourcing_research.py` |
| 需求 DSL 与整理 | `src/procurement_agent/domain/requirements.py`、`ingestion/compiler.py` |
| 打字 / 对齐 / 计算器 | `src/procurement_agent/services/spec_typing.py`、`spec_alignment.py`、`spec_calculator.py` |
| 人工审校别名表 | `src/procurement_agent/domain/attributes.py` |
| 价格与历史口径 | `src/procurement_agent/services/price_context.py`、`history_analytics.py`、`product_equivalence.py` |
| 报告生成 | `src/procurement_agent/reports/procurement_report.py` |
| 前端工作区 | `frontend/src/workspace/`、`frontend/src/view/analysis.ts` |

术语与状态词表见 `docs/expected_behavior.md`；需求 DSL 见 `docs/requirement_dsl.md`；
交付计划与现状见 `docs/TODO.md`；前后端契约与逐条回执见 `docs/m4/backend_contract_response.md`。
