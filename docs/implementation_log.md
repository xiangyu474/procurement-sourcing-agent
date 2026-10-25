# Implementation Log

## M0 — 平台与代理能力验证

日期：2026-10-24 ｜状态：**M0 通过**

### 已实现

- 独立 Python 包 `procurement_agent`：`agents/`（Deep Agents 主循环）、`api/`（Container 内
  FastAPI）、`infra/`（环境配置、模型适配、`SearchProvider` 抽象）、`reports/`（DOCX 生成）。
- 领域不变量固化为可执行约束：搜索结果只是候选来源，不直接成为证据；Agent 系统提示词禁止
  捏造供应商、报价、来源与关系，并要求区分四类价格、隔离模拟历史供应商。
- 需求与历史数据解耦：M0 执行端点不要求任何历史文件，阶段文案显式说明“历史文件未提供”。
- Cloudflare 网关（TypeScript）：项目/运行创建、运行状态、阶段事件、内部回写鉴权、R2 产物
  上传与 DOCX 下载；Workflow 驱动 Container 长任务；失败写入终态 `FAILED` 与失败原因。
- D1 三次增量 migration：`0001_init`（projects/runs/run_events）、`0002_run_idempotency`
  （idempotency_key + 唯一索引）、`0003_run_last_error`（last_error）。
- 幂等：`POST /api/projects/{id}/runs` 接受 `idempotency_key`，重复请求返回同一 `run_id`。

### 部署（真实执行）

| 项目 | 值 |
| --- | --- |
| Worker | `https://procurement-sourcing-gateway.xiangyu474.workers.dev` |
| Workflow | `procurement-sourcing-run` |
| Container 应用 | `procurement-sourcing-gateway-sourcingcontainer`（`a03c199b-83f5-4544-995e-76c6932d14f4`） |
| 镜像 | `registry.cloudflare.com/4132e127.../procurement-sourcing-gateway-sourcingcontainer@sha256:ffcd81b3...` |
| D1 | `procurement-sourcing`（`3a67c338-107f-4053-b678-109dd218773c`） |
| R2 | `procurement-sourcing-artifacts` |
| 部署方式 | GitHub push → Cloudflare Workers Builds 远程构建（本机无 Docker） |

### 实测结果

**本地**
- `uv run python -m pytest -q` → **10 passed**
- `npx tsc --noEmit` → 无错误
- `uv run python scripts/live_model_smoke.py` → **PASS**（对话、11k 上下文、tool calling、
  Deep Agents 实际调用工具、Pydantic 结构化输出）
- `uv run python scripts/live_search_smoke.py` → **PASS**（Tavily 返回 3 条真实结果）
- LangSmith root trace：`01a16e21-6e97-7723-a154-13872a6b38da`（Deep Agents 工具执行）、
  `01a16e21-95b3-7bc0-8fa7-fe9b866134d5`（结构化输出）

**云端（M0 验收）**
- C01 创建任务：立即返回 `202` + `run_id`，状态 `QUEUED` ✅
- C02/C03 断连存活：创建 run 后 **70 秒内不发起任何请求**，任务仍完整跑完并写入 6 条阶段事件 ✅
- C04 失败恢复：故意触发容器 422（`duration_seconds=9999`），run 终态为 `FAILED`，
  失败原因写入事件：`container task failed with status 422: ... "Input should be less than
  or equal to 600"`；不再出现永久 `QUEUED` ✅
- C05 幂等：同一 `idempotency_key` 两次请求返回同一 `run_id`（第二次带 `reused: true`）✅
- C07 DOCX 下载：`GET /api/runs/{id}/report/download` → 200，37,509 字节，
  `python-docx` 可解析，中文标题与 7 行阶段表正常 ✅
- C08 越权访问：内部接口使用错误 token → `401 {"error":"unauthorized"}` ✅
- R2 对象已核对：key `workspaces/default/projects/{run_id}/reports/{run_id}/report.docx`，
  size 37,506，contentType 为 DOCX ✅

**关键排障记录（均为实测，非推测）**
1. Container 首次 500：`model_config` 是 Pydantic 保留字段名，导致应用导入即崩溃、
   容器秒退。改为 `runtime_config`，并新增 `test_container_startup.py` 断言容器可导入，
  避免同类问题再次只表现为云端启动失败。
2. Container 内存：`lite` 实例不足以运行 Python 应用，改为 `standard-1`。
3. 就绪探针：改用 `pingEndpoint = "localhost/health"`，直接探测应用健康路由而非仅探测端口。
4. 失败 run 卡在 `QUEUED`：`last_error` 曾被加进已应用的 `0001` migration，实际未建列，
   失败写入 SQL 抛错。已拆出 `0003_run_last_error.sql`。
5. 环境：Git 与 curl 需走公司代理 `proxy.emea.ibm.com:8080`；Git 不读 Windows 系统代理。

### 已知限制

- 容器内长任务目前是**阶段演练**，尚未接入真实检索、规格核验与比价；报告明确标注
  “尚未执行公开检索、规格核验或价格比对”。
- 无 Web UI：`/api/projects` 直接用 curl 调用。
- 仓库仍为 private；比赛提交前需转 public。
- `wrangler.bootstrap.jsonc` + `bootstrap.ts` 为首次建 Worker 的引导产物，可在下一切片删除。
- 未做容器中途重启（SIGTERM）恢复测试；失败路径已验证，进程被杀场景待补。
- 未获取精确计费数据，不声称具体金额。

## M1 — Demand Intake / Requirement DSL / Optional History（本地实现与回归通过；尚未部署）

日期：2026-10-24

### 文件级改动

