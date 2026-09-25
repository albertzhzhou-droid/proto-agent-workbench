"""Client parity, ownership, cancellation and durable project acceptance."""

from __future__ import annotations

import copy
import json
import threading
import time
from pathlib import Path

import pytest

from chem_workbench import execution
from chem_workbench.execution import (
    ExecutionStore,
    build_mock_resolved_plan,
    cancel_job,
    issue_approval,
    recover_interrupted_jobs,
    submit_run,
)
from chem_workbench.tool_gateway import invoke_tool
from chem_workbench.visualization import compile_snapshot, content_hash
from chem_workbench.workflows import ProjectStore, WorkflowService

ROOT = Path(__file__).resolve().parents[1]


def request() -> dict:
    return {
        "source": (ROOT / "examples/crystals/fcc-copper.chem").read_text(),
        "attachments": {
            "structures/fcc-copper.cif": (
                ROOT / "examples/crystals/structures/fcc-copper.cif"
            ).read_text()
        },
        "object_id": "fcc_copper",
        "profile": "copper",
        "scales": [0.98, 1.0, 1.02],
    }


def test_workflow_requires_approval_and_rejects_source_drift(tmp_path: Path) -> None:
    service = WorkflowService(tmp_path)
    data = request()
    prepared = service.prepare(data)
    with pytest.raises(ValueError, match="APPROVAL_REQUIRED"):
        service.submit(prepared["reference"])
    with pytest.raises(ValueError, match="APPROVAL_STALE"):
        service.approve(prepared["reference"], data["source"] + "\n", data["attachments"])
    with pytest.raises(ValueError, match="unexpected"):
        service.prepare({**data, "approved": True})
    approved = service.approve(prepared["reference"], data["source"], data["attachments"])
    assert approved["state"] == "approved"
    assert "approval_token" not in json.dumps(approved)
    assert WorkflowService(tmp_path).read(prepared["reference"])["plan"] == prepared["plan"]


def test_workflow_completes_real_batch_and_retains_results(tmp_path: Path) -> None:
    service = WorkflowService(tmp_path)
    data = request()
    record = service.prepare(data)
    reference = record["reference"]
    service.approve(reference, data["source"], data["attachments"])
    service.submit(reference)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        record = service.read(reference)
        if record["state"] in {"succeeded", "failed"}:
            break
        time.sleep(0.05)
    assert record["state"] == "succeeded", record
    assert len(record["result"]["ranking"]) == 3
    assert "approval_token" not in json.dumps(record)
    assert WorkflowService(tmp_path).read(reference)["result"] == record["result"]
    result_path = service.store.runs / record["job"]["job_id"] / "result.json"
    altered = json.loads(result_path.read_text())
    altered["ranking"][0]["energy_eV_per_atom"] = "-999"
    result_path.write_text(json.dumps(altered))
    with pytest.raises(ValueError, match="EVIDENCE_CORRUPT"):
        service.read(reference)


def mock_workflow(tmp_path: Path) -> tuple[WorkflowService, str, dict]:
    service = WorkflowService(tmp_path)
    plan = build_mock_resolved_plan()
    service.store.save_plan(plan)
    approval = issue_approval(service.store, plan["resolved_plan_hash"], actor="test")
    record = {
        "state": "approved",
        "resolved_plan_hash": plan["resolved_plan_hash"],
        "approval_token": approval["token"],
    }
    reference = content_hash(record)
    service.store._write(service._path(reference), {**record, "reference": reference})
    return service, reference, approval


