"""Bounded, explicitly parameterized interface kinetics with mass and site balances.

These ideal well-mixed models integrate declared conditional mechanisms. They do
not infer kinetic constants or specific products from a candidate's descriptors.
"""

from __future__ import annotations

import copy
import importlib
import json
import math
import time
from itertools import pairwise
from typing import Any

from chem_workbench.visualization import content_hash

VERSION = "interface-simulation-spec/v1"
MAX_RHS_EVALUATIONS = 20_000
WALL_BUDGET_SECONDS = 5.0
RTOL = 1e-8
BALANCE_TOLERANCE = 2e-7
FARADAY_C_MOL = 96485.33212331001
GAS_CONSTANT_J_MOL_K = 8.31446261815324
SOURCES = {
    "mass_action_and_electrochemical_rates": "https://www.cantera.org/stable/reference/kinetics/reaction-rates.html",
    "reference_potential_butler_volmer": "https://doc.comsol.com/6.4/doc/com.comsol.help.echem/echem_ug_electrochem.06.122.html",
    "surface_species_and_sites": "https://water.usgs.gov/water-resources/software/PHREEQC/documentation/phreeqc3-html/phreeqc3-54.htm",
    "integrator": "https://docs.scipy.org/doc/scipy/reference/generated/scipy.integrate.solve_ivp.html",
}
# Bounds constrain this numerical profile; they are not admissibility claims for all materials.
COMMON: dict[str, tuple[str, float, float]] = {
    "temperature_K": ("K", 250, 500),
    "area_m2": ("m^2", 1e-12, 1),
    "liquid_volume_m3": ("m^3", 1e-12, 1),
    "site_density_mol_m2": ("mol/m^2", 1e-9, 1e-2),
}
RATE = ("1/s", 1e-12, 1e6)
ADSORPTION = ("m^3/(mol*s)", 1e-12, 1e6)
PROFILE_PARAMETERS: dict[str, dict[str, tuple[str, float, float]]] = {
    "electrode_electrolyte": {
        "k0_m_s": ("m/s", 1e-12, 1e-2),
        "alpha": ("1", 0.01, 0.99),
        "eta_V": ("V", -0.5, 0.5),
        "reference_concentration_mol_m3": ("mol/m^3", 1e-9, 1e4),
        "n_electrons": ("1", 1, 1),
    },
    "catalyst_reactant": {
        "k_ads_m3_mol_s": ADSORPTION,
        "k_des_s": RATE,
        "k_forward_s": RATE,
        "k_reverse_s": RATE,
        "hydrogen_activity": ("1", 1e-12, 1e6),
        "k_product_ads_m3_mol_s": ADSORPTION,
        "k_product_des_s": RATE,
    },
    "solid_liquid": {
        "k_ads_m3_mol_s": ADSORPTION,
        "k_des_s": RATE,
        "k_protonation_m3_mol_s": ADSORPTION,
        "k_deprotonation_s": RATE,
    },
}
INITIAL_FIELDS = {
    "electrode_electrolyte": ["theta_reduced", "concentration_oxidized_mol_m3"],
    "catalyst_reactant": [
        "theta_reactant",
        "theta_product",
        "concentration_reactant_mol_m3",
        "concentration_product_pool_mol_m3",
    ],
    "solid_liquid": [
        "theta_adsorbed",
        "theta_protonated",
        "concentration_adsorbate_mol_m3",
        "concentration_proton_mol_m3",
    ],
}
INTERPRETATIONS = {
    "electrode_electrolyte": {
        "steps": ["ortho-quinone(solution) + e- + vacant_site <=> semiquinone(adsorbed)"],
        "species": "The selected catechol supplies the declared derived ortho-quinone "
        "and semiquinone radical-anion graphs. Forward reduction consumes one electron. "
        "The mechanism is conditional and requires supplied reference conditions.",
        "potential": "eta_V is relative to the fixed formal reference potential; "
        "the concentration-dependent equilibrium potential can evolve.",
        "sign": "Positive current is anodic oxidation; reduction current is negative.",
        "charge": "Integrated external charge equals -F times "
        "the increase in adsorbed reduced moles.",
    },
    "catalyst_reactant": {
        "steps": [
            "A(solution) + vacant_site <=> A*",
            "A* <=> P* + H2(reservoir)",
            "P* <=> P_pool(solution) + vacant_site",
        ],
        "species": "A is the selected catechol and P is its graph-balanced derived "
        "ortho-quinone. The fixed-activity H2 reservoir receives the signed net "
        "dehydrogenation amount. This declared reaction recipe does not establish "
        "feasibility, an elementary pathway or experimental chemical yield.",
        "hydrogen_reservoir": "Reverse rate is k_reverse_s * hydrogen_activity * "
        "theta_product. Positive exchange adds H2 to the reservoir; negative exchange "
        "consumes it. This is reservoir accounting, not a gas-evolution prediction.",
        "detailed_balance": "Each reversible pair has its own explicit positive constants. "
        "The three-step chain has no independent thermodynamic cycle.",
    },
    "solid_liquid": {
        "steps": [
            "S(neutral) + A(neutral, solution) <=> SA(neutral)",
            "S(neutral) + H+(solution) <=> SH+(surface)",
        ],
        "species": "Neutral adsorbate and protons compete for the same finite "
        "declared molecular sites. The mechanism identifies all molecular states. "
        "A fixed spectator countercharge balances the initial free-plus-bound proton charge.",
        "charge": "Free protons plus protonated sites conserve charge; "
        "the spectator countercharge is fixed.",
        "excluded_equilibria": "Water autoionization, buffer, mineral dissolution, "
        "diffuse layer and electrostatic activity corrections are excluded.",
    },
}


