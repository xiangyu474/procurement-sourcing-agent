"""Tests for the guards that keep a product name out of a technical verdict.

A catalogue row such as "CAM-CIC-5MR/5000R 5MP 14fps Color, Mono" carries the
number 5MP, but the number belongs to the name of the product. These tests
hold the line: a quotation that does not name the quantity may not be read as
a measurement, and a value that says more than its quotation does may not be
used either.
"""

from __future__ import annotations

from typing import Any

from procurement_agent.domain.attributes import attribute_terms, quote_names_the_quantity
from procurement_agent.domain.requirements import ParseStatus, ValueType
from procurement_agent.domain.sourcing import ClaimDraft, ClaimStatus, SubjectType
from procurement_agent.domain.spec_alignment import ProductAttributeClaim
from procurement_agent.services.spec_typing import _value_is_quoted, type_claims

PRODUCT_TITLE_QUOTE = "CAM-CIC-5MR/5000R 5MP 14fps Color, Mono"
CAMERA_TITLE_QUOTE = "Camera IPS05-R10-OIA4 ILL Pro4 5MP Corner"
SPEC_ROW_QUOTE = "5.0 MP, 2448 x 2048 px"
SENSOR_ROW_QUOTE = "Effective Camera Resolution: 5 Megapixel"


class _FakeChunk:
    def __init__(self, arguments: dict[str, Any]):
        self.tool_calls = [{"name": "answer", "args": arguments}]
        self.content = ""

    def __add__(self, other: Any) -> Any:
        return self


class StubModel:
    """Proposes the typed claims it is given."""

    def __init__(self, claims: list[dict[str, Any]]):
        self.claims = claims
        self.calls = 0

    def bind_tools(self, tools, tool_choice=None):
        return self

    def stream(self, messages, config=None):
        self.calls += 1
        yield _FakeChunk({"claims": self.claims})


def claim(quote: str, value: str, attribute: str = "resolution") -> ClaimDraft:
    return ClaimDraft(
        claim_id="clm_1",
        subject_type=SubjectType.PRODUCT_MODEL,
        subject_ref="prd_1",
        attribute=attribute,
        value=value,
        unit=None,
        evidence_id="ev_1",
        source_quote=quote,
        status=ClaimStatus.SUPPORTED_BY_SOURCE,
        evaluation_method="EXCERPT_MATCH",
    )


def typed_claim(quote: str, value: str, attribute: str = "resolution") -> ProductAttributeClaim:
    model = StubModel(
        [
            {
                "claim_id": "clm_1",
                "attribute_key": "output_resolution",
                "attribute_definition": "Video output pixel count",
                "value_type": "NUMBER",
                "value": value,
                "unit": "MP",
            }
        ]
    )
    typed = type_claims(
        claims=[claim(quote, value, attribute)],
        target_attributes=["output_resolution"],
        attribute_definitions={"output_resolution": "视频输出分辨率"},
        model=model,
        evidence={"ev_1": "snapshot"},
    )
    assert typed, "the model proposed a typed claim"
    return typed[0]


def test_a_product_title_that_carries_the_number_is_not_a_measurement() -> None:
    """The 5MP of a catalogue title belongs to the name of the product."""
    typed = typed_claim(PRODUCT_TITLE_QUOTE, "5")

    assert typed.claim_status == ClaimStatus.UNVERIFIED
    assert typed.extraction_status == ParseStatus.AMBIGUOUS


def test_a_camera_title_that_carries_the_number_is_not_a_measurement() -> None:
    """The same rule holds for the title of a camera model."""
    typed = typed_claim(CAMERA_TITLE_QUOTE, "5")

    assert typed.claim_status == ClaimStatus.UNVERIFIED
    assert typed.extraction_status == ParseStatus.AMBIGUOUS


def test_a_specification_row_may_be_used() -> None:
    """A row that states the resolution names the quantity and may be used."""
    typed = typed_claim(SPEC_ROW_QUOTE, "5")

    assert typed.claim_status == ClaimStatus.SUPPORTED_BY_SOURCE
    assert typed.extraction_status == ParseStatus.RESOLVED


def test_a_row_that_names_the_resolution_may_be_used() -> None:
    """A row that names the resolution states the quantity it measures."""
    typed = typed_claim(SENSOR_ROW_QUOTE, "5")

    assert typed.claim_status == ClaimStatus.SUPPORTED_BY_SOURCE


def test_a_value_that_says_more_than_its_quotation_is_not_used() -> None:
    """A model that adds a reading of its own does not get to measure."""
    typed = typed_claim(
        PRODUCT_TITLE_QUOTE,
        "5MP, 14fps, offered Color and Mono (official 2017 VisionPro row for the 5MR/5000R family)",
    )

    assert typed.claim_status == ClaimStatus.UNVERIFIED


def test_the_words_of_the_value_have_to_be_in_the_quotation() -> None:
    """The check on the words of a value is a check on the quotation."""
    assert _value_is_quoted("5", ValueType.NUMBER, "MP", "5MP camera") is True
    assert _value_is_quoted("5MP, 14fps, Color and Mono", ValueType.NUMBER, "MP", "5MP 14fps") is False
    assert _value_is_quoted("5", ValueType.NUMBER, "MP", "5MP 14fps") is True


def test_a_pixel_size_is_a_number_the_quotation_can_confirm() -> None:
    """Both sides of a pixel size have to be written in the quotation."""
    assert _value_is_quoted("2448 x 2048", ValueType.NUMBER, "pixels", "5.0 MP, 2448 x 2048 px") is True
    assert _value_is_quoted("2448 x 2048", ValueType.NUMBER, "pixels", "2448 x 2048") is True
    assert _value_is_quoted("2448 x 2048", ValueType.NUMBER, "pixels", "2448 pixels wide") is False


def test_the_terms_of_an_attribute_name_its_quantity() -> None:
    """The words that name a quantity are read off the key and the definition."""
    terms = attribute_terms("output_resolution", "视频输出分辨率")

    assert "resolution" in terms
    assert quote_names_the_quantity("up to 2560 x 1920 resolution", terms) is True
    assert quote_names_the_quantity("CAM-CIC-5MR/5000R 5MP 14fps Color, Mono", terms) is False
    assert quote_names_the_quantity("输出分辨率：2560 x 1920", terms) is True
