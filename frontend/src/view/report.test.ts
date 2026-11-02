import { describe, expect, it } from "vitest";
import type { Report } from "../api/types";
import { decisionCoversRun, reportFailure, reportFileName, reportPhase, selectReport } from "./report";

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
		expect(failed).toBe("生成失败。");
		expect(failed).not.toMatch(/Supervisor|token/i);
		expect(reportFailure("report generation failed with status 500: Error proxying request to container: The container is not running")).toBe("生成失败。");
		expect(reportFailure("没有可写入的决策。")).toBe("生成失败。没有可写入的决策。");
	});

	it("enables a report only when the decision job finished after this run", () => {
		const job = { status: "COMPLETED", demand_revision: 2, updated_at: "2026-11-01T12:00:00.000Z" };
		expect(decisionCoversRun({ runUpdatedAt: "2026-11-01T11:00:00.000Z", projectDemandRevision: 2, job }).ready).toBe(true);
		expect(decisionCoversRun({ runUpdatedAt: "2026-11-01T13:00:00.000Z", projectDemandRevision: 2, job })).toMatchObject({
			ready: false,
			reason: "还不能确认这次运行已经有决策。",
		});
		expect(decisionCoversRun({ runUpdatedAt: "2026-11-01T11:00:00.000Z", projectDemandRevision: 2, job: { ...job, updated_at: null } }).ready).toBe(false);
		expect(decisionCoversRun({ runUpdatedAt: "2026-11-01T11:00:00.000Z", projectDemandRevision: 2, job: { ...job, status: "IDLE" } }).reason).toBe("报告还没有生成");
	});
});
