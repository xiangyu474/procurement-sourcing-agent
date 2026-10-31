# 后端契约请求

基线提交：`f0fa49bc07714132d2b960fad34cb0b86d720ed0`。下列能力现有公开 API 做不到。前端把它们标为 `BLOCKED_BY_BACKEND`，不返回假数据。鉴权与现有 `/api/*` 相同。

## 1. 项目列表

`BLOCKED_BY_BACKEND`：跨浏览器的项目列表。

```http
GET /api/projects?limit=50
```

```json
{
  "projects": [
    {
      "id": "uuid",
      "title": "项目名称",
      "history_availability": "NOT_PROVIDED",
      "demand_revision": 1,
      "analysis_version": 2,
      "created_at": "2026-10-31T00:00:00.000Z",
      "latest_run": {
        "id": "uuid",
        "status": "PARTIAL",
        "current_stage": "PARTIAL",
        "updated_at": "2026-10-31T00:04:00.000Z"
      }
    }
  ]
}
```

`latest_run` 没有运行时为 `null`。`status` 只用现有 `QUEUED` / `RUNNING` / `COMPLETED` / `PARTIAL` / `FAILED`。

F1 的左栏是本机记录加 `GET /api/projects/{id}`，不是这个接口。

## 2. 项目下的运行列表

`BLOCKED_BY_BACKEND`：已知项目编号但本机没有 `run_id` 时，无法发现最近一次运行。

```http
GET /api/projects/{project_id}/runs
```

```json
{
  "runs": [
    {
      "id": "uuid",
      "status": "PARTIAL",
      "current_stage": "PARTIAL",
      "last_error": null,
      "stop_reason_code": "BUDGET_EXHAUSTED",
      "artifact_key_present": false,
      "created_at": "2026-10-31T00:03:00.000Z",
      "updated_at": "2026-10-31T00:04:00.000Z"
    }
  ]
}
```

按 `created_at` 倒序。请把 `stop_reason_code` 写到运行行上。今天 `PARTIAL` 的原因只在 `GET /api/runs/{id}/research` 的 `metrics` 里，而那个对象同时带有 token 和搜索次数。

## 3. 读回文字需求

`BLOCKED_BY_BACKEND`：刷新后不能恢复需求正文。`GET /api/projects/{id}` 的 `sources` 没有 `text_content`。

```http
GET /api/projects/{project_id}/requirement-text
```

```json
{ "source_id": "uuid", "revision": 2, "text": "原文" }
```

没有文字来源时 404 `not_found`。只返回最新一条 `USER_TEXT`。

## 4. 需求整理状态

进行中与失败目前靠 `GET /api/projects/{id}/requirements` 推断：404 表示还没有这一版；200 且 `compilation.requirements` 不是数组、同时 `issues` 非空，表示这一版失败。请改成可查询的状态，避免把失败文档和成功文档混在同一个读接口里。

```http
GET /api/projects/{project_id}/requirement-compile/{compile_id}
```

```json
{
  "compile_id": "workflow-instance-id",
  "project_id": "uuid",
  "status": "QUEUED",
  "analysis_version": 2,
  "demand_revision": 2,
  "error": null
}
```

`status`：`QUEUED` / `RUNNING` / `COMPLETED` / `FAILED`。失败时 `error` 为可展示的短句，不要包含密钥。`COMPLETED` 后再读现有的 `GET .../requirements`。

## 5. 技术核对与决策的任务状态

`BLOCKED_BY_BACKEND`：空的 `GET .../spec-assessments` 或 `GET .../decisions` 无法区分还在运行和已经失败。Workflow 失败今天只留在 Workflow 结果里。

```http
GET /api/projects/{project_id}/spec-assessments/status
GET /api/projects/{project_id}/decisions/status
```

```json
{
  "status": "FAILED",
  "job_id": "workflow-instance-id",
  "demand_revision": 2,
  "error": "分析超时。"
}
```

`status`：`IDLE` / `QUEUED` / `RUNNING` / `COMPLETED` / `FAILED`。结果行仍由现有 GET 返回，字段不改。

## 6. 正式 DOCX

`BLOCKED_BY_BACKEND`：寻源运行不写入 `artifact_key`。现有 `GET /api/runs/{id}/report/download` 只对 M0 `SPIKE` 草稿有效，不能当作采购报告。

```http
POST /api/projects/{project_id}/reports
{ "run_id": "uuid" }
```

```json
{ "report_id": "uuid", "run_id": "uuid", "status": "QUEUED" }
```

```http
GET /api/projects/{project_id}/reports/{report_id}
```

```json
{
  "report_id": "uuid",
  "run_id": "uuid",
  "status": "COMPLETED",
  "download_path": "/api/projects/{project_id}/reports/{report_id}/download"
}
```

`status`：`QUEUED` / `RUNNING` / `COMPLETED` / `FAILED`。下载返回 DOCX 字节。报告必须只含该 `run_id` 已经落库的候选、核对和决策；没有决策时可以生成，但不要把长名单写成合格名单。多版本时路径里的 `report_id` 固定这一份，不跟随以后的新运行。

## 7. 项目级修订

`BLOCKED_BY_BACKEND`：一句话修订（例如把某项从必须改为优选并重评）没有原子接口。分开调用「新文字修订 + 重新整理 + 新运行」会留下半成品，前端不会把输入框伪装成已经完成重评。

```http
POST /api/projects/{project_id}/actions
```

```json
{
  "text": "ONVIF 不再必须，改成优选，重新评估",
  "base_demand_revision": 2,
  "base_run_id": "uuid"
}
```

```json
{
  "action_id": "uuid",
  "status": "QUEUED",
  "base_demand_revision": 2,
  "base_run_id": "uuid"
}
```

```http
GET /api/projects/{project_id}/actions/{action_id}
```

```json
{
  "action_id": "uuid",
  "status": "COMPLETED",
  "demand_revision": 3,
  "run_id": "uuid",
  "spec_status": "COMPLETED",
  "decision_status": "COMPLETED",
  "error": null
}
```

`base_demand_revision` 与当前修订不一致时返回 409，避免盖掉中间的修改。`status`：`QUEUED` / `RUNNING` / `COMPLETED` / `PARTIAL` / `FAILED`。

## 共享文件

以上都是网关新路由或现有路由的加字段，落在 `cloudflare/gateway/src/index.ts` 和可能的新迁移里。前端不改这些文件。静态资源托管和访问凭证不下发到浏览器的建议写在 `docs/m4/F0_audit.md` 第 6 节。
