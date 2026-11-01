import { describe, expect, it } from "vitest";
import { ApiError } from "./types";
import {
	explainRun,
	interpretCompilation,
	messageForApiError,
	runStatusLabel,
	sanitizePublicText,
	stageLabel,
} from "./adapter";

describe("adapter", () => {
	it("keeps an older compilation pending until the requested version arrives", () => {
		expect(
			interpretCompilation(
				{ analysis_version: 1, compilation: { requirements: [{ product_name: "相机" }], issues: [] } },
				2,
			),
		).toEqual({ phase: "pending" });
	});

	it("reads the gateway failure row as a failed compilation", () => {
		const view = interpretCompilation(
			{
				analysis_version: 2,
				compilation: {
					project_id: "p1",
					analysis_version: 2,
					issues: ["compile failed with status 500: model down"],
				},
			},
			2,
		);
		expect(view).toEqual({ phase: "failed", issues: ["compile failed with status 500: model down"] });
	});

	it("counts purchase lines without treating an empty list as failure", () => {
		expect(
			interpretCompilation(
				{ analysis_version: 3, compilation: { requirements: [], unstructured_requirements: [{ text: "待确认" }], issues: [] } },
				3,
			),
		).toEqual({ phase: "ready", requirementCount: 0, unstructuredCount: 1 });
	});

	it("describes partial and failed runs without internal terms", () => {
		expect(explainRun({ status: "PARTIAL", lastError: null, stopReason: "BUDGET_EXHAUSTED" })).toBe(
			"已保留目前得到的结果。本次公开查阅的次数已用完。",
		);
		expect(explainRun({ status: "COMPLETED", lastError: null, stopReason: null })).toBeNull();
		const failed = explainRun({ status: "FAILED", lastError: "Supervisor used 12 tokens", stopReason: null });
		expect(failed).toContain("寻源没有完成");
		expect(failed).not.toMatch(/Supervisor|token/i);
		expect(runStatusLabel("RUNNING", "WEB_RESEARCH")).toBe("查阅公开资料");
		expect(runStatusLabel("COMPLETED", "WEB_RESEARCH")).toBe("寻源已结束");
		expect(stageLabel("INTERNAL_ANALYSIS")).toBe("整理资料");
	});

	it("strips credentials and internal names from server text", () => {
		const cleaned = sanitizePublicText("Bearer secret-value Supervisor DSL token Tavily");
		expect(cleaned).not.toMatch(/secret-value|Supervisor|DSL|token|Tavily/i);
		expect(cleaned).toContain("寻源流程");
	});

	it("maps unauthorized and history import failures", () => {
		expect(messageForApiError(new ApiError(401, "unauthorized", null)).summary).toBe("访问被拒绝。");
		const imported = messageForApiError(new ApiError(500, "history_import_failed", { detail: "Supervisor timeout token sk-abcdef" }));
		expect(imported.summary).toBe("历史数据导入失败。");
		expect(imported.technical).not.toMatch(/Supervisor|token|sk-abcdef/i);
	});
});
