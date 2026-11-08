# 采购寻源比价助理 · 技术说明

> 评委与评审用。说明这套系统做什么、它的结论怎么来的、哪些部分有证据、哪些地方有边界。
> 配套材料：[演示素材](m4/demo/README.md)、[接口契约](m4/backend_contract_response.md)、[合规说明](m4/data_compliance.md)。

演示地址：<https://procurement-sourcing-agent.com>

---

## 1. 它解决什么问题

采购人员给出一段文字、一份 PPTX，或者再加一份历史采购明细。系统把这三样东西变成一份可以拿去询价、也可以拿去复核的报告。

它做五件事：

1. **整理需求**。把自然语言拆成采购项、技术约束、计划价格和未决问题，每条约束都带着原文出处。
2. **公开寻源**。在公开网络找候选供应商和具体型号，把页面原样存成快照，保留抓取时间和内容哈希。
3. **核对技术指标**。逐条约束去比对型号的公开声明，给出 `PASS`、`FAIL` 或 `UNKNOWN`。
4. **分析价格**。把计划价、历史成交价、公开参考价、正式报价分开处理，口径不可比时直接说不可比。
5. **给建议、给报告**。按硬性条件的通过情况给出采购建议，并生成可下载的 DOCX。

它输出的是**初步寻源与询价建议**。它不替采购方定标，不发询价函，不下订单，也不做供应商准入。

## 2. 结论是怎么来的

这是本系统与"给个答案"的工具最不一样的地方，所以放在最前面讲。

### 三层判定，各管一件事

| 层 | 谁做 | 产出 | 为什么这样分 |
| --- | --- | --- | --- |
| 打字 | 模型 | 声明的属性键、值、单位、引文 | 只有模型能把"页面上的一句话"变成结构化测量 |
| 对齐 | 模型加人工审校的别名表 | 需求约束与声明是不是同一个测量 | 语义只能由模型判断，但只有人工审校的别名表能纠正模型的标注 |
| 计算 | 纯代码 | 单位换算、数值比较、硬约束汇总 | 数值判断不交给模型，模型也不许改写来源里的数字 |

### 三值判定

- `PASS`：模型确认两边测的是同一个量，代码算完满足要求。
- `FAIL`：语义一致，数值不满足。要求不低于 5MP，来源写 3MP，就是 `FAIL`。
- `UNKNOWN`：证据不足以判断。缺来源、引文只写了别的测量、单位换不了，都落在这里。

汇总规则很简单：任何一条硬性条件 `FAIL`，整体 `FAIL`；任何一条硬性条件 `UNKNOWN`，整体 `UNKNOWN`；全部硬性条件通过且没有未解析需求，才是 `PASS`。

**`UNKNOWN` 不等于不合格。** 它表示"现在还判不了"，页面和报告都会这样写。

### 几条不许越过的线

这些规则写在代码里，也有测试守着：

1. **数值必须能在引文里找到。** 找不到就降级为 `UNVERIFIED`，不拿模型的记忆凑数。
2. **产品名里的数字不是测量值。** 目录标题写着"5MP"，那是商品名，不是分辨率。
3. **同一测量只能有一个键。** `output_resolution`、`video_output_resolution` 这类人工审校过的同义写法归一到同一个键；`sensor_resolution` 不在其中，传感器像素永远不能当输出像素。
4. **多值不由模型拍板。** 多个来源给出同一个测量的不同值时，模型要说明这是"多值"还是"角色不明"。前者由代码判断"是不是每个值都满足要求"，后者保持 `UNKNOWN`。
5. **硬性条件不能被低价抵消。** 进短名单必须同时满足：程序门禁通过、建议档位为建议询价、技术结论为已核验通过、硬性条件整体通过。
6. **价格口径不混算。** 不同口径之间给"不可比"并说明原因，不输出没有依据的"最低价"或"节支比例"。
7. **历史价格只属于它自己的品项。** 只有人工确认的等价关系才能把历史行归到当前品项，光同名不够；整表概览只是概览，不能当单品比价依据。
8. **模拟历史与真实企业分开。** 官方模拟历史供应商始终是独立主体，不与同名真实企业合并。

