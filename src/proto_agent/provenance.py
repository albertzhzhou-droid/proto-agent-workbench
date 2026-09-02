from __future__ import annotations

import hashlib
import json
import math
import os
import platform
import stat
import sys
import tempfile
from contextlib import contextmanager
from decimal import Decimal, InvalidOperation
from datetime import datetime, timezone
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any


SCHEMA_VERSION = "proto-agent.provenance.v1"
DEFAULT_MAX_MANIFEST_BYTES = 8 * 1024 * 1024
DEFAULT_MAX_FILES = 1_024
DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024
DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024
DEFAULT_MAX_JSON_DEPTH = 64
DEFAULT_MAX_JSON_NODES = 100_000
DEFAULT_MAX_JSON_INTEGER = (1 << 63) - 1
_WINDOWS_RESERVED_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "CLOCK$",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}


class ProvenanceError(ValueError):
    """Raised when a provenance claim crosses a configured trust boundary."""


def create_provenance(
    manifest_path: str | Path,
    *,
    workspace_root: str | Path = ".",
    build_root: str | Path = "build",
    output_path: str | Path | None = None,
    max_files: int = DEFAULT_MAX_FILES,
    max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
    max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES,
) -> dict[str, Any]:
    """Create an unsigned, content-addressed statement for one run manifest.

    Inputs must be regular files under ``workspace_root`` and generated artifacts
    must be regular files under ``build_root``. Symlinks and junctions are rejected
    so that the statement cannot silently attest a file outside either root.
    """

    _validate_limits(max_files, max_file_bytes, max_total_bytes)
    workspace = _canonical_directory(workspace_root, "workspace_root")
    build_candidate = _rooted_path(build_root, workspace)
    _require_inside(workspace, build_candidate.absolute(), "build_root")
    build = _canonical_directory(build_candidate, "build_root")
    _require_inside(workspace, build, "build_root")
    manifest = _canonical_file(
        _rooted_path(manifest_path, workspace),
        build,
        "manifest",
        max_file_bytes=DEFAULT_MAX_MANIFEST_BYTES,
    )
    payload, manifest_snapshot = _load_json_object_snapshot(
        manifest,
        DEFAULT_MAX_MANIFEST_BYTES,
    )
    destination = _rooted_path(output_path, workspace) if output_path else manifest.parent / "provenance.json"
    destination = _canonical_output(destination, build, "provenance output")

    claimed_inputs = _path_claims(payload.get("inputs", {}), "input")
    claimed_artifacts = _path_claims(payload.get("artifacts", []), "artifact")
    if len(claimed_inputs) + len(claimed_artifacts) > max_files:
        raise ProvenanceError(f"manifest declares more than {max_files} files")

    material_files = [
        (
            name,
            _canonical_file(
                _rooted_path(value, workspace),
                workspace,
                "material",
                max_file_bytes=max_file_bytes,
            ),
        )
        for name, value in claimed_inputs
    ]
    artifact_files = [
        (
            name,
            _canonical_file(
                _rooted_path(value, workspace),
                build,
                "artifact",
                max_file_bytes=max_file_bytes,
            ),
        )
        for name, value in claimed_artifacts
    ]
    _validate_claim_graph(
        manifest,
        destination,
        material_files,
        artifact_files,
        manifest_identity=manifest_snapshot["identity"],
    )

    budget = _HashBudget(max_total_bytes=max_total_bytes)
    materials = [
        _file_record(name, path, workspace, "material", max_file_bytes, budget)
        for name, path in material_files
    ]
    artifacts = [
        _file_record(name, path, build, "artifact", max_file_bytes, budget)
        for name, path in artifact_files
    ]
    subject = _file_record(
        "manifest",
        manifest,
        build,
        "manifest",
        DEFAULT_MAX_MANIFEST_BYTES,
        budget,
    )
    if (
        subject["sha256"] != manifest_snapshot["sha256"]
        or subject["size"] != manifest_snapshot["size"]
        or _object_identity(_lstat(manifest, "manifest")) != manifest_snapshot["identity"]
    ):
        raise ProvenanceError("manifest changed between parsing and attestation")

    statement: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "run_id": _bounded_text(payload.get("run_id", ""), "run_id", 256),
        "subject": subject,
        "materials": materials,
        "artifacts": artifacts,
        "tool": {
            "name": "proto-agent",
            "version": _package_version(),
            "python": platform.python_version(),
            "platform": sys.platform,
        },
        "policy": {
            "digest": "sha256",
            "signature": "none",
            "path_mode": "root-relative-single-link-regular-files-no-reparse-points",
            "atomic_write": "same-directory-replace-with-parent-identity-checks",
            "max_files": max_files,
            "max_file_bytes": max_file_bytes,
            "max_total_bytes": max_total_bytes,
            "max_manifest_bytes": DEFAULT_MAX_MANIFEST_BYTES,
            "max_json_depth": DEFAULT_MAX_JSON_DEPTH,
            "max_json_nodes": DEFAULT_MAX_JSON_NODES,
            "duplicate_json_keys": "reject",
            "non_finite_json_numbers": "reject",
        },
    }

    _atomic_write_json(
        destination,
        statement,
        root=build,
        max_bytes=DEFAULT_MAX_MANIFEST_BYTES,
    )
    statement["provenance_path"] = str(destination)
    return statement


