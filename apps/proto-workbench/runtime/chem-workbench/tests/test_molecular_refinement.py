"""Pure contract tests for molecular refinement records.

All coordinates, energies, gradients, package versions and byte references below
are deliberately synthetic structural fixtures. They are not molecular examples,
observed calculations, physical reference values, or backend availability evidence.
"""

from __future__ import annotations

import copy
import hashlib
import json
from decimal import Decimal

import pytest

from chem_workbench import method_profiles as profiles
from chem_workbench import molecular_refinement as refinement
from chem_workbench.chemir.constraints import canonical_decimal
from chem_workbench.visualization import content_hash


def _hashed(body, field):
    return {**body, field: content_hash(body)}


def _without(record, field):
    return copy.deepcopy({key: value for key, value in record.items() if key != field})


def _reference(path, text="synthetic fixture only"):
    return {"path": path, "sha256": hashlib.sha256(text.encode()).hexdigest()}


def _geometry(shift="0", different_composition=False):
    atoms = [
        {
            "id": f"atom{index}",
            "element": "N" if different_composition and index >= 6 else "C",
            "position": [canonical_decimal(str(Decimal(index) + Decimal(shift))), "0", "0"],
        }
        for index in range(8)
    ]
    return refinement.seal_refinement_geometry(
        {
            "version": "refinement-geometry/v1",
            "units": "angstrom",
            "charge": 0,
            "multiplicity": 1,
            "atoms": atoms,
        }
    )


def _spec(geometry=None):
    geometry = geometry or _geometry()
    return refinement.seal_refinement_spec(
        {
            "version": refinement.SPEC_VERSION,
            "profile": profiles.get_method_profile(profiles.PROFILE_ID),
            "source_binding": {
                "kind": "candidate_geometry",
                "source_hash": content_hash("synthetic source"),
                "candidate_hash": content_hash("synthetic candidate"),
                "atom_identity_hash": content_hash(
                    [[atom["id"], atom["element"]] for atom in geometry["atoms"]]
                ),
                "geometry_hash": geometry["geometry_hash"],
                "artifact": _reference("fixture/source.json"),
            },
            "geometry": geometry,
            "electronic_settings": {
                "native_keywords": {
                    "reference": "rks",
                    "scf_type": "pk",
                    "e_convergence": 1e-8,
                    "d_convergence": 1e-8,
                    "maxiter": 100,
                    "fail_on_maxiter": True,
                    "dft_radial_points": 99,
                    "dft_spherical_points": 590,
                    "dft_pruning_scheme": "robust",
                    "dft_vv10_radial_points": 99,
                    "dft_vv10_spherical_points": 590,
                    "dft_density_tolerance": 1e-12,
                },
                "functional_definition_hash": content_hash(
                    "synthetic definition; no availability claim"
                ),
                "effective_options_artifact": _reference("fixture/effective-options.json"),
            },
            "optimizer_settings": {
                "engine": "optking",
                "coordinates": "cartesian",
                "flexible_g_convergence": False,
                "maximum_iterations": 100,
                "max_gradient_evaluations": 150,
                "criteria": {
                    "max_force_hartree_per_bohr": "0.000015",
                    "rms_force_hartree_per_bohr": "0.00001",
                    "max_displacement_bohr": "0.00006",
                    "rms_displacement_bohr": "0.00004",
                },
            },
            "environment": {
                "boundary": "isolated",
                "phase": "gas",
                "solvent": None,
                "physical_temperature_kelvin": None,
            },
            "runtime_binding": _hashed(
                {
                    "version": "refinement-runtime-binding/v1",
                    "engine": "psi4",
                    "versions": {
                        key: "synthetic-not-a-runtime"
                        for key in ("python", "psi4", "optking", "qcengine", "qcelemental", "libxc")
                    },
                    "files": [_reference("fixture/runtime-manifest.json")],
                },
                "binding_hash",
            ),
            "basis_binding": _hashed(
                {
                    "version": "refinement-basis-binding/v1",
                    "basis": "def2-tzvppd",
                    "elements": list(profiles.ELEMENT_NUMBERS),
                    "files": [_reference("fixture/basis.gbs")],
                },
                "binding_hash",
            ),
            "resources": {
                "wall_seconds": 600,
                "memory_bytes": 3 * 1024**3,
                "cpu_seconds": 600,
                "threads": 1,
                "max_output_bytes": 10000000,
                "backend_retry_policy": {
                    "requested_retries": 0,
                    "effective_retries": 2,
                    "accounting": "observe_every_backend_attempt",
                },
            },
        }
    )


def _artifact(inventory, identity, role, text):
    inventory.append(
        {"artifact_id": identity, "role": role, **_reference("fixture/" + identity + ".json", text)}
    )
    return identity


