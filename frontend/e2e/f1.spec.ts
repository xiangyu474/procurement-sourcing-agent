import { expect, test } from "@playwright/test";
import { installCatalogue, installFixture, LONG_PPTX, LONG_TITLE } from "./fixture";

const screenshots = "/opt/cursor/artifacts/screenshots";

test("fixture path creates a project, accepts files, and restores a partial run", async ({ page }) => {
	await installFixture(page, "partial");
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/");
	await page.screenshot({ path: `${screenshots}/f1-empty.png`, fullPage: true });
	await page.getByLabel("新项目名称").fill(LONG_TITLE);
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
	await page.screenshot({ path: `${screenshots}/f1-input.png`, fullPage: true });
	await page.getByRole("button", { name: "开始寻源" }).click();
	await expect(page.getByTestId("run-status")).toHaveText("正在查阅公开资料", { timeout: 20_000 });
	await page.screenshot({ path: `${screenshots}/f1-running.png`, fullPage: true });
	await expect(page.getByTestId("run-status")).toHaveText("部分完成", { timeout: 30_000 });
	await expect(page.getByRole("alert")).toContainText("没有找到有公开资料支撑的候选供应商。");
	await expect(page.getByRole("alert")).not.toContainText("已保留目前得到的结果");
	await expect(page.getByText("有 3 条需求没能整理")).toBeVisible();
	await expect(page.getByText("计划预算未确认")).toBeVisible();
	const noticeBox = await page.getByText("计划预算未确认").boundingBox();
	const startBox = await page.getByRole("button", { name: "再次寻源" }).boundingBox();
	expect(noticeBox).toBeTruthy();
	expect(startBox).toBeTruthy();
	expect(noticeBox!.y).toBeLessThan(startBox!.y);
	await expect(page.locator("summary", { hasText: "已整理 1 条采购项" })).toBeVisible();
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
	await expect(page.getByTestId("run-version")).not.toContainText("22222222");
	await page.getByText("过程记录").click();
	await expect(page.getByTestId("run-id")).toContainText("22222222");

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
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.getByLabel("新项目名称").fill("整理失败项目");
	await page.getByRole("button", { name: "创建" }).click();
	await page.getByLabel("需求文字").fill("只写了一句无法整理的需求。");
	await page.getByRole("button", { name: "开始寻源" }).click();
	await expect(page.getByRole("alert")).toContainText("需求整理失败。");
	await expect(page.getByTestId("run-status")).toHaveCount(0);
	await page.screenshot({ path: `${screenshots}/f1-compile-failed.png`, fullPage: true });
});

test("fixture path shows a completed run without a download control", async ({ page }) => {
	await installFixture(page, "completed");
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/");
	await page.getByLabel("新项目名称").fill("已结束项目");
	await page.getByRole("button", { name: "创建" }).click();
	await page.getByLabel("需求文字").fill("采购 10 套工业摄像机。");
	await page.getByRole("button", { name: "开始寻源" }).click();
	await expect(page.getByTestId("run-status")).toHaveText("寻源已结束", { timeout: 30_000 });
	await expect(page.getByRole("button", { name: "下载这一版" })).toHaveCount(0);
	await page.screenshot({ path: `${screenshots}/f1-completed.png`, fullPage: true });
});

test("fixture path shows a failed run", async ({ page }) => {
	await installFixture(page, "failed");
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/");
	await page.getByLabel("新项目名称").fill("未能完成项目");
	await page.getByRole("button", { name: "创建" }).click();
	await page.getByLabel("需求文字").fill("采购 10 套工业摄像机。");
	await page.getByRole("button", { name: "开始寻源" }).click();
	await expect(page.getByTestId("run-status")).toHaveText("未能完成", { timeout: 30_000 });
	await expect(page.getByRole("alert")).toContainText("分析超时");
	await page.screenshot({ path: `${screenshots}/f1-failed.png`, fullPage: true });
});

test("fifty projects scroll inside the nav and keep the work panel in view", async ({ page }) => {
	await installCatalogue(page, 50);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/");
	const list = page.locator(".project-list");
	await expect(list.getByRole("button")).toHaveCount(50);
	const navStyle = await page.locator(".nav").evaluate((element) => {
		const style = getComputedStyle(element);
		return { position: style.position, top: style.top, height: Number.parseFloat(style.height) };
	});
	expect(navStyle.position).toBe("sticky");
	expect(navStyle.top).toBe("0px");
	expect(navStyle.height).toBeGreaterThan(800);
	const overflow = await list.evaluate((element) => ({
		overflowY: getComputedStyle(element).overflowY,
		scrolls: element.scrollHeight > element.clientHeight,
	}));
	expect(overflow.overflowY).toBe("auto");
	expect(overflow.scrolls).toBe(true);
	const last = list.getByRole("button").last();
	await last.scrollIntoViewIfNeeded();
	await last.click();
	const heading = page.getByRole("heading", { name: "M3 cloud acceptance" });
	await expect(heading).toBeVisible();
	const headingBox = await heading.boundingBox();
	expect(headingBox).toBeTruthy();
	expect(headingBox!.y).toBeGreaterThanOrEqual(0);
	expect(headingBox!.y).toBeLessThan(900);
	expect(await page.getByRole("button", { name: "更多" }).count()).toBe(0);
	await page.screenshot({ path: `${screenshots}/f1-nav-50.png` });

	await page.setViewportSize({ width: 390, height: 844 });
	const mobileNav = await page.locator(".nav").evaluate((element) => {
		const style = getComputedStyle(element);
		return { position: style.position, height: Number.parseFloat(style.height) };
	});
	expect(mobileNav.position).toBe("static");
	expect(mobileNav.height).toBeLessThanOrEqual(844 * 0.5 + 1);
	await heading.scrollIntoViewIfNeeded();
	await expect(heading).toBeVisible();
	const mobile = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		clientWidth: document.documentElement.clientWidth,
	}));
	expect(mobile.scrollWidth).toBeLessThanOrEqual(mobile.clientWidth + 1);
	await page.screenshot({ path: `${screenshots}/f1-nav-50-mobile.png` });
});

test("live gateway rejects a project create when no access credential is configured", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/");
	await page.getByLabel("新项目名称").fill("实时网关探针");
	await page.getByRole("button", { name: "创建" }).click();
	await expect(page.getByRole("alert")).toContainText("访问被拒绝。", { timeout: 20_000 });
	await expect(page.getByRole("heading")).toHaveCount(0);
	await page.screenshot({ path: `${screenshots}/f1-unauthorized-live.png`, fullPage: true });
});
