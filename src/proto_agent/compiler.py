from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from .models import IR_CONSTRUCT_TOPOLOGIES, Design, Diagnostic
from .parser import parse_design
from .parts import DEFAULT_PARTS_PATH, load_parts, part_index


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
    diagnostics = validate_design(design, parse_diagnostics, parts_path)
    if design is None or any(item.severity == "error" for item in diagnostics):
        return None, diagnostics

    library = load_parts(parts_path)
    by_id = part_index(library)
    constructs = []
    for construct in design.constructs:
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
        "schema_version": "proto-agent.ir.v1",
        "domain": "dna",
        "design_id": design.design_id,
        "chassis": design.chassis,
        "constructs": constructs,
        "constraints": [
            {"type": constraint.type, **constraint.params}
            for constraint in design.constraints
        ],
        "provenance": {
            "source": str(path),
            **({"snapshot_id": library.get("version")} if library.get("version") else {}),
            **({"parts_library_id": library.get("library_id")} if library.get("library_id") else {}),
        },
    }
    return ir, diagnostics


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
