import { Fragment, useState } from "react";
import type { CandidateRowView } from "../view/candidates";

function toneClass(tone: string, kind: "stage" | "tech"): string {
	if (kind === "tech") {
		if (tone === "pass") return "tech pass";
		if (tone === "fail") return "tech fail";
		if (tone === "unknown") return "tech unknown";
		return "tech none";
	}
	if (tone === "short") return "stage short";
	if (tone === "verify") return "stage verify";
	return "stage long";
}

export function CandidateTable(props: {
	rows: CandidateRowView[];
	selectedId: string | null;
	onSelect: (id: string) => void;
}) {
	const [openGroup, setOpenGroup] = useState<string | null>(null);
	const renderRow = (row: CandidateRowView, leader: boolean) => {
		const selected = row.id === props.selectedId;
		return (
			<tr
				key={row.id}
				className={selected ? "selected" : undefined}
				aria-selected={row.id === props.selectedId}
				tabIndex={0}
				onClick={() => props.onSelect(row.id)}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						props.onSelect(row.id);
					}
				}}
			>
				<td data-label="供应商">
					<span className="supplier">{row.supplier}</span>
					{leader && row.groupCount > 1 ? (
						<button
							className="text-button"
							type="button"
							onClick={(event) => {
								event.stopPropagation();
								setOpenGroup(openGroup === row.id ? null : row.id);
							}}
						>
							同型号 {row.groupCount} 条
						</button>
					) : null}
				</td>
				<td data-label="型号">
					<span className="model">{row.model}</span>
				</td>
				<td data-label="阶段">
					<span className={toneClass(row.stage.tone, "stage")}>{row.stage.label}</span>
				</td>
				<td data-label="技术">
					<span className={toneClass(row.technical.tone, "tech")}>{row.technical.label}</span>
				</td>
			</tr>
		);
	};
	return (
		<table>
			<colgroup>
				<col className="supplier" />
				<col className="model" />
				<col className="stage" />
				<col className="tech" />
			</colgroup>
			<thead>
				<tr>
					<th>供应商</th>
					<th>型号</th>
					<th>阶段</th>
					<th>技术</th>
				</tr>
			</thead>
			<tbody>
				{props.rows.map((row) => (
					<Fragment key={row.id}>
						{renderRow(row, true)}
						{openGroup === row.id ? row.members.slice(1).map((member) => renderRow(member, false)) : null}
					</Fragment>
				))}
			</tbody>
		</table>
	);
}
