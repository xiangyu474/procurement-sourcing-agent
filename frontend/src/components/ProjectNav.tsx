import { useState, type FormEvent } from "react";
import { formatProjectDate, listStatus, openRailStatus } from "../api/adapter";
import type { ProjectSummary } from "../api/types";

function statusText(label: string): string {
	return label === "未完成" ? "未能完成" : label;
}

function statusTone(label: string): string {
	if (label === "进行中" || label === "整理需求") return "st-run";
	if (label === "部分完成") return "st-partial";
	if (label === "未完成" || label === "未能完成") return "st-fail";
	return "";
}

export function ProjectNav(props: {
	projects: ProjectSummary[];
	activeProjectId: string | null;
	/** Pipeline status of the open project. The rail must not use the research run instead. */
	pipelineStatus?: string | null;
	/**
	 * When the open project's latest known compile job failed, and no newer run
	 * started after it. ISO time from the session, not a list-API field.
	 */
	compileFailedAt?: string | null;
	busy: boolean;
	sampleBusy: boolean;
	onCreate: (title: string) => Promise<boolean>;
	onOpen: (projectId: string) => Promise<boolean>;
	onSelect: (projectId: string) => void;
	onSample: () => Promise<void>;
}) {
	const [title, setTitle] = useState("");
	const [openId, setOpenId] = useState("");

	const create = (event: FormEvent) => {
		event.preventDefault();
		void props.onCreate(title).then((ok) => {
			if (ok) setTitle("");
		});
	};

	const open = (event: FormEvent) => {
		event.preventDefault();
		void props.onOpen(openId).then((ok) => {
			if (ok) setOpenId("");
		});
	};

	return (
		<nav className="nav" aria-label="项目">
			<form className="create" onSubmit={create}>
				<input
					aria-label="新项目名称"
					placeholder="新项目名称"
					value={title}
					onChange={(event) => setTitle(event.target.value)}
					disabled={props.busy}
				/>
				<button type="submit" disabled={props.busy}>
					创建
				</button>
			</form>
			<button className="ghost sample" type="button" disabled={props.busy || props.sampleBusy} onClick={() => void props.onSample()}>
				{props.sampleBusy ? "正在打开示例" : "查看示例结果"}
			</button>
			<div className="project-list">
				{props.projects.map((project) => {
					const open = project.id === props.activeProjectId;
					const decision = openRailStatus({
						pipelineStatus: open ? props.pipelineStatus : null,
						runStatus: project.latest_run?.status ?? null,
						runUpdatedAt: project.latest_run?.updated_at ?? null,
						compileFailedAt: open ? props.compileFailedAt : null,
					});
					const raw = listStatus(decision.status, null);
					const label = decision.compileFailed ? "未完成" : statusText(raw);
					const tone = statusTone(decision.compileFailed ? "未完成" : raw);
					const created = formatProjectDate(project.created_at);
					return (
						<button
							key={project.id}
							type="button"
							className={project.id === props.activeProjectId ? "project current" : "project"}
							aria-current={project.id === props.activeProjectId ? "true" : undefined}
							onClick={() => props.onSelect(project.id)}
						>
							<span className="project-main">
								<span className="project-name">
									{project.title}
									{project.is_sample ? <span className="sample-tag">示例</span> : null}
								</span>
								{created ? <span className="project-created">{created}</span> : null}
							</span>
							<span className={tone ? `project-status ${tone}` : "project-status"}>{label}</span>
						</button>
					);
				})}
			</div>
			<details className="by-id">
				<summary>用编号打开</summary>
				<form onSubmit={open}>
					<input
						aria-label="项目编号"
						placeholder="项目编号"
						value={openId}
						onChange={(event) => setOpenId(event.target.value)}
						disabled={props.busy}
					/>
					<button type="submit" disabled={props.busy || !openId.trim()}>
						打开
					</button>
				</form>
			</details>
		</nav>
	);
}