def _provenance(value: Any) -> None:
    if (
        not isinstance(value, dict)
        or set(value) != {"kind", "source"}
        or not isinstance(value["kind"], str)
        or value["kind"] not in {"user_supplied", "illustrative"}
        or not isinstance(value["source"], str)
        or not 1 <= len(value["source"].strip()) <= 2000
    ):
        raise ValueError(
            "PARAMETER_PROVENANCE_REQUIRED: declare user_supplied or illustrative source"
        )


def _number(value: Any, minimum: float, maximum: float) -> float:
    if (
        type(value) not in (int, float)
        or not math.isfinite(value)
        or not minimum <= value <= maximum
    ):
        raise ValueError("INVALID_INTERFACE_NUMBER: finite bounded numeric value required")
    return float(value)


def _quantity(value: Any, constraint: tuple[str, float, float]) -> float:
    if not isinstance(value, dict) or set(value) != {"value", "unit", "provenance"}:
        raise ValueError("INTERFACE_QUANTITY_REQUIRED")
    if value["unit"] != constraint[0]:
        raise ValueError("INTERFACE_UNIT_MISMATCH: " + constraint[0])
    _provenance(value["provenance"])
    return _number(value["value"], constraint[1], constraint[2])


def _verify_candidate(candidate: dict[str, Any], family: str) -> None:
    if candidate.get("family") != family:
        raise ValueError("INTERFACE_CANDIDATE_FAMILY_MISMATCH")
    body = {key: value for key, value in candidate.items() if key != "candidate_hash"}
    if candidate.get("candidate_hash") != content_hash(body):
        raise ValueError("INTERFACE_CANDIDATE_HASH_MISMATCH")
    geometry = candidate.get("geometry")
    if geometry is not None:
        if not isinstance(geometry, dict) or geometry.get("geometry_hash") != content_hash(
            {key: value for key, value in geometry.items() if key != "geometry_hash"}
        ):
            raise ValueError("INTERFACE_GEOMETRY_HASH_MISMATCH")
        if (
            geometry.get("object_id") != candidate.get("id")
            or geometry.get("source_hash") != candidate.get("request_hash")
            or geometry.get("subject_hash") != candidate.get("identity_hash")
        ):
            raise ValueError("INTERFACE_GEOMETRY_CANDIDATE_MISMATCH")