@pytest.mark.parametrize("partial_json", [False, True], ids=["complete-json", "partial-json"])
def test_result_publication_waits_for_job_commit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, partial_json: bool
) -> None:
    service, reference, approval = mock_workflow(tmp_path)
    published, commit = threading.Event(), threading.Event()
    original_write = service.store._write
    published_paths = []
    jobs, errors = [], []

    def mock_worker(_worker, _input_path, output_path, **_limits):
        output_path.write_text(json.dumps({"worker": "mock", "marker": "publication-test"}))
        return {"status": "succeeded", "returncode": 0, "_stdout": b"", "_stderr": b""}

    def pause_result_write(path, value):
        if path.name == "result.json":
            if partial_json:
                path.write_text('{"execution_status":', encoding="utf-8")
            else:
                original_write(path, value)
            published_paths.append(path)
            published.set()
            assert commit.wait(10), "test did not release the result publication barrier"
        original_write(path, value)

    def submit():
        try:
            jobs.append(submit_run(service.store, approval["token"]))
        except Exception as error:
            errors.append(error)

    monkeypatch.setattr(execution, "run_worker", mock_worker)
    monkeypatch.setattr(service.store, "_write", pause_result_write)
    thread = threading.Thread(target=submit)
    thread.start()
    try:
        assert published.wait(10), "successful result did not use atomic store publication"
        pending_bytes = published_paths[0].read_bytes()
        pending = service.read(reference)
        assert pending["state"] == "running"
        assert "result_hash" not in pending["job"]
        assert "result" not in pending
        assert service.list()[0]["state"] == "running"
        assert published_paths[0].read_bytes() == pending_bytes
    finally:
        commit.set()
        thread.join(10)
    assert not thread.is_alive()
    assert not errors
    assert len(jobs) == 1
    completed = service.read(reference)
    assert completed["state"] == "succeeded"
    assert completed["result"]["marker"] == "publication-test"
    assert completed["job"]["result_hash"] == content_hash(completed["result"])
    assert completed["job"]["evidence_eligible"] is False
    assert service.store.load_approval(approval["token"])["launches_used"] == 1


@pytest.mark.parametrize("status", ["interrupted", "failed"])
@pytest.mark.parametrize("partial_json", [False, True], ids=["complete-json", "partial-json"])
def test_uncommitted_terminal_result_is_retained_unexposed(
    tmp_path: Path, status: str, partial_json: bool
) -> None:
    service, reference, approval = mock_workflow(tmp_path)
    job = {
        "job_id": "a" * 32,
        "status": status,
        "resolved_plan_hash": approval["resolved_plan_hash"],
        "approval_token": approval["token"],
        "submitted_at": 1,
        "evidence_eligible": False,
    }
    service.store.save_job(job)
    path = service.store.run_directory(job["job_id"]) / "result.json"
    raw = '{"execution_status":' if partial_json else '{"execution_status":"succeeded"}'
    path.write_text(raw, encoding="utf-8")
    record = service.read(reference)
    assert record["state"] == status
    assert "result" not in record
    assert record["job"]["evidence_eligible"] is False
    assert service.list()[0]["state"] == status
    assert path.read_text(encoding="utf-8") == raw


@pytest.mark.parametrize("hash_field", ["absent", "null"])
@pytest.mark.parametrize("result_present", [False, True], ids=["no-result", "result-present"])
def test_succeeded_job_requires_committed_result_hash(
    tmp_path: Path, hash_field: str, result_present: bool
) -> None:
    service, reference, approval = mock_workflow(tmp_path)
    job = {
        "job_id": "c" * 32,
        "status": "succeeded",
        "resolved_plan_hash": approval["resolved_plan_hash"],
        "approval_token": approval["token"],
        "submitted_at": 1,
        "evidence_eligible": True,
    }
    if hash_field == "null":
        job["result_hash"] = None
    service.store.save_job(job)
    path = service.store.run_directory(job["job_id"]) / "result.json"
    if result_present:
        service.store._write(path, {"execution_status": "succeeded", "marker": "uncommitted"})
    retained_bytes = path.read_bytes() if result_present else None
    with pytest.raises(
        ValueError, match="EVIDENCE_CORRUPT: succeeded job has no committed result hash"
    ):
        service.read(reference)
    assert service.list()[0]["state"] == "stale"
    assert path.exists() is result_present
    if result_present:
        assert path.read_bytes() == retained_bytes


