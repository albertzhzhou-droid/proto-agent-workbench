"""Bounded, offline assay- and instrument-data analyses adapted from Biomni.

Portions adapted from Biomni (Stanford SNAP), Apache License 2.0, commit
400c1f366b96a35ca253e13c9b06c5076af41d65. See
apps/proto-workbench/THIRD_PARTY_NOTICES.md and the packaged Apache license.
Modifications: JSON-array inputs replace CSV/FASTQ/pandas file loading, NumPy /
SciPy reimplementations without matplotlib artifacts, structured results,
strict validation, no files/network/execution, and corrected upstream defects
(dimensionally inconsistent ITC binding model, Gompertz doubling-time units,
barcode lineage clustering fed by pdist-of-distance-matrix, degenerate
single-value t-tests in the biofilm assay). Outputs are analyses of supplied
measurements; no observations are fabricated.
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


def _numbers(value, name, *, minimum=3, maximum=5000, nonnegative=False):
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        raise ValueError(f"{name} must contain {minimum} to {maximum} numbers.")
    result = [_number(item, f"{name}[{index}]", minimum=0 if nonnegative else None) for index, item in enumerate(value)]
    if nonnegative and any(item < 0 for item in result):
        raise ValueError(f"{name} entries must be nonnegative.")
    return result


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


def analyze_circular_dichroism_spectra(arguments):
    wavelengths = _numbers(arguments.get("wavelengths_nm"), "wavelengths_nm", minimum=3)
    signals = _numbers(arguments.get("cd_signals_mdeg"), "cd_signals_mdeg", minimum=3)
    if len(wavelengths) != len(signals):
        raise ValueError("wavelengths_nm and cd_signals_mdeg must have equal lengths.")
    sample_type = arguments.get("sample_type", "protein")
    if sample_type not in ("protein", "nucleic_acid"):
        raise ValueError("sample_type must be protein or nucleic_acid.")
    import numpy as np

    wavelength_array = np.asarray(wavelengths)
    signal_array = np.asarray(signals)

    def band(low, high, polarity):
        mask = (wavelength_array >= low) & (wavelength_array <= high) & ((signal_array > 0) if polarity > 0 else (signal_array < 0))
        return int(mask.sum())

    if sample_type == "protein":
        scores = {"alpha_helix_190_195": band(190, 195, 1), "beta_sheet_215_220": band(215, 220, -1), "random_coil_195_200": band(195, 200, -1)}
        if scores["alpha_helix_190_195"] > max(scores["beta_sheet_215_220"], scores["random_coil_195_200"]):
            classification = "predominantly alpha-helical"
        elif scores["beta_sheet_215_220"] > max(scores["alpha_helix_190_195"], scores["random_coil_195_200"]):
            classification = "predominantly beta-sheet"
        else:
            classification = "mixed or predominantly random coil"
    else:
        scores = {"g_quadruplex_290_300": band(290, 300, 1), "b_form_270_280": band(270, 280, 1)}
        classification = ("G-quadruplex characteristics" if scores["g_quadruplex_290_300"] > 0
                          else "B-form characteristics" if scores["b_form_270_280"] > 0 else "non-standard structure")
    result = {
        "sample_type": sample_type, "points": len(signals),
        "wavelength_range_nm": [min(wavelengths), max(wavelengths)],
        "spectral_band_counts": scores, "classification": classification,
        "method": "Wavelength-band sign counting exactly as upstream; no deconvolution or secondary-structure fitting",
        "limitations": ["Band counting is a coarse qualitative classifier, not secondary-structure quantitation.",
                        "Classification depends on the supplied wavelength coverage; missing bands count as zero."],
    }
    temperatures = arguments.get("temperatures_c")
    thermal_signals = arguments.get("thermal_cd_signals")
    if temperatures is not None or thermal_signals is not None:
        temperatures = _numbers(temperatures, "temperatures_c", minimum=3)
        thermal_signals = _numbers(thermal_signals, "thermal_cd_signals", minimum=3)
        if len(temperatures) != len(thermal_signals):
            raise ValueError("temperatures_c and thermal_cd_signals must have equal lengths.")
        temperature_array = np.asarray(thermal_signals, dtype=float)
        low, high = float(temperature_array.min()), float(temperature_array.max())
        if high <= low:
            raise ValueError("thermal_cd_signals must vary for melt analysis.")
        unfolded = (temperature_array - low) / (high - low)
        midpoint_index = int(np.argmin(np.abs(unfolded - 0.5)))
        span = temperatures[-1] - temperatures[0]
        transition_width = span / len(temperatures) * float(((unfolded > 0.2) & (unfolded < 0.8)).sum())
        cooperativity = ("highly cooperative (sharp transition)" if transition_width < 0.2 * span
                         else "moderately cooperative" if transition_width < 0.4 * span else "non-cooperative (broad transition)")
        result["thermal_stability"] = {
            "melting_temperature_c": round(temperatures[midpoint_index], 4),
            "cooperativity": cooperativity,
            "unfolded_fraction_at_tm": round(float(unfolded[midpoint_index]), 6),
            "method": "Tm at the fraction-unfolded midpoint after min-max normalization (assumes linear endpoints)",
            "limitations": ["Min-max normalization presumes the first and last points are fully folded and unfolded.",
                            "No van't Hoff enthalpy or two-state fitting; the midpoint is interpolated to the nearest sampled temperature."],
        }
    return result


def analyze_itc_binding_thermodynamics(arguments):
    """Corrected one-site isotherm; upstream mixed units in its binding polynomial."""
    molar_ratios = _numbers(arguments.get("molar_ratios"), "molar_ratios", minimum=4)
    heats = _numbers(arguments.get("heats_ucal"), "heats_ucal", minimum=4)
    if len(molar_ratios) != len(heats):
        raise ValueError("molar_ratios and heats_ucal must have equal lengths.")
    protein_concentration = _number(arguments.get("protein_concentration_uM"), "protein_concentration_uM", positive=True)
    temperature = _number(arguments.get("temperature_k"), "temperature_k", minimum=1, maximum=1000)
    import numpy as np
    from scipy.optimize import curve_fit

    x = np.asarray(molar_ratios, dtype=float)
    y = np.asarray(heats, dtype=float)
    pt = protein_concentration * 1e-6

    def heats_model(ratios, kd_um, delta_h, stoichiometry):
        kd = kd_um * 1e-6
        ligand = ratios * pt
        total = stoichiometry * pt + ligand + kd
        bound = ((total) - np.sqrt(np.maximum(total ** 2 - 4 * stoichiometry * pt * ligand, 0.0))) / 2
        cumulative = bound * delta_h
        return np.diff(np.concatenate(([0.0], cumulative)))

    try:
        parameters, covariance = curve_fit(heats_model, x, y, p0=[1.0, -2000.0, 1.0],
                                           bounds=([1e-6, -1e9, 0.05], [1e6, 1e9, 10.0]), maxfev=50_000)
    except (RuntimeError, ValueError) as error:
        raise ValueError("One-site ITC fitting did not converge; check that the thermogram shows a saturating transition.") from error
    kd_um, delta_h, stoichiometry = map(float, parameters)
    predicted = heats_model(x, *parameters)
    residuals = y - predicted
    ss_total = float(np.sum((y - y.mean()) ** 2))
    if ss_total <= 0:
        raise ValueError("heats_ucal must vary for fitting.")
    errors = np.sqrt(np.maximum(np.diag(covariance), 0.0))
    gas_constant = 1.9872e-3  # kcal/(mol*K)
    delta_g_ucal = gas_constant * temperature * math.log(kd_um * 1e-6) * 1e6
    delta_s = (delta_h - delta_g_ucal) / temperature
    return {
        "n": len(x), "stoichiometry": stoichiometry, "kd_um": kd_um,
        "kd_standard_error_um": float(errors[0]) if math.isfinite(errors[0]) else None,
        "delta_h_ucal_per_mol": delta_h, "delta_h_standard_error": float(errors[1]) if math.isfinite(errors[1]) else None,
        "delta_g_ucal_per_mol": delta_g_ucal, "delta_s_ucal_per_mol_k": delta_s,
        "r_squared": 1.0 - float(residuals @ residuals) / ss_total,
        "fitted_heats": [round(float(value), 6) for value in predicted],
        "residuals": [round(float(value), 6) for value in residuals],
        "method": "One-site binding isotherm: exact quadratic bound concentration, differential heats, unweighted nonlinear least squares",
        "limitations": ["Upstream's model treated molar ratios as free ligand concentrations with mixed units; this port fits the standard one-site quadratic instead and is not comparable number-for-number.",
                        "Single-site stoichiometry only; no competitive, cooperative, or displacement models. Heats are uncorrected for dilution and injection-volume effects.",
                        "Errors assume independent homoscedastic residuals and can be unreliable for poorly sampled transitions."],
    }


def analyze_bacterial_growth_curve(arguments):
    times = _numbers(arguments.get("time_hours"), "time_hours", minimum=4)
    ods = _numbers(arguments.get("od_values"), "od_values", minimum=4)
    if len(times) != len(ods):
        raise ValueError("time_hours and od_values must have equal lengths.")
    if min(ods) <= 0 or len(set(ods)) < 3:
        raise ValueError("od_values must contain positive, varying measurements.")
    import numpy as np
    from scipy.optimize import curve_fit

    t = np.asarray(times, dtype=float)
    y = np.asarray(ods, dtype=float)

    def logistic(time, capacity, initial, rate):
        return capacity / (1 + ((capacity - initial) / initial) * np.exp(-rate * time))

    try:
        parameters, _ = curve_fit(logistic, t, y, p0=[max(ods), ods[0], 0.5], bounds=([1e-12, 1e-12, 1e-9], [np.inf, np.inf, np.inf]), maxfev=20_000)
    except (RuntimeError, ValueError) as error:
        raise ValueError("Logistic growth fitting did not converge; ensure the curve rises toward a plateau.") from error
    capacity, initial, rate = map(float, parameters)
    predicted = logistic(t, *parameters)
    residuals = y - predicted
    ss_total = float(np.sum((y - y.mean()) ** 2))
    lag = max(0.0, (math.log((capacity / initial) - 1) - math.log((capacity / (0.05 * capacity)) - 1)) / rate)
    return {
        "n": len(times), "carrying_capacity_od": capacity, "initial_od": initial,
        "logistic_rate_per_hour": rate, "doubling_time_hours": math.log(2) / rate,
        "lag_phase_hours": lag, "r_squared": 1.0 - float(residuals @ residuals) / ss_total if ss_total > 0 else None,
        "fitted_od": [round(float(value), 8) for value in predicted],
        "residuals": [round(float(value), 8) for value in residuals],
        "method": "Three-parameter logistic fit N(t) = K / (1 + ((K-N0)/N0) exp(-r t)) via nonlinear least squares",
        "limitations": ["The logistic model has no explicit lag phase; the lag estimate is upstream's algebraic approximation referenced to 5% of capacity.",
                        "OD is an optical proxy; carrying capacity and rate are instrument- and path-length-dependent."],
    }


def analyze_bacterial_growth_rate(arguments):
    times = _numbers(arguments.get("time_hours"), "time_hours", minimum=4)
    ods = _numbers(arguments.get("od_values"), "od_values", minimum=4)
    if len(times) != len(ods):
        raise ValueError("time_hours and od_values must have equal lengths.")
    if min(ods) <= 0 or len(set(ods)) < 3:
        raise ValueError("od_values must contain positive, varying measurements.")
    import numpy as np
    from scipy.optimize import curve_fit

    t = np.asarray(times, dtype=float)
    y = np.asarray(ods, dtype=float)

    def gompertz(time, lag, mu_max, capacity):
        return capacity * np.exp(-np.exp(mu_max * math.e * (lag - time) / capacity + 1))

    try:
        parameters, covariance = curve_fit(gompertz, t, y, p0=[float(np.mean(t)) / 3, 0.5, float(y.max()) * 1.1],
                                           bounds=([0.0, 1e-9, 1e-12], [np.inf, np.inf, np.inf]), maxfev=50_000)
    except (RuntimeError, ValueError) as error:
        raise ValueError("Gompertz fitting did not converge; ensure the data shows lag, exponential, and stationary phases.") from error
    lag, mu_max, capacity = map(float, parameters)
    predicted = gompertz(t, *parameters)
    residuals = y - predicted
    ss_total = float(np.sum((y - y.mean()) ** 2))
    # In the Zwietering parameterization mu_max is the maximum tangent slope in
    # OD/h, not the specific growth rate; upstream divided ln(2) by it directly.
    specific_rate = mu_max * math.e / capacity
    return {
        "n": len(times), "lag_hours": lag, "max_slope_od_per_hour": mu_max,
        "specific_growth_rate_per_hour": specific_rate,
        "doubling_time_hours": math.log(2) / specific_rate if specific_rate > 0 else None,
        "carrying_capacity_od": capacity, "r_squared": 1.0 - float(residuals @ residuals) / ss_total if ss_total > 0 else None,
        "fitted_od": [round(float(value), 8) for value in predicted],
        "method": "Zwietering-reparameterized Gompertz via nonlinear least squares",
        "limitations": ["Upstream reported ln(2)/mu as the doubling time, conflating the maximum tangent slope (OD/h) with the specific rate (per hour); this port converts via mu*e/A first.",
                        "OD-derived rates are proxies; growth-phase coverage strongly conditions the fit."],
    }


def estimate_cell_cycle_phase_durations(arguments):
    times = _numbers(arguments.get("time_hours"), "time_hours", minimum=3, maximum=200)
    edu = _numbers(arguments.get("edu_positive_percent"), "edu_positive_percent", minimum=3, maximum=200)
    brdu = _numbers(arguments.get("brdu_positive_percent"), "brdu_positive_percent", minimum=3, maximum=200)
    double = _numbers(arguments.get("double_positive_percent"), "double_positive_percent", minimum=3, maximum=200)
    if len({len(times), len(edu), len(brdu), len(double)}) != 1:
        raise ValueError("time_hours and the percentage arrays must have equal lengths.")
    for name, values in (("edu_positive_percent", edu), ("brdu_positive_percent", brdu), ("double_positive_percent", double)):
        if min(values) < 0 or max(values) > 100:
            raise ValueError(f"{name} must be percentages between 0 and 100.")
    initial = arguments.get("initial_estimates")
    if not isinstance(initial, dict) or set(initial) != {"g1_duration", "s_duration", "g2m_duration", "death_rate"}:
        raise ValueError("initial_estimates must contain g1_duration, s_duration, g2m_duration, and death_rate.")
    import numpy as np
    from scipy import optimize

    t = np.asarray(times, dtype=float)
    observed = np.asarray([edu, brdu, double], dtype=float)

    def simulate(params):
        g1, s_phase, _g2m, death = params
        cycle = g1 + s_phase + _g2m
        if cycle <= 0:
            return None
        s_fraction = s_phase / cycle
        edu_curve = np.minimum(s_fraction * np.exp(-death * t), 1.0) * 100
        brdu_curve = np.minimum(s_fraction * (1 - np.exp(-t / s_phase)), 1.0) * 100
        double_curve = np.minimum(s_fraction * np.exp(-death * t) * (1 - np.exp(-t / s_phase)), 1.0) * 100
        return np.vstack([edu_curve, brdu_curve, double_curve])

    def objective(params):
        simulated = simulate(params)
        if simulated is None:
            return 1e12
        return float(np.sum((simulated - observed) ** 2))

    start = [max(initial["g1_duration"], 0.1), max(initial["s_duration"], 0.1), max(initial["g2m_duration"], 0.1), min(max(initial["death_rate"], 0.0), 1.0)]
    result = optimize.minimize(objective, start, method="L-BFGS-B", bounds=[(0.1, 50.0), (0.1, 30.0), (0.1, 20.0), (0.0, 1.0)])
    g1, s_phase, g2m, death = map(float, result.x)
    return {
        "n": len(times),
        "g1_hours": g1, "s_hours": s_phase, "g2m_hours": g2m,
        "total_cycle_hours": g1 + s_phase + g2m, "death_rate_per_hour": death,
        "sum_of_squares": float(result.fun), "optimizer_converged": bool(result.success),
        "initial_estimates": {key: initial[key] for key in ("g1_duration", "s_duration", "g2m_duration", "death_rate")},
        "method": "Upstream's simplified demonstration model (phase fractions times exponential incorporation) fitted by L-BFGS-B",
        "limitations": ["The upstream simulation is an explicitly simplified demonstration model, not a validated dual-pulse cell-cycle model; durations are indicative only.",
                        "G2/M duration enters only through the cycle total; the objective can trade phases off against each other.",
                        "Percent inputs must come from a consistent gating strategy; no measurement error is modeled."],
    }


def analyze_ebv_antibody_titers(arguments):
    supplied_curves = arguments.get("standard_curves")
    if not isinstance(supplied_curves, list) or not 1 <= len(supplied_curves) <= 10:
        raise ValueError("standard_curves must contain 1 to 10 entries.")
    curves = {}
    for index, curve in enumerate(supplied_curves):
        if not isinstance(curve, dict) or set(curve) != {"antibody", "calibrators"} or not isinstance(curve["calibrators"], list):
            raise ValueError(f"standard_curves[{index}] must contain antibody and calibrators.")
        antibody = _string(curve["antibody"], f"standard_curves[{index}].antibody")
        if antibody in curves:
            raise ValueError(f"Duplicate standard curve for {antibody}.")
        calibrators = curve["calibrators"]
        if not isinstance(calibrators, list) or not 3 <= len(calibrators) <= 50:
            raise ValueError(f"standard_curves[{index}].calibrators must contain 3 to 50 {{concentration, od}} points.")
        pairs = []
        for pair_index, pair in enumerate(calibrators):
            if not isinstance(pair, dict) or set(pair) != {"concentration", "od"}:
                raise ValueError(f"standard_curves[{index}].calibrators[{pair_index}] must contain concentration and od.")
            pairs.append((_number(pair["concentration"], "concentration"), _number(pair["od"], "od")))
        curves[antibody] = pairs
    samples = arguments.get("samples")
    if not isinstance(samples, list) or not 1 <= len(samples) <= 500:
        raise ValueError("samples must contain 1 to 500 entries.")
    import numpy as np

    fitted = {}
    for antibody, pairs in curves.items():
        concentrations = np.asarray([pair[0] for pair in pairs])
        ods = np.asarray([pair[1] for pair in pairs])
        if len(set(ods.tolist())) < 2:
            raise ValueError(f"Standard curve for {antibody} needs varying ODs.")
        slope, intercept = np.polyfit(ods, concentrations, 1)
        fitted[antibody] = (float(slope), float(intercept))
    results = []
    for index, sample in enumerate(samples):
        if not isinstance(sample, dict) or not {"sample_id", "readings"} <= set(sample) <= {"sample_id", "readings", "group"}:
            raise ValueError(f"samples[{index}] must contain sample_id and readings (optional group).")
        entry = {"sample_id": _string(sample["sample_id"], f"samples[{index}].sample_id"),
                 "group": sample.get("group", "Unknown")}
        if not isinstance(sample["readings"], list) or not 1 <= len(sample["readings"]) <= 20:
            raise ValueError(f"samples[{index}].readings must contain 1 to 20 {{antibody, od}} entries.")
        readings = {}
        for reading_index, reading in enumerate(sample["readings"]):
            if not isinstance(reading, dict) or set(reading) != {"antibody", "od"}:
                raise ValueError(f"samples[{index}].readings[{reading_index}] must contain antibody and od.")
            antibody = _string(reading["antibody"], "antibody")
            if antibody not in fitted:
                raise ValueError(f"Unknown antibody {antibody}; supply a standard curve for it.")
            if antibody in readings:
                raise ValueError(f"Duplicate reading for {antibody} in sample {entry['sample_id']}.")
            readings[antibody] = round(fitted[antibody][0] * _number(reading["od"], "od") + fitted[antibody][1], 6)
        entry["titers"] = readings
        results.append(entry)
    groups = {}
    for entry in results:
        for antibody, titer in entry["titers"].items():
            groups.setdefault(entry["group"], {}).setdefault(antibody, []).append(titer)
    summary = {group: {antibody: {"mean": round(float(np.mean(values)), 6),
                                  "std": round(float(np.std(values, ddof=1)) if len(values) > 1 else 0.0, 6),
                                  "n": len(values)}
                        for antibody, values in antibodies.items()} for group, antibodies in groups.items()}
    return {
        "samples": results, "group_summary": summary,
        "standard_curves": {antibody: {"slope": round(slope, 8), "intercept": round(intercept, 8)} for antibody, (slope, intercept) in fitted.items()},
        "method": "Per-antibody linear calibration concentration = slope*OD + intercept (least squares on supplied calibrators)",
        "limitations": ["Linear calibration over the supplied calibrator range only; extrapolation beyond it is unreliable.",
                        "Group summaries are unweighted descriptive statistics; no assay validation, cutoffs, or clinical interpretation."],
    }


def analyze_arsenic_speciation_hplc_icpms(arguments):
    supplied = arguments.get("samples")
    if not isinstance(supplied, list) or not 1 <= len(supplied) <= 100:
        raise ValueError("samples must contain 1 to 100 entries.")
    default_calibration = {"As(III)": (0.85, 0.1), "As(V)": (0.92, 0.1), "MMAs(III)": (0.78, 0.2),
                           "MMAs(V)": (0.88, 0.15), "DMAs(III)": (0.81, 0.2), "DMAs(V)": (0.90, 0.15)}
    calibration = default_calibration
    override = arguments.get("calibration_factors")
    if override is not None:
        if not isinstance(override, list) or not 1 <= len(override) <= 20:
            raise ValueError("calibration_factors must contain 1 to 20 entries.")
        calibration = {}
        for index, entry in enumerate(override):
            if not isinstance(entry, dict) or set(entry) != {"species", "factor", "detection_limit"}:
                raise ValueError(f"calibration_factors[{index}] must contain species, factor, and detection_limit.")
            calibration[_string(entry["species"], "species")] = (_number(entry["factor"], "factor", positive=True),
                                                                 _number(entry["detection_limit"], "detection_limit", positive=True))
    retention_times = {"As(III)": 2.8, "As(V)": 7.5, "MMAs(III)": 3.9, "MMAs(V)": 6.2, "DMAs(III)": 4.7, "DMAs(V)": 5.3}
    tolerance = _number(arguments.get("retention_tolerance_min", 0.3), "retention_tolerance_min", positive=True, maximum=2)
    results = {}
    for index, sample in enumerate(supplied):
        if not isinstance(sample, dict) or set(sample) != {"sample_id", "chromatogram"} or not isinstance(sample["chromatogram"], list):
            raise ValueError(f"samples[{index}] must contain sample_id and chromatogram.")
        sample_id = _string(sample["sample_id"], f"samples[{index}].sample_id")
        if not 3 <= len(sample["chromatogram"]) <= 2000:
            raise ValueError(f"samples[{index}].chromatogram must contain 3 to 2000 {{retention_time, intensity}} points.")
        chromatogram = {}
        for point_index, point in enumerate(sample["chromatogram"]):
            if not isinstance(point, dict) or set(point) != {"retention_time", "intensity"}:
                raise ValueError(f"samples[{index}].chromatogram[{point_index}] must contain retention_time and intensity.")
            retention = _number(point["retention_time"], "retention_time", minimum=0)
            if retention in chromatogram:
                raise ValueError(f"samples[{index}].chromatogram has a duplicate retention time {retention}.")
            chromatogram[retention] = _number(point["intensity"], "intensity", minimum=0)
        species_result = {}
        for species, expected in retention_times.items():
            if species not in calibration:
                continue
            closest = min(chromatogram, key=lambda rt: abs(rt - expected))
            factor, limit = calibration[species]
            if abs(closest - expected) <= tolerance:
                concentration = chromatogram[closest] * factor
                species_result[species] = (round(concentration, 6) if concentration >= limit
                                           else {"below_detection_limit": True, "detection_limit": limit})
            else:
                species_result[species] = "not_detected"
        detected = {species: value for species, value in species_result.items() if isinstance(value, float)}
        results[sample_id] = {"species": species_result,
                              "predominant_species": max(detected, key=detected.get) if detected else None}
    return {
        "samples": results,
        "retention_reference_minutes": retention_times,
        "calibration_used": {species: {"factor": factor, "detection_limit": limit} for species, (factor, limit) in calibration.items()},
        "method": "Nearest-retention-time matching within a tolerance, quantified by per-species linear calibration factors",
        "limitations": ["Upstream's default calibration factors and detection limits are illustrative; supply measured calibrations for quantitative work.",
                        "Peak assignment uses the single nearest retention time; co-eluting species are not resolved."],
    }


def enumerate_bacterial_cfu_by_serial_dilution(arguments):
    """Planning simulation: seeded Poisson counts, exactly upstream's teaching intent."""
    estimated = _number(arguments.get("estimated_concentration_cfu_per_ml"), "estimated_concentration_cfu_per_ml", positive=True, maximum=1e12)
    dilution_factor = _integer(arguments.get("dilution_factor", 10), "dilution_factor", 2, 1000)
    num_dilutions = _integer(arguments.get("num_dilutions", 7), "num_dilutions", 1, 12)
    spots = _integer(arguments.get("spots_per_dilution", 3), "spots_per_dilution", 1, 10)
    seed = _integer(arguments.get("seed", 0), "seed", 0, 2**31 - 1)
    import numpy as np

    rng = np.random.default_rng(seed)
    rows = []
    for dilution in range(num_dilutions + 1):
        concentration = estimated / dilution_factor ** dilution
        expected_per_spot = concentration * 0.01  # 10 uL spot
        for spot in range(spots):
            count = "TMTC" if expected_per_spot > 300 else int(rng.poisson(expected_per_spot))
            rows.append({"dilution": "undiluted" if dilution == 0 else f"10^{-dilution}",
                         "dilution_factor": dilution_factor ** dilution, "spot": spot + 1,
                         "expected_cfu_per_spot": round(expected_per_spot, 4), "simulated_count": count})
    countable = []
    for dilution in range(num_dilutions + 1):
        counts = [row["simulated_count"] for row in rows
                  if row["dilution_factor"] == dilution_factor ** dilution and isinstance(row["simulated_count"], int)]
        if counts:
            average = sum(counts) / len(counts)
            if 3 <= average <= 300:
                countable.append({"dilution": "undiluted" if dilution == 0 else f"10^{-dilution}",
                                  "average_cfu_per_spot": round(average, 4),
                                  "cfu_per_ml": round(average * 100 * dilution_factor ** dilution, 4)})
    final = round(sum(row["cfu_per_ml"] for row in countable) / len(countable), 4) if countable else None
    return {
        "planned_concentration_cfu_per_ml": estimated, "dilution_factor": dilution_factor,
        "simulated_rows": rows, "countable_dilutions": countable,
        "mean_estimate_cfu_per_ml": final, "seed": seed,
        "method": "Deterministic-seed Poisson spot-count planning simulation (10 uL spots, countable window 3-300 colonies)",
        "limitations": ["This simulates expected colony counts for planning; it is not a measurement of any actual plate.",
                        f"Poisson counts are drawn from seed {seed}; replicate runs with the same seed are identical.",
                        "The final estimate averages countable dilutions exactly as upstream; TMTC spots are excluded."],
    }


