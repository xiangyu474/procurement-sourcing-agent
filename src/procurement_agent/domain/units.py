"""Whitelisted unit normalisation for M3 constraint comparison.

Only units that measure the same quantity convert into each other. The table
keeps measurement definitions apart on purpose:

- Decimal storage bytes and binary storage bytes are different dimensions, so a
  32 GB drive is never compared with a 32 GiB one.
- A frame rate and a temporal frequency are different dimensions.

A pixel count is one dimension: 5 MP and 5 000 000 px are the same quantity.
The difference between sensor effective pixels and video output pixels is not
a unit question. It is a question of what the attribute measures, and that
belongs to the alignment step.

A unit that the table does not know is still comparable with an identical unit
string on the other side: the same unit cancels out of an ordering. Two
different unknown units are not comparable, because the scale factor between
them is unknown.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum


class UnitDimension(StrEnum):
    """The physical quantity a unit measures."""

    NONE = "NONE"
    LENGTH = "LENGTH"
    POWER = "POWER"
    VOLTAGE = "VOLTAGE"
    CURRENT = "CURRENT"
    FREQUENCY = "FREQUENCY"
    FRAME_RATE = "FRAME_RATE"
    PIXEL_COUNT = "PIXEL_COUNT"
    STORAGE_DECIMAL = "STORAGE_DECIMAL"
    STORAGE_BINARY = "STORAGE_BINARY"
    TIME = "TIME"
    TEMPERATURE = "TEMPERATURE"
    DATA_RATE = "DATA_RATE"
    ANGLE = "ANGLE"
    MASS = "MASS"


@dataclass(frozen=True)
class UnitSpec:
    """A unit, its dimension, and the factor that reaches the base unit."""

    dimension: UnitDimension
    factor: Decimal
    base_unit: str


# unit -> (dimension, factor to base unit, base unit)
_UNIT_TABLE: dict[str, tuple[UnitDimension, str, str]] = {
    # Length, base millimetre.
    "mm": (UnitDimension.LENGTH, "1", "mm"),
    "cm": (UnitDimension.LENGTH, "10", "mm"),
    "dm": (UnitDimension.LENGTH, "100", "mm"),
    "m": (UnitDimension.LENGTH, "1000", "mm"),
    "um": (UnitDimension.LENGTH, "0.001", "mm"),
    "nm": (UnitDimension.LENGTH, "0.000001", "mm"),
    "in": (UnitDimension.LENGTH, "25.4", "mm"),
    "mil": (UnitDimension.LENGTH, "0.0254", "mm"),
    # Power, base watt.
    "w": (UnitDimension.POWER, "1", "W"),
    "mw": (UnitDimension.POWER, "0.001", "W"),
    "kw": (UnitDimension.POWER, "1000", "W"),
    "megw": (UnitDimension.POWER, "1000000", "W"),
    # Voltage, base volt.
    "v": (UnitDimension.VOLTAGE, "1", "V"),
    "mv": (UnitDimension.VOLTAGE, "0.001", "V"),
    "kv": (UnitDimension.VOLTAGE, "1000", "V"),
    # Current, base ampere.
    "a": (UnitDimension.CURRENT, "1", "A"),
    "ma": (UnitDimension.CURRENT, "0.001", "A"),
    "ka": (UnitDimension.CURRENT, "1000", "A"),
    # Temporal frequency, base hertz.
    "hz": (UnitDimension.FREQUENCY, "1", "Hz"),
    "khz": (UnitDimension.FREQUENCY, "1000", "Hz"),
    "mhz": (UnitDimension.FREQUENCY, "1000000", "Hz"),
    "ghz": (UnitDimension.FREQUENCY, "1000000000", "Hz"),
    # Frame rate, base frame per second. Kept apart from hertz on purpose.
    "fps": (UnitDimension.FRAME_RATE, "1", "fps"),
    # Pixel count, base pixel.
    "px": (UnitDimension.PIXEL_COUNT, "1", "px"),
    "kpx": (UnitDimension.PIXEL_COUNT, "1000", "px"),
    "mp": (UnitDimension.PIXEL_COUNT, "1000000", "px"),
    "mpx": (UnitDimension.PIXEL_COUNT, "1000000", "px"),
    # Decimal storage, base byte.
    "b": (UnitDimension.STORAGE_DECIMAL, "1", "B"),
    "kb": (UnitDimension.STORAGE_DECIMAL, "1000", "B"),
    "mb": (UnitDimension.STORAGE_DECIMAL, "1000000", "B"),
    "gb": (UnitDimension.STORAGE_DECIMAL, "1000000000", "B"),
    "tb": (UnitDimension.STORAGE_DECIMAL, "1000000000000", "B"),
    # Binary storage, base byte.
    "kib": (UnitDimension.STORAGE_BINARY, "1024", "B"),
    "mib": (UnitDimension.STORAGE_BINARY, "1048576", "B"),
    "gib": (UnitDimension.STORAGE_BINARY, "1073741824", "B"),
    "tib": (UnitDimension.STORAGE_BINARY, "1099511627776", "B"),
    # Time, base second.
    "s": (UnitDimension.TIME, "1", "s"),
    "ms": (UnitDimension.TIME, "0.001", "s"),
    "min": (UnitDimension.TIME, "60", "s"),
    "h": (UnitDimension.TIME, "3600", "s"),
    # Temperature, base degree Celsius. No affine conversion is supported.
    "degc": (UnitDimension.TEMPERATURE, "1", "degC"),
    # Data rate, base bit per second.
    "bps": (UnitDimension.DATA_RATE, "1", "bit/s"),
    "kbps": (UnitDimension.DATA_RATE, "1000", "bit/s"),
    "mbps": (UnitDimension.DATA_RATE, "1000000", "bit/s"),
    "gbps": (UnitDimension.DATA_RATE, "1000000000", "bit/s"),
    # Angle, base degree.
    "deg": (UnitDimension.ANGLE, "1", "deg"),
    "rad": (UnitDimension.ANGLE, "57.29577951308232", "deg"),
    # Mass, base kilogram.
    "kg": (UnitDimension.MASS, "1", "kg"),
    "g": (UnitDimension.MASS, "0.001", "kg"),
    "mg": (UnitDimension.MASS, "0.000001", "kg"),
    "t": (UnitDimension.MASS, "1000", "kg"),
}

# Spellings that mean the same unit. The key is the normalised unit string.
_ALIASES: dict[str, str] = {
    "µm": "um",
    "μm": "um",
    "micron": "um",
    "microns": "um",
    "微米": "um",
    "毫米": "mm",
    "厘米": "cm",
    "米": "m",
    "英寸": "in",
    "megapixel": "mp",
    "megapixels": "mp",
    "megapix": "mp",
    "百万像素": "mp",
    "像素": "px",
    "pixel": "px",
    "pixels": "px",
    "watt": "w",
    "watts": "w",
    "瓦": "w",
    "千瓦": "kw",
    "milliwatt": "mw",
    "volt": "v",
    "volts": "v",
    "伏": "v",
    "伏特": "v",
    "ampere": "a",
    "安": "a",
    "安培": "a",
    "hertz": "hz",
    "赫兹": "hz",
    "framespersecond": "fps",
    "gigabyte": "gb",
    "gigabytes": "gb",
    "gibibyte": "gib",
    "gibibytes": "gib",
    "millisecond": "ms",
    "seconds": "s",
    "second": "s",
    "秒": "s",
    "分钟": "min",
    "小时": "h",
    "celsius": "degc",
    "°c": "degc",
    "℃": "degc",
    "华氏度": "degc",
    "bit/s": "bps",
    "degree": "deg",
    "degrees": "deg",
    "度": "deg",
    "弧度": "rad",
    "kilogram": "kg",
    "千克": "kg",
    "公斤": "kg",
    "gram": "g",
    "克": "g",
}


def unit_spellings() -> list[tuple[str, str]]:
    """Surface spellings that can be recognized inside free text, longest first.

    The longer spelling wins, so a text that says "cm" is read as centimetres
    and not as metres.
    """
    spellings: list[tuple[str, str]] = [(key, key) for key in _UNIT_TABLE]
    spellings.extend(_ALIASES.items())
    return sorted(spellings, key=lambda item: -len(item[0]))


def normalize_unit(unit: str | None) -> str | None:
    """Return the canonical spelling of a unit, or None when there is none."""
    if unit is None:
        return None
    key = unit.strip().casefold().replace(" ", "")
    if not key:
        return None
    return _ALIASES.get(key, key)


def unit_spec(unit: str | None) -> UnitSpec | None:
    """Describe a unit, or return None when the whitelist does not know it."""
    normalized = normalize_unit(unit)
    if normalized is None:
        return None
    entry = _UNIT_TABLE.get(normalized)
    if entry is None:
        return None
    dimension, factor, base = entry
    return UnitSpec(dimension=dimension, factor=Decimal(factor), base_unit=base)


def units_compatible(left: str | None, right: str | None) -> bool:
    """Report whether two units can be brought onto one scale."""
    if left is None or right is None:
        return left is None and right is None
    normalized_left = normalize_unit(left)
    normalized_right = normalize_unit(right)
    if normalized_left == normalized_right:
        return True
    spec_left = unit_spec(normalized_left)
    spec_right = unit_spec(normalized_right)
    if spec_left is None or spec_right is None:
        return False
    return spec_left.dimension == spec_right.dimension


def convert_to_base(magnitude: Decimal, unit: str | None) -> tuple[Decimal, str] | None:
    """Convert a magnitude into the base unit of its dimension."""
    spec = unit_spec(unit)
    if spec is None:
        return None
    return magnitude * spec.factor, spec.base_unit


def convert_between(magnitude: Decimal, from_unit: str | None, to_unit: str | None) -> Decimal | None:
    """Express a magnitude in another unit of the same dimension."""
    if from_unit is None or to_unit is None:
        return None
    if normalize_unit(from_unit) == normalize_unit(to_unit):
        return magnitude
    source = unit_spec(from_unit)
    target = unit_spec(to_unit)
    if source is None or target is None or source.dimension != target.dimension:
        return None
    return magnitude * source.factor / target.factor
