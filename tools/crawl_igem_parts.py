#!/usr/bin/env python3
"""Crawl published, openly licensed iGEM Registry parts into review evidence.

The iGEM Registry API (https://api.registry.igem.org) is the structured mirror
of the historical team-wiki part pages submitted to past iGEM competitions.
This tool selects ``published`` DNA parts under the two reviewed open licenses
(CC-BY-4.0, CC0-1.0) for the four part types the design compiler supports,
fetches each part record as exact response bytes, enforces the same identity
invariants the promotion audit will later apply, and records accept/reject
decisions with reasons in a resumable state file.

Usage:
    python tools/crawl_igem_parts.py --run [--repo PATH]
    python tools/crawl_igem_parts.py --status [--repo PATH]
    python tools/crawl_igem_parts.py --verify-review-required [--repo PATH]

The crawl is rate-limit polite (one request per ~6.2 seconds, honoring the
registry's 100 requests / 10 minutes window) and fully resumable: exact source
evidence is durably published before its state checkpoint.
"""

from __future__ import annotations

import argparse
import json
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any
from uuid import UUID

import certifi

from proto_agent.security import (
    MAX_JSON_FILE_BYTES,
    SecurityBoundaryError,
    WorkspacePaths,
    is_reparse_point,
    read_bytes_bounded,
    read_text_bounded,
    write_text_bounded,
)


API_BASE = "https://api.registry.igem.org/v1"
EVIDENCE_DIRECTORY = "materials/reviewed/source_responses/2026-09/igem"
PARTS_DIRECTORY = f"{EVIDENCE_DIRECTORY}/parts"
REJECTED_DIRECTORY = f"{EVIDENCE_DIRECTORY}/rejected"
REVIEW_REQUIRED_DIRECTORY = f"{EVIDENCE_DIRECTORY}/review-required"
STATE_PATH = "materials/reviewed/igem_expansion_state_2026-09.jsonl"
MANIFEST_PATH = "materials/reviewed/igem_expansion_2026-09.json"
SEED_PATH = "materials/reviewed/igem_design_eligible_2026-09.json"
REVIEW_REQUIRED_REPORT_PATH = "materials/reviewed/igem_review_required_verification_2026-09.json"
USER_AGENT = "Proto-Agent-Materials-Audit/2026.09 (+software-catalog-review)"
MAX_RESPONSE_BYTES = 2_000_000
MAX_STATE_BYTES = MAX_JSON_FILE_BYTES
REQUEST_INTERVAL_SECONDS = 6.2
MAX_ATTEMPTS = 4

ROLE_UUIDS = {
    "SO:0000167": "35e00de3-f02a-4935-9add-72cfb517fa15",
    "SO:0000139": "9c7c4d6d-ac06-4c93-8515-e95ba3bea3bb",
    "SO:0000316": "65f1c72e-396c-4d02-b574-af06b3a073a9",
    "SO:0000141": "ae5c878a-2fdb-4c2e-b904-e6eb1a1224f2",
}
ROLE_PART_TYPES = {
    "SO:0000167": "promoter",
    "SO:0000139": "rbs",
    "SO:0000316": "cds",
    "SO:0000141": "terminator",
}
ROLE_LABELS = {
    "SO:0000167": "Promoter",
    "SO:0000139": "Ribosome Entry Site",
    "SO:0000316": "CDS",
    "SO:0000141": "Terminator",
}
LICENSE_UUIDS = {
    "d6c69ca7-8be4-4bc0-b4a8-d3ae1d428aa6": "CC-BY-4.0",
    "5b2a6fd4-f5fa-4626-a37f-35f1ea89eec7": "CC0-1.0",
}
# Per-role selection policy: verified quota, hard fetch cap, and the sequence
# length bounds passed to the listing endpoint as minLength/maxLength.
ROLE_POLICY = {
    "SO:0000167": {"quota": 220, "cap": 320, "min_length": 10, "max_length": 1000},
    "SO:0000139": {"quota": 260, "cap": 560, "min_length": 10, "max_length": 200},
    "SO:0000316": {"quota": 280, "cap": 520, "min_length": 30, "max_length": 5000},
    "SO:0000141": {"quota": 260, "cap": 440, "min_length": 20, "max_length": 500},
}
# The manifest is emitted once at least this many parts have been verified,
# independent of the per-role stopping quotas above.
GLOBAL_TARGET = 1000
DNA_ALPHABET = set("ACGTUNRYKMSWBDHV")
# The 2026 iGEM season has not run yet, so 2026-team submissions have no
# competition-track record.  Only parts created before this cutoff (the 2025
# season and earlier, including the classic pre-2019 collections) are eligible.
SEASON_CUTOFF = datetime(2026, 1, 1, tzinfo=timezone.utc)
SEASON_2026_NAME = re.compile(r"^BBa_26[0-9A-Za-z]+$")
RFC3339_TIMESTAMP = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$"
)
SAFETY_PATTERN = re.compile(
    r"(?:pathogen|virulence|toxin|toxic|antimicrobial resistance|antibiotic resistance|"
    r"drug resistance|clinical isolate|human pathogen|oncogenic|select agent|病原|毒力|毒素|"
    r"耐药|临床分离|人源病原)",
    re.IGNORECASE,
)
NAME_PATTERN = re.compile(r"^BBa_[A-Za-z0-9]+$")
REVIEW_REQUIRED_UUIDS = (
    "286252f0-8b8c-4a76-b69b-cc486a7653a7",
    "fffc69c6-d65a-4fd5-8f14-f8410d0b2b14",
    "73143dae-df61-4fd3-b4cb-224ca65fa5a9",
    "3305e58c-59e2-4aab-9790-1f037cf5d4a5",
    "6ab08401-8df7-4017-be4f-75dfb6bf5961",
)


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _sha256_bytes(value: bytes) -> str:
    import hashlib

    return hashlib.sha256(value).hexdigest()


