import type { ReactNode } from "react";

/**
 * Inspector shell. `detail` is the F2 evidence column and `report` is the F3
 * download action. F1 leaves both unset, so neither region is rendered.
 */
export function WorkspaceShell(props: { nav: ReactNode; children: ReactNode; detail?: ReactNode; report?: ReactNode }) {
	return (
		<div className="shell">
			{props.nav}
			<main className="work">
				{props.report ? <div className="report-slot">{props.report}</div> : null}
				{props.detail ? (
					<div className="split">
						<div>{props.children}</div>
						{props.detail}
					</div>
				) : (
					props.children
				)}
			</main>
		</div>
	);
}
