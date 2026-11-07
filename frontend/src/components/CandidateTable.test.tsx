import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CandidateRowView } from "../view/candidates";
import { CandidateTable } from "./CandidateTable";

function row(patch: Partial<CandidateRowView>): CandidateRowView {
	return {
		id: "group",
		supplier: "22 条发现 · 3 家供应来源",
		supplierCount: 3,
		model: "型号A",
		stage: { label: "长名单", tone: "long", note: "" },
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
		groupCount: 2,
		members: [],
		...patch,
	};
}

describe("CandidateTable", () => {
	it("keeps discoveries collapsed until the row is opened", () => {
		const member = row({ id: "c1", supplier: "甲公司", groupCount: 1, members: [] });
		render(
			<CandidateTable
				rows={[row({ members: [member] })]}
				selectedId={null}
				onSelect={() => {}}
			/>,
		);
		expect(screen.getByText("22 条发现 · 3 家供应来源")).toBeTruthy();
		expect(screen.queryByText("甲公司")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "展开来源" }));
		expect(screen.getByText("甲公司")).toBeTruthy();
	});
});