def verify_provenance(
    provenance_path: str | Path,
    *,
    workspace_root: str | Path = ".",
    build_root: str | Path = "build",
    max_files: int = DEFAULT_MAX_FILES,
    max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
    max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES,
) -> dict[str, Any]:
    """Recompute every digest in a provenance statement.

    The result is structured so callers can distinguish a changed file from an
    invalid or out-of-bound claim without parsing exception text.
    """

    _validate_limits(max_files, max_file_bytes, max_total_bytes)
    workspace = _canonical_directory(workspace_root, "workspace_root")
    build_candidate = _rooted_path(build_root, workspace)
    _require_inside(workspace, build_candidate.absolute(), "build_root")
    build = _canonical_directory(build_candidate, "build_root")
    _require_inside(workspace, build, "build_root")
    path = _canonical_file(
        _rooted_path(provenance_path, workspace),
        build,
        "provenance",
        max_file_bytes=DEFAULT_MAX_MANIFEST_BYTES,
    )
    statement, provenance_snapshot = _load_json_object_snapshot(
        path,
        DEFAULT_MAX_MANIFEST_BYTES,
    )
    mismatches: list[dict[str, Any]] = []
    checked = 0

    if statement.get("schema_version") != SCHEMA_VERSION:
        mismatches.append(
            {
                "code": "UNSUPPORTED_SCHEMA",
                "expected": SCHEMA_VERSION,
                "actual": statement.get("schema_version"),
            }
        )

    records: list[tuple[str, dict[str, Any], Path]] = []
    subject = statement.get("subject")
    if isinstance(subject, dict):
        records.append(("manifest", subject, build))
    else:
        mismatches.append({"code": "MISSING_SUBJECT", "name": "manifest"})
    for kind, root in (("material", workspace), ("artifact", build)):
        collection = statement.get("materials" if kind == "material" else "artifacts", [])
        if not isinstance(collection, list):
            mismatches.append({"code": "INVALID_RECORDS", "kind": kind})
            continue
        for record in collection:
            if isinstance(record, dict):
                records.append((kind, record, root))
            else:
                mismatches.append({"code": "INVALID_RECORD", "kind": kind})

    try:
        expected_records, manifest_payload = _expected_claim_records(
            subject,
            workspace=workspace,
            build=build,
        )
        actual_records = _actual_claim_records(statement)
        for missing in sorted(expected_records - actual_records):
            mismatches.append(
                {
                    "code": "MISSING_CLAIM_RECORD",
                    "kind": missing[0],
                    "name": missing[1],
                    "path": missing[2],
                }
            )
        for extra in sorted(actual_records - expected_records):
            mismatches.append(
                {
                    "code": "UNDECLARED_CLAIM_RECORD",
                    "kind": extra[0],
                    "name": extra[1],
                    "path": extra[2],
                }
            )
        if statement.get("run_id") != manifest_payload.get("run_id"):
            mismatches.append(
                {
                    "code": "RUN_ID_MISMATCH",
                    "expected": manifest_payload.get("run_id"),
                    "actual": statement.get("run_id"),
                }
            )
    except (OSError, ProvenanceError) as exc:
        mismatches.append({"code": "INVALID_CLAIM_GRAPH", "detail": str(exc)})

    if len(records) > max_files + 1:
        mismatches.append(
            {"code": "TOO_MANY_RECORDS", "limit": max_files + 1, "actual": len(records)}
        )
        records = records[: max_files + 1]

    budget = _HashBudget(max_total_bytes=max_total_bytes)
    seen_paths = {_path_key(path): "provenance"}
    seen_objects = {provenance_snapshot["identity"]: "provenance"}
    for kind, record, root in records:
        try:
            name = _bounded_text(record.get("name", ""), "record.name", 512)
        except ProvenanceError as exc:
            mismatches.append({"code": "INVALID_NAME", "kind": kind, "detail": str(exc)})
            continue
        relative = record.get("path")
        if not isinstance(relative, str) or not relative or len(relative) > 1_024:
            mismatches.append({"code": "INVALID_PATH", "kind": kind, "name": name})
            continue
        try:
            _validate_statement_relative_path(relative)
        except ProvenanceError as exc:
            mismatches.append(
                {"code": "INVALID_PATH", "kind": kind, "name": name, "detail": str(exc)}
            )
            continue

        expected_digest = record.get("sha256")
        expected_size = record.get("size")
        if not _is_sha256(expected_digest):
            mismatches.append({"code": "INVALID_DIGEST", "kind": kind, "name": name})
            continue
        file_limit = max_file_bytes if kind != "manifest" else DEFAULT_MAX_MANIFEST_BYTES
        if (
            not isinstance(expected_size, int)
            or isinstance(expected_size, bool)
            or expected_size < 0
            or expected_size > file_limit
        ):
            mismatches.append({"code": "INVALID_SIZE", "kind": kind, "name": name})
            continue
        try:
            candidate = _canonical_file(
                root / Path(relative),
                root,
                kind,
                max_file_bytes=file_limit,
            )
            candidate_key = _path_key(candidate)
            candidate_identity = _object_identity(_lstat(candidate, kind))
            conflict = seen_paths.get(candidate_key, seen_objects.get(candidate_identity))
            if conflict is not None:
                code = "SELF_REFERENCE" if conflict == "provenance" else "DUPLICATE_PATH"
                mismatches.append(
                    {
                        "code": code,
                        "kind": kind,
                        "name": name,
                        "conflicts_with": conflict,
                    }
                )
                continue
            seen_paths[candidate_key] = f"{kind}:{name}"
            seen_objects[candidate_identity] = f"{kind}:{name}"
            actual = _digest_file(
                candidate,
                budget,
                max_file_bytes=file_limit,
                label=kind,
            )
            checked += 1
        except (OSError, ProvenanceError) as exc:
            mismatches.append(
                {"code": "UNREADABLE_OR_OUTSIDE_ROOT", "kind": kind, "name": name, "detail": str(exc)}
            )
            continue

        if actual["sha256"] != expected_digest.lower():
            mismatches.append(
                {
                    "code": "DIGEST_MISMATCH",
                    "kind": kind,
                    "name": name,
                    "expected": expected_digest,
                    "actual": actual["sha256"],
                }
            )
        if actual["size"] != expected_size:
            mismatches.append(
                {
                    "code": "SIZE_MISMATCH",
                    "kind": kind,
                    "name": name,
                    "expected": expected_size,
                    "actual": actual["size"],
                }
            )

    try:
        final_provenance_metadata = _regular_metadata(
            path,
            "provenance",
            max_file_bytes=DEFAULT_MAX_MANIFEST_BYTES,
        )
        if _stable_signature(final_provenance_metadata) != provenance_snapshot["signature"]:
            mismatches.append({"code": "PROVENANCE_CHANGED_DURING_VERIFICATION"})
    except (OSError, ProvenanceError) as exc:
        mismatches.append(
            {"code": "PROVENANCE_CHANGED_DURING_VERIFICATION", "detail": str(exc)}
        )

    return {
        "schema_version": "proto-agent.provenance_verification.v1",
        "ok": not mismatches,
        "provenance_path": str(path),
        "subject": (
            {
                "path": subject.get("path"),
                "sha256": subject.get("sha256"),
                "size": subject.get("size"),
            }
            if isinstance(subject, dict)
            else None
        ),
        "checked": checked,
        "mismatches": mismatches,
        "warnings": ["Statement is digest-protected but unsigned."],
    }


