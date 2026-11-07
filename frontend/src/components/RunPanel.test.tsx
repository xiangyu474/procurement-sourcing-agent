import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Run } from "../api/types";
import { RunPanel } from "./RunPanel";

function run(overrides: Partial<Run>): Run {
	return {
		id: "run-123",
		project_id: "p1",
		status: "COMPLETED",
		current_stage: "WEB_RESEARCH",
		artifact_key: null,
		last_error: null,
		created_at: "2026-10-31T00:00:00.000Z",
		updated_at: "2026-10-31T00:05:00.000Z",
		...overrides,
	};
}

describe("RunPanel", () => {
	it("shows a partial result without internal research terms", () => {
		render(
			<RunPanel
				run={run({ status: "PARTIAL", current_stage: "PARTIAL" })}
				events={[{ stage: "WEB_RESEARCH", created_at: "2026-10-31T00:02:00.000Z" }]}
				stopReason="BUDGET_EXHAUSTED"
			/>,
		);
		expect(screen.getByTestId("run-status").textContent).toContain("部分完成");
		expect(screen.getByRole("alert").textContent).toContain("已保留目前得到的结果。本次公开查阅的次数已用完。");
		expect(screen.getByTestId("run-version").textContent).not.toContain("run-123");
		expect(screen.getByTestId("run-id").textContent).toContain("run-123");
		expect(document.body.textContent).not.toMatch(/Supervisor|Researcher|DSL|token/i);
	});

	it("names an in-progress public search without the run id", () => {
		render(<RunPanel run={run({ status: "RUNNING", current_stage: "WEB_RESEARCH" })} events={[]} stopReason={null} />);
		expect(screen.getByTestId("run-status").textContent).toContain("正在查阅公开资料");
		expect(screen.getByTestId("run-version").textContent).toContain("开始");
		expect(screen.getByTestId("run-version").textContent).not.toContain("run-123");
	});

	it("does not explain a finished run", () => {
		render(<RunPanel run={run({})} events={[]} stopReason={null} />);
		expect(screen.getByTestId("run-status").textContent).toContain("寻源已结束");
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("does not call a running assessment a finished search", () => {
		render(
			<RunPanel
				run={run({ status: "COMPLETED", current_stage: "COMPLETED" })}
				events={[]}
				stopReason={null}
				pipelineStatus="RUNNING"
			/>,
		);
		expect(screen.getByTestId("run-status").textContent).toBe("进行中");
		expect(screen.getByTestId("run-status").textContent).not.toContain("寻源已结束");
		expect(screen.getByTestId("run-status").className).toContain("tone-running");
	});

	it("uses the pipeline failure as the heading when research itself finished", () => {
		render(
			<RunPanel
				run={run({ status: "COMPLETED", current_stage: "COMPLETED" })}
				events={[]}
				stopReason={null}
				pipelineStatus="FAILED"
			/>,
		);
		expect(screen.getByTestId("run-status").textContent).toBe("需要处理");
		expect(screen.getByTestId("run-status").textContent).not.toContain("寻源已结束");
		expect(screen.getByTestId("run-status").className).toContain("tone-fail");
	});

	it("drops the in-progress stamp when the pipeline has already failed", () => {
		render(
			<RunPanel
				run={run({ status: "RUNNING", current_stage: "WEB_RESEARCH" })}
				events={[]}
				stopReason={null}
				pipelineStatus="FAILED"
			/>,
		);
		expect(screen.getByTestId("run-status").textContent).toBe("需要处理");
		expect(screen.getByTestId("run-version").textContent).not.toContain("开始");
		expect(screen.getByTestId("run-version").textContent).toContain("的寻源");
	});

	it("wraps a failed reason that names an internal role", () => {
		render(
			<RunPanel
				run={run({ status: "FAILED", current_stage: "FAILED", last_error: "Supervisor stopped" })}
				events={[]}
				stopReason={null}
			/>,
		);
		expect(screen.getByRole("alert").textContent).not.toMatch(/Supervisor/);
		expect(screen.getByRole("alert").textContent).toContain("寻源没有完成");
	});
});
