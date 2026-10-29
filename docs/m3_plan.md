# M3 实施计划

本文是 M3 的执行计划。读完能回答四个问题：M3 分几步做，每一步产出什么文件，数据怎么流，哪些测试证明每一步做对了。

M3 的范围来自《M3验收标准.md》：三个切片 M3-A（需求与产品的语义对齐加确定性计算）、M3-B（历史分析、数据融合、价格可比性）、M3-C（Supervisor 决策与验证闸门）。本轮不重构 M0–M2，不新增 Agent 类型，不做 M4 的前端与报告。

## 阶段划分

M3 切成七个阶段。每个阶段结束时给出实际测试结果和代表性业务案例，并把状态写进 `docs/implementation_log.md`。

| 阶段 | 做什么 | 产出 | 依赖 |
|---|---|---|---|
| M3-0 | 计划与基线审计 | 本文；候选与证据审计；token 归因 | 无 |✅|
| M3-A1 | 契约与纯计算器 | 对齐与评估的数据契约；单位换算表；纯函数计算器与单测 | M3-0 |✅|
| M3-A2 | 声明类型化与语义对齐 | 声明类型化适配器；对齐适配器；编排入口与集成测试 | M3-A1 |✅|
| M3-A3 | 云端接线与真实案例 | D1 迁移；容器端点；Worker 路由；真实 M2 产品的评估结果 | M3-A2 |
| M3-B | 历史分析与价格可比性 | 历史统计；产品等价关系；价格口径与可比性判定 | M3-A2 |
| M3-C | 决策与验证闸门 | Supervisor 决策输出；程序化闸门；决策快照 | M3-A3、M3-B |
| M3-Q | M1/M2 质量补强 | 数字与来源校验；Case 2 回归；约束抽取改进 | 贯穿全程 |第一项 ✅|

M3-Q 里的两项审计（M3-0 的候选与证据审计、token 归因）已经在本阶段完成，其余项随相关切片推进。

## 数据流

```text
需求侧（M1）                              产品侧（M2）              评价（M3）
──────────────────────────────         ──────────────────────    ─────────────────────────
Requirement                       ──▶  ProjectCandidate
  └─ RequirementConstraint               └─ ProductIntelligence
       attribute_key/operator/value          └─ ClaimDraft（自由文本 attribute/value）
       unit/qualifiers/importance               │  声明类型化（M3-A2，LLM + 数字校验）
       source_quote                              ▼
                                              ProductAttributeClaim
                                                attribute_key/value_type/value/unit
                                                qualifiers/evidence_ids/source_quote
                                                     │
SemanticAlignment（M3-A2，LLM 提议 + 代码保守校验）◀┘
  status/method/dimension/unit_conversion/reason
                    │
                    ▼
             Constraint Calculator（M3-A1，纯 Python，无网络无模型）
                    │
                    ▼
             SpecAssessment（M3-A1）
               checks[] / hard_spec_overall / unresolved_question_ids
                    │
                    ▼
        M3-B 历史与价格 │ M3-C Supervisor 决策 → Verification Gate
```

两条边界要守住：

- **评价的最小单位是 Requirement × Product Model（型号）。** 同一企业的不同型号分别评价，不合并成供应商级结论。
- **判定权在计算器，不在模型。** 模型负责把自由文本变成带类型的声明、并提出对齐建议；比较、单位换算、三值逻辑、HARD 聚合全部是确定性代码。模型无法把 UNKNOWN 改成 PASS。

## 文件级实施顺序

