from __future__ import annotations

from pathlib import Path

from .models import DECLARED_CONSTRUCT_TOPOLOGIES, Constraint, Construct, Design, Diagnostic, PartRef
from .security import MAX_TEXT_FILE_BYTES, SecurityBoundaryError, read_text_bounded

PART_TYPES = {"promoter", "rbs", "cds", "terminator"}


def parse_design(path: str | Path) -> tuple[Design | None, list[Diagnostic]]:
    source = Path(path)
    diagnostics: list[Diagnostic] = []
    design: Design | None = None
    current_construct: Construct | None = None

    try:
        lines = read_text_bounded(source, MAX_TEXT_FILE_BYTES).splitlines()
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

    for index, raw_line in enumerate(lines, start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

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
            if len(tokens) != 2:
                diagnostics.append(
                    Diagnostic(
                        "error",
                        str(source),
                        index,
                        "INVALID_PART",
                        "Expected: <part_type> <part_id>",
                    )
                )
                continue
            current_construct.parts.append(PartRef(tokens[0], tokens[1], index))
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
