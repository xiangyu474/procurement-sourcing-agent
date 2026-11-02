import assert from "node:assert/strict";
import { it } from "node:test";
import { retryContainerNotRunning } from "../src/container_startup.ts";

it("retries a proxy not-running response without retrying arbitrary 5xx", async () => {
	let calls = 0, waits = 0;
	const response = await retryContainerNotRunning(async () => {
		calls++;
		return calls === 1
			? new Response("Error proxying request to container: The container is not running, consider calling start()", { status: 500 })
			: new Response("compiled", { status: 200 });
	}, async () => { waits++; });
	assert.equal(response.status, 200);
	assert.equal(calls, 2);
	assert.equal(waits, 1);
	calls = 0;
	const error = await retryContainerNotRunning(async () => { calls++; return new Response("model failed", { status: 500 }); }, async () => {});
	assert.equal(error.status, 500);
	assert.equal(await error.text(), "model failed");
	assert.equal(calls, 1);
});
