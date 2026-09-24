"""Bounded model-free tools. Model arguments cannot grant execution authority."""

from __future__ import annotations

import copy
import json
import uuid
from decimal import Decimal
from typing import Any

from jsonschema import Draft202012Validator  # type: ignore[import-untyped]

from chem_workbench.chemir.constraints import canonical_decimal
from chem_workbench.compiler import CompilationResult
from chem_workbench.paths import resource_root
from chem_workbench.readiness import require_profile
from chem_workbench.visualization import content_hash, geometry_for_object

REF = {"type": "string", "minLength": 1, "maxLength": 160}
SCALES = {
    "type": "array",
    "minItems": 2,
    "maxItems": 9,
    "uniqueItems": True,
    "items": {"type": "number", "minimum": 0.95, "maximum": 1.05},
}


def _schema(properties: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": list(properties),
        "additionalProperties": False,
    }


def _output(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": required if required is not None else list(properties),
        "additionalProperties": True,
    }


TOOLS: dict[str, dict[str, Any]] = {
    "capabilities_list": {
        "description": "List the admitted local tool and future compute profiles.",
        "input": _schema({}),
        "output": _output(
            {
                "tools": {"type": "array"},
                "execution_available": {"type": "boolean"},
                "compute_candidates": {"type": "array"},
            }
        ),
    },
    "object_inspect": {
        "description": "Inspect one object in the current compiled snapshot.",
        "input": _schema({"object_id": REF}),
        "output": _output(
            {
                "object_id": REF,
                "kind": {"type": "string"},
                "subject_hash": {"type": "string"},
                "has_coordinates": {"type": "boolean"},
                "source_references": {"type": "array"},
            }
        ),
    },
    "structure_preview": {
        "description": "Derive bounded, source-bound display geometry.",
        "input": _schema({"object_id": REF}),
        "output": _output(
            {
                "object_id": REF,
                "geometry_hash": {"type": "string"},
                "units": {"type": "string"},
                "atom_count": {"type": "integer", "minimum": 0},
            }
        ),
    },
    "plan_water_single_point": {
        "description": (
            "Prepare the explicitly labeled water installation geometry for HF/STO-3G "
            "review. No execution. Never substitute supplied experimental geometry."
        ),
        "input": _schema({"object_id": REF}),
        "output": _output(
            {
                "version": {"const": "water-proposal/v1"},
                "geometry": {"type": "object"},
                "execution_authorized": {"const": False},
            }
        ),
    },
    "plan_molecular_single_point": {
        "description": "Prepare an explicitly requested source-generated molecular conformer "
        "for neutral-singlet HF/STO-3G gas/0 K single-point review. Connected "
        "organic molecules, 8-32 heavy atoms. No execution, optimization, "
        "measured-coordinate substitution or physical-property claims.",
        "input": _schema({"object_id": REF}),
        "output": _output(
            {
                "version": {"const": "molecular-proposal/v1"},
                "geometry": {"type": "object"},
                "execution_authorized": {"const": False},
            }
        ),
    },
    "plan_cu_lattice_scan": {
        "description": "Propose 2-9 fixed-composition copper cell scales in [0.95, 1.05]. "
        "Draft only; never executes or ranks candidates.",
        "input": _schema({"object_id": REF, "scale_factors": SCALES}),
        "output": _output(
            {
                "version": {"const": "cu-scan-proposal/v1"},
                "status": {"const": "draft_not_executable"},
                "method_profile_id": {"const": "ase.emt.cu.scan.v1"},
                "execution_authorized": {"const": False},
                "candidates": {"type": "array", "minItems": 1},
            }
        ),
    },
}


def tool_inventory() -> list[dict[str, Any]]:
    return [
        {
            "name": name,
            **copy.deepcopy(contract),
            "version": "1",
            "permission": "read_and_derive",
            "compute": False,
            "network": False,
            "definition_hash": content_hash(contract),
        }
        for name, contract in TOOLS.items()
    ]


def object_from_snapshot(snapshot: CompilationResult, reference: str) -> dict[str, Any]:
    if not snapshot.success or snapshot.document is None:
        raise ValueError("NEEDS_INPUT: compile valid source before using tools")
    for obj in snapshot.document["objects"]:
        if obj["id"] == reference:
            return copy.deepcopy(obj)
    raise ValueError("REFERENCE_OUT_OF_SCOPE: object is absent from the current snapshot")