def quantify_biofilm_biomass_crystal_violet(arguments):
    """Replicate-aware t-test; upstream tested single values (degenerate p=nan)."""
    supplied = arguments.get("samples")
    if not isinstance(supplied, list) or not 2 <= len(supplied) <= 200:
        raise ValueError("samples must contain 2 to 200 entries.")
    samples = []
    for index, sample in enumerate(supplied):
        if not isinstance(sample, dict) or set(sample) != {"name", "replicate_ods"} or not isinstance(sample["replicate_ods"], list):
            raise ValueError(f"samples[{index}] must contain name and replicate_ods.")
        replicates = _numbers(sample["replicate_ods"], f"samples[{index}].replicate_ods", minimum=2, maximum=50, nonnegative=True)
        samples.append({"name": _string(sample["name"], f"samples[{index}].name"), "replicates": replicates})
    control = arguments.get("control_sample")
    if control is None:
        control = samples[0]["name"]
    control = _string(control, "control_sample")
    names = [sample["name"] for sample in samples]
    if control not in names:
        raise ValueError(f"control_sample {control!r} is not among the samples.")
    if len(set(names)) != len(names):
        raise ValueError("Sample names must be unique.")
    import numpy as np
    from scipy import stats

    control_replicates = np.asarray(samples[names.index(control)]["replicates"])
    rows = []
    for sample in samples:
        replicates = np.asarray(sample["replicates"])
        normalized = replicates - control_replicates.mean()
        if sample["name"] == control:
            statistic = p_value = None
        else:
            # One-sample t-test of the sample's normalized replicates against zero.
            if len(replicates) < 2 or np.allclose(normalized, normalized[0]):
                statistic = p_value = None
            else:
                statistic, p_value = map(float, stats.ttest_1samp(normalized, 0.0))
        rows.append({"name": sample["name"], "n": len(replicates),
                     "mean_od": round(float(replicates.mean()), 6),
                     "normalized_mean_od": round(float(normalized.mean()), 6),
                     "normalized_std_od": round(float(normalized.std(ddof=1)) if len(replicates) > 1 else 0.0, 6),
                     "t_statistic": statistic, "p_value": p_value,
                     "significant_at_0_05": bool(p_value is not None and p_value < 0.05)})
    positive = [row["normalized_mean_od"] for row in rows if row["normalized_mean_od"] > 0 and row["name"] != control]
    return {
        "control_sample": control, "samples": rows,
        "mean_normalized_biomass": round(float(np.mean(positive)), 6) if positive else 0.0,
        "std_normalized_biomass": round(float(np.std(positive, ddof=1)) if len(positive) > 1 else 0.0, 6),
        "method": "Control-subtracted OD with one-sample t-tests per sample (Welch-free, equal to upstream's intent but replicate-aware)",
        "limitations": ["Upstream ran ttest_1samp on a single value per sample, which yields undefined p-values; this port requires replicates.",
                        "No multiple-comparison correction; uncorrected p-values are reported as-is.",
                        "Crystal violet stains biomass including dead cells and matrix; normalization by cell count is not performed."],
    }


