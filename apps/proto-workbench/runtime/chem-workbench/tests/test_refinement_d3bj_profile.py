"""Pure named-profile checks using a retained complex geometry; no calculations."""

import copy

import pytest
from test_refinement_isotopes import mass_bound_spec_body

from chem_workbench.method_profiles import (
    D3BJ_PROFILE_ID,
    MASS_BOUND_PROFILE_ID,
    get_method_profile,
    gradient_driver_arguments,
)
from chem_workbench.molecular_refinement import seal_refinement_spec
from chem_workbench.visualization import content_hash


def d3_body():
    body = mass_bound_spec_body()
    body["profile"] = get_method_profile(D3BJ_PROFILE_ID)
    keywords = body["electronic_settings"]["native_keywords"]
    keywords.pop("dft_vv10_radial_points")
    keywords.pop("dft_vv10_spherical_points")
    keywords["function_kwargs"] = gradient_driver_arguments(body["profile"])
    keywords["puream"] = True
    return body


def test_named_counterpart_remains_distinct_and_unvalidated():
    body = d3_body()
    spec = seal_refinement_spec(body)
    original = get_method_profile(MASS_BOUND_PROFILE_ID)
    assert spec["profile"]["profile_hash"] != original["profile_hash"]
    assert spec["profile"]["method"] == "wb97x-d3bj"
    assert original["method"] == "wb97x-v"
    assert spec["profile"]["backend_verified"] is False
    assert spec["profile"]["dispersion"]["parameters"]["s9"] == "0"
    assert spec["profile"]["dispersion"]["nonlocal_correlation"] is False
    assert len(spec["geometry"]["atoms"]) == 34


@pytest.mark.parametrize(
    "driver",
    [
        None,
        {"dertype": 1},
        {"dertype": 1, "engine": "dftd3"},
        {"dertype": True, "engine": "s-dftd3"},
        {"dertype": 0, "engine": "s-dftd3"},
        {"dertype": 1, "engine": "s-dftd3", "unknown": True},
    ],
)
def test_no_implicit_dispersion_backend_or_derivative_fallback(driver):
    body = d3_body()
    if driver is None:
        body["electronic_settings"]["native_keywords"].pop("function_kwargs")
    else:
        body["electronic_settings"]["native_keywords"]["function_kwargs"] = driver
    with pytest.raises(ValueError):
        seal_refinement_spec(body)


@pytest.mark.parametrize("value", [False, 1, "true", None])
def test_spherical_basis_flag_is_explicit_and_typed(value):
    body = d3_body()
    body["electronic_settings"]["native_keywords"]["puream"] = value
    with pytest.raises(ValueError):
        seal_refinement_spec(body)


def test_unused_vv10_grid_cannot_appear_as_effective_d3bj_configuration():
    body = d3_body()
    body["electronic_settings"]["native_keywords"]["dft_vv10_radial_points"] = 99
    with pytest.raises(ValueError):
        seal_refinement_spec(body)


def test_resealing_a_changed_dispersion_parameter_does_not_register_a_method():
    body = d3_body()
    profile = copy.deepcopy(body["profile"])
    profile.pop("profile_hash")
    profile["dispersion"]["parameters"]["s9"] = "1"
    body["profile"] = {**profile, "profile_hash": content_hash(profile)}
    with pytest.raises(ValueError, match="descriptor"):
        seal_refinement_spec(body)