def copper_plan(
    obj: dict[str, Any], scales: list[float], semantic_hash: str | None
) -> dict[str, Any]:
    payload = obj["payload"]
    if obj["kind"] != "PeriodicStructure" or "sites" not in payload or "lattice" not in payload:
        raise ValueError("UNSUPPORTED_PROFILE: import an explicit periodic copper structure first")
    if not 1 <= len(payload["sites"]) <= 32:
        raise ValueError("UNSUPPORTED_PROFILE: copper draft profile supports 1-32 sites")
    if any(s["element"] != "Cu" or s["occupancy"] != 1 for s in payload["sites"]):
        raise ValueError("UNSUPPORTED_PROFILE: only fully occupied, pure copper is admitted")
    candidates = []
    for scale in sorted(scales):
        factor = Decimal(str(scale))
        lattice = [
            [canonical_decimal(str(Decimal(v) * factor)) for v in row]
            for row in payload["lattice"]["vectors"]
        ]
        candidate = {
            "scale": canonical_decimal(str(factor)),
            "lattice_angstrom": lattice,
            "fractional_sites": copy.deepcopy(payload["sites"]),
        }
        candidate["candidate_hash"] = content_hash(candidate)
        candidates.append(candidate)
    plan = {
        "version": "cu-scan-proposal/v1",
        "status": "draft_not_executable",
        "subject_ref": obj["id"],
        "subject_hash": content_hash(obj),
        "source_semantic_hash": semantic_hash,
        "method_profile_id": "ase.emt.cu.scan.v1",
        "resource_profile_id": "local.smoke.v1",
        "candidates": candidates,
        "objective": "Compare EMT energy per atom for a fixed-composition cell scale batch",
        "normalization": "eV/atom",
        "execution_authorized": False,
        "results": [],
        "limitations": [
            "No execution or ranking has occurred.",
            "A resolved plan, budget approval and supervised runner are required.",
            "This is not a prediction of phase stability or catalytic activity.",
        ],
    }
    plan["logical_plan_hash"] = content_hash(plan)
    return plan


def invoke_tool(name: str, arguments: object, snapshot: CompilationResult) -> dict[str, Any]:
    """Host-owned dispatch shared by direct UI actions and the optional model."""
    request_id = str(uuid.uuid4())
    if name not in TOOLS:
        raise ValueError("UNKNOWN_TOOL: not in the first-party registry")
    errors = list(Draft202012Validator(TOOLS[name]["input"]).iter_errors(arguments))
    if errors:
        raise ValueError("INVALID_ARGUMENT: " + errors[0].message[:240])
    assert isinstance(arguments, dict)
    data: dict[str, Any]
    if name == "capabilities_list":
        data = {
            "tools": tool_inventory(),
            "execution_available": False,
            "compute_candidates": [
                "ase.emt.cu.scan.v1",
                "qcengine.psi4.hf_sto3g.smoke.v1",
                "qcengine.psi4.hf_sto3g.organic.v1",
            ],
        }
    else:
        obj = object_from_snapshot(snapshot, arguments["object_id"])
        if name in {"plan_water_single_point", "plan_cu_lattice_scan"}:
            require_profile(
                snapshot, obj["id"], "water" if name == "plan_water_single_point" else "copper"
            )
        if name == "object_inspect":
            data = {
                "object_id": obj["id"],
                "kind": obj["kind"],
                "subject_hash": content_hash(obj),
                "has_coordinates": "sites" in obj["payload"],
                "source_references": obj["source_references"],
                "diagnostics": [d.to_dict() for d in snapshot.diagnostics][:12],
            }
        elif name == "structure_preview":
            geometry = geometry_for_object(obj, snapshot.source_sha256)
            data = {
                k: geometry[k]
                for k in (
                    "object_id",
                    "geometry_hash",
                    "units",
                    "provenance",
                    "method",
                    "description",
                )
            }
            data["atom_count"] = len(geometry["atoms"])
        elif name == "plan_molecular_single_point":
            from chem_workbench.molecular_compute import molecular_proposal

            data = molecular_proposal(snapshot, obj["id"])
        elif name == "plan_water_single_point":
            if obj["kind"] != "Molecule" or not any(
                r.get("format") == "smiles" and r.get("value") in {"O", "[OH2]"}
                for r in obj["payload"].get("representations", [])
            ):
                raise ValueError("UNSUPPORTED_PROFILE: only explicit water is admitted")
            geometry = json.loads(
                (resource_root() / "examples/molecules/water-hf-sto3g-geometry.json").read_text(
                    encoding="utf-8"
                )
            )
            data = {
                "version": "water-proposal/v1",
                "object_id": obj["id"],
                "geometry": geometry,
                "source_hash": snapshot.source_sha256,
                "execution_authorized": False,
                "provenance": "installation_fixture_requires_explicit_review",
            }
            data["logical_plan_hash"] = content_hash(data)
        else:
            data = copper_plan(obj, arguments["scale_factors"], snapshot.semantic_hash)
    output_errors = list(Draft202012Validator(TOOLS[name]["output"]).iter_errors(data))
    if output_errors:
        raise ValueError("INVALID_TOOL_OUTPUT: " + output_errors[0].message[:240])
    return {
        "request_id": request_id,
        "tool_name": name,
        "contract_version": "1",
        "status": "succeeded",
        "data": data,
        "data_hash": content_hash(data),
        "source_hash": snapshot.source_sha256,
        "authority": "host_read_and_derive_only",
    }
