"""Integrity validation for exported design data; hashes are not external attestation."""

from __future__ import annotations

import json
import math
from typing import Any

from chem_workbench.execution_validation import verify_hash
from chem_workbench.visualization import content_hash


def verify_design_record(value: object) -> None:
    if not isinstance(value, dict) or len(json.dumps(value, allow_nan=False)) > 20 * 1024 * 1024:
        raise ValueError("DESIGN_IMPORT_LIMIT")
    record: dict[str, Any] = value
    verify_hash(record, "record_hash")
    if (
        record.get("version") != "design-run/v1"
        or record.get("state") not in {"completed", "failed", "rejected", "needs_input"}
        or not isinstance(record.get("request"), dict)
        or not isinstance(record.get("interfaces"), list)
        or len(record["interfaces"]) > 4
        or not isinstance(record.get("trace"), list)
        or len(record["trace"]) > 6
    ):
        raise ValueError("DESIGN_IMPORT_RECORD_SHAPE")
    from chem_workbench.design_studio import INTERFACES, WORKFLOWS, validate_study

    validate_study(record["request"].get("study"))
    if not isinstance(record["request"].get("prompt"), str):
        raise ValueError("DESIGN_IMPORT_PROMPT")
    for step in record["trace"]:
        if (
            not isinstance(step, dict)
            or step.get("module") not in {*INTERFACES, *WORKFLOWS}
            or step.get("status") not in {"succeeded", "failed"}
            or type(step.get("seconds")) not in (float, int)
            or not math.isfinite(step["seconds"])
            or step["seconds"] < 0
        ):
            raise ValueError("DESIGN_IMPORT_TRACE")
    if type(record.get("seconds")) not in (float, int) or record["seconds"] < 0:
        raise ValueError("DESIGN_IMPORT_TIMING")
    if record.get("decision") is not None and (
        not isinstance(record["decision"], dict)
        or not isinstance(record["decision"].get("message"), str)
    ):
        raise ValueError("DESIGN_IMPORT_DECISION")
    if record.get("request_hash") != content_hash(record["request"]) or record.get(
        "study_hash"
    ) != content_hash(record["request"]["study"]):
        raise ValueError("DESIGN_IMPORT_REQUEST_BINDING")
    if record.get("plan"):
        verify_hash(record["plan"], "logical_plan_hash")
    candidates: dict[str, list[dict[str, Any]]] = {}
    for family in ("organic", "inorganic"):
        library = record.get(family)
        candidates[family] = []
        if library is None:
            continue
        if not isinstance(library, dict) or not isinstance(library.get("candidates"), list):
            raise ValueError("DESIGN_IMPORT_CANDIDATE_LIBRARY")
        if len(library["candidates"]) > 24:
            raise ValueError("DESIGN_IMPORT_CANDIDATE_LIMIT")
        if "result_hash" in library:
            verify_hash(library, "result_hash")
        for candidate in library["candidates"]:
            verify_hash(candidate, "candidate_hash")
            geometry = candidate.get("geometry")
            verify_hash(geometry, "geometry_hash")
            if (
                candidate.get("family") != family
                or geometry.get("object_id") != candidate.get("id")
                or geometry.get("source_hash") != candidate.get("request_hash")
                or geometry.get("subject_hash") != candidate.get("identity_hash")
                or not isinstance(geometry.get("atoms"), list)
                or not 1 <= len(geometry["atoms"]) <= 512
            ):
                raise ValueError("DESIGN_IMPORT_GEOMETRY_BINDING")
            candidates[family].append(candidate)
    selected = record.get("selected_pair")
    if selected is not None and (
        not isinstance(selected, dict)
        or set(selected) != {"organic", "inorganic"}
        or any(
            selected[family] not in {item["candidate_hash"] for item in candidates[family]}
            for family in ("organic", "inorganic")
        )
    ):
        raise ValueError("DESIGN_IMPORT_SELECTED_PAIR")
    for simulation in record["interfaces"]:
        verify_hash(simulation, "result_hash")
        verify_hash(simulation.get("mechanism"), "mechanism_hash")
        if (
            simulation.get("input_hash") != content_hash(simulation.get("inputs"))
            or not isinstance(simulation.get("series"), list)
            or not 2 <= len(simulation["series"]) <= 201
            or simulation.get("profile") not in INTERFACES
            or any(
                not isinstance(row, dict)
                or "time_s" not in row
                or any(type(n) not in (float, int) or not math.isfinite(n) for n in row.values())
                for row in simulation["series"]
            )
        ):
            raise ValueError("DESIGN_IMPORT_SIMULATION_BINDING")
        for family in ("organic", "inorganic"):
            candidate = simulation["inputs"][family + "_candidate"]
            if (
                candidate not in candidates[family]
                or simulation["candidate_hashes"][family] != content_hash(candidate)
                or simulation["inputs"]["spec"]["candidate_hashes"][family]
                != content_hash(candidate)
            ):
                raise ValueError("DESIGN_IMPORT_SIMULATION_CANDIDATE_BINDING")
    if record.get("interface_screening"):
        screening = record["interface_screening"]
        verify_hash(screening, "result_hash")
        if screening.get("simulations") != record["interfaces"]:
            raise ValueError("DESIGN_IMPORT_SCREENING_BINDING")
