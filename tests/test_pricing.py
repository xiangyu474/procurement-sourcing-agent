"""Tests for the M3-B price comparability and the price analysis."""

from __future__ import annotations

from procurement_agent.domain.pricing import (
    ComparabilityReason,
    ComparabilityStatus,
    PriceBasis,
    PriceObservation,
)
from procurement_agent.domain.requirements import TaxBasis
from procurement_agent.services.price_analysis import analyze_prices, compare_prices


def observation(**overrides) -> PriceObservation:
    fields = {
        "observation_id": "obs1",
        "price_basis": PriceBasis.HISTORICAL_TRANSACTION,
        "value": "100",
        "currency": "CNY",
        "unit": "元/套",
        "tax_basis": TaxBasis.EXCLUSIVE,
    }
    fields.update(overrides)
    return PriceObservation(**fields)


# --- comparability ----------------------------------------------------------


def test_two_prices_of_the_same_basis_compare():
    comparison = compare_prices(observation(), observation(observation_id="obs2", value="120"))
    assert comparison.status == ComparabilityStatus.COMPARABLE
    assert comparison.difference == "-20"
    assert comparison.difference_percent is not None


def test_a_budget_and_a_transaction_compare():
    """The budget against the past is a question a buyer asks."""
    comparison = compare_prices(
        observation(observation_id="b", price_basis=PriceBasis.PLANNED_BUDGET),
        observation(observation_id="t", price_basis=PriceBasis.HISTORICAL_TRANSACTION),
    )
    assert comparison.status == ComparabilityStatus.COMPARABLE
    assert comparison.difference == "0"


def test_a_budget_and_a_public_listing_do_not_compare():
    """A listing somebody posted is not an offer, so it never saves money."""
    comparison = compare_prices(
        observation(observation_id="b", price_basis=PriceBasis.PLANNED_BUDGET),
        observation(observation_id="p", price_basis=PriceBasis.PUBLIC_REFERENCE),
    )
    assert comparison.status == ComparabilityStatus.NOT_COMPARABLE
    assert ComparabilityReason.DIFFERENT_BASIS in comparison.reasons
    assert comparison.difference is None


def test_a_budget_and_a_quotation_compare():
    comparison = compare_prices(
        observation(observation_id="b", price_basis=PriceBasis.PLANNED_BUDGET, value="100"),
        observation(observation_id="q", price_basis=PriceBasis.FORMAL_QUOTATION, value="90"),
    )
    assert comparison.status == ComparabilityStatus.COMPARABLE
    assert comparison.difference == "10"


def test_a_public_listing_and_a_quotation_do_not_compare():
    comparison = compare_prices(
        observation(observation_id="p", price_basis=PriceBasis.PUBLIC_REFERENCE),
        observation(observation_id="q", price_basis=PriceBasis.FORMAL_QUOTATION),
    )
    assert comparison.status == ComparabilityStatus.NOT_COMPARABLE
    assert ComparabilityReason.DIFFERENT_BASIS in comparison.reasons


def test_a_tax_basis_mismatch_does_not_compare():
    comparison = compare_prices(
        observation(observation_id="a", tax_basis=TaxBasis.INCLUSIVE),
        observation(observation_id="b", tax_basis=TaxBasis.EXCLUSIVE),
    )
    assert ComparabilityReason.TAX_BASIS_MISMATCH in comparison.reasons


def test_an_unknown_tax_basis_does_not_compare():
    comparison = compare_prices(
        observation(observation_id="a", tax_basis=TaxBasis.UNKNOWN),
        observation(observation_id="b", tax_basis=TaxBasis.EXCLUSIVE),
    )
    assert ComparabilityReason.UNKNOWN_TAX_BASIS in comparison.reasons


def test_a_currency_mismatch_does_not_compare():
    comparison = compare_prices(
        observation(observation_id="a", currency="USD"),
        observation(observation_id="b", currency="CNY"),
    )
    assert ComparabilityReason.CURRENCY_MISMATCH in comparison.reasons


def test_a_unit_mismatch_does_not_compare():
    comparison = compare_prices(
        observation(observation_id="a", unit="元/套"),
        observation(observation_id="b", unit="元/台"),
    )
    assert ComparabilityReason.UNIT_MISMATCH in comparison.reasons


def test_a_missing_unit_does_not_compare():
    comparison = compare_prices(
        observation(observation_id="a", unit=None),
        observation(observation_id="b", unit="元/套"),
    )
    assert ComparabilityReason.UNKNOWN_UNIT in comparison.reasons


