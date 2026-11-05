import assert from "node:assert/strict";
import { it } from "node:test";
import { pipelineInstanceName } from "../src/container_instance.ts";

it("gives every pipeline its own container instance", () => {
	const first = pipelineInstanceName("sourcing-v25", "11111111-2222-3333-4444-555555555555");
	const second = pipelineInstanceName("sourcing-v25", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
	assert.notEqual(first, second);
	assert.match(first, /^sourcing-v25-[a-f0-9]{16}$/);
});

it("keeps a name the container binding accepts", () => {
	const name = pipelineInstanceName("sourcing-v25", "A/B_C:d-123");
	assert.ok(name.length <= 63);
	assert.match(name, /^[a-z0-9-]+$/);
	// A run without a pipeline id still gets the plain instance.
	assert.equal(pipelineInstanceName("sourcing-v25", null), "sourcing-v25");
});
