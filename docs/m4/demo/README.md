# 演示素材

| 文件 | 用途 |
| --- | --- |
| `official/智能视频采集终端生产采购项目_v1.pptx` | **官方需求素材** ✓✓（A 段：上传为 `purpose=REQUIREMENT` ✓） |
| `official/智能视频采集终端_历史采购明细_v1.xlsx` | **官方历史素材** ✓✓（A 段：上传为 `purpose=HISTORY` ✓，再调用 `POST /api/projects/{id}/history-imports` ✓） |
| `sample_report_2026-11-03.docx` | 示例运行生成的**正式报告** ✓（43,996 字节 ✓，B 段录屏里展示的报告 ✓✓） |
| `sample_report_2026-11-03.pdf` | 同一份报告的 PDF ✓（便于直接翻看 ✓） |
| `sample_report_from_portal.docx` | 从**公开入口**（`POST /api/demo/sample` ✓）下载到的同一份报告 ✓（43,996 字节 ✓，SHA-256 与 D1 记录一致 ✓） |
| `page1.png` / `page2.png` / `page3.png` | 报告前三页的版式预览 ✓（封面与报告标识 ✓、候选与型号表 ✓、关键技术判定表 ✓） |

官方素材来自赛题方发布的原始文件 ✓✓，此处仅作演示复现用 ✓✓；其历史数据为**模拟采购** ✓，系统始终把它与公开市场企业分属两个命名空间并标注 ✓✓（见 `docs/m4/data_compliance.md` ✓）。

录制步骤与旁白见 `docs/m4/backend_contract_response.md` §7.9 与 §7.11 ✓✓；解说词见 `docs/m4/demo_narration.md` ✓✓。