规则 3 到 7 的测试分别在 `tests/test_judgment_guards.py`、`tests/test_supplier_identity.py`、`tests/test_history_scope.py`、`tests/test_price_context.py`。

### 建议分四档

`建议询价`、`建议排除`、`待补充证据`、`需人工复核`。只有"建议询价"一档通过了硬性条件核对。长名单不等于合格名单。

## 3. 一次分析内部发生了什么

```
浏览器（React，与 API 同源）
   │  HttpOnly 会话 Cookie，浏览器不持有任何凭证
   ▼
Cloudflare Worker：会话、归属校验、限流、预算预约、冻结快照
   │
   ▼
Cloudflare Workflows
   ├── 采购流水线：寻源 → 核验 → 决策 → 冻结
   └── 报告工作流：DOCX 生成与落盘
          │
          ▼
   Python 容器（FastAPI，Deep Agents + LangGraph）
      ├── 需求整理（结构化输出加 Schema 校验）
      ├── 寻源 Supervisor 与研究员（Tavily 搜索与抓取）
      ├── 技术核验：打字 → 对齐 → 确定性计算器
      └── 采购建议与报告（python-docx）
          │
          ▼
   D1（业务数据、快照、判定缓存、审计）  R2（页面快照、DOCX，私有）
```

一次访客点击会依次经历：

1. 浏览器打开页面，`POST /api/session` 换到一枚 HttpOnly 会话 Cookie。
2. 访客建项目、提交需求文字或上传 PPTX 与 XLSX。
3. 访客点"开始分析"。网关做幂等预约与预算预约，创建流水线。
4. 寻源把候选、声明、来源快照写回网关。
5. 核验按冻结的候选与声明判定。
6. 决策按硬性条件门禁给建议。
7. 冻结：把需求修订、候选、声明、核验、决策、价格口径和各快照的哈希合成一份不可变快照。它的 SHA-256 就是 `decision_version`。
8. 决策冻结后自动生成 DOCX 报告。报告失败不回滚已冻结的分析，可以单独重试。

页面刷新、切换历史运行，都读各自冻结的那一版。

### 为什么选这套技术栈

- **网关与重推理分开**：Cloudflare Container 跑模型和检索，Worker 负责强一致的写。D1 的单条条件写入就能原子完成预算预约，不需要额外的锁服务。
- **Workflows 管长任务**：步骤边界、重试、持久化由平台保证，失败阶段被记录而不是静默。
- **冻结快照用内容寻址**：判定输入的每个快照都有哈希，`decision_version` 一变就能发现输入被改过。
- **Deep Agents 适合寻源**：Supervisor 委派加并行研究员加预算上限，正是 deepagents 的形状。

## 4. 证据链与数据合规

每条外部事实都带四样东西：来源 URL、抓取时间、内容 SHA-256、逐字引文。引文里的数字和声明值必须一致，否则这条声明不算数。

判定输入被冻结在快照里，报告里的每个结论都能顺着证据 ID 回到原始页面快照。

合规上有三条硬规定：

- 公开收集的企业与价格是**公开市场情报**，不写成历史采购订单，与内部交易分属两个命名空间。
- 官方素材里的历史采购是**模拟数据**，模拟主体不与同名真实企业合并，页面和报告都会标注。
- 历史价格只在它所属的品项范围内成立，整表概览不能当单品比价依据。

细节见 [数据合规说明](m4/data_compliance.md)。

## 5. 价格口径

系统把价格分成五类，不允许混算：

| 口径 | 含义 |
| --- | --- |
| `PLANNED_PRICE` | 需求里写的计划价 |
| `HISTORICAL_TRANSACTION` | 导入的历史成交价，只在确认的品项范围内成立 |
| `PUBLIC_REFERENCE` | 公开网页上的参考价 |
| `FORMAL_QUOTATION` | 供应商正式报价 |
| `HYPOTHETICAL` | 假设值 |

