/* Prototype chrome. Not imported by the application build. */
window.Proto = {
	esc(value) {
		return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
	},
	state() {
		const value = new URLSearchParams(location.search).get("state") || "empty";
		const known = ["empty", "input", "running", "completed", "partial", "failed", "denied", "noreport"];
		return known.includes(value) ? value : "empty";
	},
	rows(state) {
		if (state === "completed" || state === "noreport") return window.FIXTURE.full;
		if (state === "partial") return window.FIXTURE.partial;
		return [];
	},
	mark() {
		const state = this.state();
		for (const link of document.querySelectorAll(".proto a")) {
			const url = new URL(link.href);
			link.setAttribute("aria-current", url.searchParams.get("state") === state ? "true" : "false");
		}
	},
	evidence(item) {
		const e = this.esc;
		if (!item.evidence) return `<div class="evidence"><p>${e(item.gap)}</p></div>`;
		const prices = item.prices.map((price) => `<p><b>${e(price.kind)}</b>　${e(price.text)}</p>`).join("");
		return `<div class="evidence"><p class="source">${e(item.evidence.title)} · ${e(item.evidence.retrieved)}</p><blockquote>${e(item.evidence.excerpt)}</blockquote>${item.gap ? `<p>${e(item.gap)}</p>` : ""}${prices}<p class="quiet">${e(item.stageNote)}</p></div>`;
	},
};
