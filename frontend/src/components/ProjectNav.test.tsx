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
				onCreate={onCreate}
				onOpen={async () => true}
				onSelect={() => {}}
			/>,
		);
		fireEvent.change(screen.getByLabelText("新项目名称"), { target: { value: "新项目" } });
		expect(screen.getByText("用编号打开")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "创建" }));
		expect(onCreate).toHaveBeenCalledWith("新项目");
		const item = screen.getByRole("button", { name: new RegExp(longName) });
		expect(item.querySelector(".project-name")?.className).toContain("project-name");
		expect(screen.getByText("未开始")).toBeTruthy();
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
		render(<ProjectNav projects={projects} activeProjectId="p1" busy={false} onCreate={async () => true} onOpen={async () => true} onSelect={() => {}} />);
		expect(screen.getAllByText("M3 cloud acceptance")).toHaveLength(2);
		expect(screen.getByText(formatProjectDate(projects[0].created_at))).toBeTruthy();
		expect(screen.getByText(formatProjectDate(projects[1].created_at))).toBeTruthy();
		expect(screen.queryByRole("button", { name: "更多" })).toBeNull();
	});
});
