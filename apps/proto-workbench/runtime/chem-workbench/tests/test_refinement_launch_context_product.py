"""Real 34-atom retained request shape; synthetic host reservation/approval only.

No native import, model, backend, supervisor, process or scientific execution.
The source and runtime directories below are independent temporary fixtures.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import sys
from dataclasses import asdict, replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from test_refinement_governed_plan_product import case as case
from test_refinement_governed_plan_product import retained_case as retained_case

from chem_workbench.molecular_refinement import validate_refinement_spec
from chem_workbench.refinement_execution import governed_plan as facade
from chem_workbench.refinement_execution import launch_context as launch
from chem_workbench.refinement_execution.disk_budget import DiskBudget
from chem_workbench.refinement_execution.execution_contract import (
    build_worker_request,
    seal_execution_contract,
    validate_execution_contract,
)
from chem_workbench.refinement_execution.host_subject_admission import build_host_admission
from chem_workbench.refinement_execution.refinement_plan import (
    PlanContext,
    build_resolved_plan,
    content_hash,
    validate_plan,
)

ROOT = Path(__file__).resolve().parents[1]
INPUT = ROOT / "tests/fixtures/refinement_evidence_product/input.json"


def write(root, relative, body):
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = body if isinstance(body, bytes) else json.dumps(body, allow_nan=False).encode()
    path.write_bytes(raw)
    return {"path": relative, "sha256": hashlib.sha256(raw).hexdigest()}


@pytest.fixture
def fixture(tmp_path):
    root = tmp_path / "artifacts"
    code = tmp_path / "installed-code"
    runtime = tmp_path / "isolated-runtime"
    for path in (root / "jobs/run-1", code, runtime):
        path.mkdir(parents=True)
    spec = json.loads(INPUT.read_bytes())["spec"]
    assert len(spec["geometry"]["atoms"]) == 34
    contract = seal_execution_contract(spec, "gradient")
    request = build_worker_request(spec, contract)
    worker = {
        "kind": "psi4_refinement",
        "script": "worker_refinement_psi4.py",
        "environment": {"prefix": str(runtime), "fixture_only": True},
    }
    subject = {"scope": "synthetic host closure for transport tests", "geometry": spec["geometry"]}

    def verify_subject(value, actual_spec):
        assert value == subject and actual_spec == spec

    context = PlanContext(
        subject=subject,
        spec=spec,
        worker_identity=worker,
        mode="gradient",
        resource_policy={key: spec["resources"][key] for key in launch.RESOURCE_FIELDS},
        validate_spec=validate_refinement_spec,
        validate_subject_spec=verify_subject,
        execution_contract=contract,
        validate_contract=validate_execution_contract,
    )
    plan = build_resolved_plan(context)
    input_ref = write(root, "jobs/run-1/input.json", request)
    source_ref = write(code, "package/worker.py", b"# synthetic installed source\n")
    admission_ref = write(
        root,
        "admission.json",
        {"spec_hash": spec["spec_hash"], "scope": "synthetic host admission for transport tests"},
    )
    calls = []

    def authorize(actual_request, actual_context):
        assert actual_request == request
        assert actual_context.job_id == "job-1"
        assert actual_context.approval_id == "sha256:" + "a" * 64
        calls.append(actual_context.run_nonce)

    kwargs = {
        "root": root,
        "code_root": code,
        "runtime_root": runtime,
        "job_id": "job-1",
        "approval_id": "sha256:" + "a" * 64,
        "run_id": "run-1",
        "run_directory": "jobs/run-1",
        "plan": plan,
        "plan_context": context,
        "input_artifact": input_ref,
        "trusted_subject_admission_ref": admission_ref,
        "source_identity": {source_ref["path"]: source_ref["sha256"]},
        "native_task_config": {
            "ncores": spec["resources"]["threads"],
            "memory": spec["resources"]["memory_bytes"] / 1024**3 * 0.6,
            "retries": 0,
            "scratch_directory": str(root / "jobs/run-1/scratch"),
        },
        "validate_host_plan": validate_plan,
        "verify_host_admission": authorize,
    }
    result = SimpleNamespace(
        root=root,
        code=code,
        runtime=runtime,
        request=request,
        context=context,
        plan=plan,
        create=kwargs,
        calls=calls,
        authorize=authorize,
    )
    result.load = lambda sideband, **changes: launch.load_launch_context(
        **(
            {
                "root": root,
                "code_root": code,
                "runtime_root": runtime,
                "input_path": root / input_ref["path"],
                "output_path": root / "jobs/run-1/worker-result.json",
                "request": request,
                "environment": sideband.environment,
                "verify_host_admission": authorize,
            }
            | changes
        )
    )
    return result


def reseal_sidecar(fixture, sideband, mutate):
    """Explicitly simulate an altered controlled transport, never host authority."""
    reference = sideband.context.sidecar_reference
    record = json.loads((fixture.root / reference["path"]).read_bytes())
    mutate(record)
    updated = write(fixture.root, reference["path"], record)
    environment = {**sideband.environment, launch.ENV_SHA256: updated["sha256"]}
    return replace(sideband, environment=environment)


def test_roundtrip_separates_roots_and_does_not_import_native(fixture):
    before = set(sys.modules)
    originals = copy.deepcopy((fixture.plan, fixture.request, fixture.create["source_identity"]))
    sideband = launch.create_launch_context(**fixture.create)
    assert set(sideband.environment) == launch.ENVIRONMENT_KEYS
    assert set(sideband.environment.values()).isdisjoint({fixture.create["approval_id"]})
    assert sideband.context.sidecar_reference["path"] == "jobs/.run-1-refinement-launch.json"
    context = fixture.load(sideband)
    assert context.root == fixture.root and context.code_root == fixture.code
    assert context.runtime_root == fixture.runtime
    assert context.root != context.code_root != context.runtime_root
    assert context.plan_context == fixture.plan
    assert context.claim_reference["path"] == "jobs/.run-1-refinement-launch.claimed.json"
    launch.verify_launch_context(fixture.request, context)
    launch.verify_launch_context(fixture.request, context)
    assert len(fixture.calls) == 2
    assert (fixture.plan, fixture.request, fixture.create["source_identity"]) == originals
    assert not {"psi4", "qcengine", "qcelemental", "dftd3", "optking"} & (set(sys.modules) - before)
    assert list((fixture.root / "jobs/run-1").iterdir()) == [fixture.root / "jobs/run-1/input.json"]


def test_same_launch_and_fixed_sidecar_cannot_be_reused(fixture):
    sideband = launch.create_launch_context(**fixture.create)
    fixture.load(sideband)
    with pytest.raises(FileExistsError):
        fixture.load(sideband)
    with pytest.raises(FileExistsError):
        launch.create_launch_context(**fixture.create)


def test_nonce_is_generated_by_host_not_supplied_by_request(fixture):
    first = launch.create_launch_context(**fixture.create)
    (fixture.root / "jobs/run-2").mkdir()
    second_input = write(fixture.root, "jobs/run-2/input.json", fixture.request)
    args = {
        **fixture.create,
        "run_id": "run-2",
        "run_directory": "jobs/run-2",
        "input_artifact": second_input,
        "native_task_config": {
            **fixture.create["native_task_config"],
            "scratch_directory": str(fixture.root / "jobs/run-2/scratch"),
        },
    }
    second = launch.create_launch_context(**args)
    assert first.context.run_nonce != second.context.run_nonce
    assert len(first.context.run_nonce) == 64
    wrong = {**first.environment, launch.ENV_NONCE: second.context.run_nonce}
    with pytest.raises(ValueError, match="nonce"):
        fixture.load(first, environment=wrong)


@pytest.mark.parametrize(
    "key,value",
    [
        (launch.ENV_PATH, "../escape.json"),
        (launch.ENV_PATH, "jobs/../sidecar.json"),
        (launch.ENV_PATH, "C:/escape.json"),
        (launch.ENV_SHA256, "f" * 64),
        (launch.ENV_NONCE, "0" * 64),
        (launch.ENV_NONCE, ""),
    ],
)
def test_environment_binding_and_path_rejection(fixture, key, value):
    sideband = launch.create_launch_context(**fixture.create)
    with pytest.raises(ValueError):
        fixture.load(sideband, environment={**sideband.environment, key: value})


@pytest.mark.parametrize(
    "change",
    [
        lambda env: env.pop(launch.ENV_NONCE),
        lambda env: env.update({launch.ENV_PATH.lower(): env[launch.ENV_PATH]}),
        lambda env: env.update({"CHEM_REFINEMENT_CONTEXT_APPROVED": "true"}),
    ],
)
def test_incomplete_or_ambiguous_controlled_environment_is_rejected(fixture, change):
    sideband = launch.create_launch_context(**fixture.create)
    environment = dict(sideband.environment)
    change(environment)
    with pytest.raises(ValueError, match="environment"):
        fixture.load(sideband, environment=environment)


@pytest.mark.parametrize(
    "field,value",
    [
        ("host_approved", True),
        ("approval_id", "sha256:" + "a" * 64),
        ("run_nonce", "a" * 64),
        ("context", {}),
        ("environment", {}),
    ],
)
def test_request_cannot_add_authority_fields(fixture, field, value):
    sideband = launch.create_launch_context(**fixture.create)
    with pytest.raises(ValueError):
        fixture.load(sideband, request={**fixture.request, field: value})
    assert not (fixture.root / "jobs/.run-1-refinement-launch.claimed.json").exists()


@pytest.mark.parametrize(
    "field", ["root", "code_root", "runtime_root", "input_path", "output_path"]
)
def test_independent_argv_and_root_drift(fixture, field):
    sideband = launch.create_launch_context(**fixture.create)
    value = fixture.root / "other" if field.endswith("path") else fixture.code
    if field == "code_root":
        value = fixture.root
    with pytest.raises((ValueError, FileNotFoundError)):
        fixture.load(sideband, **{field: value})


@pytest.mark.parametrize(
    "mutate",
    [
        lambda record: record.update({"prepared_input_hash": "sha256:" + "e" * 64}),
        lambda record: record.update({"resolved_plan_hash": "sha256:" + "e" * 64}),
        lambda record: record["resource_policy"].update({"threads": True}),
        lambda record: record["native_task_config"].update({"retries": False}),
        lambda record: record["native_task_config"].update({"memory": 1}),
        lambda record: record["native_task_config"].update({"scratch_directory": "elsewhere"}),
        lambda record: record["worker_identity"].update({"script": "worker_other.py"}),
        lambda record: record.update({"output_path": "jobs/other/worker-result.json"}),
        lambda record: record.update({"run_directory": "jobs/other"}),
        lambda record: record.update({"approval_id": "raw-secret-token"}),
        lambda record: record.update({"source_identity": {}}),
        lambda record: record["plan_context"].update({"subject": {"substituted": True}}),
    ],
)
def test_rehashed_transport_does_not_relax_internal_bindings(fixture, mutate):
    sideband = launch.create_launch_context(**fixture.create)
    altered = reseal_sidecar(fixture, sideband, mutate)
    with pytest.raises((ValueError, FileNotFoundError)):
        fixture.load(altered)


def test_rehashed_plan_resource_conflict_is_rejected(fixture):
    sideband = launch.create_launch_context(**fixture.create)

    def mutate(record):
        plan = record["plan_context"]
        plan["resource_ceilings"]["threads"] += 1
        plan["resolved_plan_hash"] = content_hash(
            {key: value for key, value in plan.items() if key != "resolved_plan_hash"}
        )
        record["resource_policy"] = plan["resource_ceilings"]
        record["resolved_plan_hash"] = plan["resolved_plan_hash"]

    with pytest.raises(ValueError):
        fixture.load(reseal_sidecar(fixture, sideband, mutate))


@pytest.mark.parametrize("role", ["input", "source", "admission", "sidecar"])
def test_raw_artifact_tamper_is_detected_before_claim(fixture, role):
    sideband = launch.create_launch_context(**fixture.create)
    paths = {
        "input": fixture.root / fixture.create["input_artifact"]["path"],
        "source": fixture.code / "package/worker.py",
        "admission": fixture.root / "admission.json",
        "sidecar": fixture.root / sideband.context.sidecar_reference["path"],
    }
    path = paths[role]
    path.write_bytes(path.read_bytes() + b" ")
    with pytest.raises(ValueError, match="hash"):
        fixture.load(sideband)
    assert not (fixture.root / "jobs/.run-1-refinement-launch.claimed.json").exists()


@pytest.mark.parametrize("stage", ["create", "load"])
@pytest.mark.parametrize("result", [True, False, {}, "approved"])
def test_verifier_must_return_none_or_raise(fixture, stage, result):
    def callback(request, context):
        return result

    if stage == "create":
        with pytest.raises(ValueError, match="None or raise"):
            launch.create_launch_context(**(fixture.create | {"verify_host_admission": callback}))
        assert not (fixture.root / "jobs/.run-1-refinement-launch.json").exists()
    else:
        sideband = launch.create_launch_context(**fixture.create)
        with pytest.raises(ValueError, match="None or raise"):
            fixture.load(sideband, verify_host_admission=callback)


def test_verifier_rejection_and_mutation_remain_fail_closed(fixture):
    def reject(request, context):
        raise ValueError("synthetic host approval revoked")

    with pytest.raises(ValueError, match="revoked"):
        launch.create_launch_context(**(fixture.create | {"verify_host_admission": reject}))
    sideband = launch.create_launch_context(**fixture.create)

    def mutate(request, context):
        context.source_identity.clear()

    with pytest.raises(ValueError, match="mutation"):
        fixture.load(sideband, verify_host_admission=mutate)


def test_claim_tamper_and_context_mutation_are_detected_on_lifecycle_recheck(fixture):
    context = fixture.load(launch.create_launch_context(**fixture.create))
    with pytest.raises(ValueError):
        launch.verify_launch_context(fixture.request, replace(context, run_nonce="b" * 64))
    path = fixture.root / context.claim_reference["path"]
    path.write_bytes(path.read_bytes() + b" ")
    with pytest.raises(ValueError, match="hash"):
        launch.verify_launch_context(fixture.request, context)


def test_unconsumed_host_context_cannot_be_used_as_worker_context(fixture):
    sideband = launch.create_launch_context(**fixture.create)
    with pytest.raises(ValueError, match="claim required"):
        launch.verify_launch_context(fixture.request, sideband.context)


def test_source_reparse_and_hardlink_are_rejected(fixture):
    sideband = launch.create_launch_context(**fixture.create)
    source = fixture.code / "package/worker.py"
    hardlink = fixture.code / "linked.py"
    os.link(source, hardlink)
    with pytest.raises(ValueError, match="single-link"):
        fixture.load(sideband)


def test_duplicate_json_key_cannot_hide_rehashed_sidecar_fields(fixture):
    sideband = launch.create_launch_context(**fixture.create)
    path = fixture.root / sideband.context.sidecar_reference["path"]
    raw = path.read_bytes()
    raw = raw[:-1] + b',"version":"' + launch.VERSION.encode() + b'"}'
    path.write_bytes(raw)
    environment = {**sideband.environment, launch.ENV_SHA256: hashlib.sha256(raw).hexdigest()}
    with pytest.raises(ValueError, match="duplicate"):
        fixture.load(sideband, environment=environment)


def test_failed_exclusive_write_is_retained_and_not_reusable(fixture, monkeypatch):
    def fail(_descriptor):
        raise OSError("synthetic fsync failure")

    monkeypatch.setattr(launch.os, "fsync", fail)
    with pytest.raises(OSError, match="fsync"):
        launch.create_launch_context(**fixture.create)
    path = fixture.root / "jobs/.run-1-refinement-launch.json"
    assert path.exists()
    with pytest.raises(FileExistsError):
        launch.create_launch_context(**fixture.create)


@pytest.fixture
def governed(case):
    """Real host Design-source admission, synthetic approval and installed identity."""
    root = case["root"]
    code, runtime, run = root / "code", root / "runtime", root / "job-run"
    for path in (code, runtime, run):
        path.mkdir()
    case["observed_worker_identity"]["environment"] = {"prefix": str(runtime)}
    plan = facade.prepare(**case)
    context = facade.context_from_artifacts(
        **{key: value for key, value in case.items() if key != "disk_budget"}
    )
    request = plan["prepared_input"]
    source = write(code, "module.py", b"# synthetic installed source identity\n")
    input_ref = write(root, "job-run/input.json", request)
    admission_ref = write(
        root,
        "host-subject-admission.json",
        build_host_admission(root=root, spec_ref=case["spec_ref"]),
    )

    def authorize(actual, launch_context):
        assert actual == request and launch_context.job_id == "governed-job"
        assert launch_context.approval_id == "sha256:" + "9" * 64

    def validate_host_plan(actual, actual_context):
        assert actual_context is context
        return facade.validate_plan(actual, root, case["observed_worker_identity"])

    args = {
        "root": root,
        "code_root": code,
        "runtime_root": runtime,
        "job_id": "governed-job",
        "approval_id": "sha256:" + "9" * 64,
        "run_id": "governed-run",
        "run_directory": "job-run",
        "plan": plan,
        "plan_context": context,
        "input_artifact": input_ref,
        "trusted_subject_admission_ref": admission_ref,
        "source_identity": {source["path"]: source["sha256"]},
        "native_task_config": {
            "ncores": request["spec"]["resources"]["threads"],
            "memory": request["spec"]["resources"]["memory_bytes"] / 1024**3 * 0.6,
            "retries": 0,
            "scratch_directory": str(run / "scratch"),
        },
        "validate_host_plan": validate_host_plan,
        "verify_host_admission": authorize,
    }
    sideband = launch.create_launch_context(**args)
    validate_args = {
        "root": root,
        "code_root": code,
        "runtime_root": runtime,
        "input_path": root / input_ref["path"],
        "output_path": run / "worker-result.json",
        "request": request,
        "disk_budget": case["disk_budget"],
    }
    load_args = {key: value for key, value in validate_args.items() if key != "disk_budget"}
    load_args.update(environment=sideband.environment, verify_host_admission=authorize)
    return SimpleNamespace(
        root=root,
        plan=plan,
        request=request,
        args=args,
        sideband=sideband,
        validate_args=validate_args,
        load_args=load_args,
        case=case,
    )


def test_genuine_governed_plan_and_subject_admission_roundtrip_before_worker_claim(governed):
    state = governed
    assert len(state.plan["subject"]["geometry"]["atoms"]) == 34
    assert state.plan["subject"]["graph_validation"]["heavy_atoms"] == 19
    launch.verify_launch_sideband(state.sideband, **state.validate_args)
    launch.verify_launch_sideband(state.sideband, **state.validate_args)
    assert not (state.root / ".job-run-refinement-launch.claimed.json").exists()
    actual = launch.load_launch_context(**state.load_args)
    assert actual.plan_context == state.plan
    assert actual.resolved_plan_hash != state.plan["core_plan_hash"]
    assert actual.plan_context["core_logical_plan_hash"] != state.plan["logical_plan_hash"]
    assert actual.resource_policy == state.plan["resource_ceilings"]
    launch.verify_launch_context(state.request, actual)
    with pytest.raises(ValueError, match="claim already exists"):
        launch.verify_launch_sideband(state.sideband, **state.validate_args)


@pytest.mark.parametrize(
    "change",
    [
        lambda values: values.update(disk_budget={"untyped": True}),
        lambda values: values.update(disk_budget=replace(values["disk_budget"], max_entries=1)),
        lambda values: values.update(input_path=values["root"] / "different.json"),
        lambda values: values.update(output_path=values["root"] / "different.json"),
        lambda values: values.update(code_root=values["root"]),
        lambda values: values.update(runtime_root=values["root"]),
    ],
)
def test_prelaunch_rechecks_independent_argv_roots_and_disk_policy(governed, change):
    values = dict(governed.validate_args)
    change(values)
    with pytest.raises(ValueError):
        launch.verify_launch_sideband(governed.sideband, **values)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda record: record["plan_context"].update(core_plan_hash="sha256:" + "0" * 64),
        lambda record: record["plan_context"].update(core_logical_plan_hash="sha256:" + "0" * 64),
        lambda record: record["plan_context"]["disk_budget"].update(max_entries=True),
        lambda record: record["plan_context"]["artifact_refs"].update(
            subject={
                "path": "source.chem",
                "sha256": "0" * 64,
            }
        ),
    ],
)
def test_governed_core_binding_survives_outer_rehash_attack(governed, mutate):
    reference = governed.sideband.context.sidecar_reference
    record = json.loads((governed.root / reference["path"]).read_bytes())
    mutate(record)
    plan = record["plan_context"]
    plan["resolved_plan_hash"] = content_hash(
        {key: value for key, value in plan.items() if key != "resolved_plan_hash"}
    )
    record["resolved_plan_hash"] = plan["resolved_plan_hash"]
    ref = write(governed.root, reference["path"], record)
    environment = {**governed.sideband.environment, launch.ENV_SHA256: ref["sha256"]}
    with pytest.raises(ValueError):
        launch.load_launch_context(**(governed.load_args | {"environment": environment}))


@pytest.mark.parametrize("role", ["spec", "subject", "execution_contract"])
def test_governed_raw_ref_drift_rejected_at_prelaunch(governed, role):
    path = governed.root / governed.plan["artifact_refs"][role]["path"]
    path.write_bytes(path.read_bytes() + b" ")
    with pytest.raises(ValueError, match="hash"):
        launch.verify_launch_sideband(governed.sideband, **governed.validate_args)


def test_prelaunch_rejects_untyped_or_mutated_sideband(governed):
    with pytest.raises(ValueError, match="typed host launch"):
        launch.verify_launch_sideband({}, **governed.validate_args)
    sideband = replace(
        governed.sideband, environment={**governed.sideband.environment, launch.ENV_NONCE: "b" * 64}
    )
    with pytest.raises(ValueError, match="environment"):
        launch.verify_launch_sideband(sideband, **governed.validate_args)
    actual = launch.load_launch_context(**governed.load_args)
    with pytest.raises(ValueError, match="already consumed"):
        launch.verify_launch_sideband(
            replace(governed.sideband, context=actual), **governed.validate_args
        )


def test_prelaunch_refuses_self_consistent_changed_budget_while_original_is_approved(governed):
    # A different internally valid budget must still differ from the approved
    # launch sideband; hash recomputation never approves that new policy.
    alternative = DiskBudget(**{**asdict(governed.case["disk_budget"]), "max_entries": 2})
    with pytest.raises(ValueError, match="disk budget"):
        launch.verify_launch_sideband(
            governed.sideband,
            **{
                **governed.validate_args,
                "disk_budget": alternative,
            },
        )
