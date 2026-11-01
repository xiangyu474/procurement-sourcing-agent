"""M3-A2: turn the research claims into typed product attribute claims.

The researcher records what a source states as free text: an attribute name, a
value, sometimes a unit. The typing step asks the model to give that text a
type, and the code then checks the reading against the quotation the claim
already carries.

A claim whose number is not in its own quotation does not become a usable
typed claim. It stays unverified, and the calculator refuses to use it, so a
model cannot invent a threshold that turns into a PASS.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import ValidationError

from procurement_agent.domain.attributes import attribute_terms, quote_names_the_quantity
from procurement_agent.domain.requirements import ParseStatus, ValueType
from procurement_agent.domain.sourcing import ClaimDraft, ClaimStatus
from procurement_agent.domain.spec_alignment import (
    ProductAttributeClaim,
    TypedClaimBatch,
)
from procurement_agent.domain.units import pixel_size
from procurement_agent.infra.llm import json_object_from_text, stream_tool_call
from procurement_agent.services.source_numbers import (
    number_is_quoted,
    plain_number_is_quoted,
    quoted_numbers,
    read_decimal,
    text_is_quoted,
)

SYSTEM_PROMPT = """You type product claims so that a requirement can be compared with them.

A claim says what a source states about one product model. You give it a stable
attribute key, a definition of what the attribute measures, a value type, a
value, and a unit.

Rules:
- Keep the claim's own wording in the value. Do not round, convert, or infer a number the quotation does not state. If the quotation states "up to 2560 x 1920 (~5 MP) pixels", the value is 5 and the unit is MP, and the conditions keep the wording.
- value_type NUMBER needs a decimal number and its unit. BOOLEAN needs true or false. STRING needs one text value. SET needs a list of tokens the source lists. RANGE needs lower and upper bounds.
- attribute_key is a lowercase snake_case identifier that names the quantity the attribute measures, not the wording of the source. attribute_definition says what the attribute measures, in a few words.
- Do not merge two claims that measure different quantities. Do not drop a qualifier such as a mode, a variant, or a condition.
- Copy the claim_id exactly as it is given.
- Type a claim when it states one of the target attributes, even when the wording differs. Leave out the claims that state something else, and answer with an empty list when none of them states a target attribute.
- If a claim states something that cannot be given a comparable value, answer with value_type NUMBER and value null only if the source states a number; otherwise leave value_type out.
"""

_TRUE_WORDS = {"是", "有", "支持", "yes", "true", "√", "已"}
_FALSE_WORDS = {"否", "无", "不支持", "no", "false", "×", "未"}

TYPING_BATCH_SIZE = 15
TYPING_CONCURRENCY = 3

# The guards that decide whether a reading may be used. The number is part of
# the rules, because a change of the guards changes which readings are valid.
TYPING_GUARD_VERSION = "2.0"


def typing_rules_version() -> str:
    """The digest of the prompt and the schema that type the claims.

    Changing either of them changes the version, so the cache of this layer
    stops being used without anyone having to remember a number.
    """
    from procurement_agent.domain.judgment_cache import digest

    return digest(
        {
            "prompt": SYSTEM_PROMPT,
            "schema": TypedClaimBatch.model_json_schema(),
            "guards": TYPING_GUARD_VERSION,
        }
    )


def _claim_payload(claims: Sequence[ClaimDraft]) -> list[dict[str, Any]]:
    return [
        {
            "claim_id": claim.claim_id,
            "attribute": claim.attribute,
            "value": claim.value,
            "unit": claim.unit,
            "source_quote": claim.source_quote,
            "evidence_id": claim.evidence_id,
        }
        for claim in claims
    ]


def _propose(
    *,
    claims: Sequence[ClaimDraft],
    target_attributes: Sequence[str],
    model: BaseChatModel,
    batch_size: int = TYPING_BATCH_SIZE,
    config: dict[str, Any] | None = None,
    concurrency: int = TYPING_CONCURRENCY,
) -> dict[str, Any]:
    """Ask the model to type the claims, a batch at a time.

    A long list of claims makes the request slow enough to time out, so the
    list is cut into batches and each batch is a separate call. The batch size
    is a setting, not a constant of the code.
    """
    typed: dict[str, Any] = {}
    step = max(1, batch_size)
    batches = [claims[start: start + step] for start in range(0, len(claims), step)]
    # The batches do not depend on each other, so they run together.
    with ThreadPoolExecutor(max_workers=max(1, min(concurrency, len(batches)))) as pool:
        results = list(
            pool.map(
                lambda batch: _propose_batch(
                    claims=batch,
                    target_attributes=target_attributes,
                    model=model,
                    config=config,
                ),
                batches,
            )
        )
    for result in results:
        typed.update(result)
    return typed


def _stage_config(config: dict[str, Any] | None, tag: str) -> dict[str, Any]:
    """Mark a call with its stage, so the cost of each stage can be told apart."""
    merged = dict(config or {})
    tags = list(merged.get("tags") or [])
    tags.append(tag)
    merged["tags"] = tags
    return merged


def _propose_batch(
    *,
    claims: Sequence[ClaimDraft],
    target_attributes: Sequence[str],
    model: BaseChatModel,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Ask the model to type one batch of claims."""
    payload = {
        "target_attributes": list(target_attributes),
        "claims": _claim_payload(claims),
    }
    batches: list[TypedClaimBatch] = []
    for attempt in range(2):
        try:
            payloads, text = stream_tool_call(
                model,
                [
                    SystemMessage(content=SYSTEM_PROMPT),
                    HumanMessage(content=json.dumps(payload, ensure_ascii=False)),
                ]
                + (
                    [
                        HumanMessage(
                            content="Answer with one typed claim for every claim_id given to you."
                        )
                    ]
                    if attempt
                    else []
                ),
                TypedClaimBatch,
                config=_stage_config(config, "m3-typing"),
            )
        except Exception:
            # The provider failed. The claims of this batch stay untyped, so the
            # calculator reports UNKNOWN for them instead of guessing.
            continue
        for raw in payloads:
            try:
                batches.append(TypedClaimBatch.model_validate(raw))
            except ValidationError:
                continue
        if batches:
            break
        found = json_object_from_text(text)
        if found is not None:
            try:
                batches.append(TypedClaimBatch.model_validate(found))
            except ValidationError:
                pass
            break
    typed: dict[str, Any] = {}
    for batch in batches:
        for proposal in batch.claims:
            typed.setdefault(proposal.claim_id, proposal)
    return typed