def _validate(
    spec: Any, organic: Any, inorganic: Any
) -> tuple[str, dict[str, float], list[float], list[float]]:
    if (
        not isinstance(spec, dict)
        or set(spec)
        != {
            "version",
            "profile",
            "candidate_hashes",
            "mechanism",
            "parameters",
            "initial_conditions",
            "time_grid",
        }
        or spec["version"] != VERSION
        or not isinstance(spec["profile"], str)
        or spec["profile"] not in PROFILE_PARAMETERS
    ):
        raise ValueError("INVALID_INTERFACE_SPEC")
    if (
        not isinstance(organic, dict)
        or not organic
        or not isinstance(inorganic, dict)
        or not inorganic
    ):
        raise ValueError("INTERFACE_CANDIDATES_REQUIRED")
    try:
        if len(json.dumps([spec, organic, inorganic], allow_nan=False).encode()) > 500_000:
            raise ValueError("INTERFACE_INPUT_LIMIT")
    except (TypeError, OverflowError) as error:
        raise ValueError("INVALID_INTERFACE_JSON") from error
    _verify_candidate(organic, "organic")
    _verify_candidate(inorganic, "inorganic")
    if spec["candidate_hashes"] != {
        "organic": content_hash(organic),
        "inorganic": content_hash(inorganic),
    }:
        raise ValueError("INTERFACE_CANDIDATE_BINDING_MISMATCH")
    profile = str(spec["profile"])
    mechanism = spec["mechanism"]
    if not isinstance(mechanism, dict) or mechanism.get("mechanism_hash") != content_hash(
        {key: value for key, value in mechanism.items() if key != "mechanism_hash"}
    ):
        raise ValueError("INTERFACE_MECHANISM_HASH_MISMATCH")
    mechanisms = importlib.import_module("chem_workbench.interface_mechanisms")
    expected_mechanism = mechanisms.mechanism_for_candidate(profile, organic, inorganic)
    # Python equality treats 1 and 1.0 as equal; the retained JSON identity does not.
    if content_hash(mechanism) != content_hash(expected_mechanism):
        raise ValueError("INTERFACE_MECHANISM_BINDING_MISMATCH")
    constraints = COMMON | PROFILE_PARAMETERS[profile]
    if not isinstance(spec["parameters"], dict) or set(spec["parameters"]) != set(constraints):
        raise ValueError("INTERFACE_PARAMETERS_MISMATCH")
    parameters = {
        key: _quantity(spec["parameters"][key], bound) for key, bound in constraints.items()
    }
    initial = spec["initial_conditions"]
    if not isinstance(initial, dict) or set(initial) != set(INITIAL_FIELDS[profile]):
        raise ValueError("INTERFACE_INITIAL_STATE_MISMATCH")
    y0 = [
        _quantity(initial[key], ("1", 0, 1) if key.startswith("theta_") else ("mol/m^3", 0, 1e4))
        for key in INITIAL_FIELDS[profile]
    ]
    coverage_count = 1 if profile == "electrode_electrolyte" else 2
    if sum(y0[:coverage_count]) > 1:
        raise ValueError("INTERFACE_SITE_BALANCE: initial occupied fraction exceeds one")
    grid = spec["time_grid"]
    if (
        not isinstance(grid, dict)
        or set(grid) != {"values", "unit", "provenance"}
        or grid["unit"] != "s"
        or not isinstance(grid["values"], list)
        or not 2 <= len(grid["values"]) <= 201
    ):
        raise ValueError("INTERFACE_TIME_GRID: 2-201 explicit times in seconds required")
    _provenance(grid["provenance"])
    times = [_number(value, 0, 3600) for value in grid["values"]]
    if times[0] != 0 or any(right <= left for left, right in pairwise(times)):
        raise ValueError("INTERFACE_TIME_GRID: start at zero and strictly increase")
    return profile, parameters, y0, times