### M3-A1：契约与纯计算器（已完成）

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/procurement_agent/domain/spec_alignment.py` | 新增 | `ProductAttributeClaim`、`SemanticAlignment`、`ConstraintCheck`、`SpecAssessment` 四个 Pydantic 契约；`AlignmentStatus`、`AlignmentMethod`、`ConstraintStatus`、`ConstraintReasonCode` 四个枚举；模型侧宽松提案类型 |
| `src/procurement_agent/domain/units.py` | 新增 | 单位换算白名单（Decimal 运算）：长度、功率、电压、频率、像素、像素密度、百分比；`GB` 与 `GiB` 等不可互换项显式列为不可换算 |
| `src/procurement_agent/services/spec_calculator.py` | 新增 | 纯函数：`normalize_value`、`evaluate_constraint`、`aggregate_hard_checks`、`evaluate_requirement_product`。不访问网络，不调用模型，不修改输入 |
| `tests/test_spec_calculator.py` | 新增 | 计算器单测，含 9 条验收要求里全部不依赖模型的情形 |
| `tests/test_spec_alignment_contracts.py` | 新增 | 契约校验：非法值类型、非法算子、缺证据、时间戳、未知字段 |

### M3-A2：声明类型化与语义对齐（已完成）

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/procurement_agent/services/spec_typing.py` | 新增 | 把 M2 的 `ClaimDraft`（自由文本 attribute/value）转成 `ProductAttributeClaim`：模型提议类型与数值，代码复核数值确实出现在 `source_quote` 里，否则降级为 `UNVERIFIED` |
| `src/procurement_agent/services/spec_alignment.py` | 新增 | 对齐适配器：模型提议 `SemanticAlignment`，代码复核 dimension 一致、单位可换算、限定词不冲突；不满足则降级为 `NOT_ALIGNED` 或 `AMBIGUOUS` |
| `src/procurement_agent/services/spec_evaluation.py` | 新增 | 编排入口 `evaluate_project_candidates`：读需求约束与候选声明 → 类型化 → 对齐 → 计算 → `SpecAssessment` 列表 |
| `tests/test_spec_typing.py` | 新增 | 类型化单测：数值与引文不符、单位缺失、属性名不一致 |
| `tests/test_spec_evaluation.py` | 新增 | 集成测试：假模型输出 → 真计算器结果 |

### M3-A3：云端接线与真实案例

| 文件 | 动作 | 内容 |
|---|---|---|
| `cloudflare/gateway/migrations/0007_m3_spec_assessment.sql` | 新增 | `spec_assessments` 表：评估 JSON、需求/型号标识、HARD 汇总结论、计算器版本、被引用的证据 ID、幂等键 |
| `src/procurement_agent/api/app.py` | 修改 | 新增内部端点 `/internal/evaluate-spec`，读需求与候选声明，返回评估结果 |
| `cloudflare/gateway/src/index.ts` | 修改 | 新增 `/api/projects/{id}/spec-assessments` 读取路由与触发评估的路由 |
| `scripts/verify_m3_cloud_api.py` | 新增 | 云端验收：真实 M2 产品的评估、HARD FAIL 拦截、UNKNOWN 保持 UNKNOWN、证据引用可回溯 |
| `docs/data_model.md` | 修改 | 补 `spec_assessments` 表与四个新契约 |

### M3-B：历史分析与价格可比性

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/procurement_agent/domain/pricing.py` | 新增 | 价格口径类型：预算、历史成交价、公开参考价、正式报价；可比性判定结果 |
| `src/procurement_agent/services/history_analytics.py` | 新增 | 历史单价分布、采购量与必要统计；模拟供应商与公网实体隔离 |
| `src/procurement_agent/services/product_equivalence.py` | 新增 | 需求/SKU 与确认的产品等价关系；按等价关系融合，不按供应商名 JOIN |
| `tests/test_history_analytics.py`、`tests/test_price_comparability.py` | 新增 | 无历史数据可分析；不可比价格不产生最低价或节支结论 |

### M3-C：决策与验证闸门

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/procurement_agent/domain/decision.py` | 新增 | 决策快照契约：候选筛选、优先询价建议、证据缺口、下一步调查建议 |
| `src/procurement_agent/services/decision_gate.py` | 新增 | 程序化闸门：HARD FAIL 的型号不得进 RFQ 短名单；UNKNOWN 不得写成已核实 PASS；引用的证据 ID 必须真实存在；报价必须是真实口径 |
| `src/procurement_agent/services/sourcing_decision.py` | 新增 | Supervisor 决策编排：输入精简评估摘要，不回灌原始网页 |
| `tests/test_decision_gate.py` | 新增 | 虚构证据 ID、虚构报价、HARD FAIL 入短名单，三种都要被拦住 |

