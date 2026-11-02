/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_API_BASE_URL?: string;
	/** Set to "1" only after the backend publishes POST/GET /api/session. Default build leaves it unset. */
	readonly VITE_GUEST_SESSION?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
