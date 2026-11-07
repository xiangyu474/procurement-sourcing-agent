// Tell one real company apart from the many names it is found under.
//
// A research run discovers pages, not companies: the same manufacturer shows up
// as "Bosch", "Bosch Security Systems B.V." and "boschsecurity.com". The rule
// mirrors src/procurement_agent/domain/supplier_identity.py, so the report and
// the page count the same companies.

const LEGAL_SUFFIXES = new Set([
	"co ltd", "coltd", "co limited", "company limited", "ltd", "limited", "llc", "inc",
	"incorporated", "corp", "corporation", "gmbh", "ag", "sa", "sas", "nv", "bv", "pty",
	"plc", "oy", "ab", "as", "kk",
]);
const LEGAL_INITIALS = new Set(["b", "v", "g", "m", "k", "s", "a", "ag", "as"]);
const GENERIC_WORDS = new Set(["security", "systems", "solutions", "electronics", "group", "holding"]);
const DOMAIN = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;

function tokens(name: string): string[] {
	const folded = name.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/\bwww\b/g, " ");
	return folded.replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
}

function stripSuffix(words: string[]): string[] {
	const out = [...words];
	while (out.length && (LEGAL_SUFFIXES.has(out[out.length - 1]) || (out[out.length - 1].length === 1 && LEGAL_INITIALS.has(out[out.length - 1])))) {
		out.pop();
	}
	return out;
}

function domainLabel(name: string): string | null {
	const address = name.toLowerCase().trim().replace(/\s+/g, "").replace(/^www\./, "");
	return DOMAIN.test(address) ? address.split(".")[0] : null;
}

/** The words of a supplier name that identify it, without its decoration. */
export function supplierCore(name: string): string {
	const label = domainLabel(name);
	if (label) return label;
	const words = stripSuffix(tokens(name));
	if (!words.length) return "";
	const kept = words.filter(word => !GENERIC_WORDS.has(word));
	return (kept.length ? kept : words).join(" ");
}

/** A key that is equal for two names of the same company. */
export function supplierKey(name: string): string {
	return supplierCore(name).replace(/ /g, "");
}

function isDomain(name: string): boolean {
	return domainLabel(name) !== null;
}

/** Whether two discovered names point at one company. */
export function sameSupplier(first: string, second: string): boolean {
	const left = supplierKey(first);
	const right = supplierKey(second);
	if (!left || !right) return false;
	if (left === right) return true;
	const shorter = left.length <= right.length ? left : right;
	const longer = left.length <= right.length ? right : left;
	if (shorter.length < 4) return false;
	if (isDomain(first) === isDomain(second)) return false;
	const domainSide = isDomain(first) ? first : second;
	const nameSide = isDomain(first) ? second : first;
	return supplierKey(domainSide).startsWith(supplierKey(nameSide));
}

/** How many companies the discovered names point at. */
export function countSupplierEntities(names: string[]): number {
	const representatives: string[] = [];
	for (const name of names) {
		if (!representatives.some(other => sameSupplier(name, other))) representatives.push(name);
	}
	return representatives.length;
}