@pytest.mark.parametrize("status", ["succeeded", "failed"])
@pytest.mark.parametrize("corruption", ["modified", "missing", "partial-json"])
def test_committed_result_integrity_remains_required(
    tmp_path: Path, status: str, corruption: str
) -> None:
    service, reference, approval = mock_workflow(tmp_path)
    result = {"execution_status": status, "marker": "committed", "evidence_eligible": False}
    job = {
        "job_id": "b" * 32,
        "status": status,
        "resolved_plan_hash": approval["resolved_plan_hash"],
        "approval_token": approval["token"],
        "submitted_at": 1,
        "result_hash": content_hash(result),
    }
    path = service.store.run_directory(job["job_id"]) / "result.json"
    service.store._write(path, result)
    service.store.save_job(job)
    assert service.read(reference)["result"] == result
    if corruption == "missing":
        path.unlink()
    elif corruption == "partial-json":
        path.write_text('{"execution_status":', encoding="utf-8")
    else:
        service.store._write(path, {**result, "marker": "modified"})
    with pytest.raises(ValueError, match="EVIDENCE_CORRUPT"):
        service.read(reference)
    assert service.list()[0]["state"] == "stale"


def test_owned_job_can_be_cancelled_during_execution(tmp_path: Path) -> None:
    store = ExecutionStore(tmp_path)
    plan = build_mock_resolved_plan(sleep_seconds=30)
    store.save_plan(plan)
    approval = issue_approval(store, plan["resolved_plan_hash"], actor="test")
    results = []
    thread = threading.Thread(target=lambda: results.append(submit_run(store, approval["token"])))
    thread.start()
    deadline = time.monotonic() + 10
    while not list(store.jobs.glob("*.json")) and time.monotonic() < deadline:
        time.sleep(0.01)
    job = store._read(next(store.jobs.glob("*.json")))
    assert cancel_job(store, job["job_id"])["status"] == "cancellation_requested"
    thread.join(timeout=10)
    assert not thread.is_alive()
    assert results[0]["status"] == "cancelled"
    assert results[0]["evidence_eligible"] is False


def test_cross_workspace_approval_is_rejected(tmp_path: Path) -> None:
    left, right = ExecutionStore(tmp_path / "a"), ExecutionStore(tmp_path / "b")
    plan = build_mock_resolved_plan()
    left.save_plan(plan)
    right.save_plan(plan)
    approval = issue_approval(left, plan["resolved_plan_hash"], actor="test")
    right.save_approval(approval)
    with pytest.raises(ValueError, match="another workspace"):
        submit_run(right, approval["token"])


def test_recovery_never_replays_interrupted_jobs(tmp_path: Path) -> None:
    store = ExecutionStore(tmp_path)
    job = {"job_id": "a" * 32, "status": "running", "evidence_eligible": True}
    store.save_job(job)
    assert recover_interrupted_jobs(store) == [job["job_id"]]
    assert store.load_job(job["job_id"])["status"] == "interrupted"
    assert store.load_job(job["job_id"])["evidence_eligible"] is False


def test_project_revisions_are_immutable_and_hash_checked(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path)
    value = {
        "name": "Copper",
        "source": request()["source"],
        "attachments": request()["attachments"],
    }
    first = store.save(value)
    second = store.save({**value, "source": value["source"] + "\n"})
    assert first["revision"] != second["revision"]
    assert len(ProjectStore(tmp_path).list()) == 2
    path = store.directory / (first["revision"][7:] + ".json")
    first["name"] = "tampered"
    path.write_text(json.dumps(first))
    with pytest.raises(ValueError, match="mismatch"):
        store.list()


