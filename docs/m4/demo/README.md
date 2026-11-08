# 演示素材

| 文件 | 用途 |
| --- | --- |
| `official/智能视频采集终端生产采购项目_v1.pptx` | **官方需求素材** ✓✓（A 段：上传为 `purpose=REQUIREMENT` ✓） |
| `official/智能视频采集终端_历史采购明细_v1.xlsx` | **官方历史素材** ✓✓（A 段：上传为 `purpose=HISTORY` ✓，再调用 `POST /api/projects/{id}/history-imports` ✓） |
| `sample_report_2026-11-03.docx` | 示例运行生成的**正式报告** ✓（43,996 字节 ✓，B 段录屏里展示的报告 ✓✓） |
| `sample_report_2026-11-03.pdf` | 同一份报告的 PDF ✓（便于直接翻看 ✓） |
| `sample_report_from_portal.docx` | 从**公开入口**（`POST /api/demo/sample` ✓）下载到的同一份报告 ✓（43,996 字节 ✓，SHA-256 与 D1 记录一致 ✓） |
| `page1.png` / `page2.png` / `page3.png` | 报告前三页的版式预览 ✓（封面与报告标识 ✓、候选与型号表 ✓、关键技术判定表 ✓） |
| `demo.mp4` | **终版演示视频 v4** ✓✓（Git LFS ✓；180 秒 ✓，1920×1080 ✓，H.264 ✓；中文字幕已烧录 ✓，无旁白 ✓；地址栏与页面为正式域名 `https://procurement-sourcing-agent.com` ✓） |
| `demo.srt` | 同一支视频的字幕 ✓ |
| `cuts.md` / `cuts.json` | 分镜表 ✓✓（只含真实界面录制 ✓；A 段 795 秒等待以 53 倍快进呈现并标明 ✓；90–105 秒对照页面版本与 DOCX 决策版本 `37c0c77b` ✓，其中最后 9 秒为标明的定格 ✓） |
| `matching_versions.png` | 视频 100 秒处的定格 ✓（页面版本与报告里的决策版本 `37c0c77b` ✓） |

官方素材来自赛题方发布的原始文件 ✓✓，此处仅作演示复现用 ✓✓；其历史数据为**模拟采购** ✓，系统始终把它与公开市场企业分属两个命名空间并标注 ✓✓（见 `docs/m4/data_compliance.md` ✓）。

克隆后需要 `git lfs pull` 才能拿到 `demo.mp4` ✓（仓库里提交的是 LFS 指针 ✓）。

录制步骤与旁白见 `docs/m4/backend_contract_response.md` §7.9 与 §7.11 ✓✓；解说词见 `docs/m4/demo_narration.md` ✓✓。
