import { describe, expect, it } from "vitest";
import { ApiError } from "../api/types";
import { pollUntil } from "./poll";

describe("pollUntil", () => {
	it("returns the first finished value", async () => {
		let reads = 0;
		const value = await pollUntil({
			intervalMs: 5,
			timeoutMs: 1_000,
			sleepFn: async () => {},
			tick: async () => {
				reads += 1;
				return reads < 2 ? null : "done";
			},
		});
		expect(value).toBe("done");
		expect(reads).toBe(2);
	});

	it("fails when the deadline passes with no result", async () => {
		const error = await pollUntil({
			intervalMs: 1,
			timeoutMs: 0,
			sleepFn: async () => {},
			tick: async () => null,
		}).then(
			() => null,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ code: "timeout" });
	});
});
