import { useState, type FormEvent } from "react";
import type { Project } from "../api/types";
import { canImportHistory, historyLabel, pptxLabel, textDemandLabel } from "../workspace/labels";
import type { HistoryNote } from "../workspace/types";

export function DemandForm(props: {
	project: Project;
	text: string;
	busy: boolean;
	locked: boolean;
	collapsed: boolean;
	compileCount: number | null;
	historyNote: HistoryNote | null;
	synthetic: boolean | null;
	startLabel: string;
	onText: (value: string) => void;
	onUpload: (purpose: "REQUIREMENT" | "HISTORY", file: File) => Promise<void>;
	onImport: () => Promise<void>;
	onStart: () => Promise<void>;
}) {
	const [pptxKey, setPptxKey] = useState(0);
	const [xlsxKey, setXlsxKey] = useState(0);
	const textLine = textDemandLabel(props.project);
	const pptx = pptxLabel(props.project);
	const history = historyLabel(props.project, props.historyNote, props.synthetic);
	const summary = [
		"需求",
		textLine,
		pptx ? "PPTX 已接收" : null,
		history,
		props.compileCount != null ? `已整理 ${props.compileCount} 条采购项` : null,
	]
		.filter(Boolean)
		.join(" · ");

	const onFile = (purpose: "REQUIREMENT" | "HISTORY", file: File | undefined, reset: () => void) => {
		if (!file) return;
		void props.onUpload(purpose, file).finally(reset);
	};

	const start = (event: FormEvent) => {
		event.preventDefault();
		void props.onStart();
	};

	const fields = (
		<>
			<label className="field">
				<textarea
					aria-label="需求文字"
					placeholder="填写采购需求"
					value={props.text}
					onChange={(event) => props.onText(event.target.value)}
					disabled={props.busy || props.locked}
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
						disabled={props.busy || props.locked}
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
						disabled={props.busy || props.locked}
						onChange={(event) => {
							const file = event.target.files?.[0];
							onFile("HISTORY", file, () => setXlsxKey((value) => value + 1));
						}}
					/>
				</label>
			</div>
			<ul className="received">
				{textLine ? <li>{textLine}</li> : null}
				{pptx ? <li className="file-name">{pptx}</li> : null}
				{history ? <li className="file-name">{history}</li> : null}
			</ul>
			{props.compileCount != null ? <p className="arranged">已整理 {props.compileCount} 条采购项</p> : null}
		</>
	);

	const actions = (
		<div className="actions">
			{canImportHistory(props.project, props.historyNote) ? (
				<button className="ghost" type="button" disabled={props.busy || props.locked} onClick={() => void props.onImport()}>
					导入历史数据
				</button>
			) : null}
			<button className="primary" type="submit" disabled={props.busy || props.locked}>
				{props.startLabel}
			</button>
		</div>
	);

	if (!props.collapsed) {
		return (
			<form onSubmit={start}>
				{fields}
				{actions}
			</form>
		);
	}

	return (
		<form onSubmit={start}>
			<details className="summary">
				<summary>{summary}</summary>
				{fields}
			</details>
			{actions}
		</form>
	);
}
