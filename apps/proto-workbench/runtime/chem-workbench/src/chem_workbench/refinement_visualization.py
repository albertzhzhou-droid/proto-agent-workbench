"""Result-bound views of discrete refinement evaluations, with exact data tables.

The existing viewer accepts the numeric scene shape. Its label branch must add
``evaluated_geometry`` before this adapter is wired into the frontend: the current
fallback label is ETKDG, which would be incorrect for these scenes. Its current
float-based coordinate table/export must also use the exact table retained here.
No geometry generation, interpolation, approval, external file access or backend
execution occurs in this adapter.
"""

from __future__ import annotations

import copy
import math
from decimal import Decimal, localcontext
from typing import Any

from chem_workbench.execution_validation import verify_hash
from chem_workbench.molecular_refinement import (
    validate_refinement_result,
    validate_refinement_spec,
)
from chem_workbench.visualization import content_hash

VIEW_VERSION = "molecular-refinement-view/v1"


def _text(value: Decimal) -> str:
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return "0" if rendered in {"-0", "0", ""} else rendered


def _display_number(value: str) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("INVALID_GEOMETRY: refinement display projection is not finite")
    return number


def _gradient_summary(gradient: list[list[str]]) -> dict[str, Any]:
    with localcontext() as context:
        context.prec = 80
        components = [Decimal(value) for row in gradient for value in row]
        maximum = max(value.copy_abs() for value in components)
        rms = (sum((v * v for v in components), Decimal(0)) / len(components)).sqrt()
    return {
        "maximum_absolute_component": _text(maximum),
        "rms_component": _text(rms),
        "units": "hartree/bohr",
        "component_count": len(components),
        "rms_arithmetic_significant_digits": 80,
        "derivation": "Absolute maximum and RMS of recorded Cartesian gradient components",
        "scientific_accuracy_inferred": False,
    }


def _evaluated_frame(
    spec: dict[str, Any], result: dict[str, Any], frame: dict[str, Any]
) -> dict[str, Any]:
    geometry = frame["geometry"]
    table = [
        {
            "index": index,
            "id": atom["id"],
            "element": atom["element"],
            "position_angstrom": list(atom["position"]),
            "gradient_hartree_per_bohr": list(frame["gradient_hartree_per_bohr"][index]),
        }
        for index, atom in enumerate(geometry["atoms"])
    ]
    atoms = [
        {
            "id": row["id"],
            "element": row["element"],
            "position": [_display_number(value) for value in row["position_angstrom"]],
        }
        for row in table
    ]
    with localcontext() as context:
        context.prec = 512
        maximum_error = max(
            (Decimal.from_float(number) - Decimal(exact)).copy_abs()
            for row, atom in zip(table, atoms, strict=True)
            for exact, number in zip(row["position_angstrom"], atom["position"], strict=True)
        )
    binding = {
        "source_hash": spec["source_binding"]["source_hash"],
        "candidate_hash": spec["source_binding"]["candidate_hash"],
        "spec_hash": spec["spec_hash"],
        "result_hash": result["result_hash"],
        "frame_hash": frame["frame_hash"],
        "evaluated_geometry_hash": geometry["geometry_hash"],
        "atom_identity_hash": spec["source_binding"]["atom_identity_hash"],
        "raw_input_artifact_id": frame["raw_input_artifact_id"],
        "raw_result_artifact_id": frame["raw_result_artifact_id"],
    }
    origin = {
        "worker_record": "Worker-recorded",
        "synthetic_validation": "Synthetic validation",
        "imported_unverified": "Unverified imported",
    }[result["evidence_origin"]]
    scene = {
        "version": "display-geometry/v1",
        "object_id": f"refinement-evaluation-{frame['evaluation_index']}",
        "kind": "Molecule",
        "units": "angstrom",
        "atoms": atoms,
        "bonds": [],
        "cell": None,
        "unit_cell_atoms": len(atoms),
        "provenance": "evaluated_geometry",
        "evidence_origin": result["evidence_origin"],
        "method": spec["profile"]["method"] + "/" + spec["profile"]["basis"],
        "description": (
            f"{origin} discrete gradient-evaluation geometry. Exact coordinates and gradients "
            "are in coordinate_table; these numeric positions are a rendering projection. "
            "Atom-only view: no bonds, physical motion, optical color or minimum is inferred."
        ),
        "source_hash": binding["source_hash"],
        "subject_hash": binding["candidate_hash"] or geometry["geometry_hash"],
        "source_references": [copy.deepcopy(spec["source_binding"]["artifact"])],
        "refinement_binding": binding,
        "coordinate_table": table,
        "projection": {
            "kind": "binary64_rendering_only",
            "exact_coordinate_table_hash": content_hash(table),
            "rendered_atoms_hash": content_hash(atoms),
            "maximum_absolute_coordinate_error_angstrom": _text(maximum_error),
            "rounding_present": maximum_error != 0,
            "display_scale": 1,
        },
    }
    scene["geometry_hash"] = content_hash(scene)
    return {
        **binding,
        "evaluation_index": frame["evaluation_index"],
        "optimizer_iteration": frame["optimizer_iteration"],
        "step_status": frame["step_status"],
        "reevaluates_frame_hash": frame["reevaluates_frame_hash"],
        "elapsed_wall_seconds": frame["elapsed_wall_seconds"],
        "physical_time_s": None,
        "energy_hartree": frame["energy_hartree"],
        "gradient_summary": _gradient_summary(frame["gradient_hartree_per_bohr"]),
        "coordinate_table": table,
        "scene": scene,
    }


