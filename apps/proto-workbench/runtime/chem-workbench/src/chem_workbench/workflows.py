"""Persistent application service shared by local clients; model code grants no authority."""

from __future__ import annotations

import getpass
import hashlib
import json
import threading
from pathlib import Path
from typing import Any

from chem_workbench import execution as execution_api
from chem_workbench.adapters import governed_compute
from chem_workbench.compiler import CompilationResult
from chem_workbench.execution import (
    ExecutionStore,
    build_cu_resolved_plan,
    build_molecular_resolved_plan,
    build_water_resolved_plan,
    cancel_job,
    issue_approval,
    recover_interrupted_jobs,
    submit_run,
)
from chem_workbench.execution_validation import digest_id, verify_hash
from chem_workbench.method_profiles import D3BJ_PROFILE_ID
from chem_workbench.readiness import require_profile
from chem_workbench.refinement_execution.worker_subject_replay import closed, load_json, read_bound
from chem_workbench.refinement_visualization import build_refinement_view
from chem_workbench.tool_gateway import invoke_tool
from chem_workbench.visualization import compile_snapshot, content_hash


class WorkflowService:
    def __init__(self, root: Path, *, artifact_root: Path | None = None) -> None:
        self.store = ExecutionStore(root, artifact_root=artifact_root)
        self.records = self.store.root / "workflows"
        self.records.mkdir(exist_ok=True)
        self.lock = threading.RLock()
        self.active: set[str] = set()
        try:
            recover_interrupted_jobs(self.store)
        except ValueError as error:
            if "EXECUTION_BUSY" not in str(error):
                raise

    def _path(self, reference: str) -> Path:
        return self.records / (digest_id(reference) + ".json")

    def read(self, reference: str) -> dict[str, Any]:
        with self.lock:
            path = self._path(reference)
            if not path.is_file():
                raise ValueError("WORKFLOW_NOT_FOUND")
            record = self.store._read(path)
            plan = self.store.load_plan(record["resolved_plan_hash"])
            refinement = plan["kind"] == "molecular_refinement"
            if refinement:
                self._verify_refinement_workflow(record, plan, reference)
                record["refinement_view"] = None
            jobs = [self.store._read(p) for p in self.store.jobs.glob("*.json")]
            jobs = [
                j
                for j in jobs
                if j.get("resolved_plan_hash") == record["resolved_plan_hash"]
                and j.get("approval_token") == record.get("approval_token")
            ]
            jobs.sort(key=lambda j: j["submitted_at"])
            if jobs:
                job = jobs[-1]
                record["job"] = {k: v for k, v in job.items() if k != "approval_token"}
                record["state"] = job["status"]
                result_path = self.store.runs / job["job_id"] / "result.json"
                if job["status"] == "succeeded" and job.get("result_hash") is None:
                    raise ValueError("EVIDENCE_CORRUPT: succeeded job has no committed result hash")
                # The terminal job hash commits the result. The worker publishes the
                # file first, so a running or interrupted job can have uncommitted data.
                if (
                    job["status"]
                    in {
                        "succeeded",
                        "failed",
                        "timeout",
                        "cancelled",
                        "interrupted",
                        "output_limit",
                    }
                    and job.get("result_hash") is not None
                ):
                    if not result_path.is_file():
                        raise ValueError("EVIDENCE_CORRUPT: committed result is missing")
                    try:
                        result = (
                            self.store.read_refinement_result(job["job_id"])
                            if refinement
                            else self.store._read(result_path)
                        )
                    except (OSError, ValueError) as error:
                        raise ValueError(
                            "EVIDENCE_CORRUPT: committed result cannot be read"
                        ) from error
                    if content_hash(result) != job.get("result_hash"):
                        raise ValueError(
                            "EVIDENCE_CORRUPT: result content differs from the committed job"
                        )
                    record["result"] = result
                    if refinement and result.get("scientific_result") is not None:
                        record["refinement_view"] = self._committed_refinement_view(
                            plan, job, result
                        )
            if reference in self.active and not jobs:
                record["state"] = "queued"
            record["plan"] = plan
            # Approval tokens never reach model context or HTTP clients.
            record.pop("approval_token", None)
            return record

    def list(self) -> list[dict[str, Any]]:
        records = []
        for path in sorted(self.records.glob("*.json")):
            reference = "sha256:" + path.stem
            try:
                records.append(self.read(reference))
            except (ValueError, KeyError, OSError) as error:
                records.append(
                    {
                        "reference": reference,
                        "state": "stale",
                        "plan": {"kind": "legacy_or_changed"},
                        "failure": str(error)[:500],
                    }
                )
        return records

    @staticmethod
    def _refinement_selection(value: object) -> dict[str, Any]:
        selected = closed(value, {"run_ref", "candidate_hash"}, "Design selection")
        for key in ("run_ref", "candidate_hash"):
            digest_id(selected[key])
        return dict(selected)

    def _refinement_source(self, plan: dict[str, Any], selection: object) -> str:
        """Bind a validated plan to the original Design bytes in this service's store."""
        selected = self._refinement_selection(selection)
        if (
            plan["kind"] != "molecular_refinement"
            or plan["method_profile_id"] != D3BJ_PROFILE_ID
            or content_hash(plan["subject"]["selection"]) != content_hash(selected)
        ):
            raise ValueError("APPROVAL_STALE: selected Design candidate differs from plan")
        subject = plan["subject"]
        record_ref = subject["design_record"]["artifact"]
        expected = self.store.root / "designs" / (digest_id(selected["run_ref"]) + ".json")
        if self.store.artifact_root / record_ref["path"] != expected:
            raise ValueError("APPROVAL_STALE: Design record is not from this workspace store")
        original = load_json(read_bound(self.store.artifact_root, record_ref))
        if original["record_hash"] != selected["run_ref"]:
            raise ValueError("APPROVAL_STALE: saved Design run differs from selection")
        candidates = [
            item
            for item in original["organic"]["candidates"]
            if item["candidate_hash"] == selected["candidate_hash"]
        ]
        if len(candidates) != 1 or not isinstance(candidates[0].get("source"), str):
            raise ValueError("APPROVAL_STALE: selected organic candidate source is absent")
        source: str = candidates[0]["source"]
        source_hash = "sha256:" + hashlib.sha256(source.encode("utf-8")).hexdigest()
        if (
            source != subject["source_snapshot"]["text"]
            or source_hash != subject["source_snapshot"]["source_text_hash"]
            or source_hash != plan["spec"]["source_binding"]["source_hash"]
        ):
            raise ValueError("APPROVAL_STALE: selected candidate source binding differs")
        return source

    @staticmethod
    def _refinement_reference(plan: dict[str, Any], selection: object) -> str:
        return content_hash(
            {
                "version": "refinement-workflow/v1",
                "plan": plan["resolved_plan_hash"],
                "selection": selection,
                "source_hash": plan["spec"]["source_binding"]["source_hash"],
            }
        )

    def _verify_refinement_workflow(
        self, record: dict[str, Any], plan: dict[str, Any], reference: str
    ) -> None:
        source = self._refinement_source(plan, record.get("selection"))
        if (
            record.get("version") != "refinement-workflow/v1"
            or record.get("reference") != reference
            or reference != self._refinement_reference(plan, record["selection"])
            or record.get("source") != source
            or record.get("source_hash") != plan["spec"]["source_binding"]["source_hash"]
            or record.get("attachments") != {}
            or record.get("orchestration_ref") is not None
        ):
            raise ValueError("APPROVAL_STALE: saved refinement workflow source binding differs")

    def _committed_refinement_view(
        self, plan: dict[str, Any], job: dict[str, Any], result: dict[str, Any]
    ) -> dict[str, Any]:
        """Read actual retained output before projecting; preserve host eligibility separately."""
        try:
            if (
                result["job_id"] != job["job_id"]
                or result["resolved_plan_hash"] != plan["resolved_plan_hash"]
            ):
                raise ValueError("committed scientific result belongs to another job or plan")
            scientific = result["scientific_result"]
            output_ref = result["lifecycle_admission"]["output_artifact"]
            expected = self.store.runs / job["job_id"] / "worker-result.json"
            if self.store.artifact_root / output_ref["path"] != expected:
                raise ValueError("scientific output is outside this job")
            raw = read_bound(self.store.artifact_root, output_ref)
            if content_hash(load_json(raw)) != content_hash(scientific):
                raise ValueError("raw scientific output differs from committed result")
            for artifact in scientific["raw_artifacts"]:
                read_bound(
                    self.store.artifact_root,
                    {key: artifact[key] for key in ("path", "sha256")},
                )
            return build_refinement_view(plan["spec"], scientific)
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise ValueError(
                "EVIDENCE_CORRUPT: refinement view unavailable: " + str(error)
            ) from error

    def prepare_refinement(self, request: dict[str, Any]) -> dict[str, Any]:
        """Lower host-prepared refs for a saved Design selection; never generate a conformer."""
        request = closed(
            request,
            {
                "spec_ref",
                "subject_ref",
                "execution_contract_ref",
                "mode",
                "disk_budget",
                "selection",
            },
            "refinement preparation",
        )
        selection = self._refinement_selection(request["selection"])
        observed = execution_api.worker_identity(
            execution_api.WORKERS["psi4_refinement"], refinement_profile_id=D3BJ_PROFILE_ID
        )
        plan = governed_compute.resolve(
            D3BJ_PROFILE_ID,
            {key: value for key, value in request.items() if key != "selection"},
            root=self.store.artifact_root,
            observed_worker_identity=observed,
        )
        source = self._refinement_source(plan, selection)
        reference = self._refinement_reference(plan, selection)
        with self.lock:
            self.store.save_plan(plan)
            if self._path(reference).exists():
                existing = self.store._read(self._path(reference))
                self._verify_refinement_workflow(existing, plan, reference)
            else:
                self.store._write(
                    self._path(reference),
                    {
                        "version": "refinement-workflow/v1",
                        "reference": reference,
                        "resolved_plan_hash": plan["resolved_plan_hash"],
                        "selection": selection,
                        "source_hash": plan["spec"]["source_binding"]["source_hash"],
                        "source": source,
                        "attachments": {},
                        "orchestration_ref": None,
                        "state": "prepared",
                    },
                )
        return self.read(reference)

    def approve_refinement(self, reference: str) -> dict[str, Any]:
        """Approve the retained Design source, without accepting editor text or authority."""
        with self.lock:
            record = self.store._read(self._path(reference))
            if reference in self.active:
                raise ValueError("EXECUTION_BUSY: cannot renew an active workflow")
            plan = self.store.load_plan(record["resolved_plan_hash"])
            if plan["kind"] != "molecular_refinement":
                raise ValueError("UNSUPPORTED_PROFILE: a Design refinement workflow is required")
            self._verify_refinement_workflow(record, plan, reference)
            # The existing approval store independently verifies the current worker,
            # registration and artifacts before issuing its private launch token.
            approval = issue_approval(
                self.store, record["resolved_plan_hash"], actor=getpass.getuser()
            )
            record.update(approval_token=approval["token"], state="approved")
            self.store._write(self._path(reference), record)
        return self.read(reference)

    def prepare(self, request: dict[str, Any]) -> dict[str, Any]:
        allowed = {
            "source",
            "attachments",
            "object_id",
            "scales",
            "profile",
            "geometry",
            "proposal",
            "orchestration_ref",
        }
        if set(request) - allowed:
            raise ValueError("INVALID_ARGUMENT: unexpected preparation fields")
        source = request.get("source")
        if not isinstance(source, str):
            raise ValueError("NEEDS_INPUT: source is required")
        snapshot = compile_snapshot(source, request.get("attachments"))
        if not snapshot.success or snapshot.document is None:
            raise ValueError("NEEDS_INPUT: valid compiled source is required")
        if request.get("profile") != "molecular":
            require_profile(snapshot, request.get("object_id", ""), request.get("profile", ""))
        if request.get("profile") == "water":
            target = next(
                (o for o in snapshot.document["objects"] if o["id"] == request.get("object_id")),
                None,
            )
            if (
                target is None
                or target["kind"] != "Molecule"
                or not any(
                    r.get("format") == "smiles" and r.get("value") in {"O", "[OH2]"}
                    for r in target["payload"].get("representations", [])
                )
            ):
                raise ValueError("UNSUPPORTED_PROFILE: select a water molecule")
            if "geometry" not in request:
                raise ValueError(
                    "NEEDS_INPUT: supply explicit water geometry; previews are not substituted"
                )
            plan = build_water_resolved_plan(request["geometry"])
        elif request.get("profile") == "copper":
            draft = invoke_tool(
                "plan_cu_lattice_scan",
                {
                    "object_id": request.get("object_id"),
                    "scale_factors": request.get("scales", [0.98, 1.0, 1.02]),
                },
                snapshot,
            )["data"]
            if "proposal" in request:
                verify_hash(request["proposal"], "logical_plan_hash")
                if request["proposal"] != draft:
                    raise ValueError(
                        "APPROVAL_STALE: proposal differs from the current source and parameters"
                    )
            plan = build_cu_resolved_plan(draft)
        elif request.get("profile") == "molecular":
            draft = invoke_tool(
                "plan_molecular_single_point", {"object_id": request.get("object_id")}, snapshot
            )["data"]
            if "proposal" not in request:
                raise ValueError(
                    "NEEDS_INPUT: explicitly review the source-generated molecular proposal first"
                )
            verify_hash(request["proposal"], "logical_plan_hash")
            if request["proposal"] != draft:
                raise ValueError(
                    "APPROVAL_STALE: molecular proposal differs from the current source and "
                    "geometry"
                )
            plan = build_molecular_resolved_plan(draft)
        else:
            raise ValueError("UNSUPPORTED_PROFILE: choose water, copper or molecular")
        orchestration_ref = request.get("orchestration_ref")
        if orchestration_ref is not None:
            orchestration = self.store._read(
                self.store.root / "orchestrations" / (digest_id(orchestration_ref) + ".json")
            )
            verify_hash(orchestration, "record_hash")
            if orchestration["record_hash"] != orchestration_ref:
                raise ValueError(
                    "APPROVAL_STALE: orchestration reference does not match its record"
                )
            self._verify_orchestration(orchestration, request, snapshot)
        self.store.save_plan(plan)
        context = {
            "plan": plan["resolved_plan_hash"],
            "source": snapshot.source_sha256,
            "attachments": request.get("attachments", {}),
        }
        if orchestration_ref is not None:
            context["orchestration_ref"] = orchestration_ref
        reference = content_hash(context)
        with self.lock:
            existing = (
                self.store._read(self._path(reference)) if self._path(reference).exists() else None
            )
            changed = existing is not None and (
                existing["source_hash"] != snapshot.source_sha256
                or existing["attachments"] != request.get("attachments", {})
            )
            if changed and reference in self.active:
                raise ValueError("EXECUTION_BUSY: plan is running; wait before changing its source")
            if existing is None or changed:
                self.store._write(
                    self._path(reference),
                    {
                        "version": "workflow/v1",
                        "reference": reference,
                        "resolved_plan_hash": plan["resolved_plan_hash"],
                        "source_hash": snapshot.source_sha256,
                        "orchestration_ref": orchestration_ref,
                        "state": "prepared",
                        "source": source,
                        "attachments": request.get("attachments", {}),
                    },
                )
        return self.read(reference)

    @staticmethod
    def _verify_orchestration(
        orchestration: dict[str, Any], request: dict[str, Any], snapshot: CompilationResult
    ) -> None:
        """Bind model provenance to the exact successful proposal, never to approval."""
        if (
            orchestration.get("source_hash") != snapshot.source_sha256
            or orchestration.get("source_semantic_hash") != snapshot.semantic_hash
        ):
            raise ValueError(
                "APPROVAL_STALE: orchestration is bound to different source or imports"
            )
        trace = orchestration.get("trace")
        if (
            orchestration.get("state") != "REPORTED"
            or orchestration.get("execution_authorized") is not False
            or not isinstance(trace, list)
            or len(trace) != 1
            or not isinstance(trace[0], dict)
        ):
            raise ValueError("APPROVAL_STALE: orchestration has no single successful proposal")
        name = {
            "water": "plan_water_single_point",
            "copper": "plan_cu_lattice_scan",
            "molecular": "plan_molecular_single_point",
        }[request["profile"]]
        arguments = {"object_id": request["object_id"]}
        if request["profile"] == "copper":
            arguments["scale_factors"] = request.get("scales", [0.98, 1.0, 1.02])
        expected = invoke_tool(name, arguments, snapshot)
        action, output = trace[0].get("action"), trace[0].get("output")
        if (
            not isinstance(action, dict)
            or not isinstance(output, dict)
            or action.get("action") != name
            or action.get("object_id") != request["object_id"]
            or output.get("tool_name") != name
            or output.get("status") != "succeeded"
            or output.get("authority") != "host_read_and_derive_only"
            or output.get("source_hash") != snapshot.source_sha256
            or output.get("data") != expected["data"]
            or output.get("data_hash") != expected["data_hash"]
        ):
            raise ValueError("APPROVAL_STALE: orchestration proposal differs from this workflow")
        scales = action.get("scale_factors")
        if not isinstance(scales, list) or any(
            isinstance(value, bool) or not isinstance(value, (int, float)) for value in scales
        ):
            raise ValueError("APPROVAL_STALE: orchestration has invalid proposal arguments")
        if sorted(scales) != sorted(arguments.get("scale_factors", [])):
            raise ValueError("APPROVAL_STALE: orchestration proposal arguments have changed")
        if request["profile"] == "water" and request["geometry"] != expected["data"]["geometry"]:
            raise ValueError("APPROVAL_STALE: explicit geometry differs from the water proposal")
        if "proposal" in request and request["proposal"] != expected["data"]:
            raise ValueError("APPROVAL_STALE: supplied proposal differs from the orchestration")
        if orchestration.get("version") == "orchestration/v2":
            from chem_workbench.intent import requirements_binding, validate_intent_action
            from chem_workbench.model_context import request_context

            requirements = orchestration.get("requirements")
            if not isinstance(requirements, dict) or orchestration.get(
                "requirements_hash"
            ) != requirements_binding(
                orchestration["objective"], requirements, snapshot.source_sha256
            ):
                raise ValueError("APPROVAL_STALE: extracted requirements binding differs")
            brief, _ = request_context(snapshot)
            validate_intent_action(requirements, action, brief)
            if orchestration.get("model_action") != action:
                raise ValueError(
                    "APPROVAL_STALE: final model selection differs from the prepared action"
                )

    def approve(self, reference: str, source: str, attachments: object) -> dict[str, Any]:
        with self.lock:
            record = self.store._read(self._path(reference))
            if self.store.load_plan(record["resolved_plan_hash"])["kind"] == "molecular_refinement":
                raise ValueError("INVALID_ARGUMENT: use Design refinement approval")
            if reference in self.active:
                raise ValueError("EXECUTION_BUSY: cannot renew an active workflow")
            snapshot = compile_snapshot(source, attachments)
            if (
                not snapshot.success
                or snapshot.source_sha256 != record["source_hash"]
                or attachments != record["attachments"]
            ):
                raise ValueError("APPROVAL_STALE: source or attachments changed; prepare again")
            approval = issue_approval(
                self.store, record["resolved_plan_hash"], actor=getpass.getuser()
            )
            record.update(approval_token=approval["token"], state="approved")
            self.store._write(self._path(reference), record)
        return self.read(reference)

    def submit(self, reference: str) -> dict[str, Any]:
        with self.lock:
            record = self.store._read(self._path(reference))
            plan = self.store.load_plan(record["resolved_plan_hash"])
            if plan["kind"] == "molecular_refinement":
                self._verify_refinement_workflow(record, plan, reference)
            if reference in self.active:
                return self.read(reference)
            if "approval_token" not in record:
                raise ValueError("APPROVAL_REQUIRED: review and approve the resolved plan first")
            self.active.add(reference)
            token = record["approval_token"]

            def run() -> None:
                try:
                    submit_run(self.store, token)
                except Exception as error:
                    with self.lock:
                        current = self.store._read(self._path(reference))
                        current.update(state="failed", failure=str(error)[:600])
                        self.store._write(self._path(reference), current)
                finally:
                    with self.lock:
                        self.active.discard(reference)

            threading.Thread(target=run, daemon=True, name="chem-workflow").start()
        return self.read(reference)

    def cancel(self, reference: str) -> dict[str, Any]:
        # Stopping an owned job must survive source/plan/result corruption and
        # expired approval. These checks identify the existing private job; they
        # neither approve a new execution nor validate scientific evidence.
        with self.lock:
            record = self.store._read(self._path(reference))
            token, plan_hash = record.get("approval_token"), record["resolved_plan_hash"]
            digest_id(plan_hash)
            if not isinstance(token, str):
                raise ValueError("NEEDS_INPUT: no submitted job for this workflow")
            self.store._check_id(token)
            jobs = []
            for path in self.store.jobs.glob("*.json"):
                job = self.store._read(path)
                if job.get("approval_token") != token or job.get("resolved_plan_hash") != plan_hash:
                    continue
                if (
                    job.get("owner") != getpass.getuser()
                    or job.get("workspace") != str(self.store.root)
                    or job.get("job_id") != path.stem
                ):
                    raise ValueError("JOB_NOT_OWNED: no owned job with this workflow binding")
                jobs.append(job)
            if not jobs:
                raise ValueError("NEEDS_INPUT: job is being prepared; retry cancellation shortly")
            jobs.sort(key=lambda job: (job["status"] == "running", job["submitted_at"]))
            return cancel_job(self.store, jobs[-1]["job_id"])


