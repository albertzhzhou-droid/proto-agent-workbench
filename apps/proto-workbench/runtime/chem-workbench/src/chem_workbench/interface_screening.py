"""Compare candidate-bound conditional response models under matched conditions."""

from __future__ import annotations

import copy
import math
from typing import Any

from chem_workbench.interface_simulation import COMMON, simulate_interface
from chem_workbench.visualization import content_hash

OBJECTIVES = {
    "electrode_electrolyte": "max_cathodic_charge",
    "catalyst_reactant": "max_product_pool",
    "solid_liquid": "max_adsorbed_coverage",
}
OBSERVABLES = {
    "max_cathodic_charge": ("external_charge_density_C_m2", "C/m^2", -1),
    "max_product_pool": ("concentration_product_pool_mol_m3", "mol/m^3", 1),
    "max_adsorbed_coverage": ("theta_adsorbed", "1", 1),
}


class InterfaceScreeningError(ValueError):
    """Retain completed pair responses when a subsequent numerical model fails."""

    def __init__(self, message: str, simulations: list[dict[str, Any]]) -> None:
        super().__init__(message)
        self.simulations = copy.deepcopy(simulations)


def validate_screening(value: object) -> dict[str, Any]:
    if (
        not isinstance(value, dict)
        or set(value) != {"profile", "objective"}
        or value.get("profile") not in OBJECTIVES
        or value.get("objective") != OBJECTIVES[value["profile"]]
    ):
        raise ValueError("INTERFACE_SCREENING_OBJECTIVE: select a registered final-time observable")
    return copy.deepcopy(value)


def _conditions(spec: dict[str, Any]) -> dict[str, Any]:
    """Provenance may differ, but compared physical conditions must be identical."""
    fields = list(COMMON)
    if spec["profile"] == "electrode_electrolyte":
        fields += ["eta_V", "reference_concentration_mol_m3", "n_electrons"]
    if spec["profile"] == "catalyst_reactant":
        fields += ["hydrogen_activity"]
    return {
        "parameters": {
            key: {k: spec["parameters"][key][k] for k in ("value", "unit")} for key in fields
        },
        "initial_conditions": {
            key: {k: quantity[k] for k in ("value", "unit")}
            for key, quantity in spec["initial_conditions"].items()
        },
        "time_grid": {key: spec["time_grid"][key] for key in ("values", "unit")},
    }


def screen_interfaces(
    objective: dict[str, Any],
    specifications: list[dict[str, Any]],
    organics: list[dict[str, Any]],
    inorganics: list[dict[str, Any]],
) -> dict[str, Any]:
    """Run 2-4 exact pair models; no inferred constants or cross-condition comparisons."""
    objective = validate_screening(objective)
    if not 2 <= len(specifications) <= 4:
        raise ValueError("INTERFACE_SCREENING_BUDGET: supply 2-4 candidate-bound specifications")
    library = {
        "organic": {content_hash(item): item for item in organics},
        "inorganic": {content_hash(item): item for item in inorganics},
    }
    resolved = []
    seen = set()
    conditions = None
    for spec in specifications:
        if spec.get("profile") != objective["profile"]:
            raise ValueError("INTERFACE_SCREENING_PROFILE_MISMATCH")
        try:
            organic = library["organic"][spec["candidate_hashes"]["organic"]]
            inorganic = library["inorganic"][spec["candidate_hashes"]["inorganic"]]
            current = _conditions(spec)
        except (KeyError, TypeError) as error:
            raise ValueError("INTERFACE_SCREENING_SOURCE_BINDING") from error
        pair = (organic["candidate_hash"], inorganic["candidate_hash"])
        if pair in seen:
            raise ValueError("INTERFACE_SCREENING_DUPLICATE_PAIR")
        seen.add(pair)
        if conditions is not None and conditions != current:
            raise ValueError("INTERFACE_SCREENING_CONDITIONS_MISMATCH")
        conditions = current
        resolved.append((spec, organic, inorganic))
    simulations: list[dict[str, Any]] = []
    rows: list[dict[str, Any]] = []
    column, unit, sign = OBSERVABLES[objective["objective"]]
    for spec, organic, inorganic in resolved:
        try:
            result = simulate_interface(spec, organic, inorganic)
        except Exception as error:
            raise InterfaceScreeningError(str(error), simulations) from error
        final_value = sign * result["series"][-1][column]
        if not math.isfinite(final_value):
            raise ValueError("INTERFACE_SCREENING_NONFINITE_OBSERVABLE")
        simulations.append(result)
        rows.append(
            {
                "pair": {
                    "organic": organic["candidate_hash"],
                    "inorganic": inorganic["candidate_hash"],
                },
                "value": final_value,
                "unit": unit,
                "simulation_hash": result["result_hash"],
                "parameter_status": result["parameter_status"],
            }
        )
    rows.sort(key=lambda row: (-row["value"], content_hash(row["pair"])))
    # Numerical equivalence must not become a spurious chemical winner.
    tolerance = max(1e-10, max(abs(row["value"]) for row in rows) * 1e-6)
    best = rows[0]["value"]
    for row in rows:
        row["tied_best"] = abs(row["value"] - best) <= tolerance
    output = {
        "version": "interface-screening-result/v1",
        "objective": objective,
        "conditions": conditions,
        "conditions_hash": content_hash(conditions),
        "rows": rows,
        "simulations": simulations,
        "tie_tolerance": tolerance,
        "winner": rows[0]["pair"] if sum(row["tied_best"] for row in rows) == 1 else None,
        "comparison_scope": "Final-time conditional response under matched supplied conditions",
        "scientifically_calibrated": False,
        "measured_performance_claim": False,
        "limitations": [
            "Rates are supplied for each exact candidate pair; "
            "structure descriptors supply no rates.",
            "A conditional winner does not establish experimental activity or material stability.",
            "Only supplied pairs are compared; omitted candidates have no response ranking.",
        ],
    }
    output["result_hash"] = content_hash(output)
    return output