### M3-Q：M1/M2 质量补强（第一项已完成）

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/procurement_agent/ingestion/compiler.py` | 修改 | 提示词补充：需求文本里出现的客观规格（像素、倍率、防护等级、温度、功率）要抽成带引文的约束，不能只留在品名里 |
| `src/procurement_agent/services/demand_intake.py` | 修改 | 增加数字与来源复核：约束里的数值必须出现在 `source_quote` 中，数量与表格合计可复算 |
| `tests/test_case2_budget_regression.py` | 新增 | Case 2 的 5888.66 与 5888.64 万元差异回归：区分计算错误、原表差异与舍入误差 |

## 验收测试映射

《M3验收标准.md》第三节的九条要求，各自落在哪个测试：

| 验收要求 | 测试位置 | 期望行为 |
|---|---|---|
| 4MP 与最低 5MP 的确定性 FAIL | `test_spec_calculator.py::test_hard_resolution_fails_for_four_megapixel` | 4MP 对 5MP 下限判 FAIL，trace 显示 `4 GTE 5 = false` |
| 单位不同但确实可转换的数值比较 | `test_spec_calculator.py::test_thickness_converts_micrometre_to_millimetre` | 150µm 与 0.2mm 同口径后判 PASS |
| 最大输入功率与额定输出功率不得直接比较 | `test_spec_calculator.py::test_input_power_is_not_rated_output_power` | 判 UNKNOWN / `ATTRIBUTE_NOT_ALIGNED` |
| 有证据但语义不完整时返回 UNKNOWN | `test_spec_calculator.py::test_missing_claim_is_unknown` | 缺声明判 UNKNOWN / `MISSING_CLAIM`，不给 PASS |
| 硬约束 FAIL 被后置 Gate 拦截 | `tests/test_decision_gate.py::test_hard_fail_cannot_enter_rfq_shortlist` | 型号留在长名单，闸门拒绝提升 |
| 无历史数据时正常分析 | `tests/test_history_analytics.py::test_analysis_without_history` | 不造历史结果，只出技术评估 |
| 模拟历史供应商与公网实体隔离 | `tests/test_history_analytics.py::test_synthetic_supplier_never_joins_public_entity` | 模拟供应商不与公网企业关联 |
| 不可比价格不产生最低价或节支结论 | `tests/test_price_comparability.py::test_incomparable_prices_yield_no_saving` | 口径不同则不可比，不给最低价与节支率 |
| Supervisor 虚构 Evidence ID 或报价时被 Gate 拦截 | `tests/test_decision_gate.py::test_fabricated_evidence_and_price_are_rejected` | 两条都拦下并给出原因 |
| 同一企业不同产品型号分别评价 | `test_spec_evaluation.py::test_same_supplier_models_are_evaluated_separately` | 两个型号两条独立结论 |

技术规格的完整测试矩阵（DSL01–DSL22）沿用《Sourcing Agent Requirement DSL Calculator SPEC v1.0》第 9 节，落在 `tests/test_spec_calculator.py` 与 `tests/test_spec_alignment_contracts.py`。

## 预计变更范围

- **新增 Python 文件** 8 个，约 1600 行，其中计算器与对齐约 900 行，测试约 700 行。
- **修改 Python 文件** 4 个：`domain/requirements.py`（必要时补字段）、`ingestion/compiler.py`、`services/demand_intake.py`、`api/app.py`。
- **新增 D1 表** 1 张（`spec_assessments`），M3-B 阶段再加 1–2 张。已有 20 张表不改。
- **新增 API 路由** 2 组（触发评估、读取评估）。
- **Worker 改动** 只加路由，不改 M0–M2 的既有路径。
- **新增验收脚本** 2 个：`verify_m3_cloud_api.py`（M3-A）、`verify_m3_decision_api.py`（M3-C）。
- **不动**：`agents/sourcing.py` 的 Researcher/Supervisor 角色、M2 的搜索与证据链、Cloudflare 拓扑、R2 布局。

## 基线审计结果（M3-0）

### M2 候选与证据的关系

对最近一次通过验收的 M2 冷启动运行（run `4ca31b39`，39 个候选）：

| 指标 | 数值 |
|---|---|
| 候选行 | 39 |
| 独立供应商 | 28 |
| 独立产品 | 17 |
| 独立型号 | 8 |
| 带型号的候选 | 35 |
| 声明总数 | 34（型号级 23，供应商级 11） |
| 有型号级声明的产品 | 10 / 17（59%） |
| 抓取的证据 | 19 |

两个结论影响 M3-A 的设计：

1. **39 个候选实际只有 8 个独立型号。** 重复主要来自供应商名称写法不一致（`LUCID`、`LUCID Vision Labs`、`LUCID Vision Labs, Inc.`）与同一型号的多行候选。M3 的评价单位因此定在型号层，不需要按 39 行去算。
2. **只有 59% 的产品带有型号级声明。** 评价时缺声明的型号必须返回 UNKNOWN，不能按品类相似度默认通过。

### 模型消耗的阶段归因

同一运行 16 次模型调用，266762 输入 token、57954 输出 token、298.6 秒：

| 阶段 | 调用数 | 秒 | 输入 token | 输出 token |
|---|---|---|---|---|
| SUPERVISOR:sourcing_supervisor | 5 | 110.8 | 205017（77%） | 19553 |
| SUPERVISOR:supplier_researcher | 10 | 120.6 | 57844 | 24182 |
| PLAN | 1 | 67.3 | 3901 | 14219 |

Supervisor 自己吃掉 77% 的输入 token，因为每轮的上下文里带着研究器返回的完整声明与引文。这正是《Calculator SPEC》第 7.3 节说的：给决策模型的是精简摘要加 ID，不是原始网页。M3-C 按这个口径做，M3-B 的 Excel 分析结果同样只给摘要。

### 需求侧的现实约束

M1 的模型抽取在官方素材上只产出每条需求 1 个约束（`onenet_access EQ True`），另有 26 条非结构化说明。核对原始 PPTX 后确认这是**正确行为**：官方采购计划表只有品名、数量、单价、销售单价、预算、税率，没有逐项技术参数；那 26 条确实是项目政策、付款条款、模拟样例标注，不该变成约束。

但验收脚本用的 5MP 测试素材暴露了一个真实缺口：需求写的是「5MP 工业网络摄像机」，编译器把 5MP 留在了品名里，没有产出 `resolution GTE 5 MP` 约束。M3-A 的真实案例需要约束，因此 M3-Q 的第一项（提示词补充 + 数字复核）必须先于 M3-A2 的真实案例完成。

## M3-A2 之后要回答的两个问题

真实 M2 数据跑下来暴露了两个具体问题，留给 M3-A3：

1. **研究说的是传感器像素，需求问的是视频输出像素。** 两者不是同一个量，对齐必须拒绝。解决办法有两条：研究阶段要问输出分辨率；需求侧要说清指的是哪个量。
2. **协议类声明的形状。** 真实声明是 `Conforms to ONVIF Profile S`，引文是 `The camera conforms to the ONVIF Profile S specifications.`。字符串值因为不是逐字出现在引文里被拒绝，令牌集合 `ONVIF Profile S` 则通过。类型化提示词应当对协议清单优先给出令牌集合。

## 不做的事

- 不恢复 M1 的固定表头解析器。
- 不为每个品类写分支逻辑。计算器是通用的，换品类只换数据。
- 不让模型生成表达式或代码供服务端执行。
- 不把 UNKNOWN 改写成 PASS，不把公开挂牌价当正式报价。
- 不把历史模拟供应商与现实企业自动关联。
- 不做 M4 的前端页面与 DOCX 报告。
