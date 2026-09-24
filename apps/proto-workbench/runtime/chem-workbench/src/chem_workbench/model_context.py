"""Host-derived capability context; source data never changes tool or approval policy."""

from __future__ import annotations

import copy
import importlib
from typing import Any

from chem_workbench.compiler import CompilationResult
from chem_workbench.readiness import require_profile
from chem_workbench.tool_gateway import TOOLS

MAX_CONTEXT_OBJECTS = 64


def preview_preflight(obj: dict[str, Any]) -> None:
    """Cheap structural checks; later conformer generation can still fail explicitly."""
    payload = obj["payload"]
    if obj["kind"] == "PeriodicStructure":
        if "lattice" not in payload or "sites" not in payload:
            raise ValueError("MISSING_COORDINATES: attach the referenced CIF")
        if len(payload["sites"]) > 32:
            raise ValueError("ATOM_LIMIT: the periodic preview accepts at most 32 sites")
        if any(s["occupancy"] != 1 for s in payload["sites"]):
            raise ValueError("VIEW_UNSUPPORTED: partial occupancy has no explicit preview")
        return
    chemistry = importlib.import_module("rdkit.Chem")
    smiles = next(
        (r["value"] for r in payload.get("representations", []) if r["format"] == "smiles"), None
    )
    if not isinstance(smiles, str) or len(smiles) > 2048:
        raise ValueError("VIEW_UNSUPPORTED: bounded SMILES required")
    molecule = chemistry.MolFromSmiles(smiles)
    if molecule is None:
        raise ValueError("INVALID_STRUCTURE: invalid SMILES")
    if molecule.GetNumAtoms() > 64 or chemistry.AddHs(molecule).GetNumAtoms() > 256:
        raise ValueError("ATOM_LIMIT: molecular preview size exceeded")
    if len(chemistry.GetMolFrags(molecule)) != 1:
        raise ValueError("VIEW_UNSUPPORTED: disconnected fragments need separate geometry")


def request_context(snapshot: CompilationResult) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if not snapshot.document:
        raise ValueError("NEEDS_INPUT: compile valid source")
    objects = snapshot.document["objects"]
    if len(objects) > MAX_CONTEXT_OBJECTS:
        raise ValueError("CONTEXT_LIMIT: select a workspace of at most 64 objects")
    brief = []
    for obj in objects:
        payload = obj["payload"]
        actions = ["object_inspect"]
        reasons = []
        molecular_profile = None
        if obj["kind"] in {"Molecule", "PeriodicStructure"}:
            try:
                preview_preflight(obj)
                actions.append("structure_preview")
            except (ValueError, ImportError) as error:
                reasons.append(str(error))
        is_water = obj["kind"] == "Molecule" and any(
            r.get("format") == "smiles" and r.get("value") in {"O", "[OH2]"}
            for r in payload.get("representations", [])
        )
        sites = payload.get("sites", [])
        is_copper = (
            obj["kind"] == "PeriodicStructure"
            and 1 <= len(sites) <= 32
            and all(s.get("element") == "Cu" and s.get("occupancy") == 1 for s in sites)
            and "lattice" in payload
        )
        if is_water or is_copper:
            try:
                require_profile(snapshot, obj["id"], "water" if is_water else "copper")
                actions.append("plan_water_single_point" if is_water else "plan_cu_lattice_scan")
            except ValueError as error:
                reasons.append(str(error))
        if obj["kind"] == "Molecule" and not is_water:
            from chem_workbench.molecular_compute import molecular_preflight

            try:
                molecular_profile = molecular_preflight(snapshot, obj["id"])
                actions.append("plan_molecular_single_point")
            except (ValueError, ImportError) as error:
                reasons.append(str(error))
        # Only bounded typed values, never free source comments or file paths.
        summary = {
            "object_id": obj["id"],
            "kind": obj["kind"],
            "admitted_tools": actions,
            "structure": {
                "representations": [
                    {"format": r.get("format"), "value": str(r.get("value", ""))[:500]}
                    for r in payload.get("representations", [])[:4]
                ],
                "elements": sorted({s["element"] for s in sites}),
                "site_count": len(sites),
                "supplied_periodic_coordinates": bool(sites),
            },
            "declared_state": {
                k: copy.deepcopy(payload[k])
                for k in (
                    "target_reference",
                    "model",
                    "charge",
                    "multiplicity",
                    "phase",
                    "temperature",
                    "task",
                    "method",
                    "basis",
                    "properties",
                    "conditions_reference",
                )
                if k in payload
            },
            "linked_declarations": [
                {
                    "object_id": linked["id"],
                    "kind": linked["kind"],
                    "payload": copy.deepcopy(linked["payload"]),
                }
                for linked in objects
                if linked["payload"].get("target_reference") == obj["id"]
            ],
            "unavailable_profile_reasons": reasons,
        }
        if molecular_profile is not None:
            summary["molecular_profile"] = {
                key: copy.deepcopy(molecular_profile[key])
                for key in ("method_profile_id", "declared_state", "complexity")
                if key in molecular_profile
            }
        brief.append(summary)
    available = sorted(
        {a for item in brief for a in item["admitted_tools"]} | {"needs_input", "capabilities_list"}
    )
    branches = []
    for name in available:
        targets = [item["object_id"] for item in brief if name in item["admitted_tools"]]
        scales = (
            copy.deepcopy(TOOLS[name]["input"]["properties"]["scale_factors"])
            if name == "plan_cu_lattice_scan"
            else {"type": "array", "maxItems": 0, "items": {"type": "number"}}
        )
        branches.append(
            {
                "type": "object",
                "additionalProperties": False,
                "required": ["action", "object_id", "scale_factors", "message"],
                "properties": {
                    "action": {"const": name},
                    "object_id": {"type": "string", "enum": targets or [""]},
                    "scale_factors": scales,
                    "message": {"type": "string", "maxLength": 200, "pattern": "^[ -~]{0,200}$"},
                },
            }
        )
    # Grammar constrains argument shape; the host still validates every dispatch.
    schema = {"anyOf": branches}
    return brief, schema


def validate_selected_action(action: dict[str, Any], brief: list[dict[str, Any]]) -> None:
    from jsonschema import Draft202012Validator  # type: ignore[import-untyped]

    name = action["action"]
    if name in {"needs_input", "final", "capabilities_list"} and (
        action["object_id"] or action["scale_factors"]
    ):
        raise ValueError("INVALID_ARGUMENT: no target or scales accepted by this action")
    if name in {"needs_input", "final"}:
        return
    if name not in TOOLS:
        raise ValueError("UNKNOWN_TOOL")
    arguments = {} if name == "capabilities_list" else {"object_id": action["object_id"]}
    if name == "plan_cu_lattice_scan":
        arguments["scale_factors"] = action["scale_factors"]
    elif action["scale_factors"]:
        raise ValueError("INVALID_ARGUMENT: scales only apply to a copper scan")
    if list(Draft202012Validator(TOOLS[name]["input"]).iter_errors(arguments)):
        raise ValueError("INVALID_ARGUMENT: selected action violates its tool contract")
    if name != "capabilities_list" and not any(
        item["object_id"] == action["object_id"] and name in item["admitted_tools"]
        for item in brief
    ):
        raise ValueError("UNSUPPORTED_PROFILE: selected tool is not admitted for this object")
