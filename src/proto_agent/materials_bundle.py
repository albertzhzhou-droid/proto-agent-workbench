from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import shutil
import sqlite3
import stat
from pathlib import Path, PurePosixPath
from typing import Any
from uuid import uuid4

from .materials import MATERIALS_SCHEMA_VERSION, MaterialsError, MaterialsStore, provider_license_policy_errors


BUNDLE_SCHEMA_VERSION = "proto-agent.materials-bundle.v1"
PUBLIC_BUNDLE_ID = "public-reviewed-2026.09"
QUARANTINE_BUNDLE_ID = "public-quarantine-metadata-2026.09"
LOCAL_TEXT_PATTERN = re.compile(r"(?i)(?:(?<![a-z])[a-z]:[\\/]|file:/+|\\\\|(?<![a-z0-9.])/(?:home|users)/|localhost(?:[:/]|$))")
EMAIL_PATTERN = re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b")
FORBIDDEN_METADATA_KEYS = {
    "admin",
    "cwd",
    "environment",
    "home",
    "host",
    "hostname",
    "log",
    "operator",
    "path",
    "pid",
    "process_id",
    "reviewer",
    "root",
    "submitter",
    "username",
    "workspace",
}


def _is_reparse_point(path: Path) -> bool:
    try:
        attributes = int(getattr(path.lstat(), "st_file_attributes", 0))
    except OSError as exc:
        raise MaterialsError("BUNDLE_INVALID", f"Bundle path metadata is unreadable: {path.name}") from exc
    return bool(attributes & int(getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)))


def default_bundle_path(profile: str) -> Path:
    repository = Path(__file__).resolve().parents[2]
    if profile == "PUBLIC_CATALOG":
        return repository / "materials" / "bundles" / "public" / PUBLIC_BUNDLE_ID
    if profile == "PUBLIC_QUARANTINE":
        return repository / "materials" / "bundles" / "quarantine" / QUARANTINE_BUNDLE_ID
    raise MaterialsError("INVALID_BUNDLE_PROFILE", f"Unsupported materials bundle profile: {profile}")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise MaterialsError("BUNDLE_INVALID", f"Invalid JSON file in materials bundle: {path.name}") from exc
    if not isinstance(value, dict):
        raise MaterialsError("BUNDLE_INVALID", f"Materials bundle JSON must be an object: {path.name}")
    return value


def _safe_relative(value: str) -> PurePosixPath:
    path = PurePosixPath(value)
    if not value or path.is_absolute() or ".." in path.parts or "\\" in value:
        raise MaterialsError("BUNDLE_INVALID", f"Unsafe bundle-relative path: {value!r}")
    return path


