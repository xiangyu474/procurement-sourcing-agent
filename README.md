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

## 当前状态（2026-10-24）

- **M0 云端闭环已实测**：Cloudflare Worker + Container + Workflow + D1/R2；长任务可在浏览器断连时继续，DOCX 写入 R2 并下载；Cloudflare 托管构建，无本机 Docker。
- **M1 已在本地实现并测试**：纯文本、PPTX 需求抽取与受限 Requirement DSL；历史 XLSX 独立可选导入；官方两组材料回归读取到每组 14 个采购行、1000 条历史记录、38 列和第 8 行表头；官方模拟供应商使用独立命名空间；A 案 58/63 万台摘要值保留为未解决冲突。
- 文本编译的 live 模型测试已通过：显式的 7.5 kW 下限进入 HARD/GTE DSL，CAN 接口偏好留为 PREFERENCE；引用经原文定位验证。
- **M1 Cloudflare migration/API 尚未部署**：本地 Worker、D1 migration 与 Container API 代码待用户 review。当前公网 Worker 仍是 M0 版本。
- **M2–M5 尚未开始**：Supervisor/Researcher 池、真实公开寻源与 Product Claims、Supplier Intelligence、Calculator、Data Fusion、Snapshot 及 Web/DOCX 同源报告都还没有实现。不得把 M0 阶段演练的零候选当成真实研究结果。

可重现本地回归：

```bash
uv sync --python 3.11 --extra dev
uv run --python 3.11 python -m pytest -q
uv run --python 3.11 python scripts/live_demand_compile.py
uv run --python 3.11 python scripts/live_official_demand_compile.py --case all
npx tsc --noEmit
```

Live 命令需要本地 `.env`；官方素材从工作区旁的比赛资料目录读取，不复制到本仓库。完整过程、实测限制与 trace 见 `docs/implementation_log.md`。
