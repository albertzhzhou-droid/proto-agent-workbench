"""Connect a reserved host job to the v2 worker and actual-byte result admission.

This route retains failures and scratch. It grants no approval and never treats
worker exit, a single gradient, or optimizer convergence as accuracy certification.
"""

from __future__ import annotations

import copy
import getpass
import hashlib
import os
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any

from chem_workbench.molecular_refinement import (
    validate_refinement_result,
    validate_refinement_spec,
)
from chem_workbench.refinement_execution import contract_result_evidence, governed_plan
from chem_workbench.refinement_execution.disk_budget import DiskBudget, OwnedRunDirectory
from chem_workbench.refinement_execution.execution_contract import validate_execution_contract
from chem_workbench.refinement_execution.host_evidence import ContainedReader, HostEvidenceSession
from chem_workbench.refinement_execution.host_subject_admission import build_host_admission
from chem_workbench.refinement_execution.launch_context import (
    HostLaunchContext,
    create_launch_context,
)
from chem_workbench.refinement_execution.refinement_plan import (
    PlanContext,
    admit_result,
    build_resolved_plan,
)
from chem_workbench.refinement_execution.runtime_preflight import RUNTIME_PREFLIGHT_FILES
from chem_workbench.refinement_execution.worker_subject_replay import load_json
from chem_workbench.visualization import content_hash

if TYPE_CHECKING:
    from chem_workbench.execution import ExecutionStore

Record = dict[str, Any]
AUXILIARY_NAMES = (
    "input.json",
    "host-subject-admission.json",
    "stdout.txt",
    "stderr.txt",
    "cancel.request",
    "worker-lifecycle-events.jsonl",
    "supervisor-disk-observations.jsonl",
    "supervisor-failure.json",
    "supervisor-failure-stdout.bin",
    "supervisor-failure-stderr.bin",
    *RUNTIME_PREFLIGHT_FILES,
)


def _same(actual: object, expected: object, label: str) -> None:
    if content_hash(actual) != content_hash(expected):
        raise ValueError("APPROVAL_STALE: " + label + " differs")


def _reservation(store: ExecutionStore, job: Record, plan: Record) -> str:
    from chem_workbench import execution

    _same(store.load_job(job["job_id"]), job, "reserved host job")
    if (
        job["status"] != "running"
        or job["owner"] != getpass.getuser()
        or job["workspace"] != str(store.root)
        or job["resolved_plan_hash"] != plan["resolved_plan_hash"]
        or job["worker_kind"] != "psi4_refinement"
    ):
        raise ValueError("APPROVAL_REQUIRED: owned running refinement reservation required")
    approval, approved = execution._verify_approval(store, job["approval_token"])
    _same(approved, plan, "currently approved plan")
    if not (
        type(approval["launches_used"]) is int
        and type(approval["max_launches"]) is int
        and 1 <= approval["launches_used"] <= approval["max_launches"]
    ):
        raise ValueError("APPROVAL_REQUIRED: reserved launch budget required")
    # The token remains in the host store. Only this opaque binding crosses to
    # the worker, where it cannot reserve or authorize another launch.
    return content_hash(
        {"approval": approval, "reservation": job, "plan": plan["resolved_plan_hash"]}
    )


def _source_identity(code_root: Path, worker: Record) -> dict[str, str]:
    package = Path(__file__).resolve().parents[1]
    prefix = package.relative_to(code_root).as_posix()
    sources = {
        prefix + "/" + relative: digest
        for relative, digest in worker["product_module_sha256"].items()
    }
    sources.update(
        {
            "scripts/" + worker["script"]: worker["script_sha256"],
            "scripts/run_psi4_python.ps1": worker["launcher_sha256"],
            "uv.lock": worker["lock_sha256"],
        }
    )
    reader = ContainedReader(code_root, single_link_roots=())
    for relative, digest in sources.items():
        reader({"path": relative, "sha256": digest})
    return dict(sorted(sources.items()))


def _dispersion_version(worker: Record) -> str:
    """Expected native API version from authenticated installed package metadata.

    Runtime preflight and retained native calls separately observe the loaded API.
    No native imports occur in this host process.
    """
    environment = worker["environment"]
    reader = ContainedReader(Path(environment["prefix"]), single_link_roots=())
    matches = [
        {"path": path, "sha256": digest}
        for path, digest in environment["entries"].items()
        if re.fullmatch(r"conda-meta/simple-dftd3-[^/]+\.json", path)
    ]
    if len(matches) != 1:
        raise ValueError("WORKER_UNAVAILABLE: unique installed simple-dftd3 metadata required")
    metadata = load_json(reader(matches[0]))
    version = metadata.get("version")
    if (
        metadata.get("name") != "simple-dftd3"
        or type(version) is not str
        or re.fullmatch(r"\d+\.\d+\.\d+", version) is None
    ):
        raise ValueError("WORKER_UNAVAILABLE: bound simple-dftd3 API version required")
    return version


