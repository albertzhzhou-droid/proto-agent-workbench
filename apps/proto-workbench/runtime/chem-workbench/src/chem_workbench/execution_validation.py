"""Closed input contracts for admitted execution profiles."""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from chem_workbench.visualization import content_hash


def digest_id(value: object) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", value):
        raise ValueError("INVALID_ARGUMENT: expected a SHA-256 identifier")
    return value[7:]


def verify_hash(value: dict[str, Any], field: str) -> None:
    if not isinstance(value, dict):
        raise ValueError("INVALID_ARGUMENT: expected an object")
    digest_id(value.get(field))
    if value[field] != content_hash({k: v for k, v in value.items() if k != field}):
        raise ValueError(f"APPROVAL_STALE: {field} content mismatch")


def number(value: object, bound: str = "1000000") -> Decimal:
    if (
        not isinstance(value, str)
        or len(value) > 100
        or not re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", value)
    ):
        raise ValueError("INVALID_ARGUMENT: expected a bounded decimal string")
    try:
        result = Decimal(value)
        if not result.is_finite() or result.copy_abs() > Decimal(bound):
            raise ValueError("INVALID_ARGUMENT: decimal outside profile bounds")
        return result
    except InvalidOperation as error:
        raise ValueError("INVALID_ARGUMENT: invalid decimal") from error


def validate_water(geometry: Any) -> None:
    if not isinstance(geometry, dict):
        raise ValueError("INVALID_ARGUMENT: geometry must be an object")
    atoms = geometry.get("atoms")
    if (
        type(geometry.get("charge")) is not int
        or geometry["charge"] != 0
        or type(geometry.get("multiplicity")) is not int
        or geometry["multiplicity"] != 1
        or not isinstance(atoms, list)
        or len(atoms) != 3
        or any(not isinstance(a, list) or len(a) != 4 for a in atoms)
        or any(not isinstance(a[0], str) for a in atoms)
        or sorted(a[0] for a in atoms) != ["H", "H", "O"]
    ):
        raise ValueError("UNSUPPORTED_PROFILE: neutral singlet H2O geometry required")
    positions = [tuple(number(c, "100") for c in atom[1:]) for atom in atoms]
    if len(set(positions)) != 3:
        raise ValueError("INVALID_ARGUMENT: coincident atoms")


def validate_candidates(candidates: Any) -> None:
    if not isinstance(candidates, list) or not 2 <= len(candidates) <= 9:
        raise ValueError("INVALID_ARGUMENT: expected 2-9 copper candidates")
    scales: set[Decimal] = set()
    reference_sites = None
    reference_cell = None
    for candidate in candidates:
        if not isinstance(candidate, dict):
            raise ValueError("INVALID_ARGUMENT: invalid candidate")
        verify_hash(candidate, "candidate_hash")
        scale = number(candidate.get("scale"))
        if not Decimal("0.95") <= scale <= Decimal("1.05") or scale in scales:
            raise ValueError("INVALID_ARGUMENT: scales must be unique and in [0.95, 1.05]")
        scales.add(scale)
        sites = candidate.get("fractional_sites")
        if not isinstance(sites, list) or not 1 <= len(sites) <= 32:
            raise ValueError("UNSUPPORTED_PROFILE: expected 1-32 copper sites")
        for site in sites:
            if (
                not isinstance(site, dict)
                or site.get("element") != "Cu"
                or site.get("occupancy") != 1
            ):
                raise ValueError("UNSUPPORTED_PROFILE: fully occupied pure copper required")
            coordinates = site.get("coordinates")
            if not isinstance(coordinates, list) or len(coordinates) != 3:
                raise ValueError("INVALID_ARGUMENT: invalid fractional position")
            for coordinate in coordinates:
                number(coordinate, "10")
        cell = candidate.get("lattice_angstrom")
        if (
            not isinstance(cell, list)
            or len(cell) != 3
            or any(not isinstance(row, list) or len(row) != 3 for row in cell)
        ):
            raise ValueError("INVALID_ARGUMENT: expected a 3 by 3 cell")
        base = [[number(v, "100") / scale for v in row] for row in cell]
        a, b, c = base
        volume = abs(
            a[0] * (b[1] * c[2] - b[2] * c[1])
            - a[1] * (b[0] * c[2] - b[2] * c[0])
            + a[2] * (b[0] * c[1] - b[1] * c[0])
        )
        if not Decimal("0.1") <= volume <= Decimal("1000000"):
            raise ValueError("INVALID_ARGUMENT: degenerate or excessive cell")
        if reference_sites is not None and sites != reference_sites:
            raise ValueError("INVALID_ARGUMENT: fractional sites changed between candidates")
        if reference_cell is not None and any(
            abs(v - reference_cell[i][j]) > Decimal("1e-20")
            for i, row in enumerate(base)
            for j, v in enumerate(row)
        ):
            raise ValueError("INVALID_ARGUMENT: cells are not uniformly scaled")
        reference_sites, reference_cell = sites, base


