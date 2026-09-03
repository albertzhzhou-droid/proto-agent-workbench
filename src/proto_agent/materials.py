"""Local-first biological materials catalog.

The catalog deliberately separates discovery metadata from design-ready parts.
It is a small, dependency-free layer over SQLite/FTS and content-addressed
sequence blobs.  Network adapters are optional; all model-facing operations
are read-only and bounded.
"""

from __future__ import annotations

import base64
import csv
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import sqlite3
import ssl
import stat
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any, Callable, Iterable, Iterator
from uuid import uuid4

from .protein_integrity import (
    CATALOG_ATTESTATION_ISSUER,
    CATALOG_ATTESTATION_KIND,
    CATALOG_PROMOTION_INDEX_SCHEMA_VERSION,
    CATALOG_SELECTION_ATTESTATION_SCHEMA_VERSION,
    CATALOG_SIGNATURE_STATUS,
    PROTEIN_SELECTION_SCHEMA_VERSION,
    canonical_json_sha256,
    catalog_selection_binding_sha256,
    protein_selection_digest,
    protein_selection_record,
    protein_selection_record_sha256,
    promotion_attestation_structure_error,
)
from .security import MAX_JSON_FILE_BYTES, SecurityBoundaryError, WorkspacePaths, read_json_bounded


MATERIALS_SCHEMA_VERSION = "proto-agent.materials.v1"
PARTS_SCHEMA_VERSION = "proto-agent.parts-library.v1"
PROMOTION_AUDIT_SCHEMA_VERSION = "proto-agent.materials-promotion-audit.v1"
PROMOTION_POLICY_VERSION = "proto-agent.materials-promotion-policy.2026-09"
PROMOTION_ROUND_IDS = (
    "provenance_rights",
    "sequence_ontology_safety",
    "duplicate_roundtrip_visibility",
)
DEFAULT_MATERIALS_DIRECTORY_NAME = "Proto CLI Materials"
DEFAULT_SNAPSHOT_ID = "seed-2026.08"
MAX_RESULT_LIMIT = 200
MAX_MCP_RESULT_LIMIT = 50
MAX_MATERIALIZED_PARTS = 50
MAX_QUERY_CHARS = 512
MAX_RESOURCE_ID_CHARS = 256
MAX_DESCRIPTION_CHARS = 4000
MAX_ACTIVATION_OPERATOR_CHARS = 128
MAX_APPROVAL_REFERENCE_CHARS = 512
MAX_SEQUENCE_CHARS = 10_000_000
MAX_NETWORK_PAGE_BYTES = 24 * 1024 * 1024
DNA_ALPHABET = set("ACGTUNRYKMSWBDHV")
RNA_ALPHABET = set("ACGUNRYKMSWBDHV")
PROTEIN_ALPHABET = set("ABCDEFGHIJKLMNOPQRSTUVWXYZ*-")
PART_TYPES = {"promoter", "rbs", "cds", "terminator"}
STATUS_VALUES = {"DESIGN_ELIGIBLE", "REVIEW_REQUIRED", "REFERENCE_ONLY", "QUARANTINED"}
REDISTRIBUTION_VALUES = {"REDISTRIBUTABLE", "CONDITIONAL", "LINK_ONLY"}
HARD_SAFETY_PATTERN = re.compile(
    r"(?:pathogen|virulence|toxin|toxic|antimicrobial resistance|antibiotic resistance|"
    r"drug resistance|clinical isolate|human pathogen|oncogenic|select agent|病原|毒力|毒素|"
    r"耐药|临床分离|人源病原)",
    re.IGNORECASE,
)
TOKEN_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}")

_PROCESS_LOCKS_GUARD = Lock()
_PROCESS_LOCKS: dict[str, Lock] = {}

# Design eligibility is deliberately narrower than catalog ingestion.  Unknown
# or conditional rights may still be indexed as REFERENCE_ONLY, but only a
# provider/license pair reviewed here can pass the controlled promotion gate.
# URLs are compared after stripping a trailing slash so the policy tolerates
# the canonical Creative Commons deed and legal-code spellings used by the
# upstream APIs without accepting an arbitrary lookalike URL.
KNOWN_PROVIDER_LICENSES: dict[str, dict[str, frozenset[str]]] = {
    "iGEM Registry": {
        "CC-BY-4.0": frozenset({
            "https://creativecommons.org/licenses/by/4.0",
            "https://creativecommons.org/licenses/by/4.0/legalcode",
        }),
        "CC0-1.0": frozenset({
            "https://creativecommons.org/publicdomain/zero/1.0",
            "https://creativecommons.org/publicdomain/zero/1.0/legalcode",
        }),
    },
    "UniProtKB/Swiss-Prot": {
        "CC-BY-4.0": frozenset({"https://creativecommons.org/licenses/by/4.0"}),
    },
    "Rhea": {
        "CC-BY-4.0": frozenset({"https://creativecommons.org/licenses/by/4.0"}),
    },
    "BioModels": {
        "CC0-1.0": frozenset({"https://creativecommons.org/publicdomain/zero/1.0"}),
    },
    "Proto Agent": {
        "CC0-1.0": frozenset({"https://creativecommons.org/publicdomain/zero/1.0"}),
    },
    # Test fixtures are a declared source rather than an arbitrary provider.
    "fixture": {
        "CC0-1.0": frozenset({"https://creativecommons.org/publicdomain/zero/1.0"}),
    },
}


