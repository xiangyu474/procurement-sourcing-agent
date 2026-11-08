# 采购寻源比价助理：技术说明

本文供评委、评审和后续维护人员阅读。系统把采购需求转换为可核验约束，从公开网页发现供应商与具体型号，按统一口径比对规格和价格，并输出带证据快照的网页分析和 DOCX 报告。

| 项目 | 内容 |
| --- | --- |
| 正式演示 | <https://procurement-sourcing-agent.com> |
| 备用地址 | <https://demo.procurement-sourcing-agent.com> |
| 访问方式 | 无需注册，无需密码 |
| 适用场景 | 采购需求整理、公开寻源、型号级技术核验、价格口径分析、询价建议和 DOCX 报告 |
| 核心原则 | 证据不足时保留未知。网页与报告绑定同一决策版本。 |

## 0. 交付清单

| 交付项 | 提交内容 | 评委操作 |
| --- | --- | --- |
| 可运行智能体链接 | <https://procurement-sourcing-agent.com> | 直接打开，创建项目并运行分析。 |
| 演示视频链接 | `待录制上传后填入最终 URL` | 视频不超过 3 分钟，说明问题、方案、使用方式和效果。 |
| 说明文档 | 本文件 | 包含问题、方案、技术栈、创新点、使用说明和数据合规。 |
| 命题场景素材 | 官方 PPTX 需求与官方 XLSX 历史数据 | 可上传到公开地址，复现需求整理、历史导入、寻源、核验、决策和报告生成。 |


### 评委的最短体验路径

1. 打开正式地址，点击“查看示例结果”。页面直接打开一份已经完成的运行，不等待模型调用。
2. 展开任一型号，查看硬约束判定、逐字引文、来源 URL 和内容哈希。
3. 下载 DOCX，核对报告中的运行编号和决策版本。
4. 需要复现实场景时，新建项目并上传官方 PPTX 与 XLSX。完整分析通常需要 20–30 分钟，模型网关拥塞时会更久。

## 1. 问题与方案

### 1.1 问题

采购人员通常先拿到一段需求描述或采购表，再去寻找供应商和型号。通用问答工具可以给出候选清单，但很难回答三个采购问题：

- 型号是否真的满足要求，而不是仅在标题里写了相同参数？
- 这个价格能否与历史价、预算或其他报价直接比较？
- 结论来自哪里，报告与后续的供应商情报更新是否仍然对应同一版本？

### 1.2 方案

系统按以下顺序处理一次采购需求：

1. **整理需求。** 从文字或 PPTX 中提取采购项、技术约束、计划价格和未决问题。每项内容保留来源位置。
2. **公开寻源。** 使用 Tavily Search 发现来源，使用 Tavily Extract 读取页面正文。搜索摘要不进入证据。
3. **核验规格。** 模型负责提取和语义对齐。纯 Python 计算器负责单位换算、数值比较和硬约束汇总。
4. **分析价格。** 计划预算、历史成交价、公开参考价和正式报价分别处理。口径不一致时不生成比较结论。
5. **核验建议。** 程序门禁检查技术结论、候选状态、证据 ID 和价格结论。
6. **冻结并生成报告。** 系统保存本次分析使用的输入、输出和快照哈希。网页与 DOCX 读取同一份冻结快照。

系统提供初步寻源与询价建议。它不替采购方定标，不自动发询价函，不下单，也不做供应商准入。

## 2. 结论如何形成

### 2.1 三层判定

| 层 | 执行者 | 产出 |
| --- | --- | --- |
| 提取 | 模型 | 把来源句子解析为属性、值、单位和引文。 |
| 对齐 | 模型与人工审校的别名表 | 判断需求属性与产品属性是否测量同一个量。 |
| 计算 | 纯 Python | 换算单位、比较数值、汇总硬约束。 |

模型不能改写来源中的数字。单位换算和硬约束汇总不交给模型。

### 2.2 三态技术结论

| 结论 | 含义 |
| --- | --- |
| `PASS` | 语义一致，代码完成比较，且满足要求。 |
| `FAIL` | 语义一致，代码完成比较，且不满足要求。 |
| `UNKNOWN` | 证据、语义或单位不足，暂时无法判断。 |

HARD 表示必须满足的硬性约束。任一 HARD 约束 `FAIL`，整体为 `FAIL`。任一 HARD 约束 `UNKNOWN`，整体为 `UNKNOWN`。全部 HARD 约束通过且没有未解析需求，整体才是 `PASS`。

`UNKNOWN` 不等于不合格。它表示当前证据不足以支持判断。页面和报告都会保留原因和待补资料。

### 2.3 程序门禁

程序会拒绝以下建议：

