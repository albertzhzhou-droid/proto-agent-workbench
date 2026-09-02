from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

from .compiler import compile_design
from .parts import DEFAULT_PARTS_PATH
from .sequence import RESTRICTION_SITES, validate_sequences


def optimize_design(
    path: str | Path,
    parts_path: str | Path = DEFAULT_PARTS_PATH,
    backend: str = "auto",
) -> tuple[dict[str, Any], int]:
    ir, compile_diagnostics = compile_design(path, parts_path)
    selected_backend = _select_backend(backend)
    if ir is None:
        return {
            "ok": False,
            "backend": selected_backend,
            "mode": "suggestions",
            "summary": "Design did not compile, so optimization suggestions were not generated.",
            "suggestions": [],
            "diagnostics": [item.to_dict() for item in compile_diagnostics],
        }, 1

    sequence_report, sequence_diagnostics = validate_sequences(path, parts_path)
    suggestions = _suggest_repairs(ir, sequence_report)
    ok = sequence_report["ok"]
    payload = {
        "ok": ok,
        "backend": selected_backend,
        "mode": "suggestions",
        "summary": "No sequence optimization suggestions are needed."
        if ok
        else "Sequence constraints failed; review suggestions before editing the design.",
        "design_id": ir["design_id"],
        "suggestions": suggestions,
        "sequence_validation": sequence_report,
        "diagnostics": [item.to_dict() for item in sequence_diagnostics],
        "safety_notice": "This tool does not automatically rewrite biological sequences. Human review is required before applying any suggestion.",
    }
    return payload, 0


def _select_backend(requested: str) -> dict[str, Any]:
    available = importlib.util.find_spec("dnachisel") is not None
    if requested == "dnachisel" and not available:
        return {
            "name": "local_suggestions",
            "requested": requested,
            "dnachisel_available": False,
            "note": "DNA Chisel is not installed; using local suggestion backend.",
        }
    if requested in {"auto", "dnachisel"} and available:
        return {
            "name": "dnachisel",
            "requested": requested,
            "dnachisel_available": True,
            "note": "DNA Chisel package detected. Current adapter still returns reviewable suggestions only.",
        }
    return {
        "name": "local_suggestions",
        "requested": requested,
        "dnachisel_available": available,
        "note": "Using deterministic local suggestion backend.",
    }


def _suggest_repairs(ir: dict[str, Any], sequence_report: dict[str, Any]) -> list[dict[str, Any]]:
    suggestions: list[dict[str, Any]] = []
    constraints = sequence_report.get("constraints", [])
    by_construct = {construct["construct"]: construct for construct in sequence_report.get("constructs", [])}
    for construct in ir.get("constructs", []):
        name = construct["name"]
        report = by_construct.get(name, {})
        for check in report.get("checks", []):
            if check.get("ok"):
                continue
            if check.get("type") == "gc_content":
                suggestions.append(_gc_suggestion(name, check))
            elif check.get("type") == "avoid_restriction_site":
                suggestions.append(_restriction_suggestion(name, check))

    if not suggestions and not sequence_report.get("ok", False):
        suggestions.append(
            {
                "type": "manual_review",
                "priority": "high",
                "message": "Sequence validation failed, but no automated suggestion was available for the failing check.",
            }
        )
    if not constraints:
        suggestions.append(
            {
                "type": "add_constraints",
                "priority": "medium",
                "message": "No sequence constraints were declared. Add gc_content and avoid_restriction_site constraints before optimization.",
            }
        )
    return suggestions


def _gc_suggestion(construct_name: str, check: dict[str, Any]) -> dict[str, Any]:
    value = float(check.get("value", 0))
    minimum = float(check.get("min", 0))
    maximum = float(check.get("max", 1))
    if value < minimum:
        direction = "increase_gc"
        message = "GC content is below the declared range. Review part choices or use a codon-aware optimizer to raise GC content."
    elif value > maximum:
        direction = "decrease_gc"
        message = "GC content is above the declared range. Review part choices or use a codon-aware optimizer to lower GC content."
    else:
        direction = "review_gc"
        message = "GC content check failed unexpectedly. Review the compiled sequence."
    return {
        "type": "gc_content",
        "priority": "high",
        "construct": construct_name,
        "direction": direction,
        "observed": value,
        "min": minimum,
        "max": maximum,
        "message": message,
    }


def _restriction_suggestion(construct_name: str, check: dict[str, Any]) -> dict[str, Any]:
    enzyme = check.get("enzyme", "")
    site = check.get("site") or RESTRICTION_SITES.get(enzyme, "")
    return {
        "type": "avoid_restriction_site",
        "priority": "high",
        "construct": construct_name,
        "enzyme": enzyme,
        "site": site,
        "positions": check.get("positions", []),
        "message": "Restriction site is present. Review the affected part or use a sequence-aware optimizer before export/order review.",
    }