class MaterialsError(ValueError):
    """A catalog operation failed a declared data or trust boundary."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def default_materials_root(workspace: str | Path | None = None) -> Path:
    """Resolve the project-sibling external data root used by the application."""

    configured = os.environ.get("PROTO_AGENT_MATERIALS_ROOT", "").strip()
    if configured:
        return Path(configured).absolute()
    root = Path.cwd().resolve() if workspace is None else Path(workspace).resolve()
    return root.parent / DEFAULT_MATERIALS_DIRECTORY_NAME


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_license_id(value: Any) -> str:
    """Return the canonical SPDX spelling used by promotion policy."""

    text = str(value or "").strip()
    return {
        "cc-by-4.0": "CC-BY-4.0",
        "cc0-1.0": "CC0-1.0",
    }.get(text.casefold(), text)


def provider_license_policy_errors(source: Any, license_info: Any) -> list[str]:
    """Return fail-closed promotion-policy errors for one source/license pair."""

    if not isinstance(source, dict) or not isinstance(license_info, dict):
        return ["SOURCE_OR_LICENSE_MISSING"]
    provider = str(source.get("provider") or "").strip()
    license_id = canonical_license_id(license_info.get("id"))
    allowed = KNOWN_PROVIDER_LICENSES.get(provider, {}).get(license_id)
    errors: list[str] = []
    if allowed is None:
        errors.append("PROVIDER_LICENSE_POLICY_UNKNOWN")
    license_url = str(license_info.get("url") or "").strip().rstrip("/")
    try:
        parsed = urllib.parse.urlsplit(license_url)
        public_https = parsed.scheme == "https" and bool(parsed.hostname) and not parsed.username and not parsed.password
    except ValueError:
        public_https = False
    if not public_https:
        errors.append("LICENSE_URL_INVALID")
    elif allowed is not None and license_url not in allowed:
        errors.append("LICENSE_URL_POLICY_MISMATCH")
    if not str(license_info.get("attribution") or "").strip():
        errors.append("LICENSE_ATTRIBUTION_MISSING")
    if not str(license_info.get("rights_notes") or "").strip():
        errors.append("LICENSE_RIGHTS_NOTES_MISSING")
    if str(license_info.get("redistribution_status") or "").strip().upper() != "REDISTRIBUTABLE":
        errors.append("LICENSE_NOT_REDISTRIBUTABLE")
    return errors


def promotion_record_digest(raw: dict[str, Any]) -> str:
    """Bind a promotion decision to the policy-relevant candidate fields."""

    if not isinstance(raw, dict):
        raise MaterialsError("INVALID_RECORD", "Promotion candidates must be objects.")
    fields = (
        "resource_id",
        "kind",
        "name",
        "aliases",
        "tags",
        "description_en",
        "description_zh",
        "organism",
        "chassis",
        "role_terms",
        "part_type",
        "sequence_kind",
        "sequence",
        "sequence_sha256",
        "source",
        "license",
        "evidence_refs",
        "review_status",
        "safety_status",
        "design_eligibility",
        "metadata",
    )
    payload = {key: raw.get(key) for key in fields}
    return _sha256_bytes(_json(payload).encode("utf-8"))


def promotion_attestation_valid(raw: dict[str, Any], attestation: Any) -> bool:
    """Validate a locked three-round promotion decision for ``raw``.

    The attestation is supplied by a trusted importer/exporter after its audit
    report hash has been checked against ``materials/bundles/source-lock.json``.
    Ordinary JSON import never supplies this argument and therefore cannot
    promote itself merely by setting DESIGN_ELIGIBLE fields.
    """

    if not isinstance(attestation, dict):
        return False
    if attestation.get("policy_version") != PROMOTION_POLICY_VERSION:
        return False
    if str(attestation.get("resource_id") or "") != str(raw.get("resource_id", raw.get("id")) or ""):
        return False
    if str(attestation.get("record_sha256") or "").lower() != promotion_record_digest(raw):
        return False
    if str(attestation.get("decision") or "").upper() != "PASS":
        return False
    rounds = attestation.get("rounds")
    if not isinstance(rounds, list) or [item.get("round_id") for item in rounds if isinstance(item, dict)] != list(PROMOTION_ROUND_IDS):
        return False
    for item in rounds:
        if not isinstance(item, dict) or str(item.get("status") or "").upper() != "PASS":
            return False
        reasons = item.get("reason_codes")
        if not isinstance(reasons, list) or not reasons or any(not isinstance(reason, str) or not reason for reason in reasons):
            return False
    return True


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _ensure_directory(path: Path) -> Path:
    """Create a directory tree while rejecting existing reparse/symlink nodes."""

    path = path.absolute()
    if path.exists() and not path.is_dir():
        raise MaterialsError("NOT_A_DIRECTORY", f"Expected a directory: {path}")
    current = Path(path.anchor)
    for component in path.parts[1:] if path.anchor else path.parts:
        current = current / component
        if current.exists():
            if current.is_symlink():
                raise MaterialsError("REPARSE_POINT_NOT_ALLOWED", f"Reparse points are not allowed: {current}")
            try:
                mode = current.stat(follow_symlinks=False).st_mode
            except OSError as exc:
                raise MaterialsError("PATH_INSPECTION_FAILED", f"Unable to inspect {current}") from exc
            if not stat.S_ISDIR(mode):
                raise MaterialsError("NOT_A_DIRECTORY", f"Expected a directory: {current}")
        else:
            current.mkdir()
    return path.resolve(strict=True)


@contextmanager
def _exclusive_materials_lock(path: Path, *, timeout_seconds: float = 15.0) -> Iterator[None]:
    """Serialize active-pointer decisions across threads and processes.

    The persistent one-byte lock file is intentionally kept under the external
    materials root.  A process-local lock closes the platform-dependent gap
    where two handles owned by one process may otherwise share an advisory
    lock, while ``msvcrt``/``fcntl`` provides the cross-process boundary.
    """

    parent = _ensure_directory(path.parent)
    lock_path = parent / path.name
    if lock_path.exists() and lock_path.is_symlink():
        raise MaterialsError("REPARSE_POINT_NOT_ALLOWED", f"Reparse points are not allowed: {lock_path}")
    lock_key = str(lock_path.resolve(strict=False)).casefold() if os.name == "nt" else str(lock_path.resolve(strict=False))
    with _PROCESS_LOCKS_GUARD:
        process_lock = _PROCESS_LOCKS.setdefault(lock_key, Lock())
    if not process_lock.acquire(timeout=timeout_seconds):
        raise MaterialsError("MATERIALS_LOCK_TIMEOUT", "Timed out waiting for the materials activation lock.")

    handle = None
    locked = False
    try:
        handle = lock_path.open("a+b")
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
            os.fsync(handle.fileno())
        deadline = time.monotonic() + timeout_seconds
        while True:
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                locked = True
                break
            except (OSError, BlockingIOError):
                if time.monotonic() >= deadline:
                    raise MaterialsError("MATERIALS_LOCK_TIMEOUT", "Timed out waiting for the materials activation lock.")
                time.sleep(0.01)
        yield
    finally:
        if handle is not None:
            if locked:
                try:
                    handle.seek(0)
                    if os.name == "nt":
                        import msvcrt

                        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                    else:
                        import fcntl

                        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
                except OSError:
                    pass
            handle.close()
        process_lock.release()


def _safe_write(path: Path, payload: bytes) -> None:
    parent = _ensure_directory(path.parent)
    if path.exists() and path.is_symlink():
        raise MaterialsError("REPARSE_POINT_NOT_ALLOWED", f"Reparse points are not writable: {path}")
    temporary = parent / f".{path.name}.materials-{uuid4().hex}.tmp"
    try:
        with temporary.open("xb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _safe_write_validated_parts(
    path: Path,
    payload: dict[str, Any],
    *,
    before_publish: Callable[[], None],
) -> None:
    """Strict-parse a staged parts library before atomically publishing it."""

    parent = _ensure_directory(path.parent)
    if path.exists() and path.is_symlink():
        raise MaterialsError("REPARSE_POINT_NOT_ALLOWED", f"Reparse points are not writable: {path}")
    temporary = parent / f".{path.name}.materials-{uuid4().hex}.tmp"
    encoded = (_json(payload) + "\n").encode("utf-8")
    try:
        with temporary.open("xb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            # This is the exact bounded/strict loader used by parts search,
            # check, and compile.  Validate the complete staged artifact and
            # ensure decoding did not alter the deterministic payload.
            from .parts import load_parts

            parsed = load_parts(temporary)
        except (SecurityBoundaryError, ValueError) as exc:
            raise MaterialsError(
                "MATERIALIZED_PARTS_INVALID",
                f"Materialized parts are not consumable by parts search, check, and compile: {exc}",
            ) from exc
        if parsed != payload:
            raise MaterialsError("MATERIALIZED_PARTS_INVALID", "Strict parts parsing changed the materialized payload.")
        before_publish()
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _safe_read_json(path: Path) -> dict[str, Any]:
    if path.is_symlink():
        raise MaterialsError("REPARSE_POINT_NOT_ALLOWED", f"Reparse points are not readable: {path}")
    try:
        if path.stat().st_size > MAX_JSON_FILE_BYTES:
            raise MaterialsError("FILE_TOO_LARGE", f"JSON import exceeds the {MAX_JSON_FILE_BYTES}-byte limit: {path}")
    except OSError as exc:
        raise MaterialsError("INVALID_JSON", f"Unable to inspect materials JSON: {path}") from exc
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MaterialsError("INVALID_JSON", f"Invalid materials JSON: {path}") from exc
    if not isinstance(payload, dict):
        raise MaterialsError("INVALID_JSON", f"Expected a JSON object: {path}")
    return payload


def load_locked_promotion_attestations(
    workspace: Path,
    source_path: Path,
    audit_path: Path,
    source_lock_path: Path,
) -> dict[str, dict[str, Any]]:
    """Load attestations only after source, audit, and lock hashes agree."""

    workspace = workspace.resolve()
    resolved = [source_path.resolve(), audit_path.resolve(), source_lock_path.resolve()]
    for path in resolved:
        if path.is_symlink() or not path.is_file():
            raise MaterialsError("PROMOTION_AUDIT_INVALID", f"Promotion input is missing or unsafe: {path}")
        try:
            path.relative_to(workspace)
        except ValueError as exc:
            raise MaterialsError("PROMOTION_AUDIT_INVALID", "Promotion inputs must be repository-local locked files.") from exc
    source_path, audit_path, source_lock_path = resolved
    lock = _safe_read_json(source_lock_path)
    if lock.get("schema_version") != "proto-agent.public-materials-source-lock.v1":
        raise MaterialsError("PROMOTION_AUDIT_INVALID", "Unsupported materials source lock.")
    source_relative = source_path.relative_to(workspace).as_posix()
    source_entry = next(
        (item for item in lock.get("eligible_inputs", []) if isinstance(item, dict) and item.get("path") == source_relative),
        None,
    )
    if not source_entry or str(source_entry.get("sha256") or "").lower() != _sha256_file(source_path):
        raise MaterialsError("PROMOTION_AUDIT_INVALID", "Reviewed source is absent from or mismatched with the source lock.")
    audit_relative = audit_path.relative_to(workspace).as_posix()
    locked_audit = lock.get("promotion_audit")
    if (
        not isinstance(locked_audit, dict)
        or locked_audit.get("path") != audit_relative
        or str(locked_audit.get("sha256") or "").lower() != _sha256_file(audit_path)
    ):
        raise MaterialsError("PROMOTION_AUDIT_INVALID", "Promotion audit is absent from or mismatched with the source lock.")
    report = _safe_read_json(audit_path)
    if report.get("schema_version") != PROMOTION_AUDIT_SCHEMA_VERSION or report.get("policy_version") != PROMOTION_POLICY_VERSION:
        raise MaterialsError("PROMOTION_AUDIT_INVALID", "Unsupported promotion audit policy.")
    candidates = report.get("candidates")
    if not isinstance(candidates, list):
        raise MaterialsError("PROMOTION_AUDIT_INVALID", "Promotion audit candidates are missing.")
    locked_evidence: dict[str, str] = {}
    evidence_entries = lock.get("source_evidence")
    if not isinstance(evidence_entries, list) or not evidence_entries:
        raise MaterialsError("PROMOTION_AUDIT_INVALID", "Promotion source evidence is absent from the source lock.")
    for item in evidence_entries:
        if not isinstance(item, dict):
            raise MaterialsError("PROMOTION_AUDIT_INVALID", "Promotion source evidence lock entry is invalid.")
        relative = str(item.get("path") or "")
        expected_sha256 = str(item.get("sha256") or "").lower()
        evidence_path = (workspace / relative).resolve()
        try:
            evidence_path.relative_to(workspace)
        except ValueError as exc:
            raise MaterialsError("PROMOTION_AUDIT_INVALID", "Promotion source evidence escaped the repository.") from exc
        if (
            not relative
            or relative in locked_evidence
            or evidence_path.is_symlink()
            or not evidence_path.is_file()
            or not re.fullmatch(r"[a-f0-9]{64}", expected_sha256)
            or _sha256_file(evidence_path) != expected_sha256
        ):
            raise MaterialsError("PROMOTION_AUDIT_INVALID", f"Promotion source evidence is missing or mismatched: {relative}")
        locked_evidence[relative] = expected_sha256
    attestations: dict[str, dict[str, Any]] = {}
    for candidate in candidates:
        if not isinstance(candidate, dict):
            raise MaterialsError("PROMOTION_AUDIT_INVALID", "Promotion audit candidate is invalid.")
        resource_id = str(candidate.get("resource_id") or "")
        if not resource_id or resource_id.casefold() in {item.casefold() for item in attestations}:
            raise MaterialsError("PROMOTION_AUDIT_INVALID", "Promotion audit contains a duplicate resource ID.")
        evidence = candidate.get("source_evidence")
        if not isinstance(evidence, dict):
            raise MaterialsError("PROMOTION_AUDIT_INVALID", f"Promotion audit has no source evidence for {resource_id}.")
        for evidence_name in ("record_response", "license_response"):
            response = evidence.get(evidence_name)
            if not isinstance(response, dict):
                raise MaterialsError("PROMOTION_AUDIT_INVALID", f"Promotion audit is missing {evidence_name} for {resource_id}.")
            relative = str(response.get("path") or "")
            digest = str(response.get("sha256") or "").lower()
            if not relative or locked_evidence.get(relative) != digest:
                raise MaterialsError("PROMOTION_AUDIT_INVALID", f"Promotion audit evidence is not source-locked for {resource_id}.")
        attestations[resource_id] = candidate
    return attestations


def _clean_text(value: Any, *, field: str, limit: int = MAX_DESCRIPTION_CHARS) -> str:
    if value is None:
        return ""
    text = str(value).replace("\x00", " ").strip()
    if len(text) > limit:
        raise MaterialsError("FIELD_TOO_LARGE", f"{field} exceeds the {limit}-character limit.")
    return text


def _activation_policy(manifest: dict[str, Any]) -> str:
    """Resolve the strongest activation policy declared by a snapshot.

    Public exports and reviewed imports can carry their policy in different
    manifest sections. DENY always wins, followed by the explicit-human
    evidence gate. Snapshots without a policy retain compatibility with the
    small built-in seed and historical local development snapshots.
    """

    public_export = manifest.get("public_export") if isinstance(manifest.get("public_export"), dict) else {}
    promotion_audit = manifest.get("promotion_audit") if isinstance(manifest.get("promotion_audit"), dict) else {}
    policies = {
        str(value).strip()
        for value in (
            manifest.get("activation_policy"),
            public_export.get("activation_policy"),
            promotion_audit.get("activation_policy"),
        )
        if value is not None and str(value).strip()
    }
    unsupported = sorted(policies - {"DENY", "EXPLICIT_HUMAN_ONLY"})
    if unsupported:
        raise MaterialsError(
            "ACTIVATION_POLICY_INVALID",
            f"Snapshot declares an unsupported activation policy: {', '.join(unsupported)}",
        )
    if (
        "DENY" in policies
        or manifest.get("profile") == "PUBLIC_QUARANTINE"
        or public_export.get("profile") == "PUBLIC_QUARANTINE"
    ):
        return "DENY"
    if "EXPLICIT_HUMAN_ONLY" in policies:
        return "EXPLICIT_HUMAN_ONLY"
    return "COMPATIBILITY"


def _activation_evidence(
    operator: Any,
    approval_reference: Any,
    *,
    required: bool,
    error_code: str | None = None,
) -> tuple[str, str]:
    """Validate bounded, single-line operator-supplied activation evidence.

    The operator value is deliberately a self-declared label, not an
    authenticated principal. Its assurance level is recorded separately in
    the active pointer so downstream consumers cannot mistake it for identity
    proof.
    """

    raw_operator = "" if operator is None else str(operator)
    raw_reference = "" if approval_reference is None else str(approval_reference)
    if any(
        ord(character) < 32 or ord(character) in {127, 0x85, 0x2028, 0x2029}
        for character in raw_operator + raw_reference
    ):
        raise MaterialsError(error_code or "ACTIVATION_EVIDENCE_INVALID", "Activation evidence must use bounded single-line text without control characters.")
    try:
        operator_text = _clean_text(raw_operator, field="operator", limit=MAX_ACTIVATION_OPERATOR_CHARS)
        reference_text = _clean_text(
            raw_reference,
            field="approval_reference",
            limit=MAX_APPROVAL_REFERENCE_CHARS,
        )
    except MaterialsError as exc:
        raise MaterialsError(error_code or "ACTIVATION_EVIDENCE_INVALID", str(exc)) from exc
    if required and (not operator_text or not reference_text):
        raise MaterialsError(
            error_code or "ACTIVATION_EVIDENCE_REQUIRED",
            "This snapshot requires both a self-declared operator label and a non-empty approval reference.",
        )
    if bool(operator_text) != bool(reference_text):
        raise MaterialsError(
            error_code or "ACTIVATION_EVIDENCE_REQUIRED",
            "Operator and approval reference must either both be supplied or both be omitted for compatibility snapshots.",
        )
    return operator_text, reference_text


def _clean_list(value: Any, *, field: str, limit: int = 128) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        values = [value]
    elif isinstance(value, list):
        values = value
    else:
        raise MaterialsError("INVALID_FIELD", f"{field} must be a string or array.")
    if len(values) > limit:
        raise MaterialsError("FIELD_TOO_LARGE", f"{field} has too many values.")
    return [_clean_text(item, field=field, limit=256) for item in values if _clean_text(item, field=field, limit=256)]


def _sequence_valid(sequence: str, sequence_kind: str) -> bool:
    alphabet = DNA_ALPHABET if sequence_kind == "DNA" else RNA_ALPHABET if sequence_kind == "RNA" else PROTEIN_ALPHABET
    return bool(sequence) and len(sequence) <= MAX_SEQUENCE_CHARS and set(sequence.upper()) <= alphabet


def _source_id(record: dict[str, Any]) -> str:
    source = record.get("source")
    if not isinstance(source, dict):
        return ""
    return _clean_text(source.get("record_id"), field="source.record_id", limit=512)


def _validated_resource_id(value: Any) -> str:
    """Return a namespaced, path-safe identifier from untrusted input."""

    resource_id = _clean_text(value, field="resource_id", limit=MAX_RESOURCE_ID_CHARS)
    if (
        not resource_id
        or ":" not in resource_id
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}", resource_id)
        or resource_id.startswith(("/", "\\"))
        or resource_id.endswith(("/", "\\"))
        or "\\" in resource_id
        or "//" in resource_id
        or "/." in resource_id
        or any(segment in {"", ".", ".."} for segment in resource_id.split("/"))
        or resource_id.split(":", 1)[0] in {".", ".."}
    ):
        raise MaterialsError("INVALID_RESOURCE_ID", "Resource IDs must be namespaced, bounded, and path-safe.")
    return resource_id


def _safety_classification(record: dict[str, Any]) -> tuple[str, list[str]]:
    text_parts = [
        record.get("name", ""),
        record.get("description_en", ""),
        record.get("description_zh", ""),
        record.get("organism", {}).get("name", "") if isinstance(record.get("organism"), dict) else "",
        " ".join(record.get("role_terms", []) if isinstance(record.get("role_terms"), list) else []),
    ]
    joined = " ".join(str(value) for value in text_parts)
    matches = sorted(set(match.group(0).lower() for match in HARD_SAFETY_PATTERN.finditer(joined)))
    return ("HARD_FLAG" if matches else "NO_FLAG", matches)


def _description_en(record: dict[str, Any]) -> str:
    existing = _clean_text(record.get("description_en"), field="description_en")
    if existing:
        return existing
    kind = _clean_text(record.get("kind"), field="kind", limit=128) or "resource"
    name = _clean_text(record.get("name"), field="name", limit=512) or "unnamed resource"
    organism = record.get("organism")
    organism_name = organism.get("name") if isinstance(organism, dict) else ""
    suffix = f" from {organism_name}" if organism_name else ""
    return f"{kind.replace('_', ' ').capitalize()}: {name}{suffix}."[:MAX_DESCRIPTION_CHARS]


def _description_zh(record: dict[str, Any], description_en: str) -> str:
    existing = _clean_text(record.get("description_zh"), field="description_zh")
    if existing:
        return existing
    kind = _clean_text(record.get("kind"), field="kind", limit=128) or "资源"
    name = _clean_text(record.get("name"), field="name", limit=512) or "未命名资源"
    organism = record.get("organism")
    organism_name = organism.get("name") if isinstance(organism, dict) else ""
    source = record.get("source")
    source_name = source.get("provider") if isinstance(source, dict) else ""
    segments = [f"类型：{kind}", f"名称：{name}"]
    if organism_name:
        segments.append(f"来源物种：{organism_name}")
    if source_name:
        segments.append(f"来源：{source_name}")
    segments.append("英文事实描述已保留，使用前仍需人工审查")
    return "；".join(segments) + "。"


def normalize_record(raw: dict[str, Any], *, promotion_attestation: dict[str, Any] | None = None) -> dict[str, Any]:
    """Normalize and classify an untrusted upstream/user record."""

    if not isinstance(raw, dict):
        raise MaterialsError("INVALID_RECORD", "Each material record must be an object.")
    resource_id = _validated_resource_id(raw.get("resource_id", raw.get("id")))
    kind = _clean_text(raw.get("kind"), field="kind", limit=128).lower()
    if not kind:
        raise MaterialsError("MISSING_FIELD", "kind is required.")
    name = _clean_text(raw.get("name"), field="name", limit=512) or resource_id
    aliases = _clean_list(raw.get("aliases"), field="aliases")
    role_terms = _clean_list(raw.get("role_terms"), field="role_terms")
    tags = _clean_list(raw.get("tags"), field="tags")
    description_en = _description_en({**raw, "kind": kind, "name": name})
    description_zh = _description_zh({**raw, "kind": kind, "name": name}, description_en)
    organism = raw.get("organism") if isinstance(raw.get("organism"), dict) else {}
    organism = {
        "tax_id": organism.get("tax_id"),
        "name": _clean_text(organism.get("name"), field="organism.name", limit=512),
        "strain": _clean_text(organism.get("strain"), field="organism.strain", limit=512),
    }
    chassis = _clean_list(raw.get("chassis"), field="chassis")
    sequence = _clean_text(raw.get("sequence"), field="sequence", limit=MAX_SEQUENCE_CHARS).upper().replace(" ", "").replace("\n", "")
    sequence_kind = _clean_text(raw.get("sequence_kind"), field="sequence_kind", limit=32).upper()
    if sequence and sequence_kind not in {"DNA", "RNA", "PROTEIN"}:
        raise MaterialsError("INVALID_SEQUENCE_KIND", "sequence_kind must be DNA, RNA, or PROTEIN when sequence is present.")
    if sequence and not _sequence_valid(sequence, sequence_kind):
        raise MaterialsError("INVALID_SEQUENCE", f"Sequence for {resource_id} contains unsupported symbols or exceeds the limit.")
    sequence_sha256 = _sha256_bytes(sequence.encode("ascii")) if sequence else ""
    source = raw.get("source")
    if not isinstance(source, dict):
        raise MaterialsError("MISSING_SOURCE", f"Source metadata is required for {resource_id}.")
    source = {
        "provider": _clean_text(source.get("provider"), field="source.provider", limit=256),
        "record_id": _clean_text(source.get("record_id"), field="source.record_id", limit=512),
        "revision": _clean_text(source.get("revision"), field="source.revision", limit=256),
        "release": _clean_text(source.get("release"), field="source.release", limit=256),
        "url": _clean_text(source.get("url"), field="source.url", limit=2048),
        "retrieved_at": _clean_text(source.get("retrieved_at"), field="source.retrieved_at", limit=64),
        "content_sha256": _clean_text(source.get("content_sha256"), field="source.content_sha256", limit=64).lower(),
        "sequence_sha256": _clean_text(source.get("sequence_sha256"), field="source.sequence_sha256", limit=64).lower(),
    }
    if not source["provider"] or not source["record_id"] or not source["url"]:
        raise MaterialsError("MISSING_SOURCE", f"Source provider, record_id, and url are required for {resource_id}.")
    if not re.fullmatch(r"[a-f0-9]{64}", source["content_sha256"]):
        raise MaterialsError("INVALID_SOURCE_HASH", f"source.content_sha256 must be a SHA-256 digest for {resource_id}.")
    if source["sequence_sha256"] and not re.fullmatch(r"[a-f0-9]{64}", source["sequence_sha256"]):
        raise MaterialsError("INVALID_SOURCE_HASH", f"source.sequence_sha256 must be a SHA-256 digest for {resource_id}.")
    if source["sequence_sha256"] and source["sequence_sha256"] != sequence_sha256:
        raise MaterialsError("SOURCE_SEQUENCE_HASH_MISMATCH", f"source.sequence_sha256 does not match the sequence for {resource_id}.")
    if sequence and not source["sequence_sha256"]:
        # Keep the sequence digest distinct from the raw/page response digest.
        # Promotion audits still require it to have been explicit in the raw
        # reviewed record; reference-only ingestion may derive it here.
        source["sequence_sha256"] = sequence_sha256
    source_version_present = bool(source["revision"] or source["release"])
    license_info = raw.get("license")
    if not isinstance(license_info, dict):
        raise MaterialsError("MISSING_LICENSE", f"License metadata is required for {resource_id}.")
    license_info = {
        "id": canonical_license_id(_clean_text(license_info.get("id"), field="license.id", limit=128)),
        "url": _clean_text(license_info.get("url"), field="license.url", limit=2048),
        "attribution": _clean_text(license_info.get("attribution"), field="license.attribution", limit=1024),
        "rights_notes": _clean_text(license_info.get("rights_notes"), field="license.rights_notes", limit=2048),
        "redistribution_status": _clean_text(license_info.get("redistribution_status"), field="license.redistribution_status", limit=32).upper(),
    }
    if not license_info["id"] or license_info["redistribution_status"] not in REDISTRIBUTION_VALUES:
        raise MaterialsError("INVALID_LICENSE", f"License ID and redistribution status are required for {resource_id}.")
    safety_status, safety_flags = _safety_classification({**raw, "name": name, "description_en": description_en, "description_zh": description_zh, "organism": organism, "role_terms": role_terms})
    derived_safety_status = safety_status
    supplied_safety = _clean_text(raw.get("safety_status"), field="safety_status", limit=32).upper()
    safety_metadata_valid = not supplied_safety or supplied_safety in {"NO_FLAG", "HARD_FLAG"}
    if supplied_safety == "HARD_FLAG":
        safety_status = "HARD_FLAG"
        safety_flags = sorted(set([*safety_flags, "explicit-hard-flag"]))
    elif supplied_safety == "NO_FLAG" and derived_safety_status == "NO_FLAG":
        safety_status = "NO_FLAG"
    elif supplied_safety:
        safety_flags = sorted(set([*safety_flags, "invalid-safety-status"]))
    requested_status = _clean_text(raw.get("review_status"), field="review_status", limit=32).upper()
    if requested_status not in STATUS_VALUES:
        requested_status = "REVIEW_REQUIRED"
    if requested_status == "DESIGN_ELIGIBLE":
        promotion_errors = provider_license_policy_errors(source, license_info)
        explicit_sequence_digest = str((raw.get("source") or {}).get("sequence_sha256") or "").lower() if isinstance(raw.get("source"), dict) else ""
        controlled_promotion = (
            promotion_attestation_valid(raw, promotion_attestation)
            and supplied_safety == "NO_FLAG"
            and not promotion_errors
            and bool(raw.get("evidence_refs"))
            and bool(source["retrieved_at"])
            and explicit_sequence_digest == sequence_sha256
        )
        if not controlled_promotion:
            requested_status = "REVIEW_REQUIRED"
    if not sequence:
        requested_status = "REFERENCE_ONLY"
    if license_info["redistribution_status"] == "LINK_ONLY":
        requested_status = "REFERENCE_ONLY"
    elif license_info["redistribution_status"] != "REDISTRIBUTABLE" and requested_status == "DESIGN_ELIGIBLE":
        requested_status = "REVIEW_REQUIRED"
    if not source_version_present or not safety_metadata_valid:
        requested_status = "REVIEW_REQUIRED"
    if safety_status == "HARD_FLAG":
        requested_status = "QUARANTINED"
    design_eligibility = bool(raw.get("design_eligibility", False))
    part_type = _clean_text(raw.get("part_type", raw.get("type")), field="part_type", limit=64).lower()
    if kind == "genetic_part" and part_type not in PART_TYPES:
        design_eligibility = False
    # Protein sequences are a separate compiler domain.  They may become
    # design-eligible only when the upstream record explicitly opts in; they
    # never inherit DNA part/chassis semantics.  Reactions, models, and
    # generic imported sequences remain reference-only by default.
    compilable_kind = (kind == "genetic_part" and sequence_kind == "DNA" and part_type in PART_TYPES) or (
        kind == "protein_sequence" and sequence_kind == "PROTEIN"
    )
    if not compilable_kind or not sequence or license_info["redistribution_status"] != "REDISTRIBUTABLE" or safety_status == "HARD_FLAG":
        design_eligibility = False
    if requested_status != "DESIGN_ELIGIBLE":
        design_eligibility = False
    metadata = raw.get("metadata") if isinstance(raw.get("metadata"), dict) else {}
    normalized = {
        "resource_id": resource_id,
        "kind": kind,
        "name": name,
        "aliases": aliases,
        "tags": tags,
        "description_en": description_en,
        "description_zh": description_zh,
        "organism": organism,
        "chassis": chassis,
        "role_terms": role_terms,
        "part_type": part_type,
        "sequence_kind": sequence_kind,
        "sequence": sequence,
        "sequence_sha256": sequence_sha256,
        "sequence_length": len(sequence),
        "source": source,
        "license": license_info,
        "evidence_refs": _clean_list(raw.get("evidence_refs"), field="evidence_refs"),
        "review_status": requested_status,
        "safety_status": safety_status,
        "safety_flags": safety_flags,
        "design_eligibility": design_eligibility,
        "metadata": metadata,
    }
    return normalized


def builtin_records() -> list[dict[str, Any]]:
    """Small non-sequence seed records shipped with the application."""

    common_source = {
        "provider": "Proto Agent",
        "revision": "seed-1",
        "release": "2026.08",
        "retrieved_at": _now(),
        "content_sha256": _sha256_bytes(b"proto-agent-materials-seed-2026.08"),
    }
    common_license = {
        "id": "CC0-1.0",
        "url": "https://creativecommons.org/publicdomain/zero/1.0/",
        "attribution": "Proto Agent seed templates",
        "rights_notes": "Software-only design template; no experimental protocol.",
        "redistribution_status": "REDISTRIBUTABLE",
    }
    templates = [
        ("proto:template/expression-cassette", "Expression cassette", "表达盒模板", ["promoter", "rbs", "cds", "terminator"]),
        ("proto:template/dual-expression", "Dual expression cassette", "双表达盒模板", ["promoter", "rbs", "cds", "terminator", "promoter", "rbs", "cds", "terminator"]),
        ("proto:template/circular-module", "Circular construct module", "环状构建模块模板", ["promoter", "rbs", "cds", "terminator"]),
    ]
    result: list[dict[str, Any]] = []
    for resource_id, name, name_zh, slots in templates:
        result.append(
            {
                "resource_id": resource_id,
                "kind": "design_template",
                "name": name,
                "description_en": f"Software-only Proto design template with ordered slots: {', '.join(slots)}.",
                "description_zh": f"仅用于软件设计的 Proto 模板，槽位顺序：{'、'.join(slots)}。",
                "aliases": [name_zh],
                "tags": ["template", "software-only", "human-review-required"],
                "role_terms": [],
                "source": {**common_source, "record_id": resource_id, "url": "https://github.com/openai/proto-agent"},
                "license": common_license,
                "review_status": "DESIGN_ELIGIBLE",
                "design_eligibility": False,
                "metadata": {"slots": slots, "template_language": "proto-agent-dsl"},
            }
        )
    return result


def _record_summary(record: dict[str, Any]) -> dict[str, Any]:
    source = record.get("source", {})
    license_info = record.get("license", {})
    return {
        "resource_id": record["resource_id"],
        "kind": record["kind"],
        "name": record["name"],
        "aliases": record["aliases"],
        "description_en": record["description_en"],
        "description_zh": record["description_zh"],
        "organism": record["organism"],
        "chassis": record["chassis"],
        "role_terms": record["role_terms"],
        "part_type": record["part_type"],
        "sequence_kind": record["sequence_kind"],
        "sequence_length": record["sequence_length"],
        "sequence_sha256": record["sequence_sha256"],
        "source": source,
        "license": license_info,
        "evidence_refs": record["evidence_refs"],
        "review_status": record["review_status"],
        "safety_status": record["safety_status"],
        "safety_flags": record["safety_flags"],
        "design_eligibility": record["design_eligibility"],
        "metadata": record["metadata"],
    }


class MaterialsStore:
    """Manage snapshots and bounded searches in the external materials root."""

    def __init__(self, workspace: str | Path | None = None, root: str | Path | None = None) -> None:
        self.workspace = Path.cwd().resolve() if workspace is None else Path(workspace).resolve()
        if not self.workspace.is_dir():
            raise MaterialsError("WORKSPACE_NOT_FOUND", f"Workspace does not exist: {self.workspace}")
        requested_root = default_materials_root(self.workspace) if root is None else Path(root).absolute()
        if requested_root == self.workspace or self.workspace in requested_root.parents:
            raise MaterialsError("INVALID_MATERIALS_ROOT", "Materials root must be outside the workspace tree.")
        self.root = _ensure_directory(requested_root)
        self.snapshots = _ensure_directory(self.root / "snapshots")
        self.staging = _ensure_directory(self.root / "staging")
        self.quarantine = _ensure_directory(self.root / "quarantine")
        self.overlays = _ensure_directory(self.root / "overlays")

    @property
    def active_pointer(self) -> Path:
        return self.root / "active.json"

    def status(self) -> dict[str, Any]:
        active = self._active_id()
        payload: dict[str, Any] = {
            "ok": True,
            "schema_version": MATERIALS_SCHEMA_VERSION,
            "materials_root": str(self.root),
            "active_snapshot": active,
            "snapshots": [],
            "staging": sorted(path.name for path in self.staging.iterdir() if path.is_dir()),
            "overlays": [],
        }
        for path in sorted(self.snapshots.iterdir()):
            if not path.is_dir() or path.is_symlink() or not (path / "manifest.json").is_file():
                continue
            try:
                manifest = _safe_read_json(path / "manifest.json")
                payload["snapshots"].append({
                    "snapshot_id": manifest.get("snapshot_id", path.name),
                    "record_count": manifest.get("record_count", 0),
                    "status_counts": manifest.get("status_counts", {}),
                    "sources": manifest.get("sources", []),
                    "manifest_sha256": _sha256_file(path / "manifest.json"),
                    "active": manifest.get("snapshot_id", path.name) == active,
                })
            except MaterialsError:
                payload["snapshots"].append({"snapshot_id": path.name, "invalid": True, "active": path.name == active})
        overlays: list[dict[str, Any]] = []
        for overlay_path in sorted(self.overlays.glob("*.json"), reverse=True)[:100]:
            try:
                overlay = _safe_read_json(overlay_path)
                overlays.append({
                    "overlay_id": overlay.get("overlay_id", overlay_path.stem),
                    "resource_id": overlay.get("resource_id", ""),
                    "snapshot_id": overlay.get("snapshot_id", ""),
                    "decision": overlay.get("decision", ""),
                    "reviewer": overlay.get("reviewer", ""),
                    "created_at": overlay.get("created_at", ""),
                    "overlay_sha256": overlay.get("overlay_sha256", ""),
                    "path": str(overlay_path),
                })
            except MaterialsError:
                overlays.append({"overlay_id": overlay_path.stem, "invalid": True, "path": str(overlay_path)})
        payload["overlays"] = overlays
        return payload

    def initialize_seed(self, *, activate: bool = True) -> dict[str, Any]:
        records = [normalize_record(item) for item in builtin_records()]
        snapshot_id = DEFAULT_SNAPSHOT_ID
        if (self.snapshots / snapshot_id).exists():
            if activate:
                self.activate(snapshot_id)
            return self.manifest(snapshot_id)
        manifest = self._create_snapshot(records, snapshot_id, sources=[{"provider": "Proto Agent", "release": "seed-1"}], label="Small open seed")
        if activate:
            self.activate(snapshot_id)
        return manifest

    def manifest(self, snapshot_id: str | None = None) -> dict[str, Any]:
        snapshot_id = snapshot_id or self._active_id()
        if not snapshot_id:
            raise MaterialsError("NO_ACTIVE_SNAPSHOT", "No materials snapshot is active.")
        path = self._snapshot_dir(snapshot_id) / "manifest.json"
        if not path.is_file():
            raise MaterialsError("SNAPSHOT_NOT_FOUND", f"Snapshot not found: {snapshot_id}")
        return _safe_read_json(path)

    def _snapshot_promotion_attestations(
        self,
        snapshot_id: str,
        manifest: dict[str, Any],
    ) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
        """Resolve the manifest-bound promotion decisions used for selection receipts.

        New snapshots carry a content-addressed attestation index in their
        manifest.  The already-published 2026.09 snapshot predates that index,
        so it can be migrated without changing its bundle by reading the
        repository-locked audit named by the immutable manifest.  Compilation
        never calls this method; all evidence is copied into the selection.
        """

        index = manifest.get("promotion_attestation_index")
        indexed: dict[str, dict[str, Any]] = {}
        index_digest = ""
        if index is not None:
            if not isinstance(index, dict) or index.get("schema_version") != CATALOG_PROMOTION_INDEX_SCHEMA_VERSION:
                raise MaterialsError("PROMOTION_ATTESTATION_INVALID", "Snapshot promotion-attestation index is invalid.")
            if index.get("policy_version") != PROMOTION_POLICY_VERSION:
                raise MaterialsError("PROMOTION_ATTESTATION_INVALID", "Snapshot promotion policy is unsupported.")
            candidates = index.get("attestations")
            if not isinstance(candidates, list) or not candidates:
                raise MaterialsError("PROMOTION_ATTESTATION_INVALID", "Snapshot promotion-attestation index is empty.")
            index_digest = canonical_json_sha256(candidates)
            if str(index.get("attestations_sha256") or "").lower() != index_digest:
                raise MaterialsError("PROMOTION_ATTESTATION_INVALID", "Snapshot promotion-attestation index digest does not match.")
            for candidate in candidates:
                resource_id = str(candidate.get("resource_id") or "") if isinstance(candidate, dict) else ""
                problem = promotion_attestation_structure_error(candidate, resource_id)
                if problem or resource_id.casefold() in {item.casefold() for item in indexed}:
                    raise MaterialsError("PROMOTION_ATTESTATION_INVALID", problem or "Snapshot promotion-attestation index contains duplicate IDs.")
                indexed[resource_id] = candidate

        annotation = manifest.get("promotion_audit")
        audited: dict[str, dict[str, Any]] = {}
        audit_summary: dict[str, Any] | None = None
        if annotation is not None:
            if not isinstance(annotation, dict):
                raise MaterialsError("PROMOTION_ATTESTATION_INVALID", "Snapshot promotion-audit annotation is invalid.")
            audit_digest = str(annotation.get("sha256") or "").lower()
            if (
                annotation.get("schema_version") != PROMOTION_AUDIT_SCHEMA_VERSION
                or annotation.get("policy_version") != PROMOTION_POLICY_VERSION
                or not re.fullmatch(r"[a-f0-9]{64}", audit_digest)
            ):
                raise MaterialsError("PROMOTION_ATTESTATION_INVALID", "Snapshot promotion-audit binding is incomplete.")
            audit_summary = {
                "schema_version": PROMOTION_AUDIT_SCHEMA_VERSION,
                "policy_version": PROMOTION_POLICY_VERSION,
                "sha256": audit_digest,
                "source": "snapshot-manifest-locked-audit",
            }
            relative = str(annotation.get("path") or "")
            if relative:
                report_path = (self.workspace / relative).resolve()
                try:
                    report_path.relative_to(self.workspace)
                except ValueError as exc:
                    raise MaterialsError("PROMOTION_ATTESTATION_INVALID", "Snapshot promotion-audit path escaped the workspace.") from exc
                if report_path.is_file() and not report_path.is_symlink():
                    if _sha256_file(report_path) != audit_digest:
                        raise MaterialsError("PROMOTION_ATTESTATION_INVALID", "Snapshot promotion-audit file digest does not match its manifest.")
                    report = _safe_read_json(report_path)
                    candidates = report.get("candidates")
                    if (
                        report.get("schema_version") != PROMOTION_AUDIT_SCHEMA_VERSION
                        or report.get("policy_version") != PROMOTION_POLICY_VERSION
                        or not isinstance(candidates, list)
                    ):
                        raise MaterialsError("PROMOTION_ATTESTATION_INVALID", "Snapshot promotion-audit report is invalid.")
                    for candidate in candidates:
                        resource_id = str(candidate.get("resource_id") or "") if isinstance(candidate, dict) else ""
                        problem = promotion_attestation_structure_error(candidate, resource_id)
                        if problem or resource_id.casefold() in {item.casefold() for item in audited}:
                            raise MaterialsError("PROMOTION_ATTESTATION_INVALID", problem or "Snapshot promotion audit contains duplicate IDs.")
                        audited[resource_id] = candidate

        if audited and indexed:
            for resource_id, candidate in indexed.items():
                audited_candidate = audited.get(resource_id)
                if audited_candidate is None or canonical_json_sha256(audited_candidate) != canonical_json_sha256(candidate):
                    raise MaterialsError("PROMOTION_ATTESTATION_INVALID", f"Snapshot promotion index disagrees with the locked audit for {resource_id}.")
        attestations = audited or indexed
        if not attestations:
            public_export = manifest.get("public_export")
            eligible_count = int((manifest.get("status_counts") or {}).get("DESIGN_ELIGIBLE", -1)) if isinstance(manifest.get("status_counts"), dict) else -1
            audit_pass_count = int(annotation.get("pass_count", -1)) if isinstance(annotation, dict) else -1
            if (
                audit_summary is not None
                and isinstance(public_export, dict)
                and public_export.get("profile") == "PUBLIC_CATALOG"
                and eligible_count == int(manifest.get("record_count", -2))
                and audit_pass_count == eligible_count
            ):
                # Installed public bundles intentionally omit the repository
                # audit report. The immutable manifest still binds its digest
                # and pass count; materialization issues a per-record catalogue
                # receipt below and labels that derivation explicitly.
                audit_summary["source"] = "public-bundle-manifest-audit-root"
                audit_summary["attestation_resolution"] = "catalog-issued-normalized-record-binding"
                return {}, audit_summary
            raise MaterialsError(
                "PROMOTION_ATTESTATION_MISSING",
                f"Snapshot {snapshot_id} has no locally verifiable promotion attestations; reissue or rematerialize it with the current catalogue.",
            )
        if audit_summary is None:
            audit_summary = {
                "schema_version": PROMOTION_AUDIT_SCHEMA_VERSION,
                "policy_version": PROMOTION_POLICY_VERSION,
                "sha256": index_digest,
                "source": "snapshot-manifest-promotion-index",
            }
        return attestations, audit_summary

    def search(
        self,
        query: str = "",
        *,
        kind: str | None = None,
        organism: str | None = None,
        role: str | None = None,
        source: str | None = None,
        license_id: str | None = None,
        status: str | None = "DESIGN_ELIGIBLE",
        limit: int = 20,
        cursor: str | None = None,
        include_quarantine: bool = False,
        snapshot_id: str | None = None,
        auto_initialize: bool = True,
    ) -> dict[str, Any]:
        if len(query) > MAX_QUERY_CHARS or "\x00" in query:
            raise MaterialsError("INVALID_QUERY", "Query must be 0 to 512 characters and contain no NUL.")
        limit = max(1, min(int(limit), MAX_RESULT_LIMIT))
        offset = _decode_cursor(cursor)
        snapshot_id = snapshot_id or self._active_id()
        if not snapshot_id:
            if not auto_initialize:
                raise MaterialsError("NO_ACTIVE_SNAPSHOT", "No materials snapshot is active.")
            self.initialize_seed()
            snapshot_id = self._active_id()
        conn = self._connect(snapshot_id, quarantine=include_quarantine)
        try:
            clauses: list[str] = []
            params: list[Any] = []
            fts_query = _fts_query(query)
            if fts_query:
                clauses.append("rowid IN (SELECT rowid FROM resources_fts WHERE resources_fts MATCH ?)")
                params.append(fts_query)
            if kind:
                clauses.append("kind = ?")
                params.append(kind.lower())
            if organism:
                clauses.append("(organism_name LIKE ? OR organism_tax_id = ? OR chassis_json LIKE ?)")
                params.extend([f"%{organism}%", str(organism), f"%{organism}%"])
            if role:
                clauses.append("role_terms_json LIKE ?")
                params.append(f"%{role}%")
            if source:
                clauses.append("source_provider = ?")
                params.append(source)
            if license_id:
                clauses.append("license_id = ?")
                params.append(license_id)
            if status and status.upper() != "ALL":
                selected = _clean_status_filter(status)
                placeholders = ",".join("?" for _ in selected)
                clauses.append(f"review_status IN ({placeholders})")
                params.extend(selected)
            where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
            count = int(conn.execute(f"SELECT COUNT(*) FROM resources{where}", params).fetchone()[0])
            rows = conn.execute(
                f"SELECT resource_id, kind, name, aliases_json, description_en, description_zh, organism_json, chassis_json, role_terms_json, part_type, sequence_kind, sequence_length, sequence_sha256, source_json, license_json, evidence_refs_json, review_status, safety_status, safety_flags_json, design_eligibility, metadata_json FROM resources{where} ORDER BY resource_id LIMIT ? OFFSET ?",
                [*params, limit + 1, offset],
            ).fetchall()
            truncated = len(rows) > limit
            rows = rows[:limit]
            matches = [_row_summary(row) for row in rows]
            return {
                "ok": True,
                "snapshot_id": snapshot_id,
                "matches": matches,
                "match_count": count,
                "returned_count": len(matches),
                "truncated": truncated,
                "next_cursor": _encode_cursor(offset + limit) if truncated else None,
            }
        finally:
            conn.close()

    def facets(self, *, snapshot_id: str | None = None, include_quarantine: bool = False, status: str | None = None, auto_initialize: bool = True) -> dict[str, Any]:
        snapshot_id = snapshot_id or self._active_id()
        if not snapshot_id:
            if not auto_initialize:
                raise MaterialsError("NO_ACTIVE_SNAPSHOT", "No materials snapshot is active.")
            self.initialize_seed()
            snapshot_id = self._active_id()
        conn = self._connect(snapshot_id, quarantine=include_quarantine)
        try:
            where = ""
            params: tuple[Any, ...] = ()
            if status and status.upper() != "ALL":
                selected = _clean_status_filter(status)
                where = f" WHERE review_status IN ({','.join('?' for _ in selected)})"
                params = tuple(selected)
            def grouped(field: str) -> dict[str, int]:
                return {str(key): int(value) for key, value in conn.execute(f"SELECT {field}, COUNT(*) FROM resources{where} GROUP BY {field} ORDER BY COUNT(*) DESC, {field}", params)}
            return {"ok": True, "snapshot_id": snapshot_id, "kinds": grouped("kind"), "statuses": grouped("review_status"), "safety": grouped("safety_status"), "sources": grouped("source_provider"), "licenses": grouped("license_id")}
        finally:
            conn.close()

    def get(self, resource_id: str, *, include_sequence: bool = False, include_quarantine: bool = False, snapshot_id: str | None = None, auto_initialize: bool = True) -> dict[str, Any]:
        resource_id = _validated_resource_id(resource_id)
        snapshot_id = snapshot_id or self._active_id()
        if not snapshot_id:
            if not auto_initialize:
                raise MaterialsError("NO_ACTIVE_SNAPSHOT", "No materials snapshot is active.")
            self.initialize_seed()
            snapshot_id = self._active_id()
        conn = self._connect(snapshot_id, quarantine=include_quarantine)
        try:
            row = conn.execute("SELECT * FROM resources WHERE resource_id = ?", (resource_id,)).fetchone()
            if row is None:
                raise MaterialsError("RESOURCE_NOT_FOUND", f"Resource not found: {resource_id}")
            result = _row_full(row)
            if include_sequence:
                if (result["review_status"] == "QUARANTINED" or result["safety_status"] == "HARD_FLAG") and not include_quarantine:
                    raise MaterialsError("QUARANTINE_ACCESS_DENIED", "Quarantine sequences are not available through the model-facing catalog.")
                if result["sequence_sha256"]:
                    blob = self._blob_path(snapshot_id, result["sequence_sha256"], quarantine=include_quarantine)
                    if not blob.is_file():
                        raise MaterialsError("SEQUENCE_BLOB_MISSING", f"Sequence blob is missing for {resource_id}.")
                    with gzip.open(blob, "rt", encoding="ascii") as handle:
                        result["sequence"] = handle.read()
            return {"ok": True, "snapshot_id": snapshot_id, "resource": result}
        finally:
            conn.close()

    def materialize_parts(
        self,
        resource_ids: list[str],
        chassis: str,
        *,
        output: str | Path | None = None,
        snapshot_id: str | None = None,
        auto_initialize: bool = True,
        require_active: bool = False,
    ) -> dict[str, Any]:
        if not resource_ids or len(resource_ids) > MAX_MATERIALIZED_PARTS:
            raise MaterialsError(
                "INVALID_SELECTION",
                f"Select between 1 and {MAX_MATERIALIZED_PARTS} resources so the parts library remains consumable by check, compile, and parts search.",
            )
        canonical_ids: list[str] = []
        seen: set[str] = set()
        for value in resource_ids:
            resource_id = _validated_resource_id(value)
            canonical_id = resource_id.casefold()
            if canonical_id in seen:
                raise MaterialsError("DUPLICATE_RESOURCE_ID", f"Duplicate part resource ID: {resource_id}")
            seen.add(canonical_id)
            canonical_ids.append(resource_id)
        canonical_ids.sort(key=lambda value: (value.casefold(), value))
        chassis = _clean_text(chassis, field="chassis", limit=256)
        bind_to_active = require_active or snapshot_id is None
        resolved_snapshot = snapshot_id or self._active_id()
        if not resolved_snapshot:
            if not auto_initialize:
                raise MaterialsError("NO_ACTIVE_SNAPSHOT", "No materials snapshot is active.")
            self.initialize_seed()
            resolved_snapshot = self._active_id()
        if not resolved_snapshot:
            raise MaterialsError("NO_ACTIVE_SNAPSHOT", "No materials snapshot is active.")

        if bind_to_active:
            with _exclusive_materials_lock(self.root / ".active.lock"):
                return self._materialize_parts_verified(
                    canonical_ids,
                    chassis,
                    resolved_snapshot,
                    output=output,
                    require_active=True,
                )
        return self._materialize_parts_verified(
            canonical_ids,
            chassis,
            resolved_snapshot,
            output=output,
            require_active=False,
        )

    def _materialize_parts_verified(
        self,
        canonical_ids: list[str],
        chassis: str,
        snapshot_id: str,
        *,
        output: str | Path | None,
        require_active: bool,
    ) -> dict[str, Any]:
        self._verify_materialization_snapshot(snapshot_id, require_active=require_active, initial=True, verify_contents=True)
        selected: list[dict[str, Any]] = []
        for resource_id in canonical_ids:
            resource = self.get(resource_id, include_sequence=True, snapshot_id=snapshot_id, auto_initialize=False)["resource"]
            if resource["kind"] != "genetic_part" or resource["part_type"] not in PART_TYPES:
                raise MaterialsError("NOT_COMPILABLE_PART", f"Resource is not a supported Proto part: {resource_id}")
            if not resource["design_eligibility"] or resource["review_status"] != "DESIGN_ELIGIBLE":
                raise MaterialsError("PART_NOT_ELIGIBLE", f"Resource is not design-eligible: {resource_id}")
            if chassis not in resource.get("chassis", []):
                raise MaterialsError("CHASSIS_MISMATCH", f"Resource {resource_id} is not declared for chassis {chassis}.")
            sequence = resource.get("sequence")
            sequence_sha256 = resource.get("sequence_sha256")
            if not isinstance(sequence, str) or not isinstance(sequence_sha256, str) or _sha256_bytes(sequence.encode("ascii")) != sequence_sha256:
                raise MaterialsError("SNAPSHOT_INTEGRITY_FAILED", f"Selected sequence object hash mismatch for {resource_id}.")
            selected.append(resource)
        self._verify_materialization_snapshot(snapshot_id, require_active=require_active, initial=False, verify_contents=False)
        canonical = _json({"snapshot_id": snapshot_id, "chassis": chassis, "ids": canonical_ids}).encode("utf-8")
        digest = _sha256_bytes(canonical)
        paths = WorkspacePaths.create(self.workspace)
        target = paths.build_file(output or f"build/materials/selections/{digest}/parts.json", extensions={".json"})
        payload = {
            "schema_version": PARTS_SCHEMA_VERSION,
            "library_id": f"selection:{digest}",
            "version": snapshot_id,
            "chassis": chassis,
            "notice": "Materialized from an auditable external catalog. Human review required; not a wet-lab readiness claim.",
            "parts": [
                {
                    "id": item["resource_id"],
                    "type": item["part_type"],
                    "name": item["name"],
                    "description": item["description_en"],
                    "description_zh": item["description_zh"],
                    "sequence": item["sequence"],
                    "sequence_kind": item["sequence_kind"],
                    "sequence_sha256": item["sequence_sha256"],
                    "source": item["source"],
                    "license": item["license"],
                    "resource_id": item["resource_id"],
                    "review_status": item["review_status"],
                    "safety_status": item["safety_status"],
                    "safety_flags": item["safety_flags"],
                    "design_eligibility": bool(item["design_eligibility"]),
                    "evidence_refs": item["evidence_refs"],
                }
                for item in selected
            ],
        }
        _safe_write_validated_parts(
            target,
            payload,
            before_publish=lambda: self._verify_materialization_snapshot(
                snapshot_id,
                require_active=require_active,
                initial=False,
                verify_contents=True,
            ),
        )
        return {"ok": True, "snapshot_id": snapshot_id, "selection_digest": digest, "parts_path": str(target.relative_to(paths.workspace)).replace("\\", "/"), "part_count": len(selected)}

    def _verify_materialization_snapshot(
        self,
        snapshot_id: str,
        *,
        require_active: bool,
        initial: bool,
        verify_contents: bool,
    ) -> None:
        if require_active and self._active_id() != snapshot_id:
            code = "MATERIALS_SNAPSHOT_NOT_ACTIVE" if initial else "ACTIVE_POINTER_CHANGED"
            raise MaterialsError(code, "The selected materials snapshot is no longer active; no materialized selection was published.")
        manifest = self.manifest(snapshot_id)
        if verify_contents:
            self._verify_snapshot(snapshot_id, manifest)
        if require_active and self._active_id() != snapshot_id:
            raise MaterialsError("ACTIVE_POINTER_CHANGED", "The active materials snapshot changed during materialization; no materialized selection was published.")

    def materialize_proteins(
        self,
        resource_ids: list[str],
        *,
        design_id: str | None = None,
        output: str | Path | None = None,
        snapshot_id: str | None = None,
        auto_initialize: bool = True,
        require_active: bool = False,
    ) -> dict[str, Any]:
        """Materialize eligible proteins with a self-contained catalogue receipt."""

        if not resource_ids or len(resource_ids) > 256:
            raise MaterialsError("INVALID_SELECTION", "Select between 1 and 256 protein resources.")
        bind_to_active = require_active or snapshot_id is None
        resolved_snapshot = snapshot_id or self._active_id()
        if not resolved_snapshot:
            if not auto_initialize:
                raise MaterialsError("NO_ACTIVE_SNAPSHOT", "No materials snapshot is active.")
            self.initialize_seed()
            resolved_snapshot = self._active_id()
        if not resolved_snapshot:
            raise MaterialsError("NO_ACTIVE_SNAPSHOT", "No materials snapshot is active.")

        if bind_to_active:
            with _exclusive_materials_lock(self.root / ".active.lock"):
                return self._materialize_proteins_verified(
                    resource_ids,
                    design_id=design_id,
                    output=output,
                    snapshot_id=resolved_snapshot,
                    require_active=True,
                )
        return self._materialize_proteins_verified(
            resource_ids,
            design_id=design_id,
            output=output,
            snapshot_id=resolved_snapshot,
            require_active=False,
        )

    def _materialize_proteins_verified(
        self,
        resource_ids: list[str],
        *,
        design_id: str | None,
        output: str | Path | None,
        snapshot_id: str,
        require_active: bool,
    ) -> dict[str, Any]:
        self._verify_materialization_snapshot(snapshot_id, require_active=require_active, initial=True, verify_contents=True)
        manifest = self.manifest(snapshot_id)
        attestations, audit_summary = self._snapshot_promotion_attestations(snapshot_id, manifest)
        selected: list[dict[str, Any]] = []
        seen: set[str] = set()
        for resource_id in resource_ids:
            resource = self.get(resource_id, include_sequence=True, snapshot_id=snapshot_id, auto_initialize=False)["resource"]
            canonical_id = resource["resource_id"].casefold()
            if canonical_id in seen:
                raise MaterialsError("DUPLICATE_RESOURCE_ID", f"Duplicate protein resource ID: {resource_id}")
            seen.add(canonical_id)
            if resource["kind"] != "protein_sequence" or resource["sequence_kind"] != "PROTEIN":
                raise MaterialsError("NOT_COMPILABLE_PROTEIN", f"Resource is not a supported protein sequence: {resource_id}")
            if not resource["design_eligibility"] or resource["review_status"] != "DESIGN_ELIGIBLE":
                raise MaterialsError("PROTEIN_NOT_ELIGIBLE", f"Resource is not explicitly design-eligible: {resource_id}")
            if resource["safety_status"] != "NO_FLAG" or resource.get("safety_flags"):
                raise MaterialsError("PROTEIN_NOT_ELIGIBLE", f"Resource does not pass the protein safety gate: {resource_id}")
            if resource["license"].get("redistribution_status") != "REDISTRIBUTABLE":
                raise MaterialsError("PROTEIN_NOT_ELIGIBLE", f"Resource does not pass the protein rights/safety gate: {resource_id}")
            selected.append(resource)
        selected.sort(key=lambda item: (item["resource_id"].casefold(), item["resource_id"]))
        selected_records = [
            protein_selection_record(
                {
                    "id": item["resource_id"],
                    "resource_id": item["resource_id"],
                    "name": item["name"],
                    "sequence": item["sequence"],
                    "sequence_kind": item["sequence_kind"],
                    "sequence_sha256": item["sequence_sha256"],
                    "description": item["description_en"],
                    "description_zh": item["description_zh"],
                    "source": item["source"],
                    "license": item["license"],
                    "review_status": item["review_status"],
                    "safety_status": item["safety_status"],
                    "safety_flags": item["safety_flags"],
                    "design_eligibility": bool(item["design_eligibility"]),
                    "evidence_refs": item["evidence_refs"],
                    "organism": item["organism"],
                    "role_terms": item["role_terms"],
                    "metadata": item["metadata"],
                }
            )
            for item in selected
        ]
        clean_design_id = _clean_text(design_id, field="design_id", limit=256) if design_id is not None else ""
        if not clean_design_id:
            identity_digest = canonical_json_sha256(
                {
                    "schema_version": PROTEIN_SELECTION_SCHEMA_VERSION,
                    "snapshot_id": snapshot_id,
                    "proteins": selected_records,
                }
            )
            clean_design_id = f"protein-selection-{identity_digest[:16]}"
        payload = {
            "schema_version": PROTEIN_SELECTION_SCHEMA_VERSION,
            "snapshot_id": snapshot_id,
            "design_id": clean_design_id,
            "chassis": "protein_sequence",
            "proteins": selected_records,
        }
        digest = protein_selection_digest(payload)
        payload["selection_id"] = f"protein-selection:{digest}"
        payload["selection_digest"] = digest
        snapshot_binding = {
            "schema_version": manifest.get("schema_version"),
            "snapshot_id": manifest.get("snapshot_id"),
            "created_at": manifest.get("created_at"),
            "record_count": manifest.get("record_count"),
            "manifest_sha256": _sha256_file(self._snapshot_dir(snapshot_id) / "manifest.json"),
            "catalog_sha256": str(manifest.get("catalog", {}).get("sha256") or "").lower(),
            "license_catalog_sha256": str(manifest.get("license_catalog", {}).get("sha256") or "").lower(),
            "promotion_audit": audit_summary,
        }
        record_bindings: list[dict[str, Any]] = []
        for record in selected_records:
            resource_id = str(record["resource_id"])
            attestation = attestations.get(resource_id)
            if attestation is None and audit_summary.get("attestation_resolution") == "catalog-issued-normalized-record-binding":
                attestation = {
                    "policy_version": PROMOTION_POLICY_VERSION,
                    "resource_id": resource_id,
                    "record_sha256": protein_selection_record_sha256(record),
                    "decision": "PASS",
                    "rounds": [
                        {
                            "round_id": round_id,
                            "status": "PASS",
                            "reason_codes": ["PUBLIC_BUNDLE_MANIFEST_AUDIT_ROOT_BOUND"],
                        }
                        for round_id in PROMOTION_ROUND_IDS
                    ],
                    "attestation_scope": "normalized-catalog-selection-record",
                    "issued_by": CATALOG_ATTESTATION_ISSUER,
                    "source_audit_sha256": audit_summary["sha256"],
                    "signature_status": CATALOG_SIGNATURE_STATUS,
                }
            problem = promotion_attestation_structure_error(attestation, resource_id)
            if problem:
                raise MaterialsError("PROMOTION_ATTESTATION_MISSING", problem)
            assert isinstance(attestation, dict)
            record_bindings.append(
                {
                    "resource_id": resource_id,
                    "selection_record_sha256": protein_selection_record_sha256(record),
                    "promotion_attestation": attestation,
                    "promotion_attestation_sha256": canonical_json_sha256(attestation),
                    "promotion_audit_sha256": audit_summary["sha256"],
                }
            )
        catalog_attestation = {
            "schema_version": CATALOG_SELECTION_ATTESTATION_SCHEMA_VERSION,
            "issuer": CATALOG_ATTESTATION_ISSUER,
            "attestation_kind": CATALOG_ATTESTATION_KIND,
            "signature_status": CATALOG_SIGNATURE_STATUS,
            "cryptographic_signature": False,
            "authenticity": "NOT_ESTABLISHED",
            "trust_statement": "Content-addressed catalogue receipt only; no cryptographic author identity or external trust anchor is established.",
            "selection_digest": digest,
            "snapshot_manifest": snapshot_binding,
            "records": record_bindings,
        }
        catalog_attestation["binding_sha256"] = catalog_selection_binding_sha256(catalog_attestation)
        payload["catalog_attestation"] = catalog_attestation
        payload["notice"] = "Materialized from a manifest-bound catalogue audit. Protein compilation is software-only; human scientific review remains required. The catalogue receipt is content-addressed but UNSIGNED."
        paths = WorkspacePaths.create(self.workspace)
        target = paths.build_file(output or f"build/materials/selections/{digest}/proteins.json", extensions={".json"})
        self._verify_materialization_snapshot(snapshot_id, require_active=require_active, initial=False, verify_contents=True)
        _safe_write(target, (_json(payload) + "\n").encode("utf-8"))
        return {
            "ok": True,
            "snapshot_id": snapshot_id,
            "selection_digest": digest,
            "proteins_path": str(target.relative_to(paths.workspace)).replace("\\", "/"),
            "protein_count": len(selected),
        }

    def render_template(self, template_id: str, bindings: dict[str, str], *, chassis: str, output: str | Path | None = None, snapshot_id: str | None = None) -> dict[str, Any]:
        template = self.get(template_id, snapshot_id=snapshot_id)["resource"]
        if template["kind"] != "design_template":
            raise MaterialsError("NOT_A_TEMPLATE", f"Resource is not a design template: {template_id}")
        chassis = _clean_text(chassis, field="chassis", limit=256)
        if not chassis:
            raise MaterialsError("MISSING_CHASSIS", "A template draft must declare an explicit software chassis.")
        slots = template.get("metadata", {}).get("slots", [])
        if not isinstance(slots, list) or not slots:
            raise MaterialsError("INVALID_TEMPLATE", f"Template has no slots: {template_id}")
        if set(bindings) != {f"slot{i + 1}" for i in range(len(slots))}:
            raise MaterialsError("TEMPLATE_BINDINGS_INVALID", "Bindings must provide slot1..slotN for every template slot.")
        bindings = {key: _validated_resource_id(value) for key, value in bindings.items()}
        lines = [f"design materialized_template chassis {chassis}", "", "construct materialized_module:"]
        for index, slot_type in enumerate(slots, start=1):
            resource_id = bindings[f"slot{index}"]
            lines.append(f"  {slot_type} {resource_id}")
        lines.append("")
        paths = WorkspacePaths.create(self.workspace)
        digest = _sha256_bytes(_json({"template": template_id, "bindings": bindings}).encode("utf-8"))[:16]
        target = paths.build_file(output or f"build/materials/templates/{digest}.proto", extensions={".proto"})
        _safe_write(target, ("\n".join(lines) + "\n").encode("utf-8"))
        return {"ok": True, "template_id": template_id, "output": str(target.relative_to(paths.workspace)).replace("\\", "/"), "bindings": bindings, "review_status": "human_review_required"}

    def activate(
        self,
        snapshot_id: str,
        *,
        operator: str | None = None,
        approval_reference: str | None = None,
    ) -> dict[str, Any]:
        return self._switch_active(
            snapshot_id,
            action="activate",
            operator=operator,
            approval_reference=approval_reference,
        )

    def rollback(
        self,
        snapshot_id: str,
        *,
        operator: str | None = None,
        approval_reference: str | None = None,
    ) -> dict[str, Any]:
        return self._switch_active(
            snapshot_id,
            action="rollback",
            operator=operator,
            approval_reference=approval_reference,
        )

    def _switch_active(
        self,
        snapshot_id: str,
        *,
        action: str,
        operator: str | None,
        approval_reference: str | None,
    ) -> dict[str, Any]:
        with _exclusive_materials_lock(self.root / ".active.lock"):
            return self._switch_active_locked(
                snapshot_id,
                action=action,
                operator=operator,
                approval_reference=approval_reference,
            )

    def _switch_active_locked(
        self,
        snapshot_id: str,
        *,
        action: str,
        operator: str | None,
        approval_reference: str | None,
    ) -> dict[str, Any]:
        snapshot_id = _clean_text(snapshot_id, field="snapshot_id", limit=256)
        manifest = self.manifest(snapshot_id)
        policy = _activation_policy(manifest)
        if policy == "DENY":
            raise MaterialsError("SNAPSHOT_NOT_ACTIVATABLE", "Quarantine-only public bundles cannot be activated as normal materials snapshots.")
        operator_text, reference_text = _activation_evidence(
            operator,
            approval_reference,
            required=policy == "EXPLICIT_HUMAN_ONLY",
        )
        self._verify_snapshot(snapshot_id, manifest)
        pointer = {
            "schema_version": MATERIALS_SCHEMA_VERSION,
            "active_snapshot": snapshot_id,
            "action": action,
            "operator": operator_text,
            "operator_identity_assurance": "SELF_DECLARED_UNVERIFIED" if operator_text else "NOT_REQUIRED_BY_SNAPSHOT_POLICY",
            "approval_reference": reference_text,
            "manifest_sha256": _sha256_file(self._snapshot_dir(snapshot_id) / "manifest.json"),
            "activated_at": _now(),
        }
        _safe_write(self.active_pointer, (_json(pointer) + "\n").encode("utf-8"))
        return {"ok": True, **pointer}

    def diff(self, left: str, right: str) -> dict[str, Any]:
        left_rows = self._all_identity(left)
        right_rows = self._all_identity(right)
        added = sorted(set(right_rows) - set(left_rows))
        removed = sorted(set(left_rows) - set(right_rows))
        changed = sorted(key for key in set(left_rows) & set(right_rows) if left_rows[key] != right_rows[key])
        return {"ok": True, "left": left, "right": right, "added_count": len(added), "removed_count": len(removed), "changed_count": len(changed), "added": added[:1000], "removed": removed[:1000], "changed": changed[:1000]}

    def review_overlay(
        self,
        resource_id: str,
        *,
        decision: str,
        description_en: str | None = None,
        description_zh: str | None = None,
        reviewer: str = "human",
        snapshot_id: str | None = None,
        include_quarantine: bool = False,
    ) -> dict[str, Any]:
        """Save a versioned human-review overlay without mutating source rows.

        Overlays are deliberately append-only JSON objects.  They can record a
        description decision or corrected bilingual wording, but never change
        safety status, license rights, sequence objects, or design eligibility.
        A hard-flagged record can therefore be reviewed for audit purposes but
        cannot be promoted by this API.
        """

        resource_id = _validated_resource_id(resource_id)
        decision = _clean_text(decision, field="decision", limit=32).lower()
        if decision not in {"accept", "reject", "hold"}:
            raise MaterialsError("INVALID_REVIEW_DECISION", "Review decision must be accept, reject, or hold.")
        reviewer = _clean_text(reviewer, field="reviewer", limit=256) or "human"
        if description_en is None and description_zh is None:
            raise MaterialsError("MISSING_REVIEW_TEXT", "A review overlay must include description_en or description_zh.")
        clean_en = _clean_text(description_en, field="description_en") if description_en is not None else None
        clean_zh = _clean_text(description_zh, field="description_zh") if description_zh is not None else None
        snapshot_id = snapshot_id or self._active_id()
        if not snapshot_id:
            raise MaterialsError("NO_ACTIVE_SNAPSHOT", "Review overlays require an active snapshot.")
        try:
            base = self.get(resource_id, snapshot_id=snapshot_id, include_quarantine=include_quarantine, auto_initialize=False)["resource"]
        except MaterialsError as exc:
            if include_quarantine:
                raise
            # The normal catalog intentionally cannot reveal quarantine rows;
            # keep the same not-found boundary for callers without admin mode.
            raise exc
        created_at = _now()
        canonical = _json({"resource_id": resource_id, "snapshot_id": snapshot_id, "decision": decision, "description_en": clean_en, "description_zh": clean_zh, "reviewer": reviewer, "created_at": created_at}).encode("utf-8")
        digest = _sha256_bytes(canonical)
        payload = {
            "schema_version": "proto-agent.materials-overlay.v1",
            "overlay_id": f"overlay:{digest[:24]}",
            "created_at": created_at,
            "reviewer": reviewer,
            "snapshot_id": snapshot_id,
            "base_manifest_sha256": _sha256_file(self._snapshot_dir(snapshot_id) / "manifest.json"),
            "resource_id": resource_id,
            "decision": decision,
            "description_en": clean_en,
            "description_zh": clean_zh,
            "base_review_status": base["review_status"],
            "base_safety_status": base["safety_status"],
            "base_design_eligibility": bool(base["design_eligibility"]),
            "eligibility_change": "never; source rows and safety gates remain immutable",
            "overlay_sha256": digest,
        }
        target = self.overlays / f"{int(time.time())}-{digest[:24]}.json"
        _safe_write(target, (_json(payload) + "\n").encode("utf-8"))
        return {"ok": True, **payload, "overlay_path": str(target)}

    def import_file(self, path: str | Path, *, activate: bool = False) -> dict[str, Any]:
        source_path = Path(path).absolute()
        if source_path.is_symlink() or not source_path.is_file():
            raise MaterialsError("INVALID_IMPORT", "Import source must be a regular file.")
        try:
            source_size = source_path.stat().st_size
        except OSError as exc:
            raise MaterialsError("INVALID_IMPORT", "Unable to inspect import source.") from exc
        if source_size > 64 * 1024 * 1024:
            raise MaterialsError("FILE_TOO_LARGE", "Sequence imports are limited to 64 MiB.")
        if source_path.suffix.lower() == ".json":
            payload = _safe_read_json(source_path)
            raw_records = payload.get("records", payload.get("parts", []))
            if not isinstance(raw_records, list):
                raise MaterialsError("INVALID_IMPORT", "JSON import must contain records or parts array.")
        elif source_path.suffix.lower() in {".fasta", ".fa", ".fas"}:
            raw_records = _parse_fasta(source_path)
        elif source_path.suffix.lower() in {".gb", ".gbk", ".genbank"}:
            raw_records = _parse_genbank(source_path)
        elif source_path.suffix.lower() in {".ttl", ".rdf"}:
            raw_records = _parse_sbol(source_path)
        else:
            raise MaterialsError("UNSUPPORTED_IMPORT", "Supported imports are JSON, FASTA, SBOL Turtle, and GenBank.")
        records = [normalize_record(item) for item in raw_records]
        snapshot_id = f"import-{int(time.time())}-{_sha256_file(source_path)[:12]}"
        manifest = self._create_snapshot(records, snapshot_id, sources=[{"provider": "local-import", "record_id": str(source_path), "release": "local"}], label=f"Imported {source_path.name}")
        if activate:
            self.activate(snapshot_id)
        return manifest

    def import_reviewed_file(
        self,
        path: str | Path,
        *,
        audit_path: str | Path,
        source_lock_path: str | Path | None = None,
        activate: bool = False,
    ) -> dict[str, Any]:
        """Import a repository-locked, three-round reviewed materials seed.

        This is the only file-import path that may preserve DESIGN_ELIGIBLE.
        The ordinary ``import_file`` path deliberately supplies no attestation
        and therefore downgrades self-asserted eligibility to REVIEW_REQUIRED.
        """

        source_path = Path(path).resolve()
        report_path = Path(audit_path).resolve()
        lock_path = Path(source_lock_path).resolve() if source_lock_path is not None else self.workspace / "materials" / "bundles" / "source-lock.json"
        payload = _safe_read_json(source_path)
        raw_records = payload.get("records", payload.get("parts", []))
        if not isinstance(raw_records, list):
            raise MaterialsError("INVALID_IMPORT", "Reviewed JSON import must contain records or parts array.")
        attestations = load_locked_promotion_attestations(self.workspace, source_path, report_path, lock_path)
        selected_ids = {
            str(record.get("resource_id", record.get("id")) or "")
            for record in raw_records
            if isinstance(record, dict) and str(record.get("review_status") or "").upper() == "DESIGN_ELIGIBLE"
        }
        if not selected_ids or any(resource_id not in attestations for resource_id in selected_ids):
            raise MaterialsError("PROMOTION_AUDIT_INVALID", "Every reviewed design-eligible record requires a locked audit decision.")
        snapshot_id = f"reviewed-{int(time.time())}-{_sha256_file(source_path)[:12]}"
        providers = sorted({
            str(record.get("source", {}).get("provider") or "")
            for record in raw_records
            if isinstance(record, dict) and isinstance(record.get("source"), dict)
        })
        manifest = self._create_snapshot(
            raw_records,
            snapshot_id,
            sources=[{"provider": provider, "release": "locked-reviewed-seed"} for provider in providers if provider],
            label=f"Reviewed {source_path.name}",
            manifest_annotations={
                "promotion_audit": {
                    "schema_version": PROMOTION_AUDIT_SCHEMA_VERSION,
                    "policy_version": PROMOTION_POLICY_VERSION,
                    "path": report_path.relative_to(self.workspace).as_posix(),
                    "sha256": _sha256_file(report_path),
                    "activation_policy": "EXPLICIT_HUMAN_ONLY",
                }
            },
            promotion_attestations=attestations,
        )
        if activate:
            self.activate(snapshot_id)
        return manifest

    def sync_uniprot(self, *, max_records: int = 100_000, page_size: int = 500, activate: bool = False) -> dict[str, Any]:
        if max_records < 1 or max_records > 2_000_000:
            raise MaterialsError("INVALID_LIMIT", "max_records must be between 1 and 2,000,000.")
        page_size = max(1, min(page_size, 500))
        records: list[dict[str, Any]] = []
        release_info: dict[str, Any] = {}
        release = "live"
        for row in _iter_uniprot(page_size=page_size, max_records=max_records, release_info=release_info):
            release = release_info.get("release", release)
            accession = row.get("Entry", "").strip()
            if not accession:
                continue
            sequence = row.get("Sequence", "").strip().replace(" ", "")
            if not sequence:
                continue
            organism = row.get("Organism", "").strip()
            tax_id = row.get("Organism (ID)", "").strip()
            description = row.get("Protein names", "").strip() or row.get("Entry Name", "").strip()
            record_id = f"uniprot:{accession}"
            records.append(normalize_record({
                "resource_id": record_id,
                "kind": "protein_sequence",
                "name": row.get("Entry Name", accession).strip() or accession,
                "description_en": description,
                "organism": {"tax_id": int(tax_id) if tax_id.isdigit() else None, "name": organism},
                "sequence": sequence,
                "sequence_kind": "PROTEIN",
                "source": {
                    "provider": "UniProtKB/Swiss-Prot",
                    "record_id": accession,
                    "revision": "entry",
                    "release": release,
                    "url": f"https://www.uniprot.org/uniprotkb/{accession}/entry",
                    "retrieved_at": _now(),
                    # Raw/page response provenance is distinct from the
                    # sequence object digest used by the protein compiler.
                    "content_sha256": str(row.get("_response_content_sha256") or _sha256_bytes(sequence.encode("ascii"))),
                    "sequence_sha256": _sha256_bytes(sequence.encode("ascii")),
                },
                "license": {"id": "CC-BY-4.0", "url": "https://creativecommons.org/licenses/by/4.0/", "attribution": "UniProt Consortium", "rights_notes": "UniProt disclaims third-party patent or other rights.", "redistribution_status": "REDISTRIBUTABLE"},
                "review_status": "REFERENCE_ONLY",
                "design_eligibility": False,
                "evidence_refs": [],
                "metadata": {"entry_length": int(row.get("Length", "0") or 0)},
            }))
            if max_records and len(records) >= max_records:
                break
        if not records:
            raise MaterialsError("SOURCE_EMPTY", "UniProt returned no records.")
        snapshot_id = f"uniprot-{int(time.time())}-{_sha256_bytes(_json([item['resource_id'] for item in records]).encode('utf-8'))[:12]}"
        source_entry = {"provider": "UniProtKB/Swiss-Prot", "release": release, "record_count": len(records)}
        if release_info.get("release_date"):
            source_entry["release_date"] = release_info["release_date"]
        response_hashes = release_info.get("response_hashes")
        if isinstance(response_hashes, list) and response_hashes:
            source_entry["response_sha256"] = _sha256_bytes("".join(str(item) for item in response_hashes).encode("ascii"))
            source_entry["response_page_count"] = len(response_hashes)
        manifest = self._create_snapshot(records + [normalize_record(item) for item in builtin_records()], snapshot_id, sources=[source_entry], label="UniProt reviewed sequence snapshot")
        if activate:
            self.activate(snapshot_id)
        return manifest

    def sync_igem(self, *, max_records: int = 1000, page_size: int = 100, activate: bool = False) -> dict[str, Any]:
        """Stage published iGEM Registry records while honoring per-record licenses."""

        max_records = _bounded_source_limit(max_records, maximum=100_000)
        page_size = max(1, min(int(page_size), 100))
        records: list[dict[str, Any]] = []
        sync_errors: list[dict[str, str]] = []
        response_hashes: list[str] = []
        page = 1
        # A rate-limited or otherwise degraded listing endpoint can keep
        # returning non-empty pages forever while every detail request fails.
        # Bound the scan and stop after two pages with no usable record so a
        # staging run is finite and auditable instead of hanging indefinitely.
        max_pages = max(1, min(10_000, (max_records + page_size - 1) // page_size * 4))
        empty_pages = 0
        while len(records) < max_records:
            if page > max_pages:
                sync_errors.append({"record_id": "", "code": "SOURCE_PAGE_LIMIT"})
                break
            url = f"https://api.registry.igem.org/v1/parts?page={page}&pageSize={page_size}"
            payload, _ = _http_get(url, headers={"Accept": "application/json"})
            response_hashes.append(_sha256_bytes(payload))
            try:
                listing = json.loads(payload.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise MaterialsError("SOURCE_INVALID_JSON", "iGEM returned invalid JSON.") from exc
            rows = listing.get("data", []) if isinstance(listing, dict) else []
            if not isinstance(rows, list) or not rows:
                break
            before_page = len(records)
            for summary in rows:
                if len(records) >= max_records or not isinstance(summary, dict) or str(summary.get("status", "")).lower() != "published":
                    continue
                uuid = _clean_text(summary.get("uuid"), field="iGEM.uuid", limit=128)
                if not uuid:
                    continue
                detail_url = f"https://api.registry.igem.org/v1/parts/{urllib.parse.quote(uuid, safe='')}"
                try:
                    detail_bytes, _ = _http_get(detail_url, headers={"Accept": "application/json"})
                except MaterialsError as exc:
                    # A single upstream record must not discard an otherwise
                    # auditable staging run. Keep a bounded error trail in the
                    # source manifest and continue with the next published ID.
                    sync_errors.append({"record_id": uuid, "code": exc.code})
                    continue
                response_hashes.append(_sha256_bytes(detail_bytes))
                try:
                    detail = json.loads(detail_bytes.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    sync_errors.append({"record_id": uuid, "code": "SOURCE_INVALID_JSON"})
                    continue
                if not isinstance(detail, dict):
                    sync_errors.append({"record_id": uuid, "code": "SOURCE_INVALID_RECORD"})
                    continue
                license_info = _igem_license(detail.get("licenseUUID"))
                sequence = str(detail.get("sequence") or "").upper().replace(" ", "").replace("\n", "")
                role = detail.get("role") if isinstance(detail.get("role"), dict) else {}
                part_type = {"SO:0000167": "promoter", "SO:0000139": "rbs", "SO:0000316": "cds", "SO:0000141": "terminator"}.get(str(role.get("accession", "")), "")
                designed_for = detail.get("chassis", {}).get("designedFor", []) if isinstance(detail.get("chassis"), dict) else []
                chassis = [str(item.get("scientificName")) for item in designed_for if isinstance(item, dict) and item.get("scientificName")]
                description = str(detail.get("description") or detail.get("title") or summary.get("name") or uuid)
                try:
                    records.append(normalize_record({
                        "resource_id": f"igem:{uuid}",
                        "kind": "genetic_part",
                        "name": str(detail.get("name") or summary.get("name") or uuid),
                        "description_en": description,
                        "aliases": [str(detail.get("title"))] if detail.get("title") else [],
                        "chassis": chassis,
                        "role_terms": [str(role.get("label"))] if role.get("label") else [],
                        "part_type": part_type,
                        "sequence": sequence,
                        "sequence_kind": "DNA" if sequence else "",
                        "source": {"provider": "iGEM Registry", "record_id": uuid, "revision": str(detail.get("audit", {}).get("updated", "")), "release": str(detail.get("audit", {}).get("updated", "live")), "url": detail_url, "retrieved_at": _now(), "content_sha256": _sha256_bytes(detail_bytes)},
                        "license": license_info,
                        "review_status": "REVIEW_REQUIRED",
                        "design_eligibility": False,
                        "metadata": {"role_accession": role.get("accession", ""), "registry_status": detail.get("status", "")},
                    }))
                except MaterialsError as exc:
                    sync_errors.append({"record_id": uuid, "code": exc.code})
            empty_pages = empty_pages + 1 if len(records) == before_page else 0
            if empty_pages >= 2:
                sync_errors.append({"record_id": "", "code": "SOURCE_NO_PROGRESS"})
                break
            page += 1
            if len(rows) < page_size:
                break
        if not records:
            raise MaterialsError("SOURCE_EMPTY", "iGEM returned no published records with usable metadata.")
        snapshot_id = f"igem-{int(time.time())}-{_sha256_bytes(_json([item['resource_id'] for item in records]).encode('utf-8'))[:12]}"
        source_entry: dict[str, Any] = {"provider": "iGEM Registry", "release": "live", "record_count": len(records), "policy": "per-record license"}
        if response_hashes:
            source_entry["response_sha256"] = _sha256_bytes("".join(response_hashes).encode("ascii"))
            source_entry["response_page_count"] = len(response_hashes)
        if sync_errors:
            source_entry["skipped_records"] = sync_errors[:100]
            source_entry["skipped_count"] = len(sync_errors)
        manifest = self._create_snapshot(records + [normalize_record(item) for item in builtin_records()], snapshot_id, sources=[source_entry], label="iGEM published materials snapshot")
        if activate:
            self.activate(snapshot_id)
        return manifest

    def sync_rhea(self, *, max_records: int = 1000, activate: bool = False) -> dict[str, Any]:
        max_records = _bounded_source_limit(max_records, maximum=100_000)
        params = urllib.parse.urlencode({"columns": "rhea-id,equation,chebi-id,ec,pubmed", "format": "tsv", "limit": str(max_records)})
        url = f"https://www.rhea-db.org/rhea/?{params}"
        payload, _ = _http_get(url, headers={"Accept": "text/tab-separated-values"})
        response_sha256 = _sha256_bytes(payload)
        reader = csv.DictReader(io.StringIO(payload.decode("utf-8", "replace")), delimiter="\t")
        records: list[dict[str, Any]] = []
        for row in reader:
            rid = str(row.get("Reaction identifier") or row.get("rhea-id") or "").strip()
            if not rid:
                continue
            raw = _json({str(key): str(value or "") for key, value in row.items()}).encode("utf-8")
            records.append(normalize_record({
                "resource_id": rid if rid.startswith("RHEA:") else f"RHEA:{rid}",
                "kind": "biochemical_reaction",
                "name": rid,
                "description_en": str(row.get("Equation") or row.get("equation") or "Rhea curated reaction"),
                "role_terms": ["reaction", "Rhea"],
                "source": {"provider": "Rhea", "record_id": rid, "revision": "release", "release": "live", "url": f"https://www.rhea-db.org/rhea/{rid.split(':')[-1]}", "retrieved_at": _now(), "content_sha256": _sha256_bytes(raw)},
                "license": {"id": "CC-BY-4.0", "url": "https://creativecommons.org/licenses/by/4.0/", "attribution": "Rhea", "rights_notes": "Rhea database content is CC BY 4.0.", "redistribution_status": "REDISTRIBUTABLE"},
                "review_status": "REFERENCE_ONLY",
                "design_eligibility": False,
                "metadata": {"equation": row.get("Equation", ""), "chebi": row.get("ChEBI identifier", ""), "ec": row.get("EC number", ""), "pubmed": row.get("PubMed", "")},
            }))
        if not records:
            raise MaterialsError("SOURCE_EMPTY", "Rhea returned no reaction records.")
        snapshot_id = f"rhea-{int(time.time())}-{_sha256_bytes(_json([item['resource_id'] for item in records]).encode('utf-8'))[:12]}"
        manifest = self._create_snapshot(
            records + [normalize_record(item) for item in builtin_records()],
            snapshot_id,
            sources=[{
                "provider": "Rhea",
                "release": "live",
                "record_count": len(records),
                "response_sha256": response_sha256,
                "response_page_count": 1,
            }],
            label="Rhea reaction snapshot",
        )
        if activate:
            self.activate(snapshot_id)
        return manifest

    def sync_biomodels(self, *, max_records: int = 1000, activate: bool = False) -> dict[str, Any]:
        max_records = _bounded_source_limit(max_records, maximum=100_000)
        records: list[dict[str, Any]] = []
        response_hashes: list[str] = []
        page_size = 100  # BioModels caps a search response at 100 models.
        offset = 0
        while len(records) < max_records:
            requested = min(page_size, max_records - len(records))
            params = urllib.parse.urlencode({"query": "curated", "numResults": str(requested), "offset": str(offset), "format": "json"})
            url = f"https://www.ebi.ac.uk/biomodels/search?{params}"
            payload, _ = _http_get(url, headers={"Accept": "application/json"})
            response_hashes.append(_sha256_bytes(payload))
            try:
                body = json.loads(payload.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise MaterialsError("SOURCE_INVALID_JSON", "BioModels returned invalid JSON.") from exc
            rows = body.get("models", []) if isinstance(body, dict) else []
            if not isinstance(rows, list) or not rows:
                break
            before_page = len(records)
            for item in rows[:requested]:
                if len(records) >= max_records or not isinstance(item, dict) or not item.get("id"):
                    continue
                model_id = str(item["id"])
                raw = _json(item).encode("utf-8")
                records.append(normalize_record({
                    "resource_id": f"biomodels:{model_id}",
                    "kind": "computational_model",
                    "name": str(item.get("name") or model_id),
                    "description_en": str(item.get("name") or "BioModels computational model"),
                    "source": {"provider": "BioModels", "record_id": model_id, "revision": str(item.get("lastModified") or ""), "release": "live", "url": str(item.get("url") or f"https://www.biomodels.org/{model_id}"), "retrieved_at": _now(), "content_sha256": _sha256_bytes(raw)},
                    "license": {"id": "CC0-1.0", "url": "https://creativecommons.org/publicdomain/zero/1.0/", "attribution": "BioModels contributors", "rights_notes": "BioModels model pages state CC0; check linked third-party assets.", "redistribution_status": "REDISTRIBUTABLE"},
                    "review_status": "REFERENCE_ONLY",
                    "design_eligibility": False,
                    "metadata": {"format": item.get("format", ""), "submitter": item.get("submitter", "")},
                }))
            if len(records) == before_page or len(rows) < requested:
                break
            offset += len(rows)
        if not records:
            raise MaterialsError("SOURCE_EMPTY", "BioModels returned no curated model records.")
        snapshot_id = f"biomodels-{int(time.time())}-{_sha256_bytes(_json([item['resource_id'] for item in records]).encode('utf-8'))[:12]}"
        source_entry: dict[str, Any] = {"provider": "BioModels", "release": "live", "record_count": len(records)}
        if response_hashes:
            source_entry["response_sha256"] = _sha256_bytes("".join(response_hashes).encode("ascii"))
            source_entry["response_page_count"] = len(response_hashes)
        manifest = self._create_snapshot(records + [normalize_record(item) for item in builtin_records()], snapshot_id, sources=[source_entry], label="BioModels computational model snapshot")
        if activate:
            self.activate(snapshot_id)
        return manifest

    def _create_snapshot(
        self,
        records: Iterable[dict[str, Any]],
        snapshot_id: str,
        *,
        sources: list[dict[str, Any]],
        label: str,
        created_at: str | None = None,
        manifest_annotations: dict[str, Any] | None = None,
        vacuum_catalogs: bool = False,
        promotion_attestations: dict[str, dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", snapshot_id):
            raise MaterialsError("INVALID_SNAPSHOT_ID", "Snapshot IDs must be path-safe.")
        final_dir = self._snapshot_dir(snapshot_id)
        if final_dir.exists():
            raise MaterialsError("SNAPSHOT_EXISTS", f"Snapshot already exists: {snapshot_id}")
        snapshot_created_at = _clean_text(created_at or _now(), field="created_at", limit=64)
        if not snapshot_created_at:
            raise MaterialsError("INVALID_CREATED_AT", "Snapshot created_at must not be empty.")
        stage = self.staging / f"{snapshot_id}-{uuid4().hex}"
        _ensure_directory(stage)
        all_records: list[dict[str, Any]] = []
        snapshot_attestations: list[dict[str, Any]] = []
        seen: set[str] = set()
        status_counts: dict[str, int] = {key: 0 for key in sorted(STATUS_VALUES)}
        source_counts: dict[str, int] = {}
        try:
            for raw in records:
                raw_id = str(raw.get("resource_id", raw.get("id")) or "") if isinstance(raw, dict) else ""
                attestation = (promotion_attestations or {}).get(raw_id)
                record = normalize_record(raw, promotion_attestation=attestation)
                supplied_hash = raw.get("sequence_sha256") if isinstance(raw, dict) else None
                if supplied_hash and record["sequence"] and str(supplied_hash).lower() != record["sequence_sha256"]:
                    raise MaterialsError("SEQUENCE_HASH_MISMATCH", f"Sequence hash does not match {record['resource_id']}.")
                canonical_id = record["resource_id"].casefold()
                if canonical_id in seen:
                    raise MaterialsError("DUPLICATE_RESOURCE_ID", f"Duplicate or normalization-collision resource ID: {record['resource_id']}")
                seen.add(canonical_id)
                all_records.append(record)
                if record["review_status"] == "DESIGN_ELIGIBLE":
                    if not promotion_attestation_valid(raw, attestation):
                        raise MaterialsError(
                            "PROMOTION_ATTESTATION_MISSING",
                            f"Design-eligible record has no valid promotion attestation: {record['resource_id']}",
                        )
                    assert isinstance(attestation, dict)
                    # JSON round-tripping detaches the immutable manifest
                    # evidence from caller-owned mutable objects.
                    snapshot_attestations.append(json.loads(_json(attestation)))
                status_counts[record["review_status"]] += 1
                source_counts[record["source"]["provider"]] = source_counts.get(record["source"]["provider"], 0) + 1
        except Exception:
            shutil.rmtree(stage, ignore_errors=True)
            raise
        main_records = [record for record in all_records if record["review_status"] != "QUARANTINED"]
        quarantine_records = [record for record in all_records if record["review_status"] == "QUARANTINED"]
        _ensure_directory(stage / "blobs")
        _ensure_directory(stage / "quarantine" / "blobs")
        license_catalog = stage / "licenses" / "catalog.json"
        _ensure_directory(license_catalog.parent)
        _safe_write(license_catalog, (_json({
            "schema_version": "proto-agent.materials-licenses.v1",
            "sources": sources,
            "record_license_policy": "Every record retains its own license, attribution, rights_notes, and redistribution_status.",
            "standard_references": {
                "UniProtKB": "https://www.uniprot.org/help/license/",
                "Rhea": "https://www.rhea-db.org/help/license-disclaimer",
                "BioModels": "https://www.ebi.ac.uk/biomodels/faq",
                "iGEM Registry": "https://api.registry.igem.org/docs",
                "NCBI": "https://www.ncbi.nlm.nih.gov/home/about/policies/",
                "Addgene": "https://www.addgene.org/terms-of-use/",
            },
        }) + "\n").encode("utf-8"))
        try:
            main_blob_count = self._write_catalog(stage / "catalog.sqlite", stage, stage / "blobs", main_records, vacuum=vacuum_catalogs)
            quarantine_blob_count = self._write_catalog(stage / "quarantine.sqlite", stage, stage / "quarantine" / "blobs", quarantine_records, vacuum=vacuum_catalogs)
        except Exception:
            shutil.rmtree(stage, ignore_errors=True)
            raise
        catalog_sha256 = _sha256_file(stage / "catalog.sqlite")
        quarantine_catalog_sha256 = _sha256_file(stage / "quarantine.sqlite")
        manifest = {
            "schema_version": MATERIALS_SCHEMA_VERSION,
            "snapshot_id": snapshot_id,
            "label": label,
            "created_at": snapshot_created_at,
            "record_count": len(all_records),
            "catalog_record_count": len(main_records),
            "quarantine_record_count": len(quarantine_records),
            "status_counts": status_counts,
            "source_counts": source_counts,
            "sources": sources,
            "catalog": {"path": "catalog.sqlite", "sha256": catalog_sha256, "size_bytes": (stage / "catalog.sqlite").stat().st_size},
            "quarantine_catalog": {"path": "quarantine.sqlite", "sha256": quarantine_catalog_sha256, "size_bytes": (stage / "quarantine.sqlite").stat().st_size},
            "blob_count": main_blob_count + quarantine_blob_count,
            "quarantine": {"database": "quarantine.sqlite", "object_root": "quarantine/blobs", "access": "admin-only; never exposed through model-facing MCP"},
            "license_catalog": {"path": "licenses/catalog.json", "sha256": _sha256_file(license_catalog)},
            "notice": "Metadata and sequences are source-derived and untrusted. Software checks do not establish wet-lab readiness.",
        }
        if snapshot_attestations:
            snapshot_attestations.sort(key=lambda item: (str(item.get("resource_id") or "").casefold(), str(item.get("resource_id") or "")))
            manifest["promotion_attestation_index"] = {
                "schema_version": CATALOG_PROMOTION_INDEX_SCHEMA_VERSION,
                "policy_version": PROMOTION_POLICY_VERSION,
                "attestation_count": len(snapshot_attestations),
                "attestations_sha256": canonical_json_sha256(snapshot_attestations),
                "attestations": snapshot_attestations,
                "signature_status": CATALOG_SIGNATURE_STATUS,
            }
        if manifest_annotations:
            collisions = sorted(set(manifest).intersection(manifest_annotations))
            if collisions:
                shutil.rmtree(stage, ignore_errors=True)
                raise MaterialsError("MANIFEST_ANNOTATION_COLLISION", f"Manifest annotations cannot replace core fields: {', '.join(collisions)}")
            manifest.update(manifest_annotations)
        _safe_write(stage / "manifest.json", (_json(manifest) + "\n").encode("utf-8"))
        license_lines = ["# Data source notices", "", f"Snapshot: `{snapshot_id}`", ""]
        for provider, count in sorted(source_counts.items()):
            license_lines.append(f"- {provider}: {count} records; see each record's license and source fields.")
        _safe_write(stage / "LICENSES.md", ("\n".join(license_lines) + "\n").encode("utf-8"))
        provenance = {
            "schema_version": "proto-agent.materials-provenance.v1",
            "snapshot_id": snapshot_id,
            "manifest_sha256": _sha256_file(stage / "manifest.json"),
            "catalog_sha256": catalog_sha256,
            "quarantine_catalog_sha256": quarantine_catalog_sha256,
            "sources": sources,
            "created_at": snapshot_created_at,
        }
        _safe_write(stage / "provenance.json", (_json(provenance) + "\n").encode("utf-8"))
        _ensure_directory(final_dir.parent)
        os.replace(stage, final_dir)
        return {**manifest, "manifest_sha256": _sha256_file(final_dir / "manifest.json"), "snapshot_path": str(final_dir)}

    @staticmethod
    def _write_catalog(database: Path, stage: Path, blob_root: Path, records: list[dict[str, Any]], *, vacuum: bool = False) -> int:
        """Write an immutable SQLite/FTS catalog and return the unique blob count."""

        conn = sqlite3.connect(database)
        conn.execute("PRAGMA journal_mode=DELETE")
        conn.execute("PRAGMA synchronous=FULL")
        conn.executescript(
            """
            CREATE TABLE resources (
              resource_id TEXT PRIMARY KEY,
              kind TEXT NOT NULL,
              name TEXT NOT NULL,
              aliases_json TEXT NOT NULL,
              description_en TEXT NOT NULL,
              description_zh TEXT NOT NULL,
              organism_json TEXT NOT NULL,
              organism_name TEXT NOT NULL,
              organism_tax_id TEXT NOT NULL,
              chassis_json TEXT NOT NULL,
              role_terms_json TEXT NOT NULL,
              part_type TEXT NOT NULL,
              sequence_kind TEXT NOT NULL,
              sequence_length INTEGER NOT NULL,
              sequence_sha256 TEXT NOT NULL,
              sequence_path TEXT NOT NULL,
              source_provider TEXT NOT NULL,
              source_json TEXT NOT NULL,
              license_id TEXT NOT NULL,
              license_json TEXT NOT NULL,
              evidence_refs_json TEXT NOT NULL,
              review_status TEXT NOT NULL,
              safety_status TEXT NOT NULL,
              safety_flags_json TEXT NOT NULL,
              design_eligibility INTEGER NOT NULL,
              metadata_json TEXT NOT NULL
            );
            CREATE INDEX resources_kind ON resources(kind);
            CREATE INDEX resources_status ON resources(review_status);
            CREATE INDEX resources_source ON resources(source_provider);
            CREATE VIRTUAL TABLE resources_fts USING fts5(resource_id UNINDEXED, text);
            """
        )
        blob_count = 0
        try:
            for record in records:
                sequence_path = ""
                if record["sequence"]:
                    digest = record["sequence_sha256"]
                    blob = blob_root / digest[:2] / f"{digest}.txt.gz"
                    if not blob.exists():
                        _ensure_directory(blob.parent)
                        # A zero gzip mtime keeps public snapshots reproducible
                        # without embedding the exporting machine's clock.
                        with blob.open("wb") as raw_handle:
                            with gzip.GzipFile(filename="", fileobj=raw_handle, mode="wb", compresslevel=6, mtime=0) as handle:
                                handle.write(record["sequence"].encode("ascii"))
                        blob_count += 1
                    sequence_path = str(blob.relative_to(stage)).replace("\\", "/")
                organism_name = str(record["organism"].get("name", ""))
                tax_id = record["organism"].get("tax_id")
                conn.execute(
                    "INSERT INTO resources VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        record["resource_id"], record["kind"], record["name"], _json(record["aliases"]), record["description_en"], record["description_zh"], _json(record["organism"]), organism_name, "" if tax_id is None else str(tax_id), _json(record["chassis"]), _json(record["role_terms"]), record["part_type"], record["sequence_kind"], record["sequence_length"], record["sequence_sha256"], sequence_path, record["source"]["provider"], _json(record["source"]), record["license"]["id"], _json(record["license"]), _json(record["evidence_refs"]), record["review_status"], record["safety_status"], _json(record["safety_flags"]), int(record["design_eligibility"]), _json(record["metadata"]),
                    ),
                )
                fts_text = " ".join([record["resource_id"], record["name"], *record["aliases"], record["description_en"], record["description_zh"], organism_name, *record["role_terms"], record["source"]["provider"], record["source"]["record_id"], *record["tags"]])
                conn.execute("INSERT INTO resources_fts(resource_id, text) VALUES (?, ?)", (record["resource_id"], fts_text))
            conn.commit()
            if vacuum:
                # Public snapshot exports must not retain deleted/free SQLite
                # pages that could contain data outside the current allowlist.
                conn.execute("VACUUM")
        finally:
            conn.close()
        return blob_count

    def _verify_snapshot(self, snapshot_id: str, manifest: dict[str, Any]) -> None:
        directory = self._snapshot_dir(snapshot_id)
        catalog = directory / "catalog.sqlite"
        expected = manifest.get("catalog", {}).get("sha256")
        if not catalog.is_file() or not isinstance(expected, str) or _sha256_file(catalog) != expected:
            raise MaterialsError("SNAPSHOT_INTEGRITY_FAILED", f"Snapshot catalog integrity failed: {snapshot_id}")
        quarantine_catalog = directory / "quarantine.sqlite"
        expected_quarantine = manifest.get("quarantine_catalog", {}).get("sha256")
        if quarantine_catalog.exists() and (not isinstance(expected_quarantine, str) or _sha256_file(quarantine_catalog) != expected_quarantine):
            raise MaterialsError("SNAPSHOT_INTEGRITY_FAILED", f"Snapshot quarantine catalog integrity failed: {snapshot_id}")
        if manifest.get("license_catalog"):
            license_path = directory / str(manifest.get("license_catalog", {}).get("path", "licenses/catalog.json"))
            expected_license = manifest.get("license_catalog", {}).get("sha256")
            if not license_path.is_file() or not isinstance(expected_license, str) or _sha256_file(license_path) != expected_license:
                raise MaterialsError("SNAPSHOT_INTEGRITY_FAILED", f"Snapshot license catalog integrity failed: {snapshot_id}")
        counts: list[int] = []
        for quarantine in (False, True):
            if quarantine and not quarantine_catalog.exists():
                continue
            conn = self._connect(snapshot_id, quarantine=quarantine)
            try:
                row = conn.execute("SELECT COUNT(*) FROM resources").fetchone()
                counts.append(int(row[0]) if row else -1)
                self._verify_catalog_objects(directory, conn, quarantine=quarantine)
            finally:
                conn.close()
        if sum(counts) != int(manifest.get("record_count", -1)):
            raise MaterialsError("SNAPSHOT_INTEGRITY_FAILED", f"Snapshot record count mismatch: {snapshot_id}")

    @staticmethod
    def _verify_catalog_objects(directory: Path, conn: sqlite3.Connection, *, quarantine: bool) -> None:
        """Verify every content-addressed gzip object referenced by a catalog.

        Activation is the trust boundary, so a catalog with a missing, linked,
        corrupt, or hash-mismatched sequence object is never activated.  The
        verifier streams decompression to avoid loading a large sequence into
        memory and applies the same hard size bound as import/sync.
        """

        rows = list(conn.execute("SELECT resource_id, sequence_sha256, sequence_path FROM resources WHERE sequence_sha256 != ''"))
        # Git does not preserve empty directories. A catalog with no referenced
        # sequence objects therefore needs no object root; any non-empty set of
        # references still requires the full physical-root safety checks below.
        if not rows:
            return
        expected_root = directory / (Path("quarantine") / "blobs" if quarantine else Path("blobs"))
        if expected_root.is_symlink() or not expected_root.is_dir():
            raise MaterialsError("SNAPSHOT_INTEGRITY_FAILED", "Snapshot sequence object root is missing or unsafe.")
        for row in rows:
            resource_id, digest, relative_path = str(row[0]), str(row[1]), str(row[2] or "")
            if not re.fullmatch(r"[a-f0-9]{64}", digest):
                raise MaterialsError("SNAPSHOT_INTEGRITY_FAILED", f"Invalid sequence hash for {resource_id}.")
            expected_relative = (Path("quarantine") / "blobs" / digest[:2] / f"{digest}.txt.gz") if quarantine else (Path("blobs") / digest[:2] / f"{digest}.txt.gz")
            if Path(relative_path) != expected_relative:
                raise MaterialsError("SNAPSHOT_INTEGRITY_FAILED", f"Sequence object path mismatch for {resource_id}.")
            blob = directory / relative_path
            bucket = blob.parent
            if bucket.is_symlink() or not bucket.is_dir() or blob.is_symlink() or not blob.is_file():
                raise MaterialsError("SNAPSHOT_INTEGRITY_FAILED", f"Sequence object is missing or unsafe for {resource_id}.")
            hasher = hashlib.sha256()
            total = 0
            try:
                with gzip.open(blob, "rt", encoding="ascii", newline="") as handle:
                    while True:
                        chunk = handle.read(1024 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > MAX_SEQUENCE_CHARS:
                            raise MaterialsError("SNAPSHOT_INTEGRITY_FAILED", f"Sequence object exceeds the supported size for {resource_id}.")
                        hasher.update(chunk.encode("ascii"))
            except MaterialsError:
                raise
            except (OSError, UnicodeError, ValueError) as exc:
                raise MaterialsError("SNAPSHOT_INTEGRITY_FAILED", f"Sequence object could not be read for {resource_id}.") from exc
            if total < 1 or hasher.hexdigest() != digest:
                raise MaterialsError("SNAPSHOT_INTEGRITY_FAILED", f"Sequence object hash mismatch for {resource_id}.")

    def _active_id(self) -> str | None:
        if not self.active_pointer.is_file():
            return None
        payload = _safe_read_json(self.active_pointer)
        if payload.get("schema_version") != MATERIALS_SCHEMA_VERSION:
            raise MaterialsError("ACTIVE_POINTER_INVALID", "The active materials pointer uses an unsupported schema.")
        active = payload.get("active_snapshot")
        if not isinstance(active, str) or not active:
            raise MaterialsError("ACTIVE_POINTER_INVALID", "The active materials pointer does not name a snapshot.")
        try:
            manifest_path = self._snapshot_dir(active) / "manifest.json"
            expected = payload.get("manifest_sha256")
            if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected) or not manifest_path.is_file() or _sha256_file(manifest_path) != expected:
                raise MaterialsError("ACTIVE_POINTER_INVALID", "The active materials pointer does not match its manifest.")
            manifest = _safe_read_json(manifest_path)
            policy = _activation_policy(manifest)
            if policy == "DENY":
                raise MaterialsError("ACTIVE_POINTER_INVALID", "The active materials pointer targets a snapshot that denies activation.")
            if policy == "EXPLICIT_HUMAN_ONLY":
                if payload.get("action") not in {"activate", "rollback"}:
                    raise MaterialsError("ACTIVE_POINTER_INVALID", "The active materials pointer has no valid activation action.")
                _activation_evidence(
                    payload.get("operator"),
                    payload.get("approval_reference"),
                    required=True,
                    error_code="ACTIVE_POINTER_INVALID",
                )
                if payload.get("operator_identity_assurance") != "SELF_DECLARED_UNVERIFIED":
                    raise MaterialsError("ACTIVE_POINTER_INVALID", "The active materials pointer overstates or omits operator identity assurance.")
                activated_at = payload.get("activated_at")
                if not isinstance(activated_at, str) or not activated_at.endswith("Z") or len(activated_at) > 64:
                    raise MaterialsError("ACTIVE_POINTER_INVALID", "The active materials pointer has no valid UTC activation timestamp.")
                try:
                    datetime.fromisoformat(activated_at.replace("Z", "+00:00"))
                except ValueError as exc:
                    raise MaterialsError("ACTIVE_POINTER_INVALID", "The active materials pointer has no valid UTC activation timestamp.") from exc
        except MaterialsError:
            raise
        except OSError as exc:
            raise MaterialsError("ACTIVE_POINTER_INVALID", "The active materials pointer cannot be verified safely.") from exc
        return active

    def _snapshot_dir(self, snapshot_id: str) -> Path:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", snapshot_id):
            raise MaterialsError("INVALID_SNAPSHOT_ID", "Invalid snapshot ID.")
        directory = self.snapshots / snapshot_id
        if directory.is_symlink():
            raise MaterialsError("REPARSE_POINT_NOT_ALLOWED", f"Reparse points are not allowed: {directory}")
        return directory

    def _connect(self, snapshot_id: str, *, quarantine: bool = False) -> sqlite3.Connection:
        directory = self._snapshot_dir(snapshot_id)
        database = directory / ("quarantine.sqlite" if quarantine else "catalog.sqlite")
        if quarantine and not database.is_file():
            # Backward compatibility for pre-v1 snapshots: they contain no
            # physically quarantined rows, so an admin lookup is empty rather
            # than silently reading the model-facing catalog.
            raise MaterialsError("QUARANTINE_NOT_AVAILABLE", f"Snapshot has no quarantine catalog: {snapshot_id}")
        if not database.is_file():
            raise MaterialsError("SNAPSHOT_NOT_FOUND", f"Snapshot not found: {snapshot_id}")
        uri = f"file:{urllib.parse.quote(str(database))}?mode=ro"
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        if not quarantine:
            conn.execute("SELECT 1")
        return conn

    def _blob_path(self, snapshot_id: str, digest: str, *, quarantine: bool = False) -> Path:
        directory = self._snapshot_dir(snapshot_id)
        root = directory / "quarantine" / "blobs" if quarantine else directory / "blobs"
        return root / digest[:2] / f"{digest}.txt.gz"

    def _all_identity(self, snapshot_id: str) -> dict[str, str]:
        result: dict[str, str] = {}
        for quarantine in (False, True):
            try:
                conn = self._connect(snapshot_id, quarantine=quarantine)
            except MaterialsError:
                continue
            try:
                result.update({str(row[0]): str(row[1] or "") for row in conn.execute("SELECT resource_id, sequence_sha256 FROM resources")})
            finally:
                conn.close()
        return result


def _clean_status_filter(status: str) -> list[str]:
    values = [part.strip().upper() for part in status.split(",") if part.strip()]
    if not values or any(value not in STATUS_VALUES for value in values):
        raise MaterialsError("INVALID_STATUS", "Unknown materials review status.")
    return values


def _bounded_source_limit(value: int, *, maximum: int) -> int:
    try:
        value = int(value)
    except (TypeError, ValueError) as exc:
        raise MaterialsError("INVALID_LIMIT", "Source record limit must be an integer.") from exc
    if value < 1 or value > maximum:
        raise MaterialsError("INVALID_LIMIT", f"Source record limit must be between 1 and {maximum}.")
    return value


def _igem_license(license_uuid: Any) -> dict[str, Any]:
    """Resolve an iGEM record's declared license; never assume a platform default."""

    if not isinstance(license_uuid, str) or not license_uuid.strip():
        return {"id": "NOASSERTION", "url": "", "attribution": "", "rights_notes": "iGEM record has no declared license; redistribution is conditional pending review.", "redistribution_status": "CONDITIONAL"}
    endpoint = f"https://api.registry.igem.org/v1/licenses/{urllib.parse.quote(license_uuid, safe='')}"
    try:
        payload, _ = _http_get(endpoint, headers={"Accept": "application/json"})
        body = json.loads(payload.decode("utf-8"))
    except (MaterialsError, UnicodeDecodeError, json.JSONDecodeError):
        return {"id": "NOASSERTION", "url": endpoint, "attribution": "", "rights_notes": "iGEM license endpoint could not be verified; redistribution is conditional.", "redistribution_status": "CONDITIONAL"}
    spdx = str(body.get("spdxID") or "NOASSERTION") if isinstance(body, dict) else "NOASSERTION"
    normalized = spdx.upper().replace("_", "-")
    status = "REDISTRIBUTABLE" if normalized in {"CC-BY-4.0", "CC0-1.0", "CC-BY-SA-4.0", "MIT", "BSD-2-CLAUSE", "BSD-3-CLAUSE"} else "CONDITIONAL"
    return {"id": spdx, "url": str(body.get("url") or endpoint) if isinstance(body, dict) else endpoint, "attribution": "iGEM Registry contributor", "rights_notes": str(body.get("description") or "Per-record iGEM license; verify attribution and third-party rights.") if isinstance(body, dict) else "Per-record iGEM license requires review.", "redistribution_status": status}


