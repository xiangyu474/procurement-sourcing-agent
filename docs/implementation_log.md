# Implementation Log

## M0 — Cloudflare 部署与代理能力验证

日期：2026-10-24 ｜状态：**M0 通过**

### 已通过的 M0 能力

- Cloudflare Worker + Python Container + Durable Object + Workflow + D1 + R2 已真实部署。
- Worker：`https://procurement-sourcing-gateway.xiangyu474.workers.dev`
- Workers Builds 在 Cloudflare 远程构建 Container 镜像；本机不运行 Docker，不用 Docker Hub。
- C01：创建任务即返回 `202 + run_id`；C02/C03：停止轮询 70 秒，任务继续并写入阶段事件；C04：容器请求故障写终态 `FAILED` 和原因；C05：相同 idempotency key 返回同一 run；C07：DOCX 写 R2 并下载；C08：错误内部 token 得 `401`。
- 首次排障包括：Pydantic 的保留字段 `model_config`、Container 规格、健康探针、已应用 D1 migration 不可改写、失败状态不可永久 QUEUED。
- M0 长任务是**阶段演练**，不是真实寻源；DOCX 明确说明没有检索/核验/比价。

## M1 — Demand Intake / Requirement DSL / Optional History

日期：2026-10-24 ｜状态：**本地验收通过；云端端到端仍有一条 PPT 容量阻塞**

### 文件级改动

- `src/procurement_agent/domain/requirements.py`：版本化 Requirement DSL（有限 operator/value types、
  HARD/PREFERENCE/UNKNOWN、来源/原文、AMBIGUOUS/UNSUPPORTED）、PlannedAmount、DataConflict、History 模型。
- `src/procurement_agent/ingestion/text.py`：纯文本 source revision 与字符位置 locator。
- `src/procurement_agent/ingestion/pptx.py`：遍历所有 slide、shape、table/cell，保存文件/页/表/行/列定位；
  按语义筛选输入，不把市场营销/市场容量直接当采购硬条件。
- `src/procurement_agent/ingestion/pptx_tables.py`：按表头识别采购计划表并确定性提取采购行、数量、
  计划采购单价/预算/税率；计划单价税基未知时保留 `UNKNOWN`；摘要数量声明保留可追溯冲突。
- `src/procurement_agent/ingestion/xlsx.py`：前 30 行自动识别表头，别名映射，保存 source file/Sheet/row；
  对官方模拟文件识别第 8 行表头、38 列、1000 行，并建立 `HISTORICAL_SUPPLIER_SIMULATED` 独立 ID。
- `src/procurement_agent/ingestion/compiler.py`：真实模型 function-calling 结构编译；模型输出经过严格 Pydantic 校验；
  Source quote 必须在源片段内，错引文/不完整 DSL 留为 UNKNOWN/UNSTRUCTURED；未给出像素测量口径时不能直接判定。
- `src/procurement_agent/services/demand_intake.py`：文字/PPT 独立解析后融合；精确匹配需求项时检测来源冲突；
  无历史返回 `NOT_PROVIDED`，导入新历史增加 analysis version，旧版本不被覆盖。
- `src/procurement_agent/api/app.py`：Container 内部需求编译、私有 PPTX 获取、历史 XLSX 导入。
- `cloudflare/gateway/src/index.ts` + `migrations/0004_m1_demand_intake.sql`：文本项目创建/版本追加、
  PPTX/XLSX 私有 R2 上传、DSL 编译存取、独立历史导入/哈希去重；公共 API 要求 `DEMO_ACCESS_TOKEN`。
- `tests/` 和 `scripts/`：DSL、语义 gold cases、来源/冲突、表格解析、历史导入、API service、migration 与官方回归；
  `scripts/verify_m1_cloud_api.py` 提供部署后文字/PPT/历史/冲突/幂等 API 验收。官方竞赛资料保留在工作区外，
  没有复制进新仓库。

### 本地验收结果

