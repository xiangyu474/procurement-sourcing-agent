/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_API_BASE_URL?: string;
	/** Leave unset. The backend keeps guest session off until a later release. */
	readonly VITE_GUEST_SESSION?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
