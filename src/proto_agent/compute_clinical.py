"""Bounded, offline clinical and pharmacometric analyses adapted from Biomni.

Portions adapted from Biomni (Stanford SNAP), Apache License 2.0, commit
400c1f366b96a35ca253e13c9b06c5076af41d65. See
apps/proto-workbench/THIRD_PARTY_NOTICES.md and the packaged Apache license.
Modifications: JSON-array inputs replace CSV/pandas file loading, NumPy/SciPy
reimplementations of statsmodels procedures (multiple linear regression with
t-distribution p-values, two-way ANOVA, Tukey HSD via the studentized-range
distribution), structured results, strict validation, no files/network, and
explicit veterinary-grading scope notes for the VCOG-CTCAE tables. Outputs
support human review and are not clinical advice.
"""

from __future__ import annotations

import math

# VCOG-CTCAE v1.1 grading ranges transcribed from upstream's inline table.
_VCOG_CRITERIA = {
    "neutropenia": {"description": "Neutrophil count decrease", "unit": "cells/uL",
                    "ranges": [(0, 100, 4), (100, 500, 3), (500, 1000, 2), (1000, 1500, 1)]},
    "anemia": {"description": "Hemoglobin decrease", "unit": "g/dL",
               "ranges": [(0, 5, 4), (5, 6.5, 3), (6.5, 8, 2), (8, 10, 1), (10, math.inf, 0)]},
    "thrombocytopenia": {"description": "Platelet count decrease", "unit": "cells/uL",
                         "ranges": [(0, 10000, 4), (10000, 25000, 3), (25000, 50000, 2), (50000, 100000, 1), (100000, math.inf, 0)]},
    "vomiting": {"description": "Vomiting frequency", "unit": "episodes per 24h",
                 "ranges": [(0, 1, 0), (1, 3, 1), (3, 6, 2), (6, math.inf, 3)]},
    "diarrhea": {"description": "Diarrhea frequency", "unit": "stools per day above baseline",
                 "ranges": [(0, 1, 0), (1, 4, 1), (4, 7, 2), (7, math.inf, 3)]},
    "anorexia": {"description": "Appetite/food intake decrease", "unit": "percent of normal intake",
                 "ranges": [(0, 25, 4), (25, 50, 3), (50, 75, 2), (75, 100, 1), (100, math.inf, 0)]},
    "alt_increase": {"description": "Alanine aminotransferase increased", "unit": "x ULN",
                     "ranges": [(0, 1, 0), (1, 2.5, 1), (2.5, 5, 2), (5, 20, 3), (20, math.inf, 4)]},
    "creatinine_increase": {"description": "Creatinine increased", "unit": "x ULN",
                            "ranges": [(0, 1, 0), (1, 1.5, 1), (1.5, 3, 2), (3, 6, 3), (6, math.inf, 4)]},
    "fever": {"description": "Fever", "unit": "degrees C",
              "ranges": [(0, 39, 0), (39, 39.5, 1), (39.5, 40, 2), (40, 41, 3), (41, math.inf, 4)]},
    "weight_loss": {"description": "Weight loss", "unit": "percent of baseline weight",
                    "ranges": [(0, 5, 0), (5, 10, 1), (10, 20, 2), (20, math.inf, 3)]},
}
_SEVERITY_GRADES = {"none": 0, "mild": 1, "moderate": 2, "severe": 3, "life-threatening": 4, "death": 5}
_SEVERITY_ONLY = {"alopecia", "neuropathy"}


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


def _numbers(value, name, *, minimum=3, maximum=2000):
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        raise ValueError(f"{name} must contain {minimum} to {maximum} numbers.")
    return [_number(item, f"{name}[{index}]") for index, item in enumerate(value)]


