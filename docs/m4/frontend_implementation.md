# M4 前端实现说明

这份文件说明前端从哪个接口取哪块数据、页面上每个结论从哪来、前端刻意不做哪些事、哪些已经在真实网关上验过。接口事实以 `docs/m4/backend_contract_response.md` 为准。

代码位置：`frontend/src/`。表格里的接口名就是代码里写的那个路径。

## 1. 前端调用哪些接口

| 接口 | 什么时候调 | 取什么 | 页面上对应哪一块 |
| --- | --- | --- | --- |
| `POST /api/session` | 打开页面 | `expires_at` | 不直接显示，只决定访客身份是否可用 |
| `GET /api/session` | 标签页重新可见 | `expires_at` | 同上 |
| `GET /api/projects?limit=50` | 打开页面 | `id`、`title`、`demand_revision`、`analysis_version`、`latest_run.status` | 左侧项目栏 |
| `POST /api/projects` | 点「创建」 | `project_id` | 左侧项目栏 |
| `GET /api/projects/{id}` | 选中项目 | `sources[]`、`demand_revision`、`analysis_version`、`history_availability` | 需求区、历史导入按钮 |
| `GET /api/projects/{id}/requirement-text` | 选中项目 | `text`、`revision` | 需求文本框 |
| `POST /api/projects/{id}/requirement-text` | 点「开始分析」且文字改过 | `revision` | 需求区 |
| `POST /api/projects/{id}/upload-sessions` | 上传 PPTX 或 XLSX | `source_id`、`revision` | 「已接收」一行 |
| `POST /api/projects/{id}/requirement-compile` | 需求有改动时 | `compile_id` | 「正在整理需求」 |
| `GET /api/projects/{id}/requirement-compile/{compile_id}` | 轮询整理结果 | `status`、`error` | 「正在整理需求」「需求整理失败。」 |
| `GET /api/projects/{id}/requirements` | 整理完成后 | `compilation.requirements`、`compilation.issues`、`compilation.unstructured_requirements` | 「已整理 N 条采购项」和整理提示 |
| `POST /api/projects/{id}/history-imports` | 点「导入历史数据」 | `row_count`、`is_synthetic` | 「已导入历史数据，N 行」 |
| `POST /api/projects/{id}/pipeline` | 点「开始分析」 | `pipeline_id`、`run_id`、`status`、`reused` | 进度行 |
| `GET /api/projects/{id}/pipeline/{pipeline_id}` | 每 3 秒轮询 | `status`、`stage`、`stages[].error_code`、`report_status`、`error` | 进度行、失败原因 |
| `GET /api/projects/{id}/pipelines?active=true&limit=20` | 选中项目、刷新之后 | `pipelines[]` | 找回上一次任务 |
| `GET /api/projects/{id}/analysis?run_id=` | 运行结束后 | 见第 2 节 | 结果表、详情栏、摘要行 |
| `GET /api/projects/{id}/runs` | 选中项目 | `runs[]` | 「过程记录」里的历史运行 |
| `GET /api/runs/{id}` | 轮询运行 | `status`、`current_stage`、`created_at` | 「寻源已结束」等一行 |
| `GET /api/runs/{id}/events` | 轮询运行 | `events[].stage`、`created_at` | 「过程记录」 |
| `GET /api/projects/{id}/reports` | 分析完成后 | `reports[]` | 下载按钮与报告状态 |
| `GET /api/projects/{id}/reports/{report_id}` | 报告生成中 | `status`、`download_path` | 「正在生成报告」 |
| `GET /api/projects/{id}/reports/{report_id}/download` | 点「下载这一版」 | 文件字节 | 下载的 DOCX |
| `POST /api/projects/{id}/reports` | 报告失败后点「重新生成」（运维通道） | `report_id`、`status` | 报告状态 |
| `POST /api/projects/{id}/pipeline/{pipeline_id}/report` | 报告失败后点「重新生成」（访客通道） | `report_id`、`status`、`decision_version` | 报告状态 |
| `GET /api/evidence/{id}` | 点「查看这条来源」 | `title`、`source_url`、`excerpt`、`snapshot_text` | 详情栏里的来源快照 |

`frontend/src/api/client.ts` 里还留着 `listCandidates`、`listAssessments`、`listDecisions`、`getJobStatus`、`getStopReason`、`getResearchSummary`、`startRun` 七个方法。应用不再调用它们，项目级 `/spec-assessments`、`/decisions` 不再是页面的数据来源。

## 2. 结果区的每个数字从哪来

