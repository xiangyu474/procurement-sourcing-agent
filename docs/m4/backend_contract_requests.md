# 后端契约请求

基线已由 `docs/m4/backend_contract_response.md` 接上。下面只保留仍未实现的项。已落地的接口标为已解决，细节以答复文档为准。

## 已解决（2026-11-01，§3.1–§3.5 与正式报告）

这些不再是缺口。前端按答复文档里的真实形状调用：

- `GET /api/projects?limit=50`
- `GET /api/projects/{id}/runs`（含 `stop_reason_code`）
- `GET /api/projects/{id}/requirement-text`
- `GET /api/projects/{id}/requirement-compile/{compile_id}`
- `GET /api/projects/{id}/spec-assessments/status`
- `GET /api/projects/{id}/decisions/status`
- `POST/GET /api/projects/{id}/reports` 与 `GET .../reports/{report_id}/download`

## 仍缺：项目级修订

`BLOCKED_BY_BACKEND`。`POST /api/projects/{id}/actions` 未实现。前端不会把「新文字 + 重新整理 + 新运行」包装成已经重评。F4 用分步引导，直到这个接口存在。

```http
POST /api/projects/{project_id}/actions
{ "text": "ONVIF 不再必须，改成优选，重新评估", "base_demand_revision": 2, "base_run_id": "uuid" }
```

`base_demand_revision` 与当前修订不一致时返回 409。

## 仍缺：访客会话

`BLOCKED_BY_BACKEND`。生产鉴权改为公开演示的访客会话，不使用 Cloudflare Access，也不做登录界面。会话由 Worker 签发和校验。前端不保存内部凭证，只请求同源 `/api`。请后端先定会话接口（见答复文档 §5，2026-11-02）。在那之前前端不会自己发明 `POST /api/session`。

开发联调仍用 Vite 代理从环境变量注入 `DEMO_ACCESS_TOKEN`，与生产会话分开。夹具测试不是生产鉴权验收。

## 仍缺：历史文件不合格应返回 422

`BLOCKED_BY_BACKEND`。实网里表头不合格的 XLSX 会得到 500 `history_import_failed`，`detail` 带异常类名。应返回 422，正文只给人能读的原因。

```json
{ "error": "history_file_rejected", "detail": "工作表没有可用的表头。" }
```

## 仍缺：无采购内容的整理结果

`BLOCKED_BY_BACKEND`。实网里非需求文字「你好，今天天气不错。」会得到整理状态 `COMPLETED`，且 `requirements` 为空。前端不会据此启动寻源。请确认应返回 `FAILED`，或在 `issues` 里给出原因码（例如 `no_recognizable_demand`）。

## 仍缺：项目列表翻页

`BLOCKED_BY_BACKEND`。`GET /api/projects?limit=50` 只返回最近 50 条，没有下一页。请加游标翻页，例如查询参数 `cursor`，响应带 `next_cursor`。前端不放一个假的「更多」。

## 仍缺：公开响应去掉内部字段

`BLOCKED_BY_BACKEND`。浏览器仍能看到 `r2_key`、`normalized_r2_key`、按次 token、`SUPERVISOR:` 阶段名，以及事件 `detail` 里的 `SourcingPlan` / `Supervisor` / `M3`。请 Worker 去掉，或另给可展示字段。事件请给 `display_text` 或原因码，前端不必展示原文。

## 共享文件

以上仍由后端改 `cloudflare/gateway/`。前端不改这些文件。