def _safe_relative(value: str) -> Path:
    pure = PurePosixPath(value)
    windows = PureWindowsPath(value)
    if (
        not value
        or "\\" in value
        or ":" in value
        or pure.is_absolute()
        or windows.is_absolute()
        or bool(windows.drive)
        or ".." in pure.parts
        or value != pure.as_posix()
    ):
        raise ValueError(f"Unsafe repository-relative path: {value!r}")
    return Path(*pure.parts)


def _validated_uuid(value: Any) -> str:
    text = str(value or "").strip()
    try:
        parsed = UUID(text)
    except (ValueError, AttributeError) as exc:
        raise ValueError(f"Invalid iGEM part UUID: {text!r}") from exc
    canonical = str(parsed)
    if text.casefold() != canonical:
        raise ValueError(f"iGEM part UUID must use canonical hyphenated form: {text!r}")
    return canonical


def _parse_rfc3339(value: Any) -> datetime | None:
    if not isinstance(value, str) or len(value) > 64 or not RFC3339_TIMESTAMP.fullmatch(value):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed.astimezone(timezone.utc)


def _repository_root(repo: Path) -> Path:
    requested = repo.absolute()
    current = Path(requested.anchor)
    for part in requested.parts[1:] if requested.anchor else requested.parts:
        current = current / part
        if is_reparse_point(current):
            raise SecurityBoundaryError(
                "REPARSE_POINT_NOT_ALLOWED",
                f"Repository paths may not traverse a symbolic link, junction, or reparse point: {current}",
            )
        if not current.exists():
            break
    try:
        canonical = requested.resolve(strict=True)
    except (FileNotFoundError, OSError) as exc:
        raise SecurityBoundaryError("WORKSPACE_NOT_FOUND", f"Repository does not exist: {requested}") from exc
    if not canonical.is_dir():
        raise SecurityBoundaryError("WORKSPACE_NOT_DIRECTORY", f"Repository is not a directory: {canonical}")
    return canonical


def _repo_file(repo: Path, value: str, *, create_parent: bool = False) -> tuple[Path, Path]:
    root = _repository_root(repo)
    relative = _safe_relative(value)
    target = root.joinpath(*relative.parts)
    policy = WorkspacePaths(root, root / "build", root / "build" / "cache")
    if create_parent:
        policy.ensure_directory(target.parent, boundary=root)
    return target, root


def _read_optional_text(repo: Path, value: str, *, max_bytes: int) -> str | None:
    target, _root = _repo_file(repo, value)
    try:
        return read_text_bounded(target, max_bytes=max_bytes)
    except SecurityBoundaryError as exc:
        if exc.code == "FILE_NOT_FOUND":
            return None
        raise


