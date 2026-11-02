# M4 后端交付：代码映射与当前状态

依据 `docs/TODO.md`。本文件区分本地实现和云端验收，不将接口草案视为已交付。

Session 基础实现：**LOCAL_ONLY / NOT_PRODUCTION_READY**。基线为 main `11f2fae`；实现提交 `e70afe8bb3dd4d4335e1042c4a0b186432d91694`。`GUEST_SESSION_ENABLED` 默认关闭，访客昂贵写操作保持禁用。Node/SQLite 本地测试通过，不代表 Cloudflare Worker 或生产验收。

B1 进行中（**LOCAL_IMPLEMENTED，尚无真实云端验收**）：新增受保护、配置开关控制的启动/状态路由和 Pipeline Workflow，绑定需求快照、run、候选、证据、评估和价格/决策上下文；带客户端幂等键，PARTIAL 可继续。新增云端验收模式，但尚未运行。没有完成 B2 的不可变决策版本、公开 Analysis 或自动 DOCX；不得当作完整产品交付。

| 顺序 | 代码位置 | 当前状态 / 后续工作 |
| --- | --- | --- |
| Session | `cloudflare/gateway/src/guest_session.ts`, `index.ts`, migration `0012` | 本地实现显式会话、同源 Origin 检查和项目/运行/证据归属；默认关闭。需完成真实 Worker 路由、浏览器 A/B 隔离和运行时测试，以及严格限额后才可启用。旧无归属项目对访客不可见；管理路径须另行设计。 |
| 总预算与滥用防护 | 现有 `runs`、`research_run_costs`、Workflow 入口 | 未实现全局原子预约、预算上限和并发控制，也未保护会话创建频率。仅按 session 计数或按地域限流均不足以保证全局预算；尚未启用公开访客任务。 |
| Pipeline | `cloudflare/gateway/src/pipeline_workflow.ts`, `pipeline_store.ts`, `index.ts` | 本地实现研究→核验→价格/决策串联及不可变阶段快照；尚待真实云端验证、异常恢复和 Worker 路由测试。报告仍未接入。 |
| Analysis 与版本 | `spec-context`, `decision-context`, `spec_assessments`, `sourcing_decisions` | 尚无统一 `/analysis`。当前部分上下文读取项目最新数据；决策表按项目/需求/候选唯一且会更新，不能视为按运行冻结的历史快照。须增加不可变的运行关联和 assessment/decision 引用。 |
| Report | `SourcingReportWorkflow`, `/internal/projects/{id}/report-context`, `src/procurement_agent/reports/procurement_report.py` | 当前报告上下文读取当前项目数据，`run_id` 不能证明内容属于该运行；摘要并非完整不可变决策快照。必须先修复再用于自动生成当前版本报告。 |
| 前端联调 | `docs/m4/backend_contract_response.md` | §5 仅为本地会话契约草案，未部署，不构成真实联调通知。每个接口部署后再记录固定版本、真实响应与测试结果。 |
| 验收 | `cloudflare/gateway/test/guest_session.test.ts`, `scripts/run_cloud_acceptance.py` | 当前 Node/SQLite 测试不等于 Worker 实际路由或云端验收。正式验收需固定部署 SHA/镜像，A/B 越权、CSRF、限额、幂等、失败恢复、刷新及 DOCX 下载全链路。 |

## 当前安全边界

`GUEST_SESSION_ENABLED` 默认未配置。旧模式使用共享 Bearer，不能作为公开演示的项目隔离；新模式即使启用也缺少严格配额，必须保持关闭。新模式中耗模型的访客写请求暂返回 `operation_unavailable`，因此本地代码不能完成一次点击的完整分析。

会话迁移只增加可空归属字段，不会自动将已有项目分配给访客；任何历史数据迁移或管理访问策略都需要明确、独立的授权。远端迁移状态尚未核实，勿假定 migration 已应用。

## 版本与数据注意事项

`scope_history()` 已移除仅凭同名判定 ITEM 的分支；历史品项需确认等价关系。`TABLE_OVERVIEW` 不能用于单品基准或节支。`UNKNOWN` 不等同于技术通过。现有工作流 PASS、缓存命中和报告可下载不单独证明业务语义正确或版本冻结。