def _expected_claim_records(
    subject: Any,
    *,
    workspace: Path,
    build: Path,
) -> tuple[set[tuple[str, str, str]], dict[str, Any]]:
    if not isinstance(subject, dict):
        raise ProvenanceError("provenance subject is missing")
    subject_path = subject.get("path")
    subject_digest = subject.get("sha256")
    subject_size = subject.get("size")
    if not isinstance(subject_path, str):
        raise ProvenanceError("provenance subject path is invalid")
    _validate_statement_relative_path(subject_path)
    if not _is_sha256(subject_digest) or not isinstance(subject_size, int) or isinstance(subject_size, bool):
        raise ProvenanceError("provenance subject digest or size is invalid")
    manifest_path = _canonical_file(
        build / Path(subject_path),
        build,
        "manifest",
        max_file_bytes=DEFAULT_MAX_MANIFEST_BYTES,
    )
    manifest, snapshot = _load_json_object_snapshot(manifest_path, DEFAULT_MAX_MANIFEST_BYTES)
    if snapshot["sha256"] != subject_digest.lower() or snapshot["size"] != subject_size:
        raise ProvenanceError("provenance subject does not match its manifest")

    expected: set[tuple[str, str, str]] = set()
    for kind, claims, record_root, allowed_root in (
        ("material", _path_claims(manifest.get("inputs", {}), "input"), workspace, workspace),
        ("artifact", _path_claims(manifest.get("artifacts", []), "artifact"), build, build),
    ):
        for name, value in claims:
            candidate = _canonical_file(
                _rooted_path(value, workspace),
                allowed_root,
                kind,
                max_file_bytes=DEFAULT_MAX_FILE_BYTES,
            )
            identity = (kind, name, candidate.relative_to(record_root).as_posix())
            if identity in expected:
                raise ProvenanceError(f"duplicate expected claim record: {identity}")
            expected.add(identity)
    return expected, manifest


def _actual_claim_records(statement: dict[str, Any]) -> set[tuple[str, str, str]]:
    actual: set[tuple[str, str, str]] = set()
    for kind, key in (("material", "materials"), ("artifact", "artifacts")):
        records = statement.get(key)
        if not isinstance(records, list):
            raise ProvenanceError(f"{key} must be an array")
        for record in records:
            if not isinstance(record, dict):
                raise ProvenanceError(f"{kind} record must be an object")
            name = _bounded_text(record.get("name", ""), f"{kind}.name", 512)
            path = _bounded_text(record.get("path", ""), f"{kind}.path", 1_024)
            _validate_statement_relative_path(path)
            identity = (kind, name, path)
            if identity in actual:
                raise ProvenanceError(f"duplicate claim record: {identity}")
            actual.add(identity)
    return actual