def analyze_atp_luminescence_assay(arguments):
    standards = arguments.get("standard_curve")
    if not isinstance(standards, list) or not 3 <= len(standards) <= 50:
        raise ValueError("standard_curve must contain 3 to 50 {luminescence, concentration} points.")
    pairs = []
    for index, point in enumerate(standards):
        if not isinstance(point, dict) or set(point) != {"luminescence", "concentration"}:
            raise ValueError(f"standard_curve[{index}] must contain luminescence and concentration.")
        pairs.append((_number(point["luminescence"], "luminescence"), _number(point["concentration"], "concentration", minimum=0)))
    import numpy as np

    luminescence = np.asarray([pair[0] for pair in pairs])
    concentration = np.asarray([pair[1] for pair in pairs])
    if len(set(luminescence.tolist())) < 2:
        raise ValueError("standard_curve luminescence values must vary.")
    slope, intercept = np.polyfit(luminescence, concentration, 1)
    samples = arguments.get("samples")
    if not isinstance(samples, list) or not 1 <= len(samples) <= 500:
        raise ValueError("samples must contain 1 to 500 entries.")
    normalization = arguments.get("normalization")  # {"sample_id": cell count or protein amount}
    if normalization is not None and (not isinstance(normalization, list) or not 1 <= len(normalization) <= 500):
        raise ValueError("normalization must contain 1 to 500 {sample_id, value} entries.")
    normalization_map = {}
    method = arguments.get("normalization_method", "none")
    if method not in ("none", "cell_count", "protein_content"):
        raise ValueError("normalization_method must be none, cell_count, or protein_content.")
    if normalization:
        for index, entry in enumerate(normalization):
            if not isinstance(entry, dict) or set(entry) != {"sample_id", "value"}:
                raise ValueError(f"normalization[{index}] must contain sample_id and value.")
            normalization_map[_string(entry["sample_id"], "sample_id")] = _number(entry["value"], "value", positive=True)
    results = []
    for index, sample in enumerate(samples):
        if not isinstance(sample, dict) or set(sample) != {"sample_id", "luminescence"}:
            raise ValueError(f"samples[{index}] must contain sample_id and luminescence.")
        sample_id = _string(sample["sample_id"], f"samples[{index}].sample_id")
        atp = slope * _number(sample["luminescence"], "luminescence") + intercept
        entry = {"sample_id": sample_id, "atp_concentration_nm": round(float(atp), 6)}
        if method == "cell_count" and sample_id in normalization_map:
            entry["atp_pmol_per_million_cells"] = round(float(atp) / normalization_map[sample_id] * 1000, 6)
        elif method == "protein_content" and sample_id in normalization_map:
            entry["atp_nmol_per_mg_protein"] = round(float(atp) / normalization_map[sample_id], 6)
        results.append(entry)
    concentrations = [entry["atp_concentration_nm"] for entry in results]
    return {
        "samples": results,
        "summary_nm": {"mean": round(float(np.mean(concentrations)), 6), "median": round(float(np.median(concentrations)), 6),
                       "min": round(float(np.min(concentrations)), 6), "max": round(float(np.max(concentrations)), 6)},
        "standard_curve": {"slope": round(float(slope), 10), "intercept": round(float(intercept), 10)},
        "normalization_method": method,
        "method": "Linear luminescence-to-ATP calibration followed by optional per-sample normalization",
        "limitations": ["Linear calibration over the supplied standard range; luminescence beyond it extrapolates unreliably.",
                        "Samples without a matching normalization entry keep unnormalized concentrations.",
                        "Assay linearity, quenching, and lysis efficiency are assumed, not verified."],
    }