def _frame(spec, geometry, index, inventory, gradient="0", attribution=True):
    raw_input = {
        "schema_name": "qcschema_input",
        "schema_version": 1,
        "driver": "gradient",
        "model": {"method": "wb97x-v", "basis": "def2-tzvppd"},
        "keywords": spec["electronic_settings"]["native_keywords"],
        "molecule": {
            "symbols": [atom["element"] for atom in geometry["atoms"]],
            "atom_labels": [atom["id"] for atom in geometry["atoms"]],
            "molecular_charge": 0,
            "molecular_multiplicity": 1,
            "fix_com": True,
            "fix_orientation": True,
            "geometry": [
                float(Decimal(part) * Decimal(profiles.ANGSTROM_TO_BOHR))
                for atom in geometry["atoms"]
                for part in atom["position"]
            ],
        },
    }
    energy = "-100" if index == 0 else "-100.01"
    gradients = [[gradient, "0", "0"] for _ in geometry["atoms"]]
    raw_result = {
        **copy.deepcopy(raw_input),
        "schema_name": "qcschema_output",
        "success": True,
        "properties": {"return_energy": float(energy)},
        "return_result": [[float(value) for value in row] for row in gradients],
        "provenance": {"creator": "Psi4", "version": "synthetic-not-a-runtime"},
    }
    input_text, result_text = json.dumps(raw_input), json.dumps(raw_result)
    return refinement.seal_refinement_frame(
        {
            "version": refinement.FRAME_VERSION,
            "evaluation_index": index,
            "optimizer_iteration": index if attribution else None,
            "step_status": ("initial" if index == 0 else "accepted") if attribution else "unknown",
            "reevaluates_frame_hash": None,
            "geometry": geometry,
            "energy_hartree": energy,
            "gradient_hartree_per_bohr": gradients,
            "elapsed_wall_seconds": str(index + 1),
            "physical_time_s": None,
            "raw_input_json": input_text,
            "raw_result_json": result_text,
            "raw_input_artifact_id": _artifact(
                inventory, f"input{index}", "atomic_input", input_text
            ),
            "raw_result_artifact_id": _artifact(
                inventory, f"result{index}", "atomic_result", result_text
            ),
        }
    )


def _body(spec, gradient="0", attribution=True):
    inventory = []
    frames = [
        _frame(spec, spec["geometry"], 0, inventory, attribution=attribution),
        _frame(spec, _geometry("0.000001"), 1, inventory, gradient, attribution),
    ]
    status = ("satisfied" if gradient == "0" else "not_satisfied") if attribution else "not_checked"
    return _assemble_body(spec, frames, inventory, status, attribution)


def _assemble_body(spec, frames, inventory, status, attribution=True):
    for index in range(len(frames)):
        _artifact(
            inventory, f"attempt{index}", "backend_attempt", "synthetic attempt " + str(index)
        )
    body = {
        "version": refinement.RESULT_VERSION,
        "spec_hash": spec["spec_hash"],
        "state": "succeeded" if status == "satisfied" and attribution else "incomplete",
        "evidence_origin": "synthetic_validation",
        "runtime_binding_hash": spec["runtime_binding"]["binding_hash"],
        "basis_binding_hash": spec["basis_binding"]["binding_hash"],
        "trajectory": frames,
        "final_frame_hash": frames[-1]["frame_hash"],
        "convergence": {
            "geometry_status": status,
            "minimum_status": "not_evaluated",
            "optimizer_reported_converged": True if attribution else None,
            "optimizer_observation_json": None,
            "optimizer_observation_artifact_id": None,
        },
        "timing": {
            "clock": "wall",
            "elapsed_seconds": str(len(frames) + 1),
            "physical_duration_seconds": None,
            "backend_attempts_observed": len(frames),
        },
        "failure": None,
        "raw_artifacts": inventory,
    }
    if attribution:
        raw_id = _artifact(inventory, "optimizer-original", "optimizer_raw", '{"synthetic":true}')
        observation = {
            "version": refinement.OBSERVATION_VERSION,
            "spec_hash": spec["spec_hash"],
            "engine": "optking",
            "reported_converged": True,
            "final_frame_hash": frames[-1]["frame_hash"],
            "attributions": [
                {
                    key: frame[key]
                    for key in (
                        "frame_hash",
                        "optimizer_iteration",
                        "step_status",
                        "reevaluates_frame_hash",
                    )
                }
                for frame in frames
            ],
            "backend_attempts_observed": len(frames),
            "source_artifact_ids": [raw_id],
        }
        observation_text = json.dumps(observation)
        body["convergence"]["optimizer_observation_json"] = observation_text
        body["convergence"]["optimizer_observation_artifact_id"] = _artifact(
            inventory, "optimizer-observation", "optimizer_observation", observation_text
        )
    return body