def compare_provenance(
    left_path: str | Path,
    right_path: str | Path,
    *,
    workspace_root: str | Path = ".",
    build_root: str | Path = "build",
    max_files: int = DEFAULT_MAX_FILES,
) -> dict[str, Any]:
    """Compare two bounded statements without reading their claimed artifacts."""

    if not isinstance(max_files, int) or isinstance(max_files, bool) or max_files <= 0:
        raise ProvenanceError("max_files must be positive")
    workspace = _canonical_directory(workspace_root, "workspace_root")
    build_candidate = _rooted_path(build_root, workspace)
    _require_inside(workspace, build_candidate.absolute(), "build_root")
    build = _canonical_directory(build_candidate, "build_root")
    _require_inside(workspace, build, "build_root")
    left_file = _canonical_file(
        _rooted_path(left_path, workspace),
        build,
        "left provenance",
        max_file_bytes=DEFAULT_MAX_MANIFEST_BYTES,
    )
    right_file = _canonical_file(
        _rooted_path(right_path, workspace),
        build,
        "right provenance",
        max_file_bytes=DEFAULT_MAX_MANIFEST_BYTES,
    )
    left, left_snapshot = _load_json_object_snapshot(left_file, DEFAULT_MAX_MANIFEST_BYTES)
    right, right_snapshot = _load_json_object_snapshot(right_file, DEFAULT_MAX_MANIFEST_BYTES)
    left_records = _statement_record_index(left, max_files=max_files)
    right_records = _statement_record_index(right, max_files=max_files)

    changes: list[dict[str, Any]] = []
    for identity in sorted(set(left_records) | set(right_records)):
        left_record = left_records.get(identity)
        right_record = right_records.get(identity)
        if left_record is None:
            status = "added"
        elif right_record is None:
            status = "removed"
        elif (
            left_record["sha256"] != right_record["sha256"]
            or left_record["size"] != right_record["size"]
        ):
            status = "modified"
        else:
            status = "unchanged"
        changes.append(
            {
                "kind": identity[0],
                "name": identity[1],
                "path": identity[2],
                "status": status,
                "left": _digest_summary(left_record),
                "right": _digest_summary(right_record),
            }
        )

    counts = {
        status: sum(item["status"] == status for item in changes)
        for status in ("added", "removed", "modified", "unchanged")
    }
    for label, statement_path, snapshot in (
        ("left provenance", left_file, left_snapshot),
        ("right provenance", right_file, right_snapshot),
    ):
        current = _regular_metadata(
            statement_path,
            label,
            max_file_bytes=DEFAULT_MAX_MANIFEST_BYTES,
        )
        if _stable_signature(current) != snapshot["signature"]:
            raise ProvenanceError(f"{label} changed during comparison")
    return {
        "schema_version": "proto-agent.provenance_comparison.v1",
        "ok": True,
        "left": {
            "path": str(left_file),
            "run_id": _bounded_text(left.get("run_id", ""), "left.run_id", 256),
        },
        "right": {
            "path": str(right_file),
            "run_id": _bounded_text(right.get("run_id", ""), "right.run_id", 256),
        },
        "counts": counts,
        "changed": bool(counts["added"] or counts["removed"] or counts["modified"]),
        "changes": changes,
    }


class _HashBudget:
    def __init__(self, *, max_total_bytes: int) -> None:
        if max_total_bytes <= 0:
            raise ProvenanceError("max_total_bytes must be positive")
        self.max_total_bytes = max_total_bytes
        self.used = 0

    def reserve(self, amount: int) -> None:
        if amount < 0:
            raise ProvenanceError("digest byte charge must not be negative")
        if amount > self.max_total_bytes - self.used:
            raise ProvenanceError(f"digest byte budget exceeded ({self.max_total_bytes} bytes)")
        self.used += amount


def _file_record(
    name: str,
    path: Path,
    root: Path,
    kind: str,
    max_file_bytes: int,
    budget: _HashBudget,
) -> dict[str, Any]:
    candidate = _canonical_file(path, root, kind, max_file_bytes=max_file_bytes)
    digest = _digest_file(
        candidate,
        budget,
        max_file_bytes=max_file_bytes,
        label=kind,
    )
    return {
        "name": _bounded_text(name, "record name", 512),
        "path": candidate.relative_to(root).as_posix(),
        **digest,
    }


def _digest_file(
    path: Path,
    budget: _HashBudget,
    *,
    max_file_bytes: int,
    label: str,
) -> dict[str, Any]:
    digest = hashlib.sha256()
    with _checked_binary_reader(path, label, max_file_bytes=max_file_bytes) as (
        handle,
        size,
        _,
        _,
    ):
        budget.reserve(size)
        remaining = size
        while remaining:
            chunk = handle.read(min(1024 * 1024, remaining))
            if not chunk:
                raise ProvenanceError(f"{label} changed while it was being digested")
            remaining -= len(chunk)
            digest.update(chunk)
        if handle.read(1):
            raise ProvenanceError(f"{label} grew while it was being digested")
    return {"sha256": digest.hexdigest(), "size": size}


def _path_claims(value: Any, prefix: str) -> list[tuple[str, str]]:
    claims: list[tuple[str, str]] = []
    if isinstance(value, dict):
        for key, item in value.items():
            path_value = item.get("path") if isinstance(item, dict) else item
            if not isinstance(path_value, str) or not path_value:
                raise ProvenanceError(f"{prefix} claim {key!r} must contain a non-empty path")
            _validate_claim_path_text(path_value, f"{prefix} claim {key!r}")
            claim_name = _bounded_text(f"{prefix}:{key}", "claim name", 512)
            claims.append((claim_name, path_value))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            path_value = item.get("path") if isinstance(item, dict) else item
            if not isinstance(path_value, str) or not path_value:
                raise ProvenanceError(f"{prefix} claim {index} must contain a non-empty path")
            _validate_claim_path_text(path_value, f"{prefix} claim {index}")
            claim_name = _bounded_text(f"{prefix}:{index}", "claim name", 512)
            claims.append((claim_name, path_value))
    else:
        raise ProvenanceError(f"{prefix} claims must be an object or array")
    return claims


