import { explainRun, runStatusLabel, stageLabel } from "../api/adapter";
import type { ProjectRunSummary, Run, RunEvent } from "../api/types";
import { analysisInProgress, pipelineHeading } from "../view/pipeline";

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

export function RunPanel(props: {
	run: Run | null;
	events: RunEvent[];
	stopReason: string | null;
	candidateCount?: number | null;
	reportNote?: { at: string | null; decisionVersion: string | null } | null;
	runs?: ProjectRunSummary[];
	onSelectRun?: (runId: string) => void;
	/** Pipeline status for this run. It decides the heading when the task is terminal. */
	pipelineStatus?: string | null;
}) {
	const { run, events, stopReason, candidateCount = null } = props;
	if (!run) return null;
	const abnormal = explainRun({ status: run.status, lastError: run.last_error, stopReason, candidateCount });
	const toneStatus = props.pipelineStatus && ["QUEUED", "RUNNING", "PARTIAL", "FAILED", "COMPLETED"].includes(props.pipelineStatus) ? props.pipelineStatus : run.status;
	const tone = statusTone(toneStatus);
	const heading = pipelineHeading(props.pipelineStatus) ?? statusText(run);
	const inProgress = analysisInProgress(props.pipelineStatus, run.status);
	const when = `${formatRunStamp(run.created_at)} ${inProgress ? "开始" : "的寻源"}`;
	return (
		<section className="progress" aria-label="进度">
			<h2 className={tone ? `status ${tone}` : "status"} data-testid="run-status">
				{heading}
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
				{events.length > 0 ? (
					<ol>
						{events.map((event, index) => (
							<li key={`${event.created_at}-${event.stage}-${index}`}>
								<time dateTime={event.created_at}>{formatRunStamp(event.created_at)}</time>
								<span>{stageLabel(event.stage)}</span>
							</li>
						))}
					</ol>
				) : null}
				<p className="run-id" data-testid="run-id">
					编号 {run.id}
				</p>
				{props.reportNote?.at ? <p className="quiet">报告生成于 {formatRunStamp(props.reportNote.at)}</p> : null}
				{props.reportNote?.decisionVersion ? <p className="quiet">决策版本 {props.reportNote.decisionVersion}</p> : null}
				{props.runs && props.runs.length > 1 ? (
					<div className="past-runs">
						{props.runs.map((item) => (
							<button
								key={item.id}
								type="button"
								className="text-button"
								aria-current={item.id === run.id ? "true" : undefined}
								onClick={() => props.onSelectRun?.(item.id)}
							>
								{formatRunStamp(item.created_at)} 的寻源
							</button>
						))}
					</div>
				) : null}
			</details>
		</section>
	);
}
