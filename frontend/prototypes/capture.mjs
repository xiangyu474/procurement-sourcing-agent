import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const root = path.dirname(new URL(import.meta.url).pathname);
const out = "/opt/cursor/artifacts/screenshots/design";
const directions = ["memo", "inspector", "queue"];
const states = ["empty", "input", "running", "completed", "partial"];

await mkdir(out, { recursive: true });
const browser = await chromium.launch();

for (const name of directions) {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	for (const state of states) {
		const url = new URL(pathToFileURL(path.join(root, `${name}.html`)).href);
		url.searchParams.set("state", state);
		await page.goto(url.href);
		await page.addStyleTag({ content: ".proto{display:none !important}" });
		await page.screenshot({ path: path.join(out, `design-${name}-${state}.png`), fullPage: true });
	}
	await page.setViewportSize({ width: 390, height: 844 });
	const mobile = new URL(pathToFileURL(path.join(root, `${name}.html`)).href);
	mobile.searchParams.set("state", "completed");
	await page.goto(mobile.href);
	await page.addStyleTag({ content: ".proto{display:none !important}" });
	await page.screenshot({ path: path.join(out, `design-${name}-mobile.png`), fullPage: true });
	await page.close();
}

await browser.close();