结果区只读 `GET /api/projects/{id}/analysis?run_id=` 这一个接口（点「查看这条来源」时另读 `GET /api/evidence/{id}`）。`?pipeline_id=` 与 `?run_id=` 二选一，前端用 `run_id`，因为「过程记录」里切换历史运行时换的就是运行 id。

| 页面上写的 | 取自 |
| --- | --- |
| N 个型号 | `summary.distinct_models`。后端按型号名聚合，一个型号名不会再被数成两个 |
| N 家供应来源 | `summary.distinct_suppliers` |
| 核验 N 条：满足 N · 不满足 N · 还不能判断 N | `summary.assessments` 与 `summary.by_verdict`，`PASS`/`FAIL`/`UNKNOWN` 依次显示为满足、不满足、还不能判断 |
| 建议询价 N · 待补证 N · 已排除 N | `summary.by_recommendation`，`SHORTLIST`/`INVESTIGATE`/`EXCLUDE` 依次对应 |
| N 份证据 | `summary.evidence` |
| 覆盖提示 | `summary.coverage_warnings[]`，后端给的中文，原样显示 |
| 型号 | `candidates[].product_model`，按 `requirement_id` 与型号名分组 |
| N 家供应商 | 该组内 `supplier_id` 去重后的数量。只有一家时显示供应商名 |
| 阶段 | `decisions[]` 的建议档位 |
| 技术 | `assessments[].hard_spec_overall` |
| 结论摘要 | `decisions[].display.summary_zh` |
| 还差什么 | `decisions[].display.gaps[].text_zh`，同一句话只显示一次 |
| 下一步 | `decisions[].display.next_actions[].text_zh` |
| 还有原始信息待核对 | `decisions[].display.untranslated_originals` |
| 判断句 | `assessments[].checks[]` 的 `constraint_id`、`status`、`reason_code`、`operation`、`normalized_actual`、`normalized_required`、`unit`、`evidence_ids` |
| 来源与摘录 | `evidence[]` 的 `title`、`url`、`quote` |

## 3. 前端不做的事

**不重算结论。** 技术结论、价格口径、节支、建议档位都来自后端。前端唯一的加工是分组和去重，不产生新的判定。

**不翻译原始文本。** `decisions[].rationale`、`decisions[].gaps[]`、`decisions[].next_actions[]` 是英文自由文本，后端没有逐条翻译。前端只显示 `display.*`，并按 `untranslated_originals` 提示还有多少原始内容没翻译。

**不展示内部字段。** 页面上不出现 `r2_key`、`normalized_r2_key`、`snapshot_r2_key`、`locator`、`content_sha256`、`claim_ids`、`workflow_id`、`job_id`、内部阶段名（`SUPERVISOR:` 一类）和 `metrics` 里的 token 数与搜索次数。运行编号只出现在「过程记录」里。

**不显示原始错误文本。** 任务失败时，阶段里的 `error_code` 决定一句中文（`RESEARCH_FAILED` → 「寻源没有完成。」、`MODEL_TIMEOUT` → 「分析超时。」、`DECISION_FAILED` → 「采购建议没有生成，可以再试一次。」、`STAGE_SERVICE_ERROR` → 「这一步没有完成，可以再试一次。」、`SNAPSHOT_MISSING` → 「这次结果没有保存下来，可以再试一次。」）。阶段码优先于任务顶层的 `PIPELINE_STAGE_FAILED`，后者只是笼统的结论。

**不在浏览器里存凭证。** 生产构建不带 Bearer。凭证只存在于开发代理（`frontend/proxyAuth.ts`），浏览器包不引用这个模块。访客身份只有 Worker 签发的 HttpOnly Cookie。

## 4. 按型号展示的口径

结果表的一行是一个「需求 × 型号」。同一型号的多个供应来源收在这一行里，点「展开来源」才展开，不平铺成多行。这与 `docs/expected_behavior.md` 第 6 节「技术核验的最小单位是需求 × 型号」一致。

型号组里的两个结论来自不同粒度：

- **技术结论**取型号级核验。同一型号的各候选共享一条结论，前端用 `assessments[].product_model_ref` 关联。
- **建议档位**按候选给定。`decisions[]` 带 `product_candidate_id`，同一型号下可能有「建议询价」也有「已排除」。

所以档位不一致时前端不合并：该行显示「结论不一致」，展开后逐个供应来源显示各自的档位。一致时直接显示该档位。

「建议询价」只在四个条件同时成立时出现：`accepted === true`、`recommendation === "SHORTLIST"`、`technical_verdict === "VERIFIED_PASS"`、`hard_spec_overall === "PASS"`。少一个就不显示。

## 5. 会话怎么建立

`frontend/src/session/useGuestSession.ts` 不依赖构建环境变量：

