"""Check that the sample's report carries the version the page shows.

The check reads the downloaded document itself. The API projects the analysis
version into the report object, so reading that would only prove the analysis
agrees with itself.
"""

import io
import sys
import time

import httpx
from docx import Document

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
BASE = "https://procurement-sourcing-agent.com"
HEADERS = {"origin": BASE}

with httpx.Client(base_url=BASE, timeout=600, headers=HEADERS) as client:
    client.post("/api/session")
    sample = client.post("/api/demo/sample").json()
    project_id = sample["project_id"]
    pipeline_id = sample["pipeline_id"]
    print("示例", project_id, pipeline_id, "| reused", sample.get("reused"), flush=True)

    report_id = f"pr_{pipeline_id}"
    for _ in range(40):
        state = client.get(f"/api/projects/{project_id}/reports/{report_id}")
        if state.status_code == 200 and state.json().get("status") == "COMPLETED":
            break
        time.sleep(10)
    print("报告状态", state.json().get("status"), flush=True)

    analysis = client.get(f"/api/projects/{project_id}/analysis",
                          params={"pipeline_id": pipeline_id}).json()
    page_version = analysis.get("decision_version")
    print("页面版本", page_version, flush=True)

    download = client.get(f"/api/projects/{project_id}/reports/{report_id}/download")
    print("下载", download.status_code, len(download.content), "字节", flush=True)
    document = Document(io.BytesIO(download.content))
    fields = {}
    for table in document.tables[:1]:
        for row in table.rows:
            cells = [cell.text.strip() for cell in row.cells]
            if len(cells) == 2:
                fields[cells[0]] = cells[1]
    report_version = fields.get("决策版本", "")
    print("报告版本", report_version, flush=True)
    print("报告运行", fields.get("寻源运行", ""), flush=True)
    print("页面与报告同版:", page_version == report_version, flush=True)
