# Implementation Log

## M0 — 平台与代理能力验证

日期：2026-10-24

### 已完成

- 通读 v1.3 增量交接包（`00_START_HERE` 至 `05_EXECUTION_EVAL`）与 `baseline_v1.2/` 九份基线文档。
- 建立独立项目骨架，不再沿用上游研究仓库的目录、示例、评测产物与无关旧实现。
- Python 包重整为 `procurement_agent`：`agents/`（Deep Agents 主循环）、`api/`（Container 内
  FastAPI）、`infra/`（环境配置、模型适配、SearchProvider 抽象）、`reports/`（DOCX 生成）。
- 领域不变量固化为可执行约束：搜索结果只是候选来源（`SearchProvider` 返回 `SearchResult`），
  不直接成为证据；Agent 系统提示词禁止捏造供应商、报价、来源与关系，并要求区分四类价格、
  隔离模拟历史供应商。
- 需求与历史数据解耦：M0 的执行端点不要求任何历史文件，阶段文案显式说明“历史文件未提供”。
- Cloudflare 网关（TypeScript）实现：项目/运行创建、运行状态查询、阶段事件、内部回写鉴权、
  R2 产物上传与 DOCX 下载；D1 migration 覆盖 `projects` / `runs` / `run_events`。
- Worker 通过 Workflow 驱动 Container 执行 2–5 分钟长任务，任务进度经内部鉴权接口回写 D1，
  页面刷新不影响运行状态。

### 实测结果（真实调用）

- `uv run python scripts/live_model_smoke.py`：普通对话、约 11k 字符上下文、原始 tool calling、
  Deep Agents 实际调用工具、Pydantic 结构化输出 **全部 PASS**。
  - 结构化输出必须显式使用 `method="function_calling"`：该端点默认模式会返回被代码围栏包裹的
    JSON，Pydantic 无法解析。这是实测结论，不做假设。
- LangSmith trace（root trace id）：
  - Deep Agents 工具执行：`01a16e21-6e97-7723-a154-13872a6b38da`
  - 结构化输出：`01a16e21-95b3-7bc0-8fa7-fe9b866134d5`
  - 对话 / 上下文探针：`01a16e21-3d86-7683-8826-eb1d30babb69`、`01a16e21-1b15-75f0-b518-1df55d853b54`
  - 失败的结构化输出 trace 保留在 LangSmith 中，作为协议问题的证据。
- `uv run python scripts/live_search_smoke.py`：Tavily 基础检索 **PASS**，返回
  `https://developers.cloudflare.com/containers`。未发送任何采购或客户数据。
- 本地单元测试：见下节命令输出。

### Cloudflare 账户与资源状态

- Workers Paid 已升级：`cf containers applications list` 由 401（错误 1000）变为正常返回空列表。
- R2 已激活：`cf r2 buckets list` 正常返回空列表。
- `cf d1 list` 与 `cf workflows list` 均正常返回空列表，账户尚未创建任何 D1 数据库、
  R2 桶、Workflow 或 Container 应用。
- 本机不安装 Docker。Container 镜像通过 Cloudflare 托管构建环境构建，不依赖 Docker Hub。

### 已知限制

- 尚未创建 D1 数据库、R2 桶与 GitHub 仓库，尚未产生任何部署链接与云端 Trace。
- M0 的容器长任务、R2 产物与 DOCX 下载闭环尚未在云端跑通，因此 M0 未通过。
- 模型端点的最大上下文长度、真实超时行为与限流响应尚未实测；客户端超时设置为 45 秒。
- 未获取精确计费数据，不声称具体金额。

### 下一步

1. 创建 GitHub 仓库并推送本项目，接入 Cloudflare Workers Builds（远程构建，无需本地 Docker）。
2. 创建 D1 数据库与 R2 桶，回填 `wrangler.jsonc` 中的 ID 与网关地址。
3. 在云端跑通 2–5 分钟长任务、状态查询与 DOCX 下载，验证容器重启后的失败恢复。
4. M0 通过后进入 v1.3 M1：文字/PPT 需求解析、可选历史导入、官方素材回归。