def _read_optional_bytes(repo: Path, value: str, *, max_bytes: int) -> bytes | None:
    target, _root = _repo_file(repo, value)
    try:
        return read_bytes_bounded(target, max_bytes=max_bytes)
    except SecurityBoundaryError as exc:
        if exc.code == "FILE_NOT_FOUND":
            return None
        raise


def _write_repo_text(repo: Path, value: str, text: str, *, max_bytes: int) -> Path:
    target, root = _repo_file(repo, value, create_parent=True)
    write_text_bounded(target, text, max_bytes=max_bytes, boundary=root)
    return target


class RegistryClient:
    """Rate-limited HTTPS client for the iGEM Registry API."""

    def __init__(self) -> None:
        self._context = ssl.create_default_context(cafile=certifi.where())
        self._last_request_at = 0.0

    def get(self, url: str) -> tuple[bytes, str, str]:
        """Return (body, content_type, retrieved_at); sleep to honor rate limits."""

        for attempt in range(MAX_ATTEMPTS):
            self._throttle()
            request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": USER_AGENT})
            try:
                with urllib.request.urlopen(request, timeout=60, context=self._context) as response:
                    if response.status != 200 or response.geturl() != url:
                        raise ValueError(f"Unexpected response for {url}: {response.status} {response.geturl()}")
                    body = response.read(MAX_RESPONSE_BYTES + 1)
                    if not body or len(body) > MAX_RESPONSE_BYTES:
                        raise ValueError(f"Response size is invalid for {url}")
                    content_type = str(response.headers.get("Content-Type") or "").split(";", 1)[0].lower()
                    return body, content_type, _now()
            except urllib.error.HTTPError as exc:
                if exc.code not in {429, 503} or attempt == MAX_ATTEMPTS - 1:
                    raise
                retry_after = str(exc.headers.get("Retry-After") or "")
                if retry_after.replace(".", "", 1).isdigit():
                    delay = min(120.0, float(retry_after) + 1.0)
                else:
                    reset = str(exc.headers.get("x-ratelimit-reset-large") or "")
                    delay = min(120.0, float(reset) + 2.0) if reset.replace(".", "", 1).isdigit() else 30.0 * (attempt + 1)
                print(f"    rate limited; sleeping {delay:.0f}s", flush=True)
                time.sleep(delay)
            except (urllib.error.URLError, TimeoutError, OSError):
                if attempt == MAX_ATTEMPTS - 1:
                    raise
                time.sleep(10.0 * (attempt + 1))
        raise RuntimeError(f"Exhausted retries for {url}")

    def _throttle(self) -> None:
        elapsed = time.time() - self._last_request_at
        if elapsed < REQUEST_INTERVAL_SECONDS:
            time.sleep(REQUEST_INTERVAL_SECONDS - elapsed)
        self._last_request_at = time.time()


def _load_seed_sequences(repo: Path) -> set[str]:
    import hashlib

    sequences: set[str] = set()
    seed_text = _read_optional_text(repo, SEED_PATH, max_bytes=MAX_JSON_FILE_BYTES)
    if seed_text is None:
        return sequences
    payload = json.loads(seed_text)
    for record in payload.get("records", []):
        sequence = "".join(str(record.get("sequence") or "").upper().split())
        if sequence:
            sequences.add(hashlib.sha256(sequence.encode("ascii")).hexdigest())
    return sequences


def _evidence_path_for_state_entry(entry: dict[str, Any]) -> str | None:
    try:
        uuid = _validated_uuid(entry.get("uuid"))
    except ValueError:
        return None
    decision = str(entry.get("decision") or "")
    if decision == "accepted":
        directory = PARTS_DIRECTORY
    elif decision == "rejected":
        directory = REJECTED_DIRECTORY
    else:
        return None
    return f"{directory}/{uuid}.json"


def _state_entry_has_durable_evidence(repo: Path, entry: dict[str, Any]) -> bool:
    relative = _evidence_path_for_state_entry(entry)
    digest = str(entry.get("content_sha256") or "")
    byte_count = entry.get("byte_count")
    if (
        relative is None
        or not re.fullmatch(r"[0-9a-f]{64}", digest)
        or not isinstance(byte_count, int)
        or isinstance(byte_count, bool)
        or not 0 < byte_count <= MAX_RESPONSE_BYTES
        or _parse_rfc3339(entry.get("retrieved_at")) is None
    ):
        return False
    body = _read_optional_bytes(repo, relative, max_bytes=MAX_RESPONSE_BYTES)
    return body is not None and len(body) == byte_count and _sha256_bytes(body) == digest


