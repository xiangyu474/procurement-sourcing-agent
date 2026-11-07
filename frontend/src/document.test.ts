import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("document", () => {
	it("is Chinese for the browser, including the title", () => {
		const html = readFileSync("index.html", "utf8");
		expect(html).toMatch(/<html[^>]*\slang="zh-CN"/);
		expect(html).toMatch(/<title>采购寻源<\/title>/);
	});
});
