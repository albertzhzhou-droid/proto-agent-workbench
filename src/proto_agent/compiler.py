from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from .models import IR_CONSTRUCT_TOPOLOGIES, Design, Diagnostic
from .parser import parse_design, parse_design_text
from .parts import DEFAULT_PARTS_PATH, load_parts, part_index
from .dna_placement import DNA_IR_V2, dna_sha256, occurrence_ids, placement_record, resolve_annotation, reverse_complement
from .security import MAX_JSON_FILE_BYTES, read_bytes_bounded


def validate_design(design: Design | None, parse_diagnostics: list[Diagnostic], parts_path: str | Path = DEFAULT_PARTS_PATH) -> list[Diagnostic]:
    diagnostics = list(parse_diagnostics)
    if design is None:
        return diagnostics

    try:
        library = load_parts(parts_path)
    except FileNotFoundError:
        diagnostics.append(
            Diagnostic(
                "error",
                str(parts_path),
                0,
                "PART_LIBRARY_NOT_FOUND",
                "Part library was not found or could not be read safely.",
            )
        )
        return diagnostics

    if library.get("chassis") != design.chassis:
        diagnostics.append(
            Diagnostic(
                "error",
                design.source_path,
                1,
                "CHASSIS_LIBRARY_MISMATCH",
                f"Design chassis '{design.chassis}' does not match part library chassis '{library.get('chassis')}'.",
            )
        )

    by_id = part_index(library)
    if _uses_placements(design):
        total_length = 0
        for construct in design.constructs:
            if len(construct.parts) > 10_000:
                diagnostics.append(Diagnostic("error", design.source_path, construct.line, "DNA_PLACEMENT_LIMIT", "A construct may contain at most 10000 occurrences."))
                return diagnostics
            for part_ref in construct.parts:
                sequence = by_id.get(part_ref.id, {}).get("sequence", "")
                total_length += len(sequence) if isinstance(sequence, str) else 0
        if len(design.constructs) > 1024 or total_length > 10_000_000:
            diagnostics.append(Diagnostic("error", design.source_path, 0, "DNA_PLACEMENT_LIMIT", "DNA v2 is limited to 1024 constructs and 10000000 total sequence characters."))
            return diagnostics

    if not design.constructs:
        diagnostics.append(
            Diagnostic(
                "error",
                design.source_path,
                1,
                "NO_CONSTRUCTS",
                "Design must contain at least one construct.",
            )
        )

    for construct in design.constructs:
        if not isinstance(construct.topology, str) or construct.topology not in IR_CONSTRUCT_TOPOLOGIES:
            diagnostics.append(
                Diagnostic(
                    "error",
                    design.source_path,
                    construct.line,
                    "CONSTRUCT_TOPOLOGY_INVALID",
                    f"Construct '{construct.name}' has unsupported topology '{construct.topology}'.",
                    "Use linear, circular, or omit the topology declaration when it is unknown.",
                )
            )
        if not construct.parts:
            diagnostics.append(
                Diagnostic(
                    "error",
                    design.source_path,
                    construct.line,
                    "EMPTY_CONSTRUCT",
                    f"Construct '{construct.name}' has no parts.",
                )
            )
            continue

        for part_ref in construct.parts:
            part = by_id.get(part_ref.id)
            if part is None:
                diagnostics.append(
                    Diagnostic(
                        "error",
                        design.source_path,
                        part_ref.line,
                        "UNKNOWN_PART",
                        f"Unknown part id: {part_ref.id}",
                        "Search the part library before adding new IDs.",
                    )
                )
                continue
            if part.get("type") != part_ref.type:
                diagnostics.append(
                    Diagnostic(
                        "error",
                        design.source_path,
                        part_ref.line,
                        "PART_TYPE_MISMATCH",
                        f"Part '{part_ref.id}' is type '{part.get('type')}', not '{part_ref.type}'.",
                    )
                )

        if _uses_placements(design):
            try:
                _compile_v2_construct(construct, by_id)
            except (ValueError, KeyError, TypeError) as error:
                diagnostics.append(Diagnostic("error", design.source_path, construct.line, "DNA_PLACEMENT_GEOMETRY_INVALID", str(error)))
            diagnostics.append(Diagnostic("warning", design.source_path, construct.line, "BIOLOGICAL_DIRECTION_REQUIRES_REVIEW", "Placement geometry is validated independently of biological direction; unspecified source direction remains unknown. Legacy forward promoter/RBS/CDS/terminator layout is not a biological validation of this construct."))
        else:
            _validate_topology(design, construct.parts, diagnostics)

    for constraint in design.constraints:
        if constraint.type == "gc_content":
            _validate_float_param(design, diagnostics, constraint.line, constraint.params, "min")
            _validate_float_param(design, diagnostics, constraint.line, constraint.params, "max")
        elif constraint.type == "avoid_restriction_site":
            if "enzyme" not in constraint.params:
                diagnostics.append(
                    Diagnostic(
                        "error",
                        design.source_path,
                        constraint.line,
                        "MISSING_CONSTRAINT_PARAM",
                        "avoid_restriction_site requires enzyme=<name>.",
                    )
                )
        else:
            diagnostics.append(
                Diagnostic(
                    "warning",
                    design.source_path,
                    constraint.line,
                    "UNKNOWN_CONSTRAINT",
                    f"Constraint '{constraint.type}' is not implemented yet.",
                )
            )

    return diagnostics


