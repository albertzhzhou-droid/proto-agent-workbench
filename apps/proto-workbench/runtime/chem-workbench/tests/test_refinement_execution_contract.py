"""Pure tamper checks on the retained complex input; never scientific acceptance."""

import copy
import hashlib
import json
import sys
from pathlib import Path

import pytest

from chem_workbench.method_profiles import MASS_BOUND_PROFILE_ID, PROFILE_ID, get_method_profile
from chem_workbench.molecular_refinement import seal_refinement_spec
from chem_workbench.refinement_execution import execution_contract as contract
from chem_workbench.refinement_execution import optimizer_policy
from chem_workbench.visualization import content_hash

ROOT = Path(__file__).resolve().parents[1]
INPUT = ROOT / "tests/fixtures/refinement_evidence_product/input.json"
INPUT_SHA256 = "d6620a22961dde59508be55acaaaf8123d69852b41cdb2673ce65840fbaa733b"


def reseal(value, field):
    value[field] = content_hash({key: item for key, item in value.items() if key != field})
    return value


@pytest.fixture
def retained_request():
    raw = INPUT.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == INPUT_SHA256
    return json.loads(raw)


@pytest.fixture
def spec(retained_request):
    result = retained_request["spec"]
    assert len(result["geometry"]["atoms"]) == 34
    assert sum(atom["element"] != "H" for atom in result["geometry"]["atoms"]) == 19
    return result


@pytest.fixture
def optimization_spec(spec):
    spec = copy.deepcopy(spec)
    spec["optimizer_settings"]["maximum_iterations"] = 3
    spec["optimizer_settings"]["max_gradient_evaluations"] = 4
    del spec["spec_hash"]
    return seal_refinement_spec(spec)


def synthetic_binding(spec):
    """Construct policy-shaped fake observations for admission tests, never native evidence."""
    settings = spec["optimizer_settings"]
    actual = optimizer_policy.requested_options(settings)
    for requested, effective in optimizer_policy._CRITERIA.values():
        actual[effective] = actual.pop(requested)
    actual.update(optimizer_policy._FLAGS)
    actual["fixture_provenance"] = "synthetic parameter fixture; no native calls"
    return optimizer_policy.seal_binding(
        settings,
        actual,
        runtime_binding_hash=spec["runtime_binding"]["binding_hash"],
        observation_artifact={
            "path": "build/refinement-contract-staged-20260913/synthetic-observation.json",
            "sha256": "b" * 64,
        },
    )


def test_retained_gradient_request_has_a_distinct_sealed_envelope(spec, retained_request):
    original = copy.deepcopy(spec)
    value = contract.seal_execution_contract(spec, "gradient")
    assert set(value) == contract._CONTRACT_KEYS
    assert value["optimizer_binding"] is None
    assert value["dispatch"] == "psi4_qcengine_psiapi_v1"
    assert value["nested_program"] == "s-dftd3"
    assert value["nested_attempt_policy"] == "record_each_native_call_zero_retries"
    request = contract.build_worker_request(spec, value)
    assert request["version"] == "refinement-worker-request/v2"
    assert set(request) == {"version", "mode", "spec", "execution_contract"}
    assert contract.validate_worker_request(request) == request
    assert spec == original
    assert retained_request["version"] == "refinement-worker-request/v1"
    assert retained_request["spec"] == original


def test_valid_optimization_binding_binds_settings_runtime_and_final_reevaluation(
    optimization_spec,
):
    binding = synthetic_binding(optimization_spec)
    value = contract.seal_execution_contract(optimization_spec, "optimization", binding)
    request = contract.build_worker_request(optimization_spec, value)
    assert contract.validate_worker_request(request) == request
    assert value["optimizer_binding"]["final_accepted_geometry_reevaluation_required"] is True
    assert (
        value["optimizer_binding"]["runtime_binding_hash"]
        == optimization_spec["runtime_binding"]["binding_hash"]
    )
    assert (
        value["optimizer_binding"]["optimizer_settings"] == optimization_spec["optimizer_settings"]
    )
    assert "result" not in request and "state" not in request


def test_all_public_outputs_are_detached(optimization_spec):
    binding = synthetic_binding(optimization_spec)
    value = contract.seal_execution_contract(optimization_spec, "optimization", binding)
    checked = contract.validate_execution_contract(value, optimization_spec, "optimization")
    request = contract.build_worker_request(optimization_spec, value)
    validated = contract.validate_worker_request(request)
    binding["effective_native_parameters"]["intrafrag_trust"] = 0.2
    value["optimizer_binding"]["effective_native_parameters"]["intrafrag_trust"] = 0.3
    checked["optimizer_binding"]["effective_native_parameters"]["intrafrag_trust"] = 0.4
    request["spec"]["geometry"]["atoms"][0]["position"][0] = "900"
    assert (
        validated["execution_contract"]["optimizer_binding"]["effective_native_parameters"][
            "intrafrag_trust"
        ]
        == 0.5
    )
    assert optimization_spec["geometry"]["atoms"][0]["position"][0] != "900"


