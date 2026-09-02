"""Deterministic three-round review for materials promotion candidates."""

from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from datetime import datetime
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
from typing import Any, Iterable
from urllib.parse import urlsplit

from .materials import (
    DNA_ALPHABET,
    PART_TYPES,
    PROMOTION_AUDIT_SCHEMA_VERSION,
    PROMOTION_POLICY_VERSION,
    PROMOTION_ROUND_IDS,
    PROTEIN_ALPHABET,
    MaterialsError,
    MaterialsStore,
    _safety_classification,
    canonical_license_id,
    normalize_record,
    promotion_record_digest,
    provider_license_policy_errors,
)


_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_MAX_AUDIT_CANDIDATES = 1000
_ROLE_BY_PART_TYPE = {
    "promoter": "SO:0000167",
    "rbs": "SO:0000139",
    "cds": "SO:0000316",
    "terminator": "SO:0000141",
}
_SOURCE_HOSTS = {
    "iGEM Registry": {"api.registry.igem.org"},
    "UniProtKB/Swiss-Prot": {"www.uniprot.org", "rest.uniprot.org"},
    "Rhea": {"www.rhea-db.org"},
    "BioModels": {"www.ebi.ac.uk", "www.biomodels.org"},
    "Proto Agent": {"github.com"},
    "fixture": {"example.invalid"},
}


def _text(value: Any) -> str:
    return str(value or "").strip()


def _public_https(value: Any, *, hosts: set[str] | None = None) -> bool:
    try:
        parsed = urlsplit(_text(value))
    except ValueError:
        return False
    host = (parsed.hostname or "").casefold()
    if parsed.scheme != "https" or not host or parsed.username or parsed.password:
        return False
    return hosts is None or host in hosts


def _round(round_id: str, errors: list[str], passed: list[str]) -> dict[str, Any]:
    return {
        "round_id": round_id,
        "status": "FAIL" if errors else "PASS",
        "reason_codes": sorted(set(errors if errors else passed)),
    }


def _locked_relative_path(value: Any) -> bool:
    text = _text(value)
    if not text or "\\" in text:
        return False
    path = PurePosixPath(text)
    return not path.is_absolute() and ".." not in path.parts and text == path.as_posix()


