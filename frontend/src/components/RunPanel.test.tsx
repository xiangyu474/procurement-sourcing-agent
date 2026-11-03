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

	it("uses the pipeline for the heading and the process log when this run has one", () => {
		render(
			<RunPanel
				run={run({ status: "COMPLETED", current_stage: "WEB_RESEARCH" })}
				events={[{ stage: "WEB_RESEARCH", created_at: "2026-10-31T00:02:00.000Z" }]}
				stopReason={null}
				pipeline={{
					status: "COMPLETED",
					stage: "COMPLETED",
					stages: [
						{ stage: "RESEARCH", status: "COMPLETED", started_at: "2026-10-31T00:01:00.000Z", finished_at: "2026-10-31T00:02:00.000Z", error_code: null },
						{ stage: "EVALUATING", status: "COMPLETED", started_at: "2026-10-31T00:02:00.000Z", finished_at: "2026-10-31T00:03:00.000Z", error_code: null },
						{ stage: "DECIDING", status: "COMPLETED", started_at: "2026-10-31T00:03:00.000Z", finished_at: "2026-10-31T00:04:00.000Z", error_code: null },
					],
				}}
			/>,
		);
		expect(screen.getByTestId("run-status").textContent).toBe("已完成");
		expect(screen.getByTestId("run-status").textContent).not.toContain("寻源已结束");
		expect(screen.getByTestId("run-version").textContent).toContain("的分析");
		expect(screen.getByTestId("run-version").textContent).not.toContain("寻源");
		expect(screen.getByText("核对技术与价格")).toBeTruthy();
		expect(screen.getByText("整理采购建议")).toBeTruthy();
		expect(screen.queryByText("查阅公开资料")).toBeNull();
	});

	it("does not explain a finished run", () => {
		render(<RunPanel run={run({})} events={[]} stopReason={null} />);
		expect(screen.getByTestId("run-status").textContent).toContain("寻源已结束");
		expect(screen.queryByRole("alert")).toBeNull();
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
