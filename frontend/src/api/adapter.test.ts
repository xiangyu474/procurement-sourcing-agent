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
		).toEqual({ phase: "ready", requirementCount: 0, unstructuredCount: 1, notices: ["有 1 条需求没能整理"] });
	});

	it("notices an unconfirmed planned budget from the issue field", () => {
		const view = interpretCompilation(
			{
				analysis_version: 4,
				compilation: {
					requirements: [{ product_name: "摄像机" }],
					unstructured_requirements: [{ text: "a" }, { text: "b" }, { text: "c" }],
					issues: [
						"The planned_total_budget of r1 could not be confirmed: the cited fragments do not state 200000.",
						{ field: "planned_unit_price", detail: "could not be confirmed" },
						"delivery note unclear",
					],
				},
			},
			4,
		);
		expect(view).toMatchObject({
			phase: "ready",
			requirementCount: 1,
			unstructuredCount: 3,
			notices: ["有 3 条需求没能整理", "计划预算未确认", "另有 2 条内容需要确认"],
		});
	});

	it("does not treat a free-text budget sentence as the planned-budget field", () => {
		const view = interpretCompilation(
			{
				analysis_version: 4,
				compilation: {
					requirements: [{ product_name: "摄像机" }],
					issues: ["budget 200000 not confirmed", { code: "AMBIGUOUS", detail: "budget looks unclear" }],
				},
			},
			4,
		);
		expect(view).toMatchObject({
			phase: "ready",
			notices: ["另有 2 条内容需要确认"],
		});
	});

	it("reads a structured planned_total_budget issue", () => {
		const view = interpretCompilation(
			{
				analysis_version: 5,
				compilation: {
					requirements: [{ product_name: "摄像机" }],
					issues: [{ field: "planned_total_budget", code: "UNCONFIRMED", detail: "cited text does not state the amount" }],
				},
			},
			5,
		);
		expect(view).toMatchObject({ phase: "ready", notices: ["计划预算未确认"] });
	});

	it("describes partial and failed runs without internal terms", () => {
		expect(explainRun({ status: "PARTIAL", lastError: null, stopReason: "BUDGET_EXHAUSTED", candidateCount: 2 })).toBe(
			"已保留目前得到的结果。本次公开查阅的次数已用完。",
		);
		expect(explainRun({ status: "PARTIAL", lastError: null, stopReason: "NO_SOURCE_BACKED_CANDIDATES", candidateCount: 0 })).toBe(
			"没有找到有公开资料支撑的候选供应商。",
		);
		expect(explainRun({ status: "PARTIAL", lastError: null, stopReason: "NO_SOURCE_BACKED_CANDIDATES", candidateCount: 0 })).not.toContain(
			"已保留目前得到的结果",
		);
		expect(explainRun({ status: "PARTIAL", lastError: null, stopReason: "SOME_NEW_CODE", candidateCount: 1 })).toBe(
			"这次寻源没有全部完成。",
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
		expect(messageForApiError(new ApiError(401, "session_expired", null)).summary).toBe("会话已失效，请刷新页面。");
		expect(messageForApiError(new ApiError(401, "session_required", null)).summary).toBe("会话已失效，请刷新页面。");
		expect(messageForApiError(new ApiError(403, "origin_mismatch", null)).summary).toBe("页面来源不对，请从本站重新打开。");
		expect(messageForApiError(new ApiError(404, "not_found", null)).summary).toBe("找不到这个项目或已无权访问。");
		expect(messageForApiError(new ApiError(409, "demand_revision_changed", null)).summary).toBe("需求刚更新过，请确认后再开始。");
		expect(messageForApiError(new ApiError(422, "no_recognizable_demand", null)).summary).toBe("没有识别出采购需求。");
		expect(messageForApiError(new ApiError(503, "operation_unavailable", { error: "operation_unavailable" })).summary).toBe("分析暂时不可用。");
		expect(messageForApiError(new ApiError(503, "workflow_start_failed", { detail: "container log" })).summary).toBe("分析没能启动。");
		expect(messageForApiError(new ApiError(503, "session_not_configured", null)).summary).toBe("会话还没有配置。");
		const imported = messageForApiError(new ApiError(500, "history_import_failed", { detail: "Supervisor timeout token sk-abcdef" }));
		expect(imported.summary).toBe("历史数据导入失败。");
		expect(imported.technical).toBeUndefined();
		const raw = messageForApiError(new ApiError(500, "http_500", { detail: "Error proxying request to container: The container is not running" }));
		expect(raw.summary).toBe("服务暂时不可用。");
		expect(raw.technical).toBeUndefined();
		expect(messageForApiError(new ApiError(429, "rate_limited", null)).summary).toBe("请求过于频繁，请稍后再试。");
		expect(messageForApiError(new ApiError(401, "session_required", null)).summary).toBe("会话已失效，请刷新页面。");
		expect(messageForApiError(new ApiError(503, "sample_not_configured", null)).summary).toBe("示例还没有准备好。");
		expect(messageForApiError(new ApiError(404, "sample_not_found", null)).summary).toBe("没有找到可查看的示例。");
		expect(messageForApiError(new ApiError(500, "sample_exploded", null)).summary).toBe("服务暂时不可用。");
		expect(messageForApiError(new ApiError(500, "sample_exploded", null)).summary).not.toContain("sample_exploded");
		expect(messageForApiError(new ApiError(403, "forbidden", null)).summary).toBe("访问被拒绝。");
		const parsed = messageForApiError(
			new ApiError(500, "history_import_failed", {
				detail: JSON.stringify({ error_type: "ValueError", detail: "ValueError: 工作表没有表头" }),
			}),
		);
		expect(parsed.summary).toBe("历史数据导入失败。");
		expect(parsed.technical).toBe("工作表没有表头");
		expect(parsed.technical).not.toMatch(/ValueError|Exception/);
	});

	it("does not show an internal stage prefix", () => {
		expect(stageLabel("SUPERVISOR:WEB_RESEARCH")).toBe("查阅公开资料");
	});
});
