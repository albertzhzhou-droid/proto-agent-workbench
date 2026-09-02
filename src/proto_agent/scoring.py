from __future__ import annotations

from pathlib import Path
from typing import Any

from .compiler import compile_design
from .parts import DEFAULT_PARTS_PATH
from .sequence import validate_sequences


def score_design(path: str | Path, parts_path: str | Path = DEFAULT_PARTS_PATH) -> tuple[dict[str, Any], list[Any]]:
    ir, diagnostics = compile_design(path, parts_path)
    if ir is None:
        return {
            "ok": False,
            "score": 0,
            "summary": "Design did not compile.",
        }, diagnostics

    sequence_report, sequence_diagnostics = validate_sequences(path, parts_path)
    diagnostics.extend(sequence_diagnostics)

    construct_scores = []
    for construct in ir.get("constructs", []):
        sequence = "".join(part.get("sequence", "") for part in construct.get("parts", []))
        gc = _gc_content(sequence)
        construct_scores.append(
            {
                "construct": construct["name"],
                "length": len(sequence),
                "gc_content": round(gc, 3),
                "has_sequence": bool(sequence),
            }
        )

    return {
        "ok": sequence_report["ok"],
        "score": 100 if sequence_report["ok"] else 40,
        "summary": "Toy score: syntax, part lookup, topology, and sequence constraints passed."
        if sequence_report["ok"]
        else "Toy score: sequence constraints did not pass.",
        "constructs": construct_scores,
        "sequence_validation": sequence_report,
    }, diagnostics


def _gc_content(sequence: str) -> float:
    if not sequence:
        return 0.0
    bases = sequence.upper()
    return (bases.count("G") + bases.count("C")) / len(bases)