# --- the analysis -----------------------------------------------------------


def test_incomparable_prices_yield_no_saving():
    """The acceptance case: a listing and a budget must not produce a saving."""
    finding = analyze_prices(
        requirement_id="r1",
        observations=[
            observation(observation_id="listing", price_basis=PriceBasis.PUBLIC_REFERENCE, value="90"),
            observation(observation_id="quote", price_basis=PriceBasis.FORMAL_QUOTATION, value="95"),
        ],
        budget=observation(
            observation_id="budget",
            price_basis=PriceBasis.PLANNED_BUDGET,
            value="100",
        ),
    )
    assert finding.comparability == ComparabilityStatus.NOT_COMPARABLE
    assert finding.lowest_value is None
    assert finding.saving is None
    assert finding.saving_percent is None
    assert set(finding.excluded_observation_ids) == {"listing", "quote"}


def test_comparable_prices_report_the_lowest_and_the_saving():
    finding = analyze_prices(
        requirement_id="r1",
        observations=[
            observation(observation_id="a", price_basis=PriceBasis.FORMAL_QUOTATION, value="95"),
            observation(observation_id="b", price_basis=PriceBasis.FORMAL_QUOTATION, value="90"),
        ],
        budget=observation(
            observation_id="budget",
            price_basis=PriceBasis.FORMAL_QUOTATION,
            value="100",
        ),
    )
    assert finding.comparability == ComparabilityStatus.COMPARABLE
    assert finding.lowest_observation_id == "b"
    assert finding.lowest_value == "90"
    assert finding.saving == "10"
    assert finding.saving_percent == "10"


def test_a_quotation_against_a_budget_reports_the_saving():
    finding = analyze_prices(
        requirement_id="r1",
        observations=[observation(observation_id="a", price_basis=PriceBasis.FORMAL_QUOTATION, value="90")],
        budget=observation(
            observation_id="budget",
            price_basis=PriceBasis.PLANNED_BUDGET,
            value="100",
        ),
    )
    assert finding.lowest_value == "90"
    assert finding.saving == "10"
    assert finding.saving_percent == "10"


def test_a_listing_against_a_budget_gives_no_saving():
    finding = analyze_prices(
        requirement_id="r1",
        observations=[observation(observation_id="a", price_basis=PriceBasis.PUBLIC_REFERENCE, value="90")],
        budget=observation(
            observation_id="budget",
            price_basis=PriceBasis.PLANNED_BUDGET,
            value="100",
        ),
    )
    assert finding.lowest_value == "90"
    assert finding.saving is None
    assert "no saving is reported" in finding.explanation


def test_no_price_at_all_yields_nothing():
    finding = analyze_prices(requirement_id="r1", observations=[])
    assert finding.comparability == ComparabilityStatus.NOT_COMPARABLE
    assert finding.lowest_value is None
    assert finding.saving is None


def test_a_set_that_mixes_bases_gives_no_lowest_price():
    """The cheapest number of a mixed set is not a price a buyer can act on."""
    finding = analyze_prices(
        requirement_id="r1",
        observations=[
            observation(observation_id="a", price_basis=PriceBasis.HISTORICAL_TRANSACTION, value="80"),
            observation(observation_id="b", price_basis=PriceBasis.HISTORICAL_TRANSACTION, value="90"),
            observation(observation_id="c", price_basis=PriceBasis.PUBLIC_REFERENCE, value="70"),
        ],
    )
    assert finding.comparability == ComparabilityStatus.NOT_COMPARABLE
    assert finding.lowest_value is None
    assert finding.saving is None
    assert set(finding.excluded_observation_ids) == {"a", "b", "c"}


def test_one_series_on_one_basis_reports_its_lowest():
    finding = analyze_prices(
        requirement_id="r1",
        observations=[
            observation(observation_id="a", price_basis=PriceBasis.HISTORICAL_TRANSACTION, value="80"),
            observation(observation_id="b", price_basis=PriceBasis.HISTORICAL_TRANSACTION, value="90"),
        ],
    )
    assert finding.comparability == ComparabilityStatus.COMPARABLE
    assert finding.lowest_observation_id == "a"
    assert finding.excluded_observation_ids == []


def test_a_price_must_be_a_decimal_string():
    with __import__("pytest").raises(Exception):
        observation(value="not a number")