def test_cli_and_service_resolve_identical_plans(tmp_path: Path, run_chem) -> None:
    data = request()
    attachments = tmp_path / "attachments.json"
    attachments.write_text(json.dumps(data["attachments"]))
    destination = tmp_path / "workflow.json"
    result = run_chem(
        "prepare",
        ROOT / "examples/crystals/fcc-copper.chem",
        "--profile",
        "copper",
        "--object-id",
        "fcc_copper",
        "--attachments",
        attachments,
        "--store",
        tmp_path / "store",
        "--output",
        destination,
    )
    assert result.returncode == 0, result.stderr
    from_cli = json.loads(destination.read_text())
    direct = WorkflowService(tmp_path / "store").prepare(data)
    assert from_cli["plan"] == direct["plan"]
    assert from_cli["reference"] == direct["reference"]
    approval = run_chem("approve", destination, "--store", tmp_path / "store")
    assert approval.returncode == 0, approval.stderr
    assert WorkflowService(tmp_path / "store").read(direct["reference"])["state"] == "approved"


def test_new_source_context_does_not_reuse_water_approval(tmp_path: Path) -> None:
    service = WorkflowService(tmp_path)
    geometry = json.loads((ROOT / "examples/molecules/water-hf-sto3g-geometry.json").read_text())
    data = {
        "source": (ROOT / "examples/molecules/water.chem").read_text(),
        "attachments": {},
        "profile": "water",
        "object_id": "water",
        "geometry": geometry,
    }
    first = service.prepare(data)
    service.approve(first["reference"], data["source"], {})
    second = service.prepare({**data, "source": data["source"] + "\n"})
    assert first["plan"] == second["plan"]
    assert first["reference"] != second["reference"]
    assert second["state"] == "prepared"
    with pytest.raises(ValueError, match="APPROVAL_REQUIRED"):
        service.submit(second["reference"])


def test_source_conditions_cannot_be_silently_overridden(tmp_path: Path) -> None:
    data = request()
    data["source"] = data["source"].replace("temperature 0", "temperature 300")
    with pytest.raises(ValueError, match="NEEDS_INPUT: valid compiled source"):
        WorkflowService(tmp_path).prepare(data)


def water_request() -> dict:
    return {
        "source": (ROOT / "examples/molecules/water.chem").read_text(),
        "attachments": {},
        "profile": "water",
        "object_id": "water",
        "geometry": json.loads(
            (ROOT / "examples/molecules/water-hf-sto3g-geometry.json").read_text()
        ),
    }


def proposal_record(data: dict) -> dict:
    """Create a host-tool test record, without model inference or execution."""
    snapshot = compile_snapshot(data["source"], data["attachments"])
    name = "plan_water_single_point" if data["profile"] == "water" else "plan_cu_lattice_scan"
    arguments = {"object_id": data["object_id"]}
    if data["profile"] == "copper":
        arguments["scale_factors"] = data["scales"]
    return {
        "version": "orchestration/v1",
        "source_hash": snapshot.source_sha256,
        "source_semantic_hash": snapshot.semantic_hash,
        "state": "REPORTED",
        "execution_authorized": False,
        "trace": [
            {
                "action": {
                    "action": name,
                    "object_id": data["object_id"],
                    "scale_factors": data.get("scales", []),
                    "message": "Test proposal",
                },
                "output": invoke_tool(name, arguments, snapshot),
            }
        ],
    }


def retain_orchestration(service: WorkflowService, record: dict) -> str:
    record = copy.deepcopy(record)
    record["record_hash"] = content_hash(record)
    directory = service.store.root / "orchestrations"
    directory.mkdir(exist_ok=True)
    service.store._write(directory / (record["record_hash"][7:] + ".json"), record)
    return record["record_hash"]


@pytest.mark.parametrize("profile", ["water", "copper"])
def test_orchestration_binding_keeps_exact_direct_plan_and_requires_approval(tmp_path, profile):
    data = water_request() if profile == "water" else request()
    direct = WorkflowService(tmp_path / "direct").prepare(data)
    service = WorkflowService(tmp_path / "model")
    reference = retain_orchestration(service, proposal_record(data))
    linked = service.prepare({**data, "orchestration_ref": reference})
    assert linked["plan"] == direct["plan"]
    assert linked["orchestration_ref"] == reference
    with pytest.raises(ValueError, match="APPROVAL_REQUIRED"):
        service.submit(linked["reference"])