@pytest.mark.parametrize(
    "key,value",
    [
        ("version", "refinement-execution-contract/v2"),
        ("spec_hash", "sha256:" + "f" * 64),
        ("mode", "optimization"),
        ("dispatch", "psi4_qcengine_subprocess_v1"),
        ("nested_program", "dftd3"),
        ("nested_attempt_policy", "assume_one_call"),
    ],
)
def test_contract_tampering_is_rejected_even_after_self_rehash(spec, key, value):
    sealed = contract.seal_execution_contract(spec, "gradient")
    sealed[key] = value
    reseal(sealed, "contract_hash")
    with pytest.raises(ValueError):
        contract.validate_execution_contract(sealed, spec, "gradient")


@pytest.mark.parametrize("key", sorted(contract._CONTRACT_KEYS))
def test_every_contract_field_is_required(spec, key):
    sealed = contract.seal_execution_contract(spec, "gradient")
    del sealed[key]
    with pytest.raises(ValueError, match="missing or unexpected fields"):
        contract.validate_execution_contract(sealed, spec, "gradient")


def test_extra_contract_field_and_stale_hash_are_rejected(spec):
    sealed = contract.seal_execution_contract(spec, "gradient")
    sealed["backend_verified"] = True
    reseal(sealed, "contract_hash")
    with pytest.raises(ValueError, match="missing or unexpected fields"):
        contract.validate_execution_contract(sealed, spec, "gradient")
    del sealed["backend_verified"]
    with pytest.raises(ValueError, match="content mismatch"):
        contract.validate_execution_contract(sealed, spec, "gradient")


@pytest.mark.parametrize("mode", [None, True, 1, "", "hessian", [], {}])
def test_invalid_modes_rejected(spec, mode):
    with pytest.raises(ValueError):
        contract.seal_execution_contract(spec, mode)


def test_binding_mode_and_capacity_are_not_interchangeable(spec, optimization_spec):
    with pytest.raises(ValueError, match="no optimizer binding"):
        contract.seal_execution_contract(spec, "gradient", synthetic_binding(optimization_spec))
    with pytest.raises(ValueError):
        contract.seal_execution_contract(optimization_spec, "optimization")
    optimization_spec["optimizer_settings"]["max_gradient_evaluations"] = 1
    reseal(optimization_spec, "spec_hash")
    with pytest.raises(ValueError, match="initial and final gradient capacity"):
        contract.seal_execution_contract(
            optimization_spec, "optimization", synthetic_binding(optimization_spec)
        )


@pytest.mark.parametrize(
    "key,value",
    [
        ("runtime_binding_hash", "sha256:" + "f" * 64),
        ("policy_id", "optking.cartesian.simple.v1"),
        ("final_accepted_geometry_reevaluation_required", False),
        ("final_accepted_geometry_reevaluation_required", 1),
        ("mutable_native_parameters", ["intrafrag_trust", "interfrag_trust", "linesearch"]),
        ("observation_artifact", {"path": "../outside.json", "sha256": "a" * 64}),
        ("observation_artifact", {"path": "build/CON.json", "sha256": "a" * 64}),
        ("observation_artifact", {"path": "build/file .json ", "sha256": "a" * 64}),
    ],
)
def test_binding_tampering_rejected_even_after_self_rehash(optimization_spec, key, value):
    binding = synthetic_binding(optimization_spec)
    binding[key] = value
    reseal(binding, "binding_hash")
    with pytest.raises(ValueError):
        contract.seal_execution_contract(optimization_spec, "optimization", binding)


def test_optimizer_settings_and_actual_native_parameter_drift_rejected(optimization_spec):
    binding = synthetic_binding(optimization_spec)
    binding["optimizer_settings"]["maximum_iterations"] = 4
    reseal(binding, "binding_hash")
    with pytest.raises(ValueError):
        contract.seal_execution_contract(optimization_spec, "optimization", binding)
    binding = synthetic_binding(optimization_spec)
    binding["effective_native_parameters"]["intrafrag_hess"] = "simple"
    reseal(binding, "binding_hash")
    with pytest.raises(ValueError):
        contract.seal_execution_contract(optimization_spec, "optimization", binding)