def _fts_query(query: str) -> str:
    tokens = TOKEN_PATTERN.findall(query)
    return " AND ".join(f"{token}*" for token in tokens[:16])


def _encode_cursor(offset: int) -> str:
    return base64.urlsafe_b64encode(str(max(0, offset)).encode("ascii")).decode("ascii").rstrip("=")


def _decode_cursor(cursor: str | None) -> int:
    if not cursor:
        return 0
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        value = int(base64.urlsafe_b64decode(padded.encode("ascii")).decode("ascii"))
    except (ValueError, UnicodeDecodeError, base64.binascii.Error) as exc:
        raise MaterialsError("INVALID_CURSOR", "Cursor is invalid.") from exc
    if value < 0 or value > 10_000_000:
        raise MaterialsError("INVALID_CURSOR", "Cursor is outside the supported range.")
    return value


def _decode_json(value: str, default: Any) -> Any:
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return default


def _row_summary(row: sqlite3.Row) -> dict[str, Any]:
    keys = row.keys()
    return {
        "resource_id": row["resource_id"],
        "kind": row["kind"],
        "name": row["name"],
        "aliases": _decode_json(row["aliases_json"], []),
        "description_en": row["description_en"],
        "description_zh": row["description_zh"],
        "organism": _decode_json(row["organism_json"], {}),
        "chassis": _decode_json(row["chassis_json"], []),
        "role_terms": _decode_json(row["role_terms_json"], []),
        "part_type": row["part_type"],
        "sequence_kind": row["sequence_kind"],
        "sequence_length": row["sequence_length"],
        "sequence_sha256": row["sequence_sha256"],
        "source": _decode_json(row["source_json"], {}),
        "license": _decode_json(row["license_json"], {}),
        "evidence_refs": _decode_json(row["evidence_refs_json"], []),
        "review_status": row["review_status"],
        "safety_status": row["safety_status"],
        "safety_flags": _decode_json(row["safety_flags_json"], []),
        "design_eligibility": bool(row["design_eligibility"]),
        "metadata": _decode_json(row["metadata_json"], {}),
    }