def _update_raw_artifact(body, identity, text):
    next(item for item in body["raw_artifacts"] if item["artifact_id"] == identity)["sha256"] = (
        hashlib.sha256(text.encode()).hexdigest()
    )


def test_synthetic_success_is_geometry_convergence_not_minimum_or_backend_proof():
    spec = _spec()
    result = refinement.seal_refinement_result(spec, _body(spec))
    assert result["convergence"]["geometry_status"] == "satisfied"
    assert result["convergence"]["minimum_status"] == "not_evaluated"
    assert result["evidence_origin"] == "synthetic_validation"
    assert spec["profile"]["backend_verified"] is False


def test_profile_snapshot_is_detached_and_cannot_claim_verified():
    profile = profiles.get_method_profile(profiles.PROFILE_ID)
    profile["backend_verified"] = True
    assert profiles.get_method_profile(profiles.PROFILE_ID)["backend_verified"] is False
    with pytest.raises(ValueError):
        profiles.validate_method_profile(_hashed(_without(profile, "profile_hash"), "profile_hash"))


def test_spec_hash_detects_mutation_and_seal_rejects_extra_fields():
    spec = _spec()
    spec["geometry"]["atoms"][0]["position"][0] = "0.1"
    with pytest.raises(ValueError, match="content mismatch"):
        refinement.validate_refinement_spec(spec)
    body = _without(_spec(), "spec_hash")
    body["accuracy_guaranteed"] = True
    with pytest.raises(ValueError, match="unexpected"):
        refinement.seal_refinement_spec(body)


@pytest.mark.parametrize("invalid", ["0.0", "-0", "+1", "1e-5", True, float("nan")])
def test_coordinates_require_exact_canonical_decimal_strings(invalid):
    geometry = _without(_geometry(), "geometry_hash")
    geometry["atoms"][0]["position"][0] = invalid
    with pytest.raises(ValueError):
        refinement.seal_refinement_geometry(geometry)


def test_duplicate_atom_identity_is_rejected():
    geometry = _without(_geometry(), "geometry_hash")
    geometry["atoms"][1]["id"] = geometry["atoms"][0]["id"]
    with pytest.raises(ValueError, match="duplicate atom"):
        refinement.seal_refinement_geometry(geometry)


def test_unknown_optimizer_attribution_retains_history_without_convergence():
    spec = _spec()
    result = refinement.seal_refinement_result(spec, _body(spec, attribution=False))
    assert result["state"] == "incomplete"
    assert len(result["trajectory"]) == 2
    assert result["convergence"]["geometry_status"] == "not_checked"


def test_self_declared_pass_cannot_override_evaluated_gradient():
    spec = _spec()
    body = _body(spec, gradient="0.1")
    body["state"] = "succeeded"
    body["convergence"]["geometry_status"] = "satisfied"
    with pytest.raises(ValueError, match="geometric convergence"):
        refinement.seal_refinement_result(spec, body)


def test_anticipated_exception_geometry_cannot_be_paired_with_previous_energy_gradient():
    spec = _spec()
    body = _body(spec, attribution=False)
    frame_body = _without(body["trajectory"][-1], "frame_hash")
    raw = json.loads(frame_body["raw_result_json"])
    raw["molecule"]["geometry"][0] += 0.1
    frame_body["raw_result_json"] = json.dumps(raw)
    _update_raw_artifact(body, frame_body["raw_result_artifact_id"], frame_body["raw_result_json"])
    frame = refinement.seal_refinement_frame(frame_body)
    body["trajectory"][-1] = frame
    body["final_frame_hash"] = frame["frame_hash"]
    with pytest.raises(ValueError, match="evaluated coordinate mismatch"):
        refinement.seal_refinement_result(spec, body)


def test_physical_time_cannot_be_inferred_from_optimizer_iterations():
    spec = _spec()
    body = _body(spec, attribution=False)
    frame_body = _without(body["trajectory"][0], "frame_hash")
    frame_body["physical_time_s"] = "0.000000000000001"
    body["trajectory"][0] = refinement.seal_refinement_frame(frame_body)
    with pytest.raises(ValueError, match="no physical time"):
        refinement.seal_refinement_result(spec, body)


def test_raw_bytes_and_raw_method_are_independently_bound():
    spec = _spec()
    body = _body(spec, attribution=False)
    frame_body = _without(body["trajectory"][0], "frame_hash")
    raw = json.loads(frame_body["raw_result_json"])
    raw["model"]["basis"] = "sto-3g"
    frame_body["raw_result_json"] = json.dumps(raw)
    body["trajectory"][0] = refinement.seal_refinement_frame(frame_body)
    with pytest.raises(ValueError, match="referenced bytes"):
        refinement.seal_refinement_result(spec, body)
    _update_raw_artifact(body, frame_body["raw_result_artifact_id"], frame_body["raw_result_json"])
    with pytest.raises(ValueError, match="method or basis"):
        refinement.seal_refinement_result(spec, body)