口径一致才给比较和节支结论。口径不一致时给 `NOT_COMPARABLE` 并说明差在哪，例如"计划单价对整表历史分布"这种比较会被明确拒绝。

需求里的计划价会标出它是单价还是总价（`budget_kind` 为 `PLANNED_UNIT_PRICE` 或 `PLANNED_TOTAL_BUDGET`），页面据此写"计划单价"或"计划预算"。

## 6. 公开接口

访客用得到的是这些：

| 接口 | 用途 |
| --- | --- |
| `POST /api/session` | 建立会话，返回过期时间与身份模式 |
| `POST /api/projects` | 建项目 |
| `POST /api/projects/{id}/requirement-text` | 提交需求文字 |
| `POST /api/projects/{id}/upload-sessions` | 上传 PPTX 或 XLSX |
| `POST /api/projects/{id}/history-imports` | 导入历史采购明细 |
| `POST /api/projects/{id}/requirement-compile` | 整理需求 |
| `POST /api/projects/{id}/pipeline` | 一次点击开始分析，可带 `research_budget` |
| `GET /api/projects/{id}/pipeline/{pipeline_id}` | 进度、阶段、失败原因码、候选与证据计数 |
| `GET /api/projects/{id}/pipelines?active=true` | 刷新后找回进行中的任务 |
| `GET /api/projects/{id}/analysis?pipeline_id=…` | 统一分析结果，冻结的一版 |
| `POST /api/projects/{id}/pipeline/{pipeline_id}/report` | 报告重试 |
| `GET /api/projects/{id}/reports/{report_id}/download` | 下载 DOCX |
| `POST /api/demo/sample` | 取一份已完成的示例运行 |

错误语义统一：`404` 表示资源不存在或不属于你（跨访客访问一律 404，不泄露资源是否存在），`409` 表示版本冲突或快照未就绪，`422` 表示输入不满足约束，`429` 表示限流或预算用完，`503` 表示能力未开启。

完整字段见 [接口契约](m4/backend_contract_response.md)。

## 7. 怎么验证它

### 测试基线

| 层 | 数量 | 命令 |
| --- | --- | --- |
| Python：领域、判定、报告、接口、官方素材回归 | 335 通过 | `uv run --python 3.11 python -m pytest -q` |
| Worker 网关：会话、准入、快照、摘要、判定展示 | 74 通过 | `npm run check` |
| 前端单元测试 | 97 通过 | `cd frontend && npm test` |
| 前端浏览器测试 | 23 通过 | `cd frontend && npm run e2e` |
| 静态检查 | Ruff、`tsc --noEmit`、生产构建全部通过 | — |

### 云端验收记录

| 验收 | 结果 |
| --- | --- |
| B1 一次点击流水线 | `cf_361ade…`：同键复用同一流水线与运行，三阶段完成 |
| B2 冻结版本与自动报告 | `cf_c43976…`：24 个候选与判定，44,335 字节 DOCX，版本与 SHA 核对一致 |
| B3 访客全链路 | `scripts/verify_guest_cloud.py` 实测：两个访客互不可见，一次点击跑完并下载到报告 |
| B4 浏览器联合验收 | 前端在正式地址完成：会话、一次点击、进度、结果与中文摘要、下载、刷新仍是同一版 |

### 复现

```bash
uv run --python 3.11 python -m pytest -q   # Python
npm run check                               # 网关
cd frontend && npm test && npm run e2e      # 前端
uv run --python 3.11 python scripts/verify_guest_cloud.py   # 云端访客全链路
```

## 8. 边界

诚实列出已知限制：

