"""Synthetic contract checks only; no electronic calculations."""

import pytest
from test_molecular_refinement import _spec, _without

from chem_workbench.molecular_refinement import seal_refinement_spec


def direct_body():
    body = _without(_spec(), "spec_hash")
    body["electronic_settings"]["native_keywords"].update(
        scf_type="direct", ints_tolerance=1e-12, df_scf_guess=False
    )
    return body


def test_direct_is_explicitly_bound_with_screening_and_without_df_guess():
    body = direct_body()
    direct = seal_refinement_spec(body)
    assert direct["spec_hash"] != _spec()["spec_hash"]
    assert direct["electronic_settings"]["native_keywords"]["scf_type"] == "direct"


@pytest.mark.parametrize("value", [True, 0, -1, 1e-8, float("inf"), float("nan"), "1e-12"])
def test_direct_rejects_unbound_or_loose_integral_screening(value):
    body = direct_body()
    body["electronic_settings"]["native_keywords"]["ints_tolerance"] = value
    with pytest.raises(ValueError):
        seal_refinement_spec(body)


@pytest.mark.parametrize("value", [True, 0, None, "false"])
def test_direct_requires_exact_false_for_df_preconvergence(value):
    body = direct_body()
    body["electronic_settings"]["native_keywords"]["df_scf_guess"] = value
    with pytest.raises(ValueError):
        seal_refinement_spec(body)


@pytest.mark.parametrize("key", ["ints_tolerance", "df_scf_guess"])
def test_direct_rejects_missing_explicit_parameter(key):
    body = direct_body()
    del body["electronic_settings"]["native_keywords"][key]
    with pytest.raises(ValueError):
        seal_refinement_spec(body)


@pytest.mark.parametrize("value", [True, False, 0, 2, -1, "1", None])
def test_driver_cannot_silently_request_a_different_derivative_strategy(value):
    body = direct_body()
    body["electronic_settings"]["native_keywords"]["function_kwargs"] = {"dertype": value}
    with pytest.raises(ValueError):
        seal_refinement_spec(body)


def test_driver_rejects_extra_function_arguments():
    body = direct_body()
    body["electronic_settings"]["native_keywords"]["function_kwargs"] = {
        "dertype": 1,
        "return_wfn": False,
    }
    with pytest.raises(ValueError):
        seal_refinement_spec(body)
