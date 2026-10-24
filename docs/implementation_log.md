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

### 下一步（v1.3 M1）

1. 按 v1.3.1 补丁实现 `SourcingSupervisor` + `SupplierResearcher` 池、`ProcurementAnalysisContext`
   与冻结的 `SourcingDecisionSnapshot`（Web 与 DOCX 同源）。
2. 需求解析：仅文字、仅 PPTX、PPT+XLSX 三条路径，历史 Excel 可后补导入。
3. 官方两组 PPT/XLSX 回归：1000 行 / 38 列 / 第 8 行表头、模拟供应商不与公网同名主体合并。
