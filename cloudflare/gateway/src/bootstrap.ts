/** Minimal bootstrap entrypoint used only to create the Worker script. */
export default {
	async fetch(): Promise<Response> {
		return new Response(JSON.stringify({ status: "ok", service: "bootstrap" }), {
			headers: { "content-type": "application/json; charset=utf-8" },
		});
	},
};
