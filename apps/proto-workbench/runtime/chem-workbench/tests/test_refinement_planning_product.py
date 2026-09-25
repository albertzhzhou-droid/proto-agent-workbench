"""Pure host-boundary tests using the frozen 34-atom candidate geometry.

All generated energies, gradients, attempts, optimizer observations and runner
identities are mocks. Even worker_record in a fixture is an explicitly simulated
worker declaration, never a retained scientific computation or acceptance result.
No scientific modules, worker, subprocess, or model are invoked.
"""

import copy
import hashlib
import json
from dataclasses import replace
from decimal import Decimal
from pathlib import Path

import pytest

from chem_workbench import molecular_refinement as refinement
from chem_workbench.method_profiles import ANGSTROM_TO_BOHR
from chem_workbench.refinement_execution import refinement_plan as policy

FIXTURES = Path(__file__).resolve().parent / "fixtures/refinement_execution_subject"


def sealed(body, key):
    body = {k: copy.deepcopy(v) for k, v in body.items() if k != key}
    return {**body, key: policy.content_hash(body)}


def subject_check(subject, spec):
    # Mock of the independently authenticated subject bridge; no schema invention.
    if subject["source_binding"] != spec["source_binding"]:
        raise ValueError("subject/spec source conflict")
    if subject["geometry"] != spec["geometry"]:
        raise ValueError("subject/spec geometry conflict")


@pytest.fixture
def context():
    spec = json.loads((FIXTURES / "mass-bound-input.original.json").read_text(encoding="utf-8"))[
        "spec"
    ]
    assert len(spec["geometry"]["atoms"]) == 34
    spec["optimizer_settings"]["max_gradient_evaluations"] = 4
    spec = refinement.seal_refinement_spec({k: v for k, v in spec.items() if k != "spec_hash"})
    return policy.PlanContext(
        subject={
            "fixture": "opaque validated closure mock",
            "source_binding": copy.deepcopy(spec["source_binding"]),
            "geometry": copy.deepcopy(spec["geometry"]),
        },
        spec=spec,
        worker_identity={
            "kind": "psi4_refinement",
            "script": "worker_refinement_psi4.py",
            "fixture": "host identity mock, not observed runtime",
        },
        mode="gradient",
        resource_policy={key: spec["resources"][key] for key in policy.LIMITS},
        validate_spec=refinement.validate_refinement_spec,
        validate_subject_spec=subject_check,
    )


def contract_context(context, mode):
    # Mock of the separately staged execution-contract validator.
    contract = {"fixture": "validated policy mock", "mode": mode, "final_reevaluation": True}

    def validate(value, spec, actual_mode):
        assert spec == context.spec
        if value != contract or actual_mode != mode:
            raise ValueError("execution contract conflict")

    return replace(context, mode=mode, execution_contract=contract, validate_contract=validate)


