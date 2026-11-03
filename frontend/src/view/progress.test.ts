import { describe, expect, it } from "vitest";
import { userProgress } from "./progress";
import { guestSessionEnabled } from "../session/useGuestSession";

describe("user progress", () => {
	it("maps the live stages and ignores an unknown pipeline value", () => {
		expect(userProgress({ runStatus: "RUNNING", specActive: false, decisionActive: false, reportActive: false, attention: false, done: false })).toBe(
			"正在寻找供应商",
		);
		expect(userProgress({ runStatus: "COMPLETED", specActive: true, decisionActive: false, reportActive: false, attention: false, done: false })).toBe(
			"正在核对技术与价格",
		);
		expect(userProgress({ runStatus: "COMPLETED", specActive: false, decisionActive: false, reportActive: true, attention: false, done: true })).toBe(
			"正在生成报告",
		);
		expect(userProgress({ runStatus: "COMPLETED", specActive: false, decisionActive: false, reportActive: false, attention: false, done: true })).toBe("已完成");
		expect(userProgress({ runStatus: "FAILED", specActive: false, decisionActive: false, reportActive: false, attention: true, done: false })).toBe("需要处理");
		expect(
			userProgress({
				pipelineStatus: "NOT_A_REAL_STATUS",
				runStatus: "RUNNING",
				specActive: false,
				decisionActive: false,
				reportActive: false,
				attention: false,
				done: false,
			}),
		).toBe("正在寻找供应商");
		expect(
			userProgress({
				pipelineStatus: "DECIDING",
				runStatus: "RUNNING",
				specActive: false,
				decisionActive: false,
				reportActive: false,
				attention: false,
				done: false,
			}),
		).toBe("正在整理采购建议");
		expect(
			userProgress({
				pipelineStatus: "RESEARCH",
				runStatus: "RUNNING",
				specActive: false,
				decisionActive: false,
				reportActive: false,
				attention: false,
				done: false,
			}),
		).toBe("正在寻找供应商");
		expect(
			userProgress({
				pipelineStatus: "RESEARCHING",
				runStatus: "COMPLETED",
				specActive: false,
				decisionActive: false,
				reportActive: false,
				attention: false,
				done: false,
			}),
		).toBe("正在寻找供应商");
		expect(
			userProgress({
				pipelineStatus: "COMPLETED",
				runStatus: "COMPLETED",
				specActive: false,
				decisionActive: false,
				reportActive: true,
				attention: false,
				done: true,
			}),
		).toBe("已完成");
	});

	it("leaves guest session off until the contract is published", () => {
		expect(guestSessionEnabled()).toBe(false);
	});
});
