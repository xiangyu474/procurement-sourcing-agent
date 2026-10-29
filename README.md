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

## 当前状态（M0/M1/M2 已通过云端验收）

- **M0 已实测部署**：Cloudflare Worker + Python Container + Workflow + D1/R2；验证任务在浏览器断连后继续、阶段事件、幂等、失败状态和 DOCX 写入/下载。Container 由 Cloudflare Workers Builds 构建，不需本地 Docker。当前仍未完成 SIGTERM 恢复和精确费用观测；已验证断连时长不等于完整的 2–5 分钟门槛证明。
- **M1 需求抽取已改为模型主导**：PPTX 原文全量按行切分后一次交给模型，模型产出采购行、技术约束、冲突和非结构化需求。原先按固定表头词表抽取 14 条采购行的确定性解析器，以及按引文复核模型读数的校验层，已删除。每组 XLSX 1000 行、38 列、第 8 行表头，模拟供应商隔离不变。代价是需求条数、数量和金额不再由代码保证，结论出处是模型。
- 编译器读回模型的**全部**工具调用。长文档下模型会一行需求一次调用，只读第一次会丢掉其余行。模型有时把整个编译包在 `result` 字段里当作 JSON 字符串，或把金额写成 JSON 字符串，这两种形状都会被读回。
- 需求编译改成 **Workflow 异步执行**。模型读完一整份文档需要几分钟，Worker 请求撑不住这么久。客户端发起编译后轮询结果。
- `scripts/live_official_demand_compile.py` 实测 **PASS**：官方两组 PPTX 各抽到 14 条采购行。Case 1 保留 58 万台与 63 万台的冲突，Case 2 由模型自行算出 5888.66 万元与表格合计 5888.64 万元的差额并报为冲突。`scripts/verify_m1_cloud_api.py` 云端 **PASS**：匿名 401、文本编译读回、官方 PPTX 14 条需求、Case A 冲突、历史导入与重复导入去重。
- **M2 云端验收通过**：`scripts/verify_m2_cloud_api.py` 返回 **PASS**。冷启动一次寻源产出带来源的候选与精确型号，同项目重跑给出复用/刷新/忽略判断，跨项目复用共享情报但不共享项目候选。三段运行的 LangSmith root trace 都能从云端读回，metadata 里的 `sourcing_run_id` 与 D1 的 run 一一对应。
- 部署走 Cloudflare 的 GitHub 构建：每次推 main，构建环境跑 `npm ci` 和 `npx wrangler deploy`，同时构建容器镜像并滚动发布。镜像固定 2 vCPU / 6 GiB，依赖版本在 `pyproject.toml` 里固定。
- **M2 已部署并通过云端验收**：版本化 SourcingPlan；一个 Deep Agents Supervisor 和同类型 Supplier Researcher；精确 question ID/渠道边界；Tavily Search/Extract；共享预算；Claim 引文与 Evidence/R2 快照校验；D1 情报账本、R2 快照、项目 Longlist 和成本/模型调用指标。D1 migrations `0005`/`0006` 已远端应用；Cloudflare LangSmith secret 已配置。
- 工具失败不再中断整轮研究。越界抓取、预算用尽、页面读不出来，都作为可执行指令回到研究器手里，它继续用已抓到的来源作答并把缺口记下来。
- 研究器答成散文而不是结构化工具调用时，系统会带着已抓到的来源再问一次，这次强制要求工具调用。
- 一次严格计划映射的 live 本地研究返回 `PARTIAL / BUDGET_EXHAUSTED`：**2 个 Researcher tasks、4 次搜索、4 次抓取、3 个候选、6 条来源支持 Claims、15 次模型调用**；找到了精确型号 `IPC501-5M-B` 与 `T-BC-IP5M-Z-2` 的公开资料。候选仍是未核实 Longlist，像素口径、身份和现售情况都未作采购结论。其他 live 尝试也曾出现模型超时或没有精确型号；均据实标为 PARTIAL。
- **系统的预期行为**（状态词表、关键行为、失败时的表现、验收方式、已知限制）整理在 `docs/expected_behavior.md`，供交付后的交接使用。
- **M3 已启动**：实施计划见 `docs/m3_plan.md`，DSL 速查见 `docs/requirement_dsl.md`。M3-A1 已完成：需求与产品共用的对齐/评估契约、单位换算白名单，以及一个纯 Python 的约束计算器（不联网、不调模型），能对每条约束给出 PASS/FAIL/UNKNOWN、原因码和计算过程。
- 最新本地验证：`pytest` **124 passed**，`npx tsc --noEmit`、Python `compileall` 和 Ruff 检查均通过。回归测试覆盖复用决策不猜关联、越界抓取的安全拒绝、多个工具调用的合并、JSON 字符串形状的读回、单任务预算上限、页面读不出来时的可恢复处理，以及研究器散文回答后的强制结构化补问。

本地验证命令：

```bash
uv run --python 3.11 python -m pytest -q
npx tsc --noEmit
uv run --python 3.11 python -m compileall -q src scripts tests
uv run --python 3.11 python scripts/live_m2_research.py --product "industrial IP camera" --minimum-resolution-mp 5
```

live 脚本需要本地 `.env`；它只打印经来源定位的公开结果，不打印密钥，且**不写 Cloudflare D1/R2**。云端 M2 验收脚本读取忽略文件 `.demo_access_token`，不输出 token；除访问 token 外还需要本地 `.env` 中的 LangSmith API key 来验证云端真实 trace。当前没有 Web UI；M3 的规格门禁已开工，比价、Data Fusion 和最终报告仍未开始。详细记录见 `docs/implementation_log.md`；全部数据模型的说明见 `docs/data_model.md`；需求 DSL 的字段、类型、算子和常见坑见 `docs/requirement_dsl.md`；交付交接用的预期行为说明见 `docs/expected_behavior.md`。
