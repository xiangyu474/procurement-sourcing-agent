import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Project } from "../api/types";
import { DemandForm } from "./DemandForm";

const project: Project = {
	id: "p1",
	title: "摄像机",
	analysis_version: 1,
	demand_revision: 1,
	history_availability: "NOT_PROVIDED",
	created_at: "2026-11-02T00:00:00.000Z",
	sources: [],
};

function renderForm(collapsed: boolean) {
	render(
		<DemandForm
			project={project}
			text="采购 10 套工业摄像机"
			busy={false}
			locked={false}
			collapsed={collapsed}
			compileCount={1}
			compileNotices={["计划预算未确认"]}
			historyNote={null}
			synthetic={null}
			startLabel={collapsed ? "再次寻源" : "开始寻源"}
			onText={() => {}}
			onUpload={async () => {}}
			onImport={async () => {}}
			onStart={async () => {}}
		/>,
	);
}

describe("DemandForm", () => {
	it("places compile notes above the start button", () => {
		renderForm(false);
		const notice = screen.getByText("计划预算未确认");
		const button = screen.getByRole("button", { name: "开始寻源" });
		expect(notice.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("keeps compile notes above the button after the demand is collapsed", () => {
		renderForm(true);
		const notice = screen.getByText("计划预算未确认");
		const button = screen.getByRole("button", { name: "再次寻源" });
		expect(notice.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});
});