def simulate_interface(
    spec: dict[str, Any], organic_candidate: dict[str, Any], inorganic_candidate: dict[str, Any]
) -> dict[str, Any]:
    """Integrate a declared model; candidate identities bind its scope, never generate rates."""
    spec, organic_candidate, inorganic_candidate = copy.deepcopy(
        (spec, organic_candidate, inorganic_candidate)
    )
    profile, p, y0, times = _validate(spec, organic_candidate, inorganic_candidate)
    integrate = importlib.import_module("scipy.integrate")
    scipy = importlib.import_module("scipy")
    gamma, area, volume = p["site_density_mol_m2"], p["area_m2"], p["liquid_volume_m3"]
    rho = gamma * area / volume
    initial = list(y0)
    if profile == "electrode_electrolyte":
        y0.append(0.0)  # Signed external charge density, C/m^2.
    elif profile == "catalyst_reactant":
        y0.append(0.0)  # Signed H2 amount transferred to the chemostat, mol/m^2.
    factor = FARADAY_C_MOL * p.get("eta_V", 0) / (GAS_CONSTANT_J_MOL_K * p["temperature_K"])

    def evaluate(y: Any) -> tuple[list[float], dict[str, float]]:
        if profile == "electrode_electrolyte":
            theta, concentration, charge = y
            forward = p["k0_m_s"] * concentration * (1 - theta) * math.exp(-p["alpha"] * factor)
            reverse = (
                p["k0_m_s"]
                * p["reference_concentration_mol_m3"]
                * theta
                * math.exp((1 - p["alpha"]) * factor)
            )
            flux = forward - reverse
            current = -FARADAY_C_MOL * flux
            return [flux / gamma, -area / volume * flux, current], {
                "forward_reduction_flux_mol_m2_s": forward,
                "reverse_oxidation_flux_mol_m2_s": reverse,
                "current_density_A_m2": current,
                "current_A": area * current,
                "external_charge_density_C_m2": charge,
            }
        theta_a, theta_b, concentration_a, concentration_b = y[:4]
        vacant = 1 - theta_a - theta_b
        adsorption = p["k_ads_m3_mol_s"] * concentration_a * vacant - p["k_des_s"] * theta_a
        if profile == "catalyst_reactant":
            transition = (
                p["k_forward_s"] * theta_a - p["k_reverse_s"] * p["hydrogen_activity"] * theta_b
            )
            product_release = (
                p["k_product_des_s"] * theta_b
                - p["k_product_ads_m3_mol_s"] * concentration_b * vacant
            )
            return [
                adsorption - transition,
                transition - product_release,
                -rho * adsorption,
                rho * product_release,
                gamma * transition,
            ], {
                "net_surface_transition_mol_m2_s": gamma * transition,
                "conditional_pool_release_mol_m2_s": gamma * product_release,
                "cumulative_net_transitions_mol_m2": gamma * (theta_b - initial[1])
                + volume / area * (concentration_b - initial[3]),
                "hydrogen_chemostat_exchange_mol_m2": float(y[4]),
            }
        protonation = (
            p["k_protonation_m3_mol_s"] * concentration_b * vacant
            - p["k_deprotonation_s"] * theta_b
        )
        charge = FARADAY_C_MOL * (volume * concentration_b + gamma * area * theta_b)
        countercharge = -FARADAY_C_MOL * (volume * initial[3] + gamma * area * initial[1])
        return [adsorption, protonation, -rho * adsorption, -rho * protonation], {
            "net_adsorption_mol_m2_s": gamma * adsorption,
            "net_protonation_mol_m2_s": gamma * protonation,
            "free_plus_bound_proton_charge_C": charge,
            "fixed_spectator_countercharge_C": countercharge,
            "net_charge_C": charge + countercharge,
        }

    total_a = (
        initial[1] + rho * initial[0]
        if profile == "electrode_electrolyte"
        else (
            initial[2]
            + (initial[3] if profile == "catalyst_reactant" else 0)
            + rho * (initial[0] + (initial[1] if profile == "catalyst_reactant" else 0))
        )
    )
    total_h = initial[3] + rho * initial[1] if profile == "solid_liquid" else 0.0
    concentration_scale = max(total_a, total_h, 1e-12)
    scales = (
        [1.0, concentration_scale, FARADAY_C_MOL * gamma]
        if profile == "electrode_electrolyte"
        else [1.0, 1.0, concentration_scale, concentration_scale]
    )
    if profile == "catalyst_reactant":
        scales.append(max(gamma, total_a * volume / area, 1e-15))
    mechanism = spec["mechanism"]
    species_by_id = {item["id"]: item for item in mechanism["species"]}

    def elemental_inventory(state: list[float]) -> dict[str, float]:
        """Count molecular atoms in finite pools plus declared reservoir exchange."""
        quantities = {
            species_id: state[index] * (rho if field.startswith("theta_") else 1.0)
            for index, field in enumerate(INITIAL_FIELDS[profile])
            for species_id in [mechanism["state_species"][field]]
        }
        coverage_count = 1 if profile == "electrode_electrolyte" else 2
        quantities[mechanism["vacant_site"]] = rho * (1 - sum(state[:coverage_count]))
        if profile == "catalyst_reactant":
            quantities["hydrogen"] = area / volume * state[4]
        inventory: dict[str, float] = {}
        for species_id, quantity in quantities.items():
            for element, count in species_by_id[species_id]["element_counts"].items():
                inventory[element] = inventory.get(element, 0.0) + quantity * count
        return inventory

    initial_elements = elemental_inventory(y0)
    element_errors = {element: 0.0 for element in initial_elements}
    evaluations = 0
    started = time.monotonic()

    def rhs(_t: float, y: Any) -> list[float]:
        nonlocal evaluations
        evaluations += 1
        if evaluations > MAX_RHS_EVALUATIONS or time.monotonic() - started > WALL_BUDGET_SECONDS:
            raise ValueError("INTERFACE_SOLVER_BUDGET_EXCEEDED")
        return evaluate(y)[0]

    solved = integrate.solve_ivp(
        rhs,
        (0.0, times[-1]),
        y0,
        method="Radau",
        t_eval=times,
        rtol=RTOL,
        atol=[1e-11 * scale for scale in scales],
        max_step=times[-1] / 20,
    )
    if not solved.success or len(solved.t) != len(times):
        raise ValueError("INTERFACE_SOLVER_FAILED")
    series: list[dict[str, float]] = []
    errors = {
        "site_balance": 0.0,
        "molecular_moiety_balance": 0.0,
        "proton_balance": 0.0,
        "charge_balance": 0.0,
        "positivity": 0.0,
        "elemental_balance": 0.0,
        "hydrogen_chemostat_balance": 0.0,
    }
    for index, timestamp in enumerate(times):
        state = [float(value) for value in solved.y[:, index]]
        if not all(math.isfinite(value) for value in state):
            raise ValueError("INTERFACE_NONFINITE_RESULT")
        coverage_count = 1 if profile == "electrode_electrolyte" else 2
        vacant = 1 - sum(state[:coverage_count])
        errors["site_balance"] = max(errors["site_balance"], max(0, -vacant))
        for number_index, value in enumerate(state):
            signed_integral = (profile == "electrode_electrolyte" and number_index == 2) or (
                profile == "catalyst_reactant" and number_index == 4
            )
            if not signed_integral:
                errors["positivity"] = max(
                    errors["positivity"], max(0, -value) / scales[number_index]
                )
        if profile == "electrode_electrolyte":
            amount_a = state[1] + rho * state[0]
            charge_error = abs(state[2] + FARADAY_C_MOL * gamma * (state[0] - initial[0]))
            errors["charge_balance"] = max(
                errors["charge_balance"], charge_error / (FARADAY_C_MOL * gamma)
            )
        else:
            amount_a = state[2] + rho * state[0]
            if profile == "catalyst_reactant":
                amount_a += state[3] + rho * state[1]
                transition_amount = gamma * (state[1] - initial[1]) + volume / area * (
                    state[3] - initial[3]
                )
                errors["hydrogen_chemostat_balance"] = max(
                    errors["hydrogen_chemostat_balance"],
                    abs(state[4] - transition_amount) / scales[4],
                )
            else:
                amount_h = state[3] + rho * state[1]
                relative = abs(amount_h - total_h) / max(total_h, 1e-15)
                errors["proton_balance"] = max(errors["proton_balance"], relative)
                errors["charge_balance"] = errors["proton_balance"]
        errors["molecular_moiety_balance"] = max(
            errors["molecular_moiety_balance"], abs(amount_a - total_a) / max(total_a, 1e-15)
        )
        for element, amount in elemental_inventory(state).items():
            relative_error = abs(amount - initial_elements[element]) / max(
                abs(initial_elements[element]), 1e-15
            )
            element_errors[element] = max(element_errors[element], relative_error)
        errors["elemental_balance"] = max(element_errors.values(), default=0.0)
        series.append(
            {
                "time_s": timestamp,
                "vacant_fraction": vacant,
                **dict(zip(INITIAL_FIELDS[profile], state, strict=False)),
                **evaluate(state)[1],
            }
        )
    if any(error > BALANCE_TOLERANCE for error in errors.values()):
        raise ValueError("INTERFACE_PHYSICAL_VALIDATION_FAILED")
    inputs = {
        "spec": copy.deepcopy(spec),
        "organic_candidate": copy.deepcopy(organic_candidate),
        "inorganic_candidate": copy.deepcopy(inorganic_candidate),
    }
    units = {
        key: ("1" if key.startswith("theta_") else "mol/m^3") for key in INITIAL_FIELDS[profile]
    }
    units.update(time_s="s", vacant_fraction="1")
    for key in series[0]:
        if key.endswith("_mol_m2_s"):
            units[key] = "mol/(m^2*s)"
        elif key.endswith("_C_m2"):
            units[key] = "C/m^2"
        elif key.endswith("_mol_m2"):
            units[key] = "mol/m^2"
        elif key.endswith("_C"):
            units[key] = "C"
        elif key.endswith("_A_m2"):
            units[key] = "A/m^2"
        elif key.endswith("_A"):
            units[key] = "A"
    result = {
        "version": "interface-simulation-result/v1",
        "profile": profile,
        "success": True,
        "inputs": inputs,
        "input_hash": content_hash(inputs),
        "candidate_hashes": copy.deepcopy(spec["candidate_hashes"]),
        "mechanism": copy.deepcopy(mechanism),
        "state_species": copy.deepcopy(mechanism["state_species"]),
        "interpretation": copy.deepcopy(INTERPRETATIONS[profile]),
        "series": series,
        "units": units,
        "balances": {
            "passed": True,
            "maximum_normalized_errors": errors,
            "maximum_normalized_element_errors": element_errors,
            "initial_elemental_inventory": initial_elements,
            "elemental_inventory_unit": "mol atoms/m^3",
            "elemental_inventory_scope": "Molecular finite pools and occupied/vacant "
            "molecular sites, including signed H2 reservoir exchange when declared. "
            "The unchanged inorganic support is excluded from the reactive inventory.",
            "tolerance": BALANCE_TOLERANCE,
        },
        "solver": {
            "engine": "scipy.solve_ivp",
            "scipy_version": scipy.__version__,
            "method": "Radau",
            "relative_tolerance": RTOL,
            "absolute_tolerances": [1e-11 * scale for scale in scales],
            "rhs_evaluations": evaluations,
            "rhs_budget": MAX_RHS_EVALUATIONS,
            "wall_budget_seconds": WALL_BUDGET_SECONDS,
        },
        "constants": {"faraday_C_mol": FARADAY_C_MOL, "gas_constant_J_mol_K": GAS_CONSTANT_J_MOL_K},
        "sources": copy.deepcopy(SOURCES),
        "parameter_status": "illustrative"
        if any(
            quantity["provenance"]["kind"] == "illustrative"
            for quantity in [
                *spec["parameters"].values(),
                *spec["initial_conditions"].values(),
                spec["time_grid"],
            ]
        )
        else "user_supplied_unverified",
        "scientifically_calibrated": False,
        "measured_data_claim": False,
        "assumptions": [
            "Well-mixed finite liquid; fixed area and independent equivalent sites.",
            "All constants apply at the declared fixed temperature; no inferred Arrhenius scaling.",
            "Candidate identity is recorded; applicability requires separate calibration.",
            "Descriptor-derived rates, atomistic interface energy, transport "
            "and physical execution are outside this model.",
        ],
    }
    result["result_hash"] = content_hash(result)
    return result