@pytest.mark.parametrize(
    "key",
    ["dft_vv10_radial_points", "dft_vv10_spherical_points", "dft_density_tolerance"],
)
def test_vv10_grid_and_density_settings_are_required(key):
    body = _without(_spec(), "spec_hash")
    del body["electronic_settings"]["native_keywords"][key]
    with pytest.raises(ValueError, match="native keywords has missing or unexpected fields"):
        refinement.seal_refinement_spec(body)


def test_unsupported_vv10_density_option_is_not_accepted():
    body = _without(_spec(), "spec_hash")
    body["electronic_settings"]["native_keywords"]["dft_vv10_density_tolerance"] = 1e-12
    with pytest.raises(ValueError, match="native keywords has missing or unexpected fields"):
        refinement.seal_refinement_spec(body)


@pytest.mark.parametrize("key", ["dft_vv10_radial_points", "dft_vv10_spherical_points"])
@pytest.mark.parametrize("invalid", [True, False, 0, -1, 10001, 99.0, "99"])
def test_vv10_grid_points_require_bounded_positive_integers(key, invalid):
    body = _without(_spec(), "spec_hash")
    body["electronic_settings"]["native_keywords"][key] = invalid
    with pytest.raises(ValueError, match="grid points outside integer bounds"):
        refinement.seal_refinement_spec(body)


@pytest.mark.parametrize("invalid", [True, False, 0, -1e-12, 1e-5, "1e-12"])
def test_dft_density_tolerance_requires_positive_bounded_json_number(invalid):
    body = _without(_spec(), "spec_hash")
    body["electronic_settings"]["native_keywords"]["dft_density_tolerance"] = invalid
    with pytest.raises(ValueError, match="DFT density tolerance must be finite, positive"):
        refinement.seal_refinement_spec(body)


@pytest.mark.parametrize("invalid", [float("nan"), float("inf"), -float("inf")])
def test_dft_density_tolerance_rejects_nonfinite_json(invalid):
    body = _without(_spec(), "spec_hash")
    body["electronic_settings"]["native_keywords"]["dft_density_tolerance"] = invalid
    with pytest.raises(ValueError, match="expected finite JSON data"):
        refinement.seal_refinement_spec(body)


def test_dft_density_tolerance_upper_bound_is_inclusive_and_content_bound():
    original = _spec()
    body = _without(original, "spec_hash")
    body["electronic_settings"]["native_keywords"]["dft_density_tolerance"] = 1e-6
    changed = refinement.seal_refinement_spec(body)
    assert changed["spec_hash"] != original["spec_hash"]
    assert changed["electronic_settings"]["native_keywords"]["dft_density_tolerance"] == 1e-6


@pytest.mark.parametrize(
    "key,expected,invalid",
    [
        ("maxiter", 1, True),
        ("fail_on_maxiter", True, 1),
        ("maxiter", 1, 1.0),
        ("dft_vv10_radial_points", 1, True),
        ("dft_vv10_spherical_points", 590, 590.0),
        ("dft_density_tolerance", 1e-12, 1e-11),
    ],
)
@pytest.mark.parametrize("envelope", ["input", "result"])
def test_raw_native_keywords_preserve_boolean_and_integer_types(key, expected, invalid, envelope):
    spec_body = _without(_spec(), "spec_hash")
    spec_body["electronic_settings"]["native_keywords"][key] = expected
    spec = refinement.seal_refinement_spec(spec_body)
    body = _body(spec, attribution=False)
    frame_body = _without(body["trajectory"][0], "frame_hash")
    raw_key, reference_key = f"raw_{envelope}_json", f"raw_{envelope}_artifact_id"
    raw = json.loads(frame_body[raw_key])
    raw["keywords"][key] = invalid
    frame_body[raw_key] = json.dumps(raw)
    _update_raw_artifact(body, frame_body[reference_key], frame_body[raw_key])
    body["trajectory"][0] = refinement.seal_refinement_frame(frame_body)
    with pytest.raises(ValueError, match="raw electronic keywords mismatch"):
        refinement.seal_refinement_result(spec, body)


@pytest.mark.parametrize("index,invalid", [(0, False), (1, True), (1, 1.0)])
def test_optimizer_attribution_iterations_cannot_use_booleans_or_decimal_numbers(index, invalid):
    spec = _spec()
    body = _body(spec)
    convergence = body["convergence"]
    observation = json.loads(convergence["optimizer_observation_json"])
    observation["attributions"][index]["optimizer_iteration"] = invalid
    convergence["optimizer_observation_json"] = json.dumps(observation)
    _update_raw_artifact(
        body,
        convergence["optimizer_observation_artifact_id"],
        convergence["optimizer_observation_json"],
    )
    with pytest.raises(ValueError, match="attributed optimizer iteration"):
        refinement.seal_refinement_result(spec, body)