def _statement_record_index(
    statement: dict[str, Any],
    *,
    max_files: int,
) -> dict[tuple[str, str, str], dict[str, Any]]:
    if statement.get("schema_version") != SCHEMA_VERSION:
        raise ProvenanceError(f"unsupported provenance schema: {statement.get('schema_version')!r}")
    raw_records: list[tuple[str, Any]] = [("manifest", statement.get("subject"))]
    materials = statement.get("materials", [])
    artifacts = statement.get("artifacts", [])
    if not isinstance(materials, list) or not isinstance(artifacts, list):
        raise ProvenanceError("materials and artifacts must be arrays")
    raw_records.extend(("material", item) for item in materials)
    raw_records.extend(("artifact", item) for item in artifacts)
    if len(raw_records) > max_files + 1:
        raise ProvenanceError(f"provenance statement exceeds the {max_files + 1}-record limit")

    index: dict[tuple[str, str, str], dict[str, Any]] = {}
    for kind, value in raw_records:
        if not isinstance(value, dict):
            raise ProvenanceError(f"{kind} record must be an object")
        name = _bounded_text(value.get("name", ""), f"{kind}.name", 512)
        path = _bounded_text(value.get("path", ""), f"{kind}.path", 1_024)
        _validate_statement_relative_path(path)
        digest = value.get("sha256")
        size = value.get("size")
        if not _is_sha256(digest):
            raise ProvenanceError(f"{kind} record has an invalid SHA-256 digest")
        if not isinstance(size, int) or isinstance(size, bool) or size < 0:
            raise ProvenanceError(f"{kind} record has an invalid size")
        identity = (kind, name, path)
        if identity in index:
            raise ProvenanceError(f"duplicate provenance record: {identity}")
        index[identity] = {"sha256": digest.lower(), "size": size}
    return index


def _validate_statement_relative_path(value: str) -> None:
    if not value or "\x00" in value or "\\" in value or ":" in value:
        raise ProvenanceError(f"invalid root-relative provenance path: {value!r}")
    if any(part in {"", ".", ".."} for part in value.split("/")):
        raise ProvenanceError(f"invalid root-relative provenance path: {value!r}")
    parsed = PurePosixPath(value)
    if parsed.is_absolute():
        raise ProvenanceError(f"invalid root-relative provenance path: {value!r}")


def _digest_summary(record: dict[str, Any] | None) -> dict[str, Any] | None:
    if record is None:
        return None
    return {"sha256": record["sha256"], "size": record["size"]}


def _validate_limits(max_files: int, max_file_bytes: int, max_total_bytes: int) -> None:
    for label, value in (
        ("max_files", max_files),
        ("max_file_bytes", max_file_bytes),
        ("max_total_bytes", max_total_bytes),
    ):
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise ProvenanceError(f"{label} must be a positive integer")


def _validate_claim_graph(
    manifest: Path,
    destination: Path,
    material_files: list[tuple[str, Path]],
    artifact_files: list[tuple[str, Path]],
    *,
    manifest_identity: tuple[int, int],
) -> None:
    manifest_key = _path_key(manifest)
    destination_key = _path_key(destination)
    if manifest_key == destination_key:
        raise ProvenanceError("provenance output must not replace its manifest")

    seen = {manifest_key: "manifest"}
    seen_objects = {manifest_identity: "manifest"}
    for kind, records in (("material", material_files), ("artifact", artifact_files)):
        for name, path in records:
            key = _path_key(path)
            identity = _object_identity(_lstat(path, kind))
            if key == manifest_key or identity == manifest_identity:
                raise ProvenanceError(f"manifest must not reference itself as {kind}:{name}")
            if key == destination_key:
                raise ProvenanceError(f"manifest must not claim provenance output as {kind}:{name}")
            if key in seen or identity in seen_objects:
                previous = seen.get(key, seen_objects.get(identity, "another claim"))
                raise ProvenanceError(
                    f"duplicate physical file claim for {kind}:{name}; already claimed as {previous}"
                )
            seen[key] = f"{kind}:{name}"
            seen_objects[identity] = f"{kind}:{name}"


def _path_key(path: Path) -> str:
    return os.path.normcase(os.path.normpath(str(path)))


def _validate_claim_path_text(value: str, label: str) -> None:
    if len(value) > 1_024:
        raise ProvenanceError(f"{label} path exceeds 1024 characters")
    if "\x00" in value:
        raise ProvenanceError(f"{label} path contains a null byte")
    _validate_windows_path_text(value, label)


def _validate_path_argument(value: str | Path, label: str) -> None:
    text = str(value)
    if not text or len(text) > 4_096:
        raise ProvenanceError(f"{label} must be a path of at most 4096 characters")
    if "\x00" in text:
        raise ProvenanceError(f"{label} contains a null byte")
    _validate_windows_path_text(text, label)


def _validate_windows_path_text(value: str, label: str) -> None:
    parsed = PureWindowsPath(value)
    if parsed.drive and not parsed.is_absolute():
        raise ProvenanceError(f"{label} must not use a drive-relative path")
    remainder = value[len(parsed.drive) :] if parsed.drive else value
    if ":" in remainder:
        raise ProvenanceError(f"{label} must not use an alternate data stream")
    for component in parsed.parts:
        normalized = component.rstrip("\\/ .")
        if not normalized or normalized in {parsed.drive, parsed.anchor}:
            continue
        device_name = normalized.split(".", 1)[0].upper()
        if device_name in _WINDOWS_RESERVED_NAMES:
            raise ProvenanceError(f"{label} contains a reserved Windows device name")


