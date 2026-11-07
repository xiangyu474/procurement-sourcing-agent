import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CandidateRowView } from "../view/candidates";
import { EvidencePane, snapshotHashLabel } from "./EvidencePane";

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

	it("shows the source url, hash and meta, and omits lines that are missing", () => {
		const withSource = { ...row, evidenceId: "ev_1" };
		const { rerender } = render(
			<EvidencePane
				row={withSource}
				evidence={{
					evidence_id: "ev_1",
					title: "规格页",
					source_url: "https://example.com/very/long/specification/page",
					retrieved_at: "2026-11-07T08:05:00.000Z",
					excerpt: "像素不低于 5MP。",
					snapshot_text: null,
					content_sha256: "3f2a9c1b7d0e4a55ffff",
				}}
				evidenceError={null}
				onOpenEvidence={() => {}}
				onSelect={() => {}}
				onClose={() => {}}
			/>,
		);
		const link = screen.getByRole("link", { name: "https://example.com/very/long/specification/page" });
		expect(link.getAttribute("href")).toBe("https://example.com/very/long/specification/page");
		expect(screen.getByText("像素不低于 5MP。")).toBeTruthy();
		expect(screen.getByText("快照哈希 3f2a9c1b7d0e4a55")).toBeTruthy();
		expect(screen.getByText(/规格页/)).toBeTruthy();
		expect(snapshotHashLabel("3f2a9c1b7d0e4a55ffff")).toBe("快照哈希 3f2a9c1b7d0e4a55");
		expect(snapshotHashLabel(null)).toBeNull();
		rerender(
			<EvidencePane
				row={withSource}
				evidence={{
					evidence_id: "ev_1",
					title: null,
					source_url: null,
					retrieved_at: null,
					excerpt: null,
					snapshot_text: null,
					content_sha256: null,
				}}
				evidenceError={null}
				onOpenEvidence={() => {}}
				onSelect={() => {}}
				onClose={() => {}}
			/>,
		);
		expect(screen.queryByRole("link")).toBeNull();
		expect(screen.queryByText(/快照哈希/)).toBeNull();
		expect(screen.queryByText("规格页")).toBeNull();
		expect(screen.queryByText("像素不低于 5MP。")).toBeNull();
	});
});
