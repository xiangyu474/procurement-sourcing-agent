import { describe, expect, it } from "vitest";
import { readPipelineId, readPipelineKey, writePipelineId, writePipelineKey } from "./pipelineState";

describe("pipeline ui state", () => {
	it("keeps one idempotency key per project revision until it is cleared", () => {
		expect(readPipelineKey("project-a", 2)).toBeNull();
		writePipelineKey("project-a", 2, "key-2");
		writePipelineKey("project-a", 3, "key-3");
		expect(readPipelineKey("project-a", 2)).toBe("key-2");
		expect(readPipelineKey("project-a", 3)).toBe("key-3");
		writePipelineKey("project-a", 2, null);
		expect(readPipelineKey("project-a", 2)).toBeNull();
		expect(readPipelineKey("project-a", 3)).toBe("key-3");
	});

	it("remembers the last pipeline id per project", () => {
		writePipelineId("project-a", "pipe-1");
		writePipelineId("project-b", "pipe-2");
		expect(readPipelineId("project-a")).toBe("pipe-1");
		writePipelineId("project-a", null);
		expect(readPipelineId("project-a")).toBeNull();
		expect(readPipelineId("project-b")).toBe("pipe-2");
	});
});