def _is_sha256(value: Any) -> bool:
    if not isinstance(value, str) or len(value) != 64:
        return False
    try:
        int(value, 16)
    except ValueError:
        return False
    return True


def _reject_remote_path(path: Path, label: str) -> None:
    text = str(path)
    if text.startswith("\\\\"):
        raise ProvenanceError(f"{label} must not use a UNC or device path")


def _canonical_directory(path: str | Path, label: str) -> Path:
    _validate_path_argument(path, label)
    raw = Path(path)
    _reject_remote_path(raw, label)
    _reject_reparse_components(raw)
    try:
        resolved = raw.resolve(strict=True)
    except OSError as exc:
        raise ProvenanceError(f"{label} is unavailable") from exc
    _reject_reparse_components(resolved)
    metadata = _lstat(resolved, label)
    if not stat.S_ISDIR(metadata.st_mode):
        raise ProvenanceError(f"{label} is not a directory: {resolved}")
    return resolved


def _canonical_file(path: Path, root: Path, label: str, *, max_file_bytes: int) -> Path:
    _validate_path_argument(path, label)
    _reject_remote_path(path, label)
    _require_inside(root, path.absolute(), label)
    _reject_reparse_components(path)
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise ProvenanceError(f"{label} is unavailable") from exc
    _require_inside(root, resolved, label)
    _reject_reparse_components(resolved)
    _regular_metadata(resolved, label, max_file_bytes=max_file_bytes)
    return resolved


def _canonical_output(path: Path, root: Path, label: str) -> Path:
    _validate_path_argument(path, label)
    _reject_remote_path(path, label)
    _require_inside(root, path.absolute(), label)
    _reject_reparse_components(path.parent)
    try:
        parent = path.parent.resolve(strict=True)
    except OSError as exc:
        raise ProvenanceError(f"{label} parent is unavailable") from exc
    _require_inside(root, parent, label)
    _reject_reparse_components(parent)
    if not path.name or path.name in {".", ".."}:
        raise ProvenanceError(f"{label} must name a file")
    destination = parent / path.name
    _require_inside(root, destination, label)
    try:
        _regular_metadata(destination, label, max_file_bytes=DEFAULT_MAX_MANIFEST_BYTES)
    except FileNotFoundError:
        pass
    return destination


def _reject_reparse_components(path: Path) -> None:
    absolute = path.absolute()
    current = Path(absolute.anchor)
    if current != Path() and _is_reparse_point(current):
        raise ProvenanceError(f"reparse points are not allowed: {current}")
    for component in absolute.parts[1:]:
        current /= component
        if _is_reparse_point(current):
            raise ProvenanceError(f"reparse points are not allowed: {current}")


def _is_reparse_point(path: Path) -> bool:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return False
    except OSError:
        return True
    if stat.S_ISLNK(metadata.st_mode):
        return True
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    attributes = getattr(metadata, "st_file_attributes", 0)
    if reparse_flag and attributes & reparse_flag:
        return True
    try:
        is_junction = getattr(path, "is_junction", None)
        return bool(is_junction and is_junction())
    except OSError:
        return True


def _lstat(path: Path, label: str) -> os.stat_result:
    try:
        return path.lstat()
    except FileNotFoundError:
        raise
    except OSError as exc:
        raise ProvenanceError(f"{label} metadata is unavailable") from exc


def _regular_metadata(path: Path, label: str, *, max_file_bytes: int) -> os.stat_result:
    metadata = _lstat(path, label)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    attributes = getattr(metadata, "st_file_attributes", 0)
    if stat.S_ISLNK(metadata.st_mode) or (reparse_flag and attributes & reparse_flag):
        raise ProvenanceError(f"{label} must not be a symlink, junction, or reparse point")
    if not stat.S_ISREG(metadata.st_mode):
        raise ProvenanceError(f"{label} is not a regular file: {path}")
    if metadata.st_nlink != 1:
        raise ProvenanceError(f"{label} must not be a hard-linked file: {path}")
    if metadata.st_size > max_file_bytes:
        raise ProvenanceError(f"{label} exceeds {max_file_bytes} bytes: {path}")
    return metadata


def _object_identity(metadata: os.stat_result) -> tuple[int, int]:
    return metadata.st_dev, metadata.st_ino


def _stable_signature(metadata: os.stat_result) -> tuple[int, int, int, int, int]:
    # CPython 3.12 changed Windows ``stat(path).st_ctime`` to creation time,
    # while ``fstat(fd).st_ctime`` can still expose a different change-time
    # value.  ``st_birthtime_ns`` is consistent across both APIs when present;
    # mtime continues to detect ordinary content changes.
    birth_or_change_ns = getattr(
        metadata,
        "st_birthtime_ns",
        getattr(metadata, "st_ctime_ns", int(metadata.st_ctime * 1_000_000_000)),
    )
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_size,
        getattr(metadata, "st_mtime_ns", int(metadata.st_mtime * 1_000_000_000)),
        birth_or_change_ns,
    )


