"""Pure checks using a retained native parameter snapshot, never scientific acceptance."""

import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from chem_workbench.refinement_execution import optimizer_policy as policy

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def native_snapshot():
    receipt = json.loads(
        (ROOT / "tests/fixtures/refinement_execution/synthetic_optimizer_receipt.json").read_text(
            encoding="utf-8"
        )
    )
    observation = receipt["native_parameters"][0]
    return {**observation["effective"], **observation["active_criteria"]}


@pytest.fixture
def settings():
    return {
        "engine": "optking",
        "coordinates": "cartesian",
        "flexible_g_convergence": False,
        "maximum_iterations": 3,
        "max_gradient_evaluations": 4,
        "criteria": {key: "0.00000000000001" for key in policy._CRITERIA},
    }


def seal(settings, native_snapshot):
    return policy.seal_binding(
        settings,
        native_snapshot,
        runtime_binding_hash="sha256:" + "a" * 64,
        observation_artifact={"path": "build/observed.json", "sha256": "b" * 64},
    )


def test_explicit_lindh_matches_retained_effective_native_options(settings, native_snapshot):
    requested = policy.requested_options(settings)
    assert requested["intrafrag_hess"] == "lindh"
    assert requested["h_guess_every"] is False
    binding = seal(settings, native_snapshot)
    assert binding["effective_native_parameters"] == native_snapshot
    assert policy.validate_binding(binding, settings, "sha256:" + "a" * 64) == binding
    assert binding["final_accepted_geometry_reevaluation_required"] is True


@pytest.mark.parametrize(
    "key,value",
    [
        ("intrafrag_hess", "SIMPLE"),
        ("h_guess_every", True),
        ("conv_max_force", 1e-6),
        ("conv_rms_force", 1e-6),
        ("conv_max_disp", 1e-6),
        ("conv_rms_disp", 1e-6),
        ("_i_rms_disp", False),
        ("_i_max_DE", True),
        ("_i_untampered", True),
        ("flexible_g_convergence", 0),
        ("dynamic_level", True),
        ("dynamic_lvl_max", 1),
        ("intrafrag_trust", 0.2),
        ("intrafrag_trust_min", 0.002),
        ("full_hess_every", 0),
        ("cart_hess_read", True),
        ("alg_geom_maxiter", 50),
        ("hess_update", "BOFILL"),
    ],
)
def test_effective_option_drift_rejected_before_any_evaluation(
    settings, native_snapshot, key, value
):
    native_snapshot[key] = value
    with pytest.raises(ValueError, match="APPROVAL_STALE"):
        seal(settings, native_snapshot)


def test_observer_checks_attributes_against_serialized_convergence_flags(native_snapshot):
    params = SimpleNamespace(**{key: native_snapshot[key] for key in policy._FLAGS})
    params.to_dict = lambda *, by_alias: native_snapshot
    observed = policy.observe_parameters(params)
    observed["intrafrag_trust"] = 0.2
    assert native_snapshot["intrafrag_trust"] == 0.5
    params._i_rms_force = False
    with pytest.raises(ValueError, match="serialization differs"):
        policy.observe_parameters(params)


def test_binding_is_detached_and_exact_default_inventory_is_bound(settings, native_snapshot):
    binding = seal(settings, native_snapshot)
    native_snapshot["rfo_root"] = 2
    settings["criteria"]["max_force_hartree_per_bohr"] = "0.5"
    assert binding["effective_native_parameters"]["rfo_root"] == 0
    assert (
        binding["optimizer_settings"]["criteria"]["max_force_hartree_per_bohr"]
        == "0.00000000000001"
    )
    original_settings = binding["optimizer_settings"]
    binding["effective_native_parameters"]["rfo_root"] = 2
    with pytest.raises(ValueError, match="binding differs"):
        policy.validate_binding(binding, original_settings, "sha256:" + "a" * 64)


@pytest.mark.parametrize("path", [Path("."), Path("retained inputs") / "hessian.dat"])
def test_live_native_path_has_explicit_lossless_json_projection(native_snapshot, path):
    native_snapshot["hessian_file"] = path
    params = SimpleNamespace(**{key: native_snapshot[key] for key in policy._FLAGS})
    params.to_dict = lambda *, by_alias: native_snapshot
    observed = policy.observe_parameters(params)
    assert observed["hessian_file"] == str(path)
    assert native_snapshot["hessian_file"] is path


@pytest.mark.parametrize("key,value", [("hessian_file", object()), ("unknown_path", Path("."))])
def test_unrecognized_native_object_is_not_silently_stringified(native_snapshot, key, value):
    native_snapshot[key] = value
    params = SimpleNamespace(**{key: native_snapshot[key] for key in policy._FLAGS})
    params.to_dict = lambda *, by_alias: native_snapshot
    with pytest.raises(TypeError, match="not JSON serializable"):
        policy.observe_parameters(params)


def test_trust_adaptation_within_bound_limits_is_retained_without_admitting_other_changes(
    settings, native_snapshot
):
    binding = seal(settings, native_snapshot)
    native_snapshot["intrafrag_trust"] = 0.25
    policy.verify_step_parameters(binding, native_snapshot)
    native_snapshot["rfo_root"] = 1
    with pytest.raises(ValueError, match="parameter changed"):
        policy.verify_step_parameters(binding, native_snapshot)


@pytest.mark.parametrize("value", [0.0001, 1.1, float("nan"), float("inf"), True, "0.5"])
def test_invalid_runtime_trust_value_rejected(settings, native_snapshot, value):
    binding = seal(settings, native_snapshot)
    native_snapshot["intrafrag_trust"] = value
    with pytest.raises(ValueError, match="trust radius"):
        policy.verify_step_parameters(binding, native_snapshot)


def test_missing_new_or_nested_mutated_native_settings_rejected(settings, native_snapshot):
    binding = seal(settings, native_snapshot)
    altered = copy.deepcopy(native_snapshot)
    del altered["linesearch"]
    with pytest.raises(ValueError, match="inventory changed"):
        policy.verify_step_parameters(binding, altered)
    altered = copy.deepcopy(native_snapshot)
    altered["frag_ref_atoms"].append([1, 2, 3])
    with pytest.raises(ValueError, match="parameter changed"):
        policy.verify_step_parameters(binding, altered)


@pytest.mark.parametrize("value", ["1e-999", "NaN", "Infinity", "0", "-0.001", "2", 1e-14])
def test_unusable_thresholds_never_reach_native_request(settings, value):
    settings["criteria"]["max_force_hartree_per_bohr"] = value
    with pytest.raises(ValueError):
        policy.requested_options(settings)


def test_policy_does_not_certify_convergence_from_parameters(settings, native_snapshot):
    binding = seal(settings, native_snapshot)
    assert "reported_converged" not in binding and "minimum_status" not in binding
    assert "final_accepted_geometry_reevaluation_required" in binding
