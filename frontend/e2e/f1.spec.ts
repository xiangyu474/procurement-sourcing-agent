import { expect, test } from "@playwright/test";
import { installCatalogue, installFixture, installKnownCase, installLateSnapshot, installReportFlow, installReview, LONG_PPTX, LONG_TITLE } from "./fixture";

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
	await page.getByRole("button", { name: "开始分析" }).click();
	await expect(page.getByTestId("run-status")).toHaveText("正在查阅公开资料", { timeout: 20_000 });
	await page.screenshot({ path: `${screenshots}/f1-running.png`, fullPage: true });
	await expect(page.getByTestId("run-status")).toHaveText("部分完成", { timeout: 30_000 });
	await expect(page.getByRole("alert")).toContainText("没有找到有公开资料支撑的候选供应商。");
	await expect(page.getByRole("alert")).not.toContainText("已保留目前得到的结果");
	await expect(page.getByText("有 3 条需求没能整理")).toBeVisible();
	await expect(page.getByText("计划预算未确认")).toBeVisible();
	const noticeBox = await page.getByText("计划预算未确认").boundingBox();
	const startBox = await page.getByRole("button", { name: "再次分析" }).boundingBox();
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
	await page.getByRole("button", { name: "开始分析" }).click();
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
	await page.getByRole("button", { name: "开始分析" }).click();
	await expect(page.getByTestId("run-status")).toHaveText("寻源已结束", { timeout: 30_000 });
	await expect(page.getByRole("button", { name: "下载这一版" })).toBeDisabled();
	await expect(page.getByText("报告还没有生成")).toBeVisible();
	await expect(page.getByText("这次没有候选供应商。")).toBeVisible();
	await page.screenshot({ path: `${screenshots}/f1-completed.png`, fullPage: true });
});

test("fixture path shows a failed run", async ({ page }) => {
	await installFixture(page, "failed");
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/");
	await page.getByLabel("新项目名称").fill("未能完成项目");
	await page.getByRole("button", { name: "创建" }).click();
	await page.getByLabel("需求文字").fill("采购 10 套工业摄像机。");
	await page.getByRole("button", { name: "开始分析" }).click();
	await expect(page.getByTestId("run-status")).toHaveText("需要处理", { timeout: 30_000 });
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

test("candidate rows keep stage and verdict, and the inspector reads stored fields", async ({ page }) => {
	await installReview(page, "mixed");
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/");
	await page.getByRole("button", { name: /工业摄像机寻源/ }).click();
	await expect(page.getByRole("row", { name: /海康威视/ })).toBeVisible();
	await expect(page.getByText("建议询价", { exact: true })).toBeVisible();
	await expect(page.getByText("待补证", { exact: true }).first()).toBeVisible();
	await expect(page.getByText("已排除", { exact: true })).toBeVisible();
	await expect(page.getByText("长名单", { exact: true }).first()).toBeVisible();
	await expect(page.getByText("推荐供应商")).toHaveCount(0);
	await page.screenshot({ path: `${screenshots}/f2-mixed.png` });

	await page.getByRole("row", { name: /海康威视/ }).click();
	await expect(page.getByRole("complementary", { name: "所选型号" })).toContainText("满足");
	await expect(page.getByText("100 CNY 元/套")).toBeVisible();
	await expect(page.getByText("这是网页标价，不是正式报价。")).toBeVisible();
	await page.getByRole("button", { name: "查看这条来源" }).click();
	await expect(page.getByText("页面正文：500万像素。")).toBeVisible();
	const passBody = await page.locator("body").innerText();
	expect(passBody).not.toMatch(/推荐供应商|snapshot_r2_key|workspaces\/default|Supervisor|token/i);
	await page.screenshot({ path: `${screenshots}/f2-pass.png` });

	await page.getByRole("row", { name: /DH-IPC-HFW5442/ }).click();
	await expect(page.getByRole("complementary", { name: "所选型号" })).toContainText("还不能判断");
	await expect(page.getByRole("complementary", { name: "所选型号" })).toContainText("长名单");
	await expect(page.getByRole("complementary", { name: "所选型号" })).not.toContainText("建议询价");
	await page.screenshot({ path: `${screenshots}/f2-unknown.png` });

	await page.getByRole("row", { name: /宇视科技/ }).click();
	await expect(page.getByRole("complementary", { name: "所选型号" })).toContainText("不满足");
	await expect(page.getByRole("complementary", { name: "所选型号" })).not.toContainText("合格");
	await page.screenshot({ path: `${screenshots}/f2-fail.png` });

	await page.getByRole("row", { name: /目录中的供应商/ }).click();
	const overview = page.getByRole("complementary", { name: "所选型号" });
	await expect(overview).toContainText("导入目录的整体情况");
	await expect(overview).not.toContainText("历史价");
	await expect(overview).not.toContainText("节支");
	await expect(overview).not.toContainText("77");
	await page.screenshot({ path: `${screenshots}/f2-overview.png` });

	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole("row", { name: /海康威视/ }).scrollIntoViewIfNeeded();
	const mobile = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		clientWidth: document.documentElement.clientWidth,
	}));
	expect(mobile.scrollWidth).toBeLessThanOrEqual(mobile.clientWidth + 1);
	await page.screenshot({ path: `${screenshots}/f2-mobile.png` });
});

