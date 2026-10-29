"""Reading numbers and quotations out of source text.

Both the demand compiler and the product claim typer need the same question:
does this text state this number, on this unit? The answer lives here so both
sides judge a quotation the same way.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

from procurement_agent.domain.units import unit_spec, unit_spellings

SCALE_WORDS: dict[str, Decimal] = {
    "万": Decimal(10_000),
    "亿": Decimal(100_000_000),
    "千": Decimal(1000),
}

_NUMBER = re.compile(r"(?<![\d.,])(-?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?")


@dataclass(frozen=True)
class QuotedNumber:
    """One number the source text states, with the scale word and unit after it."""

    value: Decimal
    scale: Decimal
    unit: str | None


def read_decimal(text: str) -> Decimal | None:
    """Read a finite decimal from the DSL's canonical string form."""
    if not isinstance(text, str):
        return None
    try:
        result = Decimal(text.replace(",", "").strip())
    except (InvalidOperation, ValueError):
        return None
    return result if result.is_finite() else None


def detect_unit(text: str) -> tuple[str | None, str]:
    """Read the unit that follows a number, and the rest of the text."""
    tail = text.lstrip()
    for spelling, normalized in unit_spellings():
        if tail[: len(spelling)].casefold() == spelling.casefold():
            return normalized, tail[len(spelling):]
    return None, tail


def quoted_numbers(text: str) -> list[QuotedNumber]:
    """Read every number the text states, with the scale word and unit after it."""
    found: list[QuotedNumber] = []
    for match in _NUMBER.finditer(text):
        sign, whole, fraction = match.groups()
        raw = f"{sign}{whole}" + (f".{fraction}" if fraction else "")
        value = read_decimal(raw)
        if value is None:
            continue
        tail = text[match.end():]
        scale = Decimal(1)
        stripped = tail.lstrip()
        if stripped[:1] in SCALE_WORDS:
            scale = SCALE_WORDS[stripped[0]]
            tail = stripped[1:]
        unit, _rest = detect_unit(tail)
        found.append(QuotedNumber(value=value, scale=scale, unit=unit))
    return found


def number_is_quoted(value: Decimal, unit: str | None, quote: str) -> bool:
    """Report whether the quote states the value on the unit the requirement states.

    A requirement that says 5 MP is confirmed by a quote that says 5MP and by
    a quote that says 500万像素, because both state the same quantity. A
    requirement that says 5 with no unit is confirmed only by a unitless
    number.
    """
    quoted = quoted_numbers(quote)
    if not quoted:
        return False
    requirement_spec = unit_spec(unit)
    for item in quoted:
        if requirement_spec is None:
            if item.value * item.scale == value:
                return True
            continue
        if item.unit is None:
            continue
        quote_spec = unit_spec(item.unit)
        if quote_spec is None or quote_spec.dimension != requirement_spec.dimension:
            continue
        if item.value * item.scale * quote_spec.factor == value * requirement_spec.factor:
            return True
    return False


def plain_number_is_quoted(value: Decimal, quote: str) -> bool:
    """Report whether the quote states the value, whatever scale word it carries."""
    return any(item.value == value for item in quoted_numbers(quote))


def text_is_quoted(text: str, quote: str) -> bool:
    """Report whether a piece of text appears in the quotation."""
    def normalize(value: str) -> str:
        return " ".join(value.split()).casefold()

    return bool(text.strip()) and normalize(text) in normalize(quote)


def quote_is_grounded(quote: str | None, source_text: str | None) -> bool:
    """Report whether the quote appears in the cited fragment."""
    if not quote or not source_text:
        return False
    return " ".join(quote.split()) in " ".join(source_text.split())


def cited_text(refs: Sequence[str], index: dict[str, str]) -> str:
    """Join the text of the fragments a requirement cites."""
    return " ".join(index.get(ref, "") for ref in sorted(set(refs)) if ref)