def analyze_in_vitro_drug_release_kinetics(arguments):
    times = _numbers(arguments.get("time_hours"), "time_hours", minimum=4, maximum=200)
    concentrations = _numbers(arguments.get("concentrations"), "concentrations", minimum=4, maximum=200)
    if len(times) != len(concentrations):
        raise ValueError("time_hours and concentrations must have equal lengths.")
    total_loaded = arguments.get("total_drug_loaded")
    total_loaded = _number(total_loaded, "total_drug_loaded", positive=True) if total_loaded is not None else max(concentrations)
    import numpy as np
    from scipy.optimize import curve_fit

    t = np.asarray(times, dtype=float)
    release = np.asarray(concentrations) / total_loaded * 100
    if float(np.max(release)) > 100.0 + 1e-6:
        raise ValueError("Concentrations exceed total_drug_loaded; release cannot exceed 100%.")

    def r_squared(observed, predicted):
        ss_res = float(np.sum((observed - predicted) ** 2))
        ss_tot = float(np.sum((observed - observed.mean()) ** 2))
        return 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0

    models = {}
    candidates = {
        "zero_order": (lambda time, k: k * time, [10.0], ([0.0], [np.inf])),
        "first_order": (lambda time, k: 100 * (1 - np.exp(-k * time)), [0.1], ([0.0], [1.0])),
        "higuchi": (lambda time, k: k * np.sqrt(time), [10.0], ([0.0], [np.inf])),
    }
    for name, (model, p0, bounds) in candidates.items():
        try:
            parameters, _ = curve_fit(model, t, release, p0=p0, bounds=bounds, maxfev=20_000)
            predicted = model(t, *parameters)
            models[name] = {"parameters": [round(float(value), 8) for value in parameters],
                            "r_squared": round(r_squared(release, predicted), 8),
                            "equation": {"zero_order": "R = k*t", "first_order": "R = 100*(1-exp(-k*t))", "higuchi": "R = k*sqrt(t)"}[name]}
        except (RuntimeError, ValueError):
            models[name] = {"parameters": None, "r_squared": None, "error": "fitting failed"}
    mask = release <= 60
    if int(mask.sum()) >= 3:
        def korsmeyer(time, k, exponent):
            return 100 * (k * time) ** exponent
        try:
            parameters, _ = curve_fit(korsmeyer, t[mask], release[mask], p0=[0.1, 0.5], bounds=([0.0, 0.0], [1.0, 1.0]), maxfev=20_000)
            predicted = korsmeyer(t, *parameters)
            models["korsmeyer_peppas"] = {"parameters": [round(float(value), 8) for value in parameters],
                                          "r_squared": round(r_squared(release, predicted), 8),
                                          "equation": "R = 100*(k*t)^n", "fitted_points": int(mask.sum())}
        except (RuntimeError, ValueError):
            models["korsmeyer_peppas"] = {"parameters": None, "r_squared": None, "error": "fitting failed"}
    else:
        models["korsmeyer_peppas"] = {"parameters": None, "r_squared": None, "error": "fewer than 3 points at or below 60% release"}
    scored = {name: data["r_squared"] for name, data in models.items() if data.get("r_squared") is not None}
    best = max(scored, key=scored.get) if scored else None
    half_life = None
    if best == "zero_order" and models[best]["parameters"][0] > 0:
        half_life = 50 / models[best]["parameters"][0]
    elif best == "first_order" and models[best]["parameters"][0] > 0:
        half_life = -math.log(0.5) / models[best]["parameters"][0]
    elif best == "higuchi" and models[best]["parameters"][0] > 0:
        half_life = (50 / models[best]["parameters"][0]) ** 2
    elif best == "korsmeyer_peppas":
        k, n = models[best]["parameters"]
        if k > 0:
            half_life = 0.5 ** (1 / n) / k
    mechanism = None
    if best == "higuchi":
        mechanism = "diffusion through a porous matrix"
    elif best == "korsmeyer_peppas" and models[best]["parameters"]:
        n = models[best]["parameters"][1]
        mechanism = "diffusion with erosion" if 0.43 <= n <= 0.85 else "Fickian diffusion" if n < 0.43 else "case-II transport"
    elif best == "first_order":
        mechanism = "concentration-dependent diffusion"
    elif best == "zero_order":
        mechanism = "constant release rate independent of concentration"
    return {
        "n": len(times), "total_drug_loaded": total_loaded,
        "cumulative_release_percent": [round(float(value), 6) for value in release],
        "models": models, "best_model": best, "half_life_hours": round(half_life, 6) if half_life else None,
        "release_rate_percent_per_hour": [round(float(value), 6) for value in np.gradient(release, t)],
        "suggested_mechanism": mechanism,
        "method": "Zero-order, first-order, Higuchi, and Korsmeyer-Peppas fits with R-squared selection (KP fitted at or below 60% release)",
        "limitations": ["R-squared model selection is descriptive; mechanistic attribution requires independent evidence.",
                        "The Korsmeyer-Peppas exponent threshold interpretation assumes a thin slab geometry.",
                        "Cumulative release above 100% is rejected; sink conditions are assumed but not verified."],
    }


