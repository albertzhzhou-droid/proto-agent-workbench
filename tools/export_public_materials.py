#!/usr/bin/env python3
"""Build the reviewed, path-free public materials distribution bundles.

The normal catalog is rebuilt from repository-reviewed JSON.  The quarantine
index is rebuilt from locked, read-only external SQLite inputs, but it retains
only an explicit metadata allowlist.  Quarantined sequences and local runtime
state are never copied.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sqlite3
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlsplit

from proto_agent.materials import (
    MaterialsError,
    MaterialsStore,
    PROMOTION_AUDIT_SCHEMA_VERSION,
    PROMOTION_POLICY_VERSION,
    load_locked_promotion_attestations,
    normalize_record,
)


PUBLIC_BUNDLE_ID = "public-reviewed-2026.09"
QUARANTINE_BUNDLE_ID = "public-quarantine-metadata-2026.09"
EXPORT_SCHEMA = "proto-agent.public-materials-export.v1"
BUNDLE_SCHEMA = "proto-agent.materials-bundle.v1"
TEXT_LEAK_PATTERNS = (
    re.compile(r"(?i)(?:(?<![a-z])[a-z]:[\\/]|file:/+|\\\\|(?<![a-z0-9.])/(?:home|users)/|localhost(?:[:/]|$))"),
    re.compile(r"(?i)\b(?:operator|reviewer|submitter|username|hostname|process_id|pid|workspace_root|materials_root)\b"),
)
EMAIL_PATTERN = re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b")

MAIN_METADATA_ALLOWLIST = {
    "iGEM Registry": {"registry_status", "role_accession", "chassis_basis"},
    "UniProtKB/Swiss-Prot": {"entry_length", "eligibility_basis", "reviewed_record"},
}
QUARANTINE_METADATA_ALLOWLIST = {
    "UniProtKB/Swiss-Prot": {"entry_length"},
    "Rhea": {"chebi", "ec", "equation", "pubmed"},
    "BioModels": {"format"},
}


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object: {path}")
    return value


def _public_https(value: Any, *, field: str, allow_empty: bool = False) -> str:
    text = str(value or "").strip()
    if not text and allow_empty:
        return ""
    parsed = urlsplit(text)
    host = (parsed.hostname or "").casefold()
    if parsed.scheme != "https" or not host or parsed.username or parsed.password:
        raise ValueError(f"{field} must be a credential-free public HTTPS URL")
    if host in {"localhost", "127.0.0.1", "::1"} or host.endswith(".local"):
        raise ValueError(f"{field} points to a local host")
    return text


def _assert_no_local_or_identity_text(value: Any, *, field: str) -> None:
    text = _canonical_json(value)
    for pattern in TEXT_LEAK_PATTERNS:
        if pattern.search(text):
            raise ValueError(f"Machine-local or identity-bearing text rejected in {field}")
    if EMAIL_PATTERN.search(text):
        raise ValueError(f"Email address rejected in {field}")


def _sanitize_source(value: Any, *, provider: str, keep_retrieved_at: bool, require_sequence_digest: bool = False) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("source metadata must be an object")
    if str(value.get("provider") or "") != provider:
        raise ValueError(f"Unexpected source provider for public export: {value.get('provider')!r}")
    result = {
        "provider": provider,
        "record_id": str(value.get("record_id") or "").strip(),
        "revision": str(value.get("revision") or "").strip(),
        "release": str(value.get("release") or "").strip(),
        "url": _public_https(value.get("url"), field="source.url"),
        "content_sha256": str(value.get("content_sha256") or "").strip().lower(),
        "sequence_sha256": str(value.get("sequence_sha256") or "").strip().lower(),
    }
    if keep_retrieved_at and value.get("retrieved_at"):
        result["retrieved_at"] = str(value["retrieved_at"]).strip()
    if not result["record_id"] or not (result["revision"] or result["release"]):
        raise ValueError("Public source record ID and revision/release are required")
    if not re.fullmatch(r"[a-f0-9]{64}", result["content_sha256"]):
        raise ValueError("Public source content SHA-256 is required")
    if require_sequence_digest and not re.fullmatch(r"[a-f0-9]{64}", result["sequence_sha256"]):
        raise ValueError("Public source sequence SHA-256 is required")
    if not result["sequence_sha256"]:
        result.pop("sequence_sha256")
    _assert_no_local_or_identity_text(result, field="source")
    return result


def _sanitize_license(value: Any, *, expected_ids: set[str] | None = None) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("license metadata must be an object")
    license_id = str(value.get("id") or "").strip()
    license_id = {"cc-by-4.0": "CC-BY-4.0", "cc0-1.0": "CC0-1.0"}.get(license_id.casefold(), license_id)
    result = {
        "id": license_id,
        "url": _public_https(value.get("url"), field="license.url"),
        "attribution": str(value.get("attribution") or "").strip(),
        "rights_notes": str(value.get("rights_notes") or "").strip(),
        "redistribution_status": str(value.get("redistribution_status") or "").strip().upper(),
    }
    if result["redistribution_status"] != "REDISTRIBUTABLE":
        raise ValueError("Only REDISTRIBUTABLE records may enter a public bundle")
    if expected_ids is not None and result["id"] not in expected_ids:
        raise ValueError(f"Unexpected public data license: {result['id']}")
    if not result["id"] or not result["attribution"] or not result["rights_notes"]:
        raise ValueError("License ID, attribution, and rights notes are required")
    _assert_no_local_or_identity_text(result, field="license")
    return result


def _sanitize_evidence(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [_public_https(item, field="evidence_refs") for item in value]


def _metadata_allowlist(value: Any, *, provider: str, quarantine: bool) -> dict[str, Any]:
    source = value if isinstance(value, dict) else {}
    allowed = (QUARANTINE_METADATA_ALLOWLIST if quarantine else MAIN_METADATA_ALLOWLIST).get(provider, set())
    result = {key: source[key] for key in sorted(allowed) if key in source}
    _assert_no_local_or_identity_text(result, field="metadata")
    return result


def _sanitize_main_record(raw: dict[str, Any], *, provider: str, attestation: dict[str, Any]) -> dict[str, Any]:
    record = dict(raw)
    record["source"] = _sanitize_source(record.get("source"), provider=provider, keep_retrieved_at=True, require_sequence_digest=True)
    record["license"] = _sanitize_license(record.get("license"))
    record["evidence_refs"] = _sanitize_evidence(record.get("evidence_refs"))
    record["metadata"] = _metadata_allowlist(record.get("metadata"), provider=provider, quarantine=False)
    normalized = normalize_record(record, promotion_attestation=attestation)
    if normalized["review_status"] != "DESIGN_ELIGIBLE" or not normalized["design_eligibility"]:
        raise ValueError(f"Public catalog record is not design eligible: {normalized['resource_id']}")
    if normalized["safety_status"] != "NO_FLAG":
        raise ValueError(f"Public catalog record has a safety flag: {normalized['resource_id']}")
    _assert_no_local_or_identity_text({key: value for key, value in record.items() if key != "sequence"}, field=normalized["resource_id"])
    return record


def _parse_json_column(row: sqlite3.Row, name: str, default: Any) -> Any:
    try:
        value = json.loads(str(row[name]))
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        raise ValueError(f"Invalid {name} for {row['resource_id']}") from exc
    return value if value is not None else default


def _sanitize_quarantine_row(row: sqlite3.Row, *, provider: str, expected_licenses: set[str]) -> dict[str, Any]:
    if row["review_status"] != "QUARANTINED" or row["safety_status"] != "HARD_FLAG" or int(row["design_eligibility"]) != 0:
        raise ValueError(f"Quarantine invariant failed for {row['resource_id']}")
    source = _sanitize_source(_parse_json_column(row, "source_json", {}), provider=provider, keep_retrieved_at=False)
    license_info = _sanitize_license(_parse_json_column(row, "license_json", {}), expected_ids=expected_licenses)
    reason_codes = sorted({str(item) for item in _parse_json_column(row, "safety_flags_json", []) if str(item).strip()})
    if not reason_codes:
        raise ValueError(f"Quarantine reason is required for {row['resource_id']}")
    original_digest = str(row["sequence_sha256"] or "")
    if original_digest and not re.fullmatch(r"[a-f0-9]{64}", original_digest):
        raise ValueError(f"Invalid redacted source digest for {row['resource_id']}")
    metadata = _metadata_allowlist(_parse_json_column(row, "metadata_json", {}), provider=provider, quarantine=True)
    metadata["public_quarantine_export"] = {
        "content_policy": "metadata-only",
        "sequence_omitted": bool(original_digest),
        "redacted_source_sequence_length": int(row["sequence_length"] or 0),
        "redacted_source_sequence_sha256": original_digest,
        "isolation_reason_codes": reason_codes,
    }
    record = {
        "resource_id": str(row["resource_id"]),
        "kind": str(row["kind"]),
        "name": str(row["name"]),
        "aliases": _parse_json_column(row, "aliases_json", []),
        "description_en": str(row["description_en"]),
        "description_zh": str(row["description_zh"]),
        "organism": _parse_json_column(row, "organism_json", {}),
        "chassis": _parse_json_column(row, "chassis_json", []),
        "role_terms": _parse_json_column(row, "role_terms_json", []),
        "part_type": str(row["part_type"]),
        "sequence_kind": str(row["sequence_kind"]),
        "sequence": "",
        "source": source,
        "license": license_info,
        "evidence_refs": _sanitize_evidence(_parse_json_column(row, "evidence_refs_json", [])),
        "review_status": "QUARANTINED",
        "safety_status": "HARD_FLAG",
        "design_eligibility": False,
        "metadata": metadata,
    }
    normalized = normalize_record(record)
    if normalized["review_status"] != "QUARANTINED" or normalized["safety_status"] != "HARD_FLAG" or normalized["design_eligibility"]:
        raise ValueError(f"Sanitized quarantine invariant failed for {normalized['resource_id']}")
    if normalized["sequence_sha256"] or normalized["sequence_length"]:
        raise ValueError(f"Quarantined sequence content was not removed for {normalized['resource_id']}")
    _assert_no_local_or_identity_text(record, field=normalized["resource_id"])
    return record


def _find_locked_quarantine(root: Path, expected_sha256: str) -> Path:
    snapshots = root / "snapshots"
    if not snapshots.is_dir():
        raise FileNotFoundError(f"External snapshot root is unavailable: {snapshots}")
    matches: list[Path] = []
    for candidate in sorted(snapshots.glob("*/quarantine.sqlite")):
        if candidate.is_symlink() or not candidate.is_file():
            continue
        if _sha256_file(candidate) == expected_sha256:
            matches.append(candidate)
    if len(matches) != 1:
        raise ValueError(f"Expected exactly one locked quarantine catalog for {expected_sha256}; found {len(matches)}")
    return matches[0]


def _read_quarantine_records(database: Path, lock: dict[str, Any]) -> list[dict[str, Any]]:
    uri = f"file:{database.as_posix()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    try:
        if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError(f"Source quarantine database failed integrity_check: {database.name}")
        rows = list(conn.execute("SELECT * FROM resources ORDER BY lower(resource_id), resource_id"))
    finally:
        conn.close()
    expected_count = int(lock["record_count"])
    if len(rows) != expected_count:
        raise ValueError(f"Locked quarantine count mismatch for {lock['provider']}: {len(rows)} != {expected_count}")
    licenses = {str(item) for item in lock["license_ids"]}
    return [_sanitize_quarantine_row(row, provider=str(lock["provider"]), expected_licenses=licenses) for row in rows]


def _normalized_summaries(
    records: Iterable[dict[str, Any]],
    *,
    quarantine: bool,
    promotion_attestations: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    summaries: list[dict[str, Any]] = []
    for raw in records:
        attestation = (promotion_attestations or {}).get(str(raw.get("resource_id") or ""))
        record = normalize_record(raw, promotion_attestation=attestation)
        summary = {key: value for key, value in record.items() if key not in {"sequence", "tags"}}
        if record["sequence_sha256"]:
            prefix = "quarantine/blobs" if quarantine else "blobs"
            digest = record["sequence_sha256"]
            summary["sequence_path"] = f"{prefix}/{digest[:2]}/{digest}.txt.gz"
        else:
            summary["sequence_path"] = ""
        summaries.append(summary)
    return sorted(summaries, key=lambda item: (item["resource_id"].casefold(), item["resource_id"]))


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_canonical_json(value) + "\n", encoding="utf-8", newline="\n")


def _write_jsonl(path: Path, values: Iterable[dict[str, Any]]) -> None:
    payload = "".join(_canonical_json(value) + "\n" for value in values)
    path.write_text(payload, encoding="utf-8", newline="\n")


def _data_license_notice(*, quarantine: bool) -> str:
    scope = "metadata-only quarantine index" if quarantine else "reviewed public catalog"
    common = f"""# Third-party data notices

