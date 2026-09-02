from __future__ import annotations

import hashlib
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .compiler import compile_design
from .compiler import validate_design
from .exporters import export_ir
from .models import Diagnostic
from .parser import parse_design
from .parts import DEFAULT_PARTS_PATH
from .json_validation import JsonValidationError, strict_json_loads
from .provenance import ProvenanceError, create_provenance
from .scoring import score_design
from .sequence import validate_sequences
from .sbol import validate_sbol_turtle
from .security import (
    MAX_JSON_FILE_BYTES,
    MAX_TEXT_FILE_BYTES,
    WorkspacePaths,
    public_workspace_payload,
    read_bytes_bounded,
    write_text_bounded,
)
from .skill_sdk import list_skill_adapters

DEFAULT_WORKFLOW_PATH = Path("workflows") / "design_review.json"

_DESIGN_REVIEW_STEPS = [
    {"id": "check", "tool": "proto-agent check", "required": True},
    {"id": "compile", "tool": "proto-agent compile", "required": True},
    {"id": "sequence_validate", "tool": "proto-agent sequence validate", "required": True},
    {"id": "score", "tool": "proto-agent score", "required": True},
    {"id": "export_sbol", "tool": "proto-agent export --format sbol", "required": False},
    {"id": "sbol_validate", "tool": "proto-agent sbol validate", "required": True},
    {"id": "export_genbank", "tool": "proto-agent export --format genbank", "required": False},
    {"id": "export_fasta", "tool": "proto-agent export --format fasta", "required": False},
]

_DESIGN_REVIEW_SKILL_BINDINGS = [
    {
        "skill_id": "proto-science-workflow",
        "stage": "orchestration",
        "required": True,
        "operations": ["inspect-connectors", "run-design-review"],
    },
    {
        "skill_id": "sequence-resource-analysis",
        "stage": "sequence-validation",
        "required": True,
        "operations": ["validate-dna"],
    },
    {
        "skill_id": "scientific-sequence-visualization",
        "stage": "artifact-handoff",
        "required": True,
        "operations": ["read-dna-artifact", "validate-sequence"],
    },
    {
        "skill_id": "research-provenance",
        "stage": "run-provenance",
        "required": True,
        "operations": ["capture-workflow"],
    },
]


