import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { isAbort, isTerminalRun, messageForApiError } from "../api/adapter";
import { ApiError } from "../api/types";
import type { ApiClient } from "../api/client";
import type { AnalysisReport, EvidenceDetail } from "../api/types";
import { analysisSummaryLine, buildAnalysisRows, recommendationText } from "../view/analysis";
import type { CandidateRowView } from "../view/candidates";

export type CandidateModel = {
	rows: CandidateRowView[];
	summaryLine: string | null;
	recommendationLine: string | null;
	warnings: string[];
	analysisReport: AnalysisReport | null;
	loading: boolean;
	loadError: string | null;
	decisionsReady: boolean;
	reportBlockReason: string | null;
	selectedId: string | null;
	select: (id: string) => void;
	evidence: EvidenceDetail | null;
	evidenceError: string | null;
	openEvidence: (evidenceId: string) => void;
};

const ANALYSIS_NOT_READY = "这次分析还没有出结果。";
const ANALYSIS_VERSION_MISSING = "这次运行没有可用的分析结果。";

/**
 * The frozen analysis of the selected run. It is the only source for a
 * pipeline result: the project level assessment and decision lists do not
 * contain it.
 */
export function useCandidates(
	clientRef: MutableRefObject<ApiClient>,
	projectId: string | null,
	runId: string | null,
	runStatus: string | null,
): CandidateModel {
	const [rows, setRows] = useState<CandidateRowView[]>([]);
	const [summaryLine, setSummaryLine] = useState<string | null>(null);
	const [recommendationLine, setRecommendationLine] = useState<string | null>(null);
	const [warnings, setWarnings] = useState<string[]>([]);
	const [analysisReport, setAnalysisReport] = useState<AnalysisReport | null>(null);
	const [loading, setLoading] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [decisionsReady, setDecisionsReady] = useState(false);
	const [reportBlockReason, setReportBlockReason] = useState<string | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [evidence, setEvidence] = useState<EvidenceDetail | null>(null);
	const [evidenceError, setEvidenceError] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const evidenceAbortRef = useRef<AbortController | null>(null);

	useEffect(() => {
		abortRef.current?.abort();
		setSelectedId(null);
		setEvidence(null);
		setEvidenceError(null);
		setLoadError(null);
		setDecisionsReady(false);
		setReportBlockReason(null);
		setRows([]);
		setSummaryLine(null);
		setRecommendationLine(null);
		setWarnings([]);
		setAnalysisReport(null);
		if (!projectId || !runId || !runStatus) {
			setLoading(false);
			return;
		}
		if (!isTerminalRun(runStatus)) {
			setLoading(false);
			setReportBlockReason("分析还没有结束。");
			return;
		}
		const controller = new AbortController();
		abortRef.current = controller;
		const signal = controller.signal;
		const currentProject = projectId;
		const currentRun = runId;
		setLoading(true);
		void (async () => {
			try {
				const analysis = await clientRef.current.getAnalysis(currentProject, { runId: currentRun }, { signal });
				if (signal.aborted) return;
				const built = buildAnalysisRows(analysis);
				setRows(built);
				setSummaryLine(analysisSummaryLine(analysis.summary));
				const recommendation = recommendationText(analysis.summary.by_recommendation);
				setRecommendationLine(recommendation || null);
				setWarnings(analysis.summary.coverage_warnings);
				setAnalysisReport(analysis.report);
				setDecisionsReady(analysis.decisions.length > 0);
				setReportBlockReason(analysis.decisions.length > 0 ? null : "报告还没有生成");
				setLoading(false);
			} catch (caught) {
				if (isAbort(caught) || signal.aborted) return;
				if (caught instanceof ApiError && caught.status === 409) {
					// The run has no frozen snapshot. Nothing is filled in from a later run.
					setLoadError(null);
					setRows([]);
					setReportBlockReason(ANALYSIS_VERSION_MISSING);
					setLoading(false);
					return;
				}
				setLoadError(messageForApiError(caught).summary);
				setReportBlockReason(ANALYSIS_NOT_READY);
				setLoading(false);
			}
		})();
		return () => controller.abort();
	}, [clientRef, projectId, runId, runStatus]);

	const select = (id: string) => {
		setSelectedId(id);
		setEvidence(null);
		setEvidenceError(null);
	};

	const openEvidence = (evidenceId: string) => {
		evidenceAbortRef.current?.abort();
		const controller = new AbortController();
		evidenceAbortRef.current = controller;
		setEvidenceError(null);
		void clientRef.current.getEvidence(evidenceId, { signal: controller.signal }).then(
			(detail) => {
				if (!controller.signal.aborted) setEvidence(detail);
			},
			(caught: unknown) => {
				if (!isAbort(caught)) setEvidenceError(messageForApiError(caught).summary);
			},
		);
	};

	return {
		rows,
		summaryLine,
		recommendationLine,
		warnings,
		analysisReport,
		loading,
		loadError,
		decisionsReady,
		reportBlockReason,
		selectedId,
		select,
		evidence,
		evidenceError,
		openEvidence,
	};
}
