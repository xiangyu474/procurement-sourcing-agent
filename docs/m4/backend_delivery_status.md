# M4 后端交付：代码映射与当前状态

依据 `docs/TODO.md`。本文件区分本地实现和云端验收，不将接口草案视为已交付。

Session：**B3 CLOUD_DEPLOYED（功能关闭、部分） / NOT_PUBLIC_READY**。代码 `42a8387` 经 `414dea5` 部署，`GUEST_SESSION_ENABLED` 仍关闭；新增会话创建和认证请求的全局/访客固定窗口限流、访客 Pipeline 只读和部分响应脱敏。真实本地 Worker + 隔离 D1/R2 已验证 A/B 隔离、Cookie、Origin、限流和并发、自己的 Pipeline 只读及昂贵写操作拒绝；未验证云端 A/B，也未实现严格全局模型成本预算或允许访客启动任务。远端 migration `0016–0018` 已应用。

B2：**CLOUD_VERIFIED（一次受保护验收） / NOT_PUBLIC_READY**。Git `d021de4`、容器 `sourcing-v17`、D1 migration `0015`；验收 `cf_c4397689d684785ec4d5d80b245906b3af996cc05452507410354c34244caafc`，24 个候选/核验/决策，自动生成并通过网关下载 44,335 字节 DOCX，报告版本和 SHA、Run、复用均核对。23 条为 PASS/SHORTLIST、1 条 UNKNOWN/INVESTIGATE，这仅是程序输出，不是独立语义准确性证明。第一次 B2 验收出现旧步骤执行，报告未启动，已终止；后续发现新部署后 Workflow 版本存在传播延迟，经无模型探针确认再重跑成功。原因仍需进一步确认。

B1：**CLOUD_VERIFIED（一次受保护验收） / NOT_PUBLIC_READY**。Git `41a29c7`、容器配置 `sourcing-v15`、D1 migration `0012–0014`；验收 `cf_361ade387f38d46a62670ec3bddb436512812cf2fc9c5a641b5cb531989b283d`，1 需求、32 候选/核验/决策，同键复用同一 Pipeline/Run，三阶段完成；32 条决策均为 UNKNOWN/UNVERIFIED/INVESTIGATE。另以合成缺失历史对象验证阶段 FAILED 被记录。首次启动参数误编码的验收已终止；后续两次分别因容器启动代理错误、模型整理返回不符合 Schema 而失败。上述为 B1 当时的范围；B2 的受保护云端结果见上文，公开访客完整链路仍未验收。

| 顺序 | 代码位置 | 当前状态 / 后续工作 |
| --- | --- | --- |
| Session | `guest_session.ts`, `guest_public.ts`, `index.ts`, migrations `0012/0016/0017` | 基础代码已部署但开关关闭；本地真实 Worker 已验证 A/B 项目/Run/证据/报告隔离、Cookie/Origin、Pipeline 自有只读和限流。未做真实云端/浏览器 A/B 验收。旧无归属项目对访客不可见；管理路径须另行设计。 |
| 总预算与滥用防护 | `guest_session.ts`, `guest_admission.ts`, migrations `0016–0018` | 本地新增全局/IP 会话创建及全局/Session 认证请求限流；新增尚未接入任务入口的 D1 原子预算单位/并发预约原语，并以隔离本地 Worker 并发测试。预约单位不等于金额，也没有约束实际模型/搜索调用；缺少供应商调用逐次扣额、全链路保守上限和失败任务安全回收。频率限制和未接入的预约不能替代部署级成本预算，访客任务仍关闭。 |
| Pipeline | `cloudflare/gateway/src/pipeline_workflow.ts`, `pipeline_store.ts`, `index.ts` | B1/B2 在受保护路径分别完成一次云端验收；B2 快照和自动报告已部署。异常恢复、更多实际 Worker 路由及浏览器联调仍需补充。 |
| Analysis 与版本 | `pipeline_final.ts`, `pipeline_analysis.ts`, `index.ts` | CLOUD_VERIFIED 单次：实际网关分别按 Pipeline/Run 查询得到完全相同响应；旧运行无快照返回 409、跨项目返回 404。多运行切换尚未完成真实浏览器验收。 |
| 决策中文展示 | `decision_display.ts`, `pipeline_analysis.ts` | CLOUD_VERIFIED 单次：基于冻结核验原因码生成中文摘要和通用跟进，原始英文理由/缺口/行动及版本未改变；不是逐条翻译，完整原文中文化仍未实现。 |
| Report | `pipeline_report.ts`, `SourcingReportWorkflow`, `src/procurement_agent/reports/procurement_report.py` | CLOUD_VERIFIED 单次：云端验收及本机实际网关均下载并打开 DOCX，Run/版本和字节 SHA 一致；重复触发复用同一报告。报告启动失败不影响分析、失败重试本地测试通过，云端故障注入/A/B 授权尚未验收。 |
| 前端联调 | `docs/m4/backend_contract_response.md` | §5.1 会话仍为关闭状态、不可用于真实联调；§5.2–§5.4 受保护 Pipeline/Analysis/Report 已有实网样例，公开 Session 和完整链路尚未验收。 |
| 验收 | `scripts/verify_guest_isolation_local.py`, `scripts/verify_guest_admission_local.py`, `scripts/verify_guest_rate_cloud.py` | 本地真实 Worker + 本地 D1/R2 的 A/B、限流和并发预约测试通过。远端 D1 条件写入经 API 的 12 次并发请求恰好允许 5 次，合成记录已清理；此前两次 CLI 并发检查遭网络 `fetch failed`。该结果只验证 D1 条件写入，不等于访客路由、模型预算或云端 A/B 验收。正式验收仍需固定部署 SHA/镜像及完整链路。 |

## 当前安全边界

`GUEST_SESSION_ENABLED` 默认未配置。旧模式使用共享 Bearer，不能作为公开演示的项目隔离；新模式即使启用也缺少严格配额，必须保持关闭。新代码仅放开已归属访客的 Pipeline 读取，启动及耗模型写请求仍受限，不能仅打开开关就完成公开流程。无效 Cookie 等未认证请求不受 Session 请求计数保护，上线前还需边缘滥用防护。共享演示凭证曾在对话中披露，应协调前端代理后轮换；不要将其放入浏览器、日志或 Git。

远端 D1 migration `0012–0018` 已应用；会话迁移只增加可空归属字段，不会自动将已有项目分配给访客。任何历史数据迁移或管理访问策略都需要明确、独立的授权。

## 版本与数据注意事项

`scope_history()` 已移除仅凭同名判定 ITEM 的分支；历史品项需确认等价关系。`TABLE_OVERVIEW` 不能用于单品基准或节支。`UNKNOWN` 不等同于技术通过。现有工作流 PASS、缓存命中和报告可下载不单独证明业务语义正确或版本冻结。