- 把硬约束 `FAIL` 的型号列入询价短名单。
- 把 `UNKNOWN` 写成已核实通过。
- 引用不存在的证据 ID（Evidence ID）。
- 写出价格分析没有产生的节支额或最低价。
- 在没有技术核验时给出结论。

被拒绝的决定仍会留档，并记录拒绝原因。

### 2.4 采购建议与候选阶段

采购建议有三档：

| 建议 | 含义 |
| --- | --- |
| `SHORTLIST` | 值得优先索取正式资料或报价。 |
| `INVESTIGATE` | 证据仍有缺口，需要补充核验。 |
| `EXCLUDE` | 已有可靠证据表明候选不应进入本次询价范围。 |

候选阶段是另一组字段，表示候选在当前项目中的发现或核验状态。候选阶段与采购建议不能混用。`SHORTLIST` 也不表示供应商已经通过准入或获得定标。

## 3. 创新点

1. **证据链与结论一起交付。** 每项外部声明带来源 URL、抓取时间、内容 SHA-256 和逐字引文。评审人员可以从证据 ID 回到当时的页面快照。
2. **语义判断与数值计算分工。** 模型处理自然语言和属性对齐。代码处理单位、数值和硬约束。人工审校的别名表防止把传感器像素当成输出像素。
3. **证据不足时保留未知。** 缺来源、语义不一致、单位无法换算或来源冲突都会得到 `UNKNOWN`。系统不会用同品类或同系列信息补齐结论。
4. **结论绑定不可变快照。** 需求、候选、证据、核验、决策、价格口径和快照哈希组成一份 `FINAL_CONTEXT`。其 SHA-256 是 `decision_version`。网页和 DOCX 读取同一版本。
5. **价格与历史数据按口径隔离。** 计划预算、历史成交价、公开参考价和正式报价分别处理。历史统计只在确认的产品等价关系内成立。模拟历史主体不与公网企业合并。

## 4. 技术栈与架构

| 层 | 选型 | 职责 |
| --- | --- | --- |
| 前端 | React 19、Vite | 需求输入、运行进度、候选分析、证据查看和报告下载。 |
| 网关 | TypeScript、Cloudflare Workers | 会话、资源归属、Origin 校验、限流、任务预约和公开 API。 |
| 编排 | Cloudflare Workflows | 长任务阶段、重试、超时和终态。 |
| Agent 服务 | Python 3.11、FastAPI、Deep Agents、LangGraph | 需求编译、寻源、规格核验、决策门禁和报告生成。 |
| 模型 | OpenAI 兼容接口 | 结构化需求、声明提取、属性对齐和采购建议。 |
| 检索 | Tavily Search、Tavily Extract | 来源发现与页面正文提取。 |
| 业务数据 | Cloudflare D1 | 项目、需求、情报、证据元数据、核验、决策和快照。 |
| 文件 | 私有 Cloudflare R2 | 上传文件、网页正文快照和 DOCX。 |
| 追踪 | LangSmith | 模型、工具和子任务轨迹。 |

```text
浏览器（React，与 API 同源）
  │  HttpOnly 会话 Cookie
  ▼
Cloudflare Worker
  ├── 会话、归属、限流、预算预约
  ├── D1 读写
  └── Workflows
        ├── 需求整理
        ├── 寻源 → 核验 → 决策 → 冻结
        └── DOCX 报告
              ▼
        Python Container
        ├── Deep Agents：1 个 Supervisor，最多 3 个研究员
        ├── Tavily：来源发现与正文提取
        ├── Python Calculator：单位与数值
        └── python-docx：报告
```

网关与模型推理分开部署。Workflow 负责长任务状态。D1 条件写入完成预算预约和幂等检查。内容哈希保护冻结快照不被静默替换。

## 5. 证据链、安全与数据合规

### 5.1 证据链

外部声明至少记录以下内容：

- 来源 URL。
- 抓取时间。
- 页面正文或 Markdown 快照的内容 SHA-256。
- 页面中的逐字引文。
- 对应的证据 ID。

搜索摘要只用于发现来源，不进入证据。快照保存提取后的文本，不保存网页原始 HTML 或 PDF 二进制。

### 5.2 数据存储

| 数据 | 存储位置 | 保护方式 |
| --- | --- | --- |
| 需求文字与修订元数据 | D1 | 按访客会话归属。 |
| PPTX 原文件 | 私有 R2 | 通过访客授权接口读取。 |
| 历史 XLSX 与标准化数据 | 私有 R2 | 数据集元数据存 D1，按访客会话归属。 |
| 网页正文快照 | 私有 R2 | D1 保存 URL、时间、哈希和定位。 |
| 技术声明、核验与建议 | D1 | 引用稳定 ID 和证据哈希。 |
| DOCX 报告 | 私有 R2 | D1 保存状态、版本和文件 SHA-256。 |
| 模型与工具轨迹 | LangSmith | 使用服务端访问权限。 |

