from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .evidence import build_evidence_cards, write_evidence_cards
from .json_validation import JsonValidationError, strict_json_loads
from .literature import DEFAULT_LITERATURE_PATH
from .materials import (
    MATERIALS_SCHEMA_VERSION,
    MAX_MATERIALIZED_PARTS,
    PARTS_SCHEMA_VERSION,
    PART_TYPES,
    MaterialsStore,
    default_materials_root,
)
from .parts import DEFAULT_PARTS_PATH
from .provenance import ProvenanceError, create_provenance, verify_provenance
from .workflow import DEFAULT_WORKFLOW_PATH, resolve_workflow_skills, run_design_review
from .security import (
    MAX_JSON_FILE_BYTES,
    MAX_TEXT_FILE_BYTES,
    WorkspacePaths,
    read_bytes_bounded,
    write_text_bounded,
)
from .skill_sdk import resolve_skill_adapter


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
    verified_inputs = _verify_current_workflow_skill_bindings(
        manifest,
        {"design": design_source, "parts": parts_source, "workflow": workflow_source},
        paths,
    )
    governed_parts_library = _is_governed_materialized_parts_library(
        verified_inputs["parts"],
        workspace=paths.workspace,
    )
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
        "skill_compatibility": manifest["skill_compatibility"],
        "skill_catalog_sha256": manifest.get("skill_catalog_sha256", ""),
        "connector_registry_sha256": manifest.get("connector_registry_sha256", ""),
        "workflow_skill_bindings": manifest.get("skill_bindings", []),
        "review_skill_bindings": _review_skill_bindings(
            paths,
            literature_query,
            evidence_path,
            checklist_path,
            workflow_provenance,
            manifest["skill_catalog_sha256"],
            manifest["connector_registry_sha256"],
            manifest["skill_compatibility"],
        ),
        "evidence_summary": evidence_payload["summary"],
        "artifacts": _artifact_list(
            manifest,
            evidence_path,
            checklist_path,
            markdown_path,
            workspace=paths.workspace,
        ),
        "review_gates": _review_gates(manifest, evidence_payload),
        "next_actions": _next_actions(
            manifest,
            evidence_payload,
            governed_parts_library=governed_parts_library,
        ),
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


def _review_skill_bindings(
    paths: WorkspacePaths,
    literature_query: str | None,
    evidence_path: Path,
    checklist_path: Path,
    workflow_provenance: Path,
    expected_catalog_sha256: str,
    expected_connector_registry_sha256: str,
    skill_compatibility: dict[str, str],
) -> list[dict[str, Any]]:
    if skill_compatibility["status"] == "needs_review":
        return []
    requests = [
        ("research-provenance", ["capture-human-review", "verify-provenance"]),
        (
            "evidence-first-literature-review",
            ["bind-review-evidence"] + (["search-local-sources"] if literature_query else []),
        ),
    ]
    bindings: list[dict[str, Any]] = []
    for skill_id, requested_operations in requests:
        resolution = resolve_skill_adapter(skill_id, workspace_root=paths.workspace)
        if (
            resolution["catalog_sha256"] != expected_catalog_sha256
            or resolution["connector_registry_sha256"] != expected_connector_registry_sha256
        ):
            raise ProvenanceError("Skill catalog or connector registry changed after the workflow was recorded")
        adapter = resolution["adapter"]
        operations = {operation["id"]: operation for operation in adapter["operations"]}
        missing = [
            operation_id
            for operation_id in requested_operations
            if operation_id not in operations or not operations[operation_id]["available"]
        ]
        if missing:
            raise ValueError(f"Review skill operations are unavailable for {skill_id}: {', '.join(missing)}")
        bindings.append(
            {
                "skill_id": skill_id,
                "application_status": "applied_with_evidence",
                "operations": requested_operations,
                "evidence": [
                    path.relative_to(paths.workspace).as_posix()
                    for path in (
                        (workflow_provenance, evidence_path, checklist_path)
                        if skill_id == "research-provenance"
                        else (evidence_path,)
                    )
                ],
                "adapter_version": adapter["version"],
                "catalog_sha256": resolution["catalog_sha256"],
                "connector_registry_sha256": resolution["connector_registry_sha256"],
                "manifest_sha256": adapter["manifest_sha256"],
                "document_sha256": adapter["document_sha256"],
            }
        )
    return bindings


