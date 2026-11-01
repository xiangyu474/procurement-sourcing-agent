import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { blankProject } from "../storage";
import { ProjectNav } from "./ProjectNav";

const longName = "集团总部2026年度工业视觉与网络摄像机框架寻源（含多园区、多品牌、超长供应商名称不应撑破导航）";

describe("ProjectNav", () => {
	it("creates a project and keeps a long name inside the navigation item", async () => {
		const onCreate = vi.fn(async () => true);
		const project = blankProject("p1", longName, false);
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
	});
});
