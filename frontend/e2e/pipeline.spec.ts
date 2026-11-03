import { expect, test } from "@playwright/test";
import { installPipeline } from "./fixture";

const screenshots = "/opt/cursor/artifacts/screenshots";

async function begin(page: import("@playwright/test").Page): Promise<void> {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/");
	await page.getByLabel("新项目名称").fill("流水线项目");
	await page.getByRole("button", { name: "创建" }).click();
	await page.getByLabel("需求文字").fill("采购 10 套工业摄像机。");
	await page.getByRole("button", { name: "开始分析" }).click();
}

test("fixture pipeline maps documented stages and does not invent a report", async ({ page }) => {
	await installPipeline(page, "stages");
	await begin(page);
	const line = page.getByTestId("run-status");
	await expect(line).toHaveText("正在寻找供应商", { timeout: 20_000 });
	await expect(line).toHaveText("正在核对技术与价格", { timeout: 20_000 });
	await expect(line).toHaveText("正在整理采购建议", { timeout: 20_000 });
	await expect(line).toHaveText("已完成", { timeout: 20_000 });
	await expect(page.getByText("正在生成报告")).toHaveCount(0);
	await expect(page.getByText("寻源已结束")).toHaveCount(0);
	await page.getByText("过程记录").click();
	await expect(page.getByText("核对技术与价格")).toBeVisible();
	await expect(page.getByText("整理采购建议")).toBeVisible();
	await expect(page.getByText("查阅公开资料")).toHaveCount(0);
	await page.screenshot({ path: `${screenshots}/b1-pipeline-done.png`, fullPage: true });
});

test("fixture pipeline keeps the task across reload without posting again", async ({ page }) => {
	const posts = await installPipeline(page, "reload");
	await begin(page);
	await expect(page.getByTestId("run-status")).toHaveText("正在寻找供应商", { timeout: 20_000 });
	expect(posts).toHaveLength(1);
	await page.reload();
	await expect(page.getByRole("heading", { name: "流水线项目" })).toBeVisible();
	await expect(page.getByTestId("run-status")).toHaveText("正在寻找供应商");
	expect(posts).toHaveLength(1);
});

test("fixture pipeline reuses one idempotency key when the start can be retried", async ({ page }) => {
	const posts = await installPipeline(page, "retry");
	await begin(page);
	await expect(page.getByRole("alert")).toContainText("分析没能启动。");
	await page.getByRole("button", { name: "重试" }).click();
	await expect(page.getByTestId("run-status")).toHaveText("已完成", { timeout: 20_000 });
	expect(posts).toHaveLength(2);
	expect(posts[0].key).toBe(posts[1].key);
	expect(posts[0].key.length).toBeGreaterThan(0);
	expect(posts[0].revision).toBe(1);
});

test("fixture pipeline replaces the key after an idempotency conflict and stays quiet", async ({ page }) => {
	const posts = await installPipeline(page, "conflict");
	await begin(page);
	await expect(page.getByTestId("run-status")).toHaveText("已完成", { timeout: 20_000 });
	expect(posts).toHaveLength(2);
	expect(posts[0].key).not.toBe(posts[1].key);
	await expect(page.getByText("idempotency_conflict")).toHaveCount(0);
	await expect(page.getByRole("alert")).toHaveCount(0);
});

test("fixture pipeline asks the user to confirm when the demand revision changed", async ({ page }) => {
	const posts = await installPipeline(page, "revision");
	await begin(page);
	await expect(page.getByRole("alert")).toContainText("需求刚更新过，请确认后再开始。");
	expect(posts).toHaveLength(1);
	await expect(page.getByTestId("run-status")).toHaveCount(0);
});

test("fixture pipeline shows an unrecognized demand from the pipeline response", async ({ page }) => {
	const posts = await installPipeline(page, "unrecognized");
	await begin(page);
	await expect(page.getByRole("alert")).toContainText("没有识别出采购需求。");
	expect(posts).toHaveLength(1);
});

test("fixture pipeline says analysis is unavailable when the operation is off", async ({ page }) => {
	const posts = await installPipeline(page, "unavailable");
	await begin(page);
	await expect(page.getByRole("alert")).toContainText("分析暂时不可用。");
	expect(posts).toHaveLength(1);
	await expect(page.getByText("operation_unavailable")).toHaveCount(0);
});

test("fixture pipeline turns a stage error code into Chinese and hides the raw error", async ({ page }) => {
	await installPipeline(page, "failed");
	await begin(page);
	await expect(page.getByTestId("pipeline-note")).toHaveText("没有读到可用的公开资料。", { timeout: 20_000 });
	await expect(page.getByTestId("run-status")).toHaveText("需要处理");
	const body = await page.locator("body").innerText();
	expect(body).not.toContain("container exploded");
	expect(body).not.toContain("NO_FETCHED_EVIDENCE");
	await expect(page.getByText("正在生成报告")).toHaveCount(0);
});