def scientific_result(
    context, *, optimization=False, origin="worker_record", failed=False, reevaluation=True
):
    spec = context.spec
    storage = {}
    inventory = []

    def artifact(identity, role, value):
        text = json.dumps(value, sort_keys=True)
        path = "mock/" + identity + ".json"
        storage[path] = text.encode()
        inventory.append(
            {
                "artifact_id": identity,
                "role": role,
                "path": path,
                "sha256": hashlib.sha256(text.encode()).hexdigest(),
            }
        )
        return text

    frames = []
    for index in range((3 if reevaluation else 2) if optimization else 1):
        geometry = copy.deepcopy(spec["geometry"])
        molecule = {
            "symbols": [a["element"] for a in geometry["atoms"]],
            "atom_labels": [a["id"] for a in geometry["atoms"]],
            "geometry": [
                float(Decimal(v) * Decimal(ANGSTROM_TO_BOHR))
                for a in geometry["atoms"]
                for v in a["position"]
            ],
            "molecular_charge": 0,
            "molecular_multiplicity": 1,
            "fix_com": True,
            "fix_orientation": True,
            "masses": [float(a["mass_dalton"]) for a in spec["isotope_binding"]["atoms"]],
            "mass_numbers": [a["mass_number"] for a in spec["isotope_binding"]["atoms"]],
        }
        raw_input = {
            "schema_name": "qcschema_input",
            "schema_version": 1,
            "driver": "gradient",
            "molecule": molecule,
            "model": {"method": spec["profile"]["method"], "basis": spec["profile"]["basis"]},
            "keywords": copy.deepcopy(spec["electronic_settings"]["native_keywords"]),
        }
        raw_result = {
            **copy.deepcopy(raw_input),
            "schema_name": "qcschema_output",
            "success": True,
            "properties": {"return_energy": -100.0},
            "return_result": [[0.0, 0.0, 0.0] for _ in geometry["atoms"]],
            "provenance": {
                "creator": "Psi4",
                "version": spec["runtime_binding"]["versions"]["psi4"],
            },
        }
        input_id, result_id = f"input-{index}", f"result-{index}"
        frame = refinement.seal_refinement_frame(
            {
                "version": refinement.FRAME_VERSION,
                "evaluation_index": index,
                "optimizer_iteration": min(index, 1) if optimization else None,
                "step_status": ["initial", "accepted", "reevaluation"][index]
                if optimization
                else "unknown",
                "reevaluates_frame_hash": frames[-1]["frame_hash"] if index == 2 else None,
                "geometry": geometry,
                "energy_hartree": "-100",
                "gradient_hartree_per_bohr": [["0", "0", "0"] for _ in geometry["atoms"]],
                "elapsed_wall_seconds": str(index + 1),
                "physical_time_s": None,
                "raw_input_json": artifact(input_id, "atomic_input", raw_input),
                "raw_result_json": artifact(result_id, "atomic_result", raw_result),
                "raw_input_artifact_id": input_id,
                "raw_result_artifact_id": result_id,
            }
        )
        frames.append(frame)
        artifact(f"attempt-{index}", "backend_attempt", {"fixture": "mock attempt"})
    observation = None
    if optimization:
        artifact("optimizer-raw", "optimizer_raw", {"fixture": "synthetic optimizer"})
        observation = artifact(
            "optimizer-observation",
            "optimizer_observation",
            {
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
                "source_artifact_ids": ["optimizer-raw"],
            },
        )
    failure = None
    if failed:
        artifact("failure", "failure", {"fixture": "mock post-evaluation failure"})
        failure = {
            "phase": "gradient",
            "code": "MOCK_FAILURE",
            "message": "synthetic failure",
            "last_evaluated_frame_hash": frames[-1]["frame_hash"],
            "artifact_id": "failure",
        }
    body = {
        "version": refinement.RESULT_VERSION,
        "spec_hash": spec["spec_hash"],
        "state": "failed" if failed else "succeeded" if optimization else "incomplete",
        "evidence_origin": origin,
        "runtime_binding_hash": spec["runtime_binding"]["binding_hash"],
        "basis_binding_hash": spec["basis_binding"]["binding_hash"],
        "trajectory": frames,
        "final_frame_hash": frames[-1]["frame_hash"],
        "convergence": {
            "geometry_status": "satisfied" if optimization else "not_checked",
            "minimum_status": "not_evaluated",
            "optimizer_reported_converged": True if optimization else None,
            "optimizer_observation_json": observation,
            "optimizer_observation_artifact_id": "optimizer-observation" if optimization else None,
        },
        "timing": {
            "clock": "wall",
            "elapsed_seconds": "4",
            "physical_duration_seconds": None,
            "backend_attempts_observed": len(frames),
        },
        "failure": failure,
        "raw_artifacts": inventory,
    }
    return refinement.seal_refinement_result(spec, body), storage


def admission(context, result, storage, **changes):
    plan = policy.build_resolved_plan(context)

    def retain(path, value):
        storage[path] = json.dumps(value, sort_keys=True).encode()
        return {"path": path, "sha256": hashlib.sha256(storage[path]).hexdigest()}

    arguments = {
        "runner": {
            "status": "succeeded",
            "returncode": 0,
            "resource_limits": copy.deepcopy(context.resource_policy),
        },
        "observed_worker_identity": context.worker_identity,
        "input_artifact": retain("mock/input.json", plan["prepared_input"]),
        "output_artifact": retain("mock/output.json", result) if result is not None else None,
        "retained_artifacts": [],
        "read_artifact": lambda ref: storage[ref["path"]],
        "validate_result": refinement.validate_refinement_result,
        "validate_contract_result": lambda *_: None,  # explicitly mocked observed-accounting gate
    }
    arguments.update(changes)
    return policy.admit_result(plan, context, **arguments)


def test_request_is_exact_and_plan_does_not_grant_approval(context):
    plan = policy.build_resolved_plan(context)
    assert set(policy.prepared_input(plan, context)) == {"version", "mode", "spec"}
    assert plan["acceptance"]["authority"] == "existing_host_approval_required"
    assert "approval_token" not in plan
    assert plan["subject_content_hash"] == policy.content_hash(context.subject)
    plan["spec"]["geometry"]["atoms"][0]["position"][0] = "999"
    assert context.spec["geometry"]["atoms"][0]["position"][0] != "999"