def _load_state(repo: Path) -> dict[str, dict[str, Any]]:
    entries: dict[str, dict[str, Any]] = {}
    state_text = _read_optional_text(repo, STATE_PATH, max_bytes=MAX_STATE_BYTES)
    if state_text is None:
        return entries
    for line in state_text.splitlines():
        line = line.strip()
        if not line:
            continue
        entry = json.loads(line)
        if not isinstance(entry, dict):
            raise ValueError("Crawl state entries must be JSON objects.")
        try:
            uuid = _validated_uuid(entry.get("uuid"))
        except ValueError:
            continue
        if _state_entry_has_durable_evidence(repo, entry):
            entries[uuid] = entry
        else:
            entries.pop(uuid, None)
    return entries


def _append_state(repo: Path, entry: dict[str, Any]) -> None:
    if not _state_entry_has_durable_evidence(repo, entry):
        raise ValueError("Crawl state may only reference durable, hash-matching source evidence.")
    existing = _read_optional_text(repo, STATE_PATH, max_bytes=MAX_STATE_BYTES) or ""
    line = json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n"
    _write_repo_text(repo, STATE_PATH, existing + line, max_bytes=MAX_STATE_BYTES)


def _write_evidence(repo: Path, directory: str, uuid: str, body: bytes) -> None:
    canonical_uuid = _validated_uuid(uuid)
    text = body.decode("utf-8")
    if text.encode("utf-8") != body:
        raise ValueError("Source evidence is not canonical UTF-8 bytes.")
    _write_repo_text(repo, f"{directory}/{canonical_uuid}.json", text, max_bytes=MAX_RESPONSE_BYTES)


def _season_allowed(created: Any, name: str) -> bool:
    timestamp = _parse_rfc3339(created)
    return timestamp is not None and timestamp < SEASON_CUTOFF and not SEASON_2026_NAME.fullmatch(name)


def _evaluate_part(detail: dict[str, Any], role: str, *, sequence_digests: set[str]) -> tuple[str, dict[str, Any]]:
    """Return (decision, facts); decision is ``accepted`` or a reject reason."""

    role_obj = detail.get("role") if isinstance(detail.get("role"), dict) else {}
    topology = detail.get("topology") if isinstance(detail.get("topology"), dict) else {}
    name = str(detail.get("name") or "").strip()
    sequence = re.sub(r"\s+", "", str(detail.get("sequence") or "")).upper()
    license_uuid = str(detail.get("licenseUUID") or "")
    chassis = detail.get("chassis") if isinstance(detail.get("chassis"), dict) else {}
    designed_for = chassis.get("designedFor") if isinstance(chassis.get("designedFor"), list) else []
    chassis_names = [str(item.get("scientificName")) for item in designed_for if isinstance(item, dict) and item.get("scientificName")]
    facts = {
        "name": name,
        "sequence_length": len(sequence),
        "sequence_sha256": _sha256_bytes(sequence.encode("ascii")) if sequence else "",
        "license_uuid": license_uuid,
        "chassis_names": chassis_names,
    }
    if str(detail.get("status") or "").lower() != "published":
        return "STATUS_NOT_PUBLISHED", facts
    if not NAME_PATTERN.fullmatch(name):
        return "NAME_INVALID", facts
    audit = detail.get("audit") if isinstance(detail.get("audit"), dict) else {}
    if not _season_allowed(audit.get("created"), name):
        return "SEASON_2026_EXCLUDED", facts
    if role_obj.get("accession") != role:
        return "ROLE_MISMATCH", facts
    if topology.get("accession") != "SO:0000987":
        return "TOPOLOGY_NOT_LINEAR", facts
    if license_uuid not in LICENSE_UUIDS:
        return "LICENSE_UNREVIEWED", facts
    policy = ROLE_POLICY[role]
    if not sequence or not set(sequence) <= DNA_ALPHABET:
        return "SEQUENCE_ALPHABET_INVALID", facts
    if not policy["min_length"] <= len(sequence) <= policy["max_length"]:
        return "SEQUENCE_LENGTH_OUT_OF_BOUNDS", facts
    if chassis_names and not any(re.search(r"Escherichia coli", item, re.IGNORECASE) for item in chassis_names):
        return "CHASSIS_INCOMPATIBLE", facts
    upstream_text = " ".join(
        str(value)
        for value in (name, detail.get("title") or "", detail.get("description") or "", role_obj.get("label") or "", *chassis_names)
    )
    if SAFETY_PATTERN.search(upstream_text):
        return "SAFETY_TEXT_FLAGGED", facts
    digest = facts["sequence_sha256"]
    if digest in sequence_digests:
        return "SEQUENCE_DUPLICATE", facts
    return "accepted", facts


