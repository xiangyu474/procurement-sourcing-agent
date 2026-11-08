import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { formatProjectDate } from "../api/adapter";
import type { ProjectSummary } from "../api/types";
import { ProjectNav } from "./ProjectNav";

const longName = "集团总部2026年度工业视觉与网络摄像机框架寻源（含多园区、多品牌、超长供应商名称不应撑破导航）";

describe("ProjectNav", () => {
	it("creates a project and keeps a long name inside the navigation item", async () => {
		const onCreate = vi.fn(async () => true);
		const project: ProjectSummary = {
			id: "p1",
			title: longName,
			history_availability: "NOT_PROVIDED",
			demand_revision: 0,
			analysis_version: 0,
			created_at: "2026-10-31T00:00:00.000Z",
			latest_run: null,
		};
		render(
			<ProjectNav
				projects={[project]}
				activeProjectId="p1"
				busy={false}
				sampleBusy={false}
				onCreate={onCreate}
				onOpen={async () => true}
				onSelect={() => {}}
				onSample={async () => {}}
			/>,
		);
		fireEvent.change(screen.getByLabelText("新项目名称"), { target: { value: "新项目" } });
		expect(screen.getByText("用编号打开")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "创建" }));
		expect(onCreate).toHaveBeenCalledWith("新项目");
		const item = screen.getByRole("button", { name: new RegExp(longName) });
		expect(item.querySelector(".project-name")?.className).toContain("project-name");
		expect(screen.getByText("未开始")).toBeTruthy();
		expect(screen.queryByText("示例")).toBeNull();
		expect(screen.getByText(formatProjectDate(project.created_at))).toBeTruthy();
	});

	it("shows a short created date when titles are the same", () => {
		const projects: ProjectSummary[] = [1, 2].map((day) => ({
			id: `p${day}`,
			title: "M3 cloud acceptance",
			history_availability: "NOT_PROVIDED",
			demand_revision: 0,
			analysis_version: 0,
			created_at: `2026-10-${String(day).padStart(2, "0")}T08:30:00.000Z`,
			latest_run: null,
		}));
		render(
			<ProjectNav
				projects={projects}
				activeProjectId="p1"
				busy={false}
				sampleBusy={false}
				onCreate={async () => true}
				onOpen={async () => true}
				onSelect={() => {}}
				onSample={async () => {}}
			/>,
		);
		expect(screen.getAllByText("M3 cloud acceptance")).toHaveLength(2);
		expect(screen.getByText(formatProjectDate(projects[0].created_at))).toBeTruthy();
		expect(screen.getByText(formatProjectDate(projects[1].created_at))).toBeTruthy();
		expect(screen.queryByRole("button", { name: "更多" })).toBeNull();
	});

	it("asks for the sample once and stays disabled while that request is open", () => {
		const onSample = vi.fn(async () => {});
		const { rerender } = render(
			<ProjectNav
				projects={[]}
				activeProjectId={null}
				busy={false}
				sampleBusy={false}
				onCreate={async () => true}
				onOpen={async () => true}
				onSelect={() => {}}
				onSample={onSample}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "查看示例结果" }));
		expect(onSample).toHaveBeenCalledTimes(1);
		rerender(
			<ProjectNav
				projects={[]}
				activeProjectId={null}
				busy={false}
				sampleBusy
				onCreate={async () => true}
				onOpen={async () => true}
				onSelect={() => {}}
				onSample={onSample}
			/>,
		);
		const button = screen.getByRole("button", { name: "正在打开示例" }) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		fireEvent.click(button);
		expect(onSample).toHaveBeenCalledTimes(1);
	});

	it("marks a sample project in the rail", () => {
		render(
			<ProjectNav
				projects={[
					{
						id: "p-sample",
						title: "示例：一次已经完成的寻源与核验",
						is_sample: true,
						history_availability: "NOT_PROVIDED",
						demand_revision: 1,
						analysis_version: 1,
						created_at: "2026-11-07T00:00:00.000Z",
						latest_run: null,
					},
				]}
				activeProjectId="p-sample"
				busy={false}
				sampleBusy={false}
				onCreate={async () => true}
				onOpen={async () => true}
				onSelect={() => {}}
				onSample={async () => {}}
			/>,
		);
		expect(document.querySelector(".sample-tag")?.textContent).toBe("示例");
	});

	it("follows the pipeline while the research run has already ended", () => {
		render(
			<ProjectNav
				projects={[
					{
						id: "p1",
						title: "摄像机",
						history_availability: "NOT_PROVIDED",
						demand_revision: 1,
						analysis_version: 1,
						created_at: "2026-11-07T00:00:00.000Z",
						latest_run: { id: "run-1", status: "COMPLETED", current_stage: "COMPLETED", updated_at: "2026-11-07T01:00:00.000Z" },
					},
				]}
				activeProjectId="p1"
				pipelineStatus="RUNNING"
				busy={false}
				sampleBusy={false}
				onCreate={async () => true}
				onOpen={async () => true}
				onSelect={() => {}}
				onSample={async () => {}}
			/>,
		);
		expect(screen.getByText("进行中")).toBeTruthy();
		expect(screen.queryByText("已结束")).toBeNull();
	});

	it("shows 未完成 when the open project's latest compile failed after the last run", () => {
		render(
			<ProjectNav
				projects={[
					{
						id: "p1",
						title: "摄像机",
						history_availability: "NOT_PROVIDED",
						demand_revision: 2,
						analysis_version: 1,
						created_at: "2026-11-07T00:00:00.000Z",
						latest_run: { id: "run-1", status: "PARTIAL", current_stage: "PARTIAL", updated_at: "2026-11-07T01:00:00.000Z" },
					},
					{
						id: "p2",
						title: "另一项",
						history_availability: "NOT_PROVIDED",
						demand_revision: 1,
						analysis_version: 1,
						created_at: "2026-11-07T00:00:00.000Z",
						latest_run: { id: "run-2", status: "PARTIAL", current_stage: "PARTIAL", updated_at: "2026-11-07T01:00:00.000Z" },
					},
				]}
				activeProjectId="p1"
				pipelineStatus="PARTIAL"
				compileFailedAt="2026-11-08T01:00:00.000Z"
				busy={false}
				sampleBusy={false}
				onCreate={async () => true}
				onOpen={async () => true}
				onSelect={() => {}}
				onSample={async () => {}}
			/>,
		);
		const open = screen.getByRole("button", { name: /摄像机/ });
		expect(open.querySelector(".project-status")?.textContent).toBe("未完成");
		expect(open.querySelector(".project-status")?.className).toContain("st-fail");
		expect(open.textContent).not.toContain("部分完成");
		expect(open.textContent).not.toContain("COMPILE_FAILED");
		const other = screen.getByRole("button", { name: /另一项/ });
		expect(other.querySelector(".project-status")?.textContent).toBe("部分完成");
	});
});
