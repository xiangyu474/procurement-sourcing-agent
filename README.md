# Procurement Sourcing Intelligence Agent

采购智能寻源比价助理。以采购需求为入口的寻源研究 Agent：拆解需求、发现并核验公开供应来源、
逐属性判断技术符合性、区分不同口径的价格、诚实标注证据缺口，并输出可追溯、可下载 DOCX 的
《采购寻源调查与参考比价报告》。

## 产品边界

- **需求是唯一必需输入**：一段文字或一份 PPTX 至少提供一种。
- **历史采购数据完全可选**：没有历史数据时寻源照常运行，历史分析显示 `NOT_PROVIDED`，
  不伪造历史价格、趋势或供应商绩效。
- **公开收集的事实不写成历史采购订单**：网页发现的企业与价格属于公开市场情报，与内部历史
  交易是分开的命名空间。
- **官方模拟历史供应商不与同名真实企业自动合并**：历史主体始终标记为模拟主体。
- **价格类型严格隔离**：`PLANNED_PRICE` / `HISTORICAL_TRANSACTION` / `PUBLIC_REFERENCE` /
  `FORMAL_QUOTATION` / `HYPOTHETICAL`。口径不一致时给出 `NOT_COMPARABLE` 及原因，
  不输出“最低价”“节支比例”这类无依据结论。
- **规格逐属性判定**：`PASS` / `FAIL` / `UNKNOWN` / `NOT_APPLICABLE`。缺证据就是 `UNKNOWN`，
  硬约束 `FAIL` 不会被低价抵消。
- **证据可追溯**：重要外部事实必须带来源 URL、抓取时间与可定位片段；内部数字绑定原始文件坐标。
- **不做**：自动外发询价邮件、谈判、下单、供应商定标、在线富文本编辑器、PPT/XLSX 导出。

## 技术栈

| 层 | 选型 |
| --- | --- |
| Agent Harness | Python `deepagents`（LangGraph）；v1.3.1 的 Supervisor + 1–3 个同类型 Researcher 属于 M2 |
| 模型 | OpenAI 兼容接口（环境变量配置），结构化输出使用 function calling |
| 搜索 | Tavily（经 `SearchProvider` 抽象，可替换） |
| 云端 | Cloudflare Workers + Containers + D1 + R2 + Workflows |
| 报告 | `python-docx`，网页预览与 DOCX 草稿 |

## 目录结构

```text
src/procurement_agent/
  agents/     Deep Agents 主循环与角色提示词
  api/        Container 内运行的 FastAPI 服务
  infra/      环境配置、模型适配、SearchProvider 抽象
  reports/    结构化报告与 DOCX 生成
cloudflare/gateway/   Worker 网关（TypeScript）、D1 migration
tests/        单元与接口测试
scripts/      live 能力自检脚本
docs/         实施日志与验收记录
```

## 本地开发

```bash
uv sync --python 3.11
uv run pytest -q
```

密钥只从环境变量读取，本地放在未纳入版本控制的 `.env`，云端用 Cloudflare Secrets：

```bash
cp .env.example .env   # 填入 GENESIS_* / TAVILY_API_KEY
uv run python scripts/live_model_smoke.py
uv run python scripts/live_search_smoke.py
```

## Cloudflare 部署

Worker 网关负责鉴权、D1 状态、R2 产物与 Workflow 编排，Python Container 执行寻源任务。

```bash
cf d1 create procurement-sourcing
cf r2 buckets create procurement-sourcing-artifacts
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
```

Container 镜像由 Cloudflare 托管构建环境构建（`Dockerfile`），本地不需要安装 Docker。
镜像构建与首次部署耗时较长，部署后需要等待实例预���绪。

## 当前状态（M0/M1 已验收；M2 本地实现进行中）

- **M0 已实测部署**：Cloudflare Worker + Python Container + Workflow + D1/R2；验证任务在浏览器断连后继续、阶段事件、幂等、失败状态和 DOCX 写入/下载。Container 由 Cloudflare Workers Builds 构建，不需本地 Docker。当前仍未完成 SIGTERM 恢复和精确费用观测；已验证断连时长不等于完整的 2–5 分钟门槛证明。
- **M1 本地与云端验收通过**：纯文本、PPTX 需求与受限 Requirement DSL；历史 XLSX 独立可选导入。官方每组 PPTX 解析 14 条采购行；每组 XLSX 1000 行、38 列、第 8 行表头；模拟供应商隔离。Case A 的 58/63 万台差异保留为有来源的冲突。
- 云端 `scripts/verify_m1_cloud_api.py` 实测通过：匿名请求 401、文本/PPT 编译与读回、Case A 冲突、历史导入及重复导入去重。最近 M1 Worker 代码提交为 `7fd1570`；仓库保持 private。
- **M2 本地垂直切片已实现；Worker/Container 尚未部署**：版本化 SourcingPlan；一个 Deep Agents Supervisor 和同类型 Supplier Researcher；严格使用计划中的 question ID/渠道；Tavily Search/Extract；共享 search/fetch/task/model-call 预算；Claim 引文与 Evidence/R2 快照校验；D1 情报账本、R2 快照、项目 Longlist 和运行状态/成本/模型调用指标。D1 migrations `0005`/`0006` 已在远端应用（仅新增表/索引/状态字段）；当前 Worker 尚未包含这些路由。
- 最近一次严格计划映射的 live 本地研究返回 `PARTIAL / BUDGET_EXHAUSTED`：**2 个 Researcher tasks、4 次搜索、4 次抓取、3 个候选、6 条来源支持 Claims、15 次模型调用**；含精确型号 `IPC501-5M-B` 与 `T-BC-IP5M-Z-2` 的公开资料。候选仍是未核实 Longlist；资料中的像素口径、身份和现售情况仍待确认。更早一次 live 重跑也遇到模型端点超时，未将失败冒充成功。
- 最新本地 M2 验收：`pytest` **60 passed**，`npx tsc --noEmit`、Python `compileall` 和本阶段修改文件的 Ruff 检查通过。待 Worker/Container 部署后，运行 `scripts/verify_m2_cloud_api.py` 验证 D1/R2、同项目重复研究、跨项目复用及 LangSmith trace。

本地验证命令：

```bash
uv run --python 3.11 python -m pytest -q
npx tsc --noEmit
uv run --python 3.11 python -m compileall -q src scripts tests
uv run --python 3.11 python scripts/live_m2_research.py --product "industrial IP camera" --minimum-resolution-mp 5
```

live 脚本需要本地 `.env`；它只打印经来源定位的公开结果，不打印密钥，且**不写 Cloudflare D1/R2**。云端 M2 验收脚本读取忽略文件 `.demo_access_token`，不输出 token；migration `0005` 已应用，待 Worker/Container 镜像部署后运行。当前没有 Web UI；M3 规格门禁、比价、Data Fusion 和最终报告仍未开始。详细记录见 `docs/implementation_log.md`。
