# M4 双 Agent 统筹决策

现在两条开发线已经走到了需要正式集成的阶段。我建议从今天开始，把目标从“分别完成后端 TODO 和前端功能”切换为：

交付一条真实、可恢复、可公开体验的采购任务链路。

我已经替你拍板报告自动生成问题，同时对后端清单做了优先级调整。

## 一、先拍板：报告自动生成，选 A

决策完成后，后端自动生成正式 DOCX。

但有一个重要细节：DOCX 生成是自动执行的独立收尾阶段，生成失败不能推翻已经成功的采购决策。

\#chatgpt-mermaid-\_r_nb\_{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;fill:rgb(13, 13, 13);}@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}@keyframes dash{to{stroke-dashoffset:0;}}#chatgpt-mermaid-\_r_nb\_ .edge-animation-slow{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 50s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_nb\_ .edge-animation-fast{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 20s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_nb\_ .error-icon{fill:rgb(243, 243, 243);}#chatgpt-mermaid-\_r_nb\_ .error-text{fill:rgb(13, 13, 13);stroke:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_nb\_ .edge-thickness-normal{stroke-width:1px;}#chatgpt-mermaid-\_r_nb\_ .edge-thickness-thick{stroke-width:3.5px;}#chatgpt-mermaid-\_r_nb\_ .edge-pattern-solid{stroke-dasharray:0;}#chatgpt-mermaid-\_r_nb\_ .edge-thickness-invisible{stroke-width:0;fill:none;}#chatgpt-mermaid-\_r_nb\_ .edge-pattern-dashed{stroke-dasharray:3;}#chatgpt-mermaid-\_r_nb\_ .edge-pattern-dotted{stroke-dasharray:2;}#chatgpt-mermaid-\_r_nb\_ .marker{fill:rgb(143, 143, 143);stroke:rgb(143, 143, 143);}#chatgpt-mermaid-\_r_nb\_ .marker.cross{stroke:rgb(143, 143, 143);}#chatgpt-mermaid-\_r_nb\_ svg{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;}#chatgpt-mermaid-\_r_nb\_ p{margin:0;}#chatgpt-mermaid-\_r_nb\_ .label{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";color:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_nb\_ .cluster-label text{fill:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_nb\_ .cluster-label span{color:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_nb\_ .cluster-label span p{background-color:transparent;}#chatgpt-mermaid-\_r_nb\_ .label text,#chatgpt-mermaid-\_r_nb\_ span{fill:rgb(13, 13, 13);color:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_nb\_ .node rect,#chatgpt-mermaid-\_r_nb\_ .node circle,#chatgpt-mermaid-\_r_nb\_ .node ellipse,#chatgpt-mermaid-\_r_nb\_ .node polygon,#chatgpt-mermaid-\_r_nb\_ .node path{fill:rgb(222, 234, 251);stroke:rgb(83, 154, 248);stroke-width:1px;}#chatgpt-mermaid-\_r_nb\_ .rough-node .label text,#chatgpt-mermaid-\_r_nb\_ .node .label text,#chatgpt-mermaid-\_r_nb\_ .image-shape .label,#chatgpt-mermaid-\_r_nb\_ .icon-shape .label{text-anchor:middle;}#chatgpt-mermaid-\_r_nb\_ .node .katex path{fill:#000;stroke:#000;stroke-width:1px;}#chatgpt-mermaid-\_r_nb\_ .rough-node .label,#chatgpt-mermaid-\_r_nb\_ .node .label,#chatgpt-mermaid-\_r_nb\_ .image-shape .label,#chatgpt-mermaid-\_r_nb\_ .icon-shape .label{text-align:center;}#chatgpt-mermaid-\_r_nb\_ .node.clickable{cursor:pointer;}#chatgpt-mermaid-\_r_nb\_ .root .anchor path{fill:rgb(143, 143, 143)!important;stroke-width:0;stroke:rgb(143, 143, 143);}#chatgpt-mermaid-\_r_nb\_ .arrowheadPath{fill:rgb(143, 143, 143);}#chatgpt-mermaid-\_r_nb\_ .edgePath .path{stroke:rgb(143, 143, 143);stroke-width:1px;}#chatgpt-mermaid-\_r_nb\_ .flowchart-link{stroke:rgb(143, 143, 143);fill:none;}#chatgpt-mermaid-\_r_nb\_ .edgeLabel{background-color:rgb(252, 252, 252);text-align:center;}#chatgpt-mermaid-\_r_nb\_ .edgeLabel p{background-color:rgb(252, 252, 252);}#chatgpt-mermaid-\_r_nb\_ .edgeLabel rect{opacity:0.5;background-color:rgb(252, 252, 252);fill:rgb(252, 252, 252);}#chatgpt-mermaid-\_r_nb\_ .labelBkg{background-color:rgba(252, 252, 252, 0.5);}#chatgpt-mermaid-\_r_nb\_ .cluster rect{fill:rgb(243, 243, 243);stroke:rgba(0, 0, 0, 0.1);stroke-width:1px;}#chatgpt-mermaid-\_r_nb\_ .cluster text{fill:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_nb\_ .cluster span{color:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_nb\_ div.mermaidTooltip{position:absolute;text-align:center;max-width:200px;padding:2px;font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:12px;background:rgb(243, 243, 243);border:1px solid rgba(0, 0, 0, 0.1);border-radius:2px;pointer-events:none;z-index:100;}#chatgpt-mermaid-\_r_nb\_ .flowchartTitleText{text-anchor:middle;font-size:18px;fill:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_nb\_ rect.text{fill:none;stroke-width:0;}#chatgpt-mermaid-\_r_nb\_ .icon-shape,#chatgpt-mermaid-\_r_nb\_ .image-shape{background-color:rgb(252, 252, 252);text-align:center;}#chatgpt-mermaid-\_r_nb\_ .icon-shape p,#chatgpt-mermaid-\_r_nb\_ .image-shape p{background-color:rgb(252, 252, 252);padding:2px;}#chatgpt-mermaid-\_r_nb\_ .icon-shape .label rect,#chatgpt-mermaid-\_r_nb\_ .image-shape .label rect{opacity:0.5;background-color:rgb(252, 252, 252);fill:rgb(252, 252, 252);}#chatgpt-mermaid-\_r_nb\_ .label-icon{display:inline-block;height:1em;overflow:visible;vertical-align:-0.125em;}#chatgpt-mermaid-\_r_nb\_ .node .label-icon path{fill:currentColor;stroke:revert;stroke-width:revert;}#chatgpt-mermaid-\_r_nb\_ .node .neo-node{stroke:rgb(83, 154, 248);}#chatgpt-mermaid-\_r_nb\_ [data-look="neo"].node rect,#chatgpt-mermaid-\_r_nb\_ [data-look="neo"].cluster rect,#chatgpt-mermaid-\_r_nb\_ [data-look="neo"].node polygon{stroke:url(#chatgpt-mermaid-\_r_nb\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_nb\_ [data-look="neo"].swimlane.cluster rect{filter:none;}#chatgpt-mermaid-\_r_nb\_ [data-look="neo"].node path{stroke:url(#chatgpt-mermaid-\_r_nb\_-gradient);stroke-width:1px;}#chatgpt-mermaid-\_r_nb\_ [data-look="neo"].node .outer-path{filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_nb\_ [data-look="neo"].node .neo-line path{stroke:rgb(83, 154, 248);filter:none;}#chatgpt-mermaid-\_r_nb\_ [data-look="neo"].node circle{stroke:url(#chatgpt-mermaid-\_r_nb\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_nb\_ [data-look="neo"].node circle .state-start{fill:#000000;}#chatgpt-mermaid-\_r_nb\_ [data-look="neo"].icon-shape .icon{fill:url(#chatgpt-mermaid-\_r_nb\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_nb\_ [data-look="neo"].icon-shape .icon-neo path{stroke:url(#chatgpt-mermaid-\_r_nb\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_nb\_ .node text{font-size:14px;font-weight:600;letter-spacing:normal;fill:rgb(0, 79, 153);}#chatgpt-mermaid-\_r_nb\_ .edgeLabels text{font-size:13px;font-weight:600;letter-spacing:-0.08px;fill:rgb(0, 79, 153);}#chatgpt-mermaid-\_r_nb\_ .node tspan[font-weight="normal"],#chatgpt-mermaid-\_r_nb\_ .edgeLabels tspan[font-weight="normal"]{font-weight:600;}#chatgpt-mermaid-\_r_nb\_ .edgeLabel .label rect{opacity:1;rx:13px;ry:13px;fill:rgb(245, 250, 255);stroke:rgb(206, 219, 229);stroke-width:1px;}#chatgpt-mermaid-\_r_nb\_ .node rect,#chatgpt-mermaid-\_r_nb\_ .node circle,#chatgpt-mermaid-\_r_nb\_ .node ellipse,#chatgpt-mermaid-\_r_nb\_ .node polygon,#chatgpt-mermaid-\_r_nb\_ .node path{fill:rgb(229, 243, 255);stroke:rgba(0, 0, 0, 0.1);stroke-width:1px;}#chatgpt-mermaid-\_r_nb\_ .node rect{rx:16px;ry:16px;}#chatgpt-mermaid-\_r_nb\_ .mermaid-decision .label-container{fill:rgb(245, 250, 255);stroke:rgb(206, 219, 229);stroke-dasharray:2,2;}#chatgpt-mermaid-\_r_nb\_ .edgePaths .flowchart-link{stroke:rgb(143, 143, 143);stroke-width:1px;stroke-linecap:round;stroke-linejoin:round;}#chatgpt-mermaid-\_r_nb\_ .marker{fill:rgb(143, 143, 143);stroke:rgb(143, 143, 143);}#chatgpt-mermaid-\_r_nb\_ :root{--mermaid-font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";}用户提交需求一次点击：开始分析M2 寻源M3 技术核验 + 价格分析M3 决策 + 验证门禁冻结决策版本自动生成 DOCX报告可下载报告生成失败保留决策，允许重新生成报告失败

