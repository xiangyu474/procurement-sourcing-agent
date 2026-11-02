import { sanitizePublicText } from "../api/adapter";
import type { Report } from "../api/types";

export type ReportPhase = "hidden" | "blocked" | "ready" | "generating" | "failed";

export function selectReport(reports: Report[], runId: string): Report | null {
	const mine = reports.filter((report) => report.run_id === runId);
	return (
		mine.find((report) => report.status === "COMPLETED" && report.download_path) ??
		mine.find((report) => report.status === "QUEUED" || report.status === "RUNNING") ??
		mine[0] ??
		null
	);
}

export function reportFileName(title: string, runCreatedAt: string): string {
	const safe = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "寻源报告";
	const date = new Date(runCreatedAt);
	if (Number.isNaN(date.getTime())) return `${safe}.docx`;
	const month = date.getMonth() + 1;
	const day = date.getDate();
	const hour = String(date.getHours()).padStart(2, "0");
	const minute = String(date.getMinutes()).padStart(2, "0");
	return `${safe}-${month}月${day}日${hour}时${minute}分.docx`;
}

export const PRIOR_REPORT_FAILURE = "上次生成失败，可以重新生成。";
export const REPORT_NETWORK_FAILURE = "网络中断，没有生成。";

/** A short Chinese sentence from the backend. Internal logs stay off the page. */
export function isPublicReportError(error: string | null): boolean {
	const cleaned = error ? sanitizePublicText(error).trim() : "";
	if (!cleaned || cleaned.length > 40) return false;
	if (/container|proxy|exception|status\s*\d|stack|https?:|internal|error/i.test(error ?? "")) return false;
	return /^[\u4e00-\u9fff0-9，。、；：！？\s]+$/.test(cleaned);
}

export function reportFailure(error: string | null): string {
	if (!isPublicReportError(error)) return "生成失败。";
	return `生成失败。${sanitizePublicText(error ?? "").trim()}`;
}

export function decisionCoversRun(input: {
	runUpdatedAt: string | null;
	projectDemandRevision: number | null;
	job: { status: string; demand_revision: number | null; updated_at: string | null } | null;
}): { ready: boolean; reason: string } {
	if (!input.job || input.job.status !== "COMPLETED") return { ready: false, reason: "报告还没有生成" };
	const runEnded = input.runUpdatedAt ? Date.parse(input.runUpdatedAt) : Number.NaN;
	const decided = input.job.updated_at ? Date.parse(input.job.updated_at) : Number.NaN;
	const revisionMatches =
		input.projectDemandRevision != null && input.job.demand_revision != null && input.job.demand_revision === input.projectDemandRevision;
	if (!revisionMatches || !Number.isFinite(runEnded) || !Number.isFinite(decided) || decided <= runEnded) {
		return { ready: false, reason: "还不能确认这次运行已经有决策。" };
	}
	return { ready: true, reason: "报告还没有生成" };
}

/** The download control. A long list cannot start a report. */
export function reportPhase(input: { runStatus: string | null; decisionsReady: boolean; report: Report | null; pending: boolean }): ReportPhase {
	const finished = input.runStatus === "COMPLETED" || input.runStatus === "PARTIAL";
	if (!finished) return "hidden";
	if (!input.decisionsReady) return "blocked";
	if (input.pending || input.report?.status === "QUEUED" || input.report?.status === "RUNNING") return "generating";
	if (input.report?.status === "COMPLETED" && input.report.download_path) return "ready";
	if (input.report?.status === "FAILED") return "failed";
	return "ready";
}
