"""Reject source/profile conflicts instead of silently changing the requested science."""

from __future__ import annotations

from chem_workbench.compiler import CompilationResult


def require_profile(snapshot: CompilationResult, object_id: str, profile: str) -> None:
    if snapshot.document is None:
        raise ValueError("NEEDS_INPUT: compile the source first")
    objects = snapshot.document["objects"]
    for obj in objects:
        payload = obj["payload"]
        if payload.get("target_reference") != object_id:
            continue
        if obj["kind"] == "CalculationSpec":
            expected = "hf" if profile == "water" else "emt"
            if (
                payload.get("task") != "single_point"
                or payload.get("properties") != ["energy"]
                or payload.get("method", {}).get("name", "").lower() != expected
            ):
                raise ValueError(
                    "UNSUPPORTED_PROFILE: source task or method conflicts with this profile"
                )
            if profile == "water" and payload.get("basis", {}).get("name", "").lower() != "sto-3g":
                raise ValueError("UNSUPPORTED_PROFILE: the water profile requires STO-3G")
        elif obj["kind"] == "ElectronicState":
            if (
                profile != "water"
                or payload.get("model") != "finite"
                or payload.get("charge") != 0
                or payload.get("multiplicity") != 1
            ):
                raise ValueError(
                    "UNSUPPORTED_PROFILE: declared electronic state conflicts with this profile"
                )
        elif obj["kind"] == "ConditionSet":
            if (
                payload.get("phase") != ("gas" if profile == "water" else "solid")
                or payload.get("temperature") != {"value": 0, "unit": "kelvin"}
                or set(payload) - {"target_reference", "phase", "temperature"}
            ):
                raise ValueError(
                    "UNSUPPORTED_PROFILE: environmental conditions are outside the pinned profile"
                )