def _discover_role(client: RegistryClient, role: str, cap: int) -> list[dict[str, Any]]:
    """Collect candidate listing rows for one role across both open licenses."""

    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    policy = ROLE_POLICY[role]
    for license_uuid in LICENSE_UUIDS:
        if len(rows) >= cap:
            break
        page = 1
        while len(rows) < cap:
            query = urllib.parse.urlencode({
                "roleUUIDs": ROLE_UUIDS[role],
                "licenseUUID": license_uuid,
                "status": "published",
                "minLength": str(policy["min_length"]),
                "maxLength": str(policy["max_length"]),
                "page": str(page),
                "pageSize": "100",
            })
            body, content_type, _ = client.get(f"{API_BASE}/parts?{query}")
            listing = json.loads(body.decode("utf-8"))
            data = listing.get("data", []) if isinstance(listing, dict) else []
            if not data:
                break
            for summary in data:
                try:
                    uuid = _validated_uuid(summary.get("uuid"))
                except ValueError:
                    continue
                if uuid in seen:
                    continue
                audit = summary.get("audit") if isinstance(summary.get("audit"), dict) else {}
                if not _season_allowed(audit.get("created"), str(summary.get("name") or "")):
                    continue
                seen.add(uuid)
                rows.append({
                    "uuid": uuid,
                    "name": str(summary.get("name") or ""),
                    "status": str(summary.get("status") or ""),
                    "sequence_length": summary.get("sequenceLength"),
                })
            page += 1
            if len(data) < 100:
                break
    rows.sort(key=lambda item: item["uuid"])
    return rows[:cap]


def _crawl_role(
    repo: Path,
    client: RegistryClient,
    role: str,
    candidates: list[dict[str, Any]],
    state: dict[str, dict[str, Any]],
    sequence_digests: set[str],
) -> tuple[int, int]:
    """Fetch details for candidates until the role quota is met; returns (accepted, processed)."""

    policy = ROLE_POLICY[role]
    accepted = sum(
        1 for entry in state.values() if entry.get("decision") == "accepted" and entry.get("role") == role
    )
    processed = sum(1 for entry in state.values() if entry.get("role") == role and str(entry.get("uuid") or "") != "")
    for candidate in candidates:
        if accepted >= policy["quota"] or processed >= policy["cap"]:
            break
        uuid = _validated_uuid(candidate.get("uuid"))
        if uuid in state:
            continue
        url = f"{API_BASE}/parts/{urllib.parse.quote(uuid, safe='')}"
        try:
            body, content_type, retrieved_at = client.get(url)
        except Exception as exc:  # noqa: BLE001 - one upstream record must not abort the crawl
            print(f"  FETCH_ERROR {uuid}: {exc}", flush=True)
            processed += 1
            continue
        processed += 1
        try:
            detail = json.loads(body.decode("utf-8"))
            if not isinstance(detail, dict):
                raise ValueError("detail response is not an object")
        except UnicodeDecodeError as exc:
            print(f"  SOURCE_INVALID_ENCODING {uuid}: {exc}", flush=True)
            continue
        except (json.JSONDecodeError, ValueError) as exc:
            entry = {
                "uuid": uuid,
                "role": role,
                "decision": "rejected",
                "reason": "SOURCE_INVALID_JSON",
                "detail": str(exc)[:200],
                "retrieved_at": retrieved_at,
                "url": url,
                "content_sha256": _sha256_bytes(body),
                "byte_count": len(body),
                "content_type": content_type,
            }
            _write_evidence(repo, REJECTED_DIRECTORY, uuid, body)
            _append_state(repo, entry)
            state[uuid] = entry
            continue
        decision, facts = _evaluate_part(detail, role, sequence_digests=sequence_digests)
        entry = {
            "uuid": uuid,
            "role": role,
            "decision": decision if decision == "accepted" else "rejected",
            "retrieved_at": retrieved_at,
            "url": url,
            "content_sha256": _sha256_bytes(body),
            "byte_count": len(body),
            "content_type": content_type,
            **facts,
        }
        if decision != "accepted":
            entry["reason"] = decision
        _write_evidence(repo, PARTS_DIRECTORY if decision == "accepted" else REJECTED_DIRECTORY, uuid, body)
        _append_state(repo, entry)
        state[uuid] = entry
        if decision == "accepted":
            sequence_digests.add(str(facts["sequence_sha256"]))
            accepted += 1
        if processed % 25 == 0:
            print(f"  {role}: processed={processed} accepted={accepted}", flush=True)
    return accepted, processed