### 5.3 浏览器与外部服务

生产前端不包含模型密钥、检索密钥、内部令牌或运维 Bearer。访客身份由一枚 24 小时有效的 `__Host-ps_session` HttpOnly Cookie 表示。

浏览器本地存储会保存最近项目 ID、标题、状态和最近一次提交的需求文字。当前输入草稿保存在 `sessionStorage`。清空浏览器数据不会删除 D1 或 R2 中的项目。

| 外部服务 | 接收内容 | 不接收内容 |
| --- | --- | --- |
| OpenAI 兼容模型接口 | 当前任务需要的需求片段、来源片段和结构化上下文。 | 访客 Cookie、Bearer 凭证、密钥和其他访客项目。 |
| Tavily Search | 从公开市场信息改写后的研究问题。 | 访客 Cookie、内部供应商名称、订单号、数量、计划价格和项目秘密。 |
| Tavily Extract | 当前研究任务已经发现的公开 URL。 | 私有 URL、访客凭证和未列入当前任务的网址。 |

网页正文和用户上传文件都视为不可信数据，不能改变系统提示或工具权限。研究器没有 Shell、文件系统或通用子任务工具。

### 5.4 访客隔离与滥用防护

项目、运行、分析、证据、报告和下载都绑定 `session_id`。访客 A 读取访客 B 的资源时统一返回 404。404 同时覆盖资源不存在和资源属于其他访客，避免泄露资源存在性。

| 控制 | 当前配置 |
| --- | --- |
| 新会话 | 全局每小时 60 次，每 IP 每小时 10 次。 |
| 已认证请求 | 全局每分钟 600 次，每会话每分钟 120 次。 |
| 任务并发 | 全局 2 个，每访客 1 个。 |
| 访客日额度 | 16 个预算单位，最多 6 次启动。 |
| 全局日额度 | 80 个预算单位。 |

预算单位限制并发和日量。它不是模型调用次数，也不是金额。寻源阶段另有搜索、抓取、任务、轮次和模型调用上限。IP 只保存 HMAC，只作为滥用信号，不作为身份。

### 5.5 模拟历史与数据保留

官方 XLSX 是模拟历史数据。模拟供应商使用独立命名空间，不与同名公网企业自动合并。历史与公网数据只按已确认的产品等价关系融合。页面和报告会标注历史数据为模拟数据。

当前没有自动数据过期或用户自助删除接口。项目、证据和报告的保留周期需要运维或合规负责人另行制定。LangSmith 的轨迹保留期限也由部署方配置。

## 6. 价格口径

价格模型使用四类价格：

| 口径 | 含义 |
| --- | --- |
| `PLANNED_BUDGET` | 需求中的计划单价或计划总预算。 |
| `HISTORICAL_TRANSACTION` | 导入的历史成交价。 |
| `PUBLIC_REFERENCE` | 公开网页上的参考价。 |
| `FORMAL_QUOTATION` | 供应商正式报价。 |

币种、含税口径或计价单位不一致时，价格为 `NOT_COMPARABLE`。公开参考价不能与预算或正式报价计算节支。混合口径的价格会分组显示，不产生跨口径的最低价。

历史数据用 `history_scope` 说明范围：

| 范围 | 含义 | 能否作为单品基准 |
| --- | --- | --- |
| `ITEM` | 当前品项或已确认等价关系对应的历史行。 | 可以。 |
| `TABLE_OVERVIEW` | 整个导入目录的概览。 | 不可以。 |
| `NONE` | 没有可用历史。 | 不可以。 |

## 7. 使用说明

### 7.1 查看示例

1. 打开 <https://procurement-sourcing-agent.com>。
2. 点击“查看示例结果”。页面把一份已完成的冻结运行复制到当前访客会话。
3. 展开型号，查看技术结论、引文和来源。
4. 下载 DOCX，核对运行编号和决策版本。

### 7.2 运行自己的需求

1. 新建项目。
2. 输入需求文字，或上传 PPTX。需要历史背景时，再上传 XLSX 并导入。
3. 点击“开始分析”。页面显示整理需求、寻找供应商、核对技术与价格、整理建议和生成报告的进度。
4. 在结果页核对型号级判定、价格口径和证据。
5. 下载当前决策版本的 DOCX。

### 7.3 主要公开接口