@pytest.mark.parametrize(
    "change",
    [
        "legacy_spec",
        "different_profile",
        "driver_missing",
        "driver_bool",
        "driver_engine",
        "retry_requested",
        "retry_effective",
    ],
)
def test_unsupported_or_tampered_spec_is_not_admitted(spec, change):
    if change == "legacy_spec":
        spec["version"] = "molecular-refinement-spec/v1"
    elif change == "different_profile":
        spec["profile"] = get_method_profile(MASS_BOUND_PROFILE_ID)
        keywords = spec["electronic_settings"]["native_keywords"]
        keywords.pop("puream")
        keywords["dft_vv10_radial_points"] = 99
        keywords["dft_vv10_spherical_points"] = 590
        keywords["function_kwargs"] = {"dertype": 1}
    elif change == "driver_missing":
        del spec["electronic_settings"]["native_keywords"]["function_kwargs"]
    elif change == "driver_bool":
        spec["electronic_settings"]["native_keywords"]["function_kwargs"]["dertype"] = True
    elif change == "driver_engine":
        spec["electronic_settings"]["native_keywords"]["function_kwargs"]["engine"] = "dftd3"
    else:
        key = "requested_retries" if change == "retry_requested" else "effective_retries"
        spec["resources"]["backend_retry_policy"][key] = 1
    reseal(spec, "spec_hash")
    with pytest.raises(ValueError):
        contract.seal_execution_contract(spec, "gradient")


def test_valid_v2_spec_change_stales_existing_contract(spec):
    sealed = contract.seal_execution_contract(spec, "gradient")
    spec["resources"]["wall_seconds"] += 1
    reseal(spec, "spec_hash")
    with pytest.raises(ValueError, match="policy or context"):
        contract.validate_execution_contract(sealed, spec, "gradient")


def test_independently_valid_legacy_spec_remains_outside_new_contract(spec):
    spec["version"] = "molecular-refinement-spec/v1"
    spec["profile"] = get_method_profile(PROFILE_ID)
    del spec["isotope_binding"]
    keywords = spec["electronic_settings"]["native_keywords"]
    del keywords["puream"]
    keywords["dft_vv10_radial_points"] = 99
    keywords["dft_vv10_spherical_points"] = 590
    keywords["function_kwargs"] = {"dertype": 1}
    del spec["spec_hash"]
    legacy_spec = seal_refinement_spec(spec)
    with pytest.raises(ValueError, match="mass-bound D3BJ spec v2"):
        contract.seal_execution_contract(legacy_spec, "gradient")


def test_exact_initial_plus_final_capacity_is_admitted(optimization_spec):
    optimization_spec["optimizer_settings"]["max_gradient_evaluations"] = 2
    reseal(optimization_spec, "spec_hash")
    value = contract.seal_execution_contract(
        optimization_spec, "optimization", synthetic_binding(optimization_spec)
    )
    assert contract.validate_execution_contract(value, optimization_spec, "optimization") == value


@pytest.mark.parametrize("field", ["version", "mode", "spec", "execution_contract"])
def test_worker_request_fields_required(spec, field):
    request = contract.build_worker_request(
        spec, contract.seal_execution_contract(spec, "gradient")
    )
    del request[field]
    with pytest.raises(ValueError):
        contract.validate_worker_request(request)


@pytest.mark.parametrize("change", ["extra", "version", "mode", "spec", "contract"])
def test_worker_request_context_tampering_rejected(spec, change):
    request = contract.build_worker_request(
        spec, contract.seal_execution_contract(spec, "gradient")
    )
    if change == "extra":
        request["verified"] = True
    elif change == "version":
        request["version"] = "refinement-worker-request/v1"
    elif change == "mode":
        request["mode"] = "optimization"
    elif change == "spec":
        request["spec"]["resources"]["wall_seconds"] += 1
        reseal(request["spec"], "spec_hash")
    else:
        request["execution_contract"]["spec_hash"] = "sha256:" + "a" * 64
        reseal(request["execution_contract"], "contract_hash")
    with pytest.raises(ValueError):
        contract.validate_worker_request(request)


def test_legacy_request_is_not_upgraded_implicitly(retained_request):
    with pytest.raises(ValueError):
        contract.validate_worker_request(retained_request)
    assert hashlib.sha256(INPUT.read_bytes()).hexdigest() == INPUT_SHA256


@pytest.mark.parametrize(
    "bad",
    [
        None,
        [],
        0,
        "{}",
        {1: "wrong"},
        {"a": float("nan")},
        {"a": float("inf")},
        {"a": (1, 2)},
        {"a": object()},
    ],
)
def test_non_json_or_non_object_inputs_rejected(bad):
    with pytest.raises(ValueError):
        contract.validate_worker_request(bad)


def test_deep_or_large_json_rejected_before_validation(monkeypatch):
    root = {}
    child = root
    for _ in range(130):
        child["next"] = {}
        child = child["next"]
    with pytest.raises(ValueError, match="depth"):
        contract.validate_worker_request(root)
    monkeypatch.setattr(contract, "MAX_RECORD_BYTES", 10)
    with pytest.raises(ValueError, match="20 MiB"):
        contract.validate_worker_request({"too_long": "payload"})


def test_pure_module_has_no_native_imports_or_completion_claims(spec):
    assert not {"psi4", "dftd3", "qcengine", "qcelemental", "optking"}.intersection(sys.modules)
    result = contract.seal_execution_contract(spec, "gradient")
    assert not {
        "success",
        "converged",
        "minimum_status",
        "scientific_validation",
        "observed_attempts",
    }.intersection(result)