def build_refinement_view(spec: object, result: object) -> dict[str, Any]:
    """Validate supplied records and return detached exact/discrete display data.

    Embedded QCSchema bytes are verified by the scientific record validator.
    External artifact files and claimed origin are not authenticated here. A
    caller must retain its independently verified host/runtime evidence; no
    execution authorization is created by presenting a valid display record.
    """
    spec = validate_refinement_spec(spec)
    result = validate_refinement_result(spec, result)
    frames = [_evaluated_frame(spec, result, frame) for frame in result["trajectory"]]
    points = [
        {
            "evaluation_index": frame["evaluation_index"],
            "optimizer_iteration": frame["optimizer_iteration"],
            "step_status": frame["step_status"],
            "frame_hash": frame["frame_hash"],
            "elapsed_wall_seconds": frame["elapsed_wall_seconds"],
            "physical_time_s": None,
            "energy_hartree": frame["energy_hartree"],
            "max_gradient_component_hartree_per_bohr": frame["gradient_summary"][
                "maximum_absolute_component"
            ],
            "rms_gradient_component_hartree_per_bohr": frame["gradient_summary"]["rms_component"],
            "plot_projection": {
                "elapsed_wall_seconds": _display_number(frame["elapsed_wall_seconds"]),
                "energy_hartree": _display_number(frame["energy_hartree"]),
                "max_gradient_component_hartree_per_bohr": _display_number(
                    frame["gradient_summary"]["maximum_absolute_component"]
                ),
                "rms_gradient_component_hartree_per_bohr": _display_number(
                    frame["gradient_summary"]["rms_component"]
                ),
            },
        }
        for frame in frames
    ]
    value = {
        "version": VIEW_VERSION,
        "source_binding": copy.deepcopy(spec["source_binding"]),
        "spec_hash": spec["spec_hash"],
        "result_hash": result["result_hash"],
        "runtime_binding_hash": result["runtime_binding_hash"],
        "basis_binding_hash": result["basis_binding_hash"],
        "evidence_origin": result["evidence_origin"],
        "state": result["state"],
        "convergence": copy.deepcopy(result["convergence"]),
        "failure": copy.deepcopy(result["failure"]),
        "timing": copy.deepcopy(result["timing"]),
        "final_frame_hash": result["final_frame_hash"],
        "frames": frames,
        "scene": {"structures": [frame["scene"] for frame in frames], "unavailable": []},
        "trajectory_chart": {
            "points": points,
            "default_x": "evaluation_index",
            "available_x": ["evaluation_index", "elapsed_wall_seconds"],
            "labels": {
                "evaluation_index": "Gradient evaluation index",
                "elapsed_wall_seconds": "Elapsed computation wall time / s",
                "energy_hartree": "Recorded electronic energy / hartree",
                "max_gradient_component_hartree_per_bohr": (
                    "Maximum gradient component / hartree bohr^-1"
                ),
                "rms_gradient_component_hartree_per_bohr": (
                    "RMS gradient component / hartree bohr^-1"
                ),
            },
            "sampling": "one point per retained successful gradient evaluation",
            "interpolation": None,
            "physical_time_s": None,
            "plot_projection_scope": (
                "Binary64 values for plotting only; exact point strings are authoritative"
            ),
        },
        "playback": {
            "clock": "evaluation_index",
            "sample_count": len(frames),
            "mode": "discrete_frames_only",
            "interpolation": None,
            "physical_duration_seconds": None,
        },
        "raw_artifacts": copy.deepcopy(result["raw_artifacts"]),
        "scope": {
            "record_validation": (
                "spec/result hashes, stable atom identity and embedded evaluated "
                "geometry/energy/gradient bindings"
            ),
            "external_artifact_files_rehashed": False,
            "origin_authenticated": False,
            "minimum_certified": False,
            "physical_trajectory": False,
            "material_appearance_predicted": False,
            "energy_comparison": (
                "Only this one spec/result is represented; no cross-composition ranking is produced"
            ),
            "scientific_accuracy_inferred": False,
        },
        "execution_authority": False,
    }
    value["view_hash"] = content_hash(value)
    return copy.deepcopy(value)


def validate_refinement_view(spec: object, result: object, value: object) -> dict[str, Any]:
    """Reject a rehashed scene/chart/table projection that changes validated records."""
    if not isinstance(value, dict):
        raise ValueError("INVALID_ARGUMENT: refinement view must be an object")
    verify_hash(value, "view_hash")
    expected = build_refinement_view(spec, result)
    if content_hash(value) != content_hash(expected):
        raise ValueError("APPROVAL_STALE: refinement display differs from validated result")
    return expected