def _retain_stream(
    reader: ContainedReader, run: str, name: str, raw: object, digest: str
) -> Record:
    if type(raw) is not bytes or hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError("EVIDENCE_CORRUPT: supervisor capture bytes differ")
    parent = reader.path(run)
    with (parent / name).open("xb", buffering=0) as stream:
        if stream.write(raw) != len(raw):
            raise OSError("EVIDENCE_CORRUPT: incomplete supervisor capture retention")
        os.fsync(stream.fileno())
    return reader.ref(run + "/" + name)


def run_refinement_job(store: ExecutionStore, job: Record, plan: Record) -> Record:
    """Execute only a genuinely reserved job under the existing submission lock."""
    from chem_workbench import execution

    plan, job = copy.deepcopy(plan), copy.deepcopy(job)
    root, code_root = store.artifact_root, execution.REPOSITORY_ROOT
    if root != code_root:
        raise ValueError("UNSUPPORTED_PROFILE: v2 launcher currently requires its resource root")
    approval_id = _reservation(store, job, plan)
    run_path = store.run_directory(job["job_id"])
    run = run_path.relative_to(root).as_posix()
    owned = OwnedRunDirectory.capture(root, run)
    if any(path.name != "cancel.request" for path in run_path.iterdir()):
        raise ValueError("APPROVAL_STALE: refinement run directory is already occupied")
    reader = ContainedReader(root, single_link_roots=(run,))
    result: Record = {
        "version": "execution-result/v1",
        "job_id": job["job_id"],
        "resolved_plan_hash": plan["resolved_plan_hash"],
        "method_profile_id": plan["method_profile_id"],
        "mode": plan["mode"],
        "execution_status": "failed",
        "evidence_eligible": False,
        "minimum_certified": False,
        "scientific_accuracy_validated": False,
        "scratch_retained": True,
    }
    try:

        def observe_worker() -> Record:
            return execution.worker_identity(
                execution.WORKERS["psi4_refinement"],
                refinement_profile_id=plan["method_profile_id"],
            )

        observed = observe_worker()
        governed_plan.validate_plan(plan, root, observed)
        refs = plan["artifact_refs"]
        plan_context = governed_plan.context_from_artifacts(
            root, refs["spec"], refs["subject"], refs["execution_contract"], plan["mode"], observed
        )
        core_plan = build_resolved_plan(plan_context)
        _same(core_plan["resolved_plan_hash"], plan["core_plan_hash"], "core plan linkage")
        input_ref = reader.publish(run, "input.json", plan["prepared_input"])
        admission = build_host_admission(root=root, spec_ref=refs["spec"])
        admission_ref = reader.publish(run, "host-subject-admission.json", admission)
        sources = _source_identity(code_root, observed)
        resources = execution.WorkerResourceLimits(**plan["resource_ceilings"])
        budget = DiskBudget(**plan["disk_budget"])
        native_config = {
            "ncores": resources.threads,
            "memory": resources.memory_bytes / 1024**3 * 0.6,
            "retries": 0,
            "scratch_directory": str(run_path / "scratch"),
        }

        def host_plan(candidate: Record, context: PlanContext) -> Record:
            _same(build_resolved_plan(context), core_plan, "host PlanContext")
            return governed_plan.validate_plan(candidate, root, observe_worker())

        def host_admission(request: Record, context: HostLaunchContext) -> None:
            _same(_reservation(store, job, plan), approval_id, "host approval reservation")
            _same(context.approval_id, approval_id, "transported opaque approval")
            _same(request, plan["prepared_input"], "approved request")
            _same(context.job_id, job["job_id"], "host job ID")
            _same(context.trusted_subject_admission_ref, admission_ref, "subject admission anchor")
            _same(
                load_json(reader(admission_ref)),
                build_host_admission(root=root, spec_ref=refs["spec"]),
                "fresh host Design admission",
            )

        sideband = create_launch_context(
            root=root,
            code_root=code_root,
            runtime_root=Path(observed["environment"]["prefix"]),
            job_id=job["job_id"],
            approval_id=approval_id,
            run_id=job["job_id"],
            run_directory=run,
            plan=plan,
            plan_context=plan_context,
            input_artifact=input_ref,
            trusted_subject_admission_ref=admission_ref,
            source_identity=sources,
            native_task_config=native_config,
            validate_host_plan=host_plan,
            verify_host_admission=host_admission,
        )
        result["launch_context"] = sideband.context.sidecar_reference
        started = False
        terminal: Record | None = None

        def assert_quiescent() -> None:
            owned.verify()
            if started and (
                terminal is None or terminal.get("process_tree_empty_verified") is not True
            ):
                raise ValueError("PROCESS_TREE_NOT_QUIESCENT: host Job Object exit required")

        host = HostEvidenceSession(
            root=root,
            run_directory=run,
            run_id=job["job_id"],
            run_nonce=sideband.context.run_nonce,
            spec=plan["spec"],
            contract=plan["execution_contract"],
            mode=plan["mode"],
            worker_identity=observed,
            source_paths=list(sources),
            native_task_config=native_config,
            native_dispersion_version=_dispersion_version(observed),
            validate_spec=validate_refinement_spec,
            validate_contract=validate_execution_contract,
            validate_result=validate_refinement_result,
            observe_worker_identity=observe_worker,
            assert_quiescent=assert_quiescent,
            auxiliary_names=AUXILIARY_NAMES,
        )
        host.begin()
        # Recheck expiry and reserved budget at the final host launch boundary.
        host_admission(plan["prepared_input"], sideband.context)
        if (run_path / "cancel.request").exists():
            result.update(execution_status="cancelled", summary="Cancelled before worker launch")
        else:
            started = True
            terminal = execution.run_worker(
                execution.WORKERS["psi4_refinement"],
                root / input_ref["path"],
                run_path / "worker-result.json",
                deadline_seconds=resources.wall_seconds,
                max_output_bytes=resources.max_output_bytes,
                cancel_path=run_path / "cancel.request",
                resources=resources,
                disk_budget=budget,
                launch_sideband=sideband,
            )
            result["execution"] = terminal
            for channel in ("stdout", "stderr"):
                raw = terminal.pop("_" + channel)
                _retain_stream(reader, run, channel + ".txt", raw, terminal[channel + "_sha256"])
            assert_quiescent()
            finalized = host.finalize(
                optimizer_evidence_path=run + "/optimizer-observation.json"
                if plan["mode"] == "optimization"
                else None
            )
            result["host_diagnostics"] = finalized.diagnostics_reference
            result["host_inventory"] = finalized.inventory_reference
            result["execution_evidence"] = finalized.evidence_reference
            inventory = load_json(host.reader(finalized.inventory_reference))
            retained = [
                {key: item[key] for key in ("path", "sha256")} for item in inventory["files"]
            ]
            assessment: Record | None = None

            def contract_admission(
                contract: Record, spec: Record, mode: str, science: Record
            ) -> None:
                nonlocal assessment
                if finalized.evidence_reference is None or finalized.host_context is None:
                    raise ValueError(
                        "INCOMPLETE_EXECUTION_EVIDENCE: authenticated host bracket absent"
                    )
                optimizer_validator = None
                if mode == "optimization":
                    from chem_workbench.refinement_execution.optimizer_evidence import (
                        make_optimizer_validator,
                    )

                    optimizer_validator = make_optimizer_validator(
                        read_artifact=host.reader,
                        run_directory=run,
                        retained_inventory=inventory["files"],
                    )
                assessment = contract_result_evidence.assess_contract_result(
                    contract,
                    spec,
                    mode,
                    science,
                    evidence_ref=finalized.evidence_reference,
                    host_context=finalized.host_context,
                    read_artifact=host.reader,
                    validate_contract=validate_execution_contract,
                    validate_scientific_result=validate_refinement_result,
                    validate_optimizer_evidence=optimizer_validator,
                )
                if assessment["complete"] is not True:
                    raise ValueError(
                        "INCOMPLETE_EXECUTION_EVIDENCE: " + "; ".join(assessment["errors"])[:1600]
                    )

            admission_result = admit_result(
                core_plan,
                plan_context,
                runner=terminal,
                observed_worker_identity=observe_worker(),
                input_artifact=input_ref,
                output_artifact=finalized.result_reference,
                retained_artifacts=retained,
                read_artifact=host.reader,
                validate_result=validate_refinement_result,
                validate_contract_result=contract_admission,
            )
            eligible = (
                admission_result["mode_completed"] is True
                and assessment is not None
                and assessment["complete"] is True
            )
            result.update(
                execution_status=admission_result["execution_status"],
                evidence_eligible=eligible,
                lifecycle_admission=admission_result,
                contract_assessment=assessment,
                scientific_result=admission_result["scientific_result"],
                scientific_state=admission_result["scientific_state"],
                summary="Bound refinement completed; accuracy and minimum remain unevaluated"
                if eligible
                else "Refinement execution incomplete; retained artifacts require review",
            )
    except Exception as error:
        # No completion envelope is assembled after an unverified process exit.
        # The supervisor's partial logs, scratch and any lifecycle files survive.
        result.update(
            execution_status="failed",
            evidence_eligible=False,
            summary=type(error).__name__ + ": " + str(error)[:1600],
        )
        if "execution" in result:
            result["execution"] = {
                key: value for key, value in result["execution"].items() if not key.startswith("_")
            }
    owned.verify()
    reader.publish(run, "result.json", result)
    return result