def _emit_manifest(repo: Path, state: dict[str, dict[str, Any]]) -> int:
    parts = []
    for entry in state.values():
        if entry.get("decision") != "accepted":
            continue
        role = str(entry.get("role") or "")
        chassis_names = entry.get("chassis_names") if isinstance(entry.get("chassis_names"), list) else []
        chassis_basis = (
            "upstream_designed_for_ecoli"
            if any(re.search(r"Escherichia coli", str(name), re.IGNORECASE) for name in chassis_names)
            else "controlled_review_software_annotation"
        )
        parts.append({
            "uuid": entry["uuid"],
            "name": entry.get("name"),
            "part_type": ROLE_PART_TYPES[role],
            "role": role,
            "length": int(entry.get("sequence_length") or 0),
            "license_uuid": entry.get("license_uuid"),
            "chassis_basis": chassis_basis,
        })
    parts.sort(key=lambda item: item["uuid"])
    selection = {ROLE_PART_TYPES[role]: 0 for role in ROLE_PART_TYPES}
    for part in parts:
        selection[part["part_type"]] += 1
    manifest = {
        "schema_version": "proto-agent.materials.igem-expansion.v1",
        "generated_at": _now(),
        "selection": selection,
        "parts": parts,
    }
    _write_repo_text(
        repo,
        MANIFEST_PATH,
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        max_bytes=MAX_JSON_FILE_BYTES,
    )
    return len(parts)


def _verify_review_required(repo: Path, client: RegistryClient) -> int:
    """Fetch the five staged REVIEW_REQUIRED 2026 team parts and report findings."""

    report: dict[str, Any] = {
        "schema_version": "proto-agent.materials.igem-review-required-verification.v1",
        "generated_at": _now(),
        "subject": "REVIEW_REQUIRED iGEM records staged by the initial 2026-09 sync snapshot",
        "parts": [],
    }
    for uuid in REVIEW_REQUIRED_UUIDS:
        url = f"{API_BASE}/parts/{urllib.parse.quote(uuid, safe='')}"
        body, content_type, retrieved_at = client.get(url)
        detail = json.loads(body.decode("utf-8"))
        _write_evidence(repo, REVIEW_REQUIRED_DIRECTORY, uuid, body)
        role = detail.get("role") if isinstance(detail.get("role"), dict) else {}
        sequence = re.sub(r"\s+", "", str(detail.get("sequence") or "")).upper()
        chassis = detail.get("chassis") if isinstance(detail.get("chassis"), dict) else {}
        designed_for = chassis.get("designedFor") if isinstance(chassis.get("designedFor"), list) else []
        accession = str(role.get("accession") or "")
        promotion_outlook = (
            "PROMOTABLE_OPEN_LICENSE_ROLE_SUPPORTED"
            if accession in ROLE_PART_TYPES and str(detail.get("licenseUUID") or "") in LICENSE_UUIDS
            else "NOT_PROMOTABLE_UNDER_CURRENT_POLICY"
        )
        if accession not in ROLE_PART_TYPES:
            promotion_outlook = f"NOT_PROMOTABLE_ROLE_UNSUPPORTED ({accession})"
        report["parts"].append({
            "uuid": uuid,
            "name": detail.get("name"),
            "status": detail.get("status"),
            "role_accession": accession,
            "role_label": role.get("label"),
            "topology": (detail.get("topology") or {}).get("accession") if isinstance(detail.get("topology"), dict) else None,
            "license_uuid": detail.get("licenseUUID"),
            "sequence_length": len(sequence),
            "sequence_present": bool(sequence),
            "chassis_designed_for": [item.get("scientificName") for item in designed_for if isinstance(item, dict)],
            "retrieved_at": retrieved_at,
            "url": url,
            "content_sha256": _sha256_bytes(body),
            "promotion_outlook": promotion_outlook,
        })
    _write_repo_text(
        repo,
        REVIEW_REQUIRED_REPORT_PATH,
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        max_bytes=MAX_JSON_FILE_BYTES,
    )
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


