import type { CandidateRowView } from "../view/candidates";

function toneClass(tone: string): string {
	if (tone === "short") return "stage short";
	if (tone === "verify") return "stage verify";
	if (tone === "pass") return "tech pass";
	if (tone === "fail") return "tech fail";
	if (tone === "unknown") return "tech unknown";
	if (tone === "none") return "tech none";
	return "stage long";
}

export function CandidateTable(props: {
	rows: CandidateRowView[];
	selectedId: string | null;
	onSelect: (id: string) => void;
}) {
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
				{props.rows.map((row) => {
					const selected = row.id === props.selectedId;
					return (
						<tr
							key={row.id}
							className={selected ? "selected" : undefined}
							aria-selected={selected}
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
							</td>
							<td data-label="型号">
								<span className="model">{row.model}</span>
							</td>
							<td data-label="阶段">
								<span className={toneClass(row.stage.tone)}>{row.stage.label}</span>
							</td>
							<td data-label="技术">
								<span className={toneClass(row.technical.tone)}>{row.technical.label}</span>
							</td>
						</tr>
					);
				})}
			</tbody>
		</table>
	);
}
