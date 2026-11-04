import { useEffect, useState, type MutableRefObject } from "react";
import { messageForApiError } from "../api/adapter";
import { ApiError } from "../api/types";
import type { ApiClient } from "../api/client";

/**
 * The guest session is the public demo identity: the Worker signs a cookie and
 * the browser never holds a credential.
 *
 * `VITE_GUEST_SESSION=0` turns the probe off for a deployment that talks to the
 * gateway through the server side bearer (the development proxy). When the
 * variable is unset the frontend asks the backend at runtime, so the built
 * bundle does not depend on how the build was configured.
 */
export function guestSessionEnabled(): boolean {
	return import.meta.env.VITE_GUEST_SESSION !== "0";
}

export type GuestSessionMode = "guest" | "operator" | "unknown";

export type GuestSession = {
	ready: boolean;
	error: string | null;
	mode: GuestSessionMode;
};

/**
 * The gateway tells the caller who it is. `GET /api/session` answers
 * `{ mode: "guest" }` for a visitor and `{ mode: "operator" }` for the server
 * side bearer path, so the frontend does not have to guess from a status code.
 *
 * A visitor without a cookie gets 401 first. Then one session is created and
 * the cookie stays HttpOnly. This hook stores no token.
 */
export function useGuestSession(clientRef: MutableRefObject<ApiClient>): GuestSession {
	const [ready, setReady] = useState(!guestSessionEnabled());
	const [error, setError] = useState<string | null>(null);
	const [mode, setMode] = useState<GuestSessionMode>(guestSessionEnabled() ? "unknown" : "operator");

	useEffect(() => {
		if (!guestSessionEnabled()) return;
		let cancelled = false;
		const fail = (caught: unknown) => {
			if (!cancelled) setError(messageForApiError(caught).summary);
		};
		const known = (info: { mode: "guest" | "operator" }) => {
			if (cancelled) return;
			setMode(info.mode);
			setReady(true);
		};
		void clientRef.current.readSession().then(
			known,
			(caught: unknown) => {
				if (cancelled) return;
				if (caught instanceof ApiError && caught.status === 404) {
					// The route is not published here. The dev proxy already carries
					// the operator credential, so the workspace can run without one.
					known({ mode: "operator" });
					return;
				}
				if (caught instanceof ApiError && caught.status === 401) {
					void clientRef.current.openSession().then(known, fail);
					return;
				}
				fail(caught);
			},
		);
		const onVisible = () => {
			if (document.visibilityState !== "visible") return;
			void clientRef.current.readSession().then(
				() => undefined,
				(caught: unknown) => {
					if (caught instanceof ApiError && caught.status === 404) return;
					if (caught instanceof ApiError && caught.status === 401) {
						// The session expired while the tab was hidden. Create a new one
						// so the next action does not fail on the first request.
						void clientRef.current.openSession().then(known, fail);
						return;
					}
					fail(caught);
				},
			);
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			cancelled = true;
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [clientRef]);

	return { ready, error, mode };
}