def compile_design(path: str | Path, parts_path: str | Path = DEFAULT_PARTS_PATH) -> tuple[dict[str, Any] | None, list[Diagnostic]]:
    design, parse_diagnostics = parse_design(path)
    return _compile_parsed_design(design, parse_diagnostics, parts_path)


def compile_design_text(text: str, parts_path: str | Path, *, source_path: str = "design.proto") -> tuple[dict[str, Any] | None, list[Diagnostic]]:
    design, parse_diagnostics = parse_design_text(text, source_path=source_path)
    return _compile_parsed_design(design, parse_diagnostics, parts_path)


def _compile_parsed_design(design: Design | None, parse_diagnostics: list[Diagnostic], parts_path: str | Path) -> tuple[dict[str, Any] | None, list[Diagnostic]]:
    parts_bytes = read_bytes_bounded(parts_path, MAX_JSON_FILE_BYTES) if design is not None and _uses_placements(design) else None
    diagnostics = validate_design(design, parse_diagnostics, parts_path)
    if design is None or any(item.severity == "error" for item in diagnostics):
        return None, diagnostics

    library = load_parts(parts_path)
    by_id = part_index(library)
    constructs = []
    for construct in design.constructs:
        if _uses_placements(design):
            constructs.append(_compile_v2_construct(construct, by_id))
            continue
        parts = []
        for part_ref in construct.parts:
            part = by_id[part_ref.id]
            compiled_part = {
                "type": part_ref.type,
                "id": part_ref.id,
                "name": part.get("name", ""),
                "sequence": part.get("sequence", ""),
            }
            # Materialized catalog selections carry auditable metadata. Keep
            # these fields optional so the six-record toy fixture and older
            # IR consumers remain valid.
            if part.get("description"):
                compiled_part["description"] = part["description"]
            if part.get("description_zh"):
                compiled_part["description_zh"] = part["description_zh"]
            if part.get("source"):
                compiled_part["source"] = part["source"]
            if part.get("license"):
                compiled_part["license"] = part["license"]
            if part.get("resource_id"):
                compiled_part["resource_id"] = part["resource_id"]
            for field in (
                "sequence_kind",
                "review_status",
                "safety_status",
                "safety_flags",
                "design_eligibility",
                "evidence_refs",
            ):
                if field in part:
                    compiled_part[field] = part[field]
            sequence = str(compiled_part["sequence"])
            if sequence:
                compiled_part["sequence_sha256"] = hashlib.sha256(sequence.encode("ascii")).hexdigest()
            parts.append(compiled_part)
        constructs.append(
            {
                "name": construct.name,
                "topology": construct.topology,
                "parts": parts,
            }
        )

    ir = {
        "schema_version": DNA_IR_V2 if _uses_placements(design) else "proto-agent.ir.v1",
        "domain": "dna",
        "design_id": design.design_id,
        "chassis": design.chassis,
        "constructs": constructs,
        "constraints": [
            {"type": constraint.type, **constraint.params}
            for constraint in design.constraints
        ],
        "provenance": {
            "source": design.source_path,
            **({"parts_source": str(parts_path), "source_sha256": design.source_sha256, "parts_sha256": hashlib.sha256(parts_bytes).hexdigest()} if parts_bytes is not None else {}),
            **({"snapshot_id": library.get("version")} if library.get("version") else {}),
            **({"parts_library_id": library.get("library_id")} if library.get("library_id") else {}),
        },
    }
    if _uses_placements(design):
        from .exporters import validate_ir_for_export
        try:
            if parts_bytes != read_bytes_bounded(parts_path, MAX_JSON_FILE_BYTES):
                raise ValueError("Materialized library changed during compilation; retry against a stable selection.")
            validate_ir_for_export(ir)
        except ValueError as error:
            diagnostics.append(Diagnostic("error", design.source_path, 0, "DNA_V2_INTEGRITY_INVALID", str(error)))
            return None, diagnostics
    return ir, diagnostics


