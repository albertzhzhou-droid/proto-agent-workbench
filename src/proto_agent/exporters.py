from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any

from .protein import PROTEIN_ALPHABET, PROTEIN_MAX_RECORDS, PROTEIN_MAX_TOTAL_SEQUENCE_CHARS, protein_metrics_match
from .protein_integrity import (
    LEGACY_PROTEIN_SELECTION_SCHEMA_VERSION,
    PROTEIN_SELECTION_SCHEMA_VERSION,
    is_sha256,
    legacy_protein_selection_digest,
    protein_selection_record,
    validate_catalog_selection_attestation,
)
from .sbol import export_sbol3_turtle
from .security import MAX_JSON_FILE_BYTES, read_text_bounded
from .ir_json import decode_ir_json
from .dna_placement import DNA_IR_V2, validate_v2_construct


IR_SCHEMA_VERSION = "proto-agent.ir.v1"
DNA_ALPHABET = frozenset("ACGTRYSWKMBDHVN")
MAX_CONSTRUCTS = 1024
MAX_PARTS_PER_CONSTRUCT = 10_000
MAX_SEQUENCE_CHARS = 10_000_000
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def load_ir(path: str | Path) -> dict[str, Any]:
    payload = decode_ir_json(read_text_bounded(path, MAX_JSON_FILE_BYTES), max_bytes=MAX_JSON_FILE_BYTES)
    validate_ir_for_export(payload)
    return payload


def export_ir(ir: dict[str, Any], output_format: str) -> str:
    domain = validate_ir_for_export(ir)
    if output_format == "sbol":
        if domain == "protein":
            raise ValueError("SBOL export is limited to nucleotide constructs; use FASTA for protein IR.")
        return export_sbol3_turtle(ir)
    if output_format == "genbank":
        if domain == "protein":
            raise ValueError("GenBank export is limited to nucleotide constructs; use FASTA for protein IR.")
        return _export_toy_genbank(ir)
    if output_format == "fasta":
        return _export_fasta(ir)
    raise ValueError(f"Unsupported export format: {output_format}")


def _required_text(value: Any, field: str, *, limit: int = 4096) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit or _CONTROL.search(value):
        raise ValueError(f"{field} must be a non-empty bounded string without control characters.")
    return value.strip()


def _validate_source_license(
    record: dict[str, Any],
    context: str,
    sequence_sha256: str,
    *,
    require_source_sequence_sha256: bool,
) -> None:
    source = record.get("source")
    license_info = record.get("license")
    if not isinstance(source, dict) or not isinstance(license_info, dict):
        raise ValueError(f"{context} must carry complete source and license metadata.")
    for field, limit in (
        ("provider", 256),
        ("record_id", 512),
        ("revision", 256),
        ("release", 256),
        ("url", 2048),
        ("retrieved_at", 64),
        ("content_sha256", 64),
    ):
        _required_text(source.get(field), f"{context}.source.{field}", limit=limit)
    if not str(source["url"]).startswith("https://") or not is_sha256(str(source["content_sha256"]).lower()):
        raise ValueError(f"{context}.source must use a public HTTPS URL and a valid response-content SHA-256.")
    source_sequence_sha256 = source.get("sequence_sha256")
    if require_source_sequence_sha256 and not is_sha256(str(source_sequence_sha256 or "").lower()):
        raise ValueError(f"{context}.source.sequence_sha256 is required for governed export.")
    if source_sequence_sha256 is not None and str(source_sequence_sha256).lower() != sequence_sha256:
        raise ValueError(f"{context}.source.sequence_sha256 does not match the exported sequence.")
    for field, limit in (("id", 128), ("url", 2048), ("attribution", 1024), ("rights_notes", 2048)):
        _required_text(license_info.get(field), f"{context}.license.{field}", limit=limit)
    if not str(license_info["url"]).startswith("https://") or license_info.get("redistribution_status") != "REDISTRIBUTABLE":
        raise ValueError(f"{context}.license must use a public HTTPS URL and explicitly permit redistribution.")