def validate_plan(plan: dict[str, Any], *, refinement_root: Path | None = None) -> None:
    verify_hash(plan, "resolved_plan_hash")
    if plan.get("kind") == "molecular_refinement":
        if refinement_root is None:
            raise ValueError("HOST_CONTEXT_REQUIRED: refinement artifact root required")
        from chem_workbench.refinement_execution.governed_plan import validate_stored_plan

        validate_stored_plan(plan, refinement_root)
        return
    if plan.get("version") != "resolved-plan/v1" or plan.get("allowed_actions") != ["execute"]:
        raise ValueError("UNSUPPORTED_PROFILE: invalid plan version or actions")
    ceilings = plan.get("resource_ceilings", {})
    if (
        not isinstance(ceilings, dict)
        or not isinstance(plan.get("worker"), dict)
        or not isinstance(plan.get("subject"), dict)
    ):
        raise ValueError("INVALID_ARGUMENT: malformed plan objects")
    for key, maximum in (("deadline_seconds", 600), ("max_output_bytes", 10_000_000)):
        value = ceilings.get(key)
        if type(value) is not int or not 1 <= value <= maximum:
            raise ValueError(f"INVALID_ARGUMENT: {key} outside host limits")
    if plan.get("prepared_input_hash") != content_hash(plan.get("prepared_input")):
        raise ValueError("APPROVAL_STALE: prepared input hash mismatch")
    if ceilings.get("job_memory_bytes") != 3 * 1024**3 or ceilings.get("job_cpu_seconds") != 600:
        raise ValueError("UNSUPPORTED_PROFILE: fixed job memory/CPU limits required")
    kind = plan.get("kind")
    profiles = {
        "mock": ("mock.worker.v1", "mock"),
        "water_hf_sto3g": ("qcengine.psi4.hf_sto3g.smoke.v1", "psi4_water"),
        "molecular_hf_sto3g": ("qcengine.psi4.hf_sto3g.organic.v1", "psi4_molecular"),
        "cu_lattice_scan": ("ase.emt.cu.scan.v1", "ase_emt"),
    }
    if (
        kind not in profiles
        or (plan.get("method_profile_id"), plan.get("worker", {}).get("kind")) != profiles[kind]
    ):
        raise ValueError("UNSUPPORTED_PROFILE: method and worker mismatch")
    if plan["prepared_input"] != prepared_input(plan):
        raise ValueError("APPROVAL_STALE: prepared input differs from profile inputs")
    subject = plan.get("subject", {})
    if kind == "water_hf_sto3g":
        validate_water(subject.get("geometry"))
        if subject.get("content_hash") != content_hash(subject["geometry"]):
            raise ValueError("APPROVAL_STALE: geometry content mismatch")
        if [plan.get(k) for k in ("method", "basis", "engine", "normalization")] != [
            "hf",
            "sto-3g",
            "psi4",
            "hartree",
        ] or plan.get("acceptance") != {
            "property": "energy_hartree",
            "minimum": "-75.1",
            "maximum": "-74.8",
        }:
            raise ValueError("UNSUPPORTED_PROFILE: water settings or acceptance changed")
    elif kind == "molecular_hf_sto3g":
        from chem_workbench.molecular_compute import validate_molecular_proposal

        proposal = subject.get("proposal")
        validate_molecular_proposal(proposal)
        expected_subject = {
            "subject_ref": proposal["object_id"],
            "subject_hash": proposal["subject_hash"],
            "source_hash": proposal["source_hash"],
            "source_semantic_hash": proposal["source_semantic_hash"],
            "linked_state_hash": proposal["linked_state_hash"],
            "geometry_hash": proposal["geometry_hash"],
            "proposal": proposal,
        }
        if (
            subject != expected_subject
            or plan.get("logical_plan_hash") != proposal["logical_plan_hash"]
        ):
            raise ValueError("APPROVAL_STALE: molecular subject binding changed")
        if [plan.get(k) for k in ("method", "basis", "engine", "normalization")] != [
            "hf",
            "sto-3g",
            "psi4",
            "hartree",
        ] or plan.get("acceptance") != {
            "property": "energy_hartree",
            "rule": "finite_negative_energy_and_scf_converged",
        }:
            raise ValueError("UNSUPPORTED_PROFILE: molecular settings or acceptance changed")
    elif kind == "cu_lattice_scan":
        validate_candidates(plan.get("candidates"))
        digest_id(subject.get("subject_hash"))
        if plan.get("normalization") != "eV/atom" or plan.get("acceptance") != {
            "property": "energy_eV_per_atom",
            "rule": "finite_decimal_and_converged_per_candidate",
        }:
            raise ValueError("UNSUPPORTED_PROFILE: copper acceptance changed")
    elif subject.get("content_hash") != content_hash({"input": subject.get("input")}):
        raise ValueError("APPROVAL_STALE: mock input changed")


def prepared_input(plan: dict[str, Any]) -> dict[str, Any]:
    if plan["kind"] == "molecular_hf_sto3g":
        from chem_workbench.molecular_compute import ANGSTROM_TO_BOHR, SCF_SETTINGS

        return {
            "geometry": plan["subject"]["proposal"]["geometry"],
            "geometry_provenance": plan["subject"]["proposal"]["geometry_provenance"],
            "source_hash": plan["subject"]["source_hash"],
            "linked_state_hash": plan["subject"]["linked_state_hash"],
            "logical_plan_hash": plan["logical_plan_hash"],
            "method": plan["method"],
            "basis": plan["basis"],
            "engine": plan["engine"],
            "scf_settings": dict(SCF_SETTINGS),
            "angstrom_to_bohr": ANGSTROM_TO_BOHR,
        }
    if plan["kind"] == "water_hf_sto3g":
        return {
            "geometry": plan["subject"]["geometry"],
            "method": plan["method"],
            "basis": plan["basis"],
            "engine": plan["engine"],
        }
    if plan["kind"] == "cu_lattice_scan":
        return {"candidates": plan["candidates"]}
    return dict(plan["subject"]["input"])