def _uses_placements(design: Design) -> bool:
    return any(construct.annotations or any(part.placement_declared or part.instance_id is not None or part.orientation != "forward" for part in construct.parts) for construct in design.constructs)


def _compile_v2_construct(construct: Any, by_id: dict[str, dict[str, Any]]) -> dict[str, Any]:
    if not construct.parts or len(construct.parts) > 10_000 or len(construct.annotations) > 1000:
        raise ValueError("DNA v2 requires 1-10000 occurrences and at most 1000 annotations per construct.")
    parts = []
    position = 0
    for part_ref, instance_id in zip(construct.parts, occurrence_ids(construct.parts)):
        original = by_id[part_ref.id]
        source_sequence = original.get("sequence", "")
        # Reject rather than normalize reviewed source bytes. The original hash
        # remains distinct from the placed sequence hash, even for a palindrome.
        reverse = reverse_complement(source_sequence)
        source_hash = dna_sha256(source_sequence)
        if original.get("sequence_sha256", source_hash) != source_hash:
            raise ValueError(f"Source sequence digest mismatch for occurrence {instance_id}.")
        source_metadata = original.get("source")
        if isinstance(source_metadata, dict) and source_metadata.get("sequence_sha256", source_hash) != source_hash:
            raise ValueError(f"Source provenance sequence digest mismatch for occurrence {instance_id}.")
        source_direction = original.get("direction", 0)
        if isinstance(source_direction, bool) or not isinstance(source_direction, int) or source_direction not in {-1, 0, 1}:
            raise ValueError("Source biological direction must be -1, 0, or 1 when declared.")
        placement = placement_record(part_ref.orientation)
        sequence = reverse if part_ref.orientation == "reverse" else source_sequence
        part = {"type": part_ref.type, "id": part_ref.id, "name": original.get("name", ""), "sequence": sequence}
        for field in ("description", "description_zh", "source", "license", "resource_id", "sequence_kind", "review_status", "safety_status", "safety_flags", "design_eligibility", "evidence_refs"):
            if field in original:
                part[field] = original[field]
        part.update({"instance_id": instance_id, "placement": placement, "source_sequence_sha256": source_hash, "sequence_sha256": dna_sha256(sequence), "start": position, "end": position + len(sequence), "source_direction": source_direction, "direction": source_direction * (-1 if part_ref.orientation == "reverse" else 1)})
        parts.append(part)
        position += len(sequence)
    sequence = "".join(part["sequence"] for part in parts)
    return {"name": construct.name, "topology": construct.topology, "parts": parts, "sequence": sequence, "length": len(sequence), "sequence_sha256": dna_sha256(sequence), "annotations": [resolve_annotation(annotation.id, annotation.payload, parts) for annotation in construct.annotations]}


def _validate_topology(design: Design, parts: list[Any], diagnostics: list[Diagnostic]) -> None:
    types = [part.type for part in parts]
    if types[0] != "promoter":
        diagnostics.append(
            Diagnostic(
                "error",
                design.source_path,
                parts[0].line,
                "CONSTRUCT_MUST_START_WITH_PROMOTER",
                "Constructs must start with a promoter.",
            )
        )
    if types[-1] != "terminator":
        diagnostics.append(
            Diagnostic(
                "error",
                design.source_path,
                parts[-1].line,
                "CONSTRUCT_MUST_END_WITH_TERMINATOR",
                "Constructs must end with a terminator.",
            )
        )
    for index, part in enumerate(parts):
        if part.type == "cds" and (index == 0 or parts[index - 1].type != "rbs"):
            diagnostics.append(
                Diagnostic(
                    "error",
                    design.source_path,
                    part.line,
                    "CDS_MISSING_UPSTREAM_RBS",
                    f"CDS '{part.id}' should have an upstream RBS.",
                )
            )


def _validate_float_param(design: Design, diagnostics: list[Diagnostic], line: int, params: dict[str, str], key: str) -> None:
    if key not in params:
        diagnostics.append(
            Diagnostic(
                "error",
                design.source_path,
                line,
                "MISSING_CONSTRAINT_PARAM",
                f"gc_content requires {key}=<number>.",
            )
        )
        return
    try:
        value = float(params[key])
    except ValueError:
        diagnostics.append(
            Diagnostic(
                "error",
                design.source_path,
                line,
                "INVALID_CONSTRAINT_NUMBER",
                f"gc_content parameter '{key}' must be numeric.",
            )
        )
        return
    if value < 0 or value > 1:
        diagnostics.append(
            Diagnostic(
                "error",
                design.source_path,
                line,
                "CONSTRAINT_OUT_OF_RANGE",
                f"gc_content parameter '{key}' must be between 0 and 1.",
            )
        )