def _value_words_are_quoted(value: Any, quote: str) -> bool:
    """Report whether every word of the value is written in the quotation.

    The model is told to keep the wording of the source. A value that adds
    words the quotation does not carry is the model's own reading, so the
    number in it may not be used as a measurement.
    """
    folded_quote = "".join(str(quote).casefold().split())
    for word in re.findall(r"[0-9A-Za-z一-鿿]+", str(value)):
        if word.isdigit() or len(word) < 2:
            continue
        if word.casefold() not in folded_quote:
            return False
    return True


def _value_is_quoted(value: Any, value_type: ValueType, unit: str | None, quote: str) -> bool:
    """Report whether the quotation states the value the model proposed."""
    if value_type == ValueType.NUMBER:
        number = read_decimal(str(value))
        if number is not None:
            if not number_is_quoted(number, unit, quote):
                return False
            return _value_words_are_quoted(value, quote)
        # A pixel size states two numbers. Both of them have to be in the
        # quotation, and the size is used as the pixel count it is.
        sides = pixel_size(str(value))
        if sides is None:
            return False
        # The unit of a pixel size is the size itself, so the two numbers
        # only have to be written in the quotation.
        return all(plain_number_is_quoted(side, quote) for side in sides)
    if value_type == ValueType.RANGE:
        if not isinstance(value, dict):
            return False
        for bound in ("lower", "upper"):
            raw = value.get(bound)
            if raw is None:
                continue
            number = read_decimal(str(raw))
            if number is None or not number_is_quoted(number, unit, quote):
                return False
        return True
    if value_type == ValueType.STRING:
        return isinstance(value, str) and text_is_quoted(value, quote)
    if value_type == ValueType.SET:
        if not isinstance(value, (list, tuple)) or not value:
            return False
        return all(isinstance(item, str) and text_is_quoted(item, quote) for item in value)
    if value_type == ValueType.BOOLEAN:
        if not isinstance(value, bool):
            return False
        words = _TRUE_WORDS if value else _FALSE_WORDS
        folded = quote.casefold()
        return any(word.casefold() in folded for word in words)
    return False


