import { useState, type FormEvent } from "react";
import type { LocalProject } from "../storage";

export function ProjectNav(props: {
	projects: LocalProject[];
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
					aria-label="项目名称"
					value={title}
					onChange={(event) => setTitle(event.target.value)}
					disabled={props.busy}
				/>
				<button type="submit" disabled={props.busy}>
					创建
				</button>
			</form>
			<div className="project-list">
				{props.projects.map((project) => (
					<button
						key={project.projectId}
						type="button"
						className={project.projectId === props.activeProjectId ? "project active" : "project"}
						aria-current={project.projectId === props.activeProjectId ? "true" : undefined}
						onClick={() => props.onSelect(project.projectId)}
					>
						<span className="project-name">{project.title}</span>
						<span className="project-status">{project.lastStatusLabel}</span>
					</button>
				))}
			</div>
			<form className="open" onSubmit={open}>
				<input
					aria-label="项目编号"
					value={openId}
					onChange={(event) => setOpenId(event.target.value)}
					disabled={props.busy}
				/>
				<button type="submit" disabled={props.busy || !openId.trim()}>
					打开
				</button>
			</form>
		</nav>
	);
}
