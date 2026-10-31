import { latestSource } from "../api/adapter";
import type { Project } from "../api/types";
import type { HistoryNote } from "./useWorkspace";

export function textDemandLabel(project: Project): string | null {
	const source = latestSource(project.sources, (item) => item.source_type === "USER_TEXT" && item.purpose === "REQUIREMENT");
	if (!source) return null;
	return `文字需求已提交，修订 ${source.revision}`;
}

export function pptxLabel(project: Project): string | null {
	const source = latestSource(project.sources, (item) => item.source_type === "INTERNAL_PPTX");
	if (!source) return null;
	return `${source.filename ?? "PPTX"} 已接收`;
}

export function historyLabel(project: Project, note: HistoryNote | null, synthetic: boolean | null): string | null {
	if (note) {
		const kind = note.synthetic ? "已导入模拟历史数据" : "已导入历史数据";
		return `${kind}，${note.rowCount} 行`;
	}
	if (project.history_availability === "IMPORTED") {
		return synthetic ? "已导入模拟历史数据" : "已导入历史数据";
	}
	if (project.history_availability === "IMPORT_FAILED") return "历史数据导入失败";
	const source = latestSource(project.sources, (item) => item.purpose === "HISTORY");
	if (!source) return null;
	return `${source.filename ?? "历史文件"} 已接收`;
}

export function canImportHistory(project: Project, note: HistoryNote | null): boolean {
	if (note) return false;
	if (project.history_availability === "IMPORTED") return false;
	return project.sources.some((source) => source.purpose === "HISTORY");
}