def _verify_current_workflow_skill_bindings(
    manifest: dict[str, Any],
    input_sources: dict[str, Path],
    paths: WorkspacePaths,
) -> dict[str, bytes]:
    """Verify consumed snapshots, then re-resolve rather than trust self-described bindings."""

    current_payloads: dict[str, bytes] = {}
    for name, source in input_sources.items():
        limit = MAX_TEXT_FILE_BYTES if name == "design" else MAX_JSON_FILE_BYTES
        current_bytes = read_bytes_bounded(source, limit)
        snapshot_source = paths.build_file(
            manifest["inputs"][f"consumed_{name}"],
            extensions={".proto"} if name == "design" else {".json"},
            must_exist=True,
        )
        snapshot_bytes = read_bytes_bounded(snapshot_source, limit)
        expected = manifest["input_digests"][name]
        if (
            len(current_bytes) != expected["size"]
            or hashlib.sha256(current_bytes).hexdigest() != expected["sha256"]
            or snapshot_bytes != current_bytes
        ):
            raise ProvenanceError(f"{name} input no longer matches the immutable bytes consumed by the run")
        current_payloads[name] = current_bytes

    current_bytes = current_payloads["workflow"]
    try:
        current_workflow = strict_json_loads(current_bytes.decode("utf-8"), max_bytes=MAX_JSON_FILE_BYTES)
    except (UnicodeDecodeError, JsonValidationError) as exc:
        raise ProvenanceError("workflow definition is not strict bounded UTF-8 JSON") from exc
    if not isinstance(current_workflow, dict) or current_workflow != manifest["workflow"]:
        raise ProvenanceError("workflow definition changed after the workflow manifest was recorded")
    if hashlib.sha256(current_bytes).hexdigest() != manifest["workflow_sha256"]:
        raise ProvenanceError("workflow input digest does not match the bytes consumed by the run")
    try:
        (
            expected_catalog_sha256,
            expected_connector_registry_sha256,
            expected_bindings,
            expected_compatibility,
        ) = resolve_workflow_skills(current_workflow, paths)
    except ValueError as exc:
        raise ProvenanceError("workflow Skill bindings no longer resolve against the governed catalog") from exc

    if manifest["connector_registry_sha256"] != expected_connector_registry_sha256:
        raise ProvenanceError("connector registry changed after the workflow was recorded")
    if manifest["skill_catalog_sha256"] != expected_catalog_sha256:
        raise ProvenanceError("Skill catalog changed after the workflow was recorded")
    if manifest["skill_compatibility"] != expected_compatibility:
        raise ProvenanceError("workflow Skill compatibility evidence does not match current governed resolution")
    if manifest["skill_bindings"] != expected_bindings:
        raise ProvenanceError("workflow Skill bindings do not match current governed resolution")
    return current_payloads