1. 打开页面发 `GET /api/session`。200 就能读到身份：访客通道是 `{"mode":"guest"}`，运维通道是 `{"mode":"operator"}`。
2. 访客通道还没有会话时返回 401，这时才发一次 `POST /api/session` 创建。
3. 运维通道下 `POST /api/session` 返回 404。部署里没有这个路由时，前端也按 404 当运维通道处理。

`VITE_GUEST_SESSION=0` 可以完全关掉探测。

会话失效（401 `session_required` 或 `session_expired`）时，`frontend/src/api/client.ts` 自动重建一次会话并重试该请求一次，只重试一次。标签页重新可见时读一次 `GET /api/session`，401 就重建一次。

## 6. 价格四行

价格来自 `price_contexts[]`，按 `requirement_id` 关联。前端不自己算价格，也不自己算节支。

| 页面上的名字 | 取自 |
| --- | --- |
| 计划预算 或 计划单价 | `budget` 加 `budget_currency`、`budget_unit`。`budget_kind` 是 `PLANNED_UNIT_PRICE` 时写「计划单价」，是 `PLANNED_TOTAL_BUDGET` 时写「计划预算」 |
| 历史成交价 | `findings[]` 里 `lowest_basis` 为 `HISTORICAL_TRANSACTION` 的 `lowest_value` |
| 公网参考价 | `findings[]` 里 `lowest_basis` 为 `PUBLIC_REFERENCE` 的 `lowest_value` |
| 正式报价 | `findings[]` 里 `lowest_basis` 为 `FORMAL_QUOTATION` 的 `lowest_value` |

`history_scope` 是 `TABLE_OVERVIEW`，或者 `overview_is_not_a_baseline` 为 true 时，界面上不出现「历史价」和「节支」，也不展示全表数字。`statistics` 只用来给历史成交价补货币和条数。

## 7. 验收分级

| 级别 | 怎么跑 | 能证明什么 |
| --- | --- | --- |
| 夹具 | `npm run e2e`，`frontend/e2e/fixture.ts` 拦截 `**/api/**` | 前端按发布出来的形状渲染。不证明公开链路 |
| 真实浏览器 + 真实网关 | 本地构建，一个把 `/api` 转发到公开网关的同源代理 | 接口对得上，页面读的是真数据 |
| 公开地址 | `https://procurement-sourcing-agent.com` | 评委走的那条链路 |

已经在公开地址上用真实浏览器验过的（2026-11-05）：

- 访客会话：打开页面无 401、无错误框。另一个访客读同一个项目与同一份分析都得到 404，项目列表为空。
- 一次点击：建项目 → 填需求 → 点「开始分析」，进度依次是「正在整理需求」「正在寻找供应商」「正在核对技术与价格」「正在整理采购建议」「正在生成报告」。没有 401。
- 分析接口：结果表、判定分布、型号分组、中文摘要、价格口径都来自 `/analysis`。刷新之后仍是同一个冻结版本。
- DOCX：点「下载这一版」得到 43,913 字节，文件名带项目名与运行时间。
- 快照晚到：运行行先变终态时，页面每 5 秒再问一次，冻结快照写好后结果自己出现，不用刷新页面。
- 失败路径：任务失败时显示阶段自己的原因（一句中文），不显示结果，不显示下载按钮，「再次分析」可点。
- 页面正文没有 `r2_key`、内部 locator、内部阶段名和 token 数。

还没有验的：

- **寻源质量。** 公开地址上那次跑通的 17 条判定全是「还不能判断」，后端给的覆盖提示是「没有任何候选通过硬性核验，结论多为证据不足。」。这说明接口和展示对得上，不说明寻源质量。寻源质量的证据是后端自己的验收：2026-11-03 用**文字需求**跑出过 22 条 PASS/SHORTLIST 加 1 条 UNKNOWN。**结论由这次研究引了哪一行决定**：引到写明「输出分辨率」的规格行就是 PASS，只引到宣传页或型号名里的 5MP 就是 UNKNOWN。后端已把提示词改成引导研究者引规格表那一行（`docs/m4/backend_contract_response.md` §7.7）。所以演示素材要**两种都准备**（官方 PPTX 与文字需求各一份），**以实测跑出 PASS 的那次为准**，不要预设哪一种一定行。

## 8. 已知差距

**报告重试在访客通道。** `POST /api/projects/{id}/pipeline/{pipeline_id}/report` 对访客开放，一次重试计一个预算单位。前端在访客模式下用这个入口，运维通道仍用 `POST /api/projects/{id}/reports`。

**契约缺口清单**在 `docs/m4/backend_contract_response.md` 第 6 节，不在这份文件里重复。
