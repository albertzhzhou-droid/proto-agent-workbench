"""Bounded compilation support for design-eligible protein selections.

Protein sequences are intentionally a separate design domain.  They are not
silently converted to DNA parts and they do not inherit the nucleotide
construct topology rules.  A protein selection is produced by the materials
catalog and carries the same source, licence, safety, and digest evidence as
the selected records.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from .models import Diagnostic
from .security import MAX_JSON_FILE_BYTES, read_json_bounded


PROTEIN_SELECTION_SCHEMA_VERSION = "proto-agent.protein-selection.v1"
PROTEIN_MAX_RECORDS = 256
PROTEIN_MAX_SEQUENCE_CHARS = 1_000_000
PROTEIN_MAX_TOTAL_SEQUENCE_CHARS = 2_000_000
PROTEIN_ALPHABET = frozenset("ACDEFGHIKLMNPQRSTVWYBXZJUO*-")
_RESOURCE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")

# Average residue masses are used only for a deterministic, explicitly
# approximate visualization metric; this is not a scientific readiness claim.
_RESIDUE_MASS = {
    "A": 71.08,
    "C": 103.14,
    "D": 115.09,
    "E": 129.12,
    "F": 147.17,
    "G": 57.05,
    "H": 137.14,
    "I": 113.16,
    "K": 128.17,
    "L": 113.16,
    "M": 131.20,
    "N": 114.10,
    "P": 97.12,
    "Q": 128.13,
    "R": 156.19,
    "S": 87.08,
    "T": 101.11,
    "V": 99.13,
    "W": 186.21,
    "Y": 163.17,
}
_HYDROPHOBIC = frozenset("AVILMFWY")
_CHARGED = frozenset("DEKR")


def _digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _text(value: Any, field: str, *, max_length: int = 4096) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string.")
    value = value.replace("\x00", " ").strip()
    if len(value) > max_length:
        raise ValueError(f"{field} exceeds {max_length} characters.")
    return value


def _resource_id(value: Any, field: str = "id") -> str:
    value = _text(value, field, max_length=256)
    if ":" not in value or not _RESOURCE_ID.fullmatch(value):
        raise ValueError(f"{field} must be a namespaced, path-safe resource ID.")
    if any(segment in {"", ".", ".."} for segment in value.split("/")):
        raise ValueError(f"{field} must not contain empty or traversal path segments.")
    return value


def _sequence(value: Any, field: str) -> str:
    value = _text(value, field, max_length=PROTEIN_MAX_SEQUENCE_CHARS)
    # Selection files are normalized by the materials store.  Reject embedded
    # whitespace instead of silently changing a user-provided sequence.
    if any(char.isspace() for char in value):
        raise ValueError(f"{field} must not contain whitespace.")
    value = value.upper()
    if not value or len(value) > PROTEIN_MAX_SEQUENCE_CHARS or not set(value) <= PROTEIN_ALPHABET:
        raise ValueError(f"{field} contains unsupported amino-acid symbols or exceeds the limit.")
    return value


def _source_and_license(record: dict[str, Any], index: int) -> tuple[dict[str, Any], dict[str, Any]]:
    source = record.get("source")
    if not isinstance(source, dict):
        raise ValueError(f"proteins[{index}].source is required.")
    source = {
        "provider": _text(source.get("provider"), f"proteins[{index}].source.provider", max_length=256),
        "record_id": _text(source.get("record_id"), f"proteins[{index}].source.record_id", max_length=512),
        "revision": _text(source.get("revision"), f"proteins[{index}].source.revision", max_length=256),
        "release": _text(source.get("release"), f"proteins[{index}].source.release", max_length=256),
        "url": _text(source.get("url"), f"proteins[{index}].source.url", max_length=2048),
        "retrieved_at": _text(source.get("retrieved_at"), f"proteins[{index}].source.retrieved_at", max_length=64),
        "content_sha256": _text(source.get("content_sha256"), f"proteins[{index}].source.content_sha256", max_length=64).lower(),
    }
    if not source["provider"] or not source["record_id"] or not source["url"] or not _SHA256.fullmatch(source["content_sha256"]):
        raise ValueError(f"proteins[{index}].source must include provider, record_id, url, and a SHA-256 content hash.")

    license_info = record.get("license")
    if not isinstance(license_info, dict):
        raise ValueError(f"proteins[{index}].license is required.")
    license_info = {
        "id": _text(license_info.get("id"), f"proteins[{index}].license.id", max_length=128),
        "url": _text(license_info.get("url"), f"proteins[{index}].license.url", max_length=2048),
        "attribution": _text(license_info.get("attribution"), f"proteins[{index}].license.attribution", max_length=1024),
        "rights_notes": _text(license_info.get("rights_notes"), f"proteins[{index}].license.rights_notes", max_length=2048),
        "redistribution_status": _text(license_info.get("redistribution_status"), f"proteins[{index}].license.redistribution_status", max_length=32).upper(),
    }
    if not license_info["id"] or license_info["redistribution_status"] != "REDISTRIBUTABLE":
        raise ValueError(f"proteins[{index}].license must explicitly permit redistribution.")
    return source, license_info


def protein_metrics(sequence: str) -> dict[str, Any]:
    """Return bounded deterministic metrics suitable for a visual summary."""

    length = len(sequence)
    counts = {residue: sequence.count(residue) for residue in sorted(set(sequence))}
    known_mass = sum(_RESIDUE_MASS.get(residue, 110.0) for residue in sequence)
    # A peptide loses one water molecule per bond.  Ambiguous residues use a
    # neutral fallback above and are labelled as approximate by the caller.
    molecular_weight = max(0.0, known_mass - (18.015 * max(0, length - 1)))
    return {
        "length_aa": length,
        "molecular_weight_da_approx": round(molecular_weight, 3),
        "composition": counts,
        "hydrophobic_fraction": round(sum(residue in _HYDROPHOBIC for residue in sequence) / length, 6),
        "charged_fraction": round(sum(residue in _CHARGED for residue in sequence) / length, 6),
        "ambiguous_or_special_fraction": round(sum(residue not in _RESIDUE_MASS for residue in sequence) / length, 6),
    }


def compile_protein_selection(path: str | Path) -> tuple[dict[str, Any] | None, list[Diagnostic]]:
    """Validate a materialized protein selection and compile it to IR v1."""

    source_path = str(path)
    diagnostics: list[Diagnostic] = []
    try:
        payload = read_json_bounded(path, MAX_JSON_FILE_BYTES)
    except (OSError, UnicodeError, ValueError) as exc:
        diagnostics.append(Diagnostic("error", source_path, 0, "PROTEIN_SELECTION_INVALID", str(exc)))
        return None, diagnostics
    if not isinstance(payload, dict):
        diagnostics.append(Diagnostic("error", source_path, 0, "PROTEIN_SELECTION_INVALID", "Protein selection must be a JSON object."))
        return None, diagnostics
    if payload.get("schema_version") != PROTEIN_SELECTION_SCHEMA_VERSION:
        diagnostics.append(Diagnostic("error", source_path, 0, "PROTEIN_SELECTION_SCHEMA_UNSUPPORTED", f"Expected {PROTEIN_SELECTION_SCHEMA_VERSION}."))
    raw_proteins = payload.get("proteins")
    if not isinstance(raw_proteins, list) or not raw_proteins or len(raw_proteins) > PROTEIN_MAX_RECORDS:
        diagnostics.append(Diagnostic("error", source_path, 0, "PROTEIN_SELECTION_RECORDS_INVALID", f"proteins must contain 1-{PROTEIN_MAX_RECORDS} records."))
        return None, diagnostics

    try:
        design_id = _text(payload.get("design_id") or "", "design_id", max_length=256)
        chassis = _text(payload.get("chassis") or "protein_sequence", "chassis", max_length=256)
        snapshot_id = _text(payload.get("snapshot_id") or payload.get("version") or "", "snapshot_id", max_length=256)
        if not design_id:
            # A stable fallback makes hand-authored selections useful without
            # inventing a biological identifier.
            fallback_identity = {
                "snapshot_id": snapshot_id,
                "ids": [item.get("id") for item in raw_proteins if isinstance(item, dict)],
            }
            design_id = f"protein-selection-{_digest(fallback_identity)[:16]}"
        if not snapshot_id:
            raise ValueError("snapshot_id is required for provenance.")
        proteins: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        total_length = 0
        for index, raw in enumerate(raw_proteins):
            if not isinstance(raw, dict):
                raise ValueError(f"proteins[{index}] must be an object.")
            identifier = _resource_id(raw.get("id", raw.get("resource_id")), f"proteins[{index}].id")
            if identifier.casefold() in seen_ids:
                raise ValueError(f"Duplicate or normalization-collision protein ID: {identifier}.")
            seen_ids.add(identifier.casefold())
            sequence = _sequence(raw.get("sequence"), f"proteins[{index}].sequence")
            sequence_sha256 = hashlib.sha256(sequence.encode("ascii")).hexdigest()
            supplied_sha256 = _text(raw.get("sequence_sha256"), f"proteins[{index}].sequence_sha256", max_length=64).lower()
            if supplied_sha256 != sequence_sha256:
                raise ValueError(f"Sequence hash does not match {identifier}.")
            source, license_info = _source_and_license(raw, index)
            if source["content_sha256"] != sequence_sha256:
                raise ValueError(f"Source content hash does not match the sequence for {identifier}.")
            if raw.get("review_status") != "DESIGN_ELIGIBLE" or raw.get("design_eligibility") is not True:
                raise ValueError(f"Protein is not explicitly DESIGN_ELIGIBLE: {identifier}.")
            if str(raw.get("safety_status", "NO_FLAG")).upper() != "NO_FLAG":
                raise ValueError(f"Protein safety status is not NO_FLAG: {identifier}.")
            name = _text(raw.get("name") or identifier, f"proteins[{index}].name", max_length=512)
            description = _text(raw.get("description", raw.get("description_en")) or name, f"proteins[{index}].description", max_length=4000)
            description_zh = _text(raw.get("description_zh") or "", f"proteins[{index}].description_zh", max_length=4000)
            total_length += len(sequence)
            if total_length > PROTEIN_MAX_TOTAL_SEQUENCE_CHARS:
                raise ValueError(f"Protein selection exceeds {PROTEIN_MAX_TOTAL_SEQUENCE_CHARS} total residues.")
            proteins.append(
                {
                    "id": identifier,
                    "resource_id": _resource_id(raw.get("resource_id", identifier), f"proteins[{index}].resource_id"),
                    "type": "protein_sequence",
                    "name": name,
                    "sequence": sequence,
                    "sequence_kind": "PROTEIN",
                    "sequence_sha256": sequence_sha256,
                    "description": description,
                    "description_zh": description_zh,
                    "source": source,
                    "license": license_info,
                    "review_status": "DESIGN_ELIGIBLE",
                    "safety_status": "NO_FLAG",
                    "design_eligibility": True,
                    "metrics": protein_metrics(sequence),
                }
            )
    except (TypeError, ValueError) as exc:
        diagnostics.append(Diagnostic("error", source_path, 0, "PROTEIN_SELECTION_INVALID", str(exc)))
        return None, diagnostics

    selection_digest = _digest(
        {"schema_version": PROTEIN_SELECTION_SCHEMA_VERSION, "snapshot_id": snapshot_id, "ids": [item["id"] for item in proteins], "hashes": [item["sequence_sha256"] for item in proteins]}
    )
    diagnostics.append(
        Diagnostic(
            "warning",
            source_path,
            0,
            "PROTEIN_HUMAN_REVIEW_REQUIRED",
            "Compiled protein records passed local data, rights, and safety gates; scientific and human review remains required.",
        )
    )
    ir = {
        "schema_version": "proto-agent.ir.v1",
        "domain": "protein",
        "design_id": design_id,
        "chassis": chassis,
        "proteins": proteins,
        "constructs": [],
        "constraints": [],
        "provenance": {
            "source": source_path,
            "snapshot_id": snapshot_id,
            "selection_digest": selection_digest,
            "resource_ids": [item["resource_id"] for item in proteins],
        },
        "review_status": "human_review_required",
        "safety_boundary": "Software-level protein sequence compilation only; no wet-lab, orderability, biosafety, or regulatory claim.",
    }
    return ir, diagnostics