- `src/procurement_agent/domain/requirements.py`：版本化 Requirement DSL（受限 operator/value types、
  HARD/PREFERENCE/UNKNOWN、来源/原文、AMBIGUOUS/UNSUPPORTED）、Conflict、历史数据集/订单行模型。
- `src/procurement_agent/ingestion/text.py`：纯文本分行 source locators 和 revision。
- `src/procurement_agent/ingestion/pptx.py`：遍历全部页、文本框、表格单元格；定位格式含 PPT 文件 ID、
  slide/shape 或 table/row/cell；header-driven 限制模型上下文，不固定第 6 页。
- `src/procurement_agent/ingestion/pptx_tables.py`：依据表头识别采购明细表，确定性抽取采购行、数量、
  计划采购单价/预算、税率和源坐标。计划单价税基保持 UNKNOWN，含税总预算保留 INCLUSIVE。PPT 摘要
  采购量以不同 source locators 生成未解决 `DataConflict`，不会覆盖详细行项。
- `src/procurement_agent/ingestion/xlsx.py`：前 30 行自动表头扫描、字段别名映射、行级 source locator、
  SHA256 可去重数据集 ID；模拟历史主体使用 `HISTORICAL_SUPPLIER_SIMULATED` 和独立实体 ID。
- `src/procurement_agent/ingestion/compiler.py`：Chat model function-calling 结构输出，Pydantic 严格 DSL
  校验；模型引文必须是实际 fragment 的原文子串；JSON 数字只在 LLM adapter 边界规范为十进制字符串；
  不完整/错误引用退化为 AMBIGUOUS/UNSTRUCTURED，不变成已验证约束。
- `src/procurement_agent/services/demand_intake.py`：文字与 PPT 独立编译，按需求/SKU 检测数量及属性冲突；
  对 PPT 结构表格优先确定性解析，LLM 仅处理经过筛选的明确叙述约束，市场营销内容不升格为硬规格。
- `src/procurement_agent/api/app.py`：Container 内部 demand compile、PPTX 加载、历史 XLSX 导入 API；历史未提供
  不阻断编译，内部数据不发送到外部搜索。
- `cloudflare/gateway/src/index.ts` + `migrations/0004_m1_demand_intake.sql`：文字建项目/追加 revision、
  独立 PPTX/XLSX 上传到私有 R2、编译结构化需求、单独导入历史、hash 去重、analysis_version/demand_revision。
  运行请求要求当前 demand revision 已有编译结果；无历史仍可创建 run。
- `tests/`：DSL、原文引用、文本/PPT 冲突、PPT 表头/行定位、XLSX 模拟数据隔离、API intake、migration schema、
  两组本地官方素材回归。新增 `scripts/live_demand_compile.py` 与 `scripts/live_official_demand_compile.py`。

### 验收命令与结果

```bash
uv run --python 3.11 python -m pytest -q
# 32 passed
npx tsc --noEmit
# pass
uv run --python 3.11 python -m compileall -q src scripts tests
# pass
uv run --python 3.11 python scripts/live_demand_compile.py
# live Genesis call: PASS，输出 1 个电源模块需求、数量 100 台，额定功率 GTE 7.5 kW HARD，CAN 接口 PREFERENCE；所有 resolved 字段引用原文 locator
uv run --python 3.11 python scripts/live_official_demand_compile.py --case 1
# PASS：7 页、14 条采购行、数量/计划价格来源坐标；保留 58万台 vs 63万台未解决摘要冲突
uv run --python 3.11 python scripts/live_official_demand_compile.py --case 2
# PASS：7 页、14 条采购行、来源坐标；没有硬编码出假规格
```

官方 XLSX 两组：各 **1000 条非空交易行、38 列、第 8 行表头**；检测到“模拟数据/供应商名称、合同、交易状态均为虚构”，
所有行的 supplier namespace 为 `HISTORICAL_SUPPLIER_SIMULATED`。官方输入保持在本地，未复制到新仓库。

LangSmith trace：
- M1 live 文本需求 DSL 编译：`01a16f55-4b22-77d5-82c0-ea22d29dfb63`（通过）。
- 官方 A PPT 叙述补充编译：`01a16f4e-6abd-76ba-9286-0315c8fcaf48`（通过；无足够来源支撑的叙述保持 UNSTRUCTURED）。

### 未解决 / 边界

- 本地 M1 代码和 D1 migration 尚未部署；Cloudflare 线上仍运行已验证的 M0 Worker。没有执行 Git commit/push（按用户要求由用户 review 后手动提交）。
- 纯文本和官方 PPT 的模型编译已实测；官方 PPT 的结构化 SKU 行由确定性表格解析负责。官方 PPT 没有可定位的具体型号技术参数，故不虚构 DSL 硬规格。
- `Pptx` 有明确市场营销/市场规模文字被保留为未结构化来源；只有能映射到具体采购行、且 source quote 可验证的语句才进入 RequirementConstraint。
- M1 XLSX importer 内存返回规范化交易数组；Worker 把它作为私有 R2 JSON snapshot 保存，D1 仅存 dataset/index。后续 M3 历史统计会从 snapshot 流式/分批计算，不能把模拟供应商连入公开 Supplier 表。
- 无 UI；text/PPT intake 和 history import Worker 路由目前仅在本地代码/类型检查中验证，需用户 review 后再触发 Cloudflare Workers Builds 部署。
- M2 及以后（Supervisor/Researcher pool、公网 Tavily 研究、Evidence Ledger/Supplier Intelligence、Calculator、Data Fusion、Snapshot、Web/DOCX 同源报告）均未开始。