def run_design_review(
    design_path: str | Path,
    parts_path: str | Path = DEFAULT_PARTS_PATH,
    workflow_path: str | Path = DEFAULT_WORKFLOW_PATH,
    out_dir: str | Path = Path("build") / "runs",
    *,
    workspace_root: str | Path | None = None,
) -> tuple[dict[str, Any], int]:
    started = time.perf_counter()
    paths = WorkspacePaths.create(workspace_root)
    design_source = paths.workspace_file(design_path, extensions={".proto"}, max_bytes=MAX_TEXT_FILE_BYTES)
    parts_source = paths.workspace_file(parts_path, extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
    workflow_source = paths.workspace_file(workflow_path, extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
    design_bytes = read_bytes_bounded(design_source, MAX_TEXT_FILE_BYTES)
    parts_bytes = read_bytes_bounded(parts_source, MAX_JSON_FILE_BYTES)
    workflow, workflow_bytes = _load_workflow(workflow_source)
    workflow_sha256 = hashlib.sha256(workflow_bytes).hexdigest()
    skill_catalog_sha256, connector_registry_sha256, skill_bindings, skill_compatibility = resolve_workflow_skills(
        workflow,
        paths,
    )
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    safe_stem = re.sub(r"[^A-Za-z0-9._-]", "_", design_source.stem)[:64]
    if not safe_stem or not safe_stem[0].isalnum():
        safe_stem = f"design-{safe_stem.lstrip('._-')}"[:64]
    run_id = f"{safe_stem}-{timestamp}"
    run_dir = paths.run_directory(out_dir, run_id)
    snapshot_dir = paths.ensure_directory(run_dir / "inputs", boundary=paths.build)
    design_snapshot = snapshot_dir / "design.proto"
    parts_snapshot = snapshot_dir / "parts.json"
    workflow_snapshot = snapshot_dir / "workflow.json"
    try:
        write_text_bounded(
            design_snapshot,
            design_bytes.decode("utf-8"),
            max_bytes=MAX_TEXT_FILE_BYTES,
            boundary=paths.build,
        )
        write_text_bounded(
            parts_snapshot,
            parts_bytes.decode("utf-8"),
            max_bytes=MAX_JSON_FILE_BYTES,
            boundary=paths.build,
        )
        write_text_bounded(
            workflow_snapshot,
            workflow_bytes.decode("utf-8"),
            max_bytes=MAX_JSON_FILE_BYTES,
            boundary=paths.build,
        )
    except UnicodeDecodeError as exc:
        raise ValueError("Workflow inputs must be valid UTF-8.") from exc

    input_bytes = {
        "design": design_bytes,
        "parts": parts_bytes,
        "workflow": workflow_bytes,
    }
    input_digests = {
        name: {"sha256": hashlib.sha256(payload).hexdigest(), "size": len(payload)}
        for name, payload in input_bytes.items()
    }

    manifest: dict[str, Any] = {
        "schema_version": "proto-agent.run.v1",
        "run_id": run_id,
        "created_at": timestamp,
        "workflow": workflow,
        "workflow_sha256": workflow_sha256,
        "input_digests": input_digests,
        "skill_catalog_sha256": skill_catalog_sha256,
        "connector_registry_sha256": connector_registry_sha256,
        "skill_bindings": skill_bindings,
        "skill_compatibility": skill_compatibility,
        "inputs": {
            "design": design_source.relative_to(paths.workspace).as_posix(),
            "parts": parts_source.relative_to(paths.workspace).as_posix(),
            "workflow": workflow_source.relative_to(paths.workspace).as_posix(),
            "consumed_design": design_snapshot.relative_to(paths.workspace).as_posix(),
            "consumed_parts": parts_snapshot.relative_to(paths.workspace).as_posix(),
            "consumed_workflow": workflow_snapshot.relative_to(paths.workspace).as_posix(),
        },
        "steps": [],
        "artifacts": [],
        "diagnostics": [],
        "review_status": workflow.get("review_gate", {}).get("status", "human_review_required"),
        "summary": "",
    }

    design, parse_diagnostics = parse_design(design_snapshot)
    check_diagnostics = validate_design(design, parse_diagnostics, parts_snapshot)
    check_ok = not any(item.severity == "error" for item in check_diagnostics)
    _append_step(manifest, "check", check_ok, check_diagnostics, [])

    ir: dict[str, Any] | None = None
    ir_path = run_dir / f"{design_source.stem}.ir.json"
    if check_ok:
        ir, compile_diagnostics = compile_design(design_snapshot, parts_snapshot)
        compile_ok = ir is not None and not any(item.severity == "error" for item in compile_diagnostics)
        if ir is not None:
            ir["provenance"] = {
                "source": design_source.relative_to(paths.workspace).as_posix(),
                "source_sha256": input_digests["design"]["sha256"],
                "parts_sha256": input_digests["parts"]["sha256"],
            }
            ir = public_workspace_payload(ir, paths.workspace)
            write_text_bounded(ir_path, json.dumps(ir, indent=2) + "\n", boundary=paths.build)
            ir_reference = ir_path.relative_to(paths.workspace).as_posix()
            manifest["artifacts"].append(ir_reference)
        _append_step(manifest, "compile", compile_ok, compile_diagnostics, [ir_reference] if ir is not None else [])
    else:
        _append_step(manifest, "compile", False, [], [], skipped=True)

    if ir is not None:
        sequence_report, sequence_diagnostics = validate_sequences(design_snapshot, parts_snapshot)
        sequence_ok = sequence_report["ok"] and not any(item.severity == "error" for item in sequence_diagnostics)
        _append_step(manifest, "sequence_validate", sequence_ok, sequence_diagnostics, [])
        manifest["sequence_validation"] = sequence_report

        score, score_diagnostics = score_design(design_snapshot, parts_snapshot)
        _append_step(manifest, "score", bool(score.get("ok")), score_diagnostics, [])
        manifest["score"] = score

        if sequence_ok:
            for output_format, suffix in (("sbol", "ttl"), ("genbank", "gb"), ("fasta", "fasta")):
                artifact_path = run_dir / f"{design_source.stem}.{suffix}"
                write_text_bounded(artifact_path, export_ir(ir, output_format), boundary=paths.build)
                artifact_reference = artifact_path.relative_to(paths.workspace).as_posix()
                manifest["artifacts"].append(artifact_reference)
                _append_step(manifest, f"export_{output_format}", True, [], [artifact_reference])
                if output_format == "sbol":
                    sbol_report = validate_sbol_turtle(artifact_path)
                    manifest["sbol_validation"] = sbol_report
                    _append_step(manifest, "sbol_validate", sbol_report["ok"], _diagnostics_from_dicts(sbol_report["diagnostics"]), [])
        else:
            for step_id in ("export_sbol", "sbol_validate", "export_genbank", "export_fasta"):
                _append_step(manifest, step_id, False, [], [], skipped=True)
    else:
        _append_step(manifest, "sequence_validate", False, [], [], skipped=True)
        _append_step(manifest, "score", False, [], [], skipped=True)
        for step_id in ("export_sbol", "sbol_validate", "export_genbank", "export_fasta"):
            _append_step(manifest, step_id, False, [], [], skipped=True)

    manifest["diagnostics"] = [
        diagnostic
        for step in manifest["steps"]
        for diagnostic in step.get("diagnostics", [])
    ]
    software_steps_ok = all(
        step["ok"] for step in manifest["steps"] if not step.get("skipped") and step.get("required", True)
    ) and not any(item.get("severity") == "error" for item in manifest["diagnostics"])
    manifest["ok"] = software_steps_ok and skill_compatibility["status"] == "resolved"
    manifest["summary"] = _summary(manifest)

    manifest_path = run_dir / "manifest.json"
    provenance_path = run_dir / "provenance.json"
    manifest["manifest_path"] = manifest_path.relative_to(paths.workspace).as_posix()
    manifest["provenance_path"] = provenance_path.relative_to(paths.workspace).as_posix()
    manifest["metrics"] = {
        "duration_ms": round((time.perf_counter() - started) * 1000, 3),
        "step_count": len(manifest["steps"]),
        "artifact_count": len(manifest["artifacts"]),
        "diagnostic_count": len(manifest["diagnostics"]),
    }
    manifest = public_workspace_payload(manifest, paths.workspace)
    write_text_bounded(manifest_path, json.dumps(manifest, indent=2) + "\n", boundary=paths.build)
    provenance = create_provenance(
        manifest_path,
        workspace_root=paths.workspace,
        build_root=paths.build,
        output_path=provenance_path,
    )
    provenance_inputs = {
        record.get("name"): record
        for record in provenance.get("materials", [])
        if isinstance(record, dict)
    }
    for name, expected in input_digests.items():
        for claim_name in (f"input:{name}", f"input:consumed_{name}"):
            record = provenance_inputs.get(claim_name)
            if (
                not isinstance(record, dict)
                or record.get("sha256") != expected["sha256"]
                or record.get("size") != expected["size"]
            ):
                raise ProvenanceError(
                    f"{name} input changed after it was consumed and before provenance attestation"
                )
    return manifest, 0 if manifest["ok"] else 1


def _load_workflow(path: str | Path) -> tuple[dict[str, Any], bytes]:
    raw = read_bytes_bounded(path, MAX_JSON_FILE_BYTES)
    try:
        payload = strict_json_loads(raw.decode("utf-8"), max_bytes=MAX_JSON_FILE_BYTES)
    except (UnicodeDecodeError, JsonValidationError) as exc:
        raise ValueError("Workflow must be strict bounded UTF-8 JSON.") from exc
    if not isinstance(payload, dict):
        raise ValueError("Workflow must be a JSON object.")
    _validate_workflow_contract(payload)
    return payload, raw


def _validate_workflow_contract(workflow: dict[str, Any]) -> None:
    required_fields = {"schema_version", "id", "description", "steps", "review_gate"}
    allowed_fields = required_fields | {"skill_bindings"}
    if not required_fields.issubset(workflow) or set(workflow) - allowed_fields:
        raise ValueError("Workflow contains missing or unsupported fields for proto-agent.workflow.v1.")
    if workflow["schema_version"] != "proto-agent.workflow.v1" or workflow["id"] != "design_review":
        raise ValueError("Workflow must declare the supported proto-agent.workflow.v1 design_review contract.")
    if not isinstance(workflow["description"], str) or not 1 <= len(workflow["description"]) <= 2_048:
        raise ValueError("Workflow description is missing or exceeds the limit.")
    if workflow["steps"] != _DESIGN_REVIEW_STEPS:
        raise ValueError("Workflow steps must exactly match the executable design_review v1 contract.")
    review_gate = workflow["review_gate"]
    if (
        not isinstance(review_gate, dict)
        or set(review_gate) != {"status", "message"}
        or review_gate.get("status") != "human_review_required"
        or not isinstance(review_gate.get("message"), str)
        or not 1 <= len(review_gate["message"]) <= 2_048
    ):
        raise ValueError("Workflow review_gate must retain the bounded human_review_required contract.")
    declared_bindings = workflow.get("skill_bindings")
    if declared_bindings is not None and declared_bindings != _DESIGN_REVIEW_SKILL_BINDINGS:
        raise ValueError(
            "Workflow Skill bindings must exactly match the operations applied by the design_review v1 contract."
        )


def resolve_workflow_skills(
    workflow: dict[str, Any],
    paths: WorkspacePaths,
) -> tuple[str, str, list[dict[str, Any]], dict[str, str]]:
    # This resolver is also used by review. Validate the immutable executable
    # contract here so a caller cannot self-attest a different set of Skills.
    _validate_workflow_contract(workflow)
    bindings = workflow.get("skill_bindings", [])
    if not isinstance(bindings, list) or len(bindings) > 16 or not all(isinstance(item, dict) for item in bindings):
        raise ValueError("Workflow skill_bindings are malformed or exceed the limit.")
    if not bindings:
        return (
            "",
            "",
            [],
            {
                "mode": "legacy_no_skill_bindings",
                "status": "needs_review",
                "reason_code": "LEGACY_WORKFLOW_SKILL_BINDINGS_MISSING",
                "message": (
                    "The workflow contains no governed Skill bindings. Software steps may run, but the run "
                    "fails closed until an operator reviews and explicitly adopts a current workflow."
                ),
            },
        )
    catalog = list_skill_adapters(workspace_root=paths.workspace)
    adapters = {adapter["id"]: adapter for adapter in catalog["adapters"]}
    resolved: list[dict[str, Any]] = []
    seen: set[str] = set()
    for binding in bindings:
        skill_id = binding.get("skill_id")
        stage = binding.get("stage")
        required = binding.get("required", True)
        operation_ids = binding.get("operations")
        if (
            not isinstance(skill_id, str)
            or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", skill_id)
            or skill_id in seen
            or not isinstance(stage, str)
            or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", stage)
            or not isinstance(required, bool)
            or not isinstance(operation_ids, list)
            or not 1 <= len(operation_ids) <= 16
            or not all(isinstance(item, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", item) for item in operation_ids)
            or len(set(operation_ids)) != len(operation_ids)
        ):
            raise ValueError("Workflow skill binding fields are malformed or duplicated.")
        seen.add(skill_id)
        adapter = adapters.get(skill_id)
        if adapter is None:
            if required:
                raise ValueError(f"Required workflow skill adapter is not installed: {skill_id}")
            resolved.append(
                {
                    "skill_id": skill_id,
                    "stage": stage,
                    "required": False,
                    "resolution_status": "unavailable",
                    "operations": operation_ids,
                    "missing_operations": operation_ids,
                }
            )
            continue
        operations = {operation["id"]: operation for operation in adapter["operations"]}
        missing = [
            operation_id
            for operation_id in operation_ids
            if operation_id not in operations or not operations[operation_id]["available"]
        ]
        if required and missing:
            raise ValueError(
                f"Required workflow skill operations are unavailable for {skill_id}: {', '.join(missing)}"
            )
        resolved.append(
            {
                "skill_id": skill_id,
                "stage": stage,
                "required": required,
                "resolution_status": "resolved" if not missing else "partial",
                "operations": operation_ids,
                "missing_operations": missing,
                "adapter_version": adapter["version"],
                "manifest_sha256": adapter["manifest_sha256"],
                "document_sha256": adapter["document_sha256"],
            }
        )
    return (
        catalog["catalog_sha256"],
        catalog["connector_registry_sha256"],
        resolved,
        {
            "mode": "skill_bound",
            "status": "resolved",
            "reason_code": "SKILL_BINDINGS_RESOLVED",
            "message": "Workflow Skill bindings resolved against the recorded catalog and connector registry.",
        },
    )


def _append_step(
    manifest: dict[str, Any],
    step_id: str,
    ok: bool,
    diagnostics: list[Diagnostic],
    artifacts: list[str],
    skipped: bool = False,
) -> None:
    required = step_id in {"check", "compile", "sequence_validate", "score", "sbol_validate"}
    manifest["steps"].append(
        {
            "id": step_id,
            "ok": ok,
            "required": required,
            "skipped": skipped,
            "diagnostics": [item.to_dict() for item in diagnostics],
            "artifacts": artifacts,
        }
    )


def _summary(manifest: dict[str, Any]) -> str:
    if manifest.get("skill_compatibility", {}).get("status") == "needs_review":
        return (
            "Local software steps were evaluated, but this legacy workflow has no governed Skill bindings. "
            "The run fails closed and requires explicit human review before reuse."
        )
    if manifest["ok"]:
        return (
            "Design passed local software checks, compiled to IR, and produced exchange artifacts. "
            "Human scientific review remains required before any real-world use."
        )
    return "Design review did not pass. Inspect diagnostics and rerun the workflow after edits."


def _diagnostics_from_dicts(items: list[dict[str, Any]]) -> list[Diagnostic]:
    return [
        Diagnostic(
            item.get("severity", "error"),
            item.get("file", ""),
            int(item.get("line", 0)),
            item.get("code", "UNKNOWN"),
            item.get("message", ""),
            item.get("suggestion"),
        )
        for item in items
    ]
