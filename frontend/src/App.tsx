import { useState, type FormEvent } from "react";
import { isTerminalRun } from "./api/adapter";
import { ProjectNav } from "./components/ProjectNav";
import { RunPanel } from "./components/RunPanel";
import { canImportHistory, historyLabel, pptxLabel, textDemandLabel } from "./workspace/labels";
import { useWorkspace } from "./workspace/useWorkspace";

export function App() {
	const workspace = useWorkspace();
	const project = workspace.project;
	const entry = project ? workspace.store.projects.find((item) => item.projectId === project.id) : undefined;
	const runActive = Boolean(workspace.run && workspace.run.project_id === project?.id && !isTerminalRun(workspace.run.status));
	const [pptxKey, setPptxKey] = useState(0);
	const [xlsxKey, setXlsxKey] = useState(0);

	const start = (event: FormEvent) => {
		event.preventDefault();
		void workspace.onStart();
	};

	const onFile = (purpose: "REQUIREMENT" | "HISTORY", file: File | undefined, reset: () => void) => {
		if (!file) return;
		void workspace.onUpload(purpose, file).finally(reset);
	};

	return (
		<div className="layout">
			<ProjectNav
				projects={workspace.store.projects}
				activeProjectId={workspace.store.activeProjectId}
				busy={workspace.busy}
				onCreate={workspace.onCreate}
				onOpen={workspace.onOpen}
				onSelect={workspace.onSelect}
			/>
			<main className="main">
				{!project ? <p className="prompt">创建或打开一个项目</p> : null}
				{project ? (
					<div className="sheet">
						<header className="title-row">
							<h1>{project.title}</h1>
						</header>
						{entry?.unknownRun && !workspace.run ? (
							<p className="abnormal partial" role="status">
								此浏览器没有这次项目的运行记录。开始寻源会启动一次新的运行。
							</p>
						) : null}
						<form onSubmit={start}>
							<label className="field">
								<textarea
									aria-label="需求文字"
									value={workspace.text}
									onChange={(event) => workspace.onText(event.target.value)}
									disabled={workspace.busy || runActive}
								/>
							</label>
							<div className="files">
								<label className="file">
									上传 PPTX
									<input
										key={pptxKey}
										aria-label="上传 PPTX"
										type="file"
										accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
										disabled={workspace.busy || runActive}
										onChange={(event) => {
											const file = event.target.files?.[0];
											onFile("REQUIREMENT", file, () => setPptxKey((value) => value + 1));
										}}
									/>
								</label>
								<label className="file">
									上传历史 XLSX
									<input
										key={xlsxKey}
										aria-label="上传历史 XLSX"
										type="file"
										accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
										disabled={workspace.busy || runActive}
										onChange={(event) => {
											const file = event.target.files?.[0];
											onFile("HISTORY", file, () => setXlsxKey((value) => value + 1));
										}}
									/>
								</label>
							</div>
							<ul className="received">
								{textDemandLabel(project) ? <li>{textDemandLabel(project)}</li> : null}
								{pptxLabel(project) ? <li className="file-name">{pptxLabel(project)}</li> : null}
								{historyLabel(project, workspace.historyNote, entry?.historySynthetic ?? null) ? (
									<li className="file-name">{historyLabel(project, workspace.historyNote, entry?.historySynthetic ?? null)}</li>
								) : null}
								{workspace.compileView?.phase === "ready" ? <li>已整理 {workspace.compileView.requirementCount} 条采购项</li> : null}
							</ul>
							{canImportHistory(project, workspace.historyNote) ? (
								<button type="button" disabled={workspace.busy || runActive} onClick={() => void workspace.onImportHistory()}>
									导入历史数据
								</button>
							) : null}
							<div className="actions">
								<button className="primary" type="submit" disabled={workspace.busy || runActive}>
									{runActive ? "寻源进行中" : workspace.run ? "再次寻源" : "开始寻源"}
								</button>
							</div>
						</form>
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
						<RunPanel run={workspace.run} events={workspace.events} stopReason={workspace.stopReason} />
					</div>
				) : null}
				{!project && workspace.error ? (
					<div role="alert" className="abnormal failed sheet">
						<p>{workspace.error.summary}</p>
					</div>
				) : null}
			</main>
		</div>
	);
}
