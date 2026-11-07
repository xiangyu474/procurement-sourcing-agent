import { describe, expect, it } from "vitest";
import {
	RESEARCH_STOP_CODES,
	STAGE_ERROR_CODES,
	analysisInProgress,
	pipelineHeading,
	pipelineProblemLine,
	pipelineProgressLine,
	showNoCandidateLine,
	sourcingOutcome,
} from "./pipeline";

describe("pipeline progress", () => {
	it("maps both research spellings and leaves a finished analysis to the heading", () => {
		expect(pipelineProgressLine("RUNNING", "RESEARCH")).toBe("正在寻找供应商");
		expect(pipelineProgressLine("RUNNING", "RESEARCHING")).toBe("正在寻找供应商");
		expect(pipelineProgressLine("RUNNING", "EVALUATING")).toBe("正在核对技术与价格");
		expect(pipelineProgressLine("RUNNING", "DECIDING")).toBe("正在整理采购建议");
		expect(pipelineProgressLine("QUEUED", null)).toBe("正在寻找供应商");
		expect(pipelineProgressLine("COMPLETED", "COMPLETED")).toBeNull();
		expect(pipelineProgressLine("COMPLETED", "COMPLETED", "QUEUED")).toBe("正在生成报告");
		expect(pipelineProgressLine("PARTIAL", "EVALUATING")).toBeNull();
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

	it("heads a failed assessment with 需要处理 and does not say there were no candidates", () => {
		const stages = [
			{ stage: "RESEARCH", status: "COMPLETED", error_code: null },
			{ stage: "EVALUATING", status: "FAILED", error_code: "STAGE_SERVICE_ERROR" },
		];
		expect(pipelineHeading("FAILED")).toBe("需要处理");
		expect(pipelineHeading("FAILED")).not.toBe("寻源已结束");
		const note = pipelineProblemLine("FAILED", "PIPELINE_STAGE_FAILED", stages);
		expect(note).toBe("供应商核验这一步没有完成，可以再试一次。");
		expect(note).not.toContain("没有候选供应商");
		expect(note).not.toContain("STAGE_SERVICE_ERROR");
		expect(analysisInProgress("FAILED", "RUNNING")).toBe(false);
		expect(analysisInProgress("FAILED", "COMPLETED")).toBe(false);
		expect(
			showNoCandidateLine({ pipelineStatus: "FAILED", runStatus: "COMPLETED", analysisLoaded: true, candidateCount: 0 }),
		).toBe(false);
		expect(
			showNoCandidateLine({ pipelineStatus: "FAILED", runStatus: "COMPLETED", analysisLoaded: false, candidateCount: 0 }),
		).toBe(false);
	});

	it("says there are no candidates when research failed with that code", () => {
		const note = pipelineProblemLine("FAILED", "PIPELINE_STAGE_FAILED", [
			{ stage: "RESEARCH", status: "FAILED", error_code: "NO_CANDIDATES" },
		]);
		expect(pipelineHeading("FAILED")).toBe("需要处理");
		expect(note).toBe("这次没有候选供应商。");
		expect(note).not.toContain("NO_CANDIDATES");
	});

	it("says 部分完成 once when research stopped short, even if the pipeline was stored as completed", () => {
		const stages = [
			{ stage: "RESEARCH", status: "PARTIAL" },
			{ stage: "EVALUATING", status: "COMPLETED" },
			{ stage: "DECIDING", status: "COMPLETED" },
		];
		expect(sourcingOutcome({ pipelineStatus: "COMPLETED", stages })).toBe("PARTIAL");
		expect(sourcingOutcome({ pipelineStatus: "COMPLETED", researchStatus: "PARTIAL" })).toBe("PARTIAL");
		expect(sourcingOutcome({ pipelineStatus: "PARTIAL", stages: [{ stage: "RESEARCH", status: "COMPLETED" }] })).toBe("PARTIAL");
		expect(pipelineHeading(sourcingOutcome({ pipelineStatus: "COMPLETED", stages }))).toBe("部分完成");
		expect(pipelineProgressLine("COMPLETED", "COMPLETED", "COMPLETED", stages)).toBeNull();
		expect(pipelineProgressLine("COMPLETED", "COMPLETED", null, stages)).not.toBe("已完成");
		expect(pipelineHeading("COMPLETED")).toBe("寻源已结束");
		expect(sourcingOutcome({ pipelineStatus: "FAILED", stages })).toBe("FAILED");
	});

	it("keeps the other terminal headings and only locks the button while queued or running", () => {
		expect(pipelineHeading("COMPLETED")).toBe("寻源已结束");
		expect(pipelineHeading("PARTIAL")).toBe("部分完成");
		expect(pipelineHeading("QUEUED")).toBe("排队中");
		expect(pipelineHeading("RUNNING")).toBeNull();
		expect(analysisInProgress("QUEUED", null)).toBe(true);
		expect(analysisInProgress("RUNNING", "COMPLETED")).toBe(true);
		expect(analysisInProgress("COMPLETED", "RUNNING")).toBe(false);
		expect(analysisInProgress("PARTIAL", "RUNNING")).toBe(false);
		expect(analysisInProgress(null, "QUEUED")).toBe(true);
		expect(analysisInProgress(null, "RUNNING")).toBe(true);
		expect(analysisInProgress(null, "COMPLETED")).toBe(false);
		expect(analysisInProgress(null, "FAILED")).toBe(false);
	});

	it("uses a stage-specific fallback for an unknown code and ignores an earlier research code", () => {
		expect(
			pipelineProblemLine("FAILED", "PIPELINE_STAGE_FAILED", [
				{ stage: "EVALUATING", status: "FAILED", error_code: "NOT_A_PUBLISHED_CODE" },
			]),
		).toBe("供应商核验这一步没有完成，可以再试一次。");
		expect(
			pipelineProblemLine("FAILED", "PIPELINE_STAGE_FAILED", [
				{ stage: "DECIDING", status: "FAILED", error_code: "NOT_A_PUBLISHED_CODE" },
			]),
		).toBe("采购建议这一步没有完成，可以再试一次。");
		expect(
			pipelineProblemLine("FAILED", "PIPELINE_STAGE_FAILED", [
				{ stage: "RESEARCH", status: "FAILED", error_code: "NOT_A_PUBLISHED_CODE" },
			]),
		).toBe("寻找供应商这一步没有完成，可以再试一次。");
		expect(
			pipelineProblemLine("FAILED", "container exploded", [
				{ stage: "RESEARCH", status: "PARTIAL", error_code: "BUDGET_EXHAUSTED" },
				{ stage: "EVALUATING", status: "FAILED", error_code: "STAGE_SERVICE_ERROR" },
			]),
		).toBe("供应商核验这一步没有完成，可以再试一次。");
		expect(pipelineProblemLine("FAILED", "container exploded", [{ stage: "EVALUATING", status: "FAILED", error_code: null }])).toBe(
			"供应商核验这一步没有完成，可以再试一次。",
		);
	});

	it("maps every documented stage code to Chinese and never shows the code", () => {
		const namedByStage = new Set(["STAGE_SERVICE_ERROR", "PIPELINE_STAGE_FAILED"]);
		for (const code of [...STAGE_ERROR_CODES, ...RESEARCH_STOP_CODES]) {
			for (const stage of ["RESEARCH", "EVALUATING", "DECIDING"]) {
				const line = pipelineProblemLine("FAILED", "PIPELINE_STAGE_FAILED", [{ stage, status: "FAILED", error_code: code }]);
				expect(line, `${stage} ${code}`).toBeTruthy();
				expect(line).not.toContain(code);
				expect(line).not.toMatch(/[A-Za-z]/);
				if (!namedByStage.has(code)) expect(line).not.toContain("这一步没有完成");
			}
		}
	});

	it("shows the empty-candidate line only after a finished analysis with none", () => {
		expect(showNoCandidateLine({ pipelineStatus: "COMPLETED", runStatus: "COMPLETED", analysisLoaded: true, candidateCount: 0 })).toBe(true);
		expect(showNoCandidateLine({ pipelineStatus: "PARTIAL", runStatus: "PARTIAL", analysisLoaded: true, candidateCount: 0 })).toBe(true);
		expect(showNoCandidateLine({ pipelineStatus: null, runStatus: "COMPLETED", analysisLoaded: true, candidateCount: 0 })).toBe(true);
		expect(showNoCandidateLine({ pipelineStatus: "COMPLETED", runStatus: "COMPLETED", analysisLoaded: false, candidateCount: 0 })).toBe(false);
		expect(showNoCandidateLine({ pipelineStatus: "COMPLETED", runStatus: "COMPLETED", analysisLoaded: true, candidateCount: 8 })).toBe(false);
		expect(showNoCandidateLine({ pipelineStatus: "RUNNING", runStatus: "RUNNING", analysisLoaded: false, candidateCount: 0 })).toBe(false);
	});
});