def _validate_common_ir(ir: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(ir, dict):
        raise ValueError("Compiled IR must be a JSON object.")
    if ir.get("schema_version") not in (IR_SCHEMA_VERSION, DNA_IR_V2):
        raise ValueError(f"Compiled IR schema must be {IR_SCHEMA_VERSION} or {DNA_IR_V2}.")
    if ir.get("schema_version") == DNA_IR_V2 and ir.get("domain") != "dna":
        raise ValueError("IR v2 placement semantics require explicit domain=dna.")
    _required_text(ir.get("design_id"), "design_id", limit=256)
    _required_text(ir.get("chassis"), "chassis", limit=256)
    constraints = ir.get("constraints")
    if not isinstance(constraints, list) or len(constraints) > 10_000:
        raise ValueError("IR constraints must be a bounded array.")
    for index, constraint in enumerate(constraints):
        if not isinstance(constraint, dict):
            raise ValueError(f"constraints[{index}] must be an object.")
        _required_text(constraint.get("type"), f"constraints[{index}].type", limit=128)
    provenance = ir.get("provenance")
    if not isinstance(provenance, dict):
        raise ValueError("IR provenance must be an object.")
    _required_text(provenance.get("source"), "provenance.source", limit=4096)
    for field in ("source_sha256", "parts_sha256"):
        if field in provenance and not is_sha256(str(provenance.get(field) or "").lower()):
            raise ValueError(f"provenance.{field} must be a SHA-256 digest when present.")
    return provenance


def _validate_protein_ir(ir: dict[str, Any], provenance: dict[str, Any]) -> None:
    proteins = ir.get("proteins")
    if not isinstance(proteins, list) or not proteins or len(proteins) > PROTEIN_MAX_RECORDS:
        raise ValueError(f"Protein IR must contain 1-{PROTEIN_MAX_RECORDS} protein records.")
    if ir.get("constructs") != []:
        raise ValueError("Protein IR must not contain nucleotide constructs.")
    if ir.get("chassis") != "protein_sequence":
        raise ValueError("Protein IR must use chassis=protein_sequence.")
    if ir.get("review_status") != "human_review_required":
        raise ValueError("Protein IR must preserve the human-review-required status.")
    _required_text(ir.get("safety_boundary"), "safety_boundary", limit=2048)

    total = 0
    identifiers: set[str] = set()
    resource_ids: list[str] = []
    is_v2 = provenance.get("selection_schema_version") == PROTEIN_SELECTION_SCHEMA_VERSION
    for index, protein in enumerate(proteins):
        context = f"proteins[{index}]"
        if not isinstance(protein, dict):
            raise ValueError(f"{context} must be an object.")
        identifier = _required_text(protein.get("id"), f"{context}.id", limit=256)
        resource_id = _required_text(protein.get("resource_id"), f"{context}.resource_id", limit=256)
        if ":" not in identifier or identifier != resource_id or identifier.casefold() in identifiers:
            raise ValueError(f"{context} must have one unique matching namespaced id/resource_id.")
        identifiers.add(identifier.casefold())
        resource_ids.append(resource_id)
        if protein.get("type") != "protein_sequence" or protein.get("sequence_kind") != "PROTEIN":
            raise ValueError(f"{context} has invalid protein domain markers.")
        sequence = _required_text(protein.get("sequence"), f"{context}.sequence", limit=1_000_000).upper()
        if any(char.isspace() for char in sequence) or not set(sequence) <= PROTEIN_ALPHABET:
            raise ValueError(f"{context}.sequence contains unsupported amino-acid symbols.")
        total += len(sequence)
        if total > PROTEIN_MAX_TOTAL_SEQUENCE_CHARS:
            raise ValueError("Protein IR exceeds the total sequence limit.")
        sequence_sha256 = hashlib.sha256(sequence.encode("ascii")).hexdigest()
        if str(protein.get("sequence_sha256") or "").lower() != sequence_sha256:
            raise ValueError(f"{context}.sequence_sha256 does not match the sequence.")
        _validate_source_license(protein, context, sequence_sha256, require_source_sequence_sha256=is_v2)
        if protein.get("review_status") != "DESIGN_ELIGIBLE" or protein.get("design_eligibility") is not True:
            raise ValueError(f"{context} is not explicitly DESIGN_ELIGIBLE.")
        if protein.get("safety_status") != "NO_FLAG":
            raise ValueError(f"{context} does not have safety_status=NO_FLAG.")
        if "safety_flags" in protein and protein.get("safety_flags") != []:
            raise ValueError(f"{context}.safety_flags must be empty.")
        if is_v2:
            if protein.get("safety_flags") != []:
                raise ValueError(f"{context}.safety_flags is required for governed export.")
            if not isinstance(protein.get("evidence_refs"), list) or not protein["evidence_refs"]:
                raise ValueError(f"{context}.evidence_refs is required for governed export.")
        if not protein_metrics_match(sequence, protein.get("metrics")):
            raise ValueError(f"{context}.metrics does not match recomputed sequence metrics.")

    snapshot_id = _required_text(provenance.get("snapshot_id"), "provenance.snapshot_id", limit=256)
    supplied_selection_digest = str(provenance.get("selection_digest") or "").lower()
    if not is_sha256(supplied_selection_digest):
        raise ValueError("Protein provenance selection_digest must be a SHA-256 digest.")
    if provenance.get("resource_ids") != resource_ids:
        raise ValueError("Protein provenance resource_ids do not match the exported records.")
    if is_v2:
        selection_payload = {
            "schema_version": PROTEIN_SELECTION_SCHEMA_VERSION,
            "selection_id": f"protein-selection:{supplied_selection_digest}",
            "selection_digest": supplied_selection_digest,
            "snapshot_id": snapshot_id,
            "design_id": ir.get("design_id"),
            "chassis": ir.get("chassis"),
            "proteins": [protein_selection_record(item) for item in proteins],
            "catalog_attestation": provenance.get("catalog_attestation"),
        }
        attestation = validate_catalog_selection_attestation(selection_payload)
        if provenance.get("catalog_binding_sha256") != attestation.get("binding_sha256") or provenance.get("catalog_signature_status") != "UNSIGNED":
            raise ValueError("Protein provenance catalogue-binding summary is inconsistent.")
    else:
        if provenance.get("selection_schema_version") not in {None, LEGACY_PROTEIN_SELECTION_SCHEMA_VERSION}:
            raise ValueError("Protein provenance selection schema is unsupported.")
        expected = legacy_protein_selection_digest(snapshot_id, proteins)
        if supplied_selection_digest != expected:
            raise ValueError("Legacy protein provenance selection_digest does not match the protein records.")


def _validate_dna_ir(ir: dict[str, Any]) -> None:
    proteins = ir.get("proteins")
    if proteins not in (None, []):
        raise ValueError("DNA IR must not contain protein records.")
    constructs = ir.get("constructs")
    if not isinstance(constructs, list) or not constructs or len(constructs) > MAX_CONSTRUCTS:
        raise ValueError(f"DNA IR must contain 1-{MAX_CONSTRUCTS} constructs.")
    total = 0
    seen_constructs: set[str] = set()
    for construct_index, construct in enumerate(constructs):
        context = f"constructs[{construct_index}]"
        if not isinstance(construct, dict):
            raise ValueError(f"{context} must be an object.")
        name = _required_text(construct.get("name"), f"{context}.name", limit=256)
        if name.casefold() in seen_constructs:
            raise ValueError(f"Duplicate construct name: {name}.")
        seen_constructs.add(name.casefold())
        topology = construct.get("topology", "unknown")
        if topology not in {"linear", "circular", "unknown"}:
            raise ValueError(f"{context}.topology is invalid.")
        parts = construct.get("parts")
        if not isinstance(parts, list) or not parts or len(parts) > MAX_PARTS_PER_CONSTRUCT:
            raise ValueError(f"{context}.parts must be a bounded non-empty array.")
        for part_index, part in enumerate(parts):
            part_context = f"{context}.parts[{part_index}]"
            if not isinstance(part, dict):
                raise ValueError(f"{part_context} must be an object.")
            _required_text(part.get("id"), f"{part_context}.id", limit=256)
            _required_text(part.get("type"), f"{part_context}.type", limit=64)
            sequence = _required_text(part.get("sequence"), f"{part_context}.sequence", limit=MAX_SEQUENCE_CHARS).upper()
            if any(char.isspace() for char in sequence) or not set(sequence) <= DNA_ALPHABET:
                raise ValueError(f"{part_context}.sequence contains unsupported DNA symbols.")
            total += len(sequence)
            if total > MAX_SEQUENCE_CHARS:
                raise ValueError("DNA IR exceeds the total sequence limit.")
            sequence_sha256 = hashlib.sha256(sequence.encode("ascii")).hexdigest()
            supplied_sha256 = part.get("sequence_sha256")
            if supplied_sha256 is not None and str(supplied_sha256).lower() != sequence_sha256:
                raise ValueError(f"{part_context}.sequence_sha256 does not match the sequence.")
            if ir["schema_version"] == DNA_IR_V2 and part.get("sequence") != sequence:
                raise ValueError("DNA v2 sequences must be canonical uppercase source-derived bytes.")
            governed = any(field in part for field in ("source", "license", "review_status", "design_eligibility", "safety_status", "safety_flags"))
            if governed:
                original_sha256 = part.get("source_sequence_sha256") if ir["schema_version"] == DNA_IR_V2 else sequence_sha256
                _validate_source_license(part, part_context, original_sha256, require_source_sequence_sha256=ir["schema_version"] == DNA_IR_V2)
                policy_fields = ("review_status", "design_eligibility", "safety_status")
                if any(field in part for field in policy_fields):
                    if part.get("review_status") != "DESIGN_ELIGIBLE" or part.get("design_eligibility") is not True or part.get("safety_status") != "NO_FLAG":
                        raise ValueError(f"{part_context} fails the governed eligibility/safety gate.")
                    if part.get("safety_flags", []) != []:
                        raise ValueError(f"{part_context}.safety_flags must be empty.")
            metrics = part.get("metrics")
            if metrics is not None:
                expected_metrics = {
                    "length_bp": len(sequence),
                    "gc_fraction": round(sum(base in "GC" for base in sequence) / len(sequence), 6),
                }
                if metrics != expected_metrics:
                    raise ValueError(f"{part_context}.metrics does not match recomputed DNA metrics.")
        if ir["schema_version"] == DNA_IR_V2:
            validate_v2_construct(construct)
        elif any(
            any(field in part for field in ("instance_id", "placement", "source_sequence_sha256")) for part in parts
        ):
            raise ValueError("DNA placement and source annotation semantics require IR v2.")


def validate_ir_for_export(ir: dict[str, Any]) -> str:
    """Return the validated domain or raise before any export bytes are written."""

    provenance = _validate_common_ir(ir)
    domain = ir.get("domain")
    if domain is None:
        # Compatibility for already-compiled v1 DNA IR.  New compilers emit an
        # explicit domain; only the unambiguous DNA shape may use this fallback.
        domain = "dna"
    if domain not in {"dna", "protein"}:
        raise ValueError("IR domain must be dna or protein.")
    if domain == "protein":
        _validate_protein_ir(ir, provenance)
    else:
        _validate_dna_ir(ir)
    return domain


def _construct_sequence(construct: dict[str, Any]) -> str:
    return "".join(part.get("sequence", "") for part in construct.get("parts", []))


def _export_toy_genbank(ir: dict[str, Any]) -> str:
    records = []
    for construct in ir.get("constructs", []):
        sequence = _construct_sequence(construct)
        records.extend(
            [
                f"LOCUS       {construct['name'][:16]:<16} {len(sequence):>5} bp    DNA     SYN",
                f"DEFINITION  Toy GenBank-like export for {ir['design_id']} / {construct['name']}.",
                "FEATURES             Location/Qualifiers",
            ]
        )
        position = 1
        for part in construct.get("parts", []):
            end = position + len(part.get("sequence", "")) - 1
            location = f"{position}..{end}"
            if ir["schema_version"] == DNA_IR_V2 and part.get("direction") == -1:
                location = f"complement({location})"
            records.append(f"     misc_feature    {location}")
            records.append(f"                     /label=\"{part['type']}:{part['id']}\"")
            if ir["schema_version"] == DNA_IR_V2:
                records.append(f"                     /note=\"instance={part['instance_id']}; placement={part['placement']['orientation']}; biological_direction={part['direction']}; source_sha256={part['source_sequence_sha256']}\"")
            position = end + 1
        for annotation in construct.get("annotations", []) if ir["schema_version"] == DNA_IR_V2 else []:
            locations = []
            for location in annotation["locations"]:
                value = f"{location['start'] + 1}..{location['end']}"
                locations.append(f"complement({value})" if location["direction"] == -1 else value)
            location_text = locations[0] if len(locations) == 1 else f"join({','.join(locations)})"
            records.append(f"     {annotation['type'][:15]:<16}{location_text}")
            records.append(f"                     /label=\"{annotation['name'].replace(chr(34), chr(39))}\"")
            records.append(f"                     /note=\"user annotation={annotation['id']}; source anchored; human review required\"")
        records.append("ORIGIN")
        records.append(f"        1 {sequence.lower()}")
        records.append("//")
    return "\n".join(records) + "\n"


def _export_fasta(ir: dict[str, Any]) -> str:
    if ir.get("domain") == "protein":
        lines = []
        provenance = ir["provenance"]
        for protein in ir.get("proteins", []):
            identifier = _fasta_header_token(protein.get("id", "protein"), "protein")
            name = _fasta_header_token(protein.get("name", ""), "record")
            design_id = _fasta_header_token(ir.get("design_id", "protein"), "protein")
            source = protein["source"]
            license_info = protein["license"]
            fields = [
                design_id,
                identifier,
                name,
                "domain=protein",
                f"sha256={protein['sequence_sha256']}",
                f"source={_fasta_header_token(source['provider'], 'source')}:{_fasta_header_token(source['record_id'], 'record')}",
                f"source_url={_fasta_header_token(source['url'], 'unavailable')}",
                f"license={_fasta_header_token(license_info['id'], 'unavailable')}",
                f"snapshot={_fasta_header_token(provenance['snapshot_id'], 'unavailable')}",
                f"selection_sha256={provenance['selection_digest']}",
                f"review={_fasta_header_token(ir['review_status'], 'human_review_required')}",
                f"catalog_signature={_fasta_header_token(provenance.get('catalog_signature_status', 'UNVERIFIED_LEGACY'), 'UNVERIFIED_LEGACY')}",
            ]
            lines.append(">" + "|".join(fields))
            lines.append(str(protein.get("sequence", "")))
        if not lines:
            raise ValueError("Protein IR contains no exportable sequences.")
        return "\n".join(lines) + "\n"
    lines = []
    for construct in ir.get("constructs", []):
        sequence = _construct_sequence(construct)
        sources = sorted({
            f"{part['source']['provider']}:{part['source']['record_id']}"
            for part in construct.get("parts", [])
            if isinstance(part.get("source"), dict)
        })
        licenses = sorted({
            str(part["license"].get("id") or "")
            for part in construct.get("parts", [])
            if isinstance(part.get("license"), dict) and part["license"].get("id")
        })
        governed = bool(sources)
        provenance = ir["provenance"]
        fields = [
            _fasta_header_token(ir["design_id"], "dna"),
            _fasta_header_token(construct["name"], "construct"),
            "domain=dna",
            f"sha256={hashlib.sha256(sequence.upper().encode('ascii')).hexdigest()}",
            f"source={_fasta_header_token(','.join(sources) if sources else 'toy_fixture', 'toy_fixture')}",
            f"license={_fasta_header_token(','.join(licenses) if licenses else 'UNVERIFIED', 'UNVERIFIED')}",
            f"snapshot={_fasta_header_token(provenance.get('snapshot_id', 'UNVERIFIED'), 'UNVERIFIED')}",
            f"review={_fasta_header_token(ir.get('review_status', 'human_review_required' if governed else 'UNVERIFIED_TOY_FIXTURE'), 'UNVERIFIED')}",
        ]
        lines.append(">" + "|".join(fields))
        lines.append(sequence)
    return "\n".join(lines) + "\n"


def _fasta_header_token(value: Any, fallback: str) -> str:
    """Keep untrusted labels on one bounded FASTA header line."""

    token = " ".join(str(value or "").replace("\x00", " ").replace("|", "_").split())[:256]
    return token or fallback