def test_requested_zero_retries_does_not_become_claim_of_zero_effective_retries():
    spec = _spec()
    assert spec["resources"]["backend_retry_policy"]["requested_retries"] == 0
    assert spec["resources"]["backend_retry_policy"]["effective_retries"] == 2
    body = _body(spec)
    body["timing"]["backend_attempts_observed"] = 1
    with pytest.raises(ValueError, match="attempt count"):
        refinement.seal_refinement_result(spec, body)


def test_failure_preserves_only_last_successfully_evaluated_frame():
    spec = _spec()
    body = _body(spec, attribution=False)
    body["state"] = "failed"
    failure_id = _artifact(
        body["raw_artifacts"], "failure", "failure", '{"synthetic":"SCF failure"}'
    )
    body["failure"] = {
        "phase": "scf",
        "code": "SCF_NOT_CONVERGED",
        "message": "Synthetic failure, not observed chemistry.",
        "last_evaluated_frame_hash": body["final_frame_hash"],
        "artifact_id": failure_id,
    }
    result = refinement.seal_refinement_result(spec, body)
    assert len(result["trajectory"]) == 2
    assert result["failure"]["last_evaluated_frame_hash"] == result["trajectory"][-1]["frame_hash"]


def test_minimum_claim_requires_future_hessian_branch():
    spec = _spec()
    body = _body(spec)
    body["convergence"]["minimum_status"] = "minimum"
    with pytest.raises(ValueError, match="cannot certify a minimum"):
        refinement.seal_refinement_result(spec, body)


def test_comparison_allows_different_coordinates_but_rejects_composition_or_method_changes():
    first, conformer = _spec(), _spec(_geometry("0.000001"))
    keys = refinement.validate_raw_energy_comparison([first, conformer])
    assert keys[0]["group_hash"] == keys[1]["group_hash"]
    assert keys[0]["geometry_hash"] != keys[1]["geometry_hash"]
    with pytest.raises(ValueError, match="UNSUPPORTED_COMPARISON"):
        refinement.validate_raw_energy_comparison(
            [first, _spec(_geometry(different_composition=True))]
        )
    changed = _without(conformer, "spec_hash")
    changed["electronic_settings"]["native_keywords"]["e_convergence"] = 1e-9
    with pytest.raises(ValueError, match="UNSUPPORTED_COMPARISON"):
        refinement.validate_raw_energy_comparison([first, refinement.seal_refinement_spec(changed)])


def test_result_comparison_key_binds_evaluated_coordinates_not_just_input_geometry():
    spec = _spec()
    result = refinement.seal_refinement_result(spec, _body(spec))
    key = refinement.raw_energy_comparison_key(spec, result)
    assert key["coordinate_role"] == "final_evaluated"
    assert key["geometry_hash"] == result["trajectory"][-1]["geometry"]["geometry_hash"]
    assert key["geometry_hash"] != spec["geometry"]["geometry_hash"]
    assert key["result_hash"] == result["result_hash"]
    assert key["evidence_origin"] == "synthetic_validation"


def test_artifact_traversal_is_not_accepted_as_provenance():
    body = _without(_spec(), "spec_hash")
    body["source_binding"]["artifact"]["path"] = "../outside.json"
    with pytest.raises(ValueError, match="relative artifact path"):
        refinement.seal_refinement_spec(body)


def _change_raw_molecule(body, envelope, key, value):
    frame_body = _without(body["trajectory"][0], "frame_hash")
    raw_key, reference_key = f"raw_{envelope}_json", f"raw_{envelope}_artifact_id"
    raw = json.loads(frame_body[raw_key])
    raw["molecule"][key] = value
    frame_body[raw_key] = json.dumps(raw)
    _update_raw_artifact(body, frame_body[reference_key], frame_body[raw_key])
    body["trajectory"][0] = refinement.seal_refinement_frame(frame_body)


@pytest.mark.parametrize("envelope", ["input", "result"])
@pytest.mark.parametrize("mask", [[False] + [True] * 7, [1] * 8, [True] * 7, None])
def test_ghost_masks_wrong_lengths_and_non_boolean_reality_are_rejected(envelope, mask):
    spec = _spec()
    body = _body(spec, attribution=False)
    _change_raw_molecule(body, envelope, "real", mask)
    with pytest.raises(ValueError, match="every evaluated atom must be real"):
        refinement.seal_refinement_result(spec, body)