@pytest.mark.parametrize("change", ["mode", "resources", "subject", "worker", "input"])
def test_fully_rehashed_plan_conflicts_rejected(context, change):
    plan = policy.build_resolved_plan(context)
    if change == "mode":
        plan["mode"] = plan["prepared_input"]["mode"] = "optimization"
    elif change == "resources":
        plan["resource_ceilings"]["threads"] = 1
        plan["spec"]["resources"]["threads"] = 1
        plan["spec"] = sealed(plan["spec"], "spec_hash")
        plan["prepared_input"]["spec"] = plan["spec"]
    elif change == "subject":
        plan["subject"]["fixture"] = "different closure"
        plan["subject_content_hash"] = policy.content_hash(plan["subject"])
    elif change == "worker":
        plan["worker"]["fixture"] = "different worker"
    else:
        plan["prepared_input"]["worker"] = "legacy forged field"
    plan["prepared_input_hash"] = policy.content_hash(plan["prepared_input"])
    plan = sealed(plan, "resolved_plan_hash")
    with pytest.raises(ValueError, match="APPROVAL_STALE"):
        policy.validate_plan(plan, context)


@pytest.mark.parametrize("key", list(policy.LIMITS))
@pytest.mark.parametrize("value", [True, 0, -1, 1.5])
def test_resource_limits_strict(context, key, value):
    limits = {**context.resource_policy, key: value}
    with pytest.raises(ValueError, match="resource"):
        policy.build_resolved_plan(replace(context, resource_policy=limits))


@pytest.mark.parametrize("key", list(policy.LIMITS))
def test_resource_upper_bounds(context, key):
    limits = {**context.resource_policy, key: policy.LIMITS[key] + 1}
    with pytest.raises(ValueError, match="host limit"):
        policy.build_resolved_plan(replace(context, resource_policy=limits))


def test_old_worker_and_legacy_optimization_not_admitted(context):
    with pytest.raises(ValueError, match="host refinement"):
        policy.build_resolved_plan(replace(context, worker_identity={"kind": "psi4_water"}))
    with pytest.raises(ValueError, match="legacy request"):
        policy.build_resolved_plan(replace(context, mode="optimization"))


def test_rehashed_subject_spec_conflict_rejected_by_injected_bridge(context):
    subject = copy.deepcopy(context.subject)
    subject["source_binding"]["candidate_hash"] = policy.content_hash("other")
    with pytest.raises(ValueError, match="subject/spec"):
        policy.build_resolved_plan(replace(context, subject=subject))


def test_new_request_exact_and_contract_conflict(context):
    context = contract_context(context, "gradient")
    plan = policy.build_resolved_plan(context)
    assert set(plan["prepared_input"]) == {"version", "mode", "spec", "execution_contract"}
    assert plan["prepared_input"]["version"] == "refinement-worker-request/v2"
    bad = {**context.execution_contract, "final_reevaluation": False}
    with pytest.raises(ValueError, match="contract conflict"):
        policy.build_resolved_plan(replace(context, execution_contract=bad))


def test_one_gradient_completion_keeps_incomplete_scientific_state(context):
    result, storage = scientific_result(context)
    observed = admission(context, result, storage)
    assert observed["execution_status"] == "succeeded"
    assert observed["mode_completed"] is True
    assert observed["scientific_state"] == "incomplete"
    assert observed["scientific_result"] == result
    assert observed["minimum_certified"] is False
    assert observed["scientific_accuracy_validated"] is False


@pytest.mark.parametrize(
    "status", ["failed", "timeout", "cancelled", "interrupted", "output_limit"]
)
def test_runner_failure_retains_valid_partial_result(context, status):
    result, storage = scientific_result(context)
    runner = {"status": status, "returncode": -1, "resource_limits": context.resource_policy}
    observed = admission(context, result, storage, runner=runner)
    assert observed["execution_status"] == status
    assert observed["mode_completed"] is False
    assert observed["scientific_record_valid"] is True
    assert observed["scientific_result"] == result


def test_worker_failure_with_exit_zero_is_not_mode_completion(context):
    result, storage = scientific_result(context, failed=True)
    observed = admission(context, result, storage)
    assert observed["mode_completed"] is False
    assert observed["scientific_state"] == "failed"
    assert len(observed["scientific_result"]["trajectory"]) == 1


@pytest.mark.parametrize("origin", ["synthetic_validation", "imported_unverified"])
def test_origin_cannot_claim_actual_completion(context, origin):
    result, storage = scientific_result(context, origin=origin)
    observed = admission(context, result, storage)
    assert observed["scientific_record_valid"] is True
    assert observed["mode_completed"] is False


def test_corrupt_artifact_keeps_original_result_but_denies_completion(context):
    result, storage = scientific_result(context)
    storage[result["raw_artifacts"][0]["path"]] = b"altered"
    observed = admission(context, result, storage)
    assert observed["mode_completed"] is False
    assert observed["artifacts_authenticated"] is False
    assert observed["scientific_result"] == result
    assert "EVIDENCE_CORRUPT" in str(observed["admission_errors"])


