"""Canonical, dependency-free integrity helpers for protein selections.

The catalogue attestation used here is deliberately *not* a cryptographic
signature.  It is a self-contained, content-addressed receipt issued by the
local materials catalogue so that a materialized selection can be checked
offline for accidental or post-materialization mutation.  Authenticating the
catalogue author still requires a separately trusted manifest digest.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any


PROTEIN_SELECTION_SCHEMA_VERSION = "proto-agent.protein-selection.v2"
LEGACY_PROTEIN_SELECTION_SCHEMA_VERSION = "proto-agent.protein-selection.v1"
CATALOG_SELECTION_ATTESTATION_SCHEMA_VERSION = "proto-agent.catalog-selection-attestation.v1"
CATALOG_PROMOTION_INDEX_SCHEMA_VERSION = "proto-agent.catalog-promotion-index.v1"
CATALOG_ATTESTATION_ISSUER = "proto-agent-materials-catalog"
CATALOG_ATTESTATION_KIND = "catalog-issued-content-binding"
CATALOG_SIGNATURE_STATUS = "UNSIGNED"
PROMOTION_POLICY_VERSION = "proto-agent.materials-promotion-policy.2026-09"
PROMOTION_ROUND_IDS = (
    "provenance_rights",
    "sequence_ontology_safety",
    "duplicate_roundtrip_visibility",
)

_SHA256 = re.compile(r"^[a-f0-9]{64}$")

# Every policy/evidence field copied from a catalogue row is part of the
# canonical selection digest.  The compiler preserves this projection in IR,
# allowing export-time revalidation without reopening the catalogue.
PROTEIN_SELECTION_RECORD_FIELDS = (
    "id",
    "resource_id",
    "name",
    "sequence",
    "sequence_kind",
    "sequence_sha256",
    "description",
    "description_zh",
    "source",
    "license",
    "review_status",
    "safety_status",
    "safety_flags",
    "design_eligibility",
    "evidence_refs",
    "organism",
    "role_terms",
    "metadata",
)


def canonical_json_sha256(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def is_sha256(value: Any) -> bool:
    return isinstance(value, str) and _SHA256.fullmatch(value) is not None


def protein_selection_record(record: dict[str, Any]) -> dict[str, Any]:
    """Return the exact record projection covered by selection content addressing."""

    return {field: record.get(field) for field in PROTEIN_SELECTION_RECORD_FIELDS}


def protein_selection_record_sha256(record: dict[str, Any]) -> str:
    return canonical_json_sha256(protein_selection_record(record))


def protein_selection_core(payload: dict[str, Any]) -> dict[str, Any]:
    proteins = payload.get("proteins")
    if not isinstance(proteins, list):
        proteins = []
    return {
        "schema_version": payload.get("schema_version"),
        "snapshot_id": payload.get("snapshot_id"),
        "design_id": payload.get("design_id"),
        "chassis": payload.get("chassis"),
        "proteins": [protein_selection_record(item) if isinstance(item, dict) else item for item in proteins],
    }


def protein_selection_digest(payload: dict[str, Any]) -> str:
    return canonical_json_sha256(protein_selection_core(payload))


def legacy_protein_selection_digest(snapshot_id: str, proteins: list[dict[str, Any]]) -> str:
    """Recompute the v1 digest so already-compiled valid IR remains exportable."""

    return canonical_json_sha256(
        {
            "schema_version": LEGACY_PROTEIN_SELECTION_SCHEMA_VERSION,
            "snapshot_id": snapshot_id,
            "ids": [item.get("id") for item in proteins],
            "hashes": [item.get("sequence_sha256") for item in proteins],
        }
    )


def promotion_attestation_structure_error(attestation: Any, resource_id: str) -> str | None:
    if not isinstance(attestation, dict):
        return f"Catalog promotion attestation is missing for {resource_id}."
    if attestation.get("policy_version") != PROMOTION_POLICY_VERSION:
        return f"Catalog promotion policy is unsupported for {resource_id}."
    if attestation.get("resource_id") != resource_id:
        return f"Catalog promotion attestation resource mismatch for {resource_id}."
    if not is_sha256(str(attestation.get("record_sha256") or "").lower()):
        return f"Catalog promotion record digest is invalid for {resource_id}."
    if str(attestation.get("decision") or "").upper() != "PASS":
        return f"Catalog promotion decision is not PASS for {resource_id}."
    rounds = attestation.get("rounds")
    if not isinstance(rounds, list) or len(rounds) != len(PROMOTION_ROUND_IDS):
        return f"Catalog promotion rounds are incomplete for {resource_id}."
    if [item.get("round_id") for item in rounds if isinstance(item, dict)] != list(PROMOTION_ROUND_IDS):
        return f"Catalog promotion round order is invalid for {resource_id}."
    for item in rounds:
        if not isinstance(item, dict) or str(item.get("status") or "").upper() != "PASS":
            return f"Catalog promotion round did not pass for {resource_id}."
        reasons = item.get("reason_codes")
        if not isinstance(reasons, list) or not reasons or any(not isinstance(reason, str) or not reason for reason in reasons):
            return f"Catalog promotion reasons are incomplete for {resource_id}."
    return None


def catalog_selection_binding_core(attestation: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in attestation.items() if key != "binding_sha256"}


def catalog_selection_binding_sha256(attestation: dict[str, Any]) -> str:
    return canonical_json_sha256(catalog_selection_binding_core(attestation))


def validate_catalog_selection_attestation(payload: dict[str, Any]) -> dict[str, Any]:
    """Validate a v2 selection's self-contained, unsigned catalogue receipt.

    The return value is the validated attestation.  Failure is fail-closed and
    raises ``ValueError``.  This proves internal content binding, not author
    identity, because no cryptographic signature or local trust store is used.
    """

    if payload.get("schema_version") != PROTEIN_SELECTION_SCHEMA_VERSION:
        raise ValueError(f"Expected {PROTEIN_SELECTION_SCHEMA_VERSION}.")
    digest = protein_selection_digest(payload)
    if str(payload.get("selection_digest") or "").lower() != digest:
        raise ValueError("Protein selection digest does not match its canonical content.")
    if payload.get("selection_id") != f"protein-selection:{digest}":
        raise ValueError("Protein selection_id is not bound to the canonical selection digest.")

    attestation = payload.get("catalog_attestation")
    if not isinstance(attestation, dict):
        raise ValueError("Catalog-issued selection attestation is required; self-asserted DESIGN_ELIGIBLE is insufficient.")
    if attestation.get("schema_version") != CATALOG_SELECTION_ATTESTATION_SCHEMA_VERSION:
        raise ValueError("Catalog selection attestation schema is unsupported.")
    if attestation.get("issuer") != CATALOG_ATTESTATION_ISSUER or attestation.get("attestation_kind") != CATALOG_ATTESTATION_KIND:
        raise ValueError("Protein selection was not issued by the supported materials catalogue attestation path.")
    if attestation.get("signature_status") != CATALOG_SIGNATURE_STATUS or attestation.get("cryptographic_signature") is not False:
        raise ValueError("Catalog content binding must honestly declare its UNSIGNED non-cryptographic status.")
    if attestation.get("authenticity") != "NOT_ESTABLISHED":
        raise ValueError("Catalog content binding must not claim cryptographic authenticity.")
    if str(attestation.get("selection_digest") or "").lower() != digest:
        raise ValueError("Catalog attestation is bound to a different protein selection.")

    snapshot = attestation.get("snapshot_manifest")
    if not isinstance(snapshot, dict):
        raise ValueError("Catalog attestation is missing the snapshot manifest binding.")
    if snapshot.get("schema_version") != "proto-agent.materials.v1" or snapshot.get("snapshot_id") != payload.get("snapshot_id"):
        raise ValueError("Catalog attestation snapshot identity does not match the protein selection.")
    for field in ("manifest_sha256", "catalog_sha256", "license_catalog_sha256"):
        if not is_sha256(str(snapshot.get(field) or "").lower()):
            raise ValueError(f"Catalog attestation snapshot {field} is invalid.")
    if not isinstance(snapshot.get("record_count"), int) or snapshot["record_count"] < 1:
        raise ValueError("Catalog attestation snapshot record_count is invalid.")
    audit = snapshot.get("promotion_audit")
    if not isinstance(audit, dict):
        raise ValueError("Catalog attestation is missing the promotion-audit binding.")
    if audit.get("schema_version") != "proto-agent.materials-promotion-audit.v1" or audit.get("policy_version") != PROMOTION_POLICY_VERSION:
        raise ValueError("Catalog attestation promotion-audit policy is unsupported.")
    audit_sha256 = str(audit.get("sha256") or "").lower()
    if not is_sha256(audit_sha256):
        raise ValueError("Catalog attestation promotion-audit digest is invalid.")

    proteins = payload.get("proteins")
    bindings = attestation.get("records")
    if not isinstance(proteins, list) or not isinstance(bindings, list) or len(bindings) != len(proteins):
        raise ValueError("Catalog attestation record bindings do not cover the complete protein selection.")
    seen: set[str] = set()
    for index, (record, binding) in enumerate(zip(proteins, bindings)):
        if not isinstance(record, dict) or not isinstance(binding, dict):
            raise ValueError(f"Catalog attestation record binding {index} is invalid.")
        resource_id = str(record.get("resource_id") or "")
        if not resource_id or binding.get("resource_id") != resource_id or resource_id.casefold() in seen:
            raise ValueError(f"Catalog attestation resource binding mismatch at proteins[{index}].")
        seen.add(resource_id.casefold())
        if str(binding.get("selection_record_sha256") or "").lower() != protein_selection_record_sha256(record):
            raise ValueError(f"Catalog attestation record content mismatch for {resource_id}.")
        promotion = binding.get("promotion_attestation")
        problem = promotion_attestation_structure_error(promotion, resource_id)
        if problem:
            raise ValueError(problem)
        if str(binding.get("promotion_attestation_sha256") or "").lower() != canonical_json_sha256(promotion):
            raise ValueError(f"Catalog promotion attestation digest mismatch for {resource_id}.")
        if str(binding.get("promotion_audit_sha256") or "").lower() != audit_sha256:
            raise ValueError(f"Catalog promotion-audit binding mismatch for {resource_id}.")

    expected_binding = catalog_selection_binding_sha256(attestation)
    if str(attestation.get("binding_sha256") or "").lower() != expected_binding:
        raise ValueError("Catalog selection binding digest does not match its canonical content.")
    return attestation
