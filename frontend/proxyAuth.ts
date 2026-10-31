export type HeaderWriter = {
	setHeader(name: string, value: string): void;
};

/**
 * Injects the gateway demo credential from the Node process that serves the dev/preview proxy.
 * The browser bundle must not import this module and must not receive the credential.
 */
export function proxyRequestHeaders(request: HeaderWriter, token: string | undefined): void {
	const value = token?.trim();
	if (!value) return;
	request.setHeader("authorization", `Bearer ${value}`);
}