def analyze_accelerated_stability_of_pharmaceutical_formulations(arguments):
    formulations = arguments.get("formulations")
    if not isinstance(formulations, list) or not 1 <= len(formulations) <= 50:
        raise ValueError("formulations must contain 1 to 50 entries.")
    for index, formulation in enumerate(formulations):
        if not isinstance(formulation, dict) or not {"name", "dosage_form"} <= set(formulation) <= {"name", "dosage_form"}:
            raise ValueError(f"formulations[{index}] must contain name and dosage_form.")
        _string(formulation["name"], f"formulations[{index}].name")
        _string(formulation["dosage_form"], f"formulations[{index}].dosage_form")
    conditions = arguments.get("storage_conditions")
    if not isinstance(conditions, list) or not 1 <= len(conditions) <= 20:
        raise ValueError("storage_conditions must contain 1 to 20 entries.")
    parsed_conditions = []
    for index, condition in enumerate(conditions):
        if not isinstance(condition, dict) or not {"description", "temperature_c"} <= set(condition) <= {"description", "temperature_c", "humidity_percent"}:
            raise ValueError(f"storage_conditions[{index}] must contain description and temperature_c (optional humidity_percent).")
        parsed_conditions.append({"description": _string(condition["description"], "description"),
                                  "temperature": _number(condition["temperature_c"], "temperature_c", minimum=-20, maximum=200),
                                  "humidity": _number(condition["humidity_percent"], "humidity_percent", minimum=0, maximum=100) if "humidity_percent" in condition else None})
    time_points = _numbers(arguments.get("time_points_days"), "time_points_days", minimum=1, maximum=100, nonnegative=True)
    rows = []
    for formulation in formulations:
        solid = "solid" in formulation["dosage_form"].lower()
        for condition in parsed_conditions:
            acceleration = 2 ** ((condition["temperature"] - 25) / 10)
            humidity_factor = 1.0 + (condition["humidity"] - 60) / 100 if condition["humidity"] is not None and condition["humidity"] > 60 else 1.0
            for days in time_points:
                effective_time = days * acceleration * humidity_factor
                chemical = 100.0 * math.exp(-0.001 * effective_time)
                physical = max(1.0, 10 - 0.05 * effective_time)
                particle_growth = 0.2 * effective_time if solid else 0.0
                assessment = ("stable" if chemical >= 90 and physical >= 7
                              else "potentially_unstable" if chemical >= 85 and physical >= 5 else "unstable")
                rows.append({"formulation": formulation["name"], "condition": condition["description"],
                             "temperature_c": condition["temperature"], "humidity_percent": condition["humidity"],
                             "days": days, "chemical_stability_percent": round(chemical, 4),
                             "physical_stability_score_of_10": round(physical, 4),
                             "particle_size_growth_percent": round(particle_growth, 4),
                             "assessment": assessment})
    by_formulation = {}
    for row in rows:
        by_formulation.setdefault(row["formulation"], []).append(row["chemical_stability_percent"])
    best = max(by_formulation, key=lambda name: sum(by_formulation[name]) / len(by_formulation[name]))
    return {
        "rows": rows, "formulation_count": len(formulations),
        "most_stable_formulation": {"name": best, "mean_chemical_stability_percent": round(sum(by_formulation[best]) / len(by_formulation[best]), 4)},
        "method": "Rule-of-thumb accelerated screening: rate doubling per 10C, first-order decay k=0.001/day, linear physical scoring (upstream heuristic constants)",
        "limitations": ["Screening heuristics with upstream's fixed illustrative constants; NOT Arrhenius fitting of real stability data.",
                        "Humidity and dosage-form particle-growth terms are crude surrogates; results support planning, not shelf-life assignment.",
                        "Assessments use upstream's fixed thresholds (90/85% chemical, 7/5 physical)."],
    }


def analyze_abr_waveform_p1_metrics(arguments):
    times = _numbers(arguments.get("time_ms"), "time_ms", minimum=10)
    amplitudes = _numbers(arguments.get("amplitude_uv"), "amplitude_uv", minimum=10)
    if len(times) != len(amplitudes):
        raise ValueError("time_ms and amplitude_uv must have equal lengths.")
    import numpy as np
    from scipy.signal import find_peaks

    peaks, properties = find_peaks(np.asarray(amplitudes), height=0)
    if len(peaks) == 0:
        return {"peaks_detected": 0, "p1": None, "message": "No positive peaks detected in the ABR waveform.",
                "limitations": ["Peak detection requires positive deflections; inverted or noisy traces return no P1."]}
    latencies = np.asarray(times)[peaks]
    heights = properties["peak_heights"]
    window = np.where((latencies >= 1) & (latencies <= 3))[0]
    index = int(window[np.argmax(heights[window])]) if len(window) else 0
    return {
        "peaks_detected": int(len(peaks)),
        "p1": {"amplitude_uv": round(float(heights[index]), 6), "latency_ms": round(float(latencies[index]), 6),
               "within_expected_window": bool(len(window))},
        "all_peaks": [{"amplitude_uv": round(float(height), 6), "latency_ms": round(float(latency), 6)}
                      for height, latency in zip(heights, latencies)],
        "method": "Positive-peak detection with the largest peak in the 1-3 ms latency window as P1",
        "limitations": ["P1 identification is a fixed-latency-window heuristic; waveform quality and electrode placement are not assessed.",
                        "Amplitudes are uncalibrated trace values; no hearing-threshold inference."],
    }


def analyze_endolysosomal_calcium_dynamics(arguments):
    times = _numbers(arguments.get("time_s"), "time_s", minimum=10)
    luminescence = _numbers(arguments.get("luminescence"), "luminescence", minimum=10)
    if len(times) != len(luminescence):
        raise ValueError("time_s and luminescence must have equal lengths.")
    treatment_time = arguments.get("treatment_time_s")
    treatment_time = _number(treatment_time, "treatment_time_s", minimum=0) if treatment_time is not None else None
    import numpy as np
    from scipy.signal import find_peaks

    t = np.asarray(times, dtype=float)
    values = np.asarray(luminescence, dtype=float)
    if treatment_time is not None:
        baseline_mask = t < treatment_time
        if baseline_mask.sum() < 2:
            raise ValueError("At least two pre-treatment samples are required for a baseline.")
        baseline = float(values[baseline_mask].mean())
        baseline_std = float(values[baseline_mask].std(ddof=1)) if baseline_mask.sum() > 1 else 0.0
    else:
        cutoff = max(2, int(len(values) * 0.1))
        baseline = float(values[:cutoff].mean())
        baseline_std = float(values[:cutoff].std(ddof=1)) if cutoff > 1 else 0.0
    if baseline <= 0:
        raise ValueError("Baseline luminescence must be positive for normalization.")
    normalized = values / baseline
    peaks, properties = find_peaks(normalized, height=1.1, distance=5)
    auc = float(np.trapezoid(normalized - 1.0, t))
    result = {
        "n": len(times), "baseline": round(baseline, 6), "baseline_std": round(baseline_std, 6),
        "peaks_detected": int(len(peaks)),
        "peaks": [{"time_s": round(float(t[index]), 6), "normalized": round(float(normalized[index]), 6)} for index in peaks],
        "area_under_curve_excess": round(auc, 6),
        "coefficient_of_variation": round(float(normalized.std() / normalized.mean()), 6),
        "treatment_time_s": treatment_time,
        "method": "Baseline-normalized luminescence with peak detection (height > 1.1x, spacing >= 5 samples) and trapezoidal excess AUC",
        "limitations": ["Peak thresholds and spacing follow upstream and are heuristic; sampling-rate assumptions are not inferred.",
                        "AUC integrates the normalized excess over the whole trace; negative excursions reduce it.",
                        "Probe kinetics, compartment specificity, and calibration are assumed."],
    }
    if len(peaks):
        maximum = peaks[int(np.argmax(properties["peak_heights"]))]
        peak_time = float(t[maximum])
        result["max_peak"] = {"time_s": round(peak_time, 6), "normalized": round(float(normalized[maximum]), 6)}
        result["response_time_after_treatment_s"] = round(peak_time - treatment_time, 6) if treatment_time is not None and peak_time > treatment_time else None
        post_peak = normalized[maximum:]
        half_value = 1.0 + (float(normalized[maximum]) - 1.0) / 2
        below = np.where(post_peak < half_value)[0]
        result["half_decay_s"] = round(float(t[maximum + below[0]] - peak_time), 6) if len(below) else None
    return result


def analyze_fatty_acid_composition_by_gc(arguments):
    supplied = arguments.get("peaks")
    if not isinstance(supplied, list) or not 1 <= len(supplied) <= 2000:
        raise ValueError("peaks must contain 1 to 2000 {retention_time, area} entries.")
    peaks = {}
    for index, peak in enumerate(supplied):
        if not isinstance(peak, dict) or set(peak) != {"retention_time", "area"}:
            raise ValueError(f"peaks[{index}] must contain retention_time and area.")
        retention = _number(peak["retention_time"], "retention_time", minimum=0)
        area = _number(peak["area"], "area", minimum=0)
        if retention in peaks:
            raise ValueError(f"Duplicate retention time {retention}.")
        peaks[retention] = area
    total = sum(peaks.values())
    if total <= 0:
        raise ValueError("Total peak area must be positive.")
    windows = {"myristic_c14_0": (2.1, 2.3), "palmitic_c16_0": (2.8, 3.0), "palmitoleic_c16_1": (3.1, 3.3),
               "stearic_c18_0": (3.7, 3.9), "oleic_c18_1": (4.0, 4.2), "linoleic_c18_2": (4.4, 4.6),
               "alpha_linolenic_c18_3": (4.7, 4.9), "arachidonic_c20_4": (5.1, 5.3), "epa_c20_5": (5.5, 5.7),
               "t10c12_cla": (5.8, 6.0), "dha_c22_6": (6.3, 6.5)}
    identified = {}
    for acid, (low, high) in windows.items():
        area = sum(value for retention, value in peaks.items() if low <= retention <= high)
        identified[acid] = {"area": round(area, 6), "percent_of_total_area": round(area / total * 100, 6)}
    saturated = {"myristic_c14_0", "palmitic_c16_0", "stearic_c18_0"}
    saturated_total = sum(identified[acid]["percent_of_total_area"] for acid in saturated)
    unsaturated_total = sum(data["percent_of_total_area"] for acid, data in identified.items() if acid not in saturated)
    detected = sorted((acid for acid, data in identified.items() if data["area"] > 0),
                      key=lambda acid: -identified[acid]["percent_of_total_area"])
    return {
        "total_peak_area": round(total, 6), "fatty_acids": identified,
        "identified_count": len(detected), "most_abundant": detected[:3],
        "saturated_percent": round(saturated_total, 6), "unsaturated_percent": round(unsaturated_total, 6),
        "saturated_to_unsaturated_ratio": round(saturated_total / unsaturated_total, 6) if unsaturated_total > 0 else None,
        "method": "Retention-window peak aggregation with area-percent normalization (upstream reference windows)",
        "limitations": ["Retention-time windows are upstream's illustrative values for one method setup; recalibrate for your column and program.",
                        "Area-percent normalization assumes equal response factors; co-elution and baseline drift are not corrected."],
    }


