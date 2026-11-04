import { chromium } from "@playwright/test";
import fs from "node:fs";

const BASE = "https://procurement-sourcing-gateway.xiangyu474.workers.dev";
const SHOTS = "C:/opt/cursor/artifacts/screenshots/m4-public";
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

const browser = await chromium.launch();
const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on("console", (m) => { if (m.type() === "error") log("browser error:", m.text()); });

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
log("session loading shown:", await page.getByTestId("session-loading").count());
log("alerts on open:", await page.getByRole("alert").allInnerTexts());
await page.screenshot({ path: `${SHOTS}/00-open.png`, fullPage: true });

await page.getByLabel("新项目名称").fill("公开链路验收");
await page.getByRole("button", { name: "创建" }).click();
await page.waitForTimeout(1500);
log("heading after create:", await page.getByRole("heading").first().innerText());

await page.getByLabel("需求文字").fill(
	"采购 10 套 5MP 工业网络摄像机，要求像素不低于 5MP，防护等级 IP67，支持 PoE 供电，质保不少于 2 年，单价不超过 500 元/套。",
);
await page.screenshot({ path: `${SHOTS}/01-input.png`, fullPage: true });
await page.getByRole("button", { name: "开始分析" }).click();
log("clicked start");

const seen = new Set();
const deadline = Date.now() + 25 * 60 * 1000;
while (Date.now() < deadline) {
	const line = (await page.getByTestId("pipeline-line").count()) ? await page.getByTestId("pipeline-line").innerText() : "";
	const activity = (await page.getByTestId("activity").count()) ? await page.getByTestId("activity").innerText() : "";
	const note = (await page.getByTestId("pipeline-note").count()) ? await page.getByTestId("pipeline-note").innerText() : "";
	const status = (await page.getByTestId("run-status").count()) ? await page.getByTestId("run-status").innerText() : "";
	const marker = `${activity}|${line}|${note}|${status}`;
	if (marker && !seen.has(marker)) { seen.add(marker); log("state:", JSON.stringify(marker)); }
	const rows = await page.locator("tbody tr").count();
	if (rows > 0) { log("results are shown. rows:", rows); break; }
	if (note) { log("the task needs attention:", note); break; }
	await page.waitForTimeout(8000);
}
await page.waitForTimeout(2000);
await page.screenshot({ path: `${SHOTS}/02-result.png`, fullPage: true });
log("summary:", (await page.getByTestId("analysis-summary").count()) ? await page.getByTestId("analysis-summary").innerText() : "(none)");
log("recommendation:", (await page.getByTestId("analysis-recommendation").count()) ? await page.getByTestId("analysis-recommendation").innerText() : "(none)");
log("warnings:", (await page.locator(".quiet").allInnerTexts()).filter((t) => t.trim() && !t.includes("·")));
log("table:\n" + (await page.locator("table").innerText().catch(() => "(no table)")));
const first = page.locator("tbody tr").first();
if (await first.count()) {
	await first.click();
	await page.waitForTimeout(1200);
	log("detail:\n" + (await page.getByRole("complementary", { name: "所选型号" }).innerText().catch(() => "(no pane)")));
	await page.screenshot({ path: `${SHOTS}/03-detail.png`, fullPage: true });
}
const body = await page.locator("body").innerText();
for (const leak of ["r2_key", "normalized_r2_key", "locator", "SUPERVISOR", "snapshot_r2_key", "workspaces/default"]) {
	if (body.toLowerCase().includes(leak.toLowerCase())) log("LEAK:", leak);
}
log("body length:", body.length);

const button = page.getByRole("button", { name: /下载这一版|正在生成报告|重新生成/ });
log("report button:", await button.first().innerText().catch(() => "(none)"), "enabled:", await button.first().isEnabled().catch(() => false));
if (await button.first().isEnabled().catch(() => false)) {
	const wait = page.waitForEvent("download", { timeout: 60_000 });
	await button.first().click();
	const download = await wait;
	const target = `${SHOTS}/${download.suggestedFilename()}`;
	await download.saveAs(target);
	log("downloaded:", download.suggestedFilename(), fs.statSync(target).size, "bytes");
}

await page.reload({ waitUntil: "domcontentloaded" });
for (let i = 0; i < 12; i += 1) { await page.waitForTimeout(5000); if (await page.locator("tbody tr").count()) break; }
log("after reload, run status:", (await page.getByTestId("run-status").count()) ? await page.getByTestId("run-status").innerText() : "(none)");
log("after reload, summary:", (await page.getByTestId("analysis-summary").count()) ? await page.getByTestId("analysis-summary").innerText() : "(none)");
log("after reload, rows:", await page.locator("tbody tr").count());
await page.screenshot({ path: `${SHOTS}/04-reload.png`, fullPage: true });
await browser.close();
