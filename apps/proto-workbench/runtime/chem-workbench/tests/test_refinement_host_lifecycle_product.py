"""Product lifecycle, observer and host code with injected fake runtimes.

The retained complex 34-atom geometry is preserved. All returned energies,
gradients, authority checks and native identity observations are synthetic.
"""

import copy
import hashlib
import json
import sys
from pathlib import Path

import pytest
from refinement_evidence_fixtures import materialize_bound_artifacts
from test_refinement_execution_lifecycle import Harness

from chem_workbench import molecular_refinement as records
from chem_workbench.refinement_execution import contract_result_evidence as evidence
from chem_workbench.refinement_execution import execution_contract
from chem_workbench.refinement_execution.host_evidence import HostEvidenceSession

ROOT = Path(__file__).resolve().parents[1]


def product_host(tmp_path, fault=None):
    harness = Harness(tmp_path)
    harness.pipeline.fault = fault
    materialize_bound_artifacts(tmp_path)
    for relative in (
        "src/chem_workbench/refinement_execution/worker_lifecycle.py",
        "src/chem_workbench/refinement_execution/host_evidence.py",
    ):
        harness.context.source_identity[relative] = hashlib.sha256(
            (ROOT / relative).read_bytes()
        ).hexdigest()
    # Snapshot actual loaded product source bytes into the synthetic host root.
    for relative, expected in harness.context.source_identity.items():
        raw = (ROOT / relative).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == expected
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as stream:
            stream.write(raw)
    quiescence = []
    host = HostEvidenceSession(
        root=tmp_path,
        run_directory=harness.context.run_directory,
        run_id=harness.context.run_id,
        run_nonce=harness.context.run_nonce,
        spec=harness.request["spec"],
        contract=harness.request["execution_contract"],
        mode="gradient",
        worker_identity=harness.context.worker_identity,
        source_paths=list(harness.context.source_identity),
        native_task_config=harness.context.native_task_config,
        native_dispersion_version="1.6.0",
        validate_spec=records.validate_refinement_spec,
        validate_contract=execution_contract.validate_execution_contract,
        validate_result=records.validate_refinement_result,
        observe_worker_identity=lambda: copy.deepcopy(harness.context.worker_identity),
        assert_quiescent=lambda: quiescence.append("synthetic-no-processes"),
        auxiliary_names=["worker-lifecycle-events.jsonl"],
    )
    host.begin()
    return harness, host, quiescence


@pytest.mark.parametrize("fault", [None, "missing_nested_return"])
def test_actual_product_lifecycle_host_assembler_and_admission(tmp_path, fault):
    harness, host, quiescence = product_host(tmp_path, fault)
    original_request = copy.deepcopy(harness.request)
    report = harness.execute()
    assert report["runner_outcome"] == ("completed" if fault is None else "failed"), report
    finalized = host.finalize()
    diagnostic = json.loads(host.reader(finalized.diagnostics_reference))
    assert finalized.evidence_reference is not None, diagnostic
    assert finalized.scientific_result == report["scientific_result"]
    assert finalized.host_context.source_identity == harness.context.source_identity
    assert set(harness.context.resource_policy) == {
        "wall_seconds",
        "memory_bytes",
        "cpu_seconds",
        "threads",
        "max_output_bytes",
    }
    assessment = evidence.assess_contract_result(
        harness.request["execution_contract"],
        harness.request["spec"],
        "gradient",
        finalized.scientific_result,
        evidence_ref=finalized.evidence_reference,
        host_context=finalized.host_context,
        read_artifact=host.reader,
        validate_contract=execution_contract.validate_execution_contract,
        validate_scientific_result=records.validate_refinement_result,
        validate_optimizer_evidence=None,
    )
    host.reader.publish(
        harness.context.run_directory + "/host-evidence",
        "test-assessment.json",
        {**assessment, "synthetic_test_only": True},
    )
    assert assessment["complete"] is (fault is None), assessment["errors"]
    assert diagnostic["execution_evidence_admission"] == "unassessed"
    assert assessment["minimum_certified"] is assessment["scientific_accuracy_validated"] is False
    assert harness.request == original_request
    assert quiescence
    assert not {"psi4", "qcengine", "qcelemental", "optking", "dftd3"} & sys.modules.keys()
    inventory = json.loads(host.reader(finalized.inventory_reference))
    assert not inventory["unknown_paths"]
    assert any(ref["path"].endswith("worker-lifecycle-events.jsonl") for ref in inventory["files"])
    if fault is None:
        assert finalized.scientific_result["state"] == "incomplete"
        assert len(finalized.scientific_result["trajectory"]) == 1
        assert len(finalized.scientific_result["trajectory"][0]["geometry"]["atoms"]) == 34
        assert assessment["evaluations"][0]["durable_counts"] == {key: 2 for key in evidence.COUNTS}
    else:
        assert finalized.scientific_result["state"] == "failed"
        assert not finalized.scientific_result["trajectory"]
        assert not (harness.run / "evaluation-0000-dispatch/nested/inner-0001-return.json").exists()
        assert assessment["evaluations"][0]["durable_counts"]["inner_calls_returned"] == 1


def test_lifecycle_initialization_failure_keeps_host_partial_without_result(tmp_path):
    harness, host, _ = product_host(tmp_path)

    def failed_import(name):
        raise RuntimeError("explicit synthetic native initialization failure: " + name)

    report = harness.execute(import_module=failed_import)
    assert report["runner_outcome"] == "failed" and report["scientific_result"] is None
    finalized = host.finalize()
    assert finalized.evidence_reference is finalized.scientific_result is None
    assert finalized.after_reference is not None
    inventory = json.loads(host.reader(finalized.inventory_reference))
    assert not inventory["unknown_paths"]
    assert {Path(ref["path"]).name for ref in inventory["files"]} == {
        "worker-lifecycle.json",
        "worker-lifecycle-events.jsonl",
    }
