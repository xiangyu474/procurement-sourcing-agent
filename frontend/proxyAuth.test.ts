import { describe, expect, it, vi } from "vitest";
import { proxyRequestHeaders } from "./proxyAuth";

describe("proxyRequestHeaders", () => {
	it("does nothing when the server has no credential", () => {
		const request = { setHeader: vi.fn() };
		proxyRequestHeaders(request, undefined);
		proxyRequestHeaders(request, "   ");
		expect(request.setHeader).not.toHaveBeenCalled();
	});

	it("sets the gateway credential only on the server-side proxy request", () => {
		const request = { setHeader: vi.fn() };
		proxyRequestHeaders(request, "demo-credential");
		expect(request.setHeader).toHaveBeenCalledTimes(1);
		expect(request.setHeader).toHaveBeenCalledWith("authorization", "Bearer demo-credential");
	});
});