这比要求用户再点击一次“生成报告”更自然，也符合 Chat-first 的交互定位。

保留前端已经完成的按需生成逻辑，作为旧版本报告或自动生成失败后的后备路径；正常情况下，报告生成完成后按钮直接变为“下载这一版”。

自动生成必须绑定具体的 `decision_version` 和 `pipeline_id`，不能通过项目的 `latest` 决策来猜测。

## 二、我对后端 TODO 的三项关键修订

修订 1：不要首次访问任意 `/api/*` 就偷偷签发会话

建议保留明确的 `POST /api/session` 创建/续用和 `GET /api/session` 查询。

前端启动时显式初始化会话即可。这样登录态、失效、测试和错误码都更清楚，也不会让非法或未授权 API 请求顺手建立新会话。

修订 2：Origin 缺失不能无条件放行写请求

本地开发代理与服务端脚本可以通过明确的受信认证路径处理；不能因为请求没有 Origin，就默认它可信。

另外 `DEMO_ACCESS_TOKEN` 不能成为公开浏览器请求绕过项目会话隔离的通行证。必须隔离管理权限与访客权限。

修订 3：候选和判定不能简单“取 judgment_version 最大值”

要先限定当前 Run、需求修订、型号、输入摘要与对应决策版本。

否则用户切换到早期运行时，前端有可能显示后来复核产生的新判定。这违反了我们已经确定的版本追溯原则。

