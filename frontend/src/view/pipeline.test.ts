import { describe, expect, it } from "vitest";
import { pipelineProblemLine, pipelineProgressLine } from "./pipeline";

describe("pipeline progress", () => {
	it("maps both research spellings and never describes a report", () => {
		expect(pipelineProgressLine("RUNNING", "RESEARCH")).toBe("正在寻找供应商");
		expect(pipelineProgressLine("RUNNING", "RESEARCHING")).toBe("正在寻找供应商");
		expect(pipelineProgressLine("RUNNING", "EVALUATING")).toBe("正在核对技术与价格");
		expect(pipelineProgressLine("RUNNING", "DECIDING")).toBe("正在整理采购建议");
		expect(pipelineProgressLine("QUEUED", null)).toBe("正在寻找供应商");
		expect(pipelineProgressLine("COMPLETED", "COMPLETED")).toBe("已完成");
		expect(pipelineProgressLine("COMPLETED", "COMPLETED")).not.toContain("报告");
		expect(pipelineProgressLine("PARTIAL", "EVALUATING")).toBe("需要处理");
		expect(pipelineProgressLine("FAILED", "RESEARCH")).toBe("需要处理");
	});

	it("uses a public code and drops raw stage errors", () => {
		expect(
			pipelineProblemLine("FAILED", "container exploded", [{ error_code: "NO_FETCHED_EVIDENCE" }]),
		).toBe("没有读到可用的公开资料。");
		expect(pipelineProblemLine("FAILED", "NOT_A_PUBLISHED_CODE", [{ error_code: null }])).toBe("这次分析没有完成。");
		expect(pipelineProblemLine("PARTIAL", null, [{ error_code: "UNKNOWN_STAGE" }])).toBe("这次分析只完成了一部分。");
		expect(pipelineProblemLine("COMPLETED", "NO_FETCHED_EVIDENCE", [])).toBeNull();
		expect(pipelineProblemLine("FAILED", "container exploded", [])).not.toContain("container");
	});
});
