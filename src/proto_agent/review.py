from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .evidence import build_evidence_cards, write_evidence_cards
from .json_validation import JsonValidationError, strict_json_loads
from .literature import DEFAULT_LITERATURE_PATH
from .parts import DEFAULT_PARTS_PATH
from .provenance import ProvenanceError, create_provenance, verify_provenance
from .workflow import DEFAULT_WORKFLOW_PATH, run_design_review
from .security import MAX_JSON_FILE_BYTES, MAX_TEXT_FILE_BYTES, WorkspacePaths, read_bytes_bounded, write_text_bounded


DEFAULT_REVIEW_OUT_DIR = Path("build") / "reviews"


def build_review_packet(
    design_path: str | Path,
    parts_path: str | Path = DEFAULT_PARTS_PATH,
    workflow_path: str | Path = DEFAULT_WORKFLOW_PATH,
    out_dir: str | Path = DEFAULT_REVIEW_OUT_DIR,
    manifest_path: str | Path | None = None,
    literature_query: str | None = None,
    literature_registry: str | Path = DEFAULT_LITERATURE_PATH,
    *,
    workspace_root: str | Path | None = None,
) -> tuple[dict[str, Any], int]:
    paths = WorkspacePaths.create(workspace_root)
    design_source = paths.workspace_file(design_path, extensions={".proto"}, max_bytes=MAX_TEXT_FILE_BYTES)
    parts_source = paths.workspace_file(parts_path, extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
    workflow_source = paths.workspace_file(workflow_path, extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
    literature_source = paths.workspace_file(literature_registry, extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
    if manifest_path:
        manifest_source = paths.build_file(manifest_path, extensions={".json"}, must_exist=True)
    else:
        generated_manifest, _workflow_code = run_design_review(
            design_path,
            parts_path,
            workflow_path,
            workspace_root=paths.workspace,
        )
        manifest_source = paths.build_file(
            generated_manifest["manifest_path"],
            extensions={".json"},
            must_exist=True,
        )

    manifest, workflow_provenance = _load_verified_workflow_manifest(manifest_source, paths)
    expected_inputs = {
        "design": design_source.relative_to(paths.workspace).as_posix(),
        "parts": parts_source.relative_to(paths.workspace).as_posix(),
        "workflow": workflow_source.relative_to(paths.workspace).as_posix(),
    }
    _validate_manifest(manifest, expected_inputs=expected_inputs)
    workflow_code = 0 if manifest["ok"] else 1

    run_id = manifest.get("run_id") or _fallback_run_id(design_path)
    if not isinstance(run_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", run_id):
        raise ValueError("Review manifest run_id is missing or unsafe.")
    review_dir = paths.run_directory(out_dir, run_id)

    evidence_payload = build_evidence_cards(
        manifest,
        literature_query=literature_query,
        literature_registry=literature_source,
    )
    evidence_path = write_evidence_cards(evidence_payload, review_dir / "evidence.cards.json")
    checklist_path = _write_checklist(review_dir / "human_review_checklist.md", manifest, evidence_payload)
    packet_path = review_dir / "review_packet.json"
    markdown_path = review_dir / "review_packet.md"
    provenance_path = review_dir / "provenance.json"

    packet = {
        "schema_version": "proto-agent.review_packet.v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "ok": manifest["ok"] and evidence_payload["summary"]["status_counts"].get("failed", 0) == 0,
        "run_id": run_id,
        "design_path": design_source.relative_to(paths.workspace).as_posix(),
        "manifest_path": manifest_source.relative_to(paths.workspace).as_posix(),
        "provenance_path": provenance_path.relative_to(paths.workspace).as_posix(),
        "inputs": {
            "design": design_source.relative_to(paths.workspace).as_posix(),
            "parts": parts_source.relative_to(paths.workspace).as_posix(),
            "workflow": workflow_source.relative_to(paths.workspace).as_posix(),
            "literature": literature_source.relative_to(paths.workspace).as_posix(),
            "workflow_manifest": manifest_source.relative_to(paths.workspace).as_posix(),
            "workflow_provenance": workflow_provenance.relative_to(paths.workspace).as_posix(),
        },
        "review_status": manifest.get("review_status", "human_review_required"),
        "summary": manifest.get("summary", ""),
        "evidence_summary": evidence_payload["summary"],
        "artifacts": _artifact_list(
            manifest,
            evidence_path,
            checklist_path,
            markdown_path,
            workspace=paths.workspace,
        ),
        "review_gates": _review_gates(manifest, evidence_payload),
        "next_actions": _next_actions(manifest, evidence_payload),
        "safety_boundary": (
            "Software validation only; this review packet does not certify wet-lab readiness, "
            "orderability, biosafety, or regulatory compliance."
        ),
    }
    packet["packet_path"] = packet_path.relative_to(paths.workspace).as_posix()
    packet["markdown_path"] = markdown_path.relative_to(paths.workspace).as_posix()

    final_manifest, final_workflow_provenance = _load_verified_workflow_manifest(manifest_source, paths)
    if final_manifest != manifest or final_workflow_provenance != workflow_provenance:
        raise ProvenanceError("workflow inputs changed while the review packet was being assembled")
    write_text_bounded(packet_path, json.dumps(packet, indent=2) + "\n", boundary=paths.build)
    write_text_bounded(markdown_path, _render_markdown(packet, evidence_payload), boundary=paths.build)
    create_provenance(
        packet_path,
        workspace_root=paths.workspace,
        build_root=paths.build,
        output_path=provenance_path,
    )
    return packet, workflow_code


def _artifact_list(
    manifest: dict[str, Any],
    evidence_path: Path,
    checklist_path: Path,
    markdown_path: Path,
    *,
    workspace: Path,
) -> list[str]:
    artifacts = list(manifest.get("artifacts", []))
    artifacts.extend(
        path.relative_to(workspace).as_posix()
        for path in (evidence_path, checklist_path, markdown_path)
    )
    return artifacts


def _load_verified_workflow_manifest(
    manifest_source: Path,
    paths: WorkspacePaths,
) -> tuple[dict[str, Any], Path]:
    expected_path = manifest_source.parent / "provenance.json"
    verification = verify_provenance(
        expected_path,
        workspace_root=paths.workspace,
        build_root=paths.build,
    )
    if not verification["ok"]:
        codes = sorted({item.get("code", "UNKNOWN") for item in verification["mismatches"]})
        raise ProvenanceError(f"workflow provenance verification failed: {', '.join(codes)}")

    subject = verification.get("subject")
    expected_subject = manifest_source.relative_to(paths.build).as_posix()
    if not isinstance(subject, dict) or subject.get("path") != expected_subject:
        raise ProvenanceError("workflow provenance subject does not bind the supplied manifest")

    payload = read_bytes_bounded(manifest_source, MAX_JSON_FILE_BYTES)
    if len(payload) != subject.get("size") or hashlib.sha256(payload).hexdigest() != subject.get("sha256"):
        raise ProvenanceError("workflow manifest changed after provenance verification")
    try:
        manifest = strict_json_loads(payload.decode("utf-8"), max_bytes=MAX_JSON_FILE_BYTES)
    except (UnicodeDecodeError, JsonValidationError) as exc:
        raise ProvenanceError("workflow manifest is not strict bounded UTF-8 JSON") from exc
    if not isinstance(manifest, dict):
        raise ProvenanceError("workflow manifest must be a JSON object")

    expected_claim = expected_path.relative_to(paths.workspace).as_posix()
    if manifest.get("provenance_path") != expected_claim:
        raise ProvenanceError("workflow manifest provenance_path is missing or does not match its run directory")
    expected_manifest_claim = manifest_source.relative_to(paths.workspace).as_posix()
    if manifest.get("manifest_path") != expected_manifest_claim:
        raise ProvenanceError("workflow manifest_path does not bind the supplied manifest file")
    return manifest, expected_path


def _review_gates(manifest: dict[str, Any], evidence_payload: dict[str, Any]) -> list[dict[str, Any]]:
    failed_cards = evidence_payload["summary"].get("failed_card_ids", [])
    needs_review_cards = evidence_payload["summary"].get("needs_review_card_ids", [])
    return [
        {
            "id": "software_validation",
            "status": "passed" if manifest.get("ok") and not failed_cards else "blocked",
            "evidence": failed_cards,
        },
        {
            "id": "scientific_human_review",
            "status": "required",
            "evidence": needs_review_cards,
        },
        {
            "id": "wet_lab_or_order_readiness",
            "status": "out_of_scope",
            "evidence": [],
        },
    ]


def _next_actions(manifest: dict[str, Any], evidence_payload: dict[str, Any]) -> list[str]:
    actions = []
    if evidence_payload["summary"]["status_counts"].get("failed", 0):
        actions.append("Resolve failed evidence cards and rerun the design review workflow.")
    actions.append("Review human-review evidence cards before using outputs in any scientific decision.")
    if manifest.get("artifacts"):
        actions.append("Inspect generated exchange artifacts for interoperability expectations.")
    actions.append("Replace toy fixture libraries with reviewed source libraries before real biological design.")
    return actions


def _write_checklist(path: Path, manifest: dict[str, Any], evidence_payload: dict[str, Any]) -> Path:
    lines = [
        "# Human Review Checklist",
        "",
        f"- [ ] Confirm design intent for `{manifest.get('inputs', {}).get('design', '')}`.",
        "- [ ] Review all failed and needs-review evidence cards.",
        "- [ ] Verify part library provenance and intended chassis.",
        "- [ ] Verify sequence constraints and export format expectations.",
        "- [ ] Confirm no wet-lab readiness, orderability, biosafety, or regulatory claim is being made.",
        "",
        "## Evidence Cards Needing Attention",
        "",
    ]
    card_ids = (
        evidence_payload["summary"].get("failed_card_ids", [])
        + evidence_payload["summary"].get("needs_review_card_ids", [])
    )
    if card_ids:
        lines.extend([f"- [ ] {card_id}" for card_id in card_ids])
    else:
        lines.append("- [ ] No failed cards; review human gate cards before final acceptance.")
    write_text_bounded(path, "\n".join(lines) + "\n", boundary=path.parent)
    return path


def _render_markdown(packet: dict[str, Any], evidence_payload: dict[str, Any]) -> str:
    counts = packet["evidence_summary"]["status_counts"]
    lines = [
        "# Proto Review Packet",
        "",
        f"- Run: `{packet['run_id']}`",
        f"- Design: `{packet['design_path']}`",
        f"- Manifest: `{packet['manifest_path']}`",
        f"- Review status: `{packet['review_status']}`",
        f"- Summary: {packet['summary']}",
        "",
        "## Evidence Summary",
        "",
        f"- Supported: {counts.get('supported', 0)}",
        f"- Failed: {counts.get('failed', 0)}",
        f"- Needs review: {counts.get('needs_review', 0)}",
        f"- Not applicable: {counts.get('not_applicable', 0)}",
        "",
        "## Review Gates",
        "",
    ]
    lines.extend([f"- `{gate['id']}`: {gate['status']}" for gate in packet["review_gates"]])
    lines.extend(["", "## Evidence Cards", ""])
    for card in evidence_payload["cards"]:
        lines.append(f"- `{card['id']}` [{card['status']}]: {card['claim']}")
    lines.extend(["", "## Safety Boundary", "", packet["safety_boundary"], ""])
    return "\n".join(lines)


def _fallback_run_id(design_path: str | Path) -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    safe_stem = re.sub(r"[^A-Za-z0-9._-]", "_", Path(design_path).stem)[:64]
    if not safe_stem or not safe_stem[0].isalnum():
        safe_stem = "design"
    return f"{safe_stem}-{timestamp}"


def _validate_manifest(
    manifest: Any,
    *,
    expected_inputs: dict[str, str] | None = None,
) -> None:
    if not isinstance(manifest, dict):
        raise ValueError("Review manifest must be a JSON object.")
    if manifest.get("schema_version") != "proto-agent.run.v1":
        raise ValueError("Review manifest schema_version must be proto-agent.run.v1.")
    if not isinstance(manifest.get("ok"), bool):
        raise ValueError("Review manifest ok must be a boolean.")
    run_id = manifest.get("run_id")
    if not isinstance(run_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", run_id):
        raise ValueError("Review manifest run_id is missing or unsafe.")
    inputs = manifest.get("inputs")
    if (
        not isinstance(inputs, dict)
        or set(inputs) != {"design", "parts", "workflow"}
        or not all(isinstance(value, str) and 1 <= len(value) <= 512 for value in inputs.values())
    ):
        raise ValueError("Review manifest inputs must contain only bounded design, parts, and workflow paths.")
    if expected_inputs is not None and inputs != expected_inputs:
        raise ValueError("Review manifest inputs do not match the requested design, parts, and workflow.")
    if manifest.get("review_status") != "human_review_required":
        raise ValueError("Review manifest must retain the human_review_required gate.")
    if not isinstance(manifest.get("summary"), str) or len(manifest["summary"]) > 8192:
        raise ValueError("Review manifest summary is malformed or exceeds the limit.")

    steps = manifest.get("steps")
    artifacts = manifest.get("artifacts")
    if not isinstance(steps, list) or not 1 <= len(steps) <= 128 or not all(isinstance(step, dict) for step in steps):
        raise ValueError("Review manifest steps are malformed or exceed the limit.")
    if not isinstance(artifacts, list) or len(artifacts) > 256 or not all(
        isinstance(artifact, str) and len(artifact) <= 512 for artifact in artifacts
    ):
        raise ValueError("Review manifest artifacts are malformed or exceed the limit.")

    expected_step_ids = {
        "check",
        "compile",
        "sequence_validate",
        "score",
        "export_sbol",
        "sbol_validate",
        "export_genbank",
        "export_fasta",
    }
    step_ids: list[str] = []
    flattened_diagnostics: list[dict[str, Any]] = []
    flattened_artifacts: list[str] = []
    for step in steps:
        if set(step) != {"id", "ok", "required", "skipped", "diagnostics", "artifacts"}:
            raise ValueError("Review manifest step contains missing or unknown fields.")
        step_id = step.get("id")
        if not isinstance(step_id, str) or step_id not in expected_step_ids:
            raise ValueError("Review manifest step id is unsupported.")
        if not all(isinstance(step.get(key), bool) for key in ("ok", "required", "skipped")):
            raise ValueError("Review manifest step status fields must be boolean.")
        diagnostics = step.get("diagnostics")
        step_artifacts = step.get("artifacts")
        if not isinstance(diagnostics, list) or len(diagnostics) > 1024 or not all(
            isinstance(item, dict) for item in diagnostics
        ):
            raise ValueError("Review manifest step diagnostics are malformed or exceed the limit.")
        if not isinstance(step_artifacts, list) or len(step_artifacts) > 256 or not all(
            isinstance(item, str) and 1 <= len(item) <= 512 for item in step_artifacts
        ):
            raise ValueError("Review manifest step artifacts are malformed or exceed the limit.")
        step_ids.append(step_id)
        flattened_diagnostics.extend(diagnostics)
        flattened_artifacts.extend(step_artifacts)

    if set(step_ids) != expected_step_ids or len(step_ids) != len(expected_step_ids):
        raise ValueError("Review manifest must contain each required workflow step exactly once.")
    if manifest.get("diagnostics") != flattened_diagnostics:
        raise ValueError("Review manifest diagnostics do not match its step diagnostics.")
    if artifacts != flattened_artifacts:
        raise ValueError("Review manifest artifacts do not match its step artifacts.")
    recomputed_ok = all(
        step["ok"] for step in steps if not step["skipped"] and step["required"]
    ) and not any(item.get("severity") == "error" for item in flattened_diagnostics)
    if manifest["ok"] != recomputed_ok:
        raise ValueError("Review manifest ok does not match its required steps and diagnostics.")