def test_changed_cif_cannot_reuse_orchestration_with_unchanged_source_text(tmp_path):
    data = request()
    service = WorkflowService(tmp_path)
    reference = retain_orchestration(service, proposal_record(data))
    old = compile_snapshot(data["source"], data["attachments"])
    data["attachments"]["structures/fcc-copper.cif"] = data["attachments"][
        "structures/fcc-copper.cif"
    ].replace("3.6149", "3.6200")
    changed = compile_snapshot(data["source"], data["attachments"])
    assert old.source_sha256 == changed.source_sha256
    assert old.semantic_hash != changed.semantic_hash
    with pytest.raises(ValueError, match="different source or imports"):
        service.prepare({**data, "orchestration_ref": reference})
    assert not list(service.records.glob("*.json"))


@pytest.mark.parametrize(
    "mutation",
    ["inspection", "refusal", "target", "scale_arguments", "output", "data_hash", "authority"],
)
def test_unrelated_or_invalid_model_record_cannot_be_plan_provenance(tmp_path, mutation):
    data = request()
    service = WorkflowService(tmp_path)
    record = proposal_record(data)
    entry = record["trace"][0]
    if mutation == "inspection":
        entry["action"]["action"] = "object_inspect"
        entry["action"]["scale_factors"] = []
        entry["output"] = invoke_tool(
            "object_inspect",
            {"object_id": data["object_id"]},
            compile_snapshot(data["source"], data["attachments"]),
        )
    elif mutation == "refusal":
        record["state"] = "NEEDS_INPUT"
        record["trace"] = []
    elif mutation == "target":
        entry["action"]["object_id"] = "different_copper"
    elif mutation == "scale_arguments":
        entry["action"]["scale_factors"] = [0.99, 1, 1.01]
    elif mutation == "output":
        entry["output"]["data"]["subject_ref"] = "different_copper"
        entry["output"]["data_hash"] = content_hash(entry["output"]["data"])
    elif mutation == "data_hash":
        entry["output"]["data_hash"] = "sha256:" + "0" * 64
    else:
        entry["output"]["authority"] = "model_claim"
    reference = retain_orchestration(service, record)
    with pytest.raises(ValueError, match="APPROVAL_STALE"):
        service.prepare({**data, "orchestration_ref": reference})


def test_water_orchestration_cannot_replace_explicit_coordinates(tmp_path):
    data = water_request()
    service = WorkflowService(tmp_path)
    reference = retain_orchestration(service, proposal_record(data))
    data["geometry"]["atoms"][1][3] = "0.9600"
    # This remains a valid direct calculation, but not the model's installation fixture.
    assert service.prepare(data)["state"] == "prepared"
    with pytest.raises(ValueError, match="explicit geometry differs"):
        service.prepare({**data, "orchestration_ref": reference})


def test_changed_copper_candidates_cannot_reuse_model_proposal_provenance(tmp_path):
    data = request()
    service = WorkflowService(tmp_path)
    reference = retain_orchestration(service, proposal_record(data))
    with pytest.raises(ValueError, match="proposal differs"):
        service.prepare({**data, "scales": [0.99, 1.0, 1.01], "orchestration_ref": reference})


def test_linked_provenance_is_not_lost_or_inherited_from_existing_direct_workflow(tmp_path):
    data = request()
    service = WorkflowService(tmp_path)
    direct = service.prepare(data)
    service.approve(direct["reference"], data["source"], data["attachments"])
    reference = retain_orchestration(service, proposal_record(data))
    linked = service.prepare({**data, "orchestration_ref": reference})
    assert linked["reference"] != direct["reference"]
    assert linked["plan"] == direct["plan"]
    assert linked["orchestration_ref"] == reference
    assert linked["state"] == "prepared"
    assert service.prepare(data)["orchestration_ref"] is None
    assert service.prepare({**data, "orchestration_ref": reference}) == linked
