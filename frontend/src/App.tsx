import { isTerminalRun } from "./api/adapter";
import { DemandForm } from "./components/DemandForm";
import { ProjectNav } from "./components/ProjectNav";
import { RunPanel } from "./components/RunPanel";
import { WorkspaceShell } from "./components/WorkspaceShell";
import { useWorkspace } from "./workspace/useWorkspace";

export function App() {
	const workspace = useWorkspace();
	const project = workspace.project;
	const entry = project ? workspace.store.projects.find((item) => item.projectId === project.id) : undefined;
	const run = workspace.run && workspace.run.project_id === project?.id ? workspace.run : null;
	const runActive = Boolean(run && !isTerminalRun(run.status));
	const collapsed = Boolean(run && isTerminalRun(run.status));
	const startLabel = runActive ? "寻源进行中" : run ? "再次寻源" : "开始寻源";

	return (
		<WorkspaceShell
			nav={
				<ProjectNav
					projects={workspace.store.projects}
					activeProjectId={workspace.store.activeProjectId}
					busy={workspace.busy}
					onCreate={workspace.onCreate}
					onOpen={workspace.onOpen}
					onSelect={workspace.onSelect}
				/>
			}
		>
			{!project && workspace.error ? (
				<div role="alert" className="abnormal failed">
					<p>{workspace.error.summary}</p>
				</div>
			) : null}
			{project ? (
				<>
					<h1>{project.title}</h1>
					{entry?.unknownRun && !run ? (
						<p className="abnormal" role="status">
							此浏览器没有这次寻源的记录。开始寻源会再启动一次。
						</p>
					) : null}
					<DemandForm
						project={project}
						text={workspace.text}
						busy={workspace.busy}
						locked={runActive}
						collapsed={collapsed}
						compileCount={workspace.compileView?.phase === "ready" ? workspace.compileView.requirementCount : null}
						historyNote={workspace.historyNote}
						synthetic={entry?.historySynthetic ?? null}
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
					<RunPanel run={run} events={workspace.events} stopReason={workspace.stopReason} />
				</>
			) : null}
		</WorkspaceShell>
	);
}
