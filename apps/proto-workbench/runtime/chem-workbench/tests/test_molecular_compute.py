"""Organic profile admission and evidence integrity; no held-out model fixtures."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from chem_workbench import execution
from chem_workbench.execution_validation import validate_plan
from chem_workbench.molecular_compute import (
    ANGSTROM_TO_BOHR,
    SCF_SETTINGS,
    molecular_preflight,
    molecular_proposal,
    validate_molecular_proposal,
    validate_molecular_result,
)
from chem_workbench.visualization import compile_snapshot, content_hash

ASPIRIN = "CC(=O)Oc1ccccc1C(=O)O"
CAFFEINE = "Cn1c(=O)c2c(ncn2C)n(C)c1=O"


def source(smiles: str = ASPIRIN, object_id: str = "development_aspirin") -> str:
    return f'''chem 0.1
molecule {object_id} {{ structure smiles "{smiles}" }}
electronic_state state {{ target {object_id} finite charge 0 multiplicity 1 }}
conditions environment {{ target {object_id} phase gas temperature 0 temperature_unit kelvin }}
calculation energy {{ target {object_id} state state conditions environment
task single_point properties [energy] method "hf" basis "sto-3g" }}
'''


def test_molecular_preflight_is_geometry_free_and_reports_real_complexity(monkeypatch: Any) -> None:
    def unexpected(*args: Any) -> None:
        raise AssertionError("Preflight must not generate geometry or execute a calculation")

    monkeypatch.setattr("chem_workbench.molecular_compute.geometry_for_object", unexpected)
    for smiles in (ASPIRIN, CAFFEINE):
        result = molecular_preflight(compile_snapshot(source(smiles)), "development_aspirin")
        assert result["complexity"]["heavy_atoms"] >= 8
        assert result["complexity"]["promotion_complexity_eligible"] is True
        assert result["complexity"]["substantive_functional_groups"]


def test_compute_admission_does_not_fabricate_promotion_complexity() -> None:
    result = molecular_preflight(compile_snapshot(source("CCCCCCCC")), "development_aspirin")
    assert result["complexity"]["promotion_complexity_eligible"] is False


@pytest.mark.parametrize(
    "smiles",
    [
        "CCO",
        "C" * 33,
        "CCCCCCCC.C",
        "CCCCCCCC[NH3+]",
        "CCCCCCC[CH2]",
        "[13CH3]CCCCCCC",
        "Brc1ccccc1O",
        "CC(O)CCc1ccccc1",
    ],
)
def test_molecular_inadmissible_structures_fail_before_geometry(smiles: str) -> None:
    with pytest.raises(ValueError, match=r"UNSUPPORTED_PROFILE|NEEDS_INPUT"):
        molecular_preflight(compile_snapshot(source(smiles)), "development_aspirin")


@pytest.mark.parametrize("kind", ["ElectronicState", "ConditionSet", "CalculationSpec"])
def test_missing_explicit_linked_state_is_not_assumed(kind: str) -> None:
    snapshot = compile_snapshot(source())
    assert snapshot.document is not None
    snapshot.document["objects"][:] = [x for x in snapshot.document["objects"] if x["kind"] != kind]
    with pytest.raises(ValueError, match="NEEDS_INPUT"):
        molecular_preflight(snapshot, "development_aspirin")


@pytest.mark.parametrize(
    ("kind", "field", "value"),
    [
        ("ElectronicState", "charge", 1),
        ("ElectronicState", "multiplicity", 3),
        ("ConditionSet", "phase", "liquid"),
        ("CalculationSpec", "method", {"name": "mp2"}),
        ("CalculationSpec", "basis", {"name": "6-31g"}),
        ("CalculationSpec", "electronic_state_reference", "unrelated"),
    ],
)
def test_source_state_and_calculation_conflicts_are_rejected(
    kind: str, field: str, value: Any
) -> None:
    snapshot = compile_snapshot(source())
    assert snapshot.document is not None
    next(x for x in snapshot.document["objects"] if x["kind"] == kind)["payload"][field] = value
    with pytest.raises(ValueError, match="UNSUPPORTED_PROFILE"):
        molecular_preflight(snapshot, "development_aspirin")


def test_generated_proposal_is_deterministic_and_bound_to_exact_source() -> None:
    original = compile_snapshot(source())
    proposal = molecular_proposal(original, "development_aspirin")
    assert proposal == molecular_proposal(original, "development_aspirin")
    assert proposal["geometry_provenance"]["measured"] is False
    assert proposal["geometry_provenance"]["optimized"] is False
    assert proposal["execution_authorized"] is False
    changed = molecular_proposal(
        compile_snapshot(source() + "# A new revision\n"), "development_aspirin"
    )
    assert changed["geometry"] == proposal["geometry"]
    assert changed["logical_plan_hash"] != proposal["logical_plan_hash"]
    assert changed["linked_state_hash"] != proposal["linked_state_hash"]


def test_rehashed_geometry_edit_cannot_claim_original_generated_provenance() -> None:
    proposal = molecular_proposal(compile_snapshot(source()), "development_aspirin")
    proposal["geometry"]["atoms"][0][1] = "50"
    proposal["geometry_hash"] = content_hash(proposal["geometry"])
    proposal["logical_plan_hash"] = content_hash(
        {k: v for k, v in proposal.items() if k != "logical_plan_hash"}
    )
    with pytest.raises(ValueError, match="APPROVAL_STALE"):
        validate_molecular_proposal(proposal)


@pytest.fixture
def plan(monkeypatch: Any) -> dict[str, Any]:
    monkeypatch.setattr(
        execution,
        "worker_identity",
        lambda worker: {
            "kind": worker.kind,
            "script": worker.script,
            "environment": {"manifest_hash": "development"},
        },
    )
    proposal = molecular_proposal(compile_snapshot(source()), "development_aspirin")
    return execution.build_molecular_resolved_plan(proposal)


def qc_response(plan: dict[str, Any], *, converged: bool = True) -> dict[str, Any]:
    geometry = plan["prepared_input"]["geometry"]
    molecule = {
        "symbols": [a[0] for a in geometry["atoms"]],
        "geometry": [float(c) * float(ANGSTROM_TO_BOHR) for a in geometry["atoms"] for c in a[1:]],
        "molecular_charge": 0.0,
        "molecular_multiplicity": 1,
        "fix_com": True,
        "fix_orientation": True,
    }
    atomic_input = {
        "molecule": molecule,
        "model": {"method": "hf", "basis": "sto-3g"},
        "driver": "energy",
        "keywords": dict(SCF_SETTINGS),
    }
    raw_result = (
        {
            **atomic_input,
            "success": True,
            "return_result": -640.0,
            "properties": {"return_energy": -640.0},
        }
        if converged
        else {
            "success": False,
            "error": {"error_type": "convergence_error", "error_message": "SCF failed"},
        }
    )
    return {
        "worker": "psi4_molecular",
        "success": converged,
        "convergence": "converged" if converged else "not_converged",
        "input_binding_hash": plan["prepared_input_hash"],
        "geometry_hash": plan["subject"]["geometry_hash"],
        "energy_hartree": "-640" if converged else None,
        "raw_input": json.dumps(atomic_input),
        "raw_result": json.dumps(raw_result),
        "error": None if converged else {"type": "convergence_error", "message": "SCF failed"},
    }


def test_molecular_plan_binds_input_units_state_and_convergence_policy(
    plan: dict[str, Any],
) -> None:
    validate_plan(plan)
    assert plan["prepared_input"]["geometry"]["units"] == "angstrom"
    assert plan["prepared_input"]["scf_settings"]["fail_on_maxiter"] is True
    altered = copy.deepcopy(plan)
    altered["prepared_input"]["scf_settings"]["maxiter"] = 1000
    altered["prepared_input_hash"] = content_hash(altered["prepared_input"])
    altered["resolved_plan_hash"] = content_hash(
        {k: v for k, v in altered.items() if k != "resolved_plan_hash"}
    )
    with pytest.raises(ValueError, match="APPROVAL_STALE"):
        validate_plan(altered)


def test_approval_rejects_environment_drift_before_launch(
    plan: dict[str, Any], tmp_path: Path, monkeypatch: Any
) -> None:
    store = execution.ExecutionStore(tmp_path / "store")
    store.save_plan(plan)
    approval = execution.issue_approval(store, plan["resolved_plan_hash"], actor="development-test")
    monkeypatch.setattr(
        execution,
        "worker_identity",
        lambda worker: {
            "kind": worker.kind,
            "script": worker.script,
            "environment": {"manifest_hash": "changed"},
        },
    )
    with pytest.raises(ValueError, match="APPROVAL_STALE"):
        execution.submit_run(store, approval["token"])
    assert not list(store.jobs.glob("*.json"))


def test_molecular_source_revision_invalidates_approved_subject(
    plan: dict[str, Any], tmp_path: Path
) -> None:
    store = execution.ExecutionStore(tmp_path / "store")
    store.save_plan(plan)
    approval = execution.issue_approval(store, plan["resolved_plan_hash"], actor="development-test")
    revised = molecular_proposal(
        compile_snapshot(source() + "# revised source\n"), "development_aspirin"
    )
    with pytest.raises(ValueError, match="current subject differs"):
        execution.submit_run(store, approval["token"], current_subject_hash=revised["subject_hash"])
    assert not list(store.jobs.glob("*.json"))


def test_registered_molecular_lowering_matches_direct_plan(plan: dict[str, Any]) -> None:
    from chem_workbench.adapters.governed_compute import require_registration, resolve
    from chem_workbench.molecular_compute import MOLECULAR_PROFILE

    require_registration(MOLECULAR_PROFILE)
    assert resolve(MOLECULAR_PROFILE, plan["subject"]["proposal"]) == plan


@pytest.mark.parametrize("tamper", ["provenance", "coordinates", "basis", "energy", "convergence"])
def test_inconsistent_molecular_results_are_never_evidence(
    plan: dict[str, Any], tamper: str
) -> None:
    response = qc_response(plan)
    if tamper == "provenance":
        response["input_binding_hash"] = "sha256:" + "0" * 64
    if tamper == "coordinates":
        raw = json.loads(response["raw_result"])
        raw["molecule"]["geometry"][0] += 1
        response["raw_result"] = json.dumps(raw)
    if tamper == "basis":
        raw = json.loads(response["raw_input"])
        raw["model"]["basis"] = "6-31g"
        response["raw_input"] = json.dumps(raw)
    if tamper == "energy":
        response["energy_hartree"] = "-641"
    if tamper == "convergence":
        response["convergence"] = "not_converged"
    with pytest.raises(ValueError, match="INVALID_TOOL_OUTPUT"):
        validate_molecular_result(plan, response)


def test_nonconverged_backend_record_persists_as_failed_job(
    plan: dict[str, Any], tmp_path: Path, monkeypatch: Any
) -> None:
    store = execution.ExecutionStore(tmp_path / "store")
    store.save_plan(plan)
    approval = execution.issue_approval(store, plan["resolved_plan_hash"], actor="development-test")

    def worker(_spec: Any, _input: Path, output: Path, **kwargs: Any) -> dict[str, Any]:
        output.write_text(json.dumps(qc_response(plan, converged=False)), encoding="utf-8")
        return {"status": "succeeded", "returncode": 0, "_stdout": b"", "_stderr": b""}

    monkeypatch.setattr(execution, "run_worker", worker)
    job = execution.submit_run(store, approval["token"])
    result = json.loads((store.runs / job["job_id"] / "result.json").read_text())
    assert job["status"] == "failed"
    assert job["evidence_eligible"] is False
    assert result["convergence"] == "not_converged"
    assert "energy_hartree" not in result
    assert job["result_hash"] == content_hash(result)