1. **公开地址的网络可达性**。`workers.dev` 在部分网络会被 DNS 投毒，所以正式地址改用自有域名 `procurement-sourcing-agent.com`。仍建议随交付附上录屏。
2. **判定比例取决于来源是否写明所问测量**。来源只写"有效分辨率 5 百万像素"而不区分输出像素与传感器像素时，判定是 `UNKNOWN`，这是语义正确的行为，不是缺陷。只有取到规格书里写明输出分辨率的那一行，才会 `PASS`。一次真实运行的实测：9 个候选、3 个型号、57 份证据，其中 1 条来源明确写出输出分辨率，判为 `PASS`，其余 8 条来源只写有效分辨率，判为 `UNKNOWN`。
3. **PDF 抽取不完整**。规格书经检索服务抽取后常只剩两千字符左右，规格表可能缺失。系统已让每个任务最多取两个规格书页并优先标注规格书结果，但仍会偶发取不到。
4. **一次分析的耗时**。公开寻源与核验都要多次调用模型，一次完整分析通常 10 到 30 分钟。网关拥塞时更久。系统不因此缩短研究，以免用更少证据换更快结论。
5. **预算单位不是金额**。访客预算是并发与日量的粗粒度代理，不是模型调用次数，也不是金额。实际调用仍受寻源内部既有上限约束。
6. **访客并发上限为 2**。同一时刻最多两条访客流水线占用容器实例。
7. **型号多样性有限**。同一型号可能由多个供应商重复提供，页面按型号聚合展示。主动扩大型号覆盖属于后续优化项。

## 9. 演示怎么走

1. 打开 <https://procurement-sourcing-agent.com>。页面自动建立会话，不需要注册。
2. 看示例结果：点"查看示例结果"，会打开一份已完成的运行，1 个型号、23 条发现归并为 3 家供应来源、22 条通过、1 条待核验、29 份证据，报告可直接下载。
3. 跑一次自己的：新建项目，粘贴需求或上传官方 PPTX 与 XLSX，点"开始分析"，看进度、结果与报告。
4. 报告里能看到运行编号与决策版本；刷新页面仍是同一版。

演示用官方素材时，字幕要说明两点：官方 Excel 是模拟采购数据，与公开市场情报分属两个口径；一次完整分析的真实耗时是 20 到 30 分钟。

素材与解说词在 [演示素材](m4/demo/README.md) 和 [解说词](m4/demo_narration.md)。

## 10. 代码在哪

| 关注点 | 位置 |
| --- | --- |
| 网关路由、访客分支、预算 | `cloudflare/gateway/src/index.ts`、`guest_session.ts`、`guest_admission.ts` |
| 流水线编排与冻结快照 | `cloudflare/gateway/src/pipeline_workflow.ts`、`pipeline_store.ts`、`pipeline_final.ts` |
| 分析投影与摘要 | `cloudflare/gateway/src/pipeline_analysis.ts`、`pipeline_summary.ts`、`decision_display.ts` |
| 供应主体归并 | `cloudflare/gateway/src/supplier_identity.ts`、`src/procurement_agent/domain/supplier_identity.py` |
| 容器 API | `src/procurement_agent/api/app.py` |
| 寻源 Agent 与提示词 | `src/procurement_agent/agents/sourcing.py`、`services/sourcing_research.py` |
| 打字、对齐、计算器 | `src/procurement_agent/services/spec_typing.py`、`spec_alignment.py`、`spec_calculator.py` |
| 人工审校的别名表 | `src/procurement_agent/domain/attributes.py` |
| 价格与历史口径 | `src/procurement_agent/services/price_context.py`、`history_analytics.py` |
| 报告生成 | `src/procurement_agent/reports/procurement_report.py` |

## 11. 参考

- [接口契约与逐条回执](m4/backend_contract_response.md)
- [数据合规说明](m4/data_compliance.md)
- [演示素材](m4/demo/README.md)、[解说词](m4/demo_narration.md)
- [产品边界与状态词表](expected_behavior.md)
- [需求 DSL](requirement_dsl.md)
- [仓库](https://github.com/xiangyu474/procurement-sourcing-agent)
