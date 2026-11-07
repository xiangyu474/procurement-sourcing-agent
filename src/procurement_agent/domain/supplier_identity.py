"""Tell one real company apart from the many names it is found under.

A research run discovers pages, not companies. The same manufacturer shows up
as "Bosch", "Bosch Security Systems B.V.", "boschsecurity.com" and
"www.boschsecurity.com". Those are separate findings with separate evidence,
but they are one supplier, and a buyer who reads twenty-three rows of the same
company learns nothing from them.

The rule is deliberately narrow, because merging two different companies is
worse than showing two rows:

- the words of a name are compared after legal suffixes and the words that
  only describe the business ("security", "systems", ...) are dropped;
- a name that is only a web address is read as the label of that address;
- two names are the same supplier when those words are equal, or when a plain
  company name starts the label of a web address of that company.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

_LEGAL_SUFFIXES = (
    "co ltd", "coltd", "co limited", "company limited", "ltd", "limited", "llc", "inc",
    "incorporated", "corp", "corporation", "gmbh", "ag", "sa", "sas", "nv", "bv", "pty",
    "plc", "oy", "ab", "as", "kk",
)
_LEGAL_INITIALS = ("b", "v", "g", "m", "k", "s", "a", "ag", "as")
_GENERIC_WORDS = ("security", "systems", "solutions", "electronics", "group", "holding")
_PARENTHESIS = re.compile(r"\([^)]*\)")
_PUNCTUATION = re.compile(r"[^a-z0-9]+")
_DOMAIN = re.compile(r"^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$")


def _tokens(name: str) -> list[str]:
    folded = _PARENTHESIS.sub(" ", name.casefold())
    folded = re.sub(r"\bwww\b", " ", folded)
    return [token for token in _PUNCTUATION.sub(" ", folded).split() if token]


def _strip_suffix(tokens: list[str]) -> list[str]:
    while tokens and (tokens[-1] in _LEGAL_SUFFIXES or (len(tokens[-1]) == 1 and tokens[-1] in _LEGAL_INITIALS)):
        tokens = tokens[:-1]
    return tokens


def _domain_label(name: str) -> str | None:
    """The label of a name that is only a web address."""
    address = name.casefold().strip().replace(" ", "")
    if address.startswith("www."):
        address = address[4:]
    if not _DOMAIN.match(address):
        return None
    return address.split(".")[0]


def supplier_core(name: str) -> str:
    """The words of a supplier name that identify it, without its decoration."""
    label = _domain_label(name)
    if label:
        # A web address is not a company name; its label is.
        return label
    tokens = _strip_suffix(_tokens(name))
    if not tokens:
        return ""
    words = [token for token in tokens if token not in _GENERIC_WORDS]
    return " ".join(words or tokens)


def supplier_key(name: str) -> str:
    """A key that is equal for two names of the same company."""
    return supplier_core(name).replace(" ", "")


def _is_domain_label(name: str) -> bool:
    return _domain_label(name) is not None


def same_supplier(first: str, second: str) -> bool:
    """Whether two discovered names point at one company."""
    left = supplier_key(first)
    right = supplier_key(second)
    if not left or not right:
        return False
    if left == right:
        return True
    # A plain company name and the web address of that company: the label of
    # the address starts with the name. Two plain names are never merged this
    # way, so "Bosch" and "Boschmann" stay apart.
    shorter, longer = sorted((left, right), key=len)
    if len(shorter) < 4:
        return False
    if _is_domain_label(first) == _is_domain_label(second):
        return False
    domain_side = first if _is_domain_label(first) else second
    name_side = second if _is_domain_label(first) else first
    domain_label = supplier_key(domain_side)
    return domain_label.startswith(supplier_key(name_side))


def merge_supplier_names(names: Iterable[str]) -> str:
    """The name to show for one supplier: the shortest of its variants."""
    variants = [name.strip() for name in names if name and name.strip()]
    if not variants:
        return "未知供应商"
    return min(variants, key=lambda name: (len(name), name))


def group_by_supplier(entries: list[dict[str, object]], name_key: str = "supplier_name") -> list[list[dict[str, object]]]:
    """Group rows that name the same company, keeping the first row's order."""
    groups: list[list[dict[str, object]]] = []
    names: list[str] = []
    for entry in entries:
        name = str(entry.get(name_key) or "")
        target = -1
        for index, other in enumerate(names):
            if same_supplier(name, other):
                target = index
                break
        if target < 0:
            names.append(name)
            groups.append([entry])
        else:
            groups[target].append(entry)
    return groups