def _is_governed_materialized_parts_library(payload: bytes, *, workspace: Path) -> bool:
    """Recognize a materialized library only when its locked catalog still verifies."""

    try:
        library = strict_json_loads(payload.decode("utf-8"), max_bytes=MAX_JSON_FILE_BYTES)
    except (UnicodeDecodeError, JsonValidationError):
        return False
    if (
        not isinstance(library, dict)
        or set(library) != {"schema_version", "library_id", "version", "chassis", "notice", "parts"}
        or library.get("schema_version") != PARTS_SCHEMA_VERSION
    ):
        return False

    snapshot_id = library.get("version")
    chassis = library.get("chassis")
    library_id = library.get("library_id")
    notice = library.get("notice")
    parts = library.get("parts")
    if (
        not isinstance(snapshot_id, str)
        or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", snapshot_id) is None
        or not isinstance(chassis, str)
        or not 1 <= len(chassis) <= 256
        or not isinstance(library_id, str)
        or not re.fullmatch(r"selection:[0-9a-f]{64}", library_id)
        or notice
        != "Materialized from an auditable external catalog. Human review required; not a wet-lab readiness claim."
        or not isinstance(parts, list)
        or not 1 <= len(parts) <= MAX_MATERIALIZED_PARTS
    ):
        return False

    resource_ids: list[str] = []
    seen: set[str] = set()
    for part in parts:
        if not isinstance(part, dict):
            return False
        resource_id = part.get("resource_id")
        sequence = part.get("sequence")
        sequence_sha256 = part.get("sequence_sha256")
        source = part.get("source")
        license_info = part.get("license")
        evidence_refs = part.get("evidence_refs")
        if (
            not isinstance(resource_id, str)
            or not 1 <= len(resource_id) <= 256
            or ":" not in resource_id
            or part.get("id") != resource_id
            or part.get("type") not in PART_TYPES
            or part.get("sequence_kind") != "DNA"
            or not isinstance(sequence, str)
            or not sequence
            or not isinstance(sequence_sha256, str)
            or not re.fullmatch(r"[0-9a-f]{64}", sequence_sha256)
            or not isinstance(source, dict)
            or not isinstance(license_info, dict)
            or not isinstance(evidence_refs, list)
            or not evidence_refs
            or not all(isinstance(ref, str) and ref for ref in evidence_refs)
            or part.get("review_status") != "DESIGN_ELIGIBLE"
            or part.get("safety_status") != "NO_FLAG"
            or part.get("safety_flags") != []
            or part.get("design_eligibility") is not True
        ):
            return False
        canonical_id = resource_id.casefold()
        if canonical_id in seen:
            return False
        seen.add(canonical_id)
        resource_ids.append(resource_id)
        try:
            sequence_bytes = sequence.encode("ascii")
        except UnicodeEncodeError:
            return False
        if hashlib.sha256(sequence_bytes).hexdigest() != sequence_sha256:
            return False
        if not all(isinstance(source.get(field), str) and source[field] for field in ("provider", "record_id", "url")):
            return False
        if source.get("sequence_sha256") != sequence_sha256:
            return False
        if not isinstance(source.get("content_sha256"), str) or not re.fullmatch(
            r"[0-9a-f]{64}", source["content_sha256"]
        ):
            return False
        if not all(
            isinstance(license_info.get(field), str) and license_info[field]
            for field in ("id", "url", "attribution", "rights_notes")
        ) or license_info.get("redistribution_status") != "REDISTRIBUTABLE":
            return False

    canonical_ids = sorted(resource_ids, key=lambda value: (value.casefold(), value))
    if resource_ids != canonical_ids:
        return False
    receipt = json.dumps(
        {"snapshot_id": snapshot_id, "chassis": chassis, "ids": canonical_ids},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    if library_id != f"selection:{hashlib.sha256(receipt).hexdigest()}":
        return False
    return _matches_locked_materials_snapshot(library, workspace=workspace)


def _matches_locked_materials_snapshot(library: dict[str, Any], *, workspace: Path) -> bool:
    """Bind a self-contained selection to the separately stored, verified catalog."""

    snapshot_id = str(library["version"])
    materials_root = default_materials_root(workspace)
    snapshot_dir = materials_root / "snapshots" / snapshot_id
    if (
        not materials_root.is_dir()
        or materials_root.is_symlink()
        or not snapshot_dir.is_dir()
        or snapshot_dir.is_symlink()
    ):
        return False

    try:
        store = MaterialsStore(workspace=workspace, root=materials_root)
        manifest = store.manifest(snapshot_id)
        if (
            manifest.get("schema_version") != MATERIALS_SCHEMA_VERSION
            or manifest.get("snapshot_id") != snapshot_id
        ):
            return False
        store._verify_snapshot(snapshot_id, manifest)
        attestations, audit_summary = store._snapshot_promotion_attestations(snapshot_id, manifest)
        if not attestations and audit_summary.get("attestation_resolution") != "catalog-issued-normalized-record-binding":
            return False

        chassis = str(library["chassis"])
        parts = library["parts"]
        for part in parts:
            resource_id = str(part["resource_id"])
            if attestations and resource_id not in attestations:
                return False
            resource = store.get(
                resource_id,
                include_sequence=True,
                snapshot_id=snapshot_id,
                auto_initialize=False,
            )["resource"]
            if (
                resource.get("kind") != "genetic_part"
                or resource.get("part_type") not in PART_TYPES
                or chassis not in resource.get("chassis", [])
                or resource.get("review_status") != "DESIGN_ELIGIBLE"
                or resource.get("safety_status") != "NO_FLAG"
                or resource.get("safety_flags") != []
                or resource.get("design_eligibility") is not True
            ):
                return False
            expected = {
                "id": resource["resource_id"],
                "type": resource["part_type"],
                "name": resource["name"],
                "description": resource["description_en"],
                "description_zh": resource["description_zh"],
                "sequence": resource["sequence"],
                "sequence_kind": resource["sequence_kind"],
                "sequence_sha256": resource["sequence_sha256"],
                "source": resource["source"],
                "license": resource["license"],
                "resource_id": resource["resource_id"],
                "review_status": resource["review_status"],
                "safety_status": resource["safety_status"],
                "safety_flags": resource["safety_flags"],
                "design_eligibility": resource["design_eligibility"],
                "evidence_refs": resource["evidence_refs"],
            }
            if part != expected:
                return False

        final_manifest = store.manifest(snapshot_id)
        if final_manifest != manifest:
            return False
        store._verify_snapshot(snapshot_id, final_manifest)
        return True
    except (OSError, sqlite3.Error, ValueError):
        return False


def _next_actions(
    manifest: dict[str, Any],
    evidence_payload: dict[str, Any],
    *,
    governed_parts_library: bool,
) -> list[str]:
    actions = []
    if manifest["skill_compatibility"]["status"] == "needs_review":
        actions.append(
            "Review and explicitly adopt a current workflow with governed Skill bindings; "
            "do not overwrite the existing workflow automatically."
        )
    if evidence_payload["summary"]["status_counts"].get("failed", 0):
        actions.append("Resolve failed evidence cards and rerun the design review workflow.")
    actions.append("Review human-review evidence cards before using outputs in any scientific decision.")
    if manifest.get("artifacts"):
        actions.append("Inspect generated exchange artifacts for interoperability expectations.")
    if not governed_parts_library:
        actions.append("Replace toy fixture libraries with reviewed source libraries before real biological design.")
    return actions


def _write_checklist(path: Path, manifest: dict[str, Any], evidence_payload: dict[str, Any]) -> Path:
    lines = [
        "# Human Review Checklist",
        "",
        f"- [ ] Confirm design intent for `{manifest.get('inputs', {}).get('design', '')}`.",
        *(
            ["- [ ] Explicitly adopt a current workflow with governed Skill bindings; preserve the legacy source file."]
            if manifest["skill_compatibility"]["status"] == "needs_review"
            else []
        ),
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
    expected_input_fields = {
        "design",
        "parts",
        "workflow",
        "consumed_design",
        "consumed_parts",
        "consumed_workflow",
    }
    if (
        not isinstance(inputs, dict)
        or set(inputs) != expected_input_fields
        or not all(isinstance(value, str) and 1 <= len(value) <= 512 for value in inputs.values())
    ):
        raise ValueError("Review manifest inputs must contain the original and consumed bounded input paths.")
    if expected_inputs is not None and any(inputs[name] != value for name, value in expected_inputs.items()):
        raise ValueError("Review manifest inputs do not match the requested design, parts, and workflow.")
    input_digests = manifest.get("input_digests")
    if not isinstance(input_digests, dict) or set(input_digests) != {"design", "parts", "workflow"}:
        raise ValueError("Review manifest input digests are missing or malformed.")
    for digest in input_digests.values():
        if (
            not isinstance(digest, dict)
            or set(digest) != {"sha256", "size"}
            or not isinstance(digest.get("sha256"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", digest["sha256"])
            or not isinstance(digest.get("size"), int)
            or isinstance(digest["size"], bool)
            or not 0 <= digest["size"] <= MAX_JSON_FILE_BYTES
        ):
            raise ValueError("Review manifest input digest record is malformed.")
    if manifest.get("review_status") != "human_review_required":
        raise ValueError("Review manifest must retain the human_review_required gate.")
    if not isinstance(manifest.get("summary"), str) or len(manifest["summary"]) > 8192:
        raise ValueError("Review manifest summary is malformed or exceeds the limit.")
    compatibility = manifest.get("skill_compatibility")
    compatibility_fields = {"mode", "status", "reason_code", "message"}
    if (
        not isinstance(compatibility, dict)
        or set(compatibility) != compatibility_fields
        or not isinstance(compatibility.get("message"), str)
        or not 1 <= len(compatibility["message"]) <= 1024
    ):
        raise ValueError("Review manifest Skill compatibility evidence is missing or malformed.")
    workflow_payload = manifest.get("workflow")
    if not isinstance(workflow_payload, dict):
        raise ValueError("Review manifest workflow definition is missing or malformed.")
    workflow_sha256 = manifest.get("workflow_sha256")
    if not isinstance(workflow_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", workflow_sha256):
        raise ValueError("Review manifest workflow input digest is missing or malformed.")
    if workflow_sha256 != input_digests["workflow"]["sha256"]:
        raise ValueError("Review manifest workflow digest claims disagree.")
    declared_skill_bindings = workflow_payload.get("skill_bindings", [])
    skill_catalog_sha256 = manifest.get("skill_catalog_sha256")
    connector_registry_sha256 = manifest.get("connector_registry_sha256")
    skill_bindings = manifest.get("skill_bindings")
    if compatibility == {
        "mode": "legacy_no_skill_bindings",
        "status": "needs_review",
        "reason_code": "LEGACY_WORKFLOW_SKILL_BINDINGS_MISSING",
        "message": compatibility["message"],
    }:
        if declared_skill_bindings != []:
            raise ValueError("Legacy Skill compatibility cannot be used with declared workflow Skill bindings.")
        if skill_catalog_sha256 != "" or connector_registry_sha256 != "" or skill_bindings != []:
            raise ValueError("Legacy Skill compatibility must not claim catalog, connector, or binding evidence.")
        if manifest["ok"]:
            raise ValueError("Legacy workflows without governed Skill bindings must fail closed.")
    elif compatibility == {
        "mode": "skill_bound",
        "status": "resolved",
        "reason_code": "SKILL_BINDINGS_RESOLVED",
        "message": compatibility["message"],
    }:
        if not isinstance(declared_skill_bindings, list) or not declared_skill_bindings:
            raise ValueError("Resolved Skill compatibility requires declared workflow Skill bindings.")
        if not isinstance(skill_catalog_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", skill_catalog_sha256):
            raise ValueError("Review manifest skill catalogue digest is missing or malformed.")
        if not isinstance(connector_registry_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", connector_registry_sha256):
            raise ValueError("Review manifest connector registry digest is missing or malformed.")
        if not isinstance(skill_bindings, list) or not 1 <= len(skill_bindings) <= 16:
            raise ValueError("Review manifest skill bindings are missing or exceed the limit.")
    else:
        raise ValueError("Review manifest Skill compatibility mode is unsupported.")
    for binding in skill_bindings:
        expected_fields = {
            "skill_id",
            "stage",
            "required",
            "resolution_status",
            "operations",
            "missing_operations",
            "adapter_version",
            "manifest_sha256",
            "document_sha256",
        }
        if not isinstance(binding, dict) or set(binding) != expected_fields:
            raise ValueError("Review manifest skill binding contains missing or unknown fields.")
        if (
            not isinstance(binding["skill_id"], str)
            or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", binding["skill_id"])
            or not isinstance(binding["stage"], str)
            or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", binding["stage"])
            or not isinstance(binding["required"], bool)
            or binding["resolution_status"] != "resolved"
            or not isinstance(binding["operations"], list)
            or not 1 <= len(binding["operations"]) <= 16
            or not all(isinstance(item, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", item) for item in binding["operations"])
            or binding["missing_operations"] != []
            or not isinstance(binding["adapter_version"], str)
            or len(binding["adapter_version"]) > 64
            or not isinstance(binding["manifest_sha256"], str)
            or not re.fullmatch(r"[0-9a-f]{64}", binding["manifest_sha256"])
            or not isinstance(binding["document_sha256"], str)
            or not re.fullmatch(r"[0-9a-f]{64}", binding["document_sha256"])
        ):
            raise ValueError("Review manifest skill binding is malformed or unresolved.")

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
    recomputed_software_ok = all(
        step["ok"] for step in steps if not step["skipped"] and step["required"]
    ) and not any(item.get("severity") == "error" for item in flattened_diagnostics)
    recomputed_ok = recomputed_software_ok and compatibility["status"] == "resolved"
    if manifest["ok"] != recomputed_ok:
        raise ValueError("Review manifest ok does not match its required steps and diagnostics.")
