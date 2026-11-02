import { useEffect, useState, type MutableRefObject } from "react";
import { messageForApiError } from "../api/adapter";
import type { ApiClient } from "../api/client";

/** Off unless VITE_GUEST_SESSION=1. The backend says to leave that unset. The dev proxy is unchanged. */
export function guestSessionEnabled(): boolean {
	return import.meta.env.VITE_GUEST_SESSION === "1";
}

/**
 * POST /api/session once when the flag is on, then GET only when the page is shown again.
 * The cookie stays HttpOnly. This hook stores no token.
 */
export function useGuestSession(clientRef: MutableRefObject<ApiClient>): { ready: boolean; error: string | null } {
	const [ready, setReady] = useState(!guestSessionEnabled());
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!guestSessionEnabled()) return;
		let cancelled = false;
		const fail = (caught: unknown) => {
			if (!cancelled) setError(messageForApiError(caught).summary);
		};
		void clientRef.current.openSession().then(
			() => {
				if (!cancelled) setReady(true);
			},
			fail,
		);
		const onVisible = () => {
			if (document.visibilityState !== "visible") return;
			void clientRef.current.readSession().catch(fail);
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			cancelled = true;
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [clientRef]);

	return { ready, error };
}
