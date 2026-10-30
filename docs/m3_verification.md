# M3 验收核对

这份文档把《M3验收标准.md》的每一节逐条对着实现和实测结果过一遍。

核对时间：2026-10-28 · 代码版本 `M3` 分支最新提交 · 本地 **228 tests passed**

**总体结论：M3 的三个切片已实现并通过本地验收；云端验收因本机网络被企业侧屏蔽 `*.workers.dev` 而待跑。**

---

## 一、M3 范围

### M3-A：需求与产品的语义对齐 + DSL 计算器

| 验收要求 | 实现 | 证据 | 结论 |
|---|---|---|---|
| 复用现有 Requirement DSL 与 Product Claim Schema，不重新设计平行模型 | 需求侧仍是 `domain/requirements.py`；产品侧新增 `ProductAttributeClaim`，**复用同一套 `ValueType`、`TaxBasis`、`ClaimStatus`** | `domain/spec_alignment.py` | ✅ |
| 将采购要求和具体产品型号的 Claim 对齐 | `services/spec_alignment.py` 的对齐适配器 | `test_spec_alignment_service.py` 13 个用例 | ✅ |
| LLM 负责语义理解、属性对齐和复杂条件分析 | 模型提议类型与配对；代码只做能机械判断的事 | `services/spec_typing.py`、`services/spec_alignment.py` | ✅ |
| Python Calculator 仅执行证据充分、语义可比的基础规则 | 纯函数模块，不联网不调模型 | `test_the_calculator_imports_no_provider_client` | ✅ |
| 支持 PASS / FAIL / UNKNOWN，保留证据及计算过程 | `ConstraintCheck` 带 `operation`、`normalized_actual`、`normalized_required`、`evidence_ids` | `test_spec_calculator.py` 31 个用例 | ✅ |
| 「工业级」等模糊条件不得强行数值化，也不得默认为满足 | 编译器提示词明确这类话不是约束；需求侧无硬约束 → `UNKNOWN`；有未决需求 → `UNKNOWN` | `test_a_vague_demand_is_not_a_constraint_and_not_satisfied`、`test_an_unresolved_demand_keeps_the_overall_unknown` | ✅ |
| 技术核验以 Requirement × Product Model/Variant 为最小单位 | 评估按型号分组；两个型号分别判定 | `test_two_models_of_one_supplier_are_judged_separately` | ✅ |

### M3-B：历史分析 + Data Fusion + 价格可比性

| 验收要求 | 实现 | 证据 | 结论 |
|---|---|---|---|
| 历史 Excel 可选，没有数据也能继续 | `build_price_context` 在没有历史时返回 `available=False` 的上下文 | `test_analysis_without_history_still_works` | ✅ |
| 基于真实字段计算历史单价分布、采购量及必要统计 | 条数、最小、最大、中位、均值、P25/P75、采购量 | `test_the_distribution_uses_the_real_fields` | ✅ |
| 模拟历史供应商不得自动映射现实企业 | 模拟命名空间单独成组，永不并入公网企业 | `test_a_simulated_supplier_stays_simulated`、`test_the_simulated_history_stays_away_from_the_public_company` | ✅ |
| 以 Requirement/SKU 和确认的产品等价关系融合，不按供应商名 JOIN | 融合键是确认过的等价关系；同名供应商无确认等价则不合 | `test_the_same_supplier_name_never_creates_a_group`、`test_records_are_fused_by_equivalence_not_by_supplier_name` | ✅ |
| 区分预算、历史成交价、公开参考价和正式报价 | 四种 `PriceBasis`，可比对矩阵显式 | `domain/pricing.py`、`services/price_analysis.py` | ✅ |
| 价格口径不足时标记不可直接比较，不计算虚构节支率 | 混口径的集合整体判不可比；挂牌价不产生节支 | `test_incomparable_prices_yield_no_saving`、`test_a_listing_against_a_budget_gives_no_saving`、`test_a_set_that_mixes_bases_gives_no_lowest_price` | ✅ |

### M3-C：Supervisor 决策 + 验证闸门