@contextmanager
def _checked_binary_reader(
    path: Path,
    label: str,
    *,
    max_file_bytes: int,
):
    _reject_reparse_components(path)
    before = _regular_metadata(path, label, max_file_bytes=max_file_bytes)
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise ProvenanceError(f"{label} could not be opened safely") from exc

    handle = None
    opened: os.stat_result | None = None
    after_descriptor: os.stat_result | None = None
    try:
        opened = os.fstat(descriptor)
        _validate_open_file_metadata(opened, label, max_file_bytes=max_file_bytes)
        if _stable_signature(before) != _stable_signature(opened):
            raise ProvenanceError(f"{label} changed between validation and open")
        handle = os.fdopen(descriptor, "rb", closefd=True)
        descriptor = -1
        yield handle, opened.st_size, _object_identity(opened), _stable_signature(opened)
        after_descriptor = os.fstat(handle.fileno())
        _validate_open_file_metadata(after_descriptor, label, max_file_bytes=max_file_bytes)
        if _stable_signature(opened) != _stable_signature(after_descriptor):
            raise ProvenanceError(f"{label} changed while it was open")
    finally:
        if handle is not None:
            handle.close()
        elif descriptor >= 0:
            os.close(descriptor)

    if after_descriptor is None:
        return
    _reject_reparse_components(path)
    after_path = _regular_metadata(path, label, max_file_bytes=max_file_bytes)
    if _stable_signature(after_descriptor) != _stable_signature(after_path):
        raise ProvenanceError(f"{label} path changed during read")


def _validate_open_file_metadata(
    metadata: os.stat_result,
    label: str,
    *,
    max_file_bytes: int,
) -> None:
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    attributes = getattr(metadata, "st_file_attributes", 0)
    if not stat.S_ISREG(metadata.st_mode) or (reparse_flag and attributes & reparse_flag):
        raise ProvenanceError(f"{label} descriptor is not a regular non-reparse file")
    if metadata.st_nlink != 1:
        raise ProvenanceError(f"{label} descriptor is hard linked")
    if metadata.st_size > max_file_bytes:
        raise ProvenanceError(f"{label} descriptor exceeds {max_file_bytes} bytes")


def _require_inside(root: Path, candidate: Path, label: str) -> None:
    try:
        common = os.path.commonpath([os.path.normcase(str(root)), os.path.normcase(str(candidate))])
    except ValueError as exc:
        raise ProvenanceError(f"{label} crosses a filesystem boundary") from exc
    if common != os.path.normcase(str(root)):
        raise ProvenanceError(f"{label} escapes configured root: {candidate}")


def _rooted_path(path: str | Path | None, root: Path) -> Path:
    if path is None:
        raise ProvenanceError("path is required")
    _validate_path_argument(path, "path")
    candidate = Path(path)
    return candidate if candidate.is_absolute() else root / candidate


def _load_json_object(path: Path, max_bytes: int) -> dict[str, Any]:
    payload, _ = _load_json_object_snapshot(path, max_bytes)
    return payload