@pytest.mark.parametrize("explicit_mask", [False, True])
def test_omitted_or_explicit_all_real_mask_preserves_atom_identity(explicit_mask):
    spec = _spec()
    body = _body(spec, attribution=False)
    if explicit_mask:
        for envelope in ("input", "result"):
            _change_raw_molecule(body, envelope, "real", [True] * 8)
    result = refinement.seal_refinement_result(spec, body)
    assert result["trajectory"][0]["geometry"] == spec["geometry"]


@pytest.mark.parametrize("envelope", ["input", "result"])
@pytest.mark.parametrize(
    "key,value",
    [
        ("atomic_numbers", [7] * 8),
        ("atomic_numbers", [True] * 8),
        ("mass_numbers", [13] * 8),
        ("masses", [13.0] * 8),
    ],
)
def test_unbound_nuclear_identity_or_isotope_fields_are_rejected(envelope, key, value):
    spec = _spec()
    body = _body(spec, attribution=False)
    _change_raw_molecule(body, envelope, key, value)
    with pytest.raises(ValueError, match=r"nuclear charges|isotope or mass"):
        refinement.seal_refinement_result(spec, body)


def _evaluation_series(spec, samples, status):
    """Synthetic (shift, gradient, iteration, attribution, anchor-index) records."""
    frames, inventory = [], []
    for index, (shift, gradient, iteration, attribution, anchor) in enumerate(samples):
        frame = _without(_frame(spec, _geometry(shift), index, inventory, gradient), "frame_hash")
        frame.update(
            optimizer_iteration=iteration,
            step_status=attribution,
            reevaluates_frame_hash=frames[anchor]["frame_hash"] if anchor is not None else None,
        )
        frames.append(refinement.seal_refinement_frame(frame))
    return _assemble_body(spec, frames, inventory, status)


def test_final_reevaluation_is_retained_and_supplies_actual_final_gradient():
    spec = _spec()
    body = _evaluation_series(
        spec,
        [
            ("0", "0", 0, "initial", None),
            ("0.000001", "0.1", 1, "accepted", None),
            ("0.000001", "0", 1, "reevaluation", 1),
        ],
        "satisfied",
    )
    result = refinement.seal_refinement_result(spec, body)
    assert len(result["trajectory"]) == 3
    assert result["final_frame_hash"] == result["trajectory"][2]["frame_hash"]
    assert (
        result["trajectory"][2]["reevaluates_frame_hash"] == result["trajectory"][1]["frame_hash"]
    )
    assert result["trajectory"][2]["gradient_hartree_per_bohr"][0][0] == "0"
    assert result["convergence"]["minimum_status"] == "not_evaluated"


def test_final_reevaluation_cannot_erase_large_last_distinct_accepted_displacement():
    spec = _spec()
    body = _evaluation_series(
        spec,
        [
            ("0", "0", 0, "initial", None),
            ("0.1", "0", 1, "accepted", None),
            ("0.1", "0", 1, "reevaluation", 1),
        ],
        "not_satisfied",
    )
    result = refinement.seal_refinement_result(spec, body)
    assert result["state"] == "incomplete"
    assert len(result["trajectory"]) == 3
    body["state"] = "succeeded"
    body["convergence"]["geometry_status"] = "satisfied"
    with pytest.raises(ValueError, match="geometric convergence"):
        refinement.seal_refinement_result(spec, body)


def test_large_actual_final_gradient_cannot_use_older_accepted_gradient_to_pass():
    spec = _spec()
    body = _evaluation_series(
        spec,
        [
            ("0", "0", 0, "initial", None),
            ("0.000001", "0", 1, "accepted", None),
            ("0.000001", "0.1", 1, "reevaluation", 1),
        ],
        "not_satisfied",
    )
    assert refinement.seal_refinement_result(spec, body)["state"] == "incomplete"
    body["state"] = "succeeded"
    body["convergence"]["geometry_status"] = "satisfied"
    with pytest.raises(ValueError, match="geometric convergence"):
        refinement.seal_refinement_result(spec, body)


def test_final_two_distinct_accepted_steps_determine_displacement_after_larger_early_move():
    spec = _spec()
    body = _evaluation_series(
        spec,
        [
            ("0", "0", 0, "initial", None),
            ("0.1", "0.1", 1, "accepted", None),
            ("0.100001", "0.1", 2, "accepted", None),
            ("0.100001", "0", 2, "reevaluation", 2),
        ],
        "satisfied",
    )
    assert refinement.seal_refinement_result(spec, body)["state"] == "succeeded"