def _bundle_files(directory: Path, *, exclude: set[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for path in sorted(directory.rglob("*")):
        if path.is_symlink() or _is_reparse_point(path):
            raise MaterialsError("BUNDLE_INVALID", f"Links and reparse points are not allowed in materials bundles: {path.name}")
        if not path.is_file():
            continue
        try:
            if path.stat().st_nlink != 1:
                raise MaterialsError("BUNDLE_INVALID", f"Hard-linked files are not allowed in materials bundles: {path.name}")
        except OSError as exc:
            raise MaterialsError("BUNDLE_INVALID", f"Bundle file metadata is unreadable: {path.name}") from exc
        relative = path.relative_to(directory).as_posix()
        if relative not in exclude:
            result[relative] = _sha256_file(path)
    return result


def _verify_checksums(directory: Path, bundle: dict[str, Any]) -> None:
    declared = bundle.get("files")
    if not isinstance(declared, dict) or not declared:
        raise MaterialsError("BUNDLE_INVALID", "Materials bundle has no file digest map.")
    actual_core = _bundle_files(directory, exclude={"bundle.json", "SHA256SUMS"})
    normalized_declared: dict[str, str] = {}
    for name, digest in declared.items():
        relative = _safe_relative(str(name)).as_posix()
        digest_text = str(digest).lower()
        if not re.fullmatch(r"[a-f0-9]{64}", digest_text):
            raise MaterialsError("BUNDLE_INVALID", f"Invalid SHA-256 for {relative}")
        normalized_declared[relative] = digest_text
    if normalized_declared != actual_core:
        raise MaterialsError("BUNDLE_INTEGRITY_FAILED", "Materials bundle core file map does not match its contents.")

    sums_path = directory / "SHA256SUMS"
    if not sums_path.is_file():
        raise MaterialsError("BUNDLE_INVALID", "Materials bundle is missing SHA256SUMS.")
    declared_sums: dict[str, str] = {}
    for line in sums_path.read_text(encoding="ascii").splitlines():
        match = re.fullmatch(r"([a-f0-9]{64})  (.+)", line)
        if not match:
            raise MaterialsError("BUNDLE_INVALID", "Malformed SHA256SUMS entry.")
        relative = _safe_relative(match.group(2)).as_posix()
        declared_sums[relative] = match.group(1)
    actual_sums = _bundle_files(directory, exclude={"SHA256SUMS"})
    if declared_sums != actual_sums:
        raise MaterialsError("BUNDLE_INTEGRITY_FAILED", "SHA256SUMS does not match the materials bundle tree.")


def _verify_activation_contract(directory: Path, bundle: dict[str, Any], *, profile: str) -> None:
    """Bind the bundle profile to the activation policy consumed at runtime."""

    manifest = _read_json(directory / "manifest.json")
    bundle_id = str(bundle.get("bundle_id") or "")
    if not bundle_id:
        raise MaterialsError("BUNDLE_INVALID", "Materials bundle has no bundle ID.")
    if profile == "PUBLIC_CATALOG":
        public_export = manifest.get("public_export") if isinstance(manifest.get("public_export"), dict) else {}
        if bundle.get("activation_policy") != "EXPLICIT_HUMAN_ONLY" or bundle.get("default_model_visibility") is not True:
            raise MaterialsError(
                "BUNDLE_POLICY_FAILED",
                "Public catalog bundles must require explicit human activation and DESIGN_ELIGIBLE-only model visibility.",
            )
        if (
            manifest.get("schema_version") != MATERIALS_SCHEMA_VERSION
            or manifest.get("snapshot_id") != bundle_id
            or public_export.get("profile") != "PUBLIC_CATALOG"
            or public_export.get("activation_policy") != "EXPLICIT_HUMAN_ONLY"
            or public_export.get("default_model_visibility") != "DESIGN_ELIGIBLE_ONLY"
        ):
            raise MaterialsError(
                "BUNDLE_POLICY_FAILED",
                "Public catalog manifest and bundle activation policies are inconsistent.",
            )
        return
    if (
        manifest.get("profile") != "PUBLIC_QUARANTINE"
        or manifest.get("bundle_id") != bundle_id
        or manifest.get("activation_policy") != "DENY"
        or manifest.get("default_model_visibility") is not False
    ):
        raise MaterialsError(
            "BUNDLE_POLICY_FAILED",
            "Public quarantine manifest and bundle activation policies are inconsistent.",
        )


def _scan_text(value: str, *, context: str) -> None:
    if LOCAL_TEXT_PATTERN.search(value):
        raise MaterialsError("BUNDLE_PRIVACY_FAILED", f"Machine-local path or endpoint found in {context}.")
    if EMAIL_PATTERN.search(value):
        raise MaterialsError("BUNDLE_PRIVACY_FAILED", f"Email address found in {context}.")


def _walk_metadata_keys(value: Any) -> set[str]:
    keys: set[str] = set()
    if isinstance(value, dict):
        for key, item in value.items():
            keys.add(str(key).casefold())
            keys.update(_walk_metadata_keys(item))
    elif isinstance(value, list):
        for item in value:
            keys.update(_walk_metadata_keys(item))
    return keys


def _verify_database(path: Path, *, profile: str, expected_count: int) -> dict[str, Any]:
    if not path.is_file() or path.is_symlink():
        raise MaterialsError("BUNDLE_INVALID", f"Materials bundle database is missing or unsafe: {path.name}")
    conn = sqlite3.connect(f"file:{path.resolve().as_posix()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        if str(conn.execute("PRAGMA integrity_check").fetchone()[0]) != "ok":
            raise MaterialsError("BUNDLE_INTEGRITY_FAILED", f"SQLite integrity_check failed: {path.name}")
        if str(conn.execute("PRAGMA quick_check").fetchone()[0]) != "ok":
            raise MaterialsError("BUNDLE_INTEGRITY_FAILED", f"SQLite quick_check failed: {path.name}")
        if int(conn.execute("PRAGMA freelist_count").fetchone()[0]) != 0:
            raise MaterialsError("BUNDLE_PRIVACY_FAILED", f"SQLite free pages are not allowed: {path.name}")
        rows = list(conn.execute("SELECT * FROM resources ORDER BY lower(resource_id), resource_id"))
        if len(rows) != expected_count:
            raise MaterialsError("BUNDLE_INTEGRITY_FAILED", f"Record count mismatch in {path.name}")
        ids = [str(row["resource_id"]) for row in rows]
        if len({item.casefold() for item in ids}) != len(ids):
            raise MaterialsError("BUNDLE_INVALID", "Duplicate or case-colliding resource ID in bundle database.")

        for row in rows:
            record_id = str(row["resource_id"])
            license_info = json.loads(str(row["license_json"]))
            if license_info.get("redistribution_status") != "REDISTRIBUTABLE":
                raise MaterialsError("BUNDLE_RIGHTS_FAILED", f"Non-redistributable row in public bundle: {record_id}")
            source = json.loads(str(row["source_json"]))
            if not str(source.get("url") or "").startswith("https://"):
                raise MaterialsError("BUNDLE_PRIVACY_FAILED", f"Non-public source URL in bundle: {record_id}")
            metadata = json.loads(str(row["metadata_json"]))
            forbidden = _walk_metadata_keys(metadata).intersection(FORBIDDEN_METADATA_KEYS)
            if forbidden:
                raise MaterialsError("BUNDLE_PRIVACY_FAILED", f"Forbidden metadata key for {record_id}: {sorted(forbidden)[0]}")
            for key in row.keys():
                value = row[key]
                if isinstance(value, str):
                    _scan_text(value, context=f"{path.name}:{record_id}:{key}")

            if profile == "PUBLIC_CATALOG":
                if row["review_status"] != "DESIGN_ELIGIBLE" or row["safety_status"] != "NO_FLAG" or int(row["design_eligibility"]) != 1:
                    raise MaterialsError("BUNDLE_POLICY_FAILED", f"Non-eligible row in public catalog: {record_id}")
                rights_errors = provider_license_policy_errors(source, license_info)
                if rights_errors:
                    raise MaterialsError("BUNDLE_RIGHTS_FAILED", f"Public bundle rights policy failed for {record_id}: {rights_errors[0]}")
                digest = str(row["sequence_sha256"])
                if str(source.get("sequence_sha256") or "") != digest:
                    raise MaterialsError("BUNDLE_INTEGRITY_FAILED", f"Source sequence digest mismatch: {record_id}")
                relative = str(row["sequence_path"])
                if not re.fullmatch(r"[a-f0-9]{64}", digest):
                    raise MaterialsError("BUNDLE_INTEGRITY_FAILED", f"Missing public sequence digest: {record_id}")
                expected_relative = f"blobs/{digest[:2]}/{digest}.txt.gz"
                if relative != expected_relative:
                    raise MaterialsError("BUNDLE_INTEGRITY_FAILED", f"Public sequence path mismatch: {record_id}")
                blob = path.parent / relative
                try:
                    sequence = gzip.open(blob, "rt", encoding="ascii").read()
                except (OSError, UnicodeError) as exc:
                    raise MaterialsError("BUNDLE_INTEGRITY_FAILED", f"Public sequence object is unreadable: {record_id}") from exc
                if hashlib.sha256(sequence.encode("ascii")).hexdigest() != digest or len(sequence) != int(row["sequence_length"]):
                    raise MaterialsError("BUNDLE_INTEGRITY_FAILED", f"Public sequence object hash mismatch: {record_id}")
            else:
                if row["review_status"] != "QUARANTINED" or row["safety_status"] != "HARD_FLAG" or int(row["design_eligibility"]) != 0:
                    raise MaterialsError("BUNDLE_POLICY_FAILED", f"Non-quarantined row in quarantine bundle: {record_id}")
                if row["sequence_sha256"] or row["sequence_path"] or int(row["sequence_length"]) != 0:
                    raise MaterialsError("BUNDLE_POLICY_FAILED", f"Sequence content leaked into quarantine metadata bundle: {record_id}")
                redaction = metadata.get("public_quarantine_export") if isinstance(metadata, dict) else None
                if not isinstance(redaction, dict) or not redaction.get("isolation_reason_codes"):
                    raise MaterialsError("BUNDLE_POLICY_FAILED", f"Quarantine reason is missing: {record_id}")
        return {"ids": ids, "rows": rows}
    except (json.JSONDecodeError, sqlite3.DatabaseError) as exc:
        raise MaterialsError("BUNDLE_INVALID", f"Invalid SQLite content in {path.name}") from exc
    finally:
        conn.close()


def _verify_records_jsonl(path: Path, *, database_ids: list[str], profile: str) -> None:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise MaterialsError("BUNDLE_INVALID", "Bundle records.jsonl is unreadable.") from exc
    records: list[dict[str, Any]] = []
    try:
        for line in lines:
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError
            records.append(value)
    except (json.JSONDecodeError, ValueError) as exc:
        raise MaterialsError("BUNDLE_INVALID", "Bundle records.jsonl contains an invalid record.") from exc
    ids = [str(record.get("resource_id") or "") for record in records]
    if ids != database_ids:
        raise MaterialsError("BUNDLE_INTEGRITY_FAILED", "records.jsonl does not match the bundle database IDs.")
    for record in records:
        if "sequence" in record:
            raise MaterialsError("BUNDLE_POLICY_FAILED", "records.jsonl must not inline sequence content.")
        if profile == "PUBLIC_QUARANTINE" and (record.get("sequence_sha256") or record.get("sequence_path") or int(record.get("sequence_length") or 0)):
            raise MaterialsError("BUNDLE_POLICY_FAILED", "Quarantine records.jsonl contains sequence content.")
        _scan_text(json.dumps(record, ensure_ascii=False, sort_keys=True), context="records.jsonl")


def verify_materials_bundle(path: str | Path, *, expected_profile: str | None = None) -> dict[str, Any]:
    directory = Path(path).resolve()
    if not directory.is_dir() or directory.is_symlink() or _is_reparse_point(directory):
        raise MaterialsError("BUNDLE_NOT_FOUND", f"Materials bundle directory is unavailable: {directory}")
    bundle = _read_json(directory / "bundle.json")
    if bundle.get("schema_version") != BUNDLE_SCHEMA_VERSION:
        raise MaterialsError("BUNDLE_INVALID", "Unsupported materials bundle schema.")
    profile = str(bundle.get("profile") or "")
    if expected_profile and profile != expected_profile:
        raise MaterialsError("BUNDLE_PROFILE_MISMATCH", f"Expected {expected_profile}, found {profile or 'unknown'}.")
    if profile not in {"PUBLIC_CATALOG", "PUBLIC_QUARANTINE"}:
        raise MaterialsError("BUNDLE_INVALID", f"Unsupported materials bundle profile: {profile}")
    if profile == "PUBLIC_QUARANTINE" and (bundle.get("activation_policy") != "DENY" or bundle.get("default_model_visibility") is not False):
        raise MaterialsError("BUNDLE_POLICY_FAILED", "Quarantine bundle must deny activation and default model visibility.")
    _verify_checksums(directory, bundle)
    _verify_activation_contract(directory, bundle, profile=profile)
    all_files = set(_bundle_files(directory, exclude={}))
    forbidden_names = {"active.json", "-wal", "-shm", "-journal"}
    for name in all_files:
        parts = PurePosixPath(name).parts
        if "staging" in parts or "overlays" in parts or name == "active.json" or any(name.endswith(suffix) for suffix in forbidden_names - {"active.json"}):
            raise MaterialsError("BUNDLE_POLICY_FAILED", f"Runtime-state file is not allowed in a public bundle: {name}")
    if profile == "PUBLIC_QUARANTINE":
        expected_files = {
            "LICENSES.md",
            "SHA256SUMS",
            "bundle.json",
            "licenses/catalog.json",
            "manifest.json",
            "provenance.json",
            "quarantine.sqlite",
            "records.jsonl",
        }
        if all_files != expected_files:
            raise MaterialsError("BUNDLE_POLICY_FAILED", "Quarantine bundle contains an unexpected file or sequence object.")
    for name in sorted(all_files):
        if name.endswith((".json", ".jsonl", ".md")) or name == "SHA256SUMS":
            try:
                text = (directory / PurePosixPath(name)).read_text(encoding="utf-8")
            except (OSError, UnicodeError) as exc:
                raise MaterialsError("BUNDLE_INVALID", f"Bundle text file is unreadable: {name}") from exc
            _scan_text(text, context=name)
    expected_count = int(bundle.get("record_count", -1))
    database_name = "catalog.sqlite" if profile == "PUBLIC_CATALOG" else "quarantine.sqlite"
    result = _verify_database(directory / database_name, profile=profile, expected_count=expected_count)
    _verify_records_jsonl(directory / "records.jsonl", database_ids=result["ids"], profile=profile)
    for suffix in ("-wal", "-shm", "-journal"):
        if (directory / f"{database_name}{suffix}").exists():
            raise MaterialsError("BUNDLE_PRIVACY_FAILED", f"SQLite sidecar file is not allowed: {database_name}{suffix}")
    return {
        "ok": True,
        "schema_version": BUNDLE_SCHEMA_VERSION,
        "bundle_id": str(bundle.get("bundle_id") or ""),
        "profile": profile,
        "record_count": expected_count,
        "source_counts": bundle.get("source_counts", {}),
        "license_counts": bundle.get("license_counts", {}),
        "status_counts": bundle.get("status_counts", {}),
        "activation_policy": bundle.get("activation_policy"),
        "default_model_visibility": bundle.get("default_model_visibility"),
    }


def install_public_bundle(
    store: MaterialsStore,
    bundle_path: str | Path | None = None,
    *,
    activate: bool = False,
    operator: str | None = None,
    approval_reference: str | None = None,
) -> dict[str, Any]:
    if not activate and (operator is not None or approval_reference is not None):
        raise MaterialsError("ACTIVATION_EVIDENCE_UNUSED", "Activation evidence can only be supplied together with activate=True.")
    source = default_bundle_path("PUBLIC_CATALOG") if bundle_path is None else Path(bundle_path).resolve()
    verification = verify_materials_bundle(source, expected_profile="PUBLIC_CATALOG")
    manifest = _read_json(source / "manifest.json")
    snapshot_id = str(manifest.get("snapshot_id") or "")
    if snapshot_id != verification["bundle_id"]:
        raise MaterialsError("BUNDLE_INVALID", "Public bundle ID and snapshot ID do not match.")
    target = store.snapshots / snapshot_id
    if target.exists():
        if target.is_symlink() or _sha256_file(target / "manifest.json") != _sha256_file(source / "manifest.json"):
            raise MaterialsError("SNAPSHOT_EXISTS", f"A different snapshot already uses the public bundle ID: {snapshot_id}")
        store._verify_snapshot(snapshot_id, manifest)
        installed = False
    else:
        for item in source.rglob("*"):
            if item.is_symlink() or _is_reparse_point(item):
                raise MaterialsError("BUNDLE_INVALID", "Links and reparse points are not allowed in public bundle installation.")
        stage_id = f"install-{snapshot_id}-{uuid4().hex}"
        stage = store.snapshots / stage_id
        try:
            shutil.copytree(source, stage)
            store._verify_snapshot(stage_id, manifest)
            os.replace(stage, target)
        except Exception:
            shutil.rmtree(stage, ignore_errors=True)
            raise
        installed = True
    activation = (
        store.activate(
            snapshot_id,
            operator=operator,
            approval_reference=approval_reference,
        )
        if activate
        else None
    )
    return {
        "ok": True,
        "bundle_id": verification["bundle_id"],
        "snapshot_id": snapshot_id,
        "record_count": verification["record_count"],
        "installed": installed,
        "activated": activation is not None,
        "activation": activation,
    }