| 验收要求 | 实现 | 证据 | 结论 |
|---|---|---|---|
| Supervisor 基于结构化分析生成候选筛选、优先询价建议、证据缺口及下一步调查建议 | 决策含 `recommendation`、`priority_rank`、`gaps`、`next_actions` | `services/sourcing_decision.py` | ✅ |
| 硬规格 FAIL 的具体型号不得进入 RFQ Shortlist | 闸门拦截 | `test_a_hard_failure_cannot_enter_the_short_list` | ✅ |
| UNKNOWN 不得改写为已核实 PASS | 技术结论是三值字段，闸门与评估比对 | `test_an_unknown_cannot_be_written_down_as_a_verified_pass` | ✅ |
| 决策输出后增加程序验证，核查候选状态、价格结论及 Evidence 引用 | 闸门查三类：候选状态、价格结论、证据引用 | `test_decision_gate.py` 12 个用例 | ✅ |
| M3 只交付结构化决策结果，不开发最终 Web UI 或 DOCX 报告 | 没有新增前端或报告模块 | 仓库 diff | ✅ |

---

## 二、针对 M1/M2 的质量补强

| # | 要求 | 实现 | 证据 | 结论 |
|---|---|---|---|---|
| 1 | 不恢复固定表头解析器，但增加数字与来源校验 | 提示词 + 确定性校验：引文须在片段内、数值须在引文内（含量纲换算）；数量/金额被核对但不修改 | `services/requirement_verification.py`，`test_requirement_verification.py` 16 个用例 | ✅ |
| 2 | Case 2 的 5888.66 与 5888.64 差异作为回归测试，区分计算错误/原表差异/舍入误差 | 重算 14 行合计 = 5888.64；未取整行列合计 = 5888.656 → 即文档的 5888.66；分类为 ROUNDING | `tests/test_case2_budget_regression.py` | ✅ |
| 3 | 审计 M2 的候选与证据关系 | 39 候选 → 28 供应商 / 17 产品 / **8 型号**；35/39 有型号码；型号级声明覆盖 **10/17（59%）** | `docs/m3_plan.md` 基线审计 | ✅ |
| 4 | 在 LangSmith 定位 token 消耗来源 | 16 次调用 266,762 输入 / 57,954 输出；**Supervisor 占输入的 77%**（每轮带着研究器的完整声明） | `docs/m3_plan.md` 基线审计 | ✅ |
| 5 | 不把历史或网页数据未经确认的技术语义视为已标准化 | 未确认的等价关系不进索引；属性键对不上时对齐被拒；未对齐即 UNKNOWN | `test_an_unconfirmed_attribute_is_not_treated_as_standardised`、`test_only_a_confirmed_equivalence_enters_the_index` | ✅ |

---

## 三、测试要求逐条

| 验收要求 | 测试 | 实际结果 |
|---|---|---|
| 4MP 与最低 5MP 的确定性 FAIL | `test_four_megapixel_fails_a_five_megapixel_minimum` | `4 MP GTE 5 MP` → FAIL |
| 单位不同但确实可转换 | `test_micrometre_thickness_converts_to_millimetre` | `0.15 mm LTE 0.2 mm` → PASS |
| 最大输入功率 ≠ 额定输出功率 | `test_input_power_is_not_rated_output_power` | UNKNOWN / `ATTRIBUTE_NOT_ALIGNED` |
| 有证据但语义不完整时返回 UNKNOWN | `test_missing_claim_is_unknown` | UNKNOWN / `MISSING_CLAIM` |
| 硬约束 FAIL 被后置 Gate 拦截 | `test_a_hard_failure_cannot_enter_the_short_list` | 决策被拒，记录失败原因 |
| 无历史数据时正常分析 | `test_analysis_without_history_still_works` | 上下文正常生成，历史为空 |
| 模拟历史供应商与公网实体隔离 | `test_a_simulated_supplier_stays_simulated` | 模拟 ID 单列，不进公网列表 |
| 不可比价格不产生最低价或节支结论 | `test_incomparable_prices_yield_no_saving` | 无最低价、无节支 |
| Supervisor 虚构 Evidence ID 或报价被拦 | `test_a_fabricated_evidence_id_is_rejected`、`test_a_fabricated_saving_is_rejected` | 两条都拒 |
| 同一企业不同产品型号分别评价 | `test_two_models_of_one_supplier_are_judged_separately` | 两个型号两条独立结论 |

