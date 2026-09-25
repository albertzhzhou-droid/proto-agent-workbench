"""Real workflow/store/admission with explicitly synthetic in-process execution.

Uses the portable retained 34-atom Design record, genuine host source validation,
and existing pure recorder/lifecycle fixture. Native objects, worker identity and
thread scheduling are injected; no native/model/server or OS worker is launched.
"""

from __future__ import annotations

import copy
import getpass
import hashlib
import json
import threading
from dataclasses import asdict
from types import SimpleNamespace

import pytest
from test_refinement_governed_execution_product import governed as governed
from test_refinement_governed_plan_product import case as case
from test_refinement_governed_plan_product import retained_case as retained_case

from chem_workbench import execution, molecular_refinement, workflows
from chem_workbench.execution import build_mock_resolved_plan
from chem_workbench.refinement_execution import governed_plan, refinement_subject
from chem_workbench.refinement_execution.execution_contract import seal_execution_contract
from chem_workbench.visualization import content_hash


def write(path, value):
    path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")), encoding="utf-8")


def ref(path, root):
    return {
        "path": path.relative_to(root).as_posix(),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


@pytest.fixture
def flow(governed, monkeypatch):
    state = governed
    root = state.root
    record = json.loads((root / "record.json").read_bytes())
    selection = {
        "run_ref": record["record_hash"],
        "candidate_hash": record["organic"]["candidates"][2]["candidate_hash"],
    }
    directory = state.store.root / "designs"
    directory.mkdir()
    saved = directory / (selection["run_ref"].split(":")[1] + ".json")
    saved.write_bytes((root / "record.json").read_bytes())
    subject = refinement_subject.prepare_design_candidate_subject(
        record,
        selection,
        root=root,
        record_artifact=ref(saved, root),
        source_artifact=ref(root / "source.chem", root),
        electronic_state={"charge": 0, "multiplicity": 1},
    )
    write(root / "subject.json", subject)
    spec = copy.deepcopy(state.plan["spec"])
    spec["source_binding"]["artifact"] = ref(root / "subject.json", root)
    spec = molecular_refinement.seal_refinement_spec(
        {key: value for key, value in spec.items() if key != "spec_hash"}
    )
    write(root / "spec.json", spec)
    write(root / "contract.json", seal_execution_contract(spec, "gradient"))
    for key, name in (
        ("spec_ref", "spec.json"),
        ("subject_ref", "subject.json"),
        ("execution_contract_ref", "contract.json"),
    ):
        state.case[key] = ref(root / name, root)
    state.plan = governed_plan.prepare(**state.case)
    pending = []

    class DeferredThread:
        def __init__(self, *, target, daemon, name):
            assert daemon is True and name == "chem-workflow"
            self.target = target

        def start(self):
            pending.append(self.target)

    monkeypatch.setattr(
        workflows, "threading", SimpleNamespace(RLock=threading.RLock, Thread=DeferredThread)
    )
    service = workflows.WorkflowService(state.store.root, artifact_root=root)
    request = {
        key: copy.deepcopy(state.case[key])
        for key in ("spec_ref", "subject_ref", "execution_contract_ref", "mode")
    }
    request.update(disk_budget=asdict(state.case["disk_budget"]), selection=selection)
    state.service, state.request, state.saved_design, state.pending = (
        service,
        request,
        saved,
        pending,
    )
    return state


def prepare(flow):
    return flow.service.prepare_refinement(copy.deepcopy(flow.request))


def finish(flow):
    record = prepare(flow)
    reference = record["reference"]
    flow.service.approve_refinement(reference)
    flow.service.submit(reference)
    flow.pending.pop(0)()
    return flow.service.read(reference)


def test_prepare_binds_actual_store_design_source_and_no_authority(flow):
    record = prepare(flow)
    assert record["version"] == "refinement-workflow/v1"
    assert record["state"] == "prepared" and record["refinement_view"] is None
    assert record["selection"] == flow.request["selection"]
    assert record["source"] == (flow.root / "source.chem").read_text()
    assert (
        record["source_hash"] == "sha256:" + hashlib.sha256(record["source"].encode()).hexdigest()
    )
    assert (
        record["source_hash"] != record["plan"]["subject"]["candidate"]["generation_request_hash"]
    )
    assert record["attachments"] == {} and record["orchestration_ref"] is None
    assert len(record["plan"]["spec"]["geometry"]["atoms"]) == 34
    assert (
        record["plan"]["subject"]["coordinate_tokens"] == flow.plan["subject"]["coordinate_tokens"]
    )
    assert record["plan"]["resource_ceilings"] == flow.plan["resource_ceilings"]
    assert record["plan"]["disk_budget"] == flow.request["disk_budget"]
    assert record["plan"]["subject"]["execution_authorized"] is False
    assert not list(flow.service.store.approvals.iterdir())
    assert flow.calls == [] and flow.pending == []
    assert "approval_token" not in json.dumps(record)
    with pytest.raises(ValueError, match="APPROVAL_REQUIRED"):
        flow.service.submit(record["reference"])


def test_refinement_approval_uses_saved_candidate_and_reprepare_keeps_approval(flow):
    record = prepare(flow)
    with pytest.raises(ValueError, match="Design refinement approval"):
        flow.service.approve(record["reference"], record["source"], {})
    approved = flow.service.approve_refinement(record["reference"])
    assert approved["state"] == "approved" and approved["refinement_view"] is None
    assert "approval_token" not in json.dumps(approved)
    assert prepare(flow) == approved
    assert len(list(flow.service.store.approvals.iterdir())) == 1


def test_real_product_state_chain_single_submission_and_exact_evaluation_view(flow):
    record = prepare(flow)
    reference = record["reference"]
    flow.service.approve_refinement(reference)
    assert flow.service.submit(reference)["state"] == "queued"
    assert flow.service.submit(reference)["state"] == "queued"
    assert len(flow.pending) == 1 and not flow.calls
    flow.pending.pop(0)()
    complete = flow.service.read(reference)
    assert complete["state"] == "succeeded", complete
    result, view = complete["result"], complete["refinement_view"]
    assert result["execution_status"] == "succeeded" and result["evidence_eligible"] is True
    assert result["scientific_state"] == view["state"] == "incomplete"
    assert result["minimum_certified"] is result["scientific_accuracy_validated"] is False
    assert len(view["frames"]) == 1 and len(view["frames"][0]["coordinate_table"]) == 34
    assert (
        view["frames"][0]["frame_hash"]
        == result["scientific_result"]["trajectory"][0]["frame_hash"]
    )
    assert view["trajectory_chart"]["points"][0]["physical_time_s"] is None
    assert "approval_token" not in json.dumps(complete)
    assert len(flow.calls) == 1
    flow.service.submit(reference)
    flow.pending.pop(0)()
    assert len(flow.calls) == 1
    assert len(list(flow.service.store.jobs.iterdir())) == 1
    assert flow.service.list() == [complete]


@pytest.mark.parametrize("fault", ["missing_result", "runner_exception"])
def test_no_scientific_result_retains_host_failure_without_fabricated_view(flow, fault):
    flow.fault = fault
    record = finish(flow)
    assert record["state"] == "failed"
    assert record["result"]["evidence_eligible"] is False
    assert record["result"].get("scientific_result") is None
    assert record["refinement_view"] is None
    assert len(flow.calls) == 1


@pytest.mark.parametrize("status", ["timeout", "cancelled"])
def test_host_timeout_or_cancellation_remains_distinct_from_scientific_frames(
    flow, monkeypatch, status
):
    flow.fault = "missing_result"
    original_runner = execution.run_worker

    def terminal_runner(*args, **kwargs):
        outcome = original_runner(*args, **kwargs)
        outcome.update(status=status, returncode=None)
        return outcome

    monkeypatch.setattr(execution, "run_worker", terminal_runner)
    record = prepare(flow)
    reference = record["reference"]
    cancelled = []
    if status == "cancelled":
        flow.before_run = lambda: cancelled.append(flow.service.cancel(reference))
    flow.service.approve_refinement(reference)
    flow.service.submit(reference)
    flow.pending.pop(0)()
    read = flow.service.read(reference)
    assert read["state"] == read["result"]["execution_status"] == status
    assert read["refinement_view"] is None
    assert read["result"]["evidence_eligible"] is False
    assert read["result"]["scientific_result"] is None
    if status == "cancelled":
        assert len(cancelled) == 1
        assert (flow.service.store.runs / read["job"]["job_id"] / "cancel.request").is_file()


@pytest.mark.parametrize("field", ["extra", "approved", "source", "geometry", "profile"])
def test_request_rejects_extra_authority_source_or_geometry(flow, field):
    request = copy.deepcopy(flow.request)
    request[field] = True
    with pytest.raises(ValueError, match="refinement preparation fields"):
        flow.service.prepare_refinement(request)
    assert not list(flow.service.records.iterdir()) and not flow.pending


@pytest.mark.parametrize(
    "mutation", ["missing", "extra", "different_candidate", "different_run", "wrong_type"]
)
def test_selection_is_exact_and_matches_full_plan_subject(flow, mutation):
    request = copy.deepcopy(flow.request)
    if mutation == "missing":
        request.pop("selection")
    elif mutation == "extra":
        request["selection"]["family"] = "organic"
    elif mutation == "different_candidate":
        request["selection"]["candidate_hash"] = "sha256:" + "1" * 64
    elif mutation == "different_run":
        request["selection"]["run_ref"] = "sha256:" + "1" * 64
    else:
        request["selection"]["candidate_hash"] = True
    with pytest.raises(ValueError):
        flow.service.prepare_refinement(request)
    assert not list(flow.service.records.iterdir())


def test_another_workspace_cannot_adopt_same_valid_design_closure(flow):
    service = workflows.WorkflowService(flow.root / "different-store", artifact_root=flow.root)
    with pytest.raises(ValueError, match="not from this workspace store"):
        service.prepare_refinement(flow.request)
    assert not list(service.records.iterdir())


@pytest.mark.parametrize(
    "name", ["design", "source.chem", "subject.json", "spec.json", "contract.json"]
)
@pytest.mark.parametrize("action", ["read", "approve_refinement", "submit"])
def test_each_source_closure_artifact_is_rechecked_before_use(flow, name, action):
    record = prepare(flow)
    if action == "submit":
        flow.service.approve_refinement(record["reference"])
    path = flow.saved_design if name == "design" else flow.root / name
    path.write_bytes(path.read_bytes() + b"\n")
    with pytest.raises(ValueError, match="bytes changed"):
        getattr(flow.service, action)(record["reference"])
    assert not flow.pending and not flow.calls


@pytest.mark.parametrize(
    "field", ["source", "source_hash", "selection", "version", "reference", "attachments"]
)
def test_saved_workflow_binding_tamper_cannot_issue_approval(flow, field):
    record = prepare(flow)
    path = flow.service._path(record["reference"])
    retained = flow.service.store._read(path)
    retained[field] = {} if field in {"selection", "attachments"} else "altered"
    if field == "attachments":
        retained[field] = {"extra": "altered"}
    flow.service.store._write(path, retained)
    with pytest.raises(ValueError):
        flow.service.approve_refinement(record["reference"])
    assert not list(flow.service.store.approvals.iterdir())


def test_historical_read_survives_current_worker_drift_but_approval_fails(flow):
    record = prepare(flow)
    flow.worker["script_sha256"] = "0" * 64
    reopened = workflows.WorkflowService(flow.service.store.root, artifact_root=flow.root)
    assert reopened.read(record["reference"]) == record
    with pytest.raises(ValueError, match="worker or launch chain changed"):
        reopened.approve_refinement(record["reference"])


def test_uncommitted_output_is_never_projected(flow):
    record = finish(flow)
    job = flow.service.store.load_job(record["job"]["job_id"])
    job.update(status="running", result_hash=None)
    flow.service.store.save_job(job)
    read = flow.service.read(record["reference"])
    assert read["state"] == "running" and "result" not in read
    assert read["refinement_view"] is None


@pytest.mark.parametrize("target", ["result", "output", "raw", "absent_output", "absent_raw"])
def test_committed_and_transitive_scientific_bytes_gate_view(flow, target):
    record = finish(flow)
    run = flow.service.store.runs / record["job"]["job_id"]
    if target == "result":
        path = run / "result.json"
        value = json.loads(path.read_bytes())
        value["evidence_eligible"] = False
        write(path, value)
    else:
        path = run / "worker-result.json"
        if target in {"raw", "absent_raw"}:
            path = flow.root / record["result"]["scientific_result"]["raw_artifacts"][0]["path"]
        if target.startswith("absent"):
            path.unlink()
        else:
            path.write_bytes(path.read_bytes() + b"\n")
    with pytest.raises(ValueError, match="EVIDENCE_CORRUPT"):
        flow.service.read(record["reference"])


def test_active_refinement_cannot_renew_approval(flow):
    record = prepare(flow)
    flow.service.approve_refinement(record["reference"])
    flow.service.submit(record["reference"])
    with pytest.raises(ValueError, match="EXECUTION_BUSY"):
        flow.service.approve_refinement(record["reference"])
    assert len(flow.pending) == 1 and not flow.calls


def test_reference_only_approval_cannot_approve_legacy_workflow(tmp_path):
    service = workflows.WorkflowService(tmp_path / "legacy", artifact_root=tmp_path)
    plan = build_mock_resolved_plan()
    service.store.save_plan(plan)
    record = {"resolved_plan_hash": plan["resolved_plan_hash"], "state": "prepared"}
    reference = content_hash(record)
    service.store._write(service._path(reference), record)
    with pytest.raises(ValueError, match="Design refinement workflow"):
        service.approve_refinement(reference)
    assert not list(service.store.approvals.iterdir())


@pytest.mark.parametrize("artifact", ["design", "source.chem"])
def test_genuine_design_source_drift_blocks_read_but_not_owned_cancellation(flow, artifact):
    record = prepare(flow)
    reference = record["reference"]
    flow.service.approve_refinement(reference)
    private = flow.service.store._read(flow.service._path(reference))
    job = {
        "job_id": "b" * 32,
        "resolved_plan_hash": private["resolved_plan_hash"],
        "approval_token": private["approval_token"],
        "owner": getpass.getuser(),
        "workspace": str(flow.service.store.root),
        "status": "running",
        "submitted_at": "synthetic retained running job; no process started",
    }
    flow.service.store.save_job(job)
    path = flow.saved_design if artifact == "design" else flow.root / artifact
    path.write_bytes(path.read_bytes() + b"\n")
    with pytest.raises(ValueError, match="bytes changed"):
        flow.service.read(reference)
    assert flow.service.cancel(reference) == {
        "job_id": job["job_id"],
        "status": "cancellation_requested",
    }
    assert (flow.service.store.runs / job["job_id"] / "cancel.request").is_file()
    assert not flow.calls and not flow.pending


@pytest.fixture
def cancellation_only(tmp_path, monkeypatch):
    """Synthetic private job metadata only; no registry/native dependencies."""
    service = workflows.WorkflowService(tmp_path / "store", artifact_root=tmp_path)
    record = {"resolved_plan_hash": "sha256:" + "1" * 64, "approval_token": "a" * 32}
    reference = content_hash(record)
    service.store._write(service._path(reference), record)
    job = {
        "job_id": "b" * 32,
        **record,
        "owner": getpass.getuser(),
        "workspace": str(service.store.root),
        "status": "running",
        "submitted_at": "2026-09-13T00:00:00Z",
    }
    service.store.save_job(job)

    def unavailable(*_args, **_kwargs):
        pytest.fail("Cancellation must not read scientific data, plan or approval")

    monkeypatch.setattr(service, "read", unavailable)
    monkeypatch.setattr(service.store, "load_plan", unavailable)
    monkeypatch.setattr(service.store, "load_approval", unavailable)
    return service, reference, job


def test_cancellation_only_private_job_does_not_require_scientific_data(cancellation_only):
    service, reference, job = cancellation_only
    assert service.cancel(reference) == {
        "job_id": job["job_id"],
        "status": "cancellation_requested",
    }
    assert (service.store.runs / job["job_id"] / "cancel.request").is_file()


@pytest.mark.parametrize(
    "field", ["owner", "workspace", "job_id", "approval_token", "resolved_plan_hash"]
)
def test_cancellation_only_rejects_other_private_job_bindings(cancellation_only, field):
    service, reference, job = cancellation_only
    wrong = copy.deepcopy(job)
    wrong[field] = "different"
    service.store._write(service.store.jobs / (job["job_id"] + ".json"), wrong)
    with pytest.raises(ValueError, match=r"JOB_NOT_OWNED|NEEDS_INPUT"):
        service.cancel(reference)
    assert not (service.store.runs / job["job_id"] / "cancel.request").exists()


def test_cancellation_only_returns_terminal_state_without_creating_cancel_file(cancellation_only):
    service, reference, job = cancellation_only
    job["status"] = "timeout"
    service.store.save_job(job)
    assert service.cancel(reference) == {"job_id": job["job_id"], "status": "timeout"}
    assert not (service.store.runs / job["job_id"] / "cancel.request").exists()


def test_cancellation_only_prefers_bound_running_job_over_later_terminal(cancellation_only):
    service, reference, job = cancellation_only
    later = {**job, "job_id": "c" * 32, "submitted_at": "2026-09-14", "status": "failed"}
    service.store.save_job(later)
    assert service.cancel(reference)["job_id"] == job["job_id"]
    assert not (service.store.runs / later["job_id"] / "cancel.request").exists()


@pytest.mark.parametrize("refinement", [False, True])
def test_result_reader_dispatch_only_uses_bound_refinement_api(tmp_path, monkeypatch, refinement):
    """Reader routing only; plan validation is injected, no registry or scientific claim."""
    service = workflows.WorkflowService(tmp_path / "store", artifact_root=tmp_path)
    plan = {
        "kind": "molecular_refinement" if refinement else "mock",
        "resolved_plan_hash": "sha256:" + "1" * 64,
    }
    record = {"resolved_plan_hash": plan["resolved_plan_hash"], "approval_token": "a" * 32}
    reference = content_hash(record)
    service.store._write(service._path(reference), record)
    result = {"execution_status": "timeout", "scientific_result": None, "evidence_eligible": False}
    job = {
        **record,
        "job_id": "b" * 32,
        "submitted_at": "synthetic",
        "status": "timeout",
        "result_hash": content_hash(result),
    }
    service.store.save_job(job)
    path = service.store.run_directory(job["job_id"]) / "result.json"
    service.store._write(path, result)
    monkeypatch.setattr(service.store, "load_plan", lambda _reference: plan)
    monkeypatch.setattr(service, "_verify_refinement_workflow", lambda *_args: None)
    original = service.store._read
    calls = []

    def default_read(target):
        if target == path:
            calls.append("default")
            assert refinement is False
        return original(target)

    def refinement_read(job_id):
        assert refinement is True and job_id == job["job_id"]
        calls.append("refinement")
        return original(path)

    monkeypatch.setattr(service.store, "_read", default_read)
    monkeypatch.setattr(service.store, "read_refinement_result", refinement_read, raising=False)
    observed = service.read(reference)
    assert observed["result"] == result
    assert calls == ["refinement" if refinement else "default"]
    if refinement:
        assert observed["refinement_view"] is None
    else:
        assert "refinement_view" not in observed