def analyze_hemodynamic_data(arguments):
    pressure = _numbers(arguments.get("pressure_mmhg"), "pressure_mmhg", minimum=50, maximum=50000)
    sampling_rate = _number(arguments.get("sampling_rate_hz"), "sampling_rate_hz", positive=True, maximum=10000)
    if sampling_rate < 1:
        raise ValueError("sampling_rate_hz must be at least 1 Hz for bandpass design.")
    import numpy as np
    from scipy import signal

    raw = np.asarray(pressure, dtype=float)
    nyquist = sampling_rate / 2
    low, high = 0.5 / nyquist, min(10.0 / nyquist, 0.999)
    if low >= high:
        raise ValueError("Sampling rate too low for the 0.5-10 Hz bandpass.")
    b_coefficient, a_coefficient = signal.butter(2, [low, high], btype="band")
    filtered = signal.filtfilt(b_coefficient, a_coefficient, raw)
    # Restore the DC level the bandpass removes; upstream reported band-limited
    # amplitudes near zero as if they were pressures.
    filtered = filtered + float(raw.mean())
    peaks, _ = signal.find_peaks(filtered, distance=max(1, int(sampling_rate * 0.5)))
    if len(peaks) < 2:
        raise ValueError("Fewer than two systolic peaks detected; check signal quality and sampling rate.")
    valleys = []
    for start, end in zip(peaks[:-1], peaks[1:]):
        valleys.append(int(start + np.argmin(filtered[start:end])))
    systolic = float(filtered[peaks].mean())
    diastolic = float(filtered[valleys].mean()) if valleys else float(filtered.min())
    intervals = np.diff(peaks) / sampling_rate
    return {
        "samples": len(pressure), "sampling_rate_hz": sampling_rate,
        "systolic_mmhg": round(systolic, 4), "diastolic_mmhg": round(diastolic, 4),
        "mean_arterial_pressure_mmhg": round(diastolic + (systolic - diastolic) / 3, 4),
        "heart_rate_bpm": round(60 / float(intervals.mean()), 4),
        "beats_detected": int(len(peaks)),
        "beat_intervals_s": [round(float(value), 6) for value in intervals[:100]],
        "filtered_preview_mmhg": [round(float(value), 4) for value in filtered[: min(len(filtered), 400)]],
        "method": "Second-order Butterworth 0.5-10 Hz zero-phase bandpass with DC restoration, peak/trough detection, MAP = DBP + (SBP-DBP)/3",
        "limitations": ["The 0.5-10 Hz band assumes human-scale pressure waveforms; other species or catheter setups need retuning.",
                        "Upstream reported band-limited (DC-removed) amplitudes as pressures; this port restores the raw mean level before reporting mmHg.",
                        "Peak spacing enforces a minimum 0.5 s beat interval; arrhythmic or noisy traces may miscount.",
                        "A short filtered prefix is returned for inspection, not the full resampled waveform."],
    }


def analyze_barcode_sequencing_data(arguments):
    reads = arguments.get("reads")
    if not isinstance(reads, list) or not 1 <= len(reads) <= 5000:
        raise ValueError("reads must contain 1 to 5000 sequences.")
    for index, read in enumerate(reads):
        if not isinstance(read, str) or not read.isascii() or not 4 <= len(read) <= 500:
            raise ValueError(f"reads[{index}] must contain 4 to 500 ASCII characters.")
    five_prime = arguments.get("flanking_5prime")
    three_prime = arguments.get("flanking_3prime")
    if not isinstance(five_prime, str) or not isinstance(three_prime, str) or not 3 <= len(five_prime) <= 60 or not 3 <= len(three_prime) <= 60:
        raise ValueError("flanking_5prime and flanking_3prime must be 3 to 60 characters.")
    five_prime, three_prime = five_prime.upper(), three_prime.upper()
    min_count = _integer(arguments.get("min_count", 5), "min_count", 1, 1000)
    import numpy as np

    barcodes = []
    for read in reads:
        start = read.upper().find(five_prime)
        if start < 0:
            continue
        begin = start + len(five_prime)
        end = read.upper().find(three_prime, begin)
        if end > begin:
            barcodes.append(read.upper()[begin:end])
    if not barcodes:
        raise ValueError("No barcodes extracted; check the flanking sequences.")
    counts = {}
    for barcode in barcodes:
        counts[barcode] = counts.get(barcode, 0) + 1
    retained = {barcode: count for barcode, count in counts.items() if count >= min_count}
    result = {
        "total_reads": len(reads), "barcodes_extracted": len(barcodes),
        "unique_barcodes": len(counts), "barcodes_above_threshold": len(retained),
        "min_count": min_count,
        "barcode_counts": sorted(({"barcode": barcode, "count": count,
                                   "frequency": round(count / len(reads), 8)} for barcode, count in retained.items()),
                                 key=lambda entry: -entry["count"])[:200],
        "method": "Flanking-sequence barcode extraction with count filtering (first occurrence per read)",
        "limitations": ["Upstream parses FASTQ files and clusters by Hamming distance; this port operates on supplied read strings and reports the corrected lineage clustering only when scipy is available below.",
                        "Extraction uses the first flanking match; reads with multiple or mutated flanks may be skipped.",
                        "A 200-barcode cap applies to the returned table."],
    }
    if len(retained) >= 2:
        from scipy.cluster.hierarchy import fcluster, linkage
        from scipy.spatial.distance import pdist, squareform

        names = sorted(retained)
        length = max(len(name) for name in names)
        matrix = np.zeros((len(names), len(names)))
        for i, first in enumerate(names):
            for j, second in enumerate(names):
                if j > i:
                    distance = sum(a != b for a, b in zip(first.ljust(length), second.ljust(length)))
                    matrix[i, j] = matrix[j, i] = distance
        # Upstream passed the raw distance matrix to pdist (distances of
        # distances); use the condensed Hamming distances directly instead.
        condensed = squareform(matrix, checks=False)
        tree = linkage(condensed, method="average")
        clusters = fcluster(tree, 3, criterion="distance")
        lineages = {}
        for name, cluster in zip(names, clusters):
            lineages.setdefault(int(cluster), []).append(name)
        result["lineage_clustering"] = {
            "method": "Average-linkage hierarchical clustering of Hamming distances, cut at distance 3 (corrected)",
            "lineage_count": len(lineages),
            "largest_lineage_size": max(len(members) for members in lineages.values()),
            "lineages": {str(identifier): members[:50] for identifier, members in sorted(lineages.items(), key=lambda item: -len(item[1])) if members},
        }
    return result


def _schema(properties, required):
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


_NUMBERS_SCHEMA = {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 5000}


def _tool(title, description, schema, example, path, function, dependency=True):
    return {"title": title, "description": description, "input_schema": schema, "example": example,
            "dependency": ["numpy", "scipy"] if dependency else [], "implementation": "biomni-adapted",
            "upstream_functions": [{"path": path, "name": function}]}