技术规格的完整矩阵（DSL01–DSL22）落在 `tests/test_spec_calculator.py`（31 个）与 `tests/test_spec_alignment_service.py`（13 个）。

---

## 四、部署、成本与可靠性

| 要求 | 状态 |
|---|---|
| M3 可先本地开发和测试，不因 CI 问题停止 | ✅ 本地 228 tests passed，ruff 全绿，`tsc --noEmit` 通过 |
| 限时排查 Cloudflare GitHub Builds 触发问题，保留可复现的手动部署与回滚路径 | 触发器正常（M2 阶段已定位过一次构建环境故障）。M3 的三个构建 `af318a4`/`6b512e9`/`4e7390d` 均成功。手动路径：`npx wrangler deploy` |
| 先核实真实模型单价及 LangSmith 用量归集，再确定货币预算 | ⚠️ **单价核实不到**：模型网关 `token.moi.matrixorigin.cn` 的 `/models` 不返回价格字段，`/billing`、`/account`、`/balance` 均 404。**token 用量已实测**（见下），货币预算需要人从平台控制台取单价 |
| Token 和运行时间限制应配置化，不能仅靠 Prompt 提醒模型 | ✅ `MODEL_TIMEOUT_SECONDS`、`MODEL_MAX_OUTPUT_TOKENS`、`M3_SPEC_TYPING_BATCH_SIZE`、`M3_SPEC_ALIGNMENT_CANDIDATES` 均为环境变量；M3 的三个阶段都接受运行配置（可挂 token 计数器与调用预算） |
| SIGTERM 中断后的可靠恢复登记为 M5 必须完成的验收 | ✅ 登记在 `docs/expected_behavior.md` 第八节「已知限制」第 6 条，未宣称已解决 |

### 实测 token 用量（M3-A，真实 M2 数据）

用 `scripts/live_m3_token_profile.py` 在真实的 M2 冷启动运行（39 候选 / 99 声明 / 8 个型号组）上跑了一次技术核验：

| 指标 | 值 |
|---|---|
| 模型调用 | 8 次（7 次类型化分批 + 1 次对齐） |
| 输入 token | 18,154 |
| 输出 token | 86,933 |
| 耗时 | 563 秒（9.4 分钟） |
| 单次平均 | 2,269 输入 / 10,867 输出 / 70.4 秒 |

**输出 token 是输入的 4.8 倍**，因为 `glm-5.3-flash` 是推理模型，输出里大部分是思考内容。这是预算时最容易被忽略的一项。

一次 M2 冷启动寻源（对照）：4 搜索 / 4 抓取 / 16 次模型调用 / 266,762 输入 / 57,954 输出 / 298.6 秒。

---

## 五、交付要求

| 要求 | 状态 |
|---|---|
| 先提交文件级实施顺序、数据流、验收测试映射、变更范围，再实施 | ✅ `docs/m3_plan.md`（M3-0 阶段先交） |
| 每完成一个切片给出实际测试结果和代表性业务案例 | ✅ M3-A：真实 LUCID `TRI050S-CC` 的 `5 MP GTE 5 MP` PASS；M3-B：Case 2 的 5888.66/5888.64 判定为舍入误差；M3-C：闸门 8 条规则 |
| M3-A 的优先样例使用 M2 已发现的真实产品及其技术证据 | ✅ 用的是 M2 真实运行 `4ca31b39` 的候选、型号与引文 |
| 保持仓库 private，不上传密钥、真实内部采购数据或参赛素材 | ✅ 全程 private；素材在仓库外；密钥只进环境变量 |
| M4 前端继续遵循极简 Chat-first + DOCX 下载按钮，不建设双端完整报告 | ✅ 本轮没有前端代码 |

---

## 六、云端验收结果

云端验收已通过。因为本机网络屏蔽了 `*.workers.dev`，验收改为在 Cloudflare 侧（容器内）运行，由工作流启动、结果从实例输出读回。

