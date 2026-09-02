from __future__ import annotations

from pathlib import Path
from typing import Any

from .compiler import compile_design
from .models import Diagnostic
from .parts import DEFAULT_PARTS_PATH

RESTRICTION_SITES = {
    "BsaI": "GGTCTC",
    "BsmBI": "CGTCTC",
    "EcoRI": "GAATTC",
    "BamHI": "GGATCC",
    "HindIII": "AAGCTT",
    "XbaI": "TCTAGA",
    "SpeI": "ACTAGT",
    "PstI": "CTGCAG",
}


def validate_sequences(path: str | Path, parts_path: str | Path = DEFAULT_PARTS_PATH) -> tuple[dict[str, Any], list[Diagnostic]]:
    ir, diagnostics = compile_design(path, parts_path)
    if ir is None:
        return {
            "ok": False,
            "summary": "Design did not compile, so sequence constraints were not evaluated.",
            "constructs": [],
        }, diagnostics

    report = {
        "ok": True,
        "summary": "Sequence constraints passed.",
        "constructs": [],
        "constraints": ir.get("constraints", []),
    }

    sequence_diagnostics: list[Diagnostic] = []
    for construct in ir.get("constructs", []):
        sequence = _construct_sequence(construct)
        construct_report = {
            "construct": construct.get("name", ""),
            "length": len(sequence),
            "gc_content": round(_gc_content(sequence), 3),
            "checks": [],
        }
        if not sequence:
            sequence_diagnostics.append(
                Diagnostic(
                    "error",
                    str(path),
                    0,
                    "CONSTRUCT_SEQUENCE_EMPTY",
                    f"Construct '{construct.get('name', '')}' has no assembled sequence.",
                )
            )

        for constraint in ir.get("constraints", []):
            if constraint.get("type") == "gc_content":
                _check_gc_content(path, construct.get("name", ""), sequence, constraint, construct_report, sequence_diagnostics)
            elif constraint.get("type") == "avoid_restriction_site":
                _check_restriction_site(path, construct.get("name", ""), sequence, constraint, construct_report, sequence_diagnostics)

        report["constructs"].append(construct_report)

    diagnostics.extend(sequence_diagnostics)
    report["ok"] = not any(item.severity == "error" for item in diagnostics)
    if not report["ok"]:
        report["summary"] = "One or more sequence constraints failed."
    return report, diagnostics


def _construct_sequence(construct: dict[str, Any]) -> str:
    return "".join(part.get("sequence", "") for part in construct.get("parts", [])).upper()


def _gc_content(sequence: str) -> float:
    if not sequence:
        return 0.0
    return (sequence.count("G") + sequence.count("C")) / len(sequence)


def _check_gc_content(
    path: str | Path,
    construct_name: str,
    sequence: str,
    constraint: dict[str, Any],
    construct_report: dict[str, Any],
    diagnostics: list[Diagnostic],
) -> None:
    minimum = float(constraint.get("min", 0))
    maximum = float(constraint.get("max", 1))
    gc = _gc_content(sequence)
    ok = minimum <= gc <= maximum
    construct_report["checks"].append(
        {
            "type": "gc_content",
            "ok": ok,
            "value": round(gc, 3),
            "min": minimum,
            "max": maximum,
        }
    )
    if not ok:
        diagnostics.append(
            Diagnostic(
                "error",
                str(path),
                0,
                "GC_CONTENT_OUT_OF_RANGE",
                f"Construct '{construct_name}' GC content {gc:.3f} is outside {minimum:.3f}..{maximum:.3f}.",
            )
        )


def _check_restriction_site(
    path: str | Path,
    construct_name: str,
    sequence: str,
    constraint: dict[str, Any],
    construct_report: dict[str, Any],
    diagnostics: list[Diagnostic],
) -> None:
    enzyme = str(constraint.get("enzyme", ""))
    site = RESTRICTION_SITES.get(enzyme)
    if site is None:
        construct_report["checks"].append(
            {
                "type": "avoid_restriction_site",
                "ok": False,
                "enzyme": enzyme,
                "known": False,
            }
        )
        diagnostics.append(
            Diagnostic(
                "warning",
                str(path),
                0,
                "UNKNOWN_RESTRICTION_ENZYME",
                f"Restriction enzyme '{enzyme}' is not in the local recognition-site table.",
            )
        )
        return

    reverse_site = _reverse_complement(site)
    positions = _find_all(sequence, site)
    if reverse_site != site:
        positions.extend(_find_all(sequence, reverse_site))
    positions = sorted(set(positions))
    ok = not positions
    construct_report["checks"].append(
        {
            "type": "avoid_restriction_site",
            "ok": ok,
            "enzyme": enzyme,
            "site": site,
            "positions": positions,
        }
    )
    if not ok:
        diagnostics.append(
            Diagnostic(
                "error",
                str(path),
                0,
                "RESTRICTION_SITE_PRESENT",
                f"Construct '{construct_name}' contains {enzyme} recognition site at 1-based positions: {positions}.",
            )
        )


def _find_all(sequence: str, site: str) -> list[int]:
    positions = []
    start = 0
    while True:
        index = sequence.find(site, start)
        if index == -1:
            return positions
        positions.append(index + 1)
        start = index + 1


def _reverse_complement(sequence: str) -> str:
    table = str.maketrans("ACGTacgt", "TGCAtgca")
    return sequence.translate(table)[::-1].upper()