还有一个容易忽视的问题：访客 Session 不是不可绕过的预算身份。 用户清除 Cookie 就能申请新会话。因此按 Session 限额之外，还需要部署级预算上限、全局并发控制及基本的滥用防护。

Cloudflare 的 Worker Rate Limiting 适合做请求频率保护，但官方明确其计数是近似的、按节点生效；不能单独承担严格的全局模型消费预算。

[image](https://www.google.com/s2/favicons?domain=https://developers.cloudflare.com\&sz=32)

Cloudflare Workers docs



## 三、重新排列两个 Agent 的任务

目前最重要的是减少互相等待，而不是让后端按 27 项 TODO 严格串行做完。

| 顺序 | 后端 Agent                  | 前端 Agent               | 联合交付物        |
| -- | ------------------------- | ---------------------- | ------------ |
| 1  | Guest Session + 隔离 + 鉴权契约 | PR #3 整理，准备 Session 接入 | 真实浏览器会话      |
| 2  | 完整 Pipeline 的最小可用串联       | F1 接统一任务入口             | 一次点击完成 M2→M3 |
| 3  | 统一 Analysis API + 版本关联    | F2 接真实候选/判定/价格数据       | 完整的分析结果      |
| 4  | 自动 DOCX + 公开错误码           | F3 接自动下载状态             | 正式可下载报告      |
| 5  | 联合验收、稳定性与安全修复             | 浏览器 E2E、极简界面收尾         | 可公开演示的产品     |

项目级自然语言修订 F4 暂列 P1，不阻塞这条主线。

这件事体现我们的长期差异化，但在目前交付时限下，不能让它挤掉完整端到端交付。

## 四、给后端 Agent 的正式执行指令

这份指令对现有 TODO 做了整合，不要求重新设计系统。

# M4 后端交付指令｜2026-11-02

架构决策已确定：**正式 DOCX 在决策完成后自动生成；后端负责一次点击的完整持久化编排，前端负责展示状态与下载。**

继续使用现有 Deep Agents、Cloudflare Worker/Workflows、Python Container、D1、R2 和 M1–M3 模块。禁止引入新框架或重构现有 Agent。

## 0. 总体优先级

P0 交付顺序：

1. Guest Session 与跨访客隔离。
2. 一次点击的完整 Pipeline。
3. 稳定的统一 Analysis API 与版本关联。
4. 自动 DOCX、报告状态及下载。
5. 真实浏览器联合验收和安全回归。

原 TODO 的字段清理、错误语义修复、分页可穿插实施，但不要让次要项目阻塞主链路。

项目级自然语言修订保留 P1。

## 1. Guest Session：修改当前设计中的几个细节

保留 migration 0012 的现有设计，先审查兼容性和既有无归属项目如何处理。

- `POST /api/session`：显式创建会话，有效会话重复请求应幂等。
- `GET /api/session`：只读取和验证当前会话，不隐式创建。
- **取消首次访问任意 `/api/*` 自动签发 Cookie 的设计**，由前端显式初始化。
- Cookie 使用 `HttpOnly; Secure; SameSite=Lax; Path=/`。会话 ID 必须足够随机，签名需经过服务端验证；服务端同时检查 D1 中的到期及有效状态。
- 过期会话不可凭过期 Cookie 自动恢复原项目访问权。重新创建访客会话时应明确视为新身份，除非另外设计安全的恢复机制。
- 每个读取、上传、运行、证据、报告和下载接口都必须检查资源归属。其他访客的资源统一返回 404，不泄露是否存在。
- 修改数据的 Cookie 请求必须采用明确的 Origin/CSRF 防护。**不要把无 Origin 当作可信条件**；无 Origin 的受信脚本应经独立的服务端认证策略处理。
- 内部 Bearer 凭证必须与访客权限隔离，不能成为普通公开路由的万能绕过方式。
- 每访客的频率、启动次数及并发限额之外，增加应用级总预算和全局并发保护；不能只依靠可以重新申请的 Guest Session。
- 保留 D1 迁移前已有项目的数据隔离策略：无 session_id 的旧项目不能通过公开访客接口任意读取。

完成后立即发布 `docs/m4/backend_contract_response.md` §5，并通知前端 Agent 联调，不需要等待 Pipeline 全部开发完成。

## 2. 完整 Pipeline：最小可交付优先

用户只调用一次：

`POST /api/projects/{id}/pipeline`

服务端返回 202、`pipeline_id`，并自动执行：

M2 → M3-A → M3-B → M3-C → 决策版本冻结 → DOCX 自动生成。

沿用 Cloudflare Workflows 实现阶段持久化。已有单阶段接口继续保留供内部测试。

要求：

- Workflow 各阶段绑定确定的 `project_id`、`demand_revision`、`sourcing_run_id`、Evidence/Claim 版本和决策版本。
- 不能在后续阶段直接查询无版本限制的项目 latest 数据。
- 每阶段独立记录开始、完成、错误与可重试状态。
- 对外部 API、数据库写入、报告创建均实施幂等；Workflow 重试不应重复创建业务成果。
- 用明确的客户端幂等键处理双击、请求重发。同一幂等键返回同一任务，但用户明确发起新调查时仍应允许创建新运行。
- M2 PARTIAL 且已有有效证据时允许继续分析，最终保留覆盖不完整标记。
- 对没有有效候选、没有有效需求、缺少必要输入的情况提供明确业务状态。
- 为耗时步骤显式配置合理的重试和超时，不依赖 Workflow 默认值。
- 报告自动生成失败，不删除或撤销已完成的决策。

统一状态中至少能够区分：

`RESEARCHING`、`EVALUATING`、`DECIDING`、`REPORT_GENERATING`、`COMPLETED`、`PARTIAL`、`FAILED`。

具体可映射现有枚举，不要求原样新增全部字符串。报告单独保留 `report_status`，避免分析成功、报告失败时把整项采购分析误判为失败。

## 3. API 契约和版本关联

优先完成：

- `POST /api/projects/{id}/pipeline`
- `GET /api/projects/{id}/pipeline/{pipeline_id}`
- `GET /api/projects/{id}/analysis`

统一分析响应应包含：

- 当前需求摘要及需求版本。
- 本次 Pipeline 对应的候选和型号。
- 具体技术判定、原因码、Evidence ID。
- M3-B 的价格上下文及 `history_scope`。
- M3-C 的采购建议。
- 决策版本与报告状态/下载引用。

重要：前端切换到旧 Run 时，必须读取那个 Run 对应的判定和报告。

**不得简单按 judgment_version 最大值关联全项目最新判定。**

必须先限定当前 Run/决策版本、需求修订、候选及型号和评估来源；如果旧版本有确定的 assessment ID，应直接引用该 assessment。

对于同型号对应多个 Offering 的情况，允许共享型号级技术评估，但保留各自的供应渠道及价格记录。

统一 `/analysis` 可以聚合现有服务响应，不必重新实现 M3 业务逻辑。

## 4. 正式 DOCX 自动生成

决策通过 Verification Gate 且版本已固定之后，自动调用现有正式报告生成服务。

要求：

- 报告严格绑定不可变的决策版本。
- 相同决策版本重复生成应优先复用已有有效报告。
- 生成失败记录公开错误码与内部 Trace，不能将容器异常、SQL 或 R2 Key 返回浏览器。
- 报告生成失败允许重试，但不能重新运行完整 M2/M3。
- 正式报告仅在相应决策存在时生成；仅有 Longlist 的运行不得伪造最终报告。
- 保留当前按需生成 API，供历史版本及失败重试使用。

## 5. 测试与部署

优先补充 Worker 路由测试，覆盖 Session、跨项目越权、CSRF、Pipeline 幂等、分析版本与下载授权。

必须有真实云端联合验收：

A/B 两个独立访客创建项目，互相不能读取或下载对方资源。

同一个访客完成：

创建项目 → 提交需求 → 一次点击 → M2/M3 → 决策 → 自动 DOCX → 下载。

测试重复启动请求、Pipeline 中途失败、报告单独失败以及页面刷新后重新读取。

正式验收期间固定镜像与 Git Commit，不在长任务执行中滚动更新容器。

## 6. 与前端的交付接口

不要等所有 P0 完成才通知前端。

按以下顺序发布可用契约：

A. Session API 和错误码。\
B. Pipeline 启动、状态与 Run 关联。\
C. `/analysis` 数据形状。\
D. Report 自动生成状态及下载引用。

每项附真实响应样例、版本 SHA、当前已部署状态和必要测试结果。

## 7. 暂缓事项

暂不开发完整项目级对话修订、新 Agent、Clef/Jev、Sandbox、M1 分片并行或大规模性能优化。

限额、鉴权、Pipeline、正式报告、版本一致性是当前交付重点。

请先把上述指令映射到现有 TODO 和代码位置，之后直接按顺序实施。每完成一个可供前端联调的契约节点就立即通知，不必等待全部工作结束。

Cloudflare Workflows 的 `step.do()` 支持持久化完成状态、失败重试及自定义超时，因此适合当前分阶段执行的设计。但 Workflow 的自动重试并不替业务数据库保证“恰好写入一次”，业务侧仍必须做到幂等。

[image](https://www.google.com/s2/favicons?domain=https://developers.cloudflare.com\&sz=32)

Cloudflare Workflows docs+2



## 五、给前端 Agent 的正式指令

前端 PR #3 已经通过类型检查、49 项单测和 15 条 E2E，真实 DOCX 下载也得到了验证。这部分值得保留，不要再为自动报告重新设计页面。

# M4 前端交付指令｜2026-11-02

架构决策已确定：**选择 A，正式 DOCX 在后端决策完成后自动生成。**

后端已收到统一 Pipeline、Guest Session、Analysis API 及自动报告的实施要求。

你继续维护 PR #3，不需要重新设计当前极简工作区。

## 1. 报告交互

保留现有“下载这一版”按钮。

新流程为：

- 当前决策尚未完成：不可下载。
- 决策完成但报告生成中：显示“正在生成报告”。
- 当前决策版本已有报告：直接下载。
- 自动生成失败：显示简短提示，并允许用户重新尝试生成。
- 旧版本未生成报告：保留现有按需生成逻辑。

报告必须绑定用户当前查看的运行和决策版本。

切换早期 Run 时，候选、技术评估、价格上下文及报告也一起切换，不能混用最新数据。

## 2. Session 联调

后端将提供显式 `POST /api/session` 和 `GET /api/session`。

前端初始化时调用 Session API，不实现登录页面。

使用同源请求及 HttpOnly Cookie；不要把内部 Bearer Token 放进浏览器或前端持久化状态。

正确处理会话失效、限流、预算耗尽、网络失败及资源不可访问等响应。

服务端返回公开错误码和简短提示；前端不要展示原始堆栈、SQL 或内部异常。

## 3. 一次点击 Pipeline

原“开始寻源”操作改为调用后端统一 Pipeline 入口。

不在浏览器里依次调用 M2、M3-A 和 M3-C。

只显示必要的用户状态：

- 正在寻找供应商。
- 正在核对技术与价格。
- 正在整理采购建议。
- 正在生成报告。
- 已完成或需要处理异常。

不暴露 Supervisor、Researcher、DSL 或 Workflow 内部名称。

可以将主操作文案调整为“开始分析”，但不要因此重新设计页面。

## 4. F2 真实数据

接入后端 `/analysis` 后：

- 使用当前 Pipeline/Run 对应的数据。
- 按后端明确提供的稳定 ID 显示候选与判定。
- 保留 Longlist、UNKNOWN、RFQ Shortlist 的实际区别。
- 计划预算、历史价格及 `history_scope` 使用后端响应。
- 不在前端重新计算价格或技术合格性。
- 证据按需展开，避免默认铺满界面。

继续遵守已经确定的 UI/UX 约束：无营销内容、无多余说明、无嵌套卡片或装饰性 Dashboard。

## 5. 当前阶段的工作顺序

1. 整理 PR #3，保持可随时集成。
2. 根据即将发布的 Session 契约，实现并验证真实浏览器会话。
3. 对接统一 Pipeline 和轮询。
4. 接入 `/analysis` 的真实 F2 数据。
5. 接入自动报告状态，并验证 F3 下载。
6. 完成真实浏览器端到端验收。

不要因后端正在开发 Pipeline 而停止组件开发，但所有尚未真实联调的功能必须明确标注。

## 6. 下次汇报

请提供：

- PR #3 最新 SHA、测试结果和是否满足合并条件。
- Session 真实联调结果。
- 统一 Pipeline 接入情况。
- F2 与正式 DOCX 的真实数据展示情况。
- 当前阻塞项及所依赖的后端接口版本。

当前不扩展通用聊天系统，也不提前设计复杂 F4。优先交付真正能用的采购工作区。

## 六、我建议设立一个非常轻量的集成看板

不需要新增 Jira、Notion 或项目管理平台。让两个 Agent 在现有对齐文档里共用下面这张表即可。

集成检查表

0/5 已验收

访客 Session 与隔离

后端负责：后端 · 前端对接：真实 Session 联调

A/B 访客互不可见

一次点击 Pipeline

后端负责：后端 · 前端对接：启动及状态展示

一次启动自动完成 M2–M3

统一 Analysis API

后端负责：后端 · 前端对接：F2 候选与判定

当前运行版本关联正确

DOCX 自动生成

后端负责：后端 · 前端对接：F3 下载状态

当前决策版本可下载

公开完整流程

后端负责：双方 · 前端对接：真实浏览器测试

公开链接全流程通过

&#x20;复制检查表

以上检查表是我们双方协作的验收标准，勾选状态需要根据真实测试更新，不代表我已经验证了这些功能。

## 七、最后三个统筹要求

第一，前端 PR #3 不要因为后端尚未提供所有接口而长期悬空。 可以先按照现有分支策略完成不依赖新接口的代码审查，并在共享分支发生变化时做好冲突处理。真正集成时再确认 API 版本，避免两位 Agent 同时改动同一份 Gateway 文件。

第二，后端不应把 27 项 TODO 当成必须逐条全部完成的独立项目。 Session、Pipeline、Analysis 和 Report 是四个核心交付点；字段清理、错误处理、分页和测试围绕这四个点完成。尤其分页如果不会阻止当前演示和基本使用，可以排在主链路之后，但不能留下虚假的“加载更多”入口。

第三，公开演示的可靠性必须优先于额外功能。 现在距离 11 月 11 日只有九天左右。完整跑通之后，我们还需要验证公开访问、错误处理、报告下载、数据合规说明和三分钟以内的演示视频。

最终统筹结论：

- 产品决策： 选 A，自动生成 DOCX。
- 后端主线： Session → Pipeline → Analysis → Report → 联合验收。
- 前端主线： 保留 PR #3 → Session 联调 → Pipeline 联调 → F2 真实数据 → F3 自动报告状态。
- 暂不进入： F4 完整多轮修订、通用记忆、进一步模型优化和其他新技术实验。

我们现在要交付的不是一套功能很多的 Agent 框架，而是一个用户打开网页、提出采购需求、等待系统完成分析、检查结论并下载正式报告的可用产品。
---
# 后端执行指令：停止重复规划，进入 M4 交付冲刺

当前日期：2026-11-02。比赛截止 2026-11-11。

架构评审结论：你对当前风险的识别是正确的，但需要调整实施顺序。现在的首要目标是形成完整、真实、可验收的采购任务链路，而不是先把 Guest Session 的全部工作做完。

**本轮不需要再向我提交完整 TODO、重新估算项目或者等待进一步确认。请直接实施，并在每个交付点给出真实代码、测试和运行结果。**

## 一、先处理当前未提交的 Session 代码

你目前已有本地 Guest Session 基础实现，但尚未提交。

请先完成以下操作：

1. 运行已有测试。
2. 检查当前代码没有意外修改其他业务行为。
3. 将 Session 基础实现提交到 Git，保留默认关闭和访客昂贵任务禁用的安全开关。
4. 记录 Commit SHA，并在状态文档中标注：`LOCAL_ONLY / NOT_PRODUCTION_READY`。
5. 不要为了完成 Session 的全部安全验收而推迟后续 Pipeline 开发。

**禁止在隔离和限额未完成前启用公开访客寻源。**

## 二、B1：优先实现受保护的完整 Pipeline

现在立即开始实现一次点击的后端编排。

用户级入口：

`POST /api/projects/{id}/pipeline`

返回 `202` 和稳定的 `pipeline_id`。

服务端自动执行：

M2 寻源 → M3-A 技术核验 → M3-B 历史与价格分析 → M3-C 决策门禁。

请复用已有 Cloudflare Workflows 和单阶段实现，不新建一套任务引擎。

### B1 必须做到

1. 创建 Pipeline 时冻结 `demand_revision` 和本次任务所需的输入标识。
2. M2 结束后，把确定的 `sourcing_run_id`、候选集合、Evidence/Claim 版本或内容摘要显式传递给后续阶段。
3. M3 不得在 Pipeline 执行过程中无条件读取项目的最新需求、最新候选或最新判断。
4. 每阶段有明确状态、失败原因、开始和完成时间。
5. 使用客户端幂等键处理同一启动请求的重试；相同键不得产生多个 Pipeline。
6. Workflow 重试必须复用或幂等创建已有业务成果。
7. M2 返回 PARTIAL 但存在有效候选时，可以继续分析，但最终保留研究不完整的标记。
8. 当前先通过受保护的内部接口运行，不依赖公开 Guest Session。

验收至少包含：一次真实 Pipeline 运行、重复启动幂等、阶段失败记录和输入版本关联。

**B1 完成后马上提交和汇报，不需要等自动报告或访客鉴权。**

## 三、B2：冻结决策版本并自动生成 DOCX

B1 跑通后，立即接入决策版本与报告。

这里必须注意：现有 `judgment_cache` 的版本化不等于完整采购决策已经不可变。

请针对每次 Pipeline 形成一个可追溯的决策版本，绑定：

- 项目与需求修订；
- M2 寻源 Run 与证据版本；
- M3 技术评估的具体版本；
- M3-B 价格分析的具体口径；
- M3-C 决策及 Verification Gate 结果。

优先复用现有 `sourcing_decisions` 及 Snapshot 相关结构，但不得让后续重评覆盖旧版本所引用的内容。

历史 Run 查询应返回当时的结果，不能默认取最大的 `judgment_version`。

接下来自动生成 DOCX：

- 决策版本冻结后自动生成报告。
- 报告使用同一份冻结数据。
- 相同决策版本重复执行，优先复用有效 DOCX。
- DOCX 失败不撤销决策，可独立重试。
- 前端通过报告状态判断何时可下载。
- 下载必须校验当前会话或内部请求的资源权限。

**B2 完成后立即给前端提供可调用的 Analysis/Report 契约和真实响应样例。**

## 四、B3：完成访客 Session 安全闭环

在 B1/B2 开发过程中保留现有 Session 实现；之后集中完成生产安全验收。

必须覆盖：

1. 显式 `POST /api/session` 和 `GET /api/session`。
2. HttpOnly、Secure、SameSite Cookie。
3. 所有项目、运行、上传、证据、分析与报告资源的归属检查。
4. 不同访客修改 ID 访问对方资源返回 404。
5. Origin/CSRF 校验；不能把无 Origin 请求一概视为可信。
6. 会话创建频率保护、每访客研究任务限额与并发限制。
7. 部署级总消费预算和全局并发上限，防止清除 Cookie 绕过所有预算。
8. 过期会话与旧无归属项目的访问处理。
9. 真实 Worker 路由测试及云端 A/B 访客验收。

不需要开发账号系统或登录页面。

安全闭环通过前，Guest Session 的昂贵任务开关保持关闭。可继续通过受保护环境测试 Pipeline。

## 五、B4：前后端联合验收

前端 PR #3 已具备 F1–F3 的基础实现，但还在等待真实后端契约。

请按顺序向前端发布：

1. Session API；
2. Pipeline 创建及查询 API；
3. 按 Pipeline/Run 版本绑定的 Analysis API；
4. 自动 DOCX 状态和下载接口。

**每个接口契约可用后立即通知前端，不要等所有后端功能全部完成。**

最终联合验收必须完成：

创建项目 → 输入采购需求 → 一次点击开始分析 → 自动 M2/M3 → 展示候选、技术状态和价格口径 → 自动生成 DOCX → 下载当前版本报告。

另外验证：

- 页面刷新可以恢复运行状态；
- 切换旧 Run 不混合新判定；
- 同一启动请求重试不生成重复任务；
- 报告失败不使整个分析结果消失；
- 访客 A 无法访问访客 B 的任何资源。

## 六、立即降低优先级的工作

以下事项不应阻塞 B1–B4：

- 项目列表分页的完整改造；
- M2 Supervisor Token 优化；
- 自然语言项目修订 F4；
- 大规模 Schema 重构；
- 更复杂的模型推理策略；
- 新增 Agent、Sandbox、Clef/Jev。

错误信息脱敏、必要的接口权限检查和真实业务数据正确性仍是上线硬要求。

## 七、新的工作汇报格式

每完成 B1、B2、B3、B4 任一交付点，请汇报：

**已完成**
- 实际改动文件；
- Commit SHA；
- 通过的测试；
- 一次真实运行的结果；
- 可以供前端使用的 API。

**尚未完成**
- 实际阻塞项；
- 哪个安全或业务风险仍然存在；
- 下一项具体代码工作。

请明确区分：

`LOCAL_IMPLEMENTED` / `CLOUD_DEPLOYED` / `CLOUD_VERIFIED` / `PUBLIC_READY`。

不要把本地测试当成云端验收，也不要在未完成隔离和预算保护前开放公开 Demo。

**现在请先提交本地 Session 基础实现，然后直接进入 B1 的代码开发。无需再等待架构确认。**
---

# 八、交付盘点（2026-11-04，距 11-11 截止 7 天）

后端状态：**B3 CLOUD_VERIFIED**（访客隔离、限流、预算单位、一次点击 Pipeline、按运行读取分析、自动 DOCX 均有实网验收）；**B4 未开始**。公开演示地址已可用：`https://procurement-sourcing-gateway.xiangyu474.workers.dev`（页面与 API 同源，访客会话生效）。

## A. 必须做完，否则演示不成立

| # | 事项 | 负责人 | 现状 | 预计 |
| --- | --- | --- | --- | --- |
| A1 | 前端把 `useGuestSession` 接进 `App.tsx`（钩子已存在但未被使用） | 前端 | 未做；未接则访客首次操作 401 | 0.5h |
| A2 | 前端消费 `/analysis`：`summary`、按型号聚合、判定与价格口径、报告三态 | 前端 | 契约已发布（§5.3、§5.3.1） | 1.5h |
| A3 | 生产构建不带任何 Bearer 凭证，只依赖 HttpOnly 会话 | 前端 | 生产构建已设 `VITE_GUEST_SESSION=1`；需确认代理不注入 | 0.2h |
| A4 | 真实浏览器端到端：建项目 → 填需求 → 整理 → 一次点击 → 进度 → 结果 → 下载 DOCX → 刷新恢复 → 切旧 Run 不混数据 | 双方 | 未做 | 3h |
| A5 | 集成检查表五项逐项勾选（以真实测试为准） | 双方 | 全空 | 0.3h |
| A6 | 三分钟演示视频 + 数据合规说明 | 产品 | 未做 | 1h |

## B. 影响质量，可取舍

| # | 事项 | 说明 | 预计 |
| --- | --- | --- | --- |
| B1 | 历史文件导入错误语义 | 已改为 422 + 中文原因（`history_file_rejected`），待部署验证 | 已完成 |
| B2 | 寻源型号多样性 | 常只找到 1 个真实型号的多个供应商；M2 检索策略偏保守，未改动以免影响研究质量 | 2h |
| B3 | 演示时长 | 一次完整公开演示约 8–12 分钟；Pipeline 已支持 `research_budget`，前端可提供“快速预览”（如 `3/3/1/1/8`） | 前端 0.3h |

## C. 明确不做（按截止日期取舍）

项目级自然语言修订（F4）、项目列表分页、逐次模型调用计费、Supervisor token 优化、大规模 schema 重构。

## C2. 2026-11-05 后端状态更新

- 已修并部署：访客可重试报告（`POST .../pipeline/{id}/report`，1 预算单位/次）；`price_contexts[].budget_kind`（总价/单价）；`GET /api/session` 返回 `mode`（后端判定身份）；`summary.models[]` 改为按型号名聚合（`distinct_models` 现在等于买家看到的型号数）；失败阶段保留原因码（`stages[].error_code`）；容器中途崩溃不再让任务空等（失败快速收口 + 1 次重试 + 阶段调用前等就绪）；需求整理"丢了可测量约束"会再试一次。
- 默认研究预算：`5/6/2/1/15`（搜索/取页/任务/轮次/模型调用）；容器升到 standard-4 避免研究中途被 OOM 杀掉。
- 一次完整分析实网耗时约 9–12 分钟。
- 未修（属研究覆盖质量，不是接口问题）：同一需求有时 PASS、有时 UNKNOWN——取决于研究是否取到写明"输出分辨率"的规格页。取到就 PASS，取不到就诚实记 `ATTRIBUTE_NOT_ALIGNED`。详见 `docs/m4/backend_contract_response.md` §7.6。

## D. 已知边界（写清楚，不要当成已解决）

- 预算单位是并发与日量的粗略代理，不是模型调用次数或金额；实际调用只受 M2 内部既有上限约束。
- 访客会话的 `CF-Connecting-IP` 在同区域 Worker 子请求中可被改写，只能当滥用信号，不能当身份。
- 技术核验的语义对齐依赖模型判断；模型的语义拒绝保留为 UNKNOWN，代码只纠正方法标注和缺失的 claim id。
- 旧项目级 `/spec-assessments`、`/decisions` 不含 Pipeline 结果，前端一律用 `/analysis`。