def _integer(value, name, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be an integer from {minimum} to {maximum}.")
    return value


def _string(value, name, maximum=100):
    if not isinstance(value, str) or not 1 <= len(value) <= maximum or value.strip() != value:
        raise ValueError(f"{name} must be a nonempty trimmed string of at most {maximum} characters.")
    return value


def grade_adverse_events_using_vcog_ctcae(arguments):
    """Veterinary VCOG-CTCAE v1.1 grading from upstream's inline criteria table."""
    events = arguments.get("events")
    if not isinstance(events, list) or not 1 <= len(events) <= 5000:
        raise ValueError("events must contain 1 to 5000 entries.")
    graded = []
    for index, event in enumerate(events):
        if not isinstance(event, dict) or not {"subject_id", "symptom", "severity"} <= set(event) <= {"subject_id", "symptom", "severity", "measurement"}:
            raise ValueError(f"events[{index}] must contain subject_id, symptom, severity, and optional measurement.")
        subject = _string(event["subject_id"], f"events[{index}].subject_id")
        symptom = _string(event["symptom"], f"events[{index}].symptom").lower()
        severity = _string(event["severity"], f"events[{index}].severity").lower()
        if severity not in _SEVERITY_GRADES:
            raise ValueError(f"events[{index}].severity must be one of: {', '.join(_SEVERITY_GRADES)}.")
        measurement = event.get("measurement")
        measurement = _number(measurement, "measurement") if measurement is not None else None
        grade, rationale = None, None
        if symptom in _VCOG_CRITERIA:
            criteria = _VCOG_CRITERIA[symptom]
            if measurement is not None:
                for low, high, band_grade in criteria["ranges"]:
                    if low <= measurement < high:
                        grade = band_grade
                        rationale = f"Grade {band_grade}: {criteria['description']} ({criteria['unit']} in [{low}, {high}))"
                        break
            if grade is None and severity in _SEVERITY_GRADES and severity != "none":
                grade = _SEVERITY_GRADES[severity]
                rationale = f"Grade {grade}: based on reported severity '{severity}' ({criteria['description']})"
        elif symptom in _SEVERITY_ONLY:
            grade = _SEVERITY_GRADES[severity]
            rationale = f"Grade {grade}: {symptom} has no numeric criteria; graded from reported severity"
        else:
            grade = _SEVERITY_GRADES[severity]
            rationale = f"Grade {grade}: symptom outside the bundled VCOG tables; graded from reported severity"
        graded.append({"subject_id": subject, "symptom": symptom, "severity": severity,
                       "measurement": measurement, "vcog_grade": grade, "rationale": rationale})
    distribution = {}
    for event in graded:
        distribution[str(event["vcog_grade"])] = distribution.get(str(event["vcog_grade"]), 0) + 1
    subjects = {}
    for event in graded:
        subjects.setdefault(event["subject_id"], []).append(event["vcog_grade"])
    severe_subjects = sorted(subject for subject, grades in subjects.items() if max(grades) >= 3)
    return {
        "graded_events": graded, "grade_distribution": distribution,
        "subject_count": len(subjects), "subjects_with_grade_3_or_higher": severe_subjects,
        "max_grade": max(event["vcog_grade"] for event in graded),
        "method": "VCOG-CTCAE v1.1 numeric-band grading with severity fallback, exactly as upstream's inline table",
        "limitations": ["VCOG-CTCAE is a veterinary oncology scale; it must not be used for human CTCAE grading.",
                        f"Numeric bands cover: {', '.join(sorted(_VCOG_CRITERIA))}. {', '.join(sorted(_SEVERITY_ONLY))} and unknown symptoms fall back to reported severity.",
                        "Grade 5 is death by definition and is not derived here; this tool supports review, not clinical decisions."],
    }


def analyze_radiolabeled_antibody_biodistribution(arguments):
    times = _numbers(arguments.get("time_points_hours"), "time_points_hours", minimum=4, maximum=100)
    tissues = arguments.get("tissue_data")
    if not isinstance(tissues, list) or not 1 <= len(tissues) <= 50:
        raise ValueError("tissue_data must contain 1 to 50 {tissue, values} entries.")
    parsed = {}
    for index, tissue in enumerate(tissues):
        if not isinstance(tissue, dict) or set(tissue) != {"tissue", "values"}:
            raise ValueError(f"tissue_data[{index}] must contain tissue and values.")
        name = _string(tissue["tissue"], f"tissue_data[{index}].tissue")
        values = _numbers(tissue["values"], f"tissue_data[{index}].values", minimum=len(times), maximum=len(times))
        if len(values) != len(times):
            raise ValueError(f"tissue_data[{index}].values must match the time point count.")
        if min(values) < 0 or len(set(values)) < 3:
            raise ValueError(f"tissue_data[{index}].values must be nonnegative and varying.")
        parsed[name] = values
    if "tumor" not in parsed:
        raise ValueError("tissue_data must include a 'tumor' entry.")
    import numpy as np
    from scipy.optimize import curve_fit

    t = np.asarray(times, dtype=float)

    def biexponential(time, a, alpha, b, beta):
        return a * np.exp(-alpha * time) + b * np.exp(-beta * time)

    pk_parameters, failures = {}, {}
    for tissue, values in parsed.items():
        try:
            parameters, _ = curve_fit(biexponential, t, np.asarray(values), p0=[50, 0.1, 50, 0.01],
                                      bounds=([0, 1e-9, 0, 1e-9], [1e9, 5.0, 1e9, 1.0]), maxfev=50_000)
            a, alpha, b, beta = map(float, parameters)
            auc = a / alpha + b / beta
            pk_parameters[tissue] = {
                "amplitudes": [round(a, 6), round(b, 6)], "rate_constants_per_hour": [round(alpha, 8), round(beta, 8)],
                "distribution_half_life_hours": round(math.log(2) / alpha, 6),
                "elimination_half_life_hours": round(math.log(2) / beta, 6),
                "auc_percent_id_hours": round(auc, 6),
                "mean_residence_time_hours": round((a / alpha ** 2 + b / beta ** 2) / auc, 6)}
        except (RuntimeError, ValueError) as error:
            failures[tissue] = f"fitting failed: {error}"
    ratios = {}
    tumor_values = parsed["tumor"]
    for tissue, values in parsed.items():
        if tissue == "tumor":
            continue
        if min(values) <= 0:
            continue
        tissue_ratios = [round(t_value / value, 6) for t_value, value in zip(tumor_values, values) if value > 0]
        ratios[tissue] = {"values": tissue_ratios, "max_ratio": max(tissue_ratios),
                          "max_ratio_time_hours": round(times[tissue_ratios.index(max(tissue_ratios))], 4)}
    return {
        "time_points_hours": times, "tissues_analyzed": sorted(parsed),
        "pk_parameters": pk_parameters, "fitting_failures": failures,
        "tumor_to_normal_ratios": ratios,
        "method": "Per-tissue bi-exponential C(t) = A exp(-alpha t) + B exp(-beta t) with derived half-lives, AUC, and MRT",
        "limitations": ["Bi-exponential fitting requires adequate sampling across distribution and elimination phases; sparse data yields unstable parameters.",
                        "Tumor-to-normal ratios are pointwise divisions of the supplied measurements; no volume or decay-decay corrections are applied.",
                        "Clearance is not derived (upstream derived it only for blood/plasma from a reciprocal AUC)."],
    }


def estimate_alpha_particle_radiotherapy_dosimetry(arguments):
    half_life = _number(arguments.get("half_life_hours"), "half_life_hours", positive=True, maximum=1e6)
    weighting = _number(arguments.get("radiation_weighting_factor", 5.0), "radiation_weighting_factor", positive=True, maximum=100)
    biodistribution = arguments.get("biodistribution")
    if not isinstance(biodistribution, list) or not 1 <= len(biodistribution) <= 50:
        raise ValueError("biodistribution must contain 1 to 50 organ entries.")
    s_factors = arguments.get("s_factors")
    if not isinstance(s_factors, list) or not 1 <= len(s_factors) <= 500:
        raise ValueError("s_factors must contain 1 to 500 {source, target, s_value} entries.")
    organ_data, organs = {}, []
    for index, organ in enumerate(biodistribution):
        if not isinstance(organ, dict) or set(organ) != {"organ", "measurements"} or not isinstance(organ["measurements"], list):
            raise ValueError(f"biodistribution[{index}] must contain organ and measurements.")
        name = _string(organ["organ"], f"biodistribution[{index}].organ")
        if name in organ_data:
            raise ValueError(f"Duplicate organ {name}.")
        if not 2 <= len(organ["measurements"]) <= 200:
            raise ValueError(f"biodistribution[{index}].measurements must contain 2 to 200 time/activity pairs.")
        pairs = []
        for pair_index, pair in enumerate(organ["measurements"]):
            if not isinstance(pair, dict) or set(pair) != {"time_hours", "activity_percent_injected"}:
                raise ValueError(f"biodistribution[{index}].measurements[{pair_index}] must contain time_hours and activity_percent_injected.")
            pairs.append((_number(pair["time_hours"], "time_hours", minimum=0),
                          _number(pair["activity_percent_injected"], "activity_percent_injected", minimum=0)))
        organ_data[name] = pairs
        organs.append(name)
    factor_map = {}
    for index, factor in enumerate(s_factors):
        if not isinstance(factor, dict) or set(factor) != {"source", "target", "s_value"}:
            raise ValueError(f"s_factors[{index}] must contain source, target, and s_value.")
        source, target = _string(factor["source"], "source"), _string(factor["target"], "target")
        if source not in organ_data or target not in organ_data:
            raise ValueError(f"s_factors[{index}] references an unknown organ.")
        factor_map[(source, target)] = _number(factor["s_value"], "s_value", positive=True)
    import numpy as np

    decay_constant = math.log(2) / half_life
    cumulated = {}
    for name, pairs in organ_data.items():
        times = np.asarray([pair[0] for pair in pairs])
        corrected = np.asarray([pair[1] * math.exp(-decay_constant * pair[0]) for pair in pairs])
        order = np.argsort(times)
        cumulated[name] = float(np.trapezoid(corrected[order], times[order]))
    conversion = 0.01
    doses = {}
    for target in organs:
        total = sum(cumulated[source] * conversion * factor_map[(source, target)]
                    for source in organs if (source, target) in factor_map)
        doses[target] = round(total * weighting, 8)
    tumor_dose = doses.get("tumor", 0.0)
    indices = {organ: round(tumor_dose / dose, 6) for organ, dose in doses.items()
               if organ != "tumor" and dose > 0} if tumor_dose > 0 else {}
    return {
        "half_life_hours": half_life, "radiation_weighting_factor": weighting,
        "cumulated_activity_percent_id_hours": {organ: round(value, 6) for organ, value in cumulated.items()},
        "absorbed_doses_gy_per_mbq": doses, "tumor_to_organ_dose_ratios": indices,
        "method": "MIRD schema: decay-corrected trapezoidal cumulated activity times S-factors times weighting factor",
        "limitations": ["S-factors must come from an appropriate phantom/source; self-dose and cross-dose terms are only as good as those values.",
                        "Trapezoidal integration between samples; long unsampled tails (e.g. late bone retention) are not extrapolated.",
                        "Organ naming must match between biodistribution and S-factors; unmatched pairs contribute nothing."],
    }


def perform_mwas_cyp2c19_metabolizer_status(arguments):
    """Per-CpG multiple regression with covariates (statsmodels OLS reimplemented)."""
    status_order = {"poor": 1, "intermediate": 2, "normal": 3, "rapid": 4, "ultrarapid": 5}
    samples = arguments.get("sample_ids")
    if not isinstance(samples, list) or not 3 <= len(samples) <= 500:
        raise ValueError("sample_ids must contain 3 to 500 identifiers.")
    if any(not isinstance(sample, str) or not sample for sample in samples) or len(set(samples)) != len(samples):
        raise ValueError("sample_ids must be unique nonempty strings.")
    statuses = arguments.get("metabolizer_status")
    if not isinstance(statuses, list) or len(statuses) != len(samples):
        raise ValueError("metabolizer_status must align with sample_ids.")
    numeric_status = []
    for index, status in enumerate(statuses):
        if isinstance(status, str):
            if status not in status_order:
                raise ValueError(f"metabolizer_status[{index}] must be numeric or one of: {', '.join(status_order)}.")
            numeric_status.append(float(status_order[status]))
        else:
            numeric_status.append(_number(status, f"metabolizer_status[{index}]"))
    methylation = arguments.get("methylation_matrix")
    if not isinstance(methylation, list) or not 1 <= len(methylation) <= 200:
        raise ValueError("methylation_matrix must contain 1 to 200 CpG rows.")
    matrix = []
    for index, row in enumerate(methylation):
        values = _numbers(row, f"methylation_matrix[{index}]", minimum=len(samples), maximum=len(samples))
        if len(values) != len(samples):
            raise ValueError(f"methylation_matrix[{index}] must have one value per sample.")
        matrix.append(values)
    covariates = arguments.get("covariates")
    covariate_matrix = []
    covariate_names = []
    if covariates is not None:
        if not isinstance(covariates, list) or not 1 <= len(covariates) <= 20:
            raise ValueError("covariates must contain 1 to 20 entries.")
        for index, covariate in enumerate(covariates):
            if not isinstance(covariate, dict) or set(covariate) != {"name", "values"}:
                raise ValueError(f"covariates[{index}] must contain name and values.")
            values = _numbers(covariate["values"], f"covariates[{index}].values", minimum=len(samples), maximum=len(samples))
            if len(values) != len(samples):
                raise ValueError(f"covariates[{index}].values must have one value per sample.")
            covariate_names.append(_string(covariate["name"], "covariate name"))
            covariate_matrix.append(values)
    threshold = _number(arguments.get("pvalue_threshold", 0.05), "pvalue_threshold", minimum=1e-12, maximum=1)
    import numpy as np
    from scipy import stats

    n = len(samples)
    base_design = np.column_stack([np.ones(n), np.asarray(numeric_status)] +
                                  (np.asarray(covariate_matrix).T if covariate_matrix else []))
    parameter_count = base_design.shape[1]
    if n <= parameter_count:
        raise ValueError("More predictors than samples; reduce covariates or add samples.")
    results = []
    for index, row in enumerate(matrix):
        design = base_design
        outcome = np.asarray(row)
        coefficients, _, _, _ = np.linalg.lstsq(design, outcome, rcond=None)
        residuals = outcome - design @ coefficients
        dof = n - parameter_count
        sigma_squared = float(residuals @ residuals) / dof
        try:
            covariance = sigma_squared * np.linalg.inv(design.T @ design)
        except np.linalg.LinAlgError:
            raise ValueError("Regressors are collinear; remove duplicated covariates.")
        standard_error = math.sqrt(max(float(covariance[1, 1]), 0.0))
        slope = float(coefficients[1])
        if standard_error <= 0:
            results.append({"cpg_index": index, "coefficient": slope, "p_value": None,
                            "note": "degenerate standard error"})
            continue
        statistic = slope / standard_error
        p_value = float(2 * stats.t.sf(abs(statistic), dof))
        results.append({"cpg_index": index, "coefficient": round(slope, 8),
                        "standard_error": round(standard_error, 8),
                        "t_statistic": round(statistic, 8), "p_value": p_value})
    tested = len(results)
    for row in results:
        if row.get("p_value") is not None:
            row["adjusted_p_value_bonferroni"] = min(row["p_value"] * tested, 1.0)
    significant = sorted((row for row in results if row.get("adjusted_p_value_bonferroni", 1) < threshold),
                         key=lambda row: row["adjusted_p_value_bonferroni"])
    return {
        "sample_count": n, "cpg_count": tested, "covariates": covariate_names,
        "pvalue_threshold": threshold, "significant_cpg_count": len(significant),
        "top_hits": significant[:10], "all_results": results[:500],
        "method": "Per-CpG ordinary least squares methylation ~ metabolizer status + covariates; two-sided t p-values; Bonferroni across all CpGs",
        "limitations": ["CpG rows are anonymous indices; map them to real probes downstream.",
                        "Status mapping uses upstream's ordinal poor..ultrarapid scale; treat ordinal-as-continuous as a modeling assumption.",
                        "Bonferroni is conservative; no population structure, batch, or cell-mixture correction."],
    }


def analyze_xenograft_tumor_growth_inhibition(arguments):
    """TGI with per-subject slopes, two-way ANOVA, and Tukey HSD (studentized range)."""
    records = arguments.get("measurements")
    if not isinstance(records, list) or not 4 <= len(records) <= 5000:
        raise ValueError("measurements must contain 4 to 5000 entries.")
    parsed = []
    for index, record in enumerate(records):
        if not isinstance(record, dict) or set(record) != {"subject", "group", "day", "volume"}:
            raise ValueError(f"measurements[{index}] must contain subject, group, day, and volume.")
        parsed.append({"subject": _string(record["subject"], f"measurements[{index}].subject"),
                       "group": _string(record["group"], f"measurements[{index}].group"),
                       "day": _number(record["day"], "day", minimum=0),
                       "volume": _number(record["volume"], "volume", minimum=0)})
    control = _string(arguments.get("control_group"), "control_group")
    import numpy as np
    from scipy import stats

    groups = sorted({record["group"] for record in parsed})
    if control not in groups:
        raise ValueError(f"control_group {control!r} not among the measurement groups.")
    subjects = sorted({record["subject"] for record in parsed})
    days = sorted({record["day"] for record in parsed})
    series = {}
    for record in parsed:
        series.setdefault((record["group"], record["day"]), []).append(record["volume"])
    group_stats = {group: {day: {"mean": float(np.mean(series[(group, day)])),
                                 "sem": float(stats.sem(series[(group, day)])) if len(series[(group, day)]) > 1 else 0.0,
                                 "n": len(series[(group, day)])}
                          for day in days if (group, day) in series} for group in groups}
    growth_rates = {}
    for group in groups:
        rates = []
        for subject in {record["subject"] for record in parsed if record["group"] == group}:
            subject_points = sorted((record["day"], record["volume"]) for record in parsed if record["subject"] == subject)
            if len(subject_points) >= 2:
                x = np.asarray([point[0] for point in subject_points])
                y = np.asarray([point[1] for point in subject_points])
                slope = float(stats.linregress(x, y).slope)
                rates.append(slope)
        growth_rates[group] = {"mean": round(float(np.mean(rates)), 8) if rates else None,
                               "sem": round(float(stats.sem(rates)), 8) if len(rates) > 1 else None,
                               "n": len(rates)}
    final_day = max(days)
    control_final = float(np.mean(series[(control, final_day)]))
    tgi = {}
    for group in groups:
        if group == control:
            continue
        group_final = float(np.mean(series[(group, final_day)]))
        tgi[group] = round((control_final - group_final) / control_final * 100, 6) if control_final else None
    # Two-way ANOVA (group, day, interaction) via cell-means sums of squares.
    grand_mean = float(np.mean([record["volume"] for record in parsed]))
    group_sizes = {group: len([r for r in parsed if r["group"] == group]) for group in groups}
    ss_group = sum(group_sizes[group] * (np.mean([r["volume"] for r in parsed if r["group"] == group]) - grand_mean) ** 2 for group in groups)
    day_sizes = {day: len([r for r in parsed if r["day"] == day]) for day in days}
    ss_day = sum(day_sizes[day] * (np.mean([r["volume"] for r in parsed if r["day"] == day]) - grand_mean) ** 2 for day in days)
    cell_means = {key: float(np.mean(values)) for key, values in series.items()}
    ss_cells = sum(len(values) * (cell_means[key] - np.mean([r["volume"] for r in parsed if r["group"] == key[0]]) -
                                  np.mean([r["volume"] for r in parsed if r["day"] == key[1]]) + grand_mean) ** 2
                   for key, values in series.items())
    ss_error = sum((record["volume"] - cell_means[(record["group"], record["day"])]) ** 2 for record in parsed)
    df_group, df_day, df_interaction = len(groups) - 1, len(days) - 1, (len(groups) - 1) * (len(days) - 1)
    df_error = len(parsed) - len(groups) * len(days)
    anova = {}
    if df_error > 0:
        for label, ss, df in (("group", ss_group, df_group), ("day", ss_day, df_day), ("interaction", ss_cells, df_interaction)):
            ms = ss / df if df else 0.0
            ms_error = ss_error / df_error
            f_statistic = ms / ms_error if ms_error > 0 else None
            anova[label] = {"sum_of_squares": round(ss, 8), "df": df, "f_statistic": round(f_statistic, 8) if f_statistic is not None else None,
                            "p_value": float(stats.f.sf(f_statistic, df, df_error)) if f_statistic is not None else None}
    # Tukey HSD at the final time point via the studentized range distribution.
    final_values, final_labels = [], []
    for record in parsed:
        if record["day"] == final_day:
            final_values.append(record["volume"])
            final_labels.append(record["group"])
    tukey = []
    if len(set(final_labels)) > 1 and len(final_values) > len(set(final_labels)):
        groups_final = {group: np.asarray([value for value, label in zip(final_values, final_labels) if label == group]) for group in set(final_labels)}
        pooled_sd = math.sqrt(sum(((values - values.mean()) ** 2).sum() for values in groups_final.values()) /
                              (len(final_values) - len(groups_final)))
        for first in groups:
            for second in groups:
                if first < second and first in groups_final and second in groups_final:
                    difference = float(groups_final[first].mean() - groups_final[second].mean())
                    harmonic = 2 / (1 / len(groups_final[first]) + 1 / len(groups_final[second]))
                    q = abs(difference) / (pooled_sd / math.sqrt(harmonic)) if pooled_sd > 0 else None
                    p_value = float(stats.studentized_range.sf(q, len(groups_final), df_error)) if q is not None else None
                    tukey.append({"group_1": first, "group_2": second, "mean_difference": round(difference, 8),
                                  "q_statistic": round(q, 8) if q is not None else None,
                                  "adjusted_p_value": p_value})
    best = max((group for group in tgi if tgi[group] is not None), key=lambda group: tgi[group], default=None)
    return {
        "groups": groups, "control_group": control, "time_points": days,
        "group_day_statistics": {group: {str(day): {key: round(value, 6) if isinstance(value, float) else value
                                                    for key, value in stats_.items()}
                                         for day, stats_ in group_stats[group].items()} for group in groups},
        "per_subject_growth_rates": growth_rates, "tumor_growth_inhibition_percent": tgi,
        "two_way_anova": anova, "tukey_hsd_final_day": tukey,
        "best_tgi_group": best,
        "method": "TGI at the final time point, per-subject linear growth slopes, unweighted two-way ANOVA, Tukey HSD via the studentized range distribution",
        "limitations": ["The ANOVA is the classical unweighted two-way decomposition; upstream used a repeated-measures formula with a subject term via statsmodels, which assumes one observation per subject-day cell.",
                        "Tukey HSD assumes balanced, homoscedastic final-day measurements; unbalanced groups are approximated with harmonic sample sizes.",
                        "Tumor volumes must come from a consistent measurement method; no blinding, randomization, or exclusion criteria are evaluated."],
    }


def _schema(properties, required):
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


_NUMBERS_SCHEMA = {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 2000}


def _tool(title, description, schema, example, path, function):
    return {"title": title, "description": description, "input_schema": schema, "example": example,
            "dependency": ["numpy", "scipy"], "implementation": "biomni-adapted",
            "upstream_functions": [{"path": path, "name": function}]}


TOOLS = {
    "grade_adverse_events_using_vcog_ctcae": _tool(
        "VCOG-CTCAE adverse event grading", "Grade veterinary adverse events (v1.1) from numeric bands with severity fallback; supports review, not clinical decisions.",
        _schema({"events": {"type": "array", "minItems": 1, "maxItems": 5000, "items": _schema(
                     {"subject_id": {"type": "string", "minLength": 1, "maxLength": 100},
                      "symptom": {"type": "string", "minLength": 1, "maxLength": 100},
                      "severity": {"type": "string", "enum": ["none", "mild", "moderate", "severe", "life-threatening", "death"]},
                      "measurement": {"type": "number", "minimum": 0, "maximum": 1e100}},
                     ["subject_id", "symptom", "severity"])}}, ["events"]),
        {"events": [{"subject_id": "dog_1", "symptom": "neutropenia", "severity": "severe", "measurement": 420},
                    {"subject_id": "dog_1", "symptom": "vomiting", "severity": "moderate", "measurement": 4},
                    {"subject_id": "dog_2", "symptom": "anemia", "severity": "mild", "measurement": 9.1}]},
        "biomni/tool/pharmacology.py", "grade_adverse_events_using_vcog_ctcae"),
    "analyze_radiolabeled_antibody_biodistribution": _tool(
        "Radiolabeled antibody biodistribution", "Fit per-tissue bi-exponential pharmacokinetics and tumor-to-normal ratios from time-activity data.",
        _schema({"time_points_hours": {"type": "array", "items": {"type": "number"}, "minItems": 4, "maxItems": 100},
                 "tissue_data": {"type": "array", "minItems": 1, "maxItems": 50, "items": _schema(
                     {"tissue": {"type": "string", "minLength": 1, "maxLength": 100},
                      "values": {"type": "array", "items": {"type": "number"}, "minItems": 4, "maxItems": 100}}, ["tissue", "values"])}},
                ["time_points_hours", "tissue_data"]),
        {"time_points_hours": [1, 4, 24, 48, 72, 96],
         "tissue_data": [{"tissue": "blood", "values": [80, 60, 30, 16, 9, 5]},
                         {"tissue": "liver", "values": [25, 22, 14, 8, 5, 3]},
                         {"tissue": "tumor", "values": [12, 15, 12, 8, 6, 4]}]},
        "biomni/tool/pharmacology.py", "analyze_radiolabeled_antibody_biodistribution"),
    "estimate_alpha_particle_radiotherapy_dosimetry": _tool(
        "Alpha-particle MIRD dosimetry", "Estimate organ absorbed doses from decay-corrected cumulated activities and S-factors under the MIRD schema.",
        _schema({"half_life_hours": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e6},
                 "radiation_weighting_factor": {"type": "number", "exclusiveMinimum": 0, "maximum": 100, "default": 5},
                 "biodistribution": {"type": "array", "minItems": 1, "maxItems": 50, "items": _schema(
                     {"organ": {"type": "string", "minLength": 1, "maxLength": 100},
                      "measurements": {"type": "array", "minItems": 2, "maxItems": 200, "items": _schema(
                          {"time_hours": {"type": "number", "minimum": 0},
                           "activity_percent_injected": {"type": "number", "minimum": 0}}, ["time_hours", "activity_percent_injected"])}},
                     ["organ", "measurements"])},
                 "s_factors": {"type": "array", "minItems": 1, "maxItems": 500, "items": _schema(
                     {"source": {"type": "string", "minLength": 1, "maxLength": 100},
                      "target": {"type": "string", "minLength": 1, "maxLength": 100},
                      "s_value": {"type": "number", "exclusiveMinimum": 0}}, ["source", "target", "s_value"])}},
                ["half_life_hours", "biodistribution", "s_factors"]),
        {"half_life_hours": 163, "radiation_weighting_factor": 5,
         "biodistribution": [{"organ": "tumor", "measurements": [{"time_hours": 1, "activity_percent_injected": 12},
                                                                  {"time_hours": 24, "activity_percent_injected": 9},
                                                                  {"time_hours": 72, "activity_percent_injected": 4}]},
                             {"organ": "liver", "measurements": [{"time_hours": 1, "activity_percent_injected": 20},
                                                                  {"time_hours": 24, "activity_percent_injected": 12},
                                                                  {"time_hours": 72, "activity_percent_injected": 3}]}],
         "s_factors": [{"source": "tumor", "target": "tumor", "s_value": 2.0},
                       {"source": "liver", "target": "liver", "s_value": 0.8},
                       {"source": "liver", "target": "tumor", "s_value": 0.05}]},
        "biomni/tool/pharmacology.py", "estimate_alpha_particle_radiotherapy_dosimetry"),
    "perform_mwas_cyp2c19_metabolizer_status": _tool(
        "MWAS metabolizer association", "Test each methylation row for association with CYP2C19 metabolizer status by multiple regression with Bonferroni correction.",
        _schema({"sample_ids": {"type": "array", "items": {"type": "string", "minLength": 1, "maxLength": 100}, "minItems": 3, "maxItems": 500},
                 "metabolizer_status": {"type": "array", "minItems": 3, "maxItems": 500,
                                        "items": {"type": "number", "minimum": -1e100, "maximum": 1e100}},
                 "methylation_matrix": {"type": "array", "minItems": 1, "maxItems": 200, "items": _NUMBERS_SCHEMA},
                 "covariates": {"type": "array", "minItems": 1, "maxItems": 20, "items": _schema(
                     {"name": {"type": "string", "minLength": 1, "maxLength": 100}, "values": _NUMBERS_SCHEMA}, ["name", "values"])},
                 "pvalue_threshold": {"type": "number", "minimum": 1e-12, "maximum": 1, "default": 0.05}},
                ["sample_ids", "metabolizer_status", "methylation_matrix"]),
        {"sample_ids": ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"],
         "metabolizer_status": [1, 1, 2, 2, 3, 3, 4, 4],
         "methylation_matrix": [[0.9, 0.85, 0.6, 0.58, 0.3, 0.28, 0.15, 0.12],
                                [0.4, 0.42, 0.45, 0.44, 0.4, 0.41, 0.39, 0.4]],
         "pvalue_threshold": 0.05},
        "biomni/tool/pharmacology.py", "perform_mwas_cyp2c19_metabolizer_status"),
    "analyze_xenograft_tumor_growth_inhibition": _tool(
        "Xenograft TGI analysis", "Summarize tumor growth curves with TGI, per-subject growth slopes, two-way ANOVA, and final-day Tukey HSD.",
        _schema({"measurements": {"type": "array", "minItems": 4, "maxItems": 5000, "items": _schema(
                     {"subject": {"type": "string", "minLength": 1, "maxLength": 100},
                      "group": {"type": "string", "minLength": 1, "maxLength": 100},
                      "day": {"type": "number", "minimum": 0, "maximum": 1e6},
                      "volume": {"type": "number", "minimum": 0, "maximum": 1e9}}, ["subject", "group", "day", "volume"])},
                 "control_group": {"type": "string", "minLength": 1, "maxLength": 100}}, ["measurements", "control_group"]),
        {"measurements": [
            {"subject": "c1", "group": "control", "day": 0, "volume": 100}, {"subject": "c1", "group": "control", "day": 10, "volume": 480},
            {"subject": "c2", "group": "control", "day": 0, "volume": 110}, {"subject": "c2", "group": "control", "day": 10, "volume": 520},
            {"subject": "c3", "group": "control", "day": 0, "volume": 95}, {"subject": "c3", "group": "control", "day": 10, "volume": 450},
            {"subject": "t1", "group": "treated", "day": 0, "volume": 105}, {"subject": "t1", "group": "treated", "day": 10, "volume": 210},
            {"subject": "t2", "group": "treated", "day": 0, "volume": 100}, {"subject": "t2", "group": "treated", "day": 10, "volume": 195},
            {"subject": "t3", "group": "treated", "day": 0, "volume": 108}, {"subject": "t3", "group": "treated", "day": 10, "volume": 220}],
         "control_group": "control"},
        "biomni/tool/pharmacology.py", "analyze_xenograft_tumor_growth_inhibition"),
}
HANDLERS = {name: globals()[name] for name in TOOLS}
