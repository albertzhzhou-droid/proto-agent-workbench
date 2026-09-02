from __future__ import annotations

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
from .provenance import create_provenance
from .scoring import score_design
from .sequence import validate_sequences
from .sbol import validate_sbol_turtle
from .security import (
    MAX_JSON_FILE_BYTES,
    MAX_TEXT_FILE_BYTES,
    WorkspacePaths,
    public_workspace_payload,
    read_json_bounded,
    write_text_bounded,
)

DEFAULT_WORKFLOW_PATH = Path("workflows") / "design_review.json"


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
    workflow = _load_workflow(workflow_source)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    safe_stem = re.sub(r"[^A-Za-z0-9._-]", "_", design_source.stem)[:64]
    if not safe_stem or not safe_stem[0].isalnum():
        safe_stem = f"design-{safe_stem.lstrip('._-')}"[:64]
    run_id = f"{safe_stem}-{timestamp}"
    run_dir = paths.run_directory(out_dir, run_id)

    manifest: dict[str, Any] = {
        "schema_version": "proto-agent.run.v1",
        "run_id": run_id,
        "created_at": timestamp,
        "workflow": workflow,
        "inputs": {
            "design": design_source.relative_to(paths.workspace).as_posix(),
            "parts": parts_source.relative_to(paths.workspace).as_posix(),
            "workflow": workflow_source.relative_to(paths.workspace).as_posix(),
        },
        "steps": [],
        "artifacts": [],
        "diagnostics": [],
        "review_status": workflow.get("review_gate", {}).get("status", "human_review_required"),
        "summary": "",
    }

    design, parse_diagnostics = parse_design(design_source)
    check_diagnostics = validate_design(design, parse_diagnostics, parts_source)
    check_ok = not any(item.severity == "error" for item in check_diagnostics)
    _append_step(manifest, "check", check_ok, check_diagnostics, [])

    ir: dict[str, Any] | None = None
    ir_path = run_dir / f"{design_source.stem}.ir.json"
    if check_ok:
        ir, compile_diagnostics = compile_design(design_source, parts_source)
        compile_ok = ir is not None and not any(item.severity == "error" for item in compile_diagnostics)
        if ir is not None:
            ir = public_workspace_payload(ir, paths.workspace)
            write_text_bounded(ir_path, json.dumps(ir, indent=2) + "\n", boundary=paths.build)
            ir_reference = ir_path.relative_to(paths.workspace).as_posix()
            manifest["artifacts"].append(ir_reference)
        _append_step(manifest, "compile", compile_ok, compile_diagnostics, [ir_reference] if ir is not None else [])
    else:
        _append_step(manifest, "compile", False, [], [], skipped=True)

    if ir is not None:
        sequence_report, sequence_diagnostics = validate_sequences(design_source, parts_source)
        sequence_ok = sequence_report["ok"] and not any(item.severity == "error" for item in sequence_diagnostics)
        _append_step(manifest, "sequence_validate", sequence_ok, sequence_diagnostics, [])
        manifest["sequence_validation"] = sequence_report

        score, score_diagnostics = score_design(design_source, parts_source)
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
    manifest["ok"] = all(
        step["ok"] for step in manifest["steps"] if not step.get("skipped") and step.get("required", True)
    ) and not any(item.get("severity") == "error" for item in manifest["diagnostics"])
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
    create_provenance(
        manifest_path,
        workspace_root=paths.workspace,
        build_root=paths.build,
        output_path=provenance_path,
    )
    return manifest, 0 if manifest["ok"] else 1


def _load_workflow(path: str | Path) -> dict[str, Any]:
    payload = read_json_bounded(path, MAX_JSON_FILE_BYTES)
    if not isinstance(payload, dict):
        raise ValueError("Workflow must be a JSON object.")
    return payload


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
