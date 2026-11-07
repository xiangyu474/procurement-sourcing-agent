import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CandidateRowView } from "../view/candidates";
import { EvidencePane } from "./EvidencePane";

const row: CandidateRowView = {
	id: "c1",
	supplier: "海康威视",
	supplierCount: 1,
	model: "DS-1",
	stage: { label: "长名单", tone: "long", note: "公开资料里的线索。" },
	technical: { label: "还不能判断", tone: "unknown" },
	checks: [],
	summary: null,
	decision: null,
	ambiguous: false,
	sourceTitle: null,
	sourceDate: null,
	excerpt: null,
	evidenceId: null,
	sourceUrl: null,
	otherEvidence: [],
	prices: [],
	groupCount: 1,
	members: [],
};

describe("EvidencePane", () => {
	it("closes from the button and from Escape", () => {
		const onClose = vi.fn();
		render(
			<EvidencePane
				row={row}
				evidence={null}
				evidenceError={null}
				onOpenEvidence={() => {}}
				onSelect={() => {}}
				onClose={onClose}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "关闭" }));
		fireEvent.keyDown(window, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(2);
	});

	it("does not close while a text field has Escape", () => {
		const onClose = vi.fn();
		render(
			<div>
				<textarea aria-label="需求文字" />
				<EvidencePane
					row={row}
					evidence={null}
					evidenceError={null}
					onOpenEvidence={() => {}}
					onSelect={() => {}}
					onClose={onClose}
				/>
			</div>,
		);
		const field = screen.getByLabelText("需求文字");
		fireEvent.keyDown(field, { key: "Escape" });
		expect(onClose).not.toHaveBeenCalled();
	});
});