class ProjectStore:
    def __init__(self, root: Path) -> None:
        self.store = ExecutionStore(root)
        self.directory = self.store.root / "projects"
        self.directory.mkdir(exist_ok=True)

    def save(self, value: dict[str, Any]) -> dict[str, Any]:
        if set(value) - {"name", "source", "attachments", "orchestration"}:
            raise ValueError("INVALID_ARGUMENT: unexpected project fields")
        if not isinstance(value.get("name"), str) or not 1 <= len(value["name"]) <= 100:
            raise ValueError("INVALID_ARGUMENT: project name must contain 1-100 characters")
        if not isinstance(value.get("source"), str):
            raise ValueError("INVALID_ARGUMENT: project source required")
        compile_snapshot(value["source"], value.get("attachments"))
        if len(json.dumps(value)) > 500_000:
            raise ValueError("PROJECT_LIMIT: project exceeds 500 KB")
        record = {"version": "project-revision/v1", **value}
        reference = content_hash(record)
        record["revision"] = reference
        self.store._write(self.directory / (digest_id(reference) + ".json"), record)
        return record

    def list(self) -> list[dict[str, Any]]:
        records = [self.store._read(p) for p in self.directory.glob("*.json")]
        for record in records:
            verify_hash(record, "revision")
        return records
