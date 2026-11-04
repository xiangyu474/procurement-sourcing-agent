"""How a quotation has to talk about a quantity before it may be used.

A number in a quotation is evidence of the quantity the requirement asks about
only when the quotation names that quantity. A catalogue title that happens to
carry "5MP" says what a product is called, not what it measures: the row
"CAM-CIC-5MR/5000R 5MP 14fps Color, Mono" is a listing, and the "5MP" in it
belongs to the name of the product.

This module holds the words that name a quantity, so a quotation can be
checked against them without asking a model. The rule is deliberately
one-sided: a quotation that does not name the quantity is not usable, which
leaves the verdict at UNKNOWN rather than turning a name into a pass.
"""

from __future__ import annotations

import re

# The words that name a quantity, by the kind of quantity. A quotation has to
# use one of them before its number may be read as that quantity.
NAMING_TERMS_BY_TRIGGER: dict[str, frozenset[str]] = {
    "resolution": frozenset(
        {"resolution", "pixel", "pixels", "megapixel", "px", "分辨率", "像素"}
    ),
    "power": frozenset({"power", "watt", "watts", "功率", "瓦特"}),
    "temperature": frozenset({"temperature", "celsius", "温度"}),
    "rating": frozenset({"rating", "nema", "防护等级", "防护"}),
    "protocol": frozenset({"protocol", "onvif", "rtsp", "协议"}),
    "focal": frozenset({"focal", "焦距"}),
    "capacity": frozenset({"capacity", "storage", "容量"}),
    "weight": frozenset({"weight", "重量"}),
}

_TOKEN_SPLIT = re.compile(r"[^0-9A-Za-z一-鿿]+")
_CJK = re.compile(r"[一-鿿]")


def _has_cjk(text: str) -> bool:
    return bool(_CJK.search(text))


def _fold(text: str) -> str:
    """Fold a text so that spacing, case, and underscores do not hide a match."""
    return "".join(_TOKEN_SPLIT.split(text.casefold()))


def _key_terms(attribute_key: str) -> set[str]:
    """The words of the attribute key itself."""
    return {
        token
        for token in _TOKEN_SPLIT.split((attribute_key or "").casefold())
        if len(token) >= 3 or _has_cjk(token)
    }


def _group_terms(attribute_key: str) -> set[str]:
    """The words that name the quantity, chosen by the kind of attribute."""
    key = (attribute_key or "").casefold()
    terms: set[str] = set()
    for trigger, names in NAMING_TERMS_BY_TRIGGER.items():
        if trigger in key:
            terms |= names
    return terms


def _definition_terms(attribute_definition: str | None) -> set[str]:
    """The words of the attribute definition, and the bigrams of a Chinese one.

    A Chinese definition is written without spaces, so the two-character
    pieces are the words a quotation can use.
    """
    definition = (attribute_definition or "").strip()
    if not definition:
        return set()
    terms = {definition.casefold()}
    if _has_cjk(definition):
        for index in range(len(definition) - 1):
            terms.add(definition[index : index + 2].casefold())
    return terms


def attribute_terms(attribute_key: str, attribute_definition: str | None = None) -> list[str]:
    """The words that name one quantity in a source quotation."""
    terms = _key_terms(attribute_key) | _group_terms(attribute_key) | _definition_terms(attribute_definition)
    return sorted(term for term in terms if term)


def quote_names_the_quantity(quote: str, terms: list[str] | tuple[str, ...]) -> bool:
    """Report whether a quotation names the quantity it is used for."""
    folded = _fold(quote)
    if not folded:
        return False
    for term in terms:
        if not term:
            continue
        candidate = _fold(term)
        if candidate and candidate in folded:
            return True
    return False


# Attribute keys that are known to mean the same measurement. The groups are
# small and reviewed by hand: a group only holds names of the same quantity.
# "max_input_power" and "rated_output_power" are in different groups on
# purpose, because they are not the same measurement.
APPROVED_ALIASES: dict[str, frozenset[str]] = {
    "output_resolution": frozenset(
        {"output_resolution", "image_output_resolution", "video_output_resolution", "resolution", "image_resolution"}
    ),
    "rated_output_power": frozenset({"rated_output_power", "output_power"}),
    "operating_temperature": frozenset(
        {"operating_temperature", "working_temperature", "operating_temperature_range"}
    ),
    "ingress_rating": frozenset({"ingress_rating", "protection_rating", "ip_rating"}),
    "supported_protocols": frozenset({"supported_protocols", "protocol_support", "protocols"}),
    "lens_focal_length": frozenset({"lens_focal_length", "focal_length"}),
    "max_input_power": frozenset({"max_input_power", "input_power"}),
}

_ALIAS_CANONICAL: dict[str, str] = {
    member: canonical for canonical, members in APPROVED_ALIASES.items() for member in members
}


def canonical_attribute_key(attribute_key: str) -> str:
    """Write one attribute key in the canonical spelling of its group.

    Two names of the same measurement are one measurement, so a claim that the
    model typed as "video_output_resolution" and a requirement that says
    "output_resolution" are the same quantity and must meet each other. A key
    that is not in a reviewed group is left exactly as it is.
    """
    key = "_".join(part for part in "".join(ch if ch.isalnum() else " " for ch in attribute_key.casefold()).split())
    return _ALIAS_CANONICAL.get(key, key[:120] or "attribute")
