"""The same company must be told apart from the many names it is found under."""

from __future__ import annotations

from procurement_agent.domain.supplier_identity import (
    group_by_supplier,
    merge_supplier_names,
    same_supplier,
    supplier_key,
)


def test_the_variants_of_one_company_are_one_supplier() -> None:
    variants = [
        "Bosch",
        "Bosch Security Systems B.V.",
        "boschsecurity.com",
        "www.boschsecurity.com",
        "Bosch Security ( Cctv ) Systems",
    ]
    for name in variants[1:]:
        assert same_supplier(variants[0], name), name
    assert supplier_key("Bosch") == supplier_key("Bosch Security Systems B.V.")


def test_different_companies_stay_apart() -> None:
    assert not same_supplier("Bosch", "Sony")
    assert not same_supplier("Hikvision", "Hanwha Vision")
    assert not same_supplier("Bosch Security", "Boschmann")


def test_rows_of_one_company_are_grouped() -> None:
    rows = [
        {"supplier_name": "Bosch", "id": "1"},
        {"supplier_name": "Bosch Security Systems B.V.", "id": "2"},
        {"supplier_name": "Sony", "id": "3"},
        {"supplier_name": "boschsecurity.com", "id": "4"},
    ]
    groups = group_by_supplier(rows)
    assert len(groups) == 2
    assert sorted(len(group) for group in groups) == [1, 3]
    assert merge_supplier_names([row["supplier_name"] for row in groups[0] if row["supplier_name"].startswith("Bosch")]) == "Bosch"


def test_an_empty_name_stands_alone() -> None:
    assert not same_supplier("", "Bosch")
    assert supplier_key("") == ""
