import assert from "node:assert/strict";
import { it } from "node:test";
import { guestEvent, guestRun, guestRunSummary, guestStopReason } from "../src/guest_public.ts";

it("returns a safe run view without storage keys or internal error text", () => {
	const raw = { id: "r1", project_id: "p1", status: "FAILED", current_stage: "SUPERVISOR: WEB_RESEARCH", artifact_key: "private/r2/key", last_error: "Bearer secret and SQL", created_at: "2026", updated_at: "2026" };
	const view = guestRun(raw);
	assert.equal(view.id, "r1");
	assert.equal(view.current_stage, "WEB_RESEARCH");
	assert.equal(view.artifact_key, null);
	assert.equal(view.last_error, "RESEARCH_EXECUTION_FAILED");
	assert.ok(!JSON.stringify(view).includes("secret"));
	assert.ok(!JSON.stringify(view).includes("private/r2"));
	assert.equal(raw.artifact_key, "private/r2/key");
});

it("keeps supported stop codes while replacing internal role names", () => {
	assert.equal(guestStopReason("BUDGET_EXHAUSTED"), "BUDGET_EXHAUSTED");
	assert.equal(guestStopReason("SUPERVISOR_RESEARCHER_ERROR"), "RESEARCH_EXECUTION_FAILED");
	assert.equal(guestStopReason("private diagnostic"), "RESEARCH_INCOMPLETE");
	const row = guestRunSummary({ id: "r", status: "FAILED", current_stage: "SECRET_STAGE", last_error: "secret", artifact_key_present: true, stop_reason_code: "SUPERVISOR_RESEARCHER_ERROR", created_at: "2026", updated_at: "2026" });
	assert.equal(row.current_stage, "FAILED");
	assert.equal(row.stop_reason_code, "RESEARCH_EXECUTION_FAILED");
	assert.ok(!JSON.stringify(row).includes("secret"));
});

it("never exposes raw event detail or an unknown internal stage", () => {
	const event = guestEvent({ stage: "SUPERVISOR: WEB_RESEARCH", detail: "internal SourcingPlan secret", created_at: "2026" });
	assert.equal(event.stage, "WEB_RESEARCH");
	assert.equal(event.display_text, "正在查阅公开资料。");
	assert.ok(!JSON.stringify(event).includes("secret"));
	assert.equal(guestEvent({ stage: "INTERNAL_SECRET", detail: "x", created_at: "2026" }).stage, "RUNNING");
});
