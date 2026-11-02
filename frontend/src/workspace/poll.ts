import { ApiError } from "../api/types";

export const POLL_INTERVAL_MS = 3_000;
export const COMPILE_TIMEOUT_MS = 3 * 60 * 1000;
export const COMPILE_UNCERTAIN_AFTER_MS = 90_000;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new ApiError(0, "aborted", null));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new ApiError(0, "aborted", null));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export async function pollUntil<T>(options: {
	intervalMs: number;
	timeoutMs: number;
	signal?: AbortSignal;
	sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
	tick: () => Promise<T | null>;
}): Promise<T> {
	const sleepFn = options.sleepFn ?? sleep;
	const deadline = Date.now() + options.timeoutMs;
	while (true) {
		if (options.signal?.aborted) throw new ApiError(0, "aborted", null);
		const value = await options.tick();
		if (value !== null) return value;
		if (Date.now() >= deadline) throw new ApiError(0, "timeout", null);
		await sleepFn(options.intervalMs, options.signal);
	}
}