test("a finished run with no candidates leaves the detail column out", async ({ page }) => {
	await installReview(page, "none");
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/");
	await page.getByRole("button", { name: /工业摄像机寻源/ }).click();
	await expect(page.getByText("这次没有候选供应商。")).toBeVisible();
	// The coverage warning of the backend is shown as it is.
	await expect(page.getByText("这次寻源没有找到可核对的候选。")).toBeVisible();
	await expect(page.getByTestId("run-status")).toHaveText("寻源已结束");
	await expect(page.getByRole("complementary", { name: "所选型号" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "下载这一版" })).toBeDisabled();
	await page.screenshot({ path: `${screenshots}/f2-none.png` });
});

test("known case hides internal wording and groups identical models", async ({ page }) => {
	await installKnownCase(page);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/");
	await page.getByRole("button", { name: /M3 cloud acceptance/ }).click();
	await expect(page.getByTestId("run-status")).toHaveText("寻源已结束");
	await expect(page.getByRole("button", { name: "展开来源" })).toBeVisible();
	await page.getByRole("row", { name: /IPS05-R10-OIA4/ }).click();
	const fail = page.getByRole("complementary", { name: "所选型号" });
	await expect(fail).toContainText("已排除");
	await expect(fail).toContainText("不满足");
	await expect(fail).toContainText("要求 ≥ 5 MP，读到 4.9152 MP");
	await expect(fail).toContainText("计划单价");
	await expect(fail).not.toContainText("output_resolution");
	await expect(fail).not.toContainText("GTE");
	await expect(fail).not.toContainText("ev_");
	await page.getByRole("button", { name: "计算和依据" }).click();
	await expect(fail).toContainText("4.9152 MP ≥ 5 MP");
	await expect(fail).toContainText("IPS 规格页");
	await page.screenshot({ path: `${screenshots}/f2-known-after-fail.png` });
	await page.getByRole("row", { name: /NBN-80052-BA/ }).first().click();
	const pass = page.getByRole("complementary", { name: "所选型号" });
	await expect(pass).toContainText("结论不一致");
	await expect(pass).toContainText("满足");
	await expect(pass).not.toContainText("pptx_");
	await page.screenshot({ path: `${screenshots}/f2-known-after-pass.png` });
	await expect(page.getByRole("complementary", { name: "所选型号" })).toContainText("供应来源");
});

test("a finished run without decisions keeps the report button disabled", async ({ page }) => {
	await installReportFlow(page, "blocked");
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/");
	await page.getByRole("button", { name: /正式报告项目/ }).click();
	await expect(page.getByRole("button", { name: "下载这一版" })).toBeDisabled();
	await expect(page.getByText("报告还没有生成")).toBeVisible();
	await page.screenshot({ path: `${screenshots}/f3-blocked.png` });
});

