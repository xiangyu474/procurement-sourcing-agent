# M4 后端交付：代码映射与当前状态

依据 `docs/TODO.md`。本文件区分本地实现和云端验收，不将接口草案视为已交付。

Session 基础实现：**LOCAL_ONLY / NOT_PRODUCTION_READY**。基线为 main `11f2fae`；实现提交 `e70afe8bb3dd4d4335e1042c4a0b186432d91694`。`GUEST_SESSION_ENABLED` 默认关闭，访客昂贵写操作保持禁用。Node/SQLite 本地测试通过，不代表 Cloudflare Worker 或生产验收。

B2：**CLOUD_VERIFIED（一次受保护验收） / NOT_PUBLIC_READY**。Git `d021de4`、容器 `sourcing-v17`、D1 migration `0015`；验收 `cf_c4397689d684785ec4d5d80b245906b3af996cc05452507410354c34244caafc`，24 个候选/核验/决策，自动生成并通过网关下载 44,335 字节 DOCX，报告版本和 SHA、Run、复用均核对。23 条为 PASS/SHORTLIST、1 条 UNKNOWN/INVESTIGATE，这仅是程序输出，不是独立语义准确性证明。第一次 B2 验收出现旧步骤执行，报告未启动，已终止；后续发现新部署后 Workflow 版本存在传播延迟，经无模型探针确认再重跑成功。原因仍需进一步确认。

B1：**CLOUD_VERIFIED（一次受保护验收） / NOT_PUBLIC_READY**。Git `41a29c7`、容器配置 `sourcing-v15`、D1 migration `0012–0014`；验收 `cf_361ade387f38d46a62670ec3bddb436512812cf2fc9c5a641b5cb531989b283d`，1 需求、32 候选/核验/决策，同键复用同一 Pipeline/Run，三阶段完成；32 条决策均为 UNKNOWN/UNVERIFIED/INVESTIGATE。另以合成缺失历史对象验证阶段 FAILED 被记录。首次启动参数误编码的验收已终止；后续两次分别因容器启动代理错误、模型整理返回不符合 Schema 而失败。没有完成 B2 的完整不可变决策版本、公开 Analysis 或自动 DOCX；不得当作完整产品交付。

| 顺序 | 代码位置 | 当前状态 / 后续工作 |
| --- | --- | --- |
| Session | `cloudflare/gateway/src/guest_session.ts`, `index.ts`, migration `0012` | 本地实现显式会话、同源 Origin 检查和项目/运行/证据归属；默认关闭。需完成真实 Worker 路由、浏览器 A/B 隔离和运行时测试，以及严格限额后才可启用。旧无归属项目对访客不可见；管理路径须另行设计。 |
| 总预算与滥用防护 | 现有 `runs`、`research_run_costs`、Workflow 入口 | 未实现全局原子预约、预算上限和并发控制，也未保护会话创建频率。仅按 session 计数或按地域限流均不足以保证全局预算；尚未启用公开访客任务。 |
| Pipeline | `cloudflare/gateway/src/pipeline_workflow.ts`, `pipeline_store.ts`, `index.ts` | B1 受保护路径一次云端验收 PASS；B2 本地已接入快照和报告终结阶段，尚未验证。异常恢复和实际 Worker 路由测试仍需补充。 |
| Analysis 与版本 | `pipeline_final.ts`, `pipeline_analysis.ts`, `index.ts` | CLOUD_VERIFIED 单次：按指定 Pipeline/Run 返回冻结快照、完整 SHA-256、assessment ID 和价格口径；旧运行无快照返回不可用。多运行切换尚未完成真实浏览器验收。 |
| Report | `pipeline_report.ts`, `SourcingReportWorkflow`, `src/procurement_agent/reports/procurement_report.py` | CLOUD_VERIFIED 单次：自动生成并通过 API 下载、打开，Run/版本和字节 SHA 一致；重复触发复用同一报告。报告启动失败不影响分析、失败重试本地测试通过，云端故障注入/A/B 授权尚未验收。 |
| 前端联调 | `docs/m4/backend_contract_response.md` | §5 仅为本地会话契约草案，未部署，不构成真实联调通知。每个接口部署后再记录固定版本、真实响应与测试结果。 |
| 验收 | `cloudflare/gateway/test/guest_session.test.ts`, `scripts/run_cloud_acceptance.py` | 当前 Node/SQLite 测试不等于 Worker 实际路由或云端验收。正式验收需固定部署 SHA/镜像，A/B 越权、CSRF、限额、幂等、失败恢复、刷新及 DOCX 下载全链路。 |

## 当前安全边界

`GUEST_SESSION_ENABLED` 默认未配置。旧模式使用共享 Bearer，不能作为公开演示的项目隔离；新模式即使启用也缺少严格配额，必须保持关闭。新模式中耗模型的访客写请求暂返回 `operation_unavailable`，因此本地代码不能完成一次点击的完整分析。

会话迁移只增加可空归属字段，不会自动将已有项目分配给访客；任何历史数据迁移或管理访问策略都需要明确、独立的授权。远端迁移状态尚未核实，勿假定 migration 已应用。

## 版本与数据注意事项

`scope_history()` 已移除仅凭同名判定 ITEM 的分支；历史品项需确认等价关系。`TABLE_OVERVIEW` 不能用于单品基准或节支。`UNKNOWN` 不等同于技术通过。现有工作流 PASS、缓存命中和报告可下载不单独证明业务语义正确或版本冻结。