def _round_one(record: dict[str, Any], source_evidence: dict[str, Any] | None) -> dict[str, Any]:
    errors: list[str] = []
    source = record.get("source") if isinstance(record.get("source"), dict) else {}
    license_info = record.get("license") if isinstance(record.get("license"), dict) else {}
    provider = _text(source.get("provider"))
    if not provider or provider not in _SOURCE_HOSTS:
        errors.append("SOURCE_PROVIDER_UNKNOWN")
    if not _text(source.get("record_id")):
        errors.append("SOURCE_RECORD_ID_MISSING")
    if not (_text(source.get("revision")) or _text(source.get("release"))):
        errors.append("SOURCE_VERSION_MISSING")
    if not _text(source.get("retrieved_at")):
        errors.append("SOURCE_RETRIEVAL_TIME_MISSING")
    else:
        try:
            datetime.fromisoformat(_text(source.get("retrieved_at")).replace("Z", "+00:00"))
        except ValueError:
            errors.append("SOURCE_RETRIEVAL_TIME_INVALID")
    if not _SHA256.fullmatch(_text(source.get("content_sha256")).lower()):
        errors.append("SOURCE_RESPONSE_HASH_INVALID")
    if not _public_https(source.get("url"), hosts=_SOURCE_HOSTS.get(provider)):
        errors.append("SOURCE_URL_POLICY_MISMATCH")
    errors.extend(provider_license_policy_errors(source, license_info))
    evidence = record.get("evidence_refs") if isinstance(record.get("evidence_refs"), list) else []
    if len(evidence) < 2 or any(not _public_https(item) for item in evidence):
        errors.append("EVIDENCE_LINKS_INCOMPLETE")
    if canonical_license_id(license_info.get("id")) != _text(license_info.get("id")):
        errors.append("LICENSE_ID_NOT_CANONICAL")
    if provider != "fixture":
        if not isinstance(source_evidence, dict):
            errors.append("SOURCE_EVIDENCE_MISSING")
        else:
            record_response = source_evidence.get("record_response")
            license_response = source_evidence.get("license_response")
            if not isinstance(record_response, dict):
                errors.append("SOURCE_RESPONSE_EVIDENCE_MISSING")
            else:
                if not _locked_relative_path(record_response.get("path")):
                    errors.append("SOURCE_RESPONSE_PATH_INVALID")
                if _text(record_response.get("sha256")).lower() != _text(source.get("content_sha256")).lower():
                    errors.append("SOURCE_RESPONSE_HASH_EVIDENCE_MISMATCH")
                if _text(record_response.get("url")) != _text(source.get("url")):
                    errors.append("SOURCE_RESPONSE_URL_EVIDENCE_MISMATCH")
                if _text(record_response.get("retrieved_at")) != _text(source.get("retrieved_at")):
                    errors.append("SOURCE_RESPONSE_TIME_EVIDENCE_MISMATCH")
            if not isinstance(license_response, dict):
                errors.append("LICENSE_RESPONSE_EVIDENCE_MISSING")
            else:
                if not _locked_relative_path(license_response.get("path")):
                    errors.append("LICENSE_RESPONSE_PATH_INVALID")
                if not _SHA256.fullmatch(_text(license_response.get("sha256")).lower()):
                    errors.append("LICENSE_RESPONSE_HASH_INVALID")
                if not _public_https(license_response.get("url")):
                    errors.append("LICENSE_RESPONSE_URL_INVALID")
                if canonical_license_id(license_response.get("declared_license_id")) != canonical_license_id(license_info.get("id")):
                    errors.append("LICENSE_RESPONSE_ID_MISMATCH")
                if _text(license_response.get("declared_license_url")).rstrip("/") != _text(license_info.get("url")).rstrip("/"):
                    errors.append("LICENSE_RESPONSE_URL_MISMATCH")
    return _round(
        PROMOTION_ROUND_IDS[0],
        errors,
        [
            "EVIDENCE_LINKS_VERIFIED",
            "LICENSE_RESPONSE_VERIFIED",
            "PROVIDER_LICENSE_POLICY_MATCHED",
            "SOURCE_RESPONSE_HASH_VERIFIED",
            "SOURCE_VERSIONED",
        ],
    )


