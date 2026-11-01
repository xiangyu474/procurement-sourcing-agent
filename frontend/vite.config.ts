/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import { proxyRequestHeaders } from "./proxyAuth";

const DEFAULT_GATEWAY = "https://procurement-sourcing-gateway.xiangyu474.workers.dev";

export default defineConfig(({ mode }) => {
	const fileEnv = loadEnv(mode, process.cwd(), "");
	const target = process.env.API_PROXY_TARGET || fileEnv.API_PROXY_TARGET || DEFAULT_GATEWAY;
	const token = process.env.DEMO_ACCESS_TOKEN || fileEnv.DEMO_ACCESS_TOKEN || "";
	const proxy: Record<string, ProxyOptions> = {
		"/api": {
			target,
			changeOrigin: true,
			secure: true,
			configure: (server) => {
				server.on("proxyReq", (proxyReq) => {
					proxyRequestHeaders(proxyReq, token);
				});
			},
		},
	};
	return {
		plugins: [react()],
		server: { proxy },
		preview: { proxy },
		test: {
			environment: "jsdom",
			setupFiles: ["./src/test/setup.ts"],
			exclude: ["e2e/**", "node_modules/**", "dist/**"],
		},
	};
});
