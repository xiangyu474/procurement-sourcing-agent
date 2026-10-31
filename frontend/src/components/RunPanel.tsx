import { explainRun, formatTimestamp, runStatusLabel, stageLabel } from "../api/adapter";
import type { Run, RunEvent } from "../api/types";

export function RunPanel(props: { run: Run | null; events: RunEvent[]; stopReason: string | null }) {
	const { run, events, stopReason } = props;
	if (!run) return null;
	const abnormal = explainRun({ status: run.status, lastError: run.last_error, stopReason });
	const tone = run.status === "FAILED" ? "failed" : run.status === "PARTIAL" ? "partial" : "";
	return (
		<section className="progress" aria-label="进度">
			<h2 data-testid="run-status">{runStatusLabel(run.status, run.current_stage)}</h2>
			<p className="meta">运行 {run.id}</p>
			{abnormal ? (
				<div role="alert" className={`abnormal ${tone}`}>
					<p>{abnormal}</p>
				</div>
			) : null}
			{events.length > 0 ? (
				<details>
					<summary>过程记录</summary>
					<ol>
						{events.map((event, index) => (
							<li key={`${event.created_at}-${event.stage}-${index}`}>
								<time dateTime={event.created_at}>{formatTimestamp(event.created_at)}</time>
								<span>{stageLabel(event.stage)}</span>
							</li>
						))}
					</ol>
				</details>
			) : null}
		</section>
	);
}