def _round_two(record: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    sequence = "".join(_text(record.get("sequence")).upper().split())
    sequence_kind = _text(record.get("sequence_kind")).upper()
    expected_alphabet = DNA_ALPHABET if sequence_kind == "DNA" else PROTEIN_ALPHABET if sequence_kind == "PROTEIN" else set()
    sequence_sha256 = hashlib.sha256(sequence.encode("ascii")).hexdigest() if sequence else ""
    if not sequence or not expected_alphabet or not set(sequence) <= expected_alphabet:
        errors.append("SEQUENCE_INVALID")
    if _text(record.get("sequence_sha256")).lower() != sequence_sha256:
        errors.append("SEQUENCE_HASH_MISMATCH")
    source = record.get("source") if isinstance(record.get("source"), dict) else {}
    if _text(source.get("sequence_sha256")).lower() != sequence_sha256:
        errors.append("SOURCE_SEQUENCE_HASH_MISMATCH")
    supplied_safety = _text(record.get("safety_status")).upper()
    derived_safety, flags = _safety_classification(record)
    if supplied_safety != "NO_FLAG":
        errors.append("EXPLICIT_SAFETY_REVIEW_MISSING")
    if derived_safety != "NO_FLAG" or flags:
        errors.append("DERIVED_SAFETY_HARD_FLAG")
    kind = _text(record.get("kind")).lower()
    if kind == "genetic_part":
        part_type = _text(record.get("part_type")).lower()
        metadata = record.get("metadata") if isinstance(record.get("metadata"), dict) else {}
        if part_type not in PART_TYPES or _text(metadata.get("role_accession")) != _ROLE_BY_PART_TYPE.get(part_type):
            errors.append("ONTOLOGY_PART_TYPE_UNSUPPORTED")
        if "ecoli_k12" not in (record.get("chassis") if isinstance(record.get("chassis"), list) else []):
            errors.append("SOFTWARE_CHASSIS_MISSING")
        if _text(metadata.get("registry_status")).lower() != "published":
            errors.append("UPSTREAM_PUBLICATION_STATUS_INVALID")
    elif kind == "protein_sequence":
        metadata = record.get("metadata") if isinstance(record.get("metadata"), dict) else {}
        if sequence_kind != "PROTEIN":
            errors.append("ONTOLOGY_PROTEIN_KIND_MISMATCH")
        if metadata.get("reviewed_record") is not True:
            errors.append("UNIPROT_REVIEWED_ASSERTION_MISSING")
    else:
        errors.append("ONTOLOGY_KIND_UNSUPPORTED")
    return _round(
        PROMOTION_ROUND_IDS[1],
        errors,
        ["DERIVED_SAFETY_NO_FLAG", "ONTOLOGY_SUPPORTED", "SEQUENCE_HASH_VERIFIED", "SOFTWARE_DOMAIN_COMPATIBLE"],
    )


def _provisional_attestation(record: dict[str, Any], rounds: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "policy_version": PROMOTION_POLICY_VERSION,
        "resource_id": _text(record.get("resource_id", record.get("id"))),
        "record_sha256": promotion_record_digest(record),
        "decision": "PASS",
        "rounds": [
            rounds[0],
            rounds[1],
            {
                "round_id": PROMOTION_ROUND_IDS[2],
                "status": "PASS",
                "reason_codes": ["PROVISIONAL_NORMALIZATION_CHECK"],
            },
        ],
    }


def _sequence_digest(record: dict[str, Any]) -> str:
    sequence = "".join(_text(record.get("sequence")).upper().split())
    return hashlib.sha256(sequence.encode("ascii")).hexdigest() if sequence else ""


def _roundtrip_gate_errors(
    candidates: list[dict[str, Any]],
    first_rounds: list[list[dict[str, Any]]],
    id_counts: Counter[str],
    sequence_counts: Counter[str],
    *,
    generated_at: str,
) -> list[list[str]]:
    """Exercise eligible candidates through an isolated catalog and materializer."""

    errors: list[list[str]] = [[] for _ in candidates]
    eligible_indices: list[int] = []
    attestations: dict[str, dict[str, Any]] = {}
    for index, record in enumerate(candidates):
        resource_id = _text(record.get("resource_id", record.get("id")))
        sequence_sha256 = _sequence_digest(record)
        if (
            any(item["status"] != "PASS" for item in first_rounds[index])
            or id_counts[resource_id.casefold()] != 1
            or not sequence_sha256
            or sequence_counts[sequence_sha256] != 1
        ):
            continue
        provisional = _provisional_attestation(record, first_rounds[index])
        try:
            normalized = normalize_record(record, promotion_attestation=provisional)
        except Exception:
            errors[index].append("NORMALIZATION_ROUNDTRIP_FAILED")
            continue
        if normalized["review_status"] != "DESIGN_ELIGIBLE" or normalized["design_eligibility"] is not True:
            errors[index].append("CATALOG_ELIGIBILITY_ROUNDTRIP_FAILED")
        if normalized["sequence_sha256"] != sequence_sha256:
            errors[index].append("NORMALIZATION_SEQUENCE_CHANGED")
        if errors[index]:
            continue
        eligible_indices.append(index)
        attestations[resource_id] = provisional

    if not eligible_indices:
        return errors

    with TemporaryDirectory(prefix="proto-materials-promotion-") as temporary:
        temporary_root = Path(temporary)
        workspace = temporary_root / "workspace"
        workspace.mkdir()
        store = MaterialsStore(workspace=workspace, root=temporary_root / "materials")
        snapshot_id = "promotion-audit-roundtrip-v1"
        eligible_records = [candidates[index] for index in eligible_indices]
        try:
            store._create_snapshot(
                eligible_records,
                snapshot_id,
                sources=[{"provider": "Proto Agent", "release": PROMOTION_POLICY_VERSION}],
                label="Ephemeral promotion round-trip audit",
                created_at=generated_at,
                promotion_attestations=attestations,
            )
        except Exception:
            for index in eligible_indices:
                errors[index].extend(
                    ["CATALOG_ELIGIBILITY_ROUNDTRIP_FAILED", "MATERIALIZATION_ROUNDTRIP_FAILED"]
                )
            return errors

        visible_ids: set[str] = set()
        cursor: str | None = None
        search_failed = False
        expected_count = len(eligible_indices)
        try:
            for _ in range((expected_count // 100) + 2):
                page = store.search(
                    status="DESIGN_ELIGIBLE",
                    limit=100,
                    cursor=cursor,
                    snapshot_id=snapshot_id,
                    auto_initialize=False,
                )
                visible_ids.update(_text(item.get("resource_id")) for item in page["matches"])
                if page["match_count"] != expected_count:
                    search_failed = True
                cursor = page.get("next_cursor")
                if not cursor:
                    break
            else:
                search_failed = True
            if cursor:
                search_failed = True
        except (MaterialsError, KeyError, TypeError, ValueError):
            search_failed = True

        for index in eligible_indices:
            record = candidates[index]
            resource_id = _text(record.get("resource_id", record.get("id")))
            if search_failed or resource_id not in visible_ids:
                errors[index].append("CATALOG_ELIGIBILITY_ROUNDTRIP_FAILED")
                continue
            try:
                fetched = store.get(
                    resource_id,
                    include_sequence=True,
                    snapshot_id=snapshot_id,
                    auto_initialize=False,
                )["resource"]
                if (
                    fetched["resource_id"] != resource_id
                    or fetched["review_status"] != "DESIGN_ELIGIBLE"
                    or fetched["design_eligibility"] is not True
                    or fetched["sequence_sha256"] != _sequence_digest(record)
                ):
                    raise ValueError("catalog record changed during round trip")
            except (MaterialsError, KeyError, TypeError, ValueError):
                errors[index].append("CATALOG_ELIGIBILITY_ROUNDTRIP_FAILED")
                continue

            try:
                output = f"build/promotion-audit/{index}"
                if _text(record.get("kind")).lower() == "genetic_part":
                    materialized = store.materialize_parts(
                        [resource_id],
                        "ecoli_k12",
                        output=f"{output}/parts.json",
                        snapshot_id=snapshot_id,
                        auto_initialize=False,
                    )
                    payload = json.loads((workspace / materialized["parts_path"]).read_text(encoding="utf-8"))
                    items = payload["parts"]
                    count = materialized["part_count"]
                else:
                    materialized = store.materialize_proteins(
                        [resource_id],
                        design_id=f"promotion-audit-{index}",
                        output=f"{output}/proteins.json",
                        snapshot_id=snapshot_id,
                        auto_initialize=False,
                    )
                    payload = json.loads((workspace / materialized["proteins_path"]).read_text(encoding="utf-8"))
                    items = payload["proteins"]
                    count = materialized["protein_count"]
                if (
                    count != 1
                    or len(items) != 1
                    or items[0].get("resource_id", items[0].get("id")) != resource_id
                    or items[0].get("sequence_sha256") != _sequence_digest(record)
                ):
                    raise ValueError("materialized selection changed during round trip")
            except (MaterialsError, OSError, json.JSONDecodeError, KeyError, TypeError, ValueError):
                errors[index].append("MATERIALIZATION_ROUNDTRIP_FAILED")

    return errors


def _round_three(
    record: dict[str, Any],
    first_rounds: list[dict[str, Any]],
    id_counts: Counter[str],
    sequence_counts: Counter[str],
    gate_errors: list[str],
) -> dict[str, Any]:
    errors: list[str] = []
    resource_id = _text(record.get("resource_id", record.get("id")))
    sequence_sha256 = _sequence_digest(record)
    if id_counts[resource_id.casefold()] != 1:
        errors.append("DUPLICATE_RESOURCE_ID")
    if sequence_sha256 and sequence_counts[sequence_sha256] != 1:
        errors.append("DUPLICATE_SEQUENCE")
    if any(item["status"] != "PASS" for item in first_rounds):
        errors.append("EARLIER_AUDIT_ROUND_FAILED")
    errors.extend(gate_errors)
    return _round(
        PROMOTION_ROUND_IDS[2],
        errors,
        [
            "CATALOG_ELIGIBILITY_ROUNDTRIP_VERIFIED",
            "MATERIALIZATION_ROUNDTRIP_VERIFIED",
            "NORMALIZATION_ROUNDTRIP_VERIFIED",
            "RESOURCE_ID_UNIQUE",
            "SEQUENCE_UNIQUE",
        ],
    )


def audit_promotion_candidates(
    records: Iterable[dict[str, Any]],
    *,
    generated_at: str,
    source_evidence: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Run three deterministic, fail-closed review rounds per candidate."""

    candidates = [dict(record) for record in records]
    if len(candidates) > _MAX_AUDIT_CANDIDATES:
        raise ValueError(f"Promotion audits are limited to {_MAX_AUDIT_CANDIDATES} candidates per run.")
    id_counts: Counter[str] = Counter(_text(record.get("resource_id", record.get("id"))).casefold() for record in candidates)
    sequence_counts: Counter[str] = Counter(
        hashlib.sha256("".join(_text(record.get("sequence")).upper().split()).encode("ascii")).hexdigest()
        for record in candidates
        if _text(record.get("sequence"))
    )
    first_rounds: list[list[dict[str, Any]]] = []
    for record in candidates:
        resource_id = _text(record.get("resource_id", record.get("id")))
        evidence = (source_evidence or {}).get(resource_id)
        first_rounds.append([_round_one(record, evidence), _round_two(record)])
    gate_errors = _roundtrip_gate_errors(
        candidates,
        first_rounds,
        id_counts,
        sequence_counts,
        generated_at=generated_at,
    )
    decisions: list[dict[str, Any]] = []
    for index, record in enumerate(candidates):
        resource_id = _text(record.get("resource_id", record.get("id")))
        evidence = (source_evidence or {}).get(resource_id)
        first = first_rounds[index]
        third = _round_three(record, first, id_counts, sequence_counts, gate_errors[index])
        rounds = [*first, third]
        decision = {
            "policy_version": PROMOTION_POLICY_VERSION,
            "resource_id": resource_id,
            "record_sha256": promotion_record_digest(record),
            "decision": "PASS" if all(item["status"] == "PASS" for item in rounds) else "FAIL",
            "rounds": rounds,
        }
        if evidence:
            decision["source_evidence"] = evidence
        decisions.append(decision)
    passed = sum(item["decision"] == "PASS" for item in decisions)
    return {
        "schema_version": PROMOTION_AUDIT_SCHEMA_VERSION,
        "policy_version": PROMOTION_POLICY_VERSION,
        "generated_at": generated_at,
        "round_order": list(PROMOTION_ROUND_IDS),
        "candidate_count": len(decisions),
        "pass_count": passed,
        "fail_count": len(decisions) - passed,
        "candidates": sorted(decisions, key=lambda item: item["resource_id"].casefold()),
        "boundary": "Round three uses an inactive, explicit snapshot through catalog and materialization APIs. It does not establish human activation, wet-lab readiness, orderability, biosafety, or regulatory status.",
    }
