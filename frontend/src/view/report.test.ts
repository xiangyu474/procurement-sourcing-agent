import { describe, expect, it } from "vitest";
import type { Report } from "../api/types";
import { reportFailure, reportFileName, reportPhase, selectReport } from "./report";

function report(patch: Partial<Report>): Report {
	return {
		report_id: "rep-1",
		run_id: "run-1",
		status: "COMPLETED",
		decision_version: "abc123",
		error: null,
		download_path: "/api/projects/p1/reports/rep-1/download",
		created_at: "2026-11-02T02:00:00.000Z",
		updated_at: "2026-11-02T02:05:00.000Z",
		...patch,
	};
}

describe("report download", () => {
	it("prefers a completed report for this run", () => {
		const selected = selectReport(
			[
				report({ report_id: "new-failed", status: "FAILED", download_path: null, created_at: "2026-11-02T03:00:00.000Z" }),
				report({ report_id: "done", status: "COMPLETED" }),
				report({ report_id: "other", run_id: "run-2", status: "COMPLETED" }),
			],
			"run-1",
		);
		expect(selected?.report_id).toBe("done");
	});

	it("names the file from the project and the run time", () => {
		expect(reportFileName("工业摄像机寻源", "2026-10-31T01:00:00.000Z")).toMatch(/^工业摄像机寻源-\d+月\d+日\d{2}时\d{2}分\.docx$/);
		expect(reportFileName("a/b:c", "not-a-date")).toBe("a b c.docx");
	});

	it("keeps a long list from generating a report", () => {
		expect(reportPhase({ runStatus: "RUNNING", decisionsReady: false, report: null, pending: false })).toBe("hidden");
		expect(reportPhase({ runStatus: "FAILED", decisionsReady: true, report: null, pending: false })).toBe("hidden");
		expect(reportPhase({ runStatus: "COMPLETED", decisionsReady: false, report: null, pending: false })).toBe("blocked");
		expect(reportPhase({ runStatus: "PARTIAL", decisionsReady: true, report: null, pending: false })).toBe("ready");
		expect(reportPhase({ runStatus: "COMPLETED", decisionsReady: true, report: report({ status: "RUNNING", download_path: null }), pending: false })).toBe("generating");
		expect(reportPhase({ runStatus: "COMPLETED", decisionsReady: true, report: report({ status: "FAILED", error: "没有可写入的决策。", download_path: null }), pending: false })).toBe("failed");
		const failed = reportFailure("Supervisor timeout token");
		expect(failed.startsWith("生成失败。")).toBe(true);
		expect(failed).not.toMatch(/Supervisor|token/i);
		expect(reportFailure("没有可写入的决策。")).toBe("生成失败。没有可写入的决策。");
	});
});