- `uv run --python 3.11 python -m pytest -q`：**34 passed**。
- `npx tsc --noEmit`：**PASS**。
- `uv run --python 3.11 python -m compileall -q src scripts tests`：**PASS**。
- 两组官方 PPT：每份 7 页、每份 **14 条采购数据行**（表格 15 行含 header），数量、计划价、预算保留来源定位。
- 两组官方 XLSX：每份 **1000 条交易行 / 38 列 / 第 8 行表头**；模拟身份隔离测试通过。
- Case A 的“58 万台”和“63 万台”被保留为两个来源值不同的 `DataConflict`，未自动择一。
- `scripts/live_demand_compile.py`：真实模型将“额定输出功率至少 7.5kW”编为 HARD/GTE，
  将“最好支持 CAN”标为 PREFERENCE；resolved 字段引用源文。LangSmith trace：
  `01a16f55-4b22-77d5-82c0-ea22d29dfb63`。
- `scripts/eval_requirement_semantics.py`：6 个有 gold label 的实时语义案例 **6/6 PASS**，覆盖 GTE/LTE、
  HARD/PREFERENCE、Boolean、像素口径歧义、宽泛质量/标准。语义 traces：
  `01a170fc-1b2a-72e8-b00f-d19afeac2ff3`, `01a170fa-f34a-768d-87df-99feee6fa9e8`,
  `01a170fa-c18c-70d8-a739-75cdc61bb743`, `01a170fa-7d4b-734c-a10f-6c5d05b5220f`,
  `01a170fa-431b-7469-a84c-81e76f0ed9ad`, `01a170fa-0f88-7432-9d40-707a7583f7c8`。

### Cloudflare M1 API 实测（用户已手动推送，未执行任何 Git 操作）

- Workers Builds 从 M1 GitHub push 成功构建 Container 镜像并部署 Worker；D1 的 `0004_m1_demand_intake.sql`
  已应用；M1 Worker 的 API bearer secret 已设置。
- 未授权 `POST /api/projects` → **401**。
- 纯文本需求流程：创建项目 → `requirement-compile` → `GET /requirements`，均成功；编译结果读回与写入结果相同；
  无历史时 `NOT_PROVIDED`。
- 官方 XLSX 独立上传并导入 → **1000 rows / 38 columns / header row 8 / synthetic true**；
  `history_availability=IMPORTED`，分析版本更新。重复导入返回 `duplicate_import=true`，没有再次累计订单。
- Case 2 PPTX 上传到私有 R2 返回 **201**，随后 `requirement-compile` 云端返回 **200**：14 条采购行、
  历史状态 `NOT_PROVIDED`，`GET /requirements` 读回一致。
- Case A PPTX 云端编译同样返回 **200**、14 条行项并可读回；但当前远端 Container 版本没有返回
  58/63 万台摘要 `DataConflict`。本地 extractor 已通过测试并产生该冲突，说明远端 image 仍落后于最新本地修改。
- 首次 Case 2 编译曾因两个旧的 per-project intake Container 处于 running 而超过 `max_instances=2`；
  它们 idle 后重试成功。当前 Worker 每个项目用不同 Container DO 名称，多个 idle 任务会暂时耗尽实例上限。
- 本地 Worker 已改为复用共享 `m1-intake` DO，并已统一重复导入 API 的 `dataset_id` 响应字段；
  这两个修正尚未部署，需要用户 review 后手动推送。云端目前仍在运行用户手动推送的版本。
- XLSX 重复导入 cloud test 返回 `duplicate_import=true` 且项目 `analysis_version` 未再次增加；旧远端响应返回 `id` 字段而非 `dataset_id`，因此语义去重通过、响应字段一致性仍待部署修正。

### 尚未完成 / M1 边界

- M1 text-only、history import、Case 2 PPT-only API 保存/读回均已云端实测；Case A 云端 PPT compile 仍缺 58/63 `DataConflict`，本地 parser 已检测。待最新本地 Container image 部署后复验这项语义。
- 最新本地 Worker/container 修正和重复导入响应字段尚未部署；没有执行 Git commit/push，按用户流程由用户 review 后手动提交/推送。
- 无 Web UI；官方文件真实数据仍未进入寻源研究；没有真实供应商发现、产品 Claim、Supplier Intelligence、Calculator 或报告建议。
- M2–M5 尚未开始；SIGTERM 中途终止恢复与精确真实费用观测仍为 M0/M5 遗留项。