def _row_full(row: sqlite3.Row) -> dict[str, Any]:
    result = _row_summary(row)
    result["sequence"] = ""
    result["sequence_path"] = row["sequence_path"]
    return result


def _parse_fasta(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    header = ""
    sequence: list[str] = []
    with path.open("r", encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line:
                continue
            if line.startswith(">"):
                if header:
                    records.append(_fasta_record(header, "".join(sequence)))
                header, sequence = line[1:].strip(), []
            else:
                sequence.append(line)
        if header:
            records.append(_fasta_record(header, "".join(sequence)))
    return records


def _parse_genbank(path: Path) -> list[dict[str, Any]]:
    """Parse the bounded, sequence-bearing subset needed for safe staging."""

    text = path.read_text(encoding="utf-8", errors="replace")
    records: list[dict[str, Any]] = []
    for block in re.split(r"\n//\s*\n?", text):
        accession_match = re.search(r"^ACCESSION\s+([^\s]+)", block, re.MULTILINE)
        if not accession_match:
            continue
        accession = accession_match.group(1).strip()
        definition_match = re.search(r"^DEFINITION\s+(.+?)(?=\n[A-Z][A-Z ]{1,15}\s|\Z)", block, re.MULTILINE | re.DOTALL)
        definition = re.sub(r"\s+", " ", definition_match.group(1)).strip() if definition_match else accession
        origin_match = re.search(r"^ORIGIN\s*\n(.+)", block, re.MULTILINE | re.DOTALL)
        if not origin_match:
            continue
        sequence = re.sub(r"[^A-Za-z]", "", origin_match.group(1)).upper()
        if not sequence:
            continue
        record_bytes = block.encode("utf-8")
        records.append({
            "resource_id": f"genbank:{accession}",
            "kind": "sequence",
            "name": accession,
            "description_en": definition[:MAX_DESCRIPTION_CHARS],
            "sequence": sequence,
            "sequence_kind": "DNA",
            "source": {"provider": "local-genbank", "record_id": accession, "revision": "local", "release": "local", "url": "local://import", "retrieved_at": _now(), "content_sha256": _sha256_bytes(record_bytes)},
            "license": {"id": "NOASSERTION", "url": "", "attribution": "", "rights_notes": "Imported GenBank rights require human review.", "redistribution_status": "CONDITIONAL"},
            "review_status": "REVIEW_REQUIRED",
            "design_eligibility": False,
        })
    if not records:
        raise MaterialsError("INVALID_GENBANK", "No bounded GenBank records with ACCESSION/ORIGIN sequence were found.")
    return records


def _parse_sbol(path: Path) -> list[dict[str, Any]]:
    """Stage simple SBOL/RDF sequence literals without granting instruction authority."""

    text = path.read_text(encoding="utf-8", errors="replace")
    if len(text.encode("utf-8")) > MAX_NETWORK_PAGE_BYTES:
        raise MaterialsError("FILE_TOO_LARGE", "SBOL import exceeds the bounded parser limit.")
    records: list[dict[str, Any]] = []
    subjects = re.findall(r"(?m)^\s*<([^>]+)>\s+a\s+(?:sbol3:)?Component\s*;?(.*?)(?=\n\s*<[^>]+>\s+a\s|\Z)", text, re.DOTALL)
    for subject, body in subjects:
        display = re.search(r"(?:sbol3:)?displayId\s+\"([^\"]+)\"", body)
        sequence = re.search(r"(?:sbol3:)?elements\s+\"([A-Za-z*\-\s]+)\"", body)
        if not display or not sequence:
            continue
        seq = re.sub(r"\s+", "", sequence.group(1)).upper()
        kind = "DNA" if set(seq) <= DNA_ALPHABET else "RNA" if set(seq) <= RNA_ALPHABET else "PROTEIN"
        records.append({
            "resource_id": f"sbol:{display.group(1)}",
            "kind": "genetic_part" if kind == "DNA" else "sequence",
            "name": display.group(1),
            "description_en": f"SBOL imported component {display.group(1)}.",
            "sequence": seq,
            "sequence_kind": kind,
            "source": {"provider": "local-sbol", "record_id": subject, "revision": "local", "release": "local", "url": "local://import", "retrieved_at": _now(), "content_sha256": _sha256_bytes(subject.encode("utf-8") + body.encode("utf-8"))},
            "license": {"id": "NOASSERTION", "url": "", "attribution": "", "rights_notes": "Imported SBOL rights require human review.", "redistribution_status": "CONDITIONAL"},
            "review_status": "REVIEW_REQUIRED",
            "design_eligibility": False,
        })
    if not records:
        raise MaterialsError("INVALID_SBOL", "No simple SBOL components with displayId/elements literals were found.")
    return records


def _fasta_record(header: str, sequence: str) -> dict[str, Any]:
    token = header.split()[0]
    kind = "DNA" if set(sequence.upper()) <= DNA_ALPHABET else "PROTEIN"
    return {
        "resource_id": f"local-fasta:{token}",
        "kind": "sequence",
        "name": header[:512],
        "description_en": header,
        "sequence": sequence,
        "sequence_kind": kind,
        "source": {"provider": "local-import", "record_id": token, "revision": "local", "release": "local", "url": "local://import", "retrieved_at": _now(), "content_sha256": _sha256_bytes(sequence.encode("ascii"))},
        "license": {"id": "NOASSERTION", "url": "", "attribution": "", "rights_notes": "Local import requires human rights review.", "redistribution_status": "CONDITIONAL"},
        "review_status": "REVIEW_REQUIRED",
        "design_eligibility": False,
    }


def _http_get(url: str, *, headers: dict[str, str] | None = None, timeout: int = 60) -> tuple[bytes, dict[str, str]]:
    try:
        import certifi

        context = ssl.create_default_context(cafile=certifi.where())
    except Exception:
        context = ssl.create_default_context()
    request = urllib.request.Request(url, headers={"User-Agent": "ProtoAgent-materials/1.0 (local catalog)", **(headers or {})})
    try:
        response = urllib.request.urlopen(request, context=context, timeout=timeout)
        payload = response.read(MAX_NETWORK_PAGE_BYTES + 1)
        if len(payload) > MAX_NETWORK_PAGE_BYTES:
            raise MaterialsError("NETWORK_RESPONSE_TOO_LARGE", f"Source response exceeded {MAX_NETWORK_PAGE_BYTES} bytes.")
        return payload, {str(key): str(value) for key, value in response.headers.items()}
    except MaterialsError:
        raise
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise MaterialsError("SOURCE_NETWORK_ERROR", f"Source request failed: {url}") from exc


def _iter_uniprot(*, page_size: int, max_records: int, release_info: dict[str, Any] | None = None) -> Iterator[dict[str, str]]:
    cursor: str | None = ""
    emitted = 0
    fields = "accession,id,protein_name,organism_name,organism_id,length,sequence"
    while cursor is not None and (not max_records or emitted < max_records):
        params = {"query": "reviewed:true", "format": "tsv", "fields": fields, "size": str(page_size)}
        if cursor:
            params["cursor"] = cursor
        url = "https://rest.uniprot.org/uniprotkb/search?" + urllib.parse.urlencode(params)
        payload, headers = _http_get(url, headers={"Accept": "text/tab-separated-values"})
        response_hash = _sha256_bytes(payload)
        if release_info is not None:
            release_info.setdefault("response_hashes", []).append(response_hash)
        if release_info is not None and headers.get("X-UniProt-Release"):
            release_info["release"] = headers["X-UniProt-Release"]
            if headers.get("X-UniProt-Release-Date"):
                release_info["release_date"] = headers["X-UniProt-Release-Date"]
        text = payload.decode("utf-8", "replace")
        reader = csv.DictReader(io.StringIO(text), delimiter="\t")
        page_count = 0
        for row in reader:
            normalized = {str(key): str(value or "") for key, value in row.items()}
            normalized["_response_content_sha256"] = response_hash
            yield normalized
            emitted += 1
            page_count += 1
            if max_records and emitted >= max_records:
                return
        link = headers.get("Link", "")
        next_match = re.search(r"<([^>]+)>;\s*rel=\"next\"", link)
        cursor = None
        if next_match:
            parsed = urllib.parse.urlparse(next_match.group(1))
            cursor = urllib.parse.parse_qs(parsed.query).get("cursor", [None])[0]
        if page_count == 0:
            break
