import { explainRun, runStatusLabel, stageLabel } from "../api/adapter";
import type { PipelineStage, ProjectRunSummary, Run, RunEvent } from "../api/types";
import { pipelineProgressLine, pipelineStageLabel } from "../view/pipeline";

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
	pipeline?: { status: string; stage: string | null; stages: PipelineStage[] } | null;
	reportNote?: { at: string | null; decisionVersion: string | null } | null;
	runs?: ProjectRunSummary[];
	onSelectRun?: (runId: string) => void;
}) {
	const { run, events, stopReason, candidateCount = null, pipeline = null } = props;
	if (!run) return null;
	const pipelineHeading = pipeline ? pipelineProgressLine(pipeline.status, pipeline.stage) : null;
	const abnormal = explainRun({ status: run.status, lastError: run.last_error, stopReason, candidateCount });
	const tone = statusTone(pipeline?.status ?? run.status);
	const inProgress = pipeline
		? pipeline.status === "QUEUED" || pipeline.status === "RUNNING"
		: run.status === "QUEUED" || run.status === "RUNNING";
	const when = `${formatRunStamp(run.created_at)} ${inProgress ? "开始" : pipeline ? "的分析" : "的寻源"}`;
	const trace = pipeline && pipeline.stages.length > 0
		? pipeline.stages.map((stage, index) => ({
				key: `${stage.stage}-${index}`,
				at: stage.started_at ?? stage.finished_at,
				label: pipelineStageLabel(stage.stage),
			}))
		: events.map((event, index) => ({
				key: `${event.created_at}-${event.stage}-${index}`,
				at: event.created_at,
				label: stageLabel(event.stage),
			}));
	return (
		<section className="progress" aria-label="进度">
			<h2 className={tone ? `status ${tone}` : "status"} data-testid="run-status">
				{pipelineHeading ?? statusText(run)}
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
				{trace.length > 0 ? (
					<ol>
						{trace.map((step) => (
							<li key={step.key}>
								{step.at ? <time dateTime={step.at}>{formatRunStamp(step.at)}</time> : null}
								<span>{step.label}</span>
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