def illustrative_interface_spec(
    profile: str, organic_candidate: dict[str, Any], inorganic_candidate: dict[str, Any]
) -> dict[str, Any]:
    """Explicit engineering fixture values; never calibrated experimental constants."""
    if profile not in PROFILE_PARAMETERS:
        raise ValueError("UNKNOWN_INTERFACE_PROFILE")
    values: dict[str, float] = {
        "temperature_K": 298.15,
        "area_m2": 1e-4,
        "liquid_volume_m3": 1e-6,
        "site_density_mol_m2": 1e-5,
    }
    values.update(
        {
            "electrode_electrolyte": {
                "k0_m_s": 1e-5,
                "alpha": 0.5,
                "eta_V": -0.025,
                "reference_concentration_mol_m3": 1.0,
                "n_electrons": 1,
            },
            "catalyst_reactant": {
                "k_ads_m3_mol_s": 1,
                "k_des_s": 0.2,
                "k_forward_s": 0.1,
                "k_reverse_s": 0.02,
                "hydrogen_activity": 1.0,
                "k_product_ads_m3_mol_s": 0.05,
                "k_product_des_s": 0.1,
            },
            "solid_liquid": {
                "k_ads_m3_mol_s": 1,
                "k_des_s": 0.1,
                "k_protonation_m3_mol_s": 100,
                "k_deprotonation_s": 0.1,
            },
        }[profile]
    )
    provenance = {
        "kind": "illustrative",
        "source": "Declared interface engineering fixture v1; not measured or fitted.",
    }
    constraints = COMMON | PROFILE_PARAMETERS[profile]
    initial_values = {
        "electrode_electrolyte": [0.0, 1.0],
        "catalyst_reactant": [0.0, 0.0, 1.0, 0.0],
        "solid_liquid": [0.0, 0.0, 1.0, 0.01],
    }[profile]
    return {
        "version": VERSION,
        "profile": profile,
        "candidate_hashes": {
            "organic": content_hash(organic_candidate),
            "inorganic": content_hash(inorganic_candidate),
        },
        "mechanism": importlib.import_module(
            "chem_workbench.interface_mechanisms"
        ).mechanism_for_candidate(profile, organic_candidate, inorganic_candidate),
        "parameters": {
            key: {
                "value": value,
                "unit": constraints[key][0],
                "provenance": copy.deepcopy(provenance),
            }
            for key, value in values.items()
        },
        "initial_conditions": {
            key: {
                "value": value,
                "unit": "1" if key.startswith("theta_") else "mol/m^3",
                "provenance": copy.deepcopy(provenance),
            }
            for key, value in zip(INITIAL_FIELDS[profile], initial_values, strict=True)
        },
        "time_grid": {
            "values": [0.3 * index for index in range(101)],
            "unit": "s",
            "provenance": provenance,
        },
    }
