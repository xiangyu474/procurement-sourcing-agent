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
	analysisPipelineId: string | null;
	loading: boolean;
	/** True only after this run's analysis response was read. A 409 or a failure is not zero candidates. */
	loaded: boolean;
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
const ANALYSIS_MISSING = "这次运行没有分析结果。";
/** How long to wait before asking again for a snapshot that is not written yet. */
const ANALYSIS_RETRY_MS = 5_000;

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
	pipelineActive: boolean,
	pipelineStatus: string | null,
): CandidateModel {
	const [rows, setRows] = useState<CandidateRowView[]>([]);
	const [summaryLine, setSummaryLine] = useState<string | null>(null);
	const [recommendationLine, setRecommendationLine] = useState<string | null>(null);
	const [warnings, setWarnings] = useState<string[]>([]);
	const [analysisReport, setAnalysisReport] = useState<AnalysisReport | null>(null);
	const [analysisPipelineId, setAnalysisPipelineId] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [decisionsReady, setDecisionsReady] = useState(false);
	const [reportBlockReason, setReportBlockReason] = useState<string | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [evidence, setEvidence] = useState<EvidenceDetail | null>(null);
	const [evidenceError, setEvidenceError] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const evidenceAbortRef = useRef<AbortController | null>(null);
	const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		abortRef.current?.abort();
		if (retryRef.current) {
			clearTimeout(retryRef.current);
			retryRef.current = null;
		}
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
		setAnalysisPipelineId(null);
		setLoaded(false);
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
				setAnalysisPipelineId(analysis.pipeline_id || null);
				setDecisionsReady(analysis.decisions.length > 0);
				setReportBlockReason(analysis.decisions.length > 0 ? null : "报告还没有生成");
				setLoaded(true);
				setLoading(false);
			} catch (caught) {
				if (isAbort(caught) || signal.aborted) return;
				if (caught instanceof ApiError && caught.status === 409) {
					// No frozen snapshot for this run. That is not zero candidates
					// and not a broken page. While the task is still running, ask
					// again. After a failed stage, the stage sentence is the message.
					setLoadError(null);
					setRows([]);
					setLoaded(false);
					setLoading(false);
					const waiting = pipelineActive || pipelineStatus === "QUEUED" || pipelineStatus === "RUNNING";
					if (waiting) {
						setReportBlockReason(null);
						retryRef.current = setTimeout(() => setAttempt((value) => value + 1), ANALYSIS_RETRY_MS);
						return;
					}
					setReportBlockReason(pipelineStatus === "FAILED" ? null : ANALYSIS_VERSION_MISSING);
					return;
				}
				if (caught instanceof ApiError && caught.status === 404) {
					// There is no task for this run. That is not a broken page.
					setLoadError(ANALYSIS_MISSING);
					setRows([]);
					setReportBlockReason(ANALYSIS_MISSING);
					setLoading(false);
					return;
				}
				setLoadError(messageForApiError(caught).summary);
				setReportBlockReason(ANALYSIS_NOT_READY);
				setLoading(false);
			}
		})();
		return () => controller.abort();
	}, [clientRef, projectId, runId, runStatus, pipelineActive, pipelineStatus, attempt]);

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
		analysisPipelineId,
		loading,
		loaded,
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