def _canonical_attribute_key(value: str) -> str:
    key = "_".join(part for part in "".join(ch if ch.isalnum() else " " for ch in value.casefold()).split())
    return key[:120] or "attribute"


def type_claims(
    *,
    claims: Sequence[ClaimDraft],
    target_attributes: Sequence[str],
    model: BaseChatModel,
    attribute_definitions: Mapping[str, str] | None = None,
    evidence: Mapping[str, str] | None = None,
    batch_size: int = TYPING_BATCH_SIZE,
    config: dict[str, Any] | None = None,
    fast_model: BaseChatModel | None = None,
    concurrency: int = TYPING_CONCURRENCY,
) -> list[ProductAttributeClaim]:
    """Type the research claims and check every reading against its quotation.

    The typing step reads a number out of a quotation and the code checks the
    number against that quotation, so it does not need the model to think at
    length. When a faster model is given, it is used for this step only.
    """
    if not claims:
        return []
    proposals = _propose(
        claims=claims,
        target_attributes=target_attributes,
        model=fast_model or model,
        batch_size=batch_size,
        config=config,
        concurrency=concurrency,
    )
    typed: list[ProductAttributeClaim] = []
    for claim in claims:
        proposal = proposals.get(claim.claim_id)
        if proposal is None:
            continue
        value_type = proposal.value_type
        if value_type is None:
            continue
        value = proposal.value
        if value is None:
            continue
        unit = proposal.unit if proposal.unit is not None else claim.unit
        quote = claim.source_quote
        supported = claim.status == ClaimStatus.SUPPORTED_BY_SOURCE
        if evidence is not None and claim.evidence_id not in evidence:
            supported = False
        verified = _value_is_quoted(value, value_type, unit, quote)
        attribute_key = _canonical_attribute_key(proposal.attribute_key or claim.attribute)
        if verified and value_type in (ValueType.NUMBER, ValueType.RANGE):
            # A number may only be read as a measurement when the quotation
            # names the quantity it measures. A catalogue title that carries
            # "5MP" names a product, not a resolution.
            terms = set(attribute_terms(attribute_key))
            terms |= set(attribute_terms(claim.attribute or ""))
            definition = (attribute_definitions or {}).get(attribute_key)
            if definition:
                terms |= set(attribute_terms("", definition))
            if terms and not quote_names_the_quantity(quote, sorted(terms)):
                verified = False
        typed.append(
            ProductAttributeClaim(
                claim_id=claim.claim_id,
                product_ref=claim.subject_ref,
                attribute_key=attribute_key,
                attribute_definition=proposal.attribute_definition or claim.attribute,
                value_type=value_type,
                value=value,
                unit=unit,
                qualifiers=proposal.qualifiers,
                evidence_ids=[claim.evidence_id] if claim.evidence_id else [],
                source_quote=quote,
                claim_status=ClaimStatus.SUPPORTED_BY_SOURCE if supported and verified else ClaimStatus.UNVERIFIED,
                extraction_status=ParseStatus.RESOLVED if verified else ParseStatus.AMBIGUOUS,
                conditions=proposal.conditions,
            )
        )
    return typed


def untyped_claims(claims: Sequence[ClaimDraft]) -> list[ProductAttributeClaim]:
    """Keep the research claims usable when no model typed them.

    The claim keeps the wording the source used. The calculator then treats it
    as a claim without a comparable value, so the result stays UNKNOWN rather
    than becoming a guess.
    """
    typed: list[ProductAttributeClaim] = []
    for claim in claims:
        typed.append(
            ProductAttributeClaim(
                claim_id=claim.claim_id,
                product_ref=claim.subject_ref,
                attribute_key=_canonical_attribute_key(claim.attribute),
                attribute_definition=claim.attribute,
                value_type=ValueType.STRING,
                value=claim.value,
                unit=claim.unit,
                evidence_ids=[claim.evidence_id] if claim.evidence_id else [],
                source_quote=claim.source_quote,
                claim_status=claim.status,
                extraction_status=ParseStatus.UNSUPPORTED,
            )
        )
    return typed


def numbers_in_quote(quote: str) -> list[str]:
    """Read the numbers a quotation states, for the report."""
    return [str(item.value) for item in quoted_numbers(quote)]


def plain_number_present(value: str, quote: str) -> bool:
    """Report whether a quotation states a plain number."""
    number = read_decimal(value)
    if number is None:
        return False
    return plain_number_is_quoted(number, quote)
