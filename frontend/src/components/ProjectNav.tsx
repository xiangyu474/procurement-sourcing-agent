import { useState, type FormEvent } from "react";
import { listStatus } from "../api/adapter";
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
	busy: boolean;
	onCreate: (title: string) => Promise<boolean>;
	onOpen: (projectId: string) => Promise<boolean>;
	onSelect: (projectId: string) => void;
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
			<div className="project-list">
				{props.projects.map((project) => {
					const raw = listStatus(project.latest_run?.status ?? null, null);
					const label = statusText(raw);
					const tone = statusTone(raw);
					return (
						<button
							key={project.id}
							type="button"
							className={project.id === props.activeProjectId ? "project current" : "project"}
							aria-current={project.id === props.activeProjectId ? "true" : undefined}
							onClick={() => props.onSelect(project.id)}
						>
							<span className="project-name">{project.title}</span>
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
