# 如何重新启动这个系统

2026-11-08 竞赛结束后，为了不再产生费用，Worker 被改成不带容器的只读版本。代码、数据和历史提交都没有删除。这份文档说明如何把完整功能恢复。

## 现在还活着的东西

| 内容 | 状态 | 位置 |
| --- | --- | --- |
| 全部代码与历史 | 完整 | GitHub `xiangyu474/procurement-sourcing-agent` |
| 数据库 | 完整 | D1 `procurement-sourcing`（321 个项目、59 份报告、1516 条证据任务） |
| 文件 | 完整 | R2 桶 `procurement-sourcing-artifacts`（上传的官方文件、网页快照、DOCX 报告） |
| 演示站点 | 只读 | `https://procurement-sourcing-agent.com` |
| Worker 密钥 | 保留 | Cloudflare Worker Secrets（模型、Tavily、会话签名、内部令牌） |
| 本机密钥文件 | 保留 | `.env`、`.provider_backup.json`、`.demo_access_token` |

## 恢复完整功能

只读版本没有容器。完整流水线需要 Cloudflare Containers，而 Containers 只在 Workers 付费计划上可用。

1. 在 Cloudflare 控制台重新开启 Workers 付费计划。
2. 恢复容器配置与容器类。

   ```bash
   git checkout 8966e3e -- wrangler.jsonc cloudflare/gateway/src/index.ts
   ```

3. 重建构建令牌。2026-11-08 原有三个令牌被删除，云端 API 令牌也应重新签发。

   ```bash
   cf builds tokens create --build-token-name m0-build-deploy --build-token-secret "$SECRET" --cloudflare-token-id <API_TOKEN_ID>
   cf builds triggers update <TRIGGER_UUID> --build-token-uuid <NEW_BUILD_TOKEN_UUID>
   ```

4. 推送即触发构建。构建脚本会构建容器镜像并部署 Worker。

   ```bash
   git push origin main
   ```

5. 数据库不需要重做。迁移文件在 `cloudflare/gateway/migrations/`，2026-11-08 已全部应用。

6. 检查密钥。Worker Secrets 在控制台里。如果需要新的 Cloudflare API 令牌，在控制台的 API 令牌页创建，然后写入本地 `.cf_api_token_secret`。

## 恢复后要重新验证的事

- `POST /api/demo/sample` 返回的示例必须带自己的报告，且报告里的决策版本与页面显示的一致。2026-11-08 修过这个缺陷，代码在 `876cc02` 之后。
- 旧的示例项目仍指向当时的报告行。迁移 `0020_sample_report_rebuild.sql` 已清理过一次，新的旧报告再出现时，重跑该迁移。
- Tavily 订阅在 2026-11-08 取消。恢复寻源前需要重新订阅并更换 Worker Secret 里的检索密钥。
- MiniMax 的密钥在 `.env` 和 Worker Secrets 里。按量计费，余额与充值策略需要单独确认。

## 只读版本的能力

- 可用：示例结果、型号判定、证据、来源、已生成的报告下载。
- 不可用：新建分析、需求整理、寻源、核验、生成新报告。
