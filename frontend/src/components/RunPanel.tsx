import { explainRun, runStatusLabel, stageLabel } from "../api/adapter";
import type { Run, RunEvent } from "../api/types";

function formatRunStamp(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const hour = String(date.getHours()).padStart(2, "0");
	const minute = String(date.getMinutes()).padStart(2, "0");
	return `${date.getMonth() + 1}月${date.getDate()}日 ${hour}:${minute}`;
}

function statusText(run: Run): string {
	if (run.status === "RUNNING" && run.current_stage === "WEB_RESEARCH") return "正在查阅公开资料";
	return runStatusLabel(run.status, run.current_stage);
}

function statusTone(status: string): string {
	if (status === "QUEUED" || status === "RUNNING") return "tone-running";
	if (status === "PARTIAL") return "tone-partial";
	if (status === "FAILED") return "tone-fail";
	return "";
}

export function RunPanel(props: { run: Run | null; events: RunEvent[]; stopReason: string | null }) {
	const { run, events, stopReason } = props;
	if (!run) return null;
	const abnormal = explainRun({ status: run.status, lastError: run.last_error, stopReason });
	const tone = statusTone(run.status);
	const inProgress = run.status === "QUEUED" || run.status === "RUNNING";
	const when = `${formatRunStamp(run.created_at)} ${inProgress ? "开始" : "的寻源"}`;
	return (
		<section className="progress" aria-label="进度">
			<h2 className={tone ? `status ${tone}` : "status"} data-testid="run-status">
				{statusText(run)}
			</h2>
			<p className="version" data-testid="run-version">
				{when}
			</p>
			{abnormal ? (
				<div role="alert" className={run.status === "FAILED" ? "abnormal failed" : "abnormal"}>
					<p>{abnormal}</p>
				</div>
			) : null}
			<details className="trace">
				<summary>过程记录</summary>
				<ol>
					{events.map((event, index) => (
						<li key={`${event.created_at}-${event.stage}-${index}`}>
							<time dateTime={event.created_at}>{formatRunStamp(event.created_at)}</time>
							<span>{stageLabel(event.stage)}</span>
						</li>
					))}
					<li className="run-id" data-testid="run-id">
						编号 {run.id}
					</li>
				</ol>
			</details>
		</section>
	);
}
