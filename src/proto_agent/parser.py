from __future__ import annotations

from pathlib import Path
import hashlib

from .models import DECLARED_CONSTRUCT_TOPOLOGIES, Constraint, Construct, Design, Diagnostic, PartRef, SourceAnnotation
from .json_validation import strict_json_loads
from .dna_placement import validate_annotation_declaration, valid_local_id
from .security import MAX_TEXT_FILE_BYTES, SecurityBoundaryError, read_text_bounded

PART_TYPES = {"promoter", "rbs", "cds", "terminator"}


def parse_design(path: str | Path) -> tuple[Design | None, list[Diagnostic]]:
    source = Path(path)
    try:
        text = read_text_bounded(source, MAX_TEXT_FILE_BYTES)
    except (FileNotFoundError, SecurityBoundaryError):
        return None, [
            Diagnostic(
                "error",
                str(source),
                0,
                "FILE_NOT_FOUND",
                "Design file was not found or could not be read safely.",
            )
        ]

    return parse_design_text(text, source_path=str(source))


def parse_design_text(text: str, *, source_path: str = "design.proto") -> tuple[Design | None, list[Diagnostic]]:
    """Parse bounded source without writing a temporary design file."""
    source = Path(source_path)
    diagnostics: list[Diagnostic] = []
    design: Design | None = None
    current_construct: Construct | None = None
    if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_TEXT_FILE_BYTES:
        return None, [Diagnostic("error", str(source), 0, "DESIGN_TEXT_LIMIT", "Design source exceeds its byte limit.")]
    for index, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        # JSON annotation content may itself contain '#'; strip trailing comments
        # only from the line-oriented non-annotation grammar.
        if line.split(None, 1)[0] != "annotation":
            line = line.split("#", 1)[0].rstrip()

        tokens = line.split()

        if tokens[0] == "design":
            if len(tokens) != 4 or tokens[2] != "chassis":
                diagnostics.append(
                    Diagnostic(
                        "error",
                        str(source),
                        index,
                        "INVALID_DESIGN_HEADER",
                        "Expected: design <design_id> chassis <chassis_id>",
                    )
                )
                continue
            design = Design(tokens[1], tokens[3], str(source))
            design.source_sha256 = hashlib.sha256(text.encode("utf-8")).hexdigest()
            current_construct = None
            continue

        if design is None:
            diagnostics.append(
                Diagnostic(
                    "error",
                    str(source),
                    index,
                    "MISSING_DESIGN_HEADER",
                    "The file must start with a design header.",
                    "Add: design <design_id> chassis <chassis_id>",
                )
            )
            continue

        if tokens[0] == "construct":
            if len(tokens) != 2 or not tokens[1].endswith(":"):
                diagnostics.append(
                    Diagnostic(
                        "error",
                        str(source),
                        index,
                        "INVALID_CONSTRUCT",
                        "Expected: construct <name>:",
                    )
                )
                current_construct = None
                continue
            current_construct = Construct(tokens[1][:-1], index)
            design.constructs.append(current_construct)
            continue

        if tokens[0] == "constraint":
            if len(tokens) < 2:
                diagnostics.append(
                    Diagnostic(
                        "error",
                        str(source),
                        index,
                        "INVALID_CONSTRAINT",
                        "Expected: constraint <type> key=value ...",
                    )
                )
                continue
            params: dict[str, str] = {}
            for token in tokens[2:]:
                if "=" not in token:
                    diagnostics.append(
                        Diagnostic(
                            "error",
                            str(source),
                            index,
                            "INVALID_CONSTRAINT_PARAM",
                            f"Constraint parameter must use key=value syntax: {token}",
                        )
                    )
                    continue
                key, value = token.split("=", 1)
                params[key] = value
            design.constraints.append(Constraint(tokens[1], index, params))
            current_construct = None
            continue

        if tokens[0] == "topology":
            if current_construct is None:
                diagnostics.append(
                    Diagnostic(
                        "error",
                        str(source),
                        index,
                        "CONSTRUCT_TOPOLOGY_OUTSIDE_CONSTRUCT",
                        "Topology declarations must appear inside a construct block.",
                        "Add topology linear or topology circular below a construct declaration.",
                    )
                )
                continue
            if len(tokens) != 2 or tokens[1] not in DECLARED_CONSTRUCT_TOPOLOGIES:
                diagnostics.append(
                    Diagnostic(
                        "error",
                        str(source),
                        index,
                        "CONSTRUCT_TOPOLOGY_INVALID",
                        "Expected: topology linear or topology circular",
                        "Omit the declaration when construct topology is unknown.",
                    )
                )
                continue
            if current_construct.topology != "unknown":
                diagnostics.append(
                    Diagnostic(
                        "error",
                        str(source),
                        index,
                        "CONSTRUCT_TOPOLOGY_DUPLICATE",
                        f"Construct '{current_construct.name}' declares topology more than once.",
                    )
                )
                continue
            current_construct.topology = "linear" if tokens[1] == "linear" else "circular"
            continue

        if tokens[0] == "annotation":
            if current_construct is None:
                diagnostics.append(Diagnostic("error", str(source), index, "ANNOTATION_OUTSIDE_CONSTRUCT", "Annotations must appear inside a construct block."))
                continue
            try:
                declaration = line.split(None, 2)
                if len(declaration) != 3 or not valid_local_id(declaration[1]):
                    raise ValueError("Expected: annotation <local_id> <bounded JSON object>")
                payload = strict_json_loads(declaration[2], max_bytes=65536)
                validate_annotation_declaration(payload)
                if any(item.id == declaration[1] for item in current_construct.annotations):
                    raise ValueError("Annotation IDs must be unique within a construct.")
                if len(current_construct.annotations) >= 1000:
                    raise ValueError("A construct may declare at most 1000 annotations.")
                current_construct.annotations.append(SourceAnnotation(declaration[1], index, payload))
            except ValueError as error:
                diagnostics.append(Diagnostic("error", str(source), index, "ANNOTATION_INVALID", str(error)))
            continue

        if tokens[0] in PART_TYPES:
            if current_construct is None:
                diagnostics.append(
                    Diagnostic(
                        "error",
                        str(source),
                        index,
                        "PART_OUTSIDE_CONSTRUCT",
                        "Part declarations must appear inside a construct block.",
                    )
                )
                continue
            if not 2 <= len(tokens) <= 4:
                diagnostics.append(
                    Diagnostic(
                        "error",
                        str(source),
                        index,
                        "INVALID_PART",
                        "Expected: <part_type> <part_id> [instance=<local_id>] [orientation=forward|reverse]",
                    )
                )
                continue
            options: dict[str, str] = {}
            valid = True
            for token in tokens[2:]:
                key, separator, value = token.partition("=")
                if not separator or key not in {"instance", "orientation"} or key in options:
                    valid = False
                    break
                options[key] = value
            if (not valid or ("instance" in options and not valid_local_id(options["instance"]))
                    or options.get("orientation", "forward") not in {"forward", "reverse"}):
                diagnostics.append(Diagnostic("error", str(source), index, "PART_PLACEMENT_INVALID", "Part placement requires unique instance=<local_id> and orientation=forward|reverse options."))
                continue
            current_construct.parts.append(PartRef(tokens[0], tokens[1], index, options.get("instance"), options.get("orientation", "forward"), bool(options)))
            continue

        diagnostics.append(
            Diagnostic(
                "error",
                str(source),
                index,
                "UNKNOWN_STATEMENT",
                f"Unknown statement: {tokens[0]}",
            )
        )

    if design is None and not diagnostics:
        diagnostics.append(
            Diagnostic(
                "error",
                str(source),
                0,
                "EMPTY_DESIGN",
                "No design declaration found.",
            )
        )

    return design, diagnostics
