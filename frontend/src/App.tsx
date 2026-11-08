import { isTerminalRun } from "./api/adapter";
import { analysisInProgress, showNoCandidateLine, sourcingOutcome } from "./view/pipeline";
import { CandidateTable } from "./components/CandidateTable";
import { DemandForm } from "./components/DemandForm";
import { EvidencePane } from "./components/EvidencePane";
import { ProjectNav } from "./components/ProjectNav";
import { RunPanel } from "./components/RunPanel";
import { WorkspaceShell } from "./components/WorkspaceShell";
import { useWorkspace } from "./workspace/useWorkspace";
import { reportButtonLabel, reportPhase, reportVersionChip } from "./view/report";

export function App() {
	const workspace = useWorkspace();
	const project = workspace.project;
	const run = workspace.run && workspace.run.project_id === project?.id ? workspace.run : null;
	const pipelineForRun = workspace.pipelineRunId && run?.id === workspace.pipelineRunId ? workspace.pipelineStatus : null;
	const outcome = sourcingOutcome({
		pipelineStatus: pipelineForRun,
		stages: pipelineForRun ? workspace.pipelineStages : [],
		researchStatus: pipelineForRun ? workspace.candidates.researchStatus : null,
	});
	const headingStatus = outcome ?? pipelineForRun;
	const terminalResult = outcome === "COMPLETED" || outcome === "PARTIAL";
	const progressLine = terminalResult
		? workspace.reportStatus === "QUEUED" || workspace.reportStatus === "RUNNING"
			? "正在生成报告"
			: null
		: workspace.pipelineLine;
	const analysisActive = analysisInProgress(workspace.pipelineStatus, run?.status ?? null);
	const collapsed = Boolean(run && isTerminalRun(run.status));
	const startLabel = workspace.startOffer === "retry" && !analysisActive ? "重试" : analysisActive ? "分析进行中" : run ? "再次分析" : "开始分析";
	const isSample = project?.is_sample === true || workspace.candidates.isSample;
	const showStart = !(isSample && startLabel === "再次分析");
	const versionChip = reportVersionChip(workspace.candidates.decisionVersion);
	const downloadPhase = reportPhase({
		// A task that failed has no report. The button is not shown at all.
		runStatus: workspace.pipelineStatus === "FAILED" ? "FAILED" : run?.status ?? null,
		decisionsReady: workspace.candidates.decisionsReady,
		report: workspace.report.report,
		analysisReport: workspace.candidates.analysisReport,
		pending: workspace.report.pending,
	});
	const candidateRows = workspace.candidates.rows;
	const selected = candidateRows.find((row) => row.id === workspace.candidates.selectedId) ?? null;
	const showEmptyCandidates = showNoCandidateLine({
		pipelineStatus: pipelineForRun,
		runStatus: run?.status ?? null,
		analysisLoaded: workspace.candidates.loaded,
		candidateCount: candidateRows.length,
	});

	return (
		<WorkspaceShell
			nav={
				<ProjectNav
					projects={workspace.projects}
					activeProjectId={workspace.activeProjectId}
					pipelineStatus={workspace.pipelineStatus}
					compileFailedAt={workspace.compileFailedAt}
					busy={workspace.busy}
					sampleBusy={workspace.sampleBusy}
					onCreate={workspace.onCreate}
					onOpen={workspace.onOpen}
					onSelect={workspace.onSelect}
					onSample={workspace.onSample}
				/>
			}
		>
			{!workspace.sessionReady ? (
				<p className="quiet" data-testid="session-loading">
					正在建立会话。
				</p>
			) : null}
			{workspace.sessionError ? (
				<div role="alert" className="abnormal failed">
					<p>{workspace.sessionError}</p>
				</div>
			) : null}
			{!project && workspace.error ? (
				<div role="alert" className="abnormal failed">
					<p>{workspace.error.summary}</p>
				</div>
			) : null}
			{project ? (
				<>
					<div className="head">
						<h1>{project.title}</h1>
						{downloadPhase !== "hidden" ? (
							<div className="report">
								<button
									className="download"
									type="button"
									disabled={downloadPhase === "blocked" || downloadPhase === "generating"}
									onClick={() => void workspace.report.download()}
								>
									{reportButtonLabel(downloadPhase, Boolean(workspace.report.report?.status === "COMPLETED" && workspace.report.report.download_path))}
								</button>
								{downloadPhase === "blocked" ? (
									<span className="quiet">{workspace.candidates.reportBlockReason ?? "报告还没有生成"}</span>
								) : null}
								{versionChip ? (
									<span className="version-chip" data-testid="report-version">
										{versionChip}
									</span>
								) : null}
								{workspace.report.note && downloadPhase !== "blocked" ? <span className="quiet">{workspace.report.note}</span> : null}
							</div>
						) : null}
					</div>
					<DemandForm
						project={project}
						text={workspace.text}
						busy={workspace.busy}
						locked={analysisActive}
						collapsed={collapsed}
						compileCount={workspace.compileView?.phase === "ready" ? workspace.compileView.requirementCount : null}
						compileNotices={workspace.compileView?.phase === "ready" ? workspace.compileView.notices : []}
						historyNote={workspace.historyNote}
						synthetic={workspace.historyNote?.synthetic ?? null}
						startLabel={startLabel}
						quietStart={startLabel === "再次分析"}
						showStart={showStart}
						onText={workspace.onText}
						onUpload={workspace.onUpload}
						onImport={workspace.onImportHistory}
						onStart={workspace.onStart}
					/>
					{workspace.activity ? (
						<p data-testid="activity" aria-live="polite">
							{workspace.activity}
						</p>
					) : null}
					{workspace.error ? (
						<div role="alert" className="abnormal failed">
							<p>{workspace.error.summary}</p>
							{workspace.error.technical ? (
								<details>
									<summary>补充说明</summary>
									<p className="technical">{workspace.error.technical}</p>
								</details>
							) : null}
						</div>
					) : null}
					<RunPanel
						run={run}
						pipelineStatus={headingStatus}
						events={workspace.events}
						stopReason={workspace.stopReason}
						candidateCount={workspace.candidateCount}
						reportNote={
							workspace.report.report?.status === "COMPLETED"
								? {
										at: workspace.report.report.updated_at ?? workspace.report.report.created_at,
										decisionVersion: null,
									}
								: null
						}
						runs={workspace.runHistory}
						onSelectRun={workspace.selectRun}
					/>
					{progressLine ? (
						<p className="quiet" data-testid="pipeline-line">
							{progressLine}
						</p>
					) : null}
					{workspace.pipelineNote ? <p data-testid="pipeline-note">{workspace.pipelineNote}</p> : null}
					{workspace.candidates.loadError ? <p className="quiet">{workspace.candidates.loadError}</p> : null}
					{workspace.candidates.summaryLine ? (
						<p className="quiet" data-testid="analysis-summary">
							{workspace.candidates.summaryLine}
						</p>
					) : null}
					{workspace.candidates.recommendationLine ? (
						<p className="quiet" data-testid="analysis-recommendation">
							{workspace.candidates.recommendationLine}
						</p>
					) : null}
					{workspace.candidates.warnings.map((warning) => (
						<p className="quiet" key={warning}>
							{warning}
						</p>
					))}
					{workspace.candidates.loading ? <p className="quiet">正在读取分析结果。</p> : null}
					{showEmptyCandidates ? <p>这次没有候选供应商。</p> : null}
					{candidateRows.length > 0 ? (
						<div className="split">
							<CandidateTable rows={candidateRows} selectedId={workspace.candidates.selectedId} onSelect={workspace.candidates.select} />
							<EvidencePane
								row={selected}
								evidence={workspace.candidates.evidence}
								evidenceError={workspace.candidates.evidenceError}
								onOpenEvidence={workspace.candidates.openEvidence}
								onSelect={workspace.candidates.select}
								onClose={workspace.candidates.clear}
							/>
						</div>
					) : null}
				</>
			) : null}
		</WorkspaceShell>
	);
}