@pytest.mark.parametrize(
    "shift,iteration,attribution,anchor,reason",
    [
        ("0.000001", 1, "accepted", None, "strictly increasing"),
        ("0.000001", 1, "reevaluation", 0, "latest accepted step"),
        ("0.000002", 1, "reevaluation", 1, "exact geometry"),
        ("0.000001", 2, "reevaluation", 1, "latest accepted step"),
    ],
)
def test_duplicate_acceptance_or_misbound_reevaluation_cannot_supply_convergence(
    shift, iteration, attribution, anchor, reason
):
    spec = _spec()
    body = _evaluation_series(
        spec,
        [
            ("0", "0", 0, "initial", None),
            ("0.000001", "0", 1, "accepted", None),
            (shift, "0", iteration, attribution, anchor),
        ],
        "satisfied",
    )
    with pytest.raises(ValueError, match=reason):
        refinement.seal_refinement_result(spec, body)


def test_unattributed_final_evaluation_is_retained_without_inferred_reevaluation():
    spec = _spec()
    body = _evaluation_series(
        spec,
        [
            ("0", "0", 0, "initial", None),
            ("0.000001", "0", 1, "accepted", None),
            ("0.000001", "0", None, "unknown", None),
        ],
        "not_checked",
    )
    result = refinement.seal_refinement_result(spec, body)
    assert len(result["trajectory"]) == 3
    assert result["convergence"]["geometry_status"] == "not_checked"


def test_numeric_iteration_even_with_unknown_status_requires_bound_observation():
    spec = _spec()
    body = _body(spec, attribution=False)
    frame = _without(body["trajectory"][0], "frame_hash")
    frame["optimizer_iteration"] = 0
    body["trajectory"][0] = refinement.seal_refinement_frame(frame)
    with pytest.raises(ValueError, match="requires a bound observation"):
        refinement.seal_refinement_result(spec, body)


def test_unknown_intermediate_evaluation_prevents_claiming_last_two_known_steps_are_adjacent():
    spec = _spec()
    body = _evaluation_series(
        spec,
        [
            ("0", "0", 0, "initial", None),
            ("0.1", "0", None, "unknown", None),
            ("0.000001", "0", 2, "accepted", None),
            ("0.000001", "0", 2, "reevaluation", 2),
        ],
        "not_checked",
    )
    assert (
        refinement.seal_refinement_result(spec, body)["convergence"]["geometry_status"]
        == "not_checked"
    )


def test_identical_effective_option_bytes_can_move_without_changing_energy_group():
    first = _spec()
    changed = _without(first, "spec_hash")
    changed["electronic_settings"]["effective_options_artifact"]["path"] = (
        "other-run/effective-options.json"
    )
    second = refinement.seal_refinement_spec(changed)
    keys = refinement.validate_raw_energy_comparison([first, second])
    assert keys[0]["group_hash"] == keys[1]["group_hash"]
    assert keys[0]["spec_hash"] != keys[1]["spec_hash"]
    assert "path" not in keys[0]["group"]["electronic_settings"]
    assert (
        second["electronic_settings"]["effective_options_artifact"]["path"]
        == "other-run/effective-options.json"
    )


@pytest.mark.parametrize(
    "changed_field", ["effective_options", "functional_definition", "native_keywords"]
)
def test_changed_option_bytes_or_functional_or_native_settings_cannot_share_energy_group(
    changed_field,
):
    first = _spec()
    changed = _without(first, "spec_hash")
    electronic = changed["electronic_settings"]
    if changed_field == "effective_options":
        electronic["effective_options_artifact"]["sha256"] = hashlib.sha256(
            b"different synthetic options"
        ).hexdigest()
    elif changed_field == "functional_definition":
        electronic["functional_definition_hash"] = content_hash("different synthetic definition")
    else:
        electronic["native_keywords"]["e_convergence"] = 1e-9
    with pytest.raises(ValueError, match="UNSUPPORTED_COMPARISON"):
        refinement.validate_raw_energy_comparison([first, refinement.seal_refinement_spec(changed)])


def _set_optimizer_reported(body, reported):
    convergence = body["convergence"]
    convergence["optimizer_reported_converged"] = reported
    observation = json.loads(convergence["optimizer_observation_json"])
    observation["reported_converged"] = reported
    convergence["optimizer_observation_json"] = json.dumps(observation)
    _update_raw_artifact(
        body,
        convergence["optimizer_observation_artifact_id"],
        convergence["optimizer_observation_json"],
    )


