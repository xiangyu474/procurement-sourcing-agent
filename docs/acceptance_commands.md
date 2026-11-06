# 可重复运行的验收命令

每个命令都能单独跑。带 `--remote` 的命令作用于**已部署的网关**，需要 `cf` 已登录。
**不要在验收运行期间部署新镜像**：容器会被替换，正在跑的请求会断。

前置：

```bash
cd C:/Users/ZZ0DVN672/Desktop/projects/moi/procurement_sourcing_agent
cf auth whoami                      # 刷新 OAuth token
npx wrangler d1 migrations apply DB --remote
```

## 0. 本地质量门（每次提交前）

```bash
uv run --python 3.11 ruff check .
uv run --python 3.11 python -m pytest -q          # 292 个用例
npm run check                                     # tsc --noEmit + 网关路由测试
```

## 1. 云端全链路验收（M1 → M2 → M3 → 正式报告）

本机直连 `workers.dev` 被企业网络阻断，所以验收从 **Cloudflare 侧**运行：

```bash
# 三次尝试，报告真实通过率
for i in 1 2 3; do
  PYTHONIOENCODING=utf-8 uv run --python 3.11 python scripts/run_cloud_acceptance.py --title "M3 验收 $i"
done
```

它会创建项目、编译需求、公开寻源、技术核对、决策，并**生成正式 DOCX 报告并下载校验**
（字节数、Word 文件头、状态、决策版本）。

网络恢复后，再跑直连版交叉验证：

```bash
uv run --python 3.11 python scripts/verify_m1_cloud_api.py
uv run --python 3.11 python scripts/verify_m2_cloud_api.py
uv run --python 3.11 python scripts/verify_m3_cloud_api.py
uv run --python 3.11 python scripts/verify_m3_decision_api.py
```

## 2. M3-B 价格口径的业务核验（本地真实官方文件）

```bash
PYTHONIOENCODING=utf-8 uv run --python 3.11 python scripts/live_m3b_price_check.py
PYTHONIOENCODING=utf-8 uv run --python 3.11 python scripts/audit_history_skus.py
```

- `live_m3b_price_check.py`：官方 1000 行历史 → 统计、可比性矩阵、融合分组、供应商隔离。
- `audit_history_skus.py`：官方历史文件的品项数与价格跨度（证明「全表概览 ≠ 单品基准」）。

## 3. 判定缓存与语义回归

```bash
uv run --python 3.11 python -m pytest tests/test_judgment_cache.py tests/test_judgment_guards.py -q
uv run --python 3.11 python -m pytest tests/test_official_history_regression.py tests/test_history_scope.py -q
```

四个冻结型号的期望值与其人工核验理由写在 `tests/fixtures/m3_semantic_regression.json` 的 `audit` 字段。

## 4. 缓存冲突归因

```bash
PYTHONIOENCODING=utf-8 uv run --python 3.11 python scripts/audit_cache_conflicts.py
```

按层、来源运行、规则版本、模型配置分类；**冲突数不是必须清零的指标**，但每条冲突都要能归因。

## 5. 通过判定落在哪些候选的引文上

```bash
PYTHONIOENCODING=utf-8 uv run --python 3.11 python scripts/audit_pass_quotes.py <project_id>
```

打印每条通过判定所依赖的引文原文，用来判断证据是**规格陈述**还是**产品目录标题**。

## 6. 正式报告

```bash
# 生成（网关公开接口）
curl -sS -X POST "https://procurement-sourcing-agent.com/api/projects/<project_id>/reports" \
  -H "Authorization: Bearer $DEMO_ACCESS_TOKEN" -H "content-type: application/json" \
  -d '{"run_id":"<run_id>"}'

# 状态与下载
curl -sS "https://procurement-sourcing-agent.com/api/projects/<project_id>/reports/<report_id>" \
  -H "Authorization: Bearer $DEMO_ACCESS_TOKEN"
curl -sS -o report.docx "https://procurement-sourcing-agent.com/api/projects/<project_id>/reports/<report_id>/download" \
  -H "Authorization: Bearer $DEMO_ACCESS_TOKEN"
```

## 7. 部署

```bash
git push origin main
cf builds list --external-script-id bc4859a483fa485e8ad1cff9c16eea77 --per-page 2
```

**每次发布新镜像都要 bump `wrangler.jsonc` 的 `CONTAINER_INSTANCE_NAME`**，否则运行中的容器仍用旧镜像。
正式验收请记录 **Git SHA + 镜像版本**，两者一起写进验收结论。