TOOLS = {
    "analyze_circular_dichroism_spectra": _tool(
        "Circular dichroism analysis", "Classify CD spectra by wavelength-band sign counting and estimate a midpoint Tm from thermal melts; qualitative.",
        _schema({"wavelengths_nm": _NUMBERS_SCHEMA, "cd_signals_mdeg": _NUMBERS_SCHEMA,
                 "sample_type": {"type": "string", "enum": ["protein", "nucleic_acid"], "default": "protein"},
                 "temperatures_c": {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 500},
                 "thermal_cd_signals": {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 500}},
                ["wavelengths_nm", "cd_signals_mdeg"]),
        {"wavelengths_nm": [192, 194, 196, 208, 218, 222], "cd_signals_mdeg": [8, 7, -2, -9, -7, -6],
         "sample_type": "protein", "temperatures_c": [25, 35, 45, 55, 65, 75, 85], "thermal_cd_signals": [-9, -9, -8, -6, -2, 0.5, 1]},
        "biomni/tool/biochemistry.py", "analyze_circular_dichroism_spectra"),
    "analyze_itc_binding_thermodynamics": _tool(
        "ITC one-site binding fit", "Fit Kd, stoichiometry, and enthalpy from differential ITC heats with a corrected one-site quadratic isotherm.",
        _schema({"molar_ratios": {"type": "array", "items": {"type": "number"}, "minItems": 4, "maxItems": 200},
                 "heats_ucal": {"type": "array", "items": {"type": "number"}, "minItems": 4, "maxItems": 200},
                 "protein_concentration_uM": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e6},
                 "temperature_k": {"type": "number", "minimum": 1, "maximum": 1000, "default": 298.15}},
                ["molar_ratios", "heats_ucal", "protein_concentration_uM"]),
        {"molar_ratios": [0.2, 0.5, 0.8, 1.2, 1.7, 2.4, 3.5, 5.0],
         "heats_ucal": [-6.1746, -8.2099, -6.5905, -6.0933, -4.3455, -2.9987, -2.0641, -1.2023],
         "protein_concentration_uM": 20, "temperature_k": 298.15},
        "biomni/tool/biochemistry.py", "analyze_itc_binding_thermodynamics"),
    "analyze_bacterial_growth_curve": _tool(
        "Logistic growth curve fit", "Fit carrying capacity, rate, doubling time, and an approximate lag from OD600 time series.",
        _schema({"time_hours": _NUMBERS_SCHEMA, "od_values": _NUMBERS_SCHEMA}, ["time_hours", "od_values"]),
        {"time_hours": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
         "od_values": [0.02, 0.03, 0.06, 0.12, 0.25, 0.45, 0.72, 0.95, 1.05, 1.1, 1.12, 1.12, 1.13]},
        "biomni/tool/immunology.py", "analyze_bacterial_growth_curve"),
    "analyze_bacterial_growth_rate": _tool(
        "Gompertz growth rate fit", "Fit Zwietering Gompertz parameters with a corrected specific-rate doubling time from OD600 data.",
        _schema({"time_hours": _NUMBERS_SCHEMA, "od_values": _NUMBERS_SCHEMA}, ["time_hours", "od_values"]),
        {"time_hours": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
         "od_values": [0.02, 0.02, 0.03, 0.06, 0.14, 0.32, 0.62, 0.9, 1.02, 1.08, 1.1, 1.11, 1.11]},
        "biomni/tool/synthetic_biology.py", "analyze_bacterial_growth_rate"),
    "estimate_cell_cycle_phase_durations": _tool(
        "Cell-cycle phase estimation", "Fit G1/S/G2-M durations and death rate to dual-nucleoside pulse-labeling percentages with upstream's simplified model.",
        _schema({"time_hours": {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 200},
                 "edu_positive_percent": {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 200},
                 "brdu_positive_percent": {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 200},
                 "double_positive_percent": {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 200},
                 "initial_estimates": _schema({"g1_duration": {"type": "number", "minimum": 0},
                                               "s_duration": {"type": "number", "minimum": 0},
                                               "g2m_duration": {"type": "number", "minimum": 0},
                                               "death_rate": {"type": "number", "minimum": 0, "maximum": 1}},
                                              ["g1_duration", "s_duration", "g2m_duration", "death_rate"])},
                ["time_hours", "edu_positive_percent", "brdu_positive_percent", "double_positive_percent", "initial_estimates"]),
        {"time_hours": [0, 2, 4, 6, 8, 10], "edu_positive_percent": [30, 28, 26, 24, 22, 20],
         "brdu_positive_percent": [5, 12, 18, 22, 24, 25], "double_positive_percent": [2, 5, 9, 12, 14, 15],
         "initial_estimates": {"g1_duration": 6, "s_duration": 8, "g2m_duration": 4, "death_rate": 0.02}},
        "biomni/tool/immunology.py", "estimate_cell_cycle_phase_durations"),
    "analyze_ebv_antibody_titers": _tool(
        "ELISA titer quantification", "Quantify antibody titers from sample ODs against per-antibody linear standard curves with group summaries.",
        _schema({"standard_curves": {"type": "array", "minItems": 1, "maxItems": 10, "items": _schema(
                     {"antibody": {"type": "string", "minLength": 1, "maxLength": 100},
                      "calibrators": {"type": "array", "minItems": 3, "maxItems": 50, "items": _schema(
                          {"concentration": {"type": "number", "minimum": 0}, "od": {"type": "number", "minimum": 0}},
                          ["concentration", "od"])}}, ["antibody", "calibrators"])},
                 "samples": {"type": "array", "minItems": 1, "maxItems": 500, "items": _schema(
                     {"sample_id": {"type": "string", "minLength": 1, "maxLength": 100}, "group": {"type": "string", "maxLength": 100},
                      "readings": {"type": "array", "minItems": 1, "maxItems": 20, "items": _schema(
                          {"antibody": {"type": "string", "minLength": 1, "maxLength": 100},
                           "od": {"type": "number", "minimum": 0, "maximum": 1e100}}, ["antibody", "od"])}},
                     ["sample_id", "readings"])}},
                ["standard_curves", "samples"]),
        {"standard_curves": [{"antibody": "VCA_IgG", "calibrators": [{"concentration": 0, "od": 0.05}, {"concentration": 50, "od": 0.35},
                                                                     {"concentration": 100, "od": 0.65}, {"concentration": 200, "od": 1.25}]}],
         "samples": [{"sample_id": "s1", "group": "control", "readings": [{"antibody": "VCA_IgG", "od": 0.4}]},
                     {"sample_id": "s2", "group": "case", "readings": [{"antibody": "VCA_IgG", "od": 0.9}]},
                     {"sample_id": "s3", "group": "case", "readings": [{"antibody": "VCA_IgG", "od": 1.0}]}]},
        "biomni/tool/immunology.py", "analyze_ebv_antibody_titers"),
    "analyze_arsenic_speciation_hplc_icpms": _tool(
        "Arsenic speciation quantification", "Assign HPLC-ICP-MS peaks to arsenic species by retention window and quantify with calibration factors.",
        _schema({"samples": {"type": "array", "minItems": 1, "maxItems": 100, "items": _schema(
                     {"sample_id": {"type": "string", "minLength": 1, "maxLength": 100},
                      "chromatogram": {"type": "array", "minItems": 3, "maxItems": 2000, "items": _schema(
                          {"retention_time": {"type": "number", "minimum": 0}, "intensity": {"type": "number", "minimum": 0}},
                          ["retention_time", "intensity"])}}, ["sample_id", "chromatogram"])},
                 "retention_tolerance_min": {"type": "number", "exclusiveMinimum": 0, "maximum": 2, "default": 0.3},
                 "calibration_factors": {"type": "array", "minItems": 1, "maxItems": 20, "items": _schema(
                     {"species": {"type": "string", "minLength": 1, "maxLength": 50}, "factor": {"type": "number", "exclusiveMinimum": 0},
                      "detection_limit": {"type": "number", "exclusiveMinimum": 0}}, ["species", "factor", "detection_limit"])}},
                ["samples"]),
        {"samples": [{"sample_id": "well_a", "chromatogram": [{"retention_time": 2.8, "intensity": 120}, {"retention_time": 7.5, "intensity": 45},
                                                             {"retention_time": 5.3, "intensity": 12}]}]},
        "biomni/tool/microbiology.py", "analyze_arsenic_speciation_hplc_icpms"),
    "enumerate_bacterial_cfu_by_serial_dilution": _tool(
        "Serial-dilution CFU planning", "Simulate expected spot-count outcomes for a dilution series with seeded Poisson counts (planning aid, not a measurement).",
        _schema({"estimated_concentration_cfu_per_ml": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e12},
                 "dilution_factor": {"type": "integer", "minimum": 2, "maximum": 1000, "default": 10},
                 "num_dilutions": {"type": "integer", "minimum": 1, "maximum": 12, "default": 7},
                 "spots_per_dilution": {"type": "integer", "minimum": 1, "maximum": 10, "default": 3},
                 "seed": {"type": "integer", "minimum": 0, "maximum": 2147483647, "default": 0}},
                ["estimated_concentration_cfu_per_ml"]),
        {"estimated_concentration_cfu_per_ml": 2e7, "dilution_factor": 10, "num_dilutions": 6, "spots_per_dilution": 3, "seed": 42},
        "biomni/tool/microbiology.py", "enumerate_bacterial_cfu_by_serial_dilution"),
    "quantify_biofilm_biomass_crystal_violet": _tool(
        "Biofilm biomass quantification", "Control-subtracted crystal violet OD statistics with replicate-aware one-sample t-tests.",
        _schema({"samples": {"type": "array", "minItems": 2, "maxItems": 200, "items": _schema(
                     {"name": {"type": "string", "minLength": 1, "maxLength": 100},
                      "replicate_ods": {"type": "array", "items": {"type": "number", "minimum": 0}, "minItems": 2, "maxItems": 50}},
                     ["name", "replicate_ods"])},
                 "control_sample": {"type": "string", "minLength": 1, "maxLength": 100}}, ["samples"]),
        {"samples": [{"name": "control", "replicate_ods": [0.12, 0.13, 0.12]},
                     {"name": "treated_a", "replicate_ods": [0.35, 0.37, 0.36]},
                     {"name": "treated_b", "replicate_ods": [0.14, 0.15, 0.13]}], "control_sample": "control"},
        "biomni/tool/microbiology.py", "quantify_biofilm_biomass_crystal_violet"),
    "analyze_atp_luminescence_assay": _tool(
        "ATP luminescence quantification", "Convert luminescence to ATP concentration via a linear standard curve with optional cell-count or protein normalization.",
        _schema({"standard_curve": {"type": "array", "minItems": 3, "maxItems": 50, "items": _schema(
                     {"luminescence": {"type": "number", "minimum": 0}, "concentration": {"type": "number", "minimum": 0}},
                     ["luminescence", "concentration"])},
                 "samples": {"type": "array", "minItems": 1, "maxItems": 500, "items": _schema(
                     {"sample_id": {"type": "string", "minLength": 1, "maxLength": 100},
                      "luminescence": {"type": "number", "minimum": 0}}, ["sample_id", "luminescence"])},
                 "normalization_method": {"type": "string", "enum": ["none", "cell_count", "protein_content"], "default": "none"},
                 "normalization": {"type": "array", "minItems": 1, "maxItems": 500, "items": _schema(
                     {"sample_id": {"type": "string", "minLength": 1, "maxLength": 100},
                      "value": {"type": "number", "exclusiveMinimum": 0}}, ["sample_id", "value"])}},
                ["standard_curve", "samples"]),
        {"standard_curve": [{"luminescence": 1000, "concentration": 5}, {"luminescence": 2500, "concentration": 13},
                            {"luminescence": 5000, "concentration": 26}, {"luminescence": 10000, "concentration": 52}],
         "samples": [{"sample_id": "a", "luminescence": 3200}, {"sample_id": "b", "luminescence": 6100}],
         "normalization_method": "cell_count",
         "normalization": [{"sample_id": "a", "value": 2.0}, {"sample_id": "b", "value": 1.8}]},
        "biomni/tool/pathology.py", "analyze_atp_luminescence_assay"),
    "analyze_in_vitro_drug_release_kinetics": _tool(
        "Drug release kinetics", "Fit zero-order, first-order, Higuchi, and Korsmeyer-Peppas models to cumulative release data and pick the best by R-squared.",
        _schema({"time_hours": {"type": "array", "items": {"type": "number"}, "minItems": 4, "maxItems": 200},
                 "concentrations": {"type": "array", "items": {"type": "number"}, "minItems": 4, "maxItems": 200},
                 "total_drug_loaded": {"type": "number", "exclusiveMinimum": 0}}, ["time_hours", "concentrations", "total_drug_loaded"]),
        {"time_hours": [0.5, 1, 2, 4, 8, 12, 24, 48],
         "concentrations": [8, 14, 25, 42, 61, 70, 82, 90], "total_drug_loaded": 100},
        "biomni/tool/bioengineering.py", "analyze_in_vitro_drug_release_kinetics"),
    "analyze_accelerated_stability_of_pharmaceutical_formulations": _tool(
        "Accelerated stability screening", "Rule-of-thumb accelerated stability screening (rate doubling per 10C) across formulations and conditions.",
        _schema({"formulations": {"type": "array", "minItems": 1, "maxItems": 50, "items": _schema(
                     {"name": {"type": "string", "minLength": 1, "maxLength": 100},
                      "dosage_form": {"type": "string", "minLength": 1, "maxLength": 100}}, ["name", "dosage_form"])},
                 "storage_conditions": {"type": "array", "minItems": 1, "maxItems": 20, "items": _schema(
                     {"description": {"type": "string", "minLength": 1, "maxLength": 100},
                      "temperature_c": {"type": "number", "minimum": -20, "maximum": 200},
                      "humidity_percent": {"type": "number", "minimum": 0, "maximum": 100}},
                     ["description", "temperature_c"])},
                 "time_points_days": {"type": "array", "items": {"type": "number", "minimum": 0}, "minItems": 1, "maxItems": 100}},
                ["formulations", "storage_conditions", "time_points_days"]),
        {"formulations": [{"name": "tablet_a", "dosage_form": "solid tablet"}, {"name": "solution_b", "dosage_form": "oral solution"}],
         "storage_conditions": [{"description": "accelerated 40C/75RH", "temperature_c": 40, "humidity_percent": 75},
                                {"description": "room 25C", "temperature_c": 25}],
         "time_points_days": [7, 30, 90, 180]},
        "biomni/tool/pharmacology.py", "analyze_accelerated_stability_of_pharmaceutical_formulations"),
    "analyze_abr_waveform_p1_metrics": _tool(
        "ABR wave-I metrics", "Extract the P1 (wave I) amplitude and latency from an auditory brainstem response waveform.",
        _schema({"time_ms": {"type": "array", "items": {"type": "number"}, "minItems": 10, "maxItems": 5000},
                 "amplitude_uv": {"type": "array", "items": {"type": "number"}, "minItems": 10, "maxItems": 5000}},
                ["time_ms", "amplitude_uv"]),
        {"time_ms": [0.0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.2, 2.4, 2.6, 2.8, 3.0, 3.2, 3.4, 3.6, 3.8],
         "amplitude_uv": [0.0, 0.1, 0.4, 0.9, 1.4, 1.1, 0.6, 0.2, -0.1, 0.3, 1.6, 0.9, 0.2, -0.2, -0.4, -0.1, 0.4, 0.9, 0.5, 0.1]},
        "biomni/tool/physiology.py", "analyze_abr_waveform_p1_metrics"),
    "analyze_endolysosomal_calcium_dynamics": _tool(
        "Endo-lysosomal calcium dynamics", "Baseline-normalize luminescence traces, detect calcium peaks, and quantify response kinetics and excess AUC.",
        _schema({"time_s": {"type": "array", "items": {"type": "number"}, "minItems": 10, "maxItems": 5000},
                 "luminescence": {"type": "array", "items": {"type": "number"}, "minItems": 10, "maxItems": 5000},
                 "treatment_time_s": {"type": "number", "minimum": 0}}, ["time_s", "luminescence"]),
        {"time_s": [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48],
         "luminescence": [100, 102, 99, 101, 100, 103, 160, 240, 300, 280, 210, 150, 110, 104, 100, 101, 99, 100, 102, 100, 101, 100, 99, 100, 101],
         "treatment_time_s": 5},
        "biomni/tool/physiology.py", "analyze_endolysosomal_calcium_dynamics"),
    "analyze_fatty_acid_composition_by_gc": _tool(
        "GC fatty acid composition", "Aggregate gas-chromatography peaks into reference retention windows and report area-percent composition.",
        _schema({"peaks": {"type": "array", "minItems": 1, "maxItems": 2000, "items": _schema(
                     {"retention_time": {"type": "number", "minimum": 0}, "area": {"type": "number", "minimum": 0}},
                     ["retention_time", "area"])}}, ["peaks"]),
        {"peaks": [{"retention_time": 2.9, "area": 1200}, {"retention_time": 3.2, "area": 4000}, {"retention_time": 3.8, "area": 2500},
                   {"retention_time": 4.1, "area": 5200}, {"retention_time": 4.5, "area": 3100}, {"retention_time": 6.4, "area": 900}]},
        "biomni/tool/physiology.py", "analyze_fatty_acid_composition_by_gc"),
    "analyze_hemodynamic_data": _tool(
        "Hemodynamic parameter extraction", "Bandpass-filter arterial pressure and derive SBP, DBP, MAP, and heart rate from beat detection.",
        _schema({"pressure_mmhg": {"type": "array", "items": {"type": "number"}, "minItems": 50, "maxItems": 5000},
                 "sampling_rate_hz": {"type": "number", "exclusiveMinimum": 0, "maximum": 10000}}, ["pressure_mmhg", "sampling_rate_hz"]),
        {"pressure_mmhg": [95, 96, 96, 96, 97, 98, 99, 100, 102, 104, 106, 108, 110, 112, 114, 116, 117, 118, 118, 117, 116, 115, 113, 111, 108, 106, 104, 102, 100, 98, 97, 96, 95, 94, 93, 92, 92, 91, 91, 90, 90, 89, 89, 89, 89, 89, 89, 89, 90, 90, 90, 91, 91, 92, 92, 93, 93, 93, 94, 94, 94, 94, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 96, 96, 96, 97, 98, 99, 100, 102, 104, 106, 108, 110, 112, 114, 116, 117, 118, 118, 117, 116, 115, 113, 111, 108, 106, 104, 102, 100, 98, 97, 96, 95, 94, 93, 92, 92, 91, 91, 90, 90, 89, 89, 89, 89, 89, 89, 89, 90, 90, 90, 91, 91, 92, 92, 93, 93, 93, 94, 94, 94, 94, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 96, 96, 96, 97, 98, 99, 100, 102, 104, 106, 108, 110, 112, 114, 116, 117, 118, 118, 117, 116, 115, 113, 111, 108, 106, 104, 102, 100, 98, 97, 96, 95, 94, 93, 92, 92, 91, 91, 90, 90, 89, 89, 89, 89, 89, 89, 89, 90, 90, 90, 91, 91, 92, 92, 93, 93, 93, 94, 94, 94, 94, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 96, 96, 96, 97, 98, 99, 100, 102, 104, 106, 108, 110, 112, 114, 116, 117, 118, 118, 117, 116, 115, 113, 111, 108, 106, 104, 102, 100, 98, 97, 96, 95, 94, 93, 92, 92, 91, 91, 90, 90, 89, 89, 89, 89, 89, 89, 89, 90, 90, 90, 91, 91, 92, 92, 93, 93, 93, 94, 94, 94, 94, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95],
         "sampling_rate_hz": 100},
        "biomni/tool/physiology.py", "analyze_hemodynamic_data"),
    "analyze_barcode_sequencing_data": _tool(
        "Barcode sequencing analysis", "Extract barcodes from supplied reads by flanking sequences, quantify abundances, and cluster lineages by corrected Hamming linkage.",
        _schema({"reads": {"type": "array", "items": {"type": "string", "minLength": 4, "maxLength": 500}, "minItems": 1, "maxItems": 5000},
                 "flanking_5prime": {"type": "string", "minLength": 3, "maxLength": 60},
                 "flanking_3prime": {"type": "string", "minLength": 3, "maxLength": 60},
                 "min_count": {"type": "integer", "minimum": 1, "maximum": 1000, "default": 5}},
                ["reads", "flanking_5prime", "flanking_3prime"]),
        {"reads": ["ACGTAC_BARCODE1 AACCTGGA", "ACGTACGATTACAGGTAACCTGGA", "ACGTACGATTACAGGTAACCTGGA", "ACGTACGATTACAGGTAACCTGGA",
                   "ACGTACGATTACGGGTAACCTGGA", "ACGTACGATTACAGGTAACCTGGA", "ACGTACCATTAAGGGAACCTGGA", "ACGTACGATTACAGGTAACCTGGA",
                   "ACGTACGATTACAGGTAACCTGGA", "ACGTACCATTAAGGGAACCTGGA"],
         "flanking_5prime": "ACGTAC", "flanking_3prime": "AACCTGGA", "min_count": 2},
        "biomni/tool/synthetic_biology.py", "analyze_barcode_sequencing_data"),
}
HANDLERS = {name: globals()[name] for name in TOOLS}
