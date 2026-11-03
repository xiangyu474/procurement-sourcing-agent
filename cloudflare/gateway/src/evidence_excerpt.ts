export interface EvidenceDisplayExcerpt {
	text: string | null;
	status: "ORIGINAL" | "FILTERED_BOILERPLATE" | "UNAVAILABLE";
}

// The full source snapshot and its SHA are never changed. This narrow display
// filter recognizes a specific observed page-builder template, not product
// claims or semantic matches; every non-null output remains a source substring.
const TEMPLATE = /add paragraph text\.\s*click\s*[“"'‘]?edit text[”"'’]?\s*to update the font,\s*size and more\./i;
const NAVIGATION = /^(?:#{1,6}\s*)?(?:access wiki|compatible accessories|you may also like|all products|rms|all use cases|newsroom|start now|contact us|products|use cases|support|resources|company|title|top of page|bottom of page)\s*$/i;

export function evidenceDisplayExcerpt(value: string | null | undefined): EvidenceDisplayExcerpt {
	if (!value || !value.trim()) return { text: null, status: "UNAVAILABLE" };
	if (!TEMPLATE.test(value)) return { text: value.slice(0, 4000), status: "ORIGINAL" };
	for (const part of value.split(/\r?\n\s*\r?\n/)) {
		let candidate = part.trim();
		if (!candidate || TEMPLATE.test(candidate) || NAVIGATION.test(candidate)) continue;
		if (/^this page is not yet available in your selected language/i.test(candidate)) continue;
		candidate = candidate.replace(/^bottom of page\s*\[\.\.\.\]\s*/i, "");
		candidate = candidate.replace(/\s*\[\.\.\.\]\s*top of page\s*$/i, "");
		if (candidate.length >= 40) return { text: candidate.slice(0, 4000), status: "FILTERED_BOILERPLATE" };
	}
	return { text: null, status: "UNAVAILABLE" };
}