test("generating a report stays honest until the file is ready", async ({ page }) => {
	const posts = (await installReportFlow(page, "generate")) as string[];
	const m0: string[] = [];
	page.on("request", (request) => {
		if (request.url().includes("/runs/") && request.url().includes("report")) m0.push(request.url());
	});
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/");
	await page.getByRole("button", { name: /正式报告项目/ }).click();
	const generating = page.getByRole("button", { name: "正在生成报告" });
	await expect(generating).toBeDisabled();
	await expect(page.getByText("报告还没有生成")).toHaveCount(0);
	await page.screenshot({ path: `${screenshots}/f3-generating.png` });
	const downloadPromise = page.waitForEvent("download");
	await expect(page.getByRole("button", { name: "下载这一版" })).toBeEnabled({ timeout: 30_000 });
	await page.getByRole("button", { name: "下载这一版" }).click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toMatch(/正式报告项目-.+\.docx/);
	// The backend starts the report on its own. The visitor does not post for it.
	expect(posts).toEqual([]);
	expect(m0).toEqual([]);
	await page.getByText("过程记录").click();
	await expect(page.getByText("决策版本 3f2a9c1b7d0e4a55")).toBeVisible();
});

test("an existing report downloads without generating another", async ({ page }) => {
	const posts = (await installReportFlow(page, "completed")) as string[];
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/");
	await page.getByRole("button", { name: /正式报告项目/ }).click();
	const download = await Promise.all([
		page.waitForEvent("download"),
		page.getByRole("button", { name: "下载这一版" }).click(),
	]).then((items) => items[0]);
	expect(download.suggestedFilename()).toMatch(/正式报告项目-.+\.docx/);
	expect(posts).toEqual([]);
	await page.getByText("过程记录").click();
	await expect(page.getByText("决策版本 3f2a9c1b7d0e4a55")).toBeVisible();
	await page.screenshot({ path: `${screenshots}/f3-completed.png` });
});

test("a failed report shows the backend error and does not pretend success", async ({ page }) => {
	await installReportFlow(page, "failed");
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/");
	await page.getByRole("button", { name: /正式报告项目/ }).click();
	await page.getByRole("button", { name: "重新生成" }).click();
	await expect(page.getByText("生成失败。没有可写入的决策。")).toBeVisible();
	await expect(page.getByText("正在生成报告")).toHaveCount(0);
	await page.screenshot({ path: `${screenshots}/f3-failed.png` });
});

test("a previous failed report does not show the container error", async ({ page }) => {
	await installReportFlow(page, "prior-failed");
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/");
	await page.getByRole("button", { name: /正式报告项目/ }).click();
	await expect(page.getByText("上次生成失败，可以重新生成。")).toBeVisible();
	await expect(page.locator("body")).not.toContainText("container");
	await expect(page.getByRole("button", { name: "重新生成" })).toBeEnabled();
});

test("an older run can be opened from the process log", async ({ page }) => {
	await installReportFlow(page, "older");
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/");
	await page.getByRole("button", { name: /正式报告项目/ }).click();
	await expect(page.getByText("报告还没有生成")).toBeVisible();
	await expect(page.getByText("这次没有候选供应商。")).toBeVisible();
	await page.getByText("过程记录").click();
	await page.getByRole("button", { name: /的寻源$/ }).last().click();
	await expect(page.getByRole("cell", { name: "海康威视" })).toBeVisible();
	await expect(page.getByRole("button", { name: "下载这一版" })).toBeEnabled();
});

test("the results appear when the snapshot arrives late", async ({ page }) => {
	// The run row turns terminal before the decision snapshot is written. The
	// page has to ask again instead of waiting for a reload.
	await installLateSnapshot(page);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/");
	await page.getByRole("button", { name: /快照晚到项目/ }).click();
	await expect(page.getByRole("row", { name: /DS-1/ })).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId("analysis-summary")).toContainText("1 个型号");
	await page.screenshot({ path: `${screenshots}/f2-late-snapshot.png`, fullPage: true });
});

test("the public gateway accepts a visitor without a credential", async ({ page }) => {
	// The public demo runs on the same origin as the api. This test only runs
	// against the live gateway: it is skipped when the gateway is not reachable.
	const gateway = process.env.LIVE_GATEWAY_URL;
	test.skip(!gateway, "LIVE_GATEWAY_URL is not set");
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(gateway as string);
	await page.getByLabel("新项目名称").fill("访客会话探针");
	await page.getByRole("button", { name: "创建" }).click();
	await expect(page.getByRole("heading", { name: "访客会话探针" })).toBeVisible({ timeout: 30_000 });
	await expect(page.getByRole("alert")).toHaveCount(0);
});
