import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	timeout: 90_000,
	fullyParallel: false,
	workers: 1,
	use: {
		baseURL: "http://127.0.0.1:4173",
		locale: "zh-CN",
	},
	webServer: {
		command: "npm run build && npm run preview -- --host 127.0.0.1 --port 4173 --strictPort",
		url: "http://127.0.0.1:4173",
		reuseExistingServer: false,
		timeout: 180_000,
	},
});
