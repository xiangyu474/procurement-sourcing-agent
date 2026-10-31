import { expect, test } from "@playwright/test";
import { installFixture, LONG_PPTX, LONG_TITLE } from "./fixture";

const screenshots = "/opt/cursor/artifacts/screenshots";

test("fixture path creates a project, accepts files, and restores a partial run", async ({ page }) => {
	await installFixture(page, "partial");
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto("/");
	await page.getByLabel("项目名称").fill(LONG_TITLE);
	await page.getByRole("button", { name: "创建" }).click();
	await expect(page.getByRole("heading", { name: LONG_TITLE })).toBeVisible();
	await page.getByLabel("需求文字").fill("采购 10 套 5MP 工业网络摄像机，单价不超过 100 元。");
	await page.getByLabel("上传 PPTX").setInputFiles({
		name: LONG_PPTX,
		mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		buffer: Buffer.from("fixture-pptx"),
	});
	await expect(page.getByText(`${LONG_PPTX} 已接收`)).toBeVisible();
	await page.getByLabel("上传历史 XLSX").setInputFiles({
		name: "历史采购.xlsx",
		mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		buffer: Buffer.from("fixture-xlsx"),
	});
	await expect(page.getByText("历史采购.xlsx 已接收")).toBeVisible();
	await page.getByRole("button", { name: "开始寻源" }).click();
	await expect(page.getByTestId("run-status")).toHaveText("部分完成", { timeout: 30_000 });
	await expect(page.getByRole("alert")).toContainText("已保留目前得到的结果。本次公开查阅的次数已用完。");
	await expect(page.getByText("已整理 1 条采购项")).toBeVisible();
	const body = await page.locator("body").innerText();
	expect(body).not.toMatch(/Supervisor|Researcher|DSL|token|12345|workspaces\/default/i);
	const nav = page.getByRole("navigation");
	const name = page.getByRole("button", { name: new RegExp("集团总部2026") });
	const navBox = await nav.boundingBox();
	const nameBox = await name.boundingBox();
	expect(navBox).toBeTruthy();
	expect(nameBox).toBeTruthy();
	expect(nameBox!.x + nameBox!.width).toBeLessThanOrEqual(navBox!.x + navBox!.width + 1);
	await page.screenshot({ path: `${screenshots}/f1-partial.png`, fullPage: true });

	await page.reload();
	await expect(page.getByRole("heading", { name: LONG_TITLE })).toBeVisible();
	await expect(page.getByTestId("run-status")).toHaveText("部分完成");
	await expect(page.getByText(/运行 22222222/)).toBeVisible();

	await page.setViewportSize({ width: 390, height: 844 });
	const metrics = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		clientWidth: document.documentElement.clientWidth,
	}));
	expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
	await page.screenshot({ path: `${screenshots}/f1-mobile.png`, fullPage: true });
});

test("fixture path shows a failed demand compilation", async ({ page }) => {
	await installFixture(page, "compile-failed");
	await page.goto("/");
	await page.getByLabel("项目名称").fill("整理失败项目");
	await page.getByRole("button", { name: "创建" }).click();
	await page.getByLabel("需求文字").fill("只写了一句无法整理的需求。");
	await page.getByRole("button", { name: "开始寻源" }).click();
	await expect(page.getByRole("alert")).toContainText("需求整理失败。");
	await expect(page.getByTestId("run-status")).toHaveCount(0);
	await page.screenshot({ path: `${screenshots}/f1-compile-failed.png`, fullPage: true });
});

test("live gateway rejects a project create when no access credential is configured", async ({ page }) => {
	await page.goto("/");
	await page.getByLabel("项目名称").fill("实时网关探针");
	await page.getByRole("button", { name: "创建" }).click();
	await expect(page.getByRole("alert")).toContainText("访问被拒绝。", { timeout: 20_000 });
	await expect(page.getByRole("heading")).toHaveCount(0);
	await page.screenshot({ path: `${screenshots}/f1-unauthorized-live.png`, fullPage: true });
});
