import { isTerminalRun } from "./api/adapter";
import { CandidateTable } from "./components/CandidateTable";
import { DemandForm } from "./components/DemandForm";
import { EvidencePane } from "./components/EvidencePane";
import { ProjectNav } from "./components/ProjectNav";
import { RunPanel } from "./components/RunPanel";
import { WorkspaceShell } from "./components/WorkspaceShell";
import { useWorkspace } from "./workspace/useWorkspace";
import { reportButtonLabel, reportPhase } from "./view/report";

export function App() {
	const workspace = useWorkspace();
	const project = workspace.project;
	const run = workspace.run && workspace.run.project_id === project?.id ? workspace.run : null;
	const runActive = Boolean(run && !isTerminalRun(run.status));
	const collapsed = Boolean(run && isTerminalRun(run.status));
	const startLabel = runActive ? "分析进行中" : run ? "再次分析" : "开始分析";
	const downloadPhase = reportPhase({
		runStatus: run?.status ?? null,
		decisionsReady: workspace.candidates.decisionsReady,
		report: workspace.report.report,
		pending: workspace.report.pending,
	});
	const candidateRows = workspace.candidates.rows;
	const selected = candidateRows.find((row) => row.id === workspace.candidates.selectedId) ?? null;
	const showEmptyCandidates = Boolean(
		run &&
			(run.status === "COMPLETED" || run.status === "PARTIAL") &&
			!workspace.candidates.loading &&
			!workspace.candidates.loadError &&
			candidateRows.length === 0,
	);

	return (
		<WorkspaceShell
			nav={
				<ProjectNav
					projects={workspace.projects}
					activeProjectId={workspace.activeProjectId}
					busy={workspace.busy}
					onCreate={workspace.onCreate}
					onOpen={workspace.onOpen}
					onSelect={workspace.onSelect}
				/>
			}
		>
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
								{workspace.report.note && downloadPhase !== "blocked" ? <span className="quiet">{workspace.report.note}</span> : null}
							</div>
						) : null}
					</div>
					<DemandForm
						project={project}
						text={workspace.text}
						busy={workspace.busy}
						locked={runActive}
						collapsed={collapsed}
						compileCount={workspace.compileView?.phase === "ready" ? workspace.compileView.requirementCount : null}
						compileNotices={workspace.compileView?.phase === "ready" ? workspace.compileView.notices : []}
						historyNote={workspace.historyNote}
						synthetic={workspace.historyNote?.synthetic ?? null}
						startLabel={startLabel}
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
						events={workspace.events}
						stopReason={workspace.stopReason}
						candidateCount={workspace.candidateCount}
						reportNote={
							workspace.report.report?.status === "COMPLETED"
								? {
										at: workspace.report.report.updated_at ?? workspace.report.report.created_at,
										decisionVersion: workspace.report.report.decision_version,
									}
								: null
						}
						runs={workspace.runHistory}
						onSelectRun={workspace.selectRun}
					/>
					{workspace.candidates.progressLine ? <p className="quiet">{workspace.candidates.progressLine}</p> : null}
					{workspace.candidates.listNote ? <p>{workspace.candidates.listNote}</p> : null}
					{workspace.candidates.loading ? <p className="quiet">正在读取候选。</p> : null}
					{showEmptyCandidates ? <p>这次没有候选供应商。</p> : null}
					{candidateRows.length > 0 ? (
						<div className="split">
							<CandidateTable rows={candidateRows} selectedId={workspace.candidates.selectedId} onSelect={workspace.candidates.select} />
							<EvidencePane
								row={selected}
								evidence={workspace.candidates.evidence}
								evidenceError={workspace.candidates.evidenceError}
								onOpenEvidence={workspace.candidates.openEvidence}
							/>
						</div>
					) : null}
				</>
			) : null}
		</WorkspaceShell>
	);
}
