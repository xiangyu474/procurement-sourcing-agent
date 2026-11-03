import assert from "node:assert/strict";
import { it } from "node:test";
import { evidenceDisplayExcerpt } from "../src/evidence_excerpt.ts";

it("selects a verbatim substantive paragraph after the observed page-builder placeholder", () => {
	const text = "Access wiki\n\n## compatible ACCESSORIES\n\nAdd paragraph text. Click “Edit Text” to update the font, size and more. To change and reuse text themes, go to Site Styles.\n\nStart Now\n\nThis page is not yet available in your selected language. Please switch to another language.\n\nbottom of page [...] The RUT241 is a compact, industrial-grade cellular router designed for reliable IoT and M2M connectivity. [...] top of page";
	const result = evidenceDisplayExcerpt(text);
	assert.equal(result.status, "FILTERED_BOILERPLATE");
	assert.equal(result.text, "The RUT241 is a compact, industrial-grade cellular router designed for reliable IoT and M2M connectivity.");
	assert.ok(text.includes(result.text!));
	assert.ok(!result.text!.includes("Add paragraph text"));
});

it("returns no fabricated quotation for a placeholder-only extract", () => {
	const text = "Access wiki\n\nAdd paragraph text. Click 'Edit Text' to update the font, size and more. To change and reuse text themes, go to Site Styles.\n\nStart Now";
	assert.deepEqual(evidenceDisplayExcerpt(text), { text: null, status: "UNAVAILABLE" });
});

it("leaves ordinary evidence unchanged", () => {
	const text = "Output resolution: 5 MP\nOther specifications: IP67.";
	assert.deepEqual(evidenceDisplayExcerpt(text), { text, status: "ORIGINAL" });
});
