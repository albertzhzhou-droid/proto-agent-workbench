"""Bounded, offline dynamical-systems simulations adapted from Biomni.

Portions adapted from Biomni (Stanford SNAP), Apache License 2.0, commit
400c1f366b96a35ca253e13c9b06c5076af41d65. See
apps/proto-workbench/THIRD_PARTY_NOTICES.md and the packaged Apache license.
Modifications: pure NumPy/SciPy reimplementation without pandas/matplotlib or
file artifacts, JSON-declared systems only (upstream's callable/ODE-function
injection is excluded as arbitrary code execution), structured results, strict
validation, deterministic seeded stochastic simulation, and a corrected
growth-dilution ordering bug in the gene-circuit model. Flux balance analysis is
solved with scipy.optimize.linprog on a JSON reaction network instead of cobra
SBML models.
"""

from __future__ import annotations

import math


def _number(value, name, *, minimum=None, maximum=None, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite number.")
    result = float(value)
    if not math.isfinite(result) or abs(result) > 1e100:
        raise ValueError(f"{name} must be finite with magnitude <= 1e100.")
    if positive and result <= 0:
        raise ValueError(f"{name} must be positive.")
    if minimum is not None and result < minimum or maximum is not None and result > maximum:
        raise ValueError(f"{name} is outside its allowed range.")
    return result


def _numbers(value, name, *, minimum=2, maximum=5000):
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        raise ValueError(f"{name} must contain {minimum} to {maximum} numbers.")
    return [_number(item, f"{name}[{index}]") for index, item in enumerate(value)]


def _integer(value, name, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be an integer from {minimum} to {maximum}.")
    return value


def _boolean(value, name):
    if not isinstance(value, bool):
        raise ValueError(f"{name} must be a boolean.")
    return value


def _string(value, name, maximum=100):
    if not isinstance(value, str) or not 1 <= len(value) <= maximum or value.strip() != value:
        raise ValueError(f"{name} must be a nonempty trimmed string of at most {maximum} characters.")
    return value


def _rates(value, name, count=None, minimum=0.0):
    if not isinstance(value, list) or not 1 <= len(value) <= 200:
        raise ValueError(f"{name} must contain 1 to 200 rates.")
    if count is not None and len(value) != count:
        raise ValueError(f"{name} must contain exactly {count} entries.")
    return [_number(item, f"{name}[{index}]", minimum=minimum) for index, item in enumerate(value)]


def _sample(times, series, limit=400):
    """Downsample trajectory columns deterministically for compact results."""
    if len(times) <= limit:
        return [round(float(t), 6) for t in times], {key: [round(float(v), 8) for v in values] for key, values in series.items()}
    stride = math.ceil(len(times) / limit)
    indices = sorted(set(list(range(0, len(times), stride)) + [len(times) - 1]))
    return ([round(float(times[i]), 6) for i in indices],
            {key: [round(float(values[i]), 8) for i in indices] for key, values in series.items()})


def _solve(odes, t_span, y0, t_eval, method):
    import numpy as np
    from scipy.integrate import solve_ivp

    solution = solve_ivp(odes, (0.0, t_span), y0, method=method, t_eval=t_eval, rtol=1e-6, atol=1e-9)
    if not solution.success or not solution.y.size or not bool(np.isfinite(solution.y).all()):
        raise ValueError(f"Simulation failed to integrate: {solution.message}. Check rates and initial values for stiffness or divergence.")
    return solution


_SIM_LIMITS = ["Trajectories are deterministic solutions of the declared ODE system with the supplied parameters; they are model extrapolations, not measurements.",
               "Downsampled to at most 400 output points per trajectory; full-resolution arrays are not retained."]


def simulate_whole_cell_ode_model(arguments):
    """Upstream's default four-state model only; callable injection is excluded."""
    rates = arguments.get("rates")
    if not isinstance(rates, dict) or set(rates) != {"k_transcription", "k_translation", "k_mrna_deg", "k_protein_deg", "k_metabolism", "k_atp_production", "k_atp_consumption"}:
        raise ValueError("rates must contain exactly the seven whole-cell model rate constants.")
    values = {key: _number(value, f"rates.{key}", minimum=0) for key, value in rates.items()}
    initial = arguments.get("initial_conditions")
    if not isinstance(initial, dict) or set(initial) != {"mRNA", "protein", "metabolite", "atp"}:
        raise ValueError("initial_conditions must contain exactly mRNA, protein, metabolite, and atp.")
    y0 = [_number(initial[name], f"initial_conditions.{name}", minimum=0) for name in ("mRNA", "protein", "metabolite", "atp")]
    duration = _number(arguments.get("duration", 100.0), "duration", minimum=0, maximum=1e6)
    output_points = _integer(arguments.get("output_points", 200), "output_points", 2, 2000)
    import numpy as np

    def odes(_t, y):
        mrna, protein, metabolite, atp = y
        return [values["k_transcription"] - values["k_mrna_deg"] * mrna,
                values["k_translation"] * mrna * atp - values["k_protein_deg"] * protein,
                values["k_metabolism"] * protein - values["k_atp_production"] * metabolite,
                values["k_atp_production"] * metabolite - values["k_atp_consumption"] * atp - values["k_translation"] * mrna * atp]

    t_eval = np.linspace(0.0, duration, output_points)
    solution = _solve(odes, duration, y0, t_eval, "LSODA")
    names = ["mRNA", "protein", "metabolite", "atp"]
    times, series = _sample(solution.t, {name: solution.y[index] for index, name in enumerate(names)})
    return {
        "duration": duration, "species": names, "initial_conditions": dict(zip(names, y0)), "rates": values,
        "times": times, **series, "final_state": {name: round(float(solution.y[index, -1]), 8) for index, name in enumerate(names)},
        "method": "Upstream default whole-cell ODE system (mRNA/protein/metabolite/ATP) via SciPy LSODA",
        "limitations": _SIM_LIMITS + ["Upstream accepts arbitrary Python ODE callables; that code-execution path is deliberately not ported.",
                                      "The four-state scheme is a coarse caricature of whole-cell metabolism, not a genome-scale model."],
    }


def model_bacterial_growth_dynamics(arguments):
    initial_population = _number(arguments.get("initial_population"), "initial_population", minimum=0)
    growth_rate = _number(arguments.get("growth_rate"), "growth_rate", minimum=0)
    clearance_rate = _number(arguments.get("clearance_rate"), "clearance_rate", minimum=0)
    niche_size = _number(arguments.get("niche_size"), "niche_size", positive=True)
    duration = _number(arguments.get("duration", 48.0), "duration", positive=True, maximum=1e6)
    output_points = _integer(arguments.get("output_points", 200), "output_points", 2, 2000)
    import numpy as np

    def odes(_t, y):
        return [growth_rate * y[0] * (1 - y[0] / niche_size) - clearance_rate * y[0]]

    t_eval = np.linspace(0.0, duration, output_points)
    solution = _solve(odes, duration, [initial_population], t_eval, "RK45")
    population = solution.y[0]
    last = max(1, int(len(population) * 0.9))
    steady = abs(population[-1] - population[last]) / max(population[last], 1e-300) < 0.01 if population[last] else population[-1] == 0
    times, series = _sample(solution.t, {"population": population})
    return {
        "initial_population": initial_population, "growth_rate": growth_rate, "clearance_rate": clearance_rate,
        "niche_size": niche_size, "duration": duration,
        "maximum_population": round(float(population.max()), 8), "final_population": round(float(population[-1]), 8),
        "steady_state_reached": bool(steady),
        "analytic_carrying_capacity": round(niche_size * (1 - clearance_rate / growth_rate), 8) if growth_rate > 0 else 0.0,
        "times": times, **series, "method": "Logistic growth with linear clearance via SciPy RK45",
        "limitations": _SIM_LIMITS + ["Single-compartment logistic model; no lag phase, resource structure, or spatial effects.",
                                      "Analytic carrying capacity is negative (population collapse) whenever clearance exceeds growth."],
    }


def simulate_generalized_lotka_volterra_dynamics(arguments):
    initial = _numbers(arguments.get("initial_abundances"), "initial_abundances", minimum=1, maximum=50)
    growth_rates = _rates(arguments.get("growth_rates"), "growth_rates", count=len(initial))
    matrix = arguments.get("interaction_matrix")
    n = len(initial)
    if not isinstance(matrix, list) or len(matrix) != n or any(not isinstance(row, list) or len(row) != n for row in matrix):
        raise ValueError(f"interaction_matrix must be {n}x{n} matching initial_abundances.")
    interactions = [[_number(item, f"interaction_matrix[{i}][{j}]", minimum=-1e6, maximum=1e6) for j, item in enumerate(row)] for i, row in enumerate(matrix)]
    duration = _number(arguments.get("duration", 50.0), "duration", positive=True, maximum=1e6)
    output_points = _integer(arguments.get("output_points", 200), "output_points", 2, 2000)
    import numpy as np
    from scipy.integrate import odeint

    growth = np.asarray(growth_rates)
    interaction = np.asarray(interactions)

    def glv(y, _t):
        return y * (growth + interaction @ y)

    t_eval = np.linspace(0.0, duration, output_points)
    try:
        trajectory = odeint(glv, np.asarray(initial), t_eval, rtol=1e-8, atol=1e-10, mxstep=10_000)
    except (RuntimeError, OverflowError) as error:
        raise ValueError("The gLV system diverged or stiffened under the supplied parameters.") from error
    if not np.isfinite(trajectory).all():
        raise ValueError("The gLV system produced non-finite abundances; check interaction strengths.")
    final = trajectory[-1]
    names = [f"species_{index + 1}" for index in range(n)]
    times, series = _sample(t_eval, {name: trajectory[:, index] for index, name in enumerate(names)})
    return {
        "species_count": n, "duration": duration, "initial_total_abundance": round(sum(initial), 8),
        "final_total_abundance": round(float(final.sum()), 8),
        "final_abundances": {name: round(float(value), 8) for name, value in zip(names, final)},
        "dominant_species": names[int(np.argmax(final))], "near_extinct_species": int((final < 1e-6).sum()),
        "times": times, **series, "method": "Generalized Lotka-Volterra ODE via SciPy odeint (LSODA)",
        "limitations": _SIM_LIMITS + ["gLV interactions are symmetric-free linear approximations; negative abundances can appear transiently with strong interactions.",
                                      "No carrying-capacity constraints or immigration; ecological interpretability depends entirely on parameter provenance."],
    }


def simulate_microbial_population_dynamics(arguments):
    """Seeded Gillespie stochastic simulation; upstream is unseeded."""
    initial = _numbers(arguments.get("initial_populations"), "initial_populations", minimum=1, maximum=10)
    n = len(initial)
    growth = _rates(arguments.get("growth_rates"), "growth_rates", count=n)
    clearance = _rates(arguments.get("clearance_rates"), "clearance_rates", count=n)
    supplied_capacities = arguments.get("carrying_capacities")
    if not isinstance(supplied_capacities, list) or len(supplied_capacities) != n:
        raise ValueError(f"carrying_capacities must contain exactly {n} entries.")
    capacities = [_number(value, f"carrying_capacities[{index}]", minimum=1) for index, value in enumerate(supplied_capacities)]
    max_time = _number(arguments.get("max_time", 100.0), "max_time", positive=True, maximum=1e6)
    output_points = _integer(arguments.get("output_points", 100), "output_points", 2, 1000)
    simulations = _integer(arguments.get("simulations", 20), "simulations", 1, 200)
    seed = _integer(arguments.get("seed", 0), "seed", 0, 2**31 - 1)
    import numpy as np

    rng = np.random.default_rng(seed)
    time_grid = np.linspace(0.0, max_time, output_points)
    average = np.zeros((n, output_points))
    extinctions = [[] for _ in range(n)]
    for _run in range(simulations):
        population = np.array(initial, dtype=float)
        time = 0.0
        trajectory = np.zeros((n, output_points))
        next_index = 0
        while next_index < output_points and time >= time_grid[next_index]:
            trajectory[:, next_index] = population
            next_index += 1
        while time < max_time and (population > 0).any():
            growth_rates = [growth[i] * population[i] * (1 - population[i] / capacities[i]) if population[i] > 0 else 0.0 for i in range(n)]
            death_rates = [clearance[i] * population[i] if population[i] > 0 else 0.0 for i in range(n)]
            total = sum(growth_rates) + sum(death_rates)
            if total <= 0:
                break
            time += rng.exponential(1.0 / total)
            while next_index < output_points and time >= time_grid[next_index]:
                trajectory[:, next_index] = population
                next_index += 1
            if time >= max_time:
                break
            event = int(rng.choice(2 * n, p=np.asarray(growth_rates + death_rates) / total))
            if event < n:
                population[event] += 1
            else:
                species = event - n
                population[species] -= 1
                if population[species] == 0:
                    extinctions[species].append(time)
        while next_index < output_points:
            trajectory[:, next_index] = population
            next_index += 1
        average += trajectory
    average /= simulations
    names = [f"species_{index + 1}" for index in range(n)]
    times, series = _sample(time_grid, {name: average[index] for index, name in enumerate(names)})
    extinction_summary = []
    for index, name in enumerate(names):
        events = extinctions[index]
        extinction_summary.append({"species": name,
                                   "extinction_probability": round(len(events) / simulations, 4),
                                   "median_extinction_time": round(float(np.median(events)), 6) if events else None})
    return {
        "species_count": n, "simulations": simulations, "seed": seed, "max_time": max_time,
        "average_final_populations": {name: round(float(average[index, -1]), 6) for index, name in enumerate(names)},
        "extinctions": extinction_summary, "times": times, **series,
        "method": "Seeded Gillespie direct-method stochastic simulation averaged over runs",
        "limitations": ["Stochastic trajectories depend on the supplied seed; identical seeds reproduce results exactly.",
                        "Demographic stochasticity only; no environmental noise, migration, or trait structure.",
                        f"Averaged over {simulations} runs; extinction statistics are noisy for small run counts."],
    }


_WC_SPECIES = ["T4_blood_free", "TBG_blood", "T4_TBG_complex", "T4_liver_free", "T3_liver_free"]


def simulate_thyroid_hormone_pharmacokinetics(arguments):
    initial = arguments.get("initial_conditions")
    if not isinstance(initial, dict) or set(initial) != set(_WC_SPECIES):
        raise ValueError(f"initial_conditions must contain exactly: {', '.join(_WC_SPECIES)}.")
    y0 = [_number(initial[name], f"initial_conditions.{name}", minimum=0) for name in _WC_SPECIES]
    parameters = arguments.get("parameters")
    required = {"blood_to_liver", "k_on_T4_TBG", "k_off_T4_TBG", "T4_to_T3_liver"}
    if not isinstance(parameters, dict) or not required <= set(parameters) <= required | {"volumes"}:
        raise ValueError(f"parameters must contain {', '.join(sorted(required))} and optional volumes.")
    values = {key: _number(parameters[key], f"parameters.{key}", minimum=0) for key in required}
    volumes = {"blood": _number(parameters.get("volumes", {}).get("blood", 1.0) if isinstance(parameters.get("volumes"), dict) else 1.0, "parameters.volumes.blood", minimum=1e-9),
               "liver": _number(parameters.get("volumes", {}).get("liver", 1.0) if isinstance(parameters.get("volumes"), dict) else 1.0, "parameters.volumes.liver", minimum=1e-9)}
    duration = _number(arguments.get("duration", 240.0), "duration", positive=True, maximum=1e6)
    output_points = _integer(arguments.get("output_points", 200), "output_points", 2, 2000)
    import numpy as np

    def odes(_t, y):
        t4_blood, tbg, complex_, t4_liver, t3_liver = y
        transport = values["blood_to_liver"] * t4_blood / volumes["blood"]
        association = values["k_on_T4_TBG"] * t4_blood * tbg
        dissociation = values["k_off_T4_TBG"] * complex_
        conversion = values["T4_to_T3_liver"] * t4_liver
        return [-transport - association + dissociation,
                -association + dissociation,
                association - dissociation,
                transport / volumes["liver"] - conversion,
                conversion]

    t_eval = np.linspace(0.0, duration, output_points)
    solution = _solve(odes, duration, y0, t_eval, "BDF")
    times, series = _sample(solution.t, {name: solution.y[index] for index, name in enumerate(_WC_SPECIES)})
    peaks = {}
    for index, name in enumerate(_WC_SPECIES):
        peak_at = int(np.argmax(solution.y[index]))
        peaks[name] = {"peak": round(float(solution.y[index, peak_at]), 8), "peak_time": round(float(solution.t[peak_at]), 6),
                       "final": round(float(solution.y[index, -1]), 8)}
    return {
        "duration": duration, "species": _WC_SPECIES, "initial_conditions": initial,
        "parameters": {**values, "volumes": volumes}, "species_summary": peaks, "times": times, **series,
        "method": "Five-species thyroid hormone transport/binding/metabolism ODE via SciPy BDF",
        "limitations": _SIM_LIMITS + ["Fixed topology keyed to the declared species names; no renal, thyroid, or peripheral T3 compartments.",
                                      "Binding kinetics use mass-action with the supplied constants; no thyroid-axis feedback."],
    }


_RAS_SPECIES = ["renin", "angiotensinogen", "angiotensin_I", "angiotensin_II", "ACE2_angiotensin_II", "angiotensin_1_7"]


def simulate_renin_angiotensin_system_dynamics(arguments):
    initial = arguments.get("initial_concentrations")
    if not isinstance(initial, dict) or set(initial) != set(_RAS_SPECIES):
        raise ValueError(f"initial_concentrations must contain exactly: {', '.join(_RAS_SPECIES)}.")
    y0 = [_number(initial[name], f"initial_concentrations.{name}", minimum=0) for name in _RAS_SPECIES]
    rates = arguments.get("rate_constants")
    required = {"k_ren", "k_agt", "k_ace", "k_ace2", "k_at1r", "k_mas"}
    if not isinstance(rates, dict) or set(rates) != required:
        raise ValueError(f"rate_constants must contain exactly: {', '.join(sorted(required))}.")
    values = {key: _number(rates[key], f"rate_constants.{key}", minimum=0) for key in required}
    feedback = _number(arguments.get("angiotensin_II_feedback", 0.5), "angiotensin_II_feedback", minimum=0)
    duration = _number(arguments.get("duration", 48.0), "duration", positive=True, maximum=1e6)
    output_points = _integer(arguments.get("output_points", 200), "output_points", 2, 2000)
    import numpy as np

    def odes(_t, y):
        renin, agt, ang_i, ang_ii, ace2_complex, ang_1_7 = y
        renin_production = values["k_ren"] / (1 + feedback * ang_ii)
        ang_i_formation = renin * agt
        return [renin_production - 0.1 * renin,
                values["k_agt"] - 0.05 * agt - ang_i_formation,
                ang_i_formation - 0.2 * ang_i - values["k_ace"] * ang_i,
                values["k_ace"] * ang_i - (0.3 + values["k_at1r"]) * ang_ii - values["k_ace2"] * ang_ii,
                values["k_ace2"] * ang_ii - 0.15 * ace2_complex - ace2_complex,
                ace2_complex - (0.25 + values["k_mas"]) * ang_1_7]

    t_eval = np.linspace(0.0, duration, output_points)
    solution = _solve(odes, duration, y0, t_eval, "RK45")
    times, series = _sample(solution.t, {name: solution.y[index] for index, name in enumerate(_RAS_SPECIES)})
    return {
        "duration": duration, "species": _RAS_SPECIES, "initial_concentrations": initial,
        "rate_constants": values, "angiotensin_ii_feedback": feedback,
        "final_concentrations": {name: round(float(solution.y[index, -1]), 8) for index, name in enumerate(_RAS_SPECIES)},
        "times": times, **series,
        "method": "Six-species renin-angiotensin cascade ODE with AngII renin feedback via SciPy RK45",
        "limitations": _SIM_LIMITS + ["Fixed linear clearances are inherited from upstream; concentrations are in arbitrary declared units.",
                                      "A pharmacological toy model, not a validated physiological RAS simulator."],
    }


def model_protein_dimerization_network(arguments):
    """Equilibrium dimer concentrations; koff fixed at 1.0 exactly as upstream."""
    supplied_monomers = arguments.get("monomer_concentrations")
    if not isinstance(supplied_monomers, list) or not 1 <= len(supplied_monomers) <= 50:
        raise ValueError("monomer_concentrations must contain 1 to 50 {name, concentration} entries.")
    monomers = {}
    for index, entry in enumerate(supplied_monomers):
        if not isinstance(entry, dict) or set(entry) != {"name", "concentration"}:
            raise ValueError(f"monomer_concentrations[{index}] must contain exactly name and concentration.")
        name = _string(entry["name"], f"monomer_concentrations[{index}].name")
        if name in monomers:
            raise ValueError(f"Duplicate monomer {name}.")
        monomers[name] = _number(entry["concentration"], f"monomer_concentrations[{index}].concentration", minimum=0)
    topology = arguments.get("network_topology")
    if not isinstance(topology, list) or not 1 <= len(topology) <= 200:
        raise ValueError("network_topology must contain 1 to 200 pairs.")
    supplied_affinities = arguments.get("dimerization_affinities")
    if not isinstance(supplied_affinities, list) or not 1 <= len(supplied_affinities) <= 200:
        raise ValueError("dimerization_affinities must contain 1 to 200 {dimer, k_on} entries.")
    affinities = {}
    for index, entry in enumerate(supplied_affinities):
        if not isinstance(entry, dict) or set(entry) != {"dimer", "k_on"}:
            raise ValueError(f"dimerization_affinities[{index}] must contain exactly dimer and k_on.")
        key = _string(entry["dimer"], f"dimerization_affinities[{index}].dimer")
        if key in affinities:
            raise ValueError(f"Duplicate dimer {key}.")
        affinities[key] = _number(entry["k_on"], f"dimerization_affinities[{index}].k_on", minimum=0)
    pairs, names, constants = [], [], []
    for index, pair in enumerate(topology):
        if not isinstance(pair, list) or len(pair) != 2 or any(not isinstance(member, str) for member in pair):
            raise ValueError(f"network_topology[{index}] must be a [monomer_a, monomer_b] pair.")
        first, second = pair
        if first not in monomers or second not in monomers:
            raise ValueError(f"network_topology[{index}] references an unknown monomer.")
        key = f"{first}-{second}" if f"{first}-{second}" in affinities else (f"{second}-{first}" if f"{second}-{first}" in affinities else None)
        if key is None:
            raise ValueError(f"No dimerization affinity for pair {first}-{second}.")
        pairs.append((first, second))
        names.append(key)
        constants.append(_number(affinities[key], f"dimerization_affinities[{key}]", minimum=0))
    import numpy as np

    all_monomers = list(monomers)
    index_of = {name: position for position, name in enumerate(all_monomers)}
    n, d = len(all_monomers), len(pairs)
    y0 = np.zeros(n + d)
    for name, concentration in monomers.items():
        y0[index_of[name]] = concentration

    def odes(_t, y):
        dydt = np.zeros_like(y)
        for i, ((first, second), k_on) in enumerate(zip(pairs, constants)):
            rate = k_on * y[index_of[first]] * y[index_of[second]] - 1.0 * y[n + i]
            dydt[index_of[first]] -= rate
            dydt[index_of[second]] -= rate
            dydt[n + i] += rate
        return dydt

    solution = _solve(odes, 1000.0, y0, np.linspace(0.0, 1000.0, 200), "BDF")
    monomer_final = {name: round(float(solution.y[index_of[name], -1]), 8) for name in all_monomers}
    dimer_final = {name: round(float(solution.y[n + i, -1]), 8) for i, name in enumerate(names)}
    return {
        "monomer_count": n, "dimer_count": d, "initial_monomer_concentrations": monomers,
        "equilibrium_monomers": monomer_final, "equilibrium_dimers": dimer_final,
        "method": "Mass-action dimerization to equilibrium (k_on from affinity table, k_off fixed at 1.0 as upstream)",
        "limitations": ["k_off is hardcoded to 1.0 exactly as upstream; affinities therefore act as kon/koff ratios only with this convention.",
                        "Homodimers must be encoded as [a, a] pairs; no higher-order complexes, degradation, or localization."],
    }


def simulate_protein_signaling_network(arguments):
    structure = arguments.get("network_structure")
    if not isinstance(structure, list) or not 1 <= len(structure) <= 50:
        raise ValueError("network_structure must contain 1 to 50 target entries.")
    species_params = arguments.get("species_params")
    if not isinstance(species_params, list) or not 1 <= len(species_params) <= 50:
        raise ValueError("species_params must contain 1 to 50 species entries.")
    edges = []
    proteins = set()
    for index, entry in enumerate(structure):
        if not isinstance(entry, dict) or set(entry) != {"target", "regulators"} or not isinstance(entry["regulators"], list):
            raise ValueError(f"network_structure[{index}] must contain target and regulators.")
        target = _string(entry["target"], f"network_structure[{index}].target")
        proteins.add(target)
        for regulator in entry["regulators"]:
            if not isinstance(regulator, dict) or set(regulator) != {"regulator", "type"} or regulator.get("type") not in (1, -1):
                raise ValueError(f"network_structure[{index}] regulators need regulator and type (1 activation, -1 inhibition).")
            proteins.add(_string(regulator["regulator"], "regulator name"))
            edges.append((regulator["regulator"], target, regulator["type"]))
    params = {}
    for index, entry in enumerate(species_params):
        if not isinstance(entry, dict) or set(entry) != {"protein", "y0", "tau", "ymax"}:
            raise ValueError(f"species_params[{index}] must contain protein, y0, tau, and ymax.")
        name = _string(entry["protein"], f"species_params[{index}].protein")
        params[name] = {"y0": _number(entry["y0"], "y0", minimum=0),
                        "tau": _number(entry["tau"], "tau", positive=True, maximum=1e6),
                        "ymax": _number(entry["ymax"], "ymax", minimum=0)}
    edge_params = {}
    supplied = arguments.get("reaction_params")
    if not isinstance(supplied, list):
        raise ValueError("reaction_params must contain edge parameter entries.")
    for index, entry in enumerate(supplied):
        if not isinstance(entry, dict) or set(entry) != {"regulator", "target", "n", "ec50", "weight"}:
            raise ValueError(f"reaction_params[{index}] must contain regulator, target, n, ec50, and weight.")
        key = (_string(entry["regulator"], "regulator"), _string(entry["target"], "target"))
        if key not in {(edge[0], edge[1]) for edge in edges}:
            raise ValueError(f"reaction_params[{index}] does not match any network edge.")
        edge_params[key] = {"n": _number(entry["n"], "n", minimum=0.1, maximum=10),
                            "ec50": _number(entry["ec50"], "ec50", minimum=1e-12),
                            "weight": _number(entry["weight"], "weight", minimum=0)}
    missing = {(edge[0], edge[1]) for edge in edges} - set(edge_params)
    if missing:
        raise ValueError(f"Missing reaction_params for edges: {sorted(missing)}.")
    unknown_species = set(params) - proteins
    if unknown_species:
        raise ValueError(f"species_params references unknown proteins: {sorted(unknown_species)}.")
    duration = _number(arguments.get("duration", 100.0), "duration", positive=True, maximum=1e6)
    output_points = _integer(arguments.get("output_points", 200), "output_points", 2, 2000)
    import numpy as np

    ordered = sorted(proteins)
    index_of = {name: position for position, name in enumerate(ordered)}
    by_target = {}
    for regulator, target, kind in edges:
        by_target.setdefault(target, []).append((regulator, kind))

    def hill(x, n, ec50):
        return x ** n / (x ** n + ec50 ** n)

    def odes(_t, y):
        dydt = np.zeros_like(y)
        for target, regulators in by_target.items():
            terms = []
            for regulator, kind in regulators:
                p = edge_params[(regulator, target)]
                value = p["weight"] * hill(y[index_of[regulator]], p["n"], p["ec50"])
                terms.append(value if kind == 1 else p["weight"] - value)
            regulation = max(0.0, min(1.0, sum(terms) / len(terms)))
            spec = params[target]
            dydt[index_of[target]] = (spec["ymax"] * regulation - y[index_of[target]]) / spec["tau"]
        return dydt

    y0 = np.zeros(len(ordered))
    for name, spec in params.items():
        y0[index_of[name]] = spec["y0"]
    t_eval = np.linspace(0.0, duration, output_points)
    solution = _solve(odes, duration, y0, t_eval, "LSODA")
    times, series = _sample(solution.t, {name: solution.y[index_of[name]] for name in ordered})
    return {
        "proteins": ordered, "duration": duration, "edge_count": len(edges),
        "final_concentrations": {name: round(float(solution.y[index_of[name], -1]), 8) for name in ordered},
        "times": times, **series,
        "method": "Normalized Hill-function logic ODE network via SciPy LSODA (activation/inhibition averaged per target)",
        "limitations": ["Regulation terms are averaged then clipped to [0, 1] exactly as upstream; this is a qualitative logic model, not mechanistic signaling.",
                        "Proteins without incoming edges stay at their initial values; parameters are user-supplied and unvalidated."],
    }


def simulate_gene_circuit_with_growth_feedback(arguments):
    """Corrected dilution: upstream read dM/dt before computing it (always zero)."""
    topology = arguments.get("circuit_topology")
    size = None
    if not isinstance(topology, list) or not 1 <= len(topology) <= 20:
        raise ValueError("circuit_topology must contain 1 to 20 rows.")
    for i, row in enumerate(topology):
        if not isinstance(row, list) or any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in row):
            raise ValueError(f"circuit_topology[{i}] must be a numeric row.")
        if size is None:
            size = len(row)
        elif len(row) != size:
            raise ValueError("circuit_topology must be square.")
    n = len(topology)
    matrix = [[_number(v, f"circuit_topology[{i}][{j}]", minimum=-10, maximum=10) for j, v in enumerate(row)] for i, row in enumerate(topology)]
    kinetic = arguments.get("kinetic_params")
    if not isinstance(kinetic, dict) or set(kinetic) != {"basal_rates", "degradation_rates", "hill_coefficients", "threshold_constants"}:
        raise ValueError("kinetic_params must contain basal_rates, degradation_rates, hill_coefficients, and threshold_constants.")
    rates = {key: _rates(kinetic[key], f"kinetic_params.{key}", count=n, minimum=0.0) for key in kinetic}
    rates["hill_coefficients"] = [_number(v, "hill_coefficients entry", minimum=0.1, maximum=10) for v in kinetic["hill_coefficients"]]
    growth = arguments.get("growth_params")
    if not isinstance(growth, dict) or set(growth) != {"max_growth_rate", "growth_inhibition", "gene_growth_weights"}:
        raise ValueError("growth_params must contain max_growth_rate, growth_inhibition, and gene_growth_weights.")
    max_growth = _number(growth["max_growth_rate"], "growth_params.max_growth_rate", minimum=0)
    inhibition = _number(growth["growth_inhibition"], "growth_params.growth_inhibition", minimum=0)
    weights = _rates(growth["gene_growth_weights"], "gene_growth_weights", count=n, minimum=-10)
    duration = _number(arguments.get("duration", 100.0), "duration", positive=True, maximum=1e6)
    output_points = _integer(arguments.get("output_points", 200), "output_points", 2, 2000)
    import numpy as np

    topology_matrix = np.asarray(matrix)

    def odes(_t, y):
        gene = y[:n]
        mass = y[n]
        burden = sum(weights[i] * gene[i] for i in range(n))
        mu = max_growth / (1 + inhibition * burden) if mass > 0 else 0.0
        dydt = np.zeros(n + 1)
        for i in range(n):
            production = rates["basal_rates"][i]
            for j in range(n):
                weight = topology_matrix[i][j]
                if weight == 0:
                    continue
                regulation = gene[j] ** rates["hill_coefficients"][j] / (
                    rates["threshold_constants"][j] ** rates["hill_coefficients"][j] + gene[j] ** rates["hill_coefficients"][j])
                production *= (1 + weight * regulation) if weight > 0 else (1 + weight * (1 - regulation))
            dydt[i] = production - (rates["degradation_rates"][i] + mu) * gene[i]
        dydt[n] = mu * mass
        return dydt

    y0 = np.zeros(n + 1)
    y0[:n] = 0.1
    y0[n] = 1.0
    t_eval = np.linspace(0.0, duration, output_points)
    solution = _solve(odes, duration, y0, t_eval, "LSODA")
    names = [f"gene_{index + 1}" for index in range(n)]
    times, series = _sample(solution.t, {**{name: solution.y[index] for index, name in enumerate(names)}, "cell_mass": solution.y[n]})
    return {
        "gene_count": n, "duration": duration, "final_gene_expression": {name: round(float(solution.y[index, -1]), 8) for index, name in enumerate(names)},
        "final_cell_mass": round(float(solution.y[n, -1]), 8),
        "final_specific_growth_rate": round(max_growth / (1 + inhibition * sum(weights[i] * solution.y[i, -1] for i in range(n))), 8),
        "times": times, **series,
        "method": "Hill-regulated gene circuit with growth dilution and burden feedback via SciPy LSODA",
        "limitations": _SIM_LIMITS + ["Upstream evaluated the dilution term before computing cell-mass growth (always zero); this port computes the specific growth rate first and is not bit-compatible with upstream.",
                                      "Initial conditions are fixed at 0.1 expression and unit mass exactly as upstream; regulation multiplies basal production per regulator."],
    }


def analyze_bifurcation_diagram(arguments):
    series_data = arguments.get("time_series_data")
    parameters = _numbers(arguments.get("parameter_values"), "parameter_values", minimum=1, maximum=200)
    if not isinstance(series_data, list) or len(series_data) != len(parameters):
        raise ValueError(f"time_series_data must contain exactly {len(parameters)} series.")
    windows = []
    for index, series in enumerate(series_data):
        values = _numbers(series, f"time_series_data[{index}]", minimum=10)
        windows.append(values)
    import numpy as np
    from scipy.signal import find_peaks

    regimes, transitions, attractor_samples = [], [], []
    for index, (parameter, series) in enumerate(zip(parameters, windows)):
        steady = np.asarray(series[int(0.7 * len(series)):], dtype=float)
        peaks, _ = find_peaks(steady)
        diffs = np.abs(np.diff(steady))
        lyapunov = float(np.log(np.mean(diffs))) if np.mean(diffs) > 0 else -1.0
        count = len(peaks)
        if lyapunov > 0.05:
            regime = "chaotic"
        elif count == 0:
            regime = "stable"
        elif count in (1, 2, 4):
            regime = f"period-{count}"
        elif lyapunov > 0:
            regime = "chaotic"
        else:
            regime = f"period-{count}"
        regimes.append(regime)
        points = steady[peaks] if count else steady[-5:]
        attractor_samples.append([round(float(v), 8) for v in points[:50]])
        if index and regimes[index - 1] != regime:
            transitions.append({"from": regimes[index - 1], "to": regime, "parameter": round(float(parameter), 8)})
    counts = {}
    for regime in regimes:
        counts[regime] = counts.get(regime, 0) + 1
    return {
        "parameter_count": len(parameters), "regimes": [{"parameter": round(float(p), 8), "regime": r} for p, r in zip(parameters, regimes)],
        "regime_counts": counts, "transitions": transitions, "attractor_extrema": attractor_samples,
        "method": "Last-30% peak counting with a mean-log-diff chaos heuristic; classifications mirror upstream thresholds",
        "limitations": ["The Lyapunov-style estimate is log(mean|diff|), a rough chaos proxy rather than a true Lyapunov exponent.",
                        "Regime labels depend on sampling density and transient cutoff; boundary parameters can flip labels under resampling."],
    }


def perform_flux_balance_analysis(arguments):
    """scipy linprog on a JSON reaction network; upstream loads cobra SBML models."""
    reactions = arguments.get("reactions")
    if not isinstance(reactions, list) or not 1 <= len(reactions) <= 200:
        raise ValueError("reactions must contain 1 to 200 entries.")
    objective = _string(arguments.get("objective_reaction"), "objective_reaction")
    parsed, metabolites = [], set()
    for index, reaction in enumerate(reactions):
        if not isinstance(reaction, dict) or not {"id", "stoichiometry"} <= set(reaction) <= {"id", "stoichiometry", "lower_bound", "upper_bound"}:
            raise ValueError(f"reactions[{index}] must contain id and stoichiometry, plus optional bounds.")
        identifier = _string(reaction["id"], f"reactions[{index}].id")
        if not isinstance(reaction["stoichiometry"], list):
            raise ValueError(f"reactions[{index}].stoichiometry must be a list of {{metabolite, coefficient}} entries.")
        stoichiometry = {}
        for entry_index, entry in enumerate(reaction["stoichiometry"]):
            if not isinstance(entry, dict) or set(entry) != {"metabolite", "coefficient"}:
                raise ValueError(f"reactions[{index}].stoichiometry[{entry_index}] must contain metabolite and coefficient.")
            name = _string(entry["metabolite"], "metabolite")
            coefficient = _number(entry["coefficient"], "coefficient", minimum=-1e6, maximum=1e6)
            if name in stoichiometry:
                raise ValueError(f"Duplicate metabolite {name} in reaction {identifier}.")
            stoichiometry[name] = coefficient
            metabolites.add(name)
        lower = _number(reaction.get("lower_bound", -1000.0), "lower_bound", minimum=-1e6, maximum=1e6)
        upper = _number(reaction.get("upper_bound", 1000.0), "upper_bound", minimum=-1e6, maximum=1e6)
        if lower > upper:
            raise ValueError(f"reactions[{index}] has lower_bound above upper_bound.")
        if not stoichiometry:
            raise ValueError(f"reactions[{index}] has an empty stoichiometry.")
        parsed.append({"id": identifier, "stoichiometry": stoichiometry, "lower": lower, "upper": upper})
    identifiers = [reaction["id"] for reaction in parsed]
    if len(set(identifiers)) != len(identifiers):
        raise ValueError("Reaction ids must be unique.")
    if objective not in identifiers:
        raise ValueError(f"objective_reaction {objective!r} is not among the reactions.")
    import numpy as np
    from scipy.optimize import linprog

    metabolite_list = sorted(metabolites)
    s_matrix = np.zeros((len(metabolite_list), len(parsed)))
    for column, reaction in enumerate(parsed):
        for name, coefficient in reaction["stoichiometry"].items():
            s_matrix[metabolite_list.index(name), column] = coefficient
    objective_vector = np.zeros(len(parsed))
    objective_vector[identifiers.index(objective)] = -1.0  # Maximize by minimizing the negative.
    result = linprog(objective_vector, A_eq=s_matrix, b_eq=np.zeros(len(metabolite_list)),
                     bounds=[(reaction["lower"], reaction["upper"]) for reaction in parsed], method="highs")
    if not result.success:
        return {"success": False, "status": result.status, "message": f"Optimization failed: {result.message}",
                "metabolites": metabolite_list, "reactions": identifiers,
                "limitations": ["A failed solve does not prove infeasibility of the biological system; bounds and mass balances may be misspecified."]}
    fluxes = result.x
    active = sum(1 for flux in fluxes if abs(flux) > 1e-6)
    ranked = sorted(range(len(parsed)), key=lambda i: -abs(fluxes[i]))[:10]
    return {
        "success": True, "objective_reaction": objective, "objective_value": round(float(-result.fun), 8),
        "metabolite_count": len(metabolite_list), "reaction_count": len(parsed), "active_reactions": active,
        "fluxes": {identifier: round(float(flux), 8) for identifier, flux in zip(identifiers, fluxes)},
        "top_reactions_by_magnitude": [{"reaction": identifiers[i], "flux": round(float(fluxes[i]), 8)} for i in ranked],
        "method": "Flux balance analysis: steady-state S.v = 0, bounded fluxes, HiGHS linear programming via scipy.optimize.linprog",
        "limitations": ["FBA reports one optimal flux distribution among possibly many; no parsimony, thermodynamic, or regulatory constraints.",
                        "Adapted from cobra's SBML workflow to an explicit JSON network; gene-protein associations and compartments are not represented.",
                        "Objective values inherit whatever units the supplied bounds carry."],
    }


def optimize_anaerobic_digestion_process(arguments):
    """Upstream's toy surrogate response surfaces; labelled as such."""
    waste = arguments.get("waste_characteristics")
    if not isinstance(waste, dict) or set(waste) != {"volatile_solids", "cod"}:
        raise ValueError("waste_characteristics must contain volatile_solids and cod.")
    volatile_solids = _number(waste["volatile_solids"], "volatile_solids.volatile_solids", minimum=0, maximum=100)
    cod = _number(waste["cod"], "waste_characteristics.cod", minimum=0, maximum=1e6)
    ranges = arguments.get("operational_parameters")
    if not isinstance(ranges, dict) or set(ranges) != {"hrt", "olr", "if_ratio", "temperature", "ph"}:
        raise ValueError("operational_parameters must contain hrt, olr, if_ratio, temperature, and ph ranges.")
    bounds = []
    for key in ("hrt", "olr", "if_ratio", "temperature", "ph"):
        pair = ranges[key]
        if not isinstance(pair, list) or len(pair) != 2 or any(isinstance(b, bool) or not isinstance(b, (int, float)) for b in pair):
            raise ValueError(f"operational_parameters.{key} must be a [min, max] pair.")
        low, high = sorted((_number(pair[0], f"{key} min"), _number(pair[1], f"{key} max")))
        bounds.append((low, high))
    target = arguments.get("target_output", "methane_yield")
    if target not in ("vfa_production", "methane_yield"):
        raise ValueError("target_output must be vfa_production or methane_yield.")
    method = arguments.get("optimization_method", "l_bfgs_b")
    if method not in ("l_bfgs_b", "differential_evolution"):
        raise ValueError("optimization_method must be l_bfgs_b or differential_evolution.")
    import numpy as np
    from scipy.optimize import differential_evolution, minimize

    def model(params):
        hrt, olr, if_ratio, temp, ph = params
        if target == "vfa_production":
            value = (-0.1 * (hrt - 10) ** 2 + 2 * olr - 5 * if_ratio
                     - 0.05 * (temp - 35) ** 2 - 10 * (ph - 5.5) ** 2)
            value *= 0.8 + 0.2 * volatile_solids / 100
            value *= 0.9 + 0.1 * cod / 10000
        else:
            value = (0.05 * hrt - 0.5 * (olr - 3) ** 2 + 2 * if_ratio
                     - 0.05 * (temp - 37) ** 2 - 15 * (ph - 7.2) ** 2)
            value *= 0.7 + 0.3 * volatile_solids / 100
            value *= 0.8 + 0.2 * cod / 10000
        return value

    if method == "l_bfgs_b":
        result = minimize(lambda p: -model(p), [(low + high) / 2 for low, high in bounds], bounds=bounds, method="L-BFGS-B")
        optimal, value, evaluations = result.x, -result.fun, result.nfev
    else:
        result = differential_evolution(lambda p: -model(p), bounds, seed=0)
        optimal, value, evaluations = result.x, -result.fun, result.nfev
    names = ["hrt_days", "olr_kg_vs_per_m3_day", "inoculum_to_feedstock_ratio", "temperature_c", "ph"]
    sensitivities = []
    for index, (name, parameter, (low, high)) in enumerate(zip(names, optimal, bounds)):
        delta = max((high - low) * 0.05, 1e-9)
        plus, minus = list(optimal), list(optimal)
        plus[index] += delta
        minus[index] -= delta
        sensitivity = abs(model(plus) - model(minus)) / (2 * delta) * (parameter / value if value else 0.0)
        sensitivities.append({"parameter": name, "sensitivity": round(float(sensitivity), 8)})
    sensitivities.sort(key=lambda item: -item["sensitivity"])
    return {
        "target_output": target, "optimization_method": method, "function_evaluations": evaluations,
        "optimal_parameters": {name: round(float(value_), 6) for name, value_ in zip(names, optimal)},
        "predicted_output": round(float(value), 8), "sensitivities": sensitivities,
        "method": "Toy surrogate response-surface optimization exactly as upstream (quadratic penalties around fixed optima)",
        "limitations": ["The objective is upstream's illustrative quadratic surrogate, not a mechanistic anaerobic digestion model; absolute values are not engineering predictions.",
                        "Volatile-solids and COD multipliers are heuristic scalings; use results for qualitative trend exploration only."],
    }


def _schema(properties, required):
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


_NUMBERS_SCHEMA = {"type": "array", "items": {"type": "number"}, "minItems": 2, "maxItems": 5000}
_RATE_SCHEMA = {"type": "array", "items": {"type": "number"}, "minItems": 1, "maxItems": 200}


def _tool(title, description, schema, example, path, function):
    return {"title": title, "description": description, "input_schema": schema, "example": example,
            "dependency": ["numpy", "scipy"], "implementation": "biomni-adapted",
            "upstream_functions": [{"path": path, "name": function}]}


_WC_RATES = {"k_transcription": 1.0, "k_translation": 0.8, "k_mrna_deg": 0.3, "k_protein_deg": 0.1,
             "k_metabolism": 0.5, "k_atp_production": 0.4, "k_atp_consumption": 0.2}

TOOLS = {
    "simulate_whole_cell_ode_model": _tool(
        "Whole-cell ODE simulation", "Integrate upstream's fixed four-state mRNA/protein/metabolite/ATP model; no custom code execution.",
        _schema({"rates": _schema({key: {"type": "number", "minimum": 0, "maximum": 1e100} for key in _WC_RATES}, list(_WC_RATES)),
                 "initial_conditions": _schema({"mRNA": {"type": "number", "minimum": 0}, "protein": {"type": "number", "minimum": 0},
                                                "metabolite": {"type": "number", "minimum": 0}, "atp": {"type": "number", "minimum": 0}},
                                               ["mRNA", "protein", "metabolite", "atp"]),
                 "duration": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e6, "default": 100},
                 "output_points": {"type": "integer", "minimum": 2, "maximum": 2000, "default": 200}},
                ["rates", "initial_conditions"]),
        {"rates": _WC_RATES, "initial_conditions": {"mRNA": 0.5, "protein": 0, "metabolite": 0, "atp": 1}, "duration": 50, "output_points": 50},
        "biomni/tool/bioengineering.py", "simulate_whole_cell_ode_model"),
    "model_bacterial_growth_dynamics": _tool(
        "Bacterial population ODE", "Simulate logistic growth with clearance toward a niche capacity and report steady-state behavior.",
        _schema({"initial_population": {"type": "number", "minimum": 0}, "growth_rate": {"type": "number", "minimum": 0},
                 "clearance_rate": {"type": "number", "minimum": 0}, "niche_size": {"type": "number", "exclusiveMinimum": 0},
                 "duration": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e6, "default": 48},
                 "output_points": {"type": "integer", "minimum": 2, "maximum": 2000, "default": 200}},
                ["initial_population", "growth_rate", "clearance_rate", "niche_size"]),
        {"initial_population": 1000, "growth_rate": 0.8, "clearance_rate": 0.1, "niche_size": 1e9, "duration": 24, "output_points": 60},
        "biomni/tool/microbiology.py", "model_bacterial_growth_dynamics"),
    "simulate_generalized_lotka_volterra_dynamics": _tool(
        "Generalized Lotka-Volterra dynamics", "Integrate multi-species gLV dynamics from a growth-rate vector and interaction matrix.",
        _schema({"initial_abundances": _NUMBERS_SCHEMA, "growth_rates": _RATE_SCHEMA,
                 "interaction_matrix": {"type": "array", "minItems": 1, "maxItems": 50, "items": _RATE_SCHEMA},
                 "duration": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e6, "default": 50},
                 "output_points": {"type": "integer", "minimum": 2, "maximum": 2000, "default": 200}},
                ["initial_abundances", "growth_rates", "interaction_matrix"]),
        {"initial_abundances": [0.5, 0.3, 0.2], "growth_rates": [1.0, 0.8, 0.6],
         "interaction_matrix": [[0.0, -0.2, -0.1], [-0.1, 0.0, -0.3], [-0.2, -0.1, 0.0]], "duration": 30, "output_points": 60},
        "biomni/tool/microbiology.py", "simulate_generalized_lotka_volterra_dynamics"),
    "simulate_microbial_population_dynamics": _tool(
        "Gillespie population simulation", "Seeded stochastic birth-death simulation with logistic growth and per-species carrying capacities.",
        _schema({"initial_populations": {"type": "array", "items": {"type": "number"}, "minItems": 1, "maxItems": 10},
                 "growth_rates": _RATE_SCHEMA, "clearance_rates": _RATE_SCHEMA, "carrying_capacities": _RATE_SCHEMA,
                 "max_time": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e6, "default": 100},
                 "output_points": {"type": "integer", "minimum": 2, "maximum": 1000, "default": 100},
                 "simulations": {"type": "integer", "minimum": 1, "maximum": 200, "default": 20},
                 "seed": {"type": "integer", "minimum": 0, "maximum": 2147483647, "default": 0}},
                ["initial_populations", "growth_rates", "clearance_rates", "carrying_capacities"]),
        {"initial_populations": [50, 20], "growth_rates": [0.4, 0.3], "clearance_rates": [0.1, 0.2],
         "carrying_capacities": [500, 200], "max_time": 60, "simulations": 10, "seed": 7},
        "biomni/tool/microbiology.py", "simulate_microbial_population_dynamics"),
    "simulate_thyroid_hormone_pharmacokinetics": _tool(
        "Thyroid hormone PK simulation", "Integrate the five-species T4/TBG transport, binding, and deiodination compartment model.",
        _schema({"initial_conditions": _schema({name: {"type": "number", "minimum": 0} for name in _WC_SPECIES}, _WC_SPECIES),
                 "parameters": _schema({"blood_to_liver": {"type": "number", "minimum": 0}, "k_on_T4_TBG": {"type": "number", "minimum": 0},
                                        "k_off_T4_TBG": {"type": "number", "minimum": 0}, "T4_to_T3_liver": {"type": "number", "minimum": 0}},
                                       ["blood_to_liver", "k_on_T4_TBG", "k_off_T4_TBG", "T4_to_T3_liver"]),
                 "duration": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e6, "default": 240},
                 "output_points": {"type": "integer", "minimum": 2, "maximum": 2000, "default": 200}},
                ["initial_conditions", "parameters"]),
        {"initial_conditions": {"T4_blood_free": 1.0, "TBG_blood": 2.0, "T4_TBG_complex": 0.0, "T4_liver_free": 0.0, "T3_liver_free": 0.0},
         "parameters": {"blood_to_liver": 0.5, "k_on_T4_TBG": 1.2, "k_off_T4_TBG": 0.1, "T4_to_T3_liver": 0.05}, "duration": 120, "output_points": 60},
        "biomni/tool/physiology.py", "simulate_thyroid_hormone_pharmacokinetics"),
    "simulate_renin_angiotensin_system_dynamics": _tool(
        "Renin-angiotensin cascade simulation", "Integrate the six-species RAS ODE cascade with angiotensin-II feedback on renin release.",
        _schema({"initial_concentrations": _schema({name: {"type": "number", "minimum": 0} for name in _RAS_SPECIES}, _RAS_SPECIES),
                 "rate_constants": _schema({key: {"type": "number", "minimum": 0} for key in
                                            ["k_ren", "k_agt", "k_ace", "k_ace2", "k_at1r", "k_mas"]},
                                           ["k_ren", "k_agt", "k_ace", "k_ace2", "k_at1r", "k_mas"]),
                 "angiotensin_ii_feedback": {"type": "number", "minimum": 0, "default": 0.5},
                 "duration": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e6, "default": 48},
                 "output_points": {"type": "integer", "minimum": 2, "maximum": 2000, "default": 200}},
                ["initial_concentrations", "rate_constants"]),
        {"initial_concentrations": {"renin": 1.0, "angiotensinogen": 100.0, "angiotensin_I": 0.0, "angiotensin_II": 0.0,
                                    "ACE2_angiotensin_II": 0.0, "angiotensin_1_7": 0.0},
         "rate_constants": {"k_ren": 0.5, "k_agt": 0.5, "k_ace": 0.8, "k_ace2": 0.2, "k_at1r": 0.3, "k_mas": 0.2},
         "duration": 24, "output_points": 60},
        "biomni/tool/systems_biology.py", "simulate_renin_angiotensin_system_dynamics"),
    "model_protein_dimerization_network": _tool(
        "Dimerization equilibrium", "Find equilibrium monomer and dimer concentrations for a mass-action network with k_off fixed at 1.0.",
        _schema({"monomer_concentrations": {"type": "array", "minItems": 1, "maxItems": 50, "items": _schema(
                     {"name": {"type": "string", "minLength": 1, "maxLength": 100},
                      "concentration": {"type": "number", "minimum": 0, "maximum": 1e100}}, ["name", "concentration"])},
                 "network_topology": {"type": "array", "minItems": 1, "maxItems": 200,
                                      "items": {"type": "array", "minItems": 2, "maxItems": 2, "items": {"type": "string", "minLength": 1, "maxLength": 100}}},
                 "dimerization_affinities": {"type": "array", "minItems": 1, "maxItems": 200, "items": _schema(
                     {"dimer": {"type": "string", "minLength": 1, "maxLength": 100}, "k_on": {"type": "number", "minimum": 0, "maximum": 1e100}},
                     ["dimer", "k_on"])}},
                ["monomer_concentrations", "network_topology", "dimerization_affinities"]),
        {"monomer_concentrations": [{"name": "A", "concentration": 10.0}, {"name": "B", "concentration": 8.0}],
         "network_topology": [["A", "A"], ["A", "B"]],
         "dimerization_affinities": [{"dimer": "A-A", "k_on": 0.2}, {"dimer": "A-B", "k_on": 0.5}]},
        "biomni/tool/systems_biology.py", "model_protein_dimerization_network"),
    "simulate_protein_signaling_network": _tool(
        "Signaling network logic model", "Integrate a Hill-function activation/inhibition logic ODE network over declared proteins.",
        _schema({"network_structure": {"type": "array", "minItems": 1, "maxItems": 50, "items": _schema(
                     {"target": {"type": "string", "minLength": 1, "maxLength": 100},
                      "regulators": {"type": "array", "minItems": 1, "maxItems": 20, "items": _schema(
                          {"regulator": {"type": "string", "minLength": 1, "maxLength": 100},
                           "type": {"type": "integer", "enum": [1, -1]}}, ["regulator", "type"])}}, ["target", "regulators"])},
                 "species_params": {"type": "array", "minItems": 1, "maxItems": 50, "items": _schema(
                     {"protein": {"type": "string", "minLength": 1, "maxLength": 100}, "y0": {"type": "number", "minimum": 0},
                      "tau": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e6}, "ymax": {"type": "number", "minimum": 0}},
                     ["protein", "y0", "tau", "ymax"])},
                 "reaction_params": {"type": "array", "minItems": 1, "maxItems": 200, "items": _schema(
                     {"regulator": {"type": "string", "minLength": 1, "maxLength": 100}, "target": {"type": "string", "minLength": 1, "maxLength": 100},
                      "n": {"type": "number", "minimum": 0.1, "maximum": 10}, "ec50": {"type": "number", "exclusiveMinimum": 0},
                      "weight": {"type": "number", "minimum": 0}}, ["regulator", "target", "n", "ec50", "weight"])},
                 "duration": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e6, "default": 100},
                 "output_points": {"type": "integer", "minimum": 2, "maximum": 2000, "default": 200}},
                ["network_structure", "species_params", "reaction_params"]),
        {"network_structure": [{"target": "ERK", "regulators": [{"regulator": "RAS", "type": 1}]},
                               {"target": "RAS", "regulators": [{"regulator": "ERK", "type": -1}]}],
         "species_params": [{"protein": "RAS", "y0": 1.0, "tau": 5.0, "ymax": 1.0}, {"protein": "ERK", "y0": 0.0, "tau": 3.0, "ymax": 1.0}],
         "reaction_params": [{"regulator": "RAS", "target": "ERK", "n": 2.0, "ec50": 0.5, "weight": 1.0},
                              {"regulator": "ERK", "target": "RAS", "n": 2.0, "ec50": 0.6, "weight": 1.0}], "duration": 60, "output_points": 60},
        "biomni/tool/systems_biology.py", "simulate_protein_signaling_network"),
    "simulate_gene_circuit_with_growth_feedback": _tool(
        "Gene circuit with growth feedback", "Integrate Hill-regulated gene expression coupled to burden-limited cell-mass growth; dilution corrected.",
        _schema({"circuit_topology": {"type": "array", "minItems": 1, "maxItems": 20, "items": _RATE_SCHEMA},
                 "kinetic_params": _schema({"basal_rates": _RATE_SCHEMA, "degradation_rates": _RATE_SCHEMA,
                                            "hill_coefficients": _RATE_SCHEMA, "threshold_constants": _RATE_SCHEMA},
                                           ["basal_rates", "degradation_rates", "hill_coefficients", "threshold_constants"]),
                 "growth_params": _schema({"max_growth_rate": {"type": "number", "minimum": 0},
                                           "growth_inhibition": {"type": "number", "minimum": 0},
                                           "gene_growth_weights": _RATE_SCHEMA}, ["max_growth_rate", "growth_inhibition", "gene_growth_weights"]),
                 "duration": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e6, "default": 100},
                 "output_points": {"type": "integer", "minimum": 2, "maximum": 2000, "default": 200}},
                ["circuit_topology", "kinetic_params", "growth_params"]),
        {"circuit_topology": [[0.0, 2.0], [-1.5, 0.0]],
         "kinetic_params": {"basal_rates": [0.5, 0.3], "degradation_rates": [0.1, 0.1],
                            "hill_coefficients": [2.0, 2.0], "threshold_constants": [0.5, 0.5]},
         "growth_params": {"max_growth_rate": 0.6, "growth_inhibition": 0.2, "gene_growth_weights": [0.1, 0.1]},
         "duration": 60, "output_points": 60},
        "biomni/tool/synthetic_biology.py", "simulate_gene_circuit_with_growth_feedback"),
    "analyze_bifurcation_diagram": _tool(
        "Bifurcation regime classification", "Classify parameter-swept time series into stable, periodic, and chaotic regimes with transition points.",
        _schema({"parameter_values": {"type": "array", "items": {"type": "number"}, "minItems": 1, "maxItems": 200},
                 "time_series_data": {"type": "array", "minItems": 1, "maxItems": 200, "items": _NUMBERS_SCHEMA}},
                ["parameter_values", "time_series_data"]),
        {"parameter_values": [2.6, 2.9, 3.2, 3.5, 3.8],
         "time_series_data": [[0.5 + 0.4 * (1 if i % 4 == 0 else 0) for i in range(40)],
                              [0.5 + 0.4 * (1 if i % 4 == 0 else 0) for i in range(40)],
                              [0.5 + 0.4 * (1 if i % 8 < 4 else 0) for i in range(40)],
                              [0.5 + 0.4 * (1 if i % 8 < 4 else 0) for i in range(40)],
                              [0.3 + 0.1 * i % 5 for i in range(40)]]},
        "biomni/tool/synthetic_biology.py", "analyze_bifurcation_diagram"),
    "perform_flux_balance_analysis": _tool(
        "Flux balance analysis", "Maximize an objective flux subject to steady-state mass balance over a JSON reaction network (scipy HiGHS LP).",
        _schema({"reactions": {"type": "array", "minItems": 1, "maxItems": 200, "items": _schema(
                     {"id": {"type": "string", "minLength": 1, "maxLength": 100},
                      "stoichiometry": {"type": "array", "minItems": 1, "maxItems": 100, "items": _schema(
                          {"metabolite": {"type": "string", "minLength": 1, "maxLength": 100},
                           "coefficient": {"type": "number", "minimum": -1e6, "maximum": 1e6}}, ["metabolite", "coefficient"])},
                      "lower_bound": {"type": "number", "minimum": -1e6, "maximum": 1e6},
                      "upper_bound": {"type": "number", "minimum": -1e6, "maximum": 1e6}}, ["id", "stoichiometry"])},
                 "objective_reaction": {"type": "string", "minLength": 1, "maxLength": 100}}, ["reactions", "objective_reaction"]),
        {"reactions": [{"id": "uptake", "stoichiometry": [{"metabolite": "A", "coefficient": 1}], "upper_bound": 10},
                       {"id": "conv", "stoichiometry": [{"metabolite": "A", "coefficient": -1}, {"metabolite": "B", "coefficient": 1}]},
                       {"id": "growth", "stoichiometry": [{"metabolite": "B", "coefficient": -1}], "lower_bound": 0}],
         "objective_reaction": "growth"},
        "biomni/tool/systems_biology.py", "perform_flux_balance_analysis"),
    "optimize_anaerobic_digestion_process": _tool(
        "Anaerobic digestion surrogate optimization", "Optimize upstream's toy quadratic surrogate for VFA or methane over HRT/OLR/I-F/temperature/pH ranges.",
        _schema({"waste_characteristics": _schema({"volatile_solids": {"type": "number", "minimum": 0, "maximum": 100},
                                                  "cod": {"type": "number", "minimum": 0, "maximum": 1e6}}, ["volatile_solids", "cod"]),
                 "operational_parameters": _schema({key: {"type": "array", "minItems": 2, "maxItems": 2,
                                                          "items": {"type": "number", "minimum": -1e6, "maximum": 1e6}} for key in
                                                   ["hrt", "olr", "if_ratio", "temperature", "ph"]},
                                                  ["hrt", "olr", "if_ratio", "temperature", "ph"]),
                 "target_output": {"type": "string", "enum": ["vfa_production", "methane_yield"], "default": "methane_yield"},
                 "optimization_method": {"type": "string", "enum": ["l_bfgs_b", "differential_evolution"], "default": "l_bfgs_b"}},
                ["waste_characteristics", "operational_parameters"]),
        {"waste_characteristics": {"volatile_solids": 70, "cod": 30000},
         "operational_parameters": {"hrt": [5, 25], "olr": [0.5, 6], "if_ratio": [0.1, 1.0], "temperature": [25, 45], "ph": [5, 8.5]}},
        "biomni/tool/microbiology.py", "optimize_anaerobic_digestion_process"),
}
HANDLERS = {name: globals()[name] for name in TOOLS}