def _load_json_object_snapshot(
    path: Path,
    max_bytes: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    with _checked_binary_reader(path, "JSON input", max_file_bytes=max_bytes) as (
        handle,
        size,
        identity,
        signature,
    ):
        raw = handle.read(size)
        if len(raw) != size or handle.read(1):
            raise ProvenanceError("JSON input changed while it was read")
    try:
        text = raw.decode("utf-8")
        _check_json_depth(text, max_depth=DEFAULT_MAX_JSON_DEPTH)
        payload = json.loads(
            text,
            object_pairs_hook=_unique_json_object,
            parse_int=_bounded_json_integer,
            parse_float=_bounded_json_float,
            parse_constant=_reject_json_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
        raise ProvenanceError(f"invalid UTF-8 JSON: {path}") from exc
    if not isinstance(payload, dict):
        raise ProvenanceError(f"JSON root must be an object: {path}")
    _check_json_node_budget(payload, max_nodes=DEFAULT_MAX_JSON_NODES)
    return payload, {
        "identity": identity,
        "signature": signature,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "size": size,
    }


def _check_json_depth(text: str, *, max_depth: int) -> None:
    depth = 0
    in_string = False
    escaped = False
    for character in text:
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
        elif character in "[{":
            depth += 1
            if depth > max_depth:
                raise ProvenanceError(f"JSON nesting exceeds {max_depth} levels")
        elif character in "]}":
            depth -= 1


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ProvenanceError(f"duplicate JSON object key: {key!r}")
        result[key] = value
    return result


def _bounded_json_integer(value: str) -> int:
    if len(value) > 20:
        raise ProvenanceError("JSON integer exceeds the signed 64-bit limit")
    parsed = int(value, 10)
    if abs(parsed) > DEFAULT_MAX_JSON_INTEGER:
        raise ProvenanceError("JSON integer exceeds the signed 64-bit limit")
    return parsed


def _bounded_json_float(value: str) -> float:
    if len(value) > 128:
        raise ProvenanceError("JSON floating-point literal is too long")
    try:
        decimal_value = Decimal(value)
    except InvalidOperation as exc:
        raise ProvenanceError("invalid JSON floating-point literal") from exc
    if not decimal_value.is_finite() or abs(decimal_value) > Decimal("1e308"):
        raise ProvenanceError("JSON floating-point literal is out of range")
    parsed = float(decimal_value)
    if not math.isfinite(parsed):
        raise ProvenanceError("JSON floating-point literal is out of range")
    return parsed


def _reject_json_constant(value: str) -> None:
    raise ProvenanceError(f"non-standard JSON numeric constant is not allowed: {value}")


def _check_json_node_budget(value: Any, *, max_nodes: int) -> None:
    stack = [value]
    count = 0
    while stack:
        current = stack.pop()
        count += 1
        if count > max_nodes:
            raise ProvenanceError(f"JSON value exceeds the {max_nodes}-node limit")
        if isinstance(current, dict):
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)


def _bounded_text(value: Any, label: str, limit: int) -> str:
    if not isinstance(value, str):
        raise ProvenanceError(f"{label} must be a string")
    if len(value) > limit:
        raise ProvenanceError(f"{label} exceeds {limit} characters")
    return value


def _package_version() -> str:
    try:
        return version("proto-agent")
    except PackageNotFoundError:
        return "0+uninstalled"


def _directory_identity(path: Path, root: Path, label: str) -> tuple[Path, tuple[int, int]]:
    _require_inside(root, path.absolute(), label)
    _reject_reparse_components(path)
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise ProvenanceError(f"{label} is unavailable") from exc
    _require_inside(root, resolved, label)
    _reject_reparse_components(resolved)
    metadata = _lstat(resolved, label)
    if not stat.S_ISDIR(metadata.st_mode) or _is_reparse_point(resolved):
        raise ProvenanceError(f"{label} must be a non-reparse directory")
    return resolved, _object_identity(metadata)


def _optional_regular_signature(
    path: Path,
    label: str,
    *,
    max_file_bytes: int,
) -> tuple[int, int, int, int, int] | None:
    try:
        metadata = _regular_metadata(path, label, max_file_bytes=max_file_bytes)
    except FileNotFoundError:
        return None
    return _stable_signature(metadata)


def _atomic_write_json(
    path: Path,
    payload: dict[str, Any],
    *,
    root: Path,
    max_bytes: int,
) -> None:
    try:
        encoded = (
            json.dumps(payload, indent=2, sort_keys=True, allow_nan=False) + "\n"
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ProvenanceError("provenance statement is not strict JSON") from exc
    if len(encoded) > max_bytes:
        raise ProvenanceError(f"provenance output exceeds {max_bytes} bytes")

    destination = _canonical_output(path, root, "provenance output")
    destination_before = _optional_regular_signature(
        destination,
        "provenance output",
        max_file_bytes=max_bytes,
    )
    parent, parent_identity = _directory_identity(
        destination.parent,
        root,
        "provenance output parent",
    )
    handle = tempfile.NamedTemporaryFile(
        mode="w+b",
        prefix=f".{destination.name}.",
        suffix=".tmp",
        dir=parent,
        delete=False,
    )
    temporary: Path | None = Path(handle.name)
    temporary_identity: tuple[int, int] | None = None
    try:
        with handle:
            opened = os.fstat(handle.fileno())
            _validate_open_file_metadata(
                opened,
                "provenance temporary file",
                max_file_bytes=max_bytes,
            )
            temporary_identity = _object_identity(opened)
            _, current_parent_identity = _directory_identity(
                destination.parent,
                root,
                "provenance output parent",
            )
            if current_parent_identity != parent_identity:
                raise ProvenanceError("provenance output parent changed before write")
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
            written = os.fstat(handle.fileno())
            _validate_open_file_metadata(
                written,
                "provenance temporary file",
                max_file_bytes=max_bytes,
            )
            if _object_identity(written) != temporary_identity or written.st_size != len(encoded):
                raise ProvenanceError("provenance temporary file changed during write")

        temporary_metadata = _regular_metadata(
            temporary,
            "provenance temporary file",
            max_file_bytes=max_bytes,
        )
        if _object_identity(temporary_metadata) != temporary_identity:
            raise ProvenanceError("provenance temporary path changed before replace")
        _, current_parent_identity = _directory_identity(
            destination.parent,
            root,
            "provenance output parent",
        )
        if current_parent_identity != parent_identity:
            raise ProvenanceError("provenance output parent changed before replace")
        revalidated_destination = _canonical_output(
            destination,
            root,
            "provenance output",
        )
        if _path_key(revalidated_destination) != _path_key(destination):
            raise ProvenanceError("provenance output path changed before replace")
        destination_now = _optional_regular_signature(
            destination,
            "provenance output",
            max_file_bytes=max_bytes,
        )
        if destination_now != destination_before:
            raise ProvenanceError("provenance output target changed before replace")
        try:
            os.replace(temporary, destination)
        except OSError as exc:
            raise ProvenanceError("atomic provenance replacement failed") from exc
        temporary = None

        _, final_parent_identity = _directory_identity(
            destination.parent,
            root,
            "provenance output parent",
        )
        if final_parent_identity != parent_identity:
            raise ProvenanceError("provenance output parent changed during replace")
        final_metadata = _regular_metadata(
            destination,
            "provenance output",
            max_file_bytes=max_bytes,
        )
        if _object_identity(final_metadata) != temporary_identity:
            raise ProvenanceError("provenance output identity changed during replace")
        _fsync_directory(parent)
    finally:
        if temporary_identity is not None and temporary is not None:
            _unlink_if_identity(temporary, temporary_identity)


def _unlink_if_identity(path: Path, identity: tuple[int, int]) -> None:
    try:
        metadata = path.lstat()
    except OSError:
        return
    if _object_identity(metadata) != identity or not stat.S_ISREG(metadata.st_mode):
        return
    try:
        path.unlink()
    except OSError:
        return


def _fsync_directory(path: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)