| 接口 | 用途 |
| --- | --- |
| `POST /api/session` | 创建或复用访客会话。 |
| `POST /api/projects` | 创建项目。 |
| `POST /api/projects/{id}/requirement-text` | 提交需求文字。 |
| `POST /api/projects/{id}/upload-sessions` | 上传 PPTX 或 XLSX。 |
| `POST /api/projects/{id}/history-imports` | 导入历史采购明细。 |
| `POST /api/projects/{id}/requirement-compile` | 整理需求。 |
| `POST /api/projects/{id}/pipeline` | 启动完整分析。 |
| `GET /api/projects/{id}/pipeline/{pipeline_id}` | 读取阶段、进度和失败原因码。 |
| `GET /api/projects/{id}/analysis?pipeline_id=…` | 读取指定版本的冻结分析。 |
| `POST /api/projects/{id}/pipeline/{pipeline_id}/report` | 只重试报告。 |
| `GET /api/projects/{id}/reports/{report_id}/download` | 下载 DOCX。 |
| `POST /api/demo/sample` | 获取一份已完成的示例运行。 |

完整字段见 [`docs/m4/backend_contract_response.md`](m4/backend_contract_response.md)。

## 8. 如何验证

### 8.1 本地检查

仓库包含领域模型、规格判定、价格口径、报告、接口、Worker、前端和浏览器测试。运行以下命令：

```bash
uv run --python 3.11 python -m pytest -q
npm run check
cd frontend && npm test && npm run e2e
```

Ruff、TypeScript 类型检查、Python 字节码编译和 Vite 生产构建也包含在本地质量门中。完整命令见 [`docs/acceptance_commands.md`](acceptance_commands.md)。

### 8.2 云端复核

已记录的云端验收覆盖以下行为：

- 正式地址与备用地址返回 200，`GET /api/health` 返回 200。
- `POST /api/session` 返回 201，带有效会话读取项目列表返回 200。
- 两个访客之间的项目、运行、分析和报告不可互访。
- 官方 PPTX 与 XLSX 可以完成需求整理、历史导入、寻源、核验、决策和报告生成。
- 示例运行可以复制到访客会话，冻结分析和 DOCX 可以正常读取。
- 重复启动请求复用同一 Pipeline。报告失败不撤销已冻结的分析。

## 9. 已知边界

1. **完整分析需要 20–30 分钟。** 模型网关拥塞时更久。示例结果可让评委立即检查输出结构。
2. **结论质量取决于来源覆盖。** 来源只写“有效分辨率 5MP”而不区分输出像素与传感器像素时，结论为 `UNKNOWN`。只有取到写明所问测量的规格行，才会 `PASS`。
3. **语义对齐仍依赖模型。** 代码会检查引文、同义表、单位和门禁，但无法证明任意自然语言都理解正确。
4. **PDF 和动态页面仍可能抽取不全。** 系统使用 Tavily Extract 的完整 Markdown 提取，并在任务预算允许时读取第二个规格页。
5. **访客预算不是金额。** 预算单位限制并发和日量。模型调用另受寻源阶段上限约束。
6. **访客并发为 2。** 每位访客同时只能运行一个分析。
7. **没有自动数据删除。** 项目、证据和报告的保留周期需要运维或合规负责人另行制定。
8. **正式报价不会自动取得。** 价格模型支持比较已有正式报价，但系统不自动询价。
9. **供应商身份默认未核实。** 公开名称和域名是观察线索，不构成工商、司法或海关核验。

## 10. 代码导航

以下路径相对仓库根目录。

| 主题 | 位置 |
| --- | --- |
| 网关、访客会话与预算 | `cloudflare/gateway/src/index.ts`、`cloudflare/gateway/src/guest_session.ts`、`cloudflare/gateway/src/guest_admission.ts` |
| Pipeline 与冻结快照 | `cloudflare/gateway/src/pipeline_workflow.ts`、`cloudflare/gateway/src/pipeline_store.ts`、`cloudflare/gateway/src/pipeline_final.ts` |
| 寻源 Agent | `src/procurement_agent/agents/sourcing.py`、`src/procurement_agent/services/sourcing_research.py` |
| 需求 DSL 与编译 | `src/procurement_agent/domain/requirements.py`、`src/procurement_agent/ingestion/compiler.py` |
| 声明提取、对齐与计算 | `src/procurement_agent/services/spec_typing.py`、`src/procurement_agent/services/spec_alignment.py`、`src/procurement_agent/services/spec_calculator.py` |
| 价格与历史口径 | `src/procurement_agent/services/price_context.py`、`src/procurement_agent/services/history_analytics.py` |
| 决策门禁 | `src/procurement_agent/services/decision_gate.py` |
| DOCX 报告 | `src/procurement_agent/reports/procurement_report.py` |
| 前端 | `frontend/src/App.tsx`、`frontend/src/view/`、`frontend/src/components/` |
| D1 schema | `cloudflare/gateway/migrations/` |
