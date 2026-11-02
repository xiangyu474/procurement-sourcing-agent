// Retry only a proxy response that proves the request never reached a running
// container. Other 5xx/connection failures can occur after model work began
// and must not silently replay a billable operation.
export async function retryContainerNotRunning(
	call: () => Promise<Response>,
	wait: () => Promise<void>,
	maxAttempts = 4,
): Promise<Response> {
	for (let attempt = 1; ; attempt++) {
		const response = await call();
		if (response.status < 500 || attempt >= maxAttempts) return response;
		const body = await response.clone().text();
		if (!body.includes("The container is not running, consider calling start()")) return response;
		await wait();
	}
}