| 阶段 | 实测 |
|---|---|
| M1 | 1 条需求、1 条约束，编译完成 |
| M2 | 寻源运行 COMPLETED，21 个候选 |
| M3-A | 21 个评估：5 个 PASS、16 个 UNKNOWN |
| M3-C | 21 条决策：5 条 SHORTLIST、16 条 INVESTIGATE，全部被采纳，0 条被拒 |

5 个 PASS 都是真判定，各带计算过程和证据：`CAM-CIC-5000-20-G`、`TRI050S-MC`、`TRI050S-QC` 满足「不低于 5MP」，计算过程 `5 MP GTE 5 MP`，并引用了具体的证据 ID。16 个 UNKNOWN 都点名了被拒的声明和理由。

决策与判定一致：通过的进短名单且标 VERIFIED_PASS，判断不了的标 INVESTIGATE 且标 UNVERIFIED；没有虚构证据 ID，没有把 UNKNOWN 写成通过。

**为了让这条路走通，修了四件事，每一件都是值得记住的事实**：

1. **运行中的容器保留它启动时的镜像。** 部署后热实例仍在跑旧镜像，新端点 404。实例名现在是配置项，换新镜像就是改一个名字。
2. **等待放在工作流里，不放在容器请求里。** 一次请求扛完编译、寻源、核验、决策，2 分半后连接被断。现在每个请求只做一件短事，工作流反复问直到阶段说完成。
3. **验收要用自己的容器实例。** 它驱动公开 API，而公开 API 会启动工作流去调容器；共用一个实例就是自己等自己。
4. **编译器的输出有多种形状。** 需求行可能在列表里、可能和约束字段平铺、可能在单独的顶层键下。只认一种形状会让编译变空，验收报「没有可识别的需求」。三种形状现在都认。

## 七、尚未完成与已知限制

1. **本机跑不了直连的验收脚本**（`verify_m1/m2/m3_cloud_api.py`、`verify_m3_decision_api.py`）：本机所在企业网络把 `*.workers.dev` 解析到内网黑洞地址（`128.242.240.91`），其他域名正常，且同一台机器在当天早些时候还能访问 Worker，说明是会话期间被启用的策略。**验收已在 Cloudflare 侧跑通**（`scripts/run_cloud_acceptance.py`）。网络恢复后，直连脚本仍应再跑一遍，作为交叉验证。
2. **模型单价核实不到**，货币预算需要人从平台控制台取单价后计算。token 用量已实测到位。
3. **M2 的研究说传感器像素，需求问视频输出像素**，对齐会拒绝（这是正确行为），但要真正判定，需要研究阶段改问输出分辨率，或需求侧说清指的是哪个量。留作 M3 之后的调研改进口径。
4. **一个真实输入样本的抽取稳定性**只验证过官方 PPTX 两种 + 验收用的小 PPTX。
5. **运行时日志未接入**：该账号没有配置 Workers Logs 的 dataset，容器异常只能靠返回体里的错误类型与脱敏消息判断。
6. **SIGTERM 中断后的可靠恢复**属于 M5。

## 七、代表案例（M3-A，真实数据）

需求（本地用当前编译器编译，5MP 工业网络摄像机）→ 约束 `output_resolution GTE 5 MP`。
产品与引文来自 M2 真实运行 `4ca31b39`。

| 型号 | 结论 | 原因 |
|---|---|---|
| LUCID `TRI050S-CC` | **PASS** `5 MP GTE 5 MP` | 声明写的是「5MP (3K) resolution at 30 fps」，是视频输出分辨率 |
| LUCID `TRI055N` | UNKNOWN | 声明量的是接口类型与 IP67 环境 |
| Cognex `CAM-CIC-5000R-14-G` | UNKNOWN | 声明是触发/频闪同步信号 |
| `NBN-80052-BA` | UNKNOWN | 声明覆盖输出分辨率、系列、供货状态、传感器格式、防护等级、输入功率，没有一条说 ONVIF |

这条案例说明了三件事：数字对上了不等于可比较（传感器像素 ≠ 输出像素）；缺什么要写出来（每个 UNKNOWN 都点名被拒的声明）；同一企业的不同型号分别判定。