This directory is the Proto Agent {scope}. The repository's MIT license covers
the software, not third-party records. Each row retains its own source URL,
license URL, attribution, rights notes, and redistribution status.

- UniProtKB/Swiss-Prot database content: CC BY 4.0; attribution to the UniProt
  Consortium is retained. UniProt notes that patents or other third-party rights
  can still apply.
"""
    if quarantine:
        source_lines = """- Rhea database content: CC BY 4.0; attribution to Rhea is retained.
- BioModels records in this export: CC0 1.0. Personal contributor fields from
  the source metadata are omitted from the public bundle.
"""
    else:
        source_lines = """- iGEM Registry records: the declared license is evaluated per record. This
  bundle contains fourteen CC BY 4.0 records and one CC0 1.0 record.
"""
    if quarantine:
        boundary = """

This quarantine bundle contains no sequence objects. Public availability and a
redistribution flag are not claims of scientific validity, orderability,
experimental readiness, biosafety, or regulatory approval.
"""
    else:
        boundary = """

Public availability and a redistribution flag are not claims of scientific
validity, orderability, experimental readiness, biosafety, or regulatory
approval.
"""
    return common + source_lines + boundary


def _file_map(directory: Path, *, excluded: set[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for path in sorted(item for item in directory.rglob("*") if item.is_file()):
        relative = path.relative_to(directory).as_posix()
        if relative not in excluded:
            result[relative] = _sha256_file(path)
    return result


def _finalize_bundle(directory: Path, *, profile: str, bundle_id: str, records: list[dict[str, Any]], activation_policy: str, model_visibility: bool) -> None:
    counts = Counter(record["review_status"] for record in records)
    sources = Counter(record["source"]["provider"] for record in records)
    licenses = Counter(record["license"]["id"] for record in records)
    core_files = _file_map(directory, excluded={"bundle.json", "SHA256SUMS"})
    bundle = {
        "schema_version": BUNDLE_SCHEMA,
        "export_schema_version": EXPORT_SCHEMA,
        "bundle_id": bundle_id,
        "profile": profile,
        "activation_policy": activation_policy,
        "default_model_visibility": model_visibility,
        "record_count": len(records),
        "status_counts": dict(sorted(counts.items())),
        "source_counts": dict(sorted(sources.items())),
        "license_counts": dict(sorted(licenses.items())),
        "files": core_files,
    }
    _write_json(directory / "bundle.json", bundle)
    sums = _file_map(directory, excluded={"SHA256SUMS"})
    (directory / "SHA256SUMS").write_text("".join(f"{digest}  {path}\n" for path, digest in sums.items()), encoding="ascii", newline="\n")


def _public_sources() -> list[dict[str, Any]]:
    return [
        {"provider": "iGEM Registry", "record_count": 15, "release": "per-record revisions", "license_policy": "per-record declared CC-BY-4.0 or CC0-1.0"},
        {"provider": "UniProtKB/Swiss-Prot", "record_count": 3, "release": "2026_02", "license": "CC-BY-4.0"},
    ]


def _quarantine_sources(lock: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {
            "provider": str(item["provider"]),
            "record_count": int(item["record_count"]),
            "release": str(item["release"]),
            "source_quarantine_catalog_sha256": str(item["quarantine_catalog_sha256"]),
            "content_policy": "metadata-only; sequences omitted",
        }
        for item in lock["quarantine_inputs"]
    ]


def build(repo: Path, external_root: Path, output_root: Path) -> tuple[Path, Path]:
    lock_path = repo / "materials" / "bundles" / "source-lock.json"
    lock = _load_json(lock_path)
    created_at = str(lock["exported_at"])
    audit_entry = lock.get("promotion_audit")
    if not isinstance(audit_entry, dict):
        raise ValueError("Source lock is missing the promotion audit")
    audit_path = repo / str(audit_entry.get("path") or "")
    if _sha256_file(audit_path) != str(audit_entry.get("sha256") or ""):
        raise ValueError("Promotion audit hash mismatch")
    audit_payload = _load_json(audit_path)
    if audit_payload.get("schema_version") != PROMOTION_AUDIT_SCHEMA_VERSION or audit_payload.get("policy_version") != PROMOTION_POLICY_VERSION:
        raise ValueError("Unsupported promotion audit policy")
    for evidence in lock.get("source_evidence", []):
        if not isinstance(evidence, dict):
            raise ValueError("Invalid source evidence lock entry")
        evidence_path = repo / str(evidence.get("path") or "")
        if _sha256_file(evidence_path) != str(evidence.get("sha256") or ""):
            raise ValueError(f"Source evidence hash mismatch: {evidence.get('path')}")

    public_records: list[dict[str, Any]] = []
    promotion_attestations: dict[str, dict[str, Any]] = {}
    for item in lock["eligible_inputs"]:
        source_path = repo / str(item["path"])
        if _sha256_file(source_path) != str(item["sha256"]):
            raise ValueError(f"Reviewed input hash mismatch: {item['path']}")
        payload = _load_json(source_path)
        provider = str(item["provider"])
        selected = [record for record in payload.get("records", []) if isinstance(record, dict) and record.get("source", {}).get("provider") == provider and record.get("review_status") == "DESIGN_ELIGIBLE" and record.get("design_eligibility") is True]
        if len(selected) != int(item["selected_record_count"]):
            raise ValueError(f"Reviewed input selection count mismatch: {item['path']}")
        locked = load_locked_promotion_attestations(repo, source_path, audit_path, lock_path)
        for record in selected:
            resource_id = str(record.get("resource_id") or "")
            attestation = locked.get(resource_id)
            if not attestation:
                raise ValueError(f"Reviewed record has no locked promotion decision: {resource_id}")
            sanitized = _sanitize_main_record(record, provider=provider, attestation=attestation)
            public_records.append(sanitized)
            promotion_attestations[resource_id] = attestation

    quarantine_records: list[dict[str, Any]] = []
    for item in lock["quarantine_inputs"]:
        database = _find_locked_quarantine(external_root, str(item["quarantine_catalog_sha256"]))
        quarantine_records.extend(_read_quarantine_records(database, item))

    public_records.sort(key=lambda item: (str(item["resource_id"]).casefold(), str(item["resource_id"])))
    quarantine_records.sort(key=lambda item: (str(item["resource_id"]).casefold(), str(item["resource_id"])))
    if len(public_records) != 18 or len(quarantine_records) != 1795:
        raise ValueError("Public export count invariant failed")
    ids = [str(item["resource_id"]).casefold() for item in [*public_records, *quarantine_records]]
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate or case-colliding public resource ID")

    public_target = output_root / "public" / PUBLIC_BUNDLE_ID
    quarantine_target = output_root / "quarantine" / QUARANTINE_BUNDLE_ID
    if public_target.exists() or quarantine_target.exists():
        raise FileExistsError("Public materials output already exists; remove it explicitly before rebuilding")

    with tempfile.TemporaryDirectory(prefix="proto-public-materials-") as temp_name:
        temp = Path(temp_name)
        store = MaterialsStore(workspace=repo, root=temp / "external")
        public_manifest = store._create_snapshot(
            public_records,
            PUBLIC_BUNDLE_ID,
            sources=_public_sources(),
            label="Reviewed public materials catalog",
            created_at=created_at,
            manifest_annotations={
                "public_export": {
                    "schema_version": EXPORT_SCHEMA,
                    "profile": "PUBLIC_CATALOG",
                    "activation_policy": "EXPLICIT_HUMAN_ONLY",
                    "default_model_visibility": "DESIGN_ELIGIBLE_ONLY",
                    "local_runtime_state_included": False,
                },
                "promotion_audit": {
                    "schema_version": PROMOTION_AUDIT_SCHEMA_VERSION,
                    "policy_version": PROMOTION_POLICY_VERSION,
                    "path": str(audit_entry["path"]),
                    "sha256": str(audit_entry["sha256"]),
                    "pass_count": int(audit_payload.get("pass_count", 0)),
                },
            },
            vacuum_catalogs=True,
            promotion_attestations=promotion_attestations,
        )
        public_source = Path(str(public_manifest["snapshot_path"]))
        shutil.copytree(public_source, public_target)
        public_provenance = _load_json(public_target / "provenance.json")
        public_provenance["source_lock_sha256"] = _sha256_file(lock_path)
        public_provenance["promotion_audit_sha256"] = str(audit_entry["sha256"])
        _write_json(public_target / "provenance.json", public_provenance)
        public_summaries = _normalized_summaries(public_records, quarantine=False, promotion_attestations=promotion_attestations)
        _write_jsonl(public_target / "records.jsonl", public_summaries)
        (public_target / "LICENSES.md").write_text(_data_license_notice(quarantine=False), encoding="utf-8", newline="\n")

        quarantine_manifest = store._create_snapshot(
            quarantine_records,
            QUARANTINE_BUNDLE_ID,
            sources=_quarantine_sources(lock),
            label="Sanitized public quarantine metadata index",
            created_at=created_at,
            manifest_annotations={
                "public_export": {
                    "schema_version": EXPORT_SCHEMA,
                    "profile": "PUBLIC_QUARANTINE",
                    "activation_policy": "DENY",
                    "default_model_visibility": False,
                    "sequence_content": "OMITTED",
                    "local_runtime_state_included": False,
                }
            },
            vacuum_catalogs=True,
        )
        quarantine_source = Path(str(quarantine_manifest["snapshot_path"]))
        quarantine_target.mkdir(parents=True)
        shutil.copy2(quarantine_source / "quarantine.sqlite", quarantine_target / "quarantine.sqlite")
        shutil.copytree(quarantine_source / "licenses", quarantine_target / "licenses")
        quarantine_summaries = _normalized_summaries(quarantine_records, quarantine=True)
        _write_jsonl(quarantine_target / "records.jsonl", quarantine_summaries)
        quarantine_db_sha = _sha256_file(quarantine_target / "quarantine.sqlite")
        q_manifest = {
            "schema_version": EXPORT_SCHEMA,
            "bundle_id": QUARANTINE_BUNDLE_ID,
            "profile": "PUBLIC_QUARANTINE",
            "created_at": created_at,
            "activation_policy": "DENY",
            "default_model_visibility": False,
            "record_count": len(quarantine_records),
            "database": {"path": "quarantine.sqlite", "sha256": quarantine_db_sha, "size_bytes": (quarantine_target / "quarantine.sqlite").stat().st_size},
            "records": {"path": "records.jsonl", "sha256": _sha256_file(quarantine_target / "records.jsonl")},
            "sequence_content": "OMITTED",
            "sources": _quarantine_sources(lock),
            "sanitization": {
                "allowlist_rebuild": True,
                "removed": ["local paths", "active state", "personal identity fields", "administrative logs", "sequence objects"],
                "redacted_sequence_digest_location": "metadata.public_quarantine_export.redacted_source_sequence_sha256",
            },
            "notice": "Public source metadata remains quarantined and is not a design, wet-lab, biosafety, or regulatory claim.",
        }
        _write_json(quarantine_target / "manifest.json", q_manifest)
        _write_json(
            quarantine_target / "provenance.json",
            {
                "schema_version": "proto-agent.materials-bundle-provenance.v1",
                "bundle_id": QUARANTINE_BUNDLE_ID,
                "profile": "PUBLIC_QUARANTINE",
                "manifest_sha256": _sha256_file(quarantine_target / "manifest.json"),
                "database_sha256": quarantine_db_sha,
                "source_lock_sha256": _sha256_file(lock_path),
                "sources": _quarantine_sources(lock),
            },
        )
        (quarantine_target / "LICENSES.md").write_text(_data_license_notice(quarantine=True), encoding="utf-8", newline="\n")

    _finalize_bundle(public_target, profile="PUBLIC_CATALOG", bundle_id=PUBLIC_BUNDLE_ID, records=_normalized_summaries(public_records, quarantine=False, promotion_attestations=promotion_attestations), activation_policy="EXPLICIT_HUMAN_ONLY", model_visibility=True)
    _finalize_bundle(quarantine_target, profile="PUBLIC_QUARANTINE", bundle_id=QUARANTINE_BUNDLE_ID, records=_normalized_summaries(quarantine_records, quarantine=True), activation_policy="DENY", model_visibility=False)
    return public_target, quarantine_target


def _default_repo() -> Path:
    return Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=_default_repo())
    parser.add_argument("--external-root", type=Path)
    parser.add_argument("--output-root", type=Path)
    args = parser.parse_args()
    repo = args.repo_root.resolve()
    external_root = (args.external_root or (repo.parent / f"{repo.name} Materials")).resolve()
    output_root = (args.output_root or (repo / "materials" / "bundles")).resolve()
    try:
        public_path, quarantine_path = build(repo, external_root, output_root)
    except (MaterialsError, OSError, ValueError, json.JSONDecodeError) as exc:
        parser.error(str(exc))
    print(_canonical_json({"ok": True, "public_bundle": str(public_path), "quarantine_bundle": str(quarantine_path)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
