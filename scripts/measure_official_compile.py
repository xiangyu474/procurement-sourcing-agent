"""Measure how long the official deck takes to compile.

The compiler runs the same code as the container, so a local run with the same
model endpoint tells us the time the cloud run needs.
"""

import json
import os
import pathlib
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

provider = json.loads(pathlib.Path(".provider_backup.json").read_text(encoding="utf-8"))
os.environ["GENESIS_BASE_URL"] = provider["GENESIS_BASE_URL"]
os.environ["GENESIS_ACCESS_TOKEN"] = provider["GENESIS_ACCESS_TOKEN"]
os.environ["GENESIS_MODEL_ID"] = provider["GENESIS_MODEL_ID"]

from procurement_agent.domain.requirements import RequirementSourceType
from procurement_agent.ingestion.compiler import compile_requirement_fragments
from procurement_agent.ingestion.pptx import extract_pptx_fragments
from procurement_agent.infra.llm import build_chat_model
from procurement_agent.infra import load_settings

deck = pathlib.Path(
    "../参赛要求与官方资料/命题赛道素材_已解压/命题赛道素材/寻价比源素材/1/智能视频采集终端生产采购项目_v1.pptx"
)
raw = deck.read_bytes()
print("PPTX 字节", len(raw), flush=True)

fragments = extract_pptx_fragments(
    raw, project_id="p-local", source_id="s-local", filename=deck.name, revision=1
)
print("片段数", len(fragments), "总字符", sum(len(f.text) for f in fragments), flush=True)

settings = load_settings()
model = build_chat_model(settings, timeout=600)
began = time.time()
result = compile_requirement_fragments(
    project_id="p-local", fragments=fragments, model=model, revision=1
)
elapsed = time.time() - began
compilation = result.compilation
print("耗时 %.0f 秒" % elapsed, flush=True)
print("品项", len(compilation.requirements), "| 未整理", len(compilation.unstructured_requirements),
      "| 待确认", len(compilation.open_questions), flush=True)
print("问题", compilation.issues[:3], flush=True)
for item in compilation.requirements[:3]:
    print(" -", item.product_name, [(c.attribute_key, c.operator.value, c.value, c.unit) for c in item.constraints], flush=True)