def test_missing_output_and_raw_partial_retained_without_fabrication(context):
    raw = b"synthetic unmatched start"
    ref = {"path": "mock/start.json", "sha256": hashlib.sha256(raw).hexdigest()}
    observed = admission(context, None, {ref["path"]: raw}, retained_artifacts=[ref])
    assert observed["scientific_result"] is None
    assert observed["scientific_state"] is None
    assert observed["retained_artifacts"] == [ref]
    assert observed["mode_completed"] is False


def test_invalid_sealed_result_is_retained_only_as_raw_output(context):
    result, storage = scientific_result(context)
    result["state"] = "succeeded"  # unsealed and missing convergence evidence
    observed = admission(context, result, storage)
    assert observed["scientific_result"] is None
    assert observed["output_artifact"] is not None
    assert "result_validation" in str(observed["admission_errors"])


def test_v2_requires_observed_contract_result_gate(context):
    context = contract_context(context, "gradient")
    result, storage = scientific_result(context)
    observed = admission(context, result, storage, validate_contract_result=None)
    assert observed["mode_completed"] is False
    assert "CONTRACT_RESULT_VALIDATOR_REQUIRED" in str(observed["admission_errors"])


def test_optimization_needs_bound_policy_and_final_reevaluation(context):
    context = contract_context(context, "optimization")
    result, storage = scientific_result(context, optimization=True)
    observed = admission(context, result, storage)
    assert observed["mode_completed"] is True
    assert observed["scientific_state"] == "succeeded"
    assert observed["minimum_certified"] is False
    assert observed["scientific_result"]["trajectory"][-1]["step_status"] == "reevaluation"
    result, storage = scientific_result(context, optimization=True, reevaluation=False)
    observed = admission(context, result, storage)
    assert observed["scientific_record_valid"] is True
    assert observed["scientific_state"] == "succeeded"
    assert observed["mode_completed"] is False
    assert "MODE_INCOMPLETE" in str(observed["admission_errors"])


def test_current_contract_module_interoperability(context):
    from chem_workbench.refinement_execution import execution_contract

    contract = execution_contract.seal_execution_contract(context.spec, "gradient")
    current = replace(
        context,
        execution_contract=contract,
        validate_contract=execution_contract.validate_execution_contract,
    )
    plan = policy.build_resolved_plan(current)
    assert policy.prepared_input(plan, current) == execution_contract.build_worker_request(
        context.spec, contract
    )


@pytest.mark.parametrize("path", ["../escape", "C:/escape", "/escape", "a\\b"])
def test_bad_reference_paths_never_reach_reader(context, path):
    result, storage = scientific_result(context)
    called = []

    def reader(ref):
        called.append(ref["path"])
        return storage[ref["path"]]

    observed = admission(
        context,
        result,
        storage,
        read_artifact=reader,
        retained_artifacts=[{"path": path, "sha256": "a" * 64}],
    )
    assert path not in called
    assert observed["mode_completed"] is False


def test_reader_must_supply_bytes_and_inputs_remain_unchanged(context):
    result, storage = scientific_result(context)
    before = copy.deepcopy(result)
    observed = admission(context, result, storage, read_artifact=lambda _: True)
    assert observed["mode_completed"] is False
    assert "actual bytes" in str(observed["admission_errors"])
    assert result == before


def test_actual_rehashed_input_content_conflict_is_retained(context):
    result, storage = scientific_result(context)
    plan = policy.build_resolved_plan(context)
    wrong = {**plan["prepared_input"], "mode": "optimization"}
    raw = json.dumps(wrong).encode()
    storage["mock/wrong-input.json"] = raw
    observed = admission(
        context,
        result,
        storage,
        input_artifact={"path": "mock/wrong-input.json", "sha256": hashlib.sha256(raw).hexdigest()},
    )
    assert observed["mode_completed"] is False
    assert observed["scientific_record_valid"] is True
    assert "actual prepared input bytes" in str(observed["admission_errors"])


def test_runner_bool_returncode_and_resource_drift_rejected(context):
    result, storage = scientific_result(context)
    runner = {
        "status": "succeeded",
        "returncode": False,
        "resource_limits": context.resource_policy,
    }
    with pytest.raises(ValueError, match="runner observation"):
        admission(context, result, storage, runner=runner)
    runner["returncode"] = 0
    runner["resource_limits"] = {**context.resource_policy, "threads": 1}
    with pytest.raises(ValueError, match="runner resources"):
        admission(context, result, storage, runner=runner)