def test_rejected_later_iteration_then_anchor_reevaluation_retains_partial_and_real_displacement():
    spec = _spec()
    body = _evaluation_series(
        spec,
        [
            ("0", "0", 0, "initial", None),
            ("0.1", "0", 1, "accepted", None),
            ("0.2", "0.1", 2, "rejected", None),
            ("0.1", "0", 1, "reevaluation", 1),
        ],
        "not_satisfied",
    )
    _set_optimizer_reported(body, False)
    result = refinement.seal_refinement_result(spec, body)
    assert result["state"] == "incomplete"
    assert [frame["optimizer_iteration"] for frame in result["trajectory"]] == [0, 1, 2, 1]
    assert (
        result["trajectory"][-1]["reevaluates_frame_hash"] == result["trajectory"][1]["frame_hash"]
    )
    assert result["final_frame_hash"] == result["trajectory"][-1]["frame_hash"]
    body["convergence"]["geometry_status"] = "satisfied"
    body["state"] = "succeeded"
    _set_optimizer_reported(body, True)
    with pytest.raises(ValueError, match="geometric convergence"):
        refinement.seal_refinement_result(spec, body)


def test_failure_after_rejected_trial_preserves_actual_anchor_reevaluation_frame():
    spec = _spec()
    body = _evaluation_series(
        spec,
        [
            ("0", "0", 0, "initial", None),
            ("0.000001", "0", 1, "accepted", None),
            ("0.1", "0.2", 2, "rejected", None),
            ("0.000001", "0.1", 1, "reevaluation", 1),
        ],
        "not_satisfied",
    )
    _set_optimizer_reported(body, False)
    body["state"] = "failed"
    failure_id = _artifact(
        body["raw_artifacts"],
        "failure-after-trial",
        "failure",
        '{"synthetic":"optimizer termination after recorded reevaluation"}',
    )
    body["failure"] = {
        "phase": "optimization",
        "code": "OPTIMIZER_NOT_CONVERGED",
        "message": "Synthetic failure shape, not an observed calculation.",
        "last_evaluated_frame_hash": body["final_frame_hash"],
        "artifact_id": failure_id,
    }
    result = refinement.seal_refinement_result(spec, body)
    assert len(result["trajectory"]) == 4
    assert result["state"] == "failed"
    assert result["failure"]["last_evaluated_frame_hash"] == result["trajectory"][3]["frame_hash"]
    assert result["trajectory"][3]["gradient_hartree_per_bohr"][0][0] == "0.1"


def test_unknown_later_iteration_then_anchor_reevaluation_cannot_claim_checked_convergence():
    spec = _spec()
    body = _evaluation_series(
        spec,
        [
            ("0", "0", 0, "initial", None),
            ("0.000001", "0", 1, "accepted", None),
            ("0.1", "0", 2, "unknown", None),
            ("0.000001", "0", 1, "reevaluation", 1),
        ],
        "not_checked",
    )
    _set_optimizer_reported(body, None)
    result = refinement.seal_refinement_result(spec, body)
    assert result["state"] == "incomplete"
    assert len(result["trajectory"]) == 4
    assert result["convergence"]["geometry_status"] == "not_checked"
    body["convergence"]["geometry_status"] = "satisfied"
    with pytest.raises(ValueError, match="geometric convergence"):
        refinement.seal_refinement_result(spec, body)


def test_known_rejected_trial_does_not_replace_last_accepted_geometry_for_displacement():
    spec = _spec()
    body = _evaluation_series(
        spec,
        [
            ("0", "0", 0, "initial", None),
            ("0.000001", "0", 1, "accepted", None),
            ("0.1", "0.1", 2, "rejected", None),
            ("0.000001", "0", 1, "reevaluation", 1),
        ],
        "satisfied",
    )
    result = refinement.seal_refinement_result(spec, body)
    assert result["state"] == "succeeded"
    assert result["convergence"]["minimum_status"] == "not_evaluated"


def test_anchor_return_keeps_monotonic_wall_clock_requirement():
    spec = _spec()
    body = _evaluation_series(
        spec,
        [
            ("0", "0", 0, "initial", None),
            ("0.1", "0", 1, "accepted", None),
            ("0.2", "0.1", 2, "rejected", None),
            ("0.1", "0", 1, "reevaluation", 1),
        ],
        "not_satisfied",
    )
    frame = _without(body["trajectory"][-1], "frame_hash")
    frame["elapsed_wall_seconds"] = "1"
    body["trajectory"][-1] = refinement.seal_refinement_frame(frame)
    body["final_frame_hash"] = body["trajectory"][-1]["frame_hash"]
    convergence = body["convergence"]
    observation = json.loads(convergence["optimizer_observation_json"])
    observation["final_frame_hash"] = body["final_frame_hash"]
    observation["attributions"][-1]["frame_hash"] = body["final_frame_hash"]
    convergence["optimizer_observation_json"] = json.dumps(observation)
    _update_raw_artifact(
        body,
        convergence["optimizer_observation_artifact_id"],
        convergence["optimizer_observation_json"],
    )
    with pytest.raises(ValueError, match="trajectory clocks"):
        refinement.seal_refinement_result(spec, body)