def _status(repo: Path) -> int:
    state = _load_state(repo)
    accepted: dict[str, int] = {}
    rejected: dict[str, int] = {}
    for entry in state.values():
        role = str(entry.get("role") or "?")
        if entry.get("decision") == "accepted":
            accepted[role] = accepted.get(role, 0) + 1
        else:
            reason = str(entry.get("reason") or "?")
            rejected[f"{role}:{reason}"] = rejected.get(f"{role}:{reason}", 0) + 1
    print("accepted by role:")
    for role in ROLE_UUIDS:
        quota = ROLE_POLICY[role]["quota"]
        print(f"  {role} ({ROLE_PART_TYPES[role]}): {accepted.get(role, 0)}/{quota}")
    print("rejected by role:reason:")
    for key in sorted(rejected):
        print(f"  {key}: {rejected[key]}")
    manifest_present = _read_optional_text(repo, MANIFEST_PATH, max_bytes=MAX_JSON_FILE_BYTES) is not None
    print(f"manifest: {'present' if manifest_present else 'not emitted'}")
    return 0


def _run(repo: Path, verify_review_required: bool) -> int:
    client = RegistryClient()
    state = _load_state(repo)
    sequence_digests = _load_seed_sequences(repo)
    for entry in state.values():
        if entry.get("decision") == "accepted" and entry.get("sequence_sha256"):
            sequence_digests.add(entry["sequence_sha256"])
    if verify_review_required:
        print("verifying REVIEW_REQUIRED 2026 team parts...", flush=True)
        _verify_review_required(repo, client)
    for role in ROLE_UUIDS:
        already = sum(1 for entry in state.values() if entry.get("decision") == "accepted" and entry.get("role") == role)
        if already >= ROLE_POLICY[role]["quota"]:
            print(f"{role}: quota already met ({already})", flush=True)
            continue
        print(f"{role} ({ROLE_PART_TYPES[role]}): discovering candidates...", flush=True)
        candidates = _discover_role(client, role, ROLE_POLICY[role]["cap"])
        print(f"{role}: {len(candidates)} candidates; fetching details...", flush=True)
        accepted, processed = _crawl_role(repo, client, role, candidates, state, sequence_digests)
        print(f"{role}: processed={processed} accepted={accepted}", flush=True)
    total_accepted = sum(1 for entry in state.values() if entry.get("decision") == "accepted")
    if total_accepted < GLOBAL_TARGET:
        print(f"only {total_accepted} parts verified (target {GLOBAL_TARGET}); manifest not emitted (rerun to resume)", flush=True)
        return 1
    total = _emit_manifest(repo, state)
    print(f"manifest emitted with {total} parts", flush=True)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--run", action="store_true", help="Discover, fetch, and emit the expansion manifest (resumable).")
    group.add_argument("--status", action="store_true", help="Print crawl progress from the state file.")
    group.add_argument("--emit-manifest", action="store_true", help="Re-emit the manifest from the state file without network access.")
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--skip-review-required", action="store_true", help="Skip the REVIEW_REQUIRED verification step.")
    args = parser.parse_args()
    repo = _repository_root(args.repo)
    if args.status:
        return _status(repo)
    if args.emit_manifest:
        total = _emit_manifest(repo, _load_state(repo))
        print(f"manifest emitted with {total} parts", flush=True)
        return 0
    return _run(repo, verify_review_required=not args.skip_review_required)


if __name__ == "__main__":
    raise SystemExit(main())
