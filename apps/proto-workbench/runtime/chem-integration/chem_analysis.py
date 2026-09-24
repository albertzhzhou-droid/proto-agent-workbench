"""Bounded local analytical chemistry operators using NumPy and SciPy.

The public operator functions accept JSON-compatible dictionaries and return JSON
results. No supplied code, file path, instrument command or network is executed.
Methods and upstream references are documented in docs/chem-analysis-methods.md.
"""
from __future__ import annotations

import math
from functools import wraps
from typing import Any


class AnalysisError(ValueError):
    def __init__(self, code: str, message: str, details: Any = None):
        super().__init__(message)
        self.code, self.details = code, details


def fail(message: str, code: str = "INVALID_INPUT") -> None:
    raise AnalysisError(code, message)


def obj(value: Any, name: str, allowed: set[str]) -> dict:
    if not isinstance(value, dict) or set(value) - allowed:
        fail(f"{name} must be an object containing only: {', '.join(sorted(allowed))}")
    return value


def number(value: Any, name: str, low: float = -1e12, high: float = 1e12) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        fail(f"{name} must be a finite number between {low:g} and {high:g}")
    return float(value)


def integer(value: Any, name: str, low: int, high: int) -> int:
    if type(value) is not int or not low <= value <= high:
        fail(f"{name} must be an integer between {low} and {high}")
    return value


def text(value: Any, name: str, limit: int = 160) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        fail(f"{name} must be nonempty text of at most {limit} characters")
    return value.strip()


def choice(value: Any, name: str, options: tuple[str, ...]) -> str:
    if value not in options:
        fail(f"{name} must be one of {', '.join(options)}")
    return value


def array(value: Any, name: str, minimum: int = 1, maximum: int = 10000) -> list:
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        fail(f"{name} must contain {minimum}–{maximum} entries")
    return value


def vector(value: Any, name: str, minimum: int = 1, maximum: int = 10000) -> list[float]:
    return [number(item, f"{name}[{index}]") for index, item in enumerate(array(value, name, minimum, maximum))]


def confidence(data: dict) -> float:
    return number(data.get("confidence", .95), "confidence", .5, .999)


def series(key: str, label: str, x: list, y: list, style: str = "line") -> dict:
    return {"id": key, "label": label, "x": x, "y": y, "style": style}


def visual(x_label: str, x_unit: str, y_label: str, y_unit: str, values: list) -> dict:
    return {"x_label": x_label, "x_unit": x_unit, "y_label": y_label, "y_unit": y_unit, "series": values}


def finite_result(function):
    """Keep numerical overflow an explicit operator error, never JSON NaN/Infinity."""
    @wraps(function)
    def checked(data):
        result = function(data)
        def visit(value):
            if isinstance(value, float) and not math.isfinite(value):
                fail("Calculation exceeded floating-point precision; rescale the supplied numerical units", "NUMERICAL_RANGE")
            elif isinstance(value, dict):
                for child in value.values():
                    visit(child)
            elif isinstance(value, (list, tuple)):
                for child in value:
                    visit(child)
        visit(result)
        return result
    return checked


def _summary(values: list[float], level: float) -> dict:
    import numpy as np
    from scipy.stats import t
    count = len(values)
    if not count:
        return dict(n=0, mean=None, sd=None, rsd_percent=None, sem=None, ci_low=None, ci_high=None, minimum=None, maximum=None)
    average = float(np.mean(values))
    sd = float(np.std(values, ddof=1)) if count > 1 else None
    sem = sd / math.sqrt(count) if sd is not None else None
    margin = float(t.ppf((1 + level) / 2, count - 1)) * sem if sem is not None else None
    return dict(n=count, mean=average, sd=sd, rsd_percent=100 * sd / abs(average) if sd is not None and average != 0 else None,
                sem=sem, ci_low=average - margin if margin is not None else None, ci_high=average + margin if margin is not None else None,
                minimum=min(values), maximum=max(values))


@finite_result
def summarize_replicates(data: dict) -> dict:
    obj(data, "input", {"groups", "unit", "confidence", "missing"})
    unit, level = text(data.get("unit"), "unit"), confidence(data)
    missing = choice(data.get("missing", "error"), "missing", ("error", "omit"))
    groups, rows, plots, warnings, labels = array(data.get("groups"), "groups", 1, 32), [], [], [], set()
    for index, raw in enumerate(groups):
        group = obj(raw, f"groups[{index}]", {"label", "values"})
        label = text(group.get("label"), "group label")
        if label in labels:
            fail("Group labels must be unique")
        labels.add(label)
        supplied = array(group.get("values"), label, 1, 10000)
        if any(value is None for value in supplied) and missing == "error":
            fail(f"{label} contains null; explicitly select missing='omit' to exclude it", "MISSING_VALUES")
        values = [number(value, label) for value in supplied if value is not None]
        summary = _summary(values, level)
        rows.append({"label": label, "unit": unit, "n_supplied": len(supplied), "n_missing": len(supplied) - len(values), **summary})
        plots.append(series(f"group-{index}", label, list(range(1, len(supplied) + 1)), [None if v is None else float(v) for v in supplied], "points"))
        if len(values) < 2:
            warnings.append(f"{label}: fewer than two observations; sample SD, SEM and confidence interval are unavailable.")
        if summary["mean"] == 0:
            warnings.append(f"{label}: RSD is undefined because the mean is zero.")
        if len(values) != len(supplied):
            warnings.append(f"{label}: {len(supplied) - len(values)} explicit null observations omitted; no imputation.")
    return {"rows": rows, "confidence": level, "missing_policy": missing,
            "method": "Sample SD (n−1), SEM = SD/sqrt(n), two-sided Student t interval for the mean; RSD = 100 SD/abs(mean).",
            "assumptions": ["Replicates within a group are independent and share the declared unit.", "Small-sample t intervals assume approximately normal measurement errors. No automatic outlier removal."],
            "warnings": warnings, "visualization": visual("Replicate", "index", "Measured value", unit, plots)}


@finite_result
def compare_assay_groups(data: dict) -> dict:
    import numpy as np
    from scipy.stats import t
    obj(data, "input", {"group_a", "group_b", "label_a", "label_b", "unit", "method", "confidence"})
    a, b = vector(data.get("group_a"), "group_a", 2), vector(data.get("group_b"), "group_b", 2)
    label_a, label_b = text(data.get("label_a", "A"), "label_a"), text(data.get("label_b", "B"), "label_b")
    unit, level = text(data.get("unit"), "unit"), confidence(data)
    method = choice(data.get("method", "welch"), "method", ("welch", "paired"))
    if method == "paired" and len(a) != len(b):
        fail("Paired observations must have exactly equal lengths and matching row order", "PAIRING_MISMATCH")
    average_a, average_b = float(np.mean(a)), float(np.mean(b))
    difference = average_a - average_b
    if method == "paired":
        differences = np.asarray(a) - np.asarray(b)
        difference = float(np.mean(differences))
        denominator = float(np.std(differences, ddof=1))
        se = denominator / math.sqrt(len(a))
        df = float(len(a) - 1)
        effect_name = "Cohen dz (mean paired difference / sample SD of paired differences)"
        assumption = "Row i in A is explicitly paired with row i in B; pairs are independent and paired differences approximately normal."
    else:
        va, vb = float(np.var(a, ddof=1)), float(np.var(b, ddof=1))
        aa, bb = va / len(a), vb / len(b)
        se = math.sqrt(aa + bb)
        df = (aa + bb)**2 / (aa**2 / (len(a) - 1) + bb**2 / (len(b) - 1)) if aa + bb > 0 else None
        denominator = math.sqrt(((len(a)-1)*va + (len(b)-1)*vb) / (len(a)+len(b)-2))
        effect_name = "Cohen d (mean difference / pooled sample SD; descriptive effect, independent of Welch SE)"
        assumption = "The two groups and observations within them are independent; measurement errors are approximately normal. Equal variances are not required."
    warnings = []
    if se > 0:
        statistic = difference / se
        p_value = float(2 * t.sf(abs(statistic), df))
        margin = float(t.ppf((1 + level)/2, df)) * se
        low, high = difference - margin, difference + margin
    else:
        statistic = p_value = low = high = None
        warnings.append("Observed variance gives zero standard error; a t test and inferential interval are undefined. No infinite statistic or fabricated significance is returned.")
    effect = difference / denominator if denominator > 0 else None
    if effect is None:
        warnings.append("Standardized effect is undefined because its reference sample SD is zero.")
    if method == "welch":
        warnings.append("Cohen d uses a pooled descriptive scale; it is not an equal-variance assumption for the Welch test.")
    comparison = {"comparison": f"{label_a} − {label_b}", "unit": unit, "method": method, "n_a": len(a), "n_b": len(b),
                  "mean_difference": difference, "standard_error": se, "degrees_of_freedom": df, "t_statistic": statistic,
                  "p_value_two_sided": p_value, "ci_low": low, "ci_high": high, "standardized_effect": effect}
    return {"rows": [comparison], "groups": [{"label": label_a, **_summary(a, level)}, {"label": label_b, **_summary(b, level)}],
            "confidence": level, "effect_definition": effect_name, "method": "Two-sided paired t test" if method == "paired" else "Two-sided Welch–Satterthwaite t test",
            "assumptions": [assumption, "Difference and confidence interval are A minus B. A p-value does not measure effect size or establish equivalence; no multiple-comparison correction is applied."],
            "warnings": warnings, "visualization": visual("Observation", "index", "Assay response", unit, [series("a", label_a, list(range(1, len(a)+1)), a, "points"), series("b", label_b, list(range(1, len(b)+1)), b, "points")])}


@finite_result
def fit_calibration_curve(data: dict) -> dict:
    import numpy as np
    from scipy.stats import t
    obj(data, "input", {"concentrations", "responses", "weights", "concentration_unit", "response_unit", "unknowns", "confidence"})
    x, y = np.asarray(vector(data.get("concentrations"), "concentrations", 3, 1000)), np.asarray(vector(data.get("responses"), "responses", 3, 1000))
    if len(x) != len(y):
        fail("Concentrations and responses must have equal lengths")
    if len(set(x)) < 2:
        fail("At least two distinct standard concentrations are required", "SINGULAR_CALIBRATION")
    unit_x, unit_y, level = text(data.get("concentration_unit"), "concentration_unit"), text(data.get("response_unit"), "response_unit"), confidence(data)
    weighted = "weights" in data
    weights = np.asarray(vector(data["weights"], "weights", 3, 1000)) if weighted else np.ones(len(x))
    if len(weights) != len(x) or any(w <= 0 for w in weights):
        fail("Weights must contain one strictly positive relative inverse-variance weight per standard")
    weights = weights / float(np.max(weights))
    center, scale = float(np.mean(x)), float(np.ptp(x))
    design = np.column_stack([np.ones(len(x)), (x - center) / scale])
    weighted_design, weighted_y = design * np.sqrt(weights[:, None]), y * np.sqrt(weights)
    beta, _, rank, _ = np.linalg.lstsq(weighted_design, weighted_y, rcond=None)
    if rank < 2:
        fail("The weighted calibration design is numerically singular", "SINGULAR_CALIBRATION")
    slope, intercept = float(beta[1]/scale), float(beta[0] - beta[1]*center/scale)
    fitted = design @ beta
    residuals, df = y-fitted, len(x)-2
    rss = float(np.sum(weights * residuals**2))
    sigma_squared = rss/df
    transform = np.asarray([[1, -center/scale], [0, 1/scale]])
    covariance = transform @ (sigma_squared*np.linalg.inv(weighted_design.T @ weighted_design)) @ transform.T
    standard_errors = np.sqrt(np.maximum(np.diag(covariance), 0))
    critical = float(t.ppf((1+level)/2, df))
    weighted_mean = float(np.average(y, weights=weights))
    total = float(np.sum(weights * (y-weighted_mean)**2))
    rows = [{"standard": i+1, "concentration": float(xi), "response": float(yi), "fitted_response": float(fi), "residual": float(ri), "relative_weight": float(wi)} for i, (xi, yi, fi, ri, wi) in enumerate(zip(x, y, fitted, residuals, weights))]
    warnings = ["The concentration axis is treated as known. Input units are labels and are never converted automatically.", "Inverse estimates are point estimates; uncertainty from dilution, standard preparation and unknown response is not propagated."]
    unknowns = []
    raw_unknowns = data.get("unknowns", [])
    array(raw_unknowns, "unknowns", 0, 256)
    nearly_flat = abs(slope)*scale <= 1e-12 * max(float(np.max(np.abs(y))), 1e-12)
    if nearly_flat:
        warnings.append("The fitted response is effectively flat; inverse concentration estimates are unavailable.")
    for i, raw in enumerate(raw_unknowns):
        sample = obj(raw, f"unknowns[{i}]", {"label", "response", "dilution_factor"})
        label, response = text(sample.get("label", f"Unknown {i+1}"), "unknown label"), number(sample.get("response"), "unknown response")
        dilution = number(sample.get("dilution_factor", 1), "dilution_factor", 1e-12, 1e12)
        estimate = None if nearly_flat else center + (response-float(beta[0]))/slope
        extrapolated = estimate is not None and not float(min(x)) <= estimate <= float(max(x))
        unknowns.append({"label": label, "response": response, "dilution_factor": dilution, "measured_concentration": estimate, "original_concentration": None if estimate is None else estimate*dilution, "concentration_unit": unit_x, "extrapolated": extrapolated})
        if extrapolated:
            warnings.append(f"{label}: inverse estimate lies outside the supplied standard concentration range; extrapolation.")
        if estimate is not None and estimate < 0:
            warnings.append(f"{label}: negative inverse estimate preserved; assess the blank and calibration range before chemical interpretation.")
    if weighted:
        warnings.append("Weights are treated as relative inverse response variances; coefficient covariance estimates the common residual scale.")
    coefficients = [{"term": "intercept", "estimate": intercept, "standard_error": float(standard_errors[0]), "ci_low": intercept-critical*float(standard_errors[0]), "ci_high": intercept+critical*float(standard_errors[0])},
                    {"term": "slope", "estimate": slope, "standard_error": float(standard_errors[1]), "ci_low": slope-critical*float(standard_errors[1]), "ci_high": slope+critical*float(standard_errors[1])}]
    plot_x = np.linspace(float(min(x)), float(max(x)), 101)
    return {"rows": rows, "coefficients": coefficients, "unknowns": unknowns, "confidence": level,
            "fit": {"slope": slope, "intercept": intercept, "r_squared": 1-rss/total if total > 0 else None, "residual_rmse": float(np.sqrt(np.mean(residuals**2))), "weighted_residual_sum_squares": rss, "degrees_of_freedom": df, "concentration_min": float(min(x)), "concentration_max": float(max(x)), "concentration_unit": unit_x, "response_unit": unit_y},
            "method": "Weighted linear least squares with intercept" if weighted else "Ordinary linear least squares with intercept",
            "assumptions": ["Response is linear over the calibration range, errors are independent, and supplied weights reflect relative precision.", "Coefficient t intervals additionally assume Gaussian response errors. R-squared alone does not validate a calibration."],
            "warnings": warnings, "visualization": visual("Concentration", unit_x, "Response", unit_y, [series("standards", "Standards", x.tolist(), y.tolist(), "points"), series("fit", "Calibration fit", plot_x.tolist(), (beta[0]+beta[1]*(plot_x-center)/scale).tolist())]),
            "residual_visualization": visual("Concentration", unit_x, "Observed − fitted response", unit_y, [series("residuals", "Residuals", x.tolist(), residuals.tolist(), "points")])}


@finite_result
def analyze_spectrum(data: dict) -> dict:
    import numpy as np
    from scipy.signal import find_peaks, peak_widths, savgol_filter
    obj(data, "input", {"x", "y", "x_label", "x_unit", "y_label", "y_unit", "baseline", "smooth_window", "polynomial_order", "prominence", "distance_points", "polarity", "regions"})
    x, raw_y = np.asarray(vector(data.get("x"), "x", 3)), np.asarray(vector(data.get("y"), "y", 3))
    if len(x) != len(raw_y):
        fail("Spectral x and y arrays must have equal lengths")
    x_label, x_unit = text(data.get("x_label"), "x_label"), text(data.get("x_unit"), "x_unit")
    y_label, y_unit = text(data.get("y_label"), "y_label"), text(data.get("y_unit"), "y_unit")
    warnings = []
    if np.all(np.diff(x) < 0):
        x, raw_y = x[::-1], raw_y[::-1]
        warnings.append("Descending input axis reversed with its response values; all integrals use increasing x.")
    elif not np.all(np.diff(x) > 0):
        fail("Spectral x must be strictly increasing or decreasing, without duplicates", "INVALID_AXIS")
    baseline = choice(data.get("baseline", "none"), "baseline", ("none", "linear_endpoints"))
    window = integer(data.get("smooth_window", 0), "smooth_window", 0, 501)
    order = integer(data.get("polynomial_order", 2), "polynomial_order", 0, 8)
    smooth = raw_y.copy()
    if window:
        if window < 3 or window % 2 == 0 or window > len(x) or order >= window:
            fail("Savitzky–Golay window must be odd, at least 3, no longer than the data, and exceed polynomial_order")
        delta = np.diff(x)
        if not np.allclose(delta, delta[0], rtol=1e-5, atol=max(abs(float(delta[0]))*1e-8, 1e-14)):
            fail("Savitzky–Golay smoothing requires uniformly spaced x values; no implicit resampling is performed", "NONUNIFORM_SMOOTHING")
        smooth = savgol_filter(raw_y, window, order, mode="interp")
    baseline_y = np.linspace(float(smooth[0]), float(smooth[-1]), len(x)) if baseline == "linear_endpoints" else np.zeros(len(x))
    if baseline == "linear_endpoints":
        # On nonuniform axes an endpoint line must follow x, not sample index.
        baseline_y = smooth[0] + (smooth[-1]-smooth[0])*(x-x[0])/(x[-1]-x[0])
        warnings.append("Endpoint baseline assumes both endpoints represent background; inspect this assumption before interpreting areas.")
    corrected = smooth-baseline_y
    prominence = number(data.get("prominence", 0), "prominence", 0, 1e12)
    distance = integer(data.get("distance_points", 1), "distance_points", 1, 10000)
    polarity = choice(data.get("polarity", "positive"), "polarity", ("positive", "negative"))
    sign = 1 if polarity == "positive" else -1
    indices, properties = find_peaks(sign*corrected, prominence=prominence, distance=distance)
    widths = peak_widths(sign*corrected, indices, rel_height=.5) if len(indices) else [[], [], [], []]
    peaks = []
    for i, peak in enumerate(indices):
        left, right = float(np.interp(widths[2][i], np.arange(len(x)), x)), float(np.interp(widths[3][i], np.arange(len(x)), x))
        peaks.append({"peak": i+1, "sample_index": int(peak), "x": float(x[peak]), "height": float(corrected[peak]), "prominence": float(properties["prominences"][i]), "half_prominence_width": right-left, "left_half_prominence_x": left, "right_half_prominence_x": right, "polarity": polarity})
    integrations = []
    for i, raw in enumerate(array(data.get("regions", []), "regions", 0, 64)):
        region = obj(raw, f"regions[{i}]", {"label", "start", "end"})
        start, end = number(region.get("start"), "region start"), number(region.get("end"), "region end")
        if not float(x[0]) <= start < end <= float(x[-1]):
            fail("Each integration region must satisfy axis minimum <= start < end <= axis maximum", "INVALID_REGION")
        inside = x[(x>start) & (x<end)]
        rx = np.concatenate([[start], inside, [end]])
        ry = np.interp(rx, x, corrected)
        integrations.append({"label": text(region.get("label", f"Region {i+1}"), "region label"), "start": start, "end": end,
                             "area": float(np.trapezoid(ry, rx)), "area_unit": f"({y_unit})·({x_unit})"})
    warnings.append("Peaks are signal features, without chemical identity assignment. Half-prominence width is not generally FWHM; overlapping peaks are not deconvolved.")
    rows = [{"x": float(xi), "raw": float(yi), "smoothed": float(si), "baseline": float(bi), "corrected": float(ci)} for xi, yi, si, bi, ci in zip(x, raw_y, smooth, baseline_y, corrected)]
    return {"rows": rows, "peaks": peaks, "integrations": integrations, "total_area": float(np.trapezoid(corrected, x)), "area_unit": f"({y_unit})·({x_unit})",
            "method": {"smoothing": "Savitzky–Golay" if window else "none", "smooth_window": window, "polynomial_order": order if window else None, "baseline": baseline, "peak_detection": "SciPy local extrema with prominence and sample-distance constraints", "integration": "Trapezoidal integration with linear interpolation at region boundaries", "polarity": polarity},
            "warnings": warnings, "visualization": visual(x_label, x_unit, y_label, y_unit, [series("raw", "Original signal", x.tolist(), raw_y.tolist()), series("corrected", "Processed signal", x.tolist(), corrected.tolist()), series("peaks", "Detected peaks", [p["x"] for p in peaks], [p["height"] for p in peaks], "points")])}


@finite_result
def chemical_pca(data: dict) -> dict:
    import numpy as np
    obj(data, "input", {"columns", "samples", "autoscale", "components"})
    columns = [text(value, "column") for value in array(data.get("columns"), "columns", 2, 128)]
    if len(columns) != len(set(columns)):
        fail("PCA feature names must be unique")
    samples, ids, matrix = array(data.get("samples"), "samples", 3, 500), [], []
    for i, raw in enumerate(samples):
        sample = obj(raw, f"samples[{i}]", {"id", "values"})
        ids.append(text(sample.get("id"), "sample id"))
        values = vector(sample.get("values"), "sample values", 2, 128)
        if len(values) != len(columns):
            fail("Every PCA sample must contain exactly one numeric value per column; missing values are not imputed")
        matrix.append(values)
    if len(ids) != len(set(ids)):
        fail("PCA sample IDs must be unique")
    autoscale = data.get("autoscale", True)
    if type(autoscale) is not bool:
        fail("autoscale must be a boolean")
    values = np.asarray(matrix)
    means, deviations = np.mean(values, axis=0), np.std(values, ddof=1, axis=0)
    threshold = np.finfo(float).eps * np.maximum(np.max(np.abs(values), axis=0), 1e-300) * 8
    retained = deviations > threshold
    dropped = [columns[i] for i in range(len(columns)) if not retained[i]]
    if sum(retained) < 2:
        fail("PCA requires at least two nonconstant numeric features", "INSUFFICIENT_VARIATION")
    components = integer(data.get("components", 2), "components", 1, min(len(values)-1, int(sum(retained))))
    scales = deviations[retained] if autoscale else np.ones(int(sum(retained)))
    processed = (values[:, retained]-means[retained])/scales
    _, singular, vt = np.linalg.svd(processed, full_matrices=False)
    # Fix sign ambiguity so saved results and plotted sample positions reproduce.
    for component in range(len(vt)):
        maximum = int(np.argmax(np.abs(vt[component])))
        if vt[component, maximum] < 0:
            vt[component] *= -1
    scores, loadings = processed @ vt[:components].T, vt[:components].T
    variances = singular**2/(len(values)-1)
    ratios = variances/float(np.sum(variances))
    rows = [{"sample": name, **{f"PC{j+1}": float(scores[i, j]) for j in range(components)}} for i, name in enumerate(ids)]
    active_columns = [columns[i] for i in range(len(columns)) if retained[i]]
    load_rows = [{"feature": name, **{f"PC{j+1}": float(loadings[i, j]) for j in range(components)}} for i, name in enumerate(active_columns)]
    explained = [{"component": f"PC{i+1}", "variance": float(variances[i]), "explained_variance_ratio": float(ratios[i]), "cumulative_ratio": float(np.sum(ratios[:i+1]))} for i in range(components)]
    reconstruction = scores @ vt[:components]
    residual = float(np.sqrt(np.mean((processed-reconstruction)**2)))
    warnings = ["PCA is unsupervised and descriptive; separation does not prove chemical identity, mechanism or significance.", "Loadings are orthonormal eigenvectors, not variable-score correlations. Signs are fixed by the largest absolute loading; tied eigenspaces may rotate."]
    if dropped:
        warnings.append("Constant or numerically unresolved features excluded: " + ", ".join(dropped))
    if not autoscale:
        warnings.append("Autoscaling is disabled: features with larger numerical variance dominate, so mixed units require particular care.")
    if components == 1:
        plot = visual("Sample", "index", "PC1 score", "standardized" if autoscale else "input scale", [series("scores", "Sample scores", list(range(1, len(ids)+1)), scores[:, 0].tolist(), "points")])
    else:
        plot = visual("PC1 score", "standardized" if autoscale else "input scale", "PC2 score", "standardized" if autoscale else "input scale", [series("scores", "Sample scores", scores[:, 0].tolist(), scores[:, 1].tolist(), "points")])
    return {"rows": rows, "loadings": load_rows, "explained_variance": explained, "dropped_columns": dropped,
            "preprocessing": [{"feature": column, "mean": float(means[i]), "sample_sd": float(deviations[i]), "retained": bool(retained[i]), "scale": float(deviations[i]) if autoscale and retained[i] else (1.0 if retained[i] else None)} for i, column in enumerate(columns)],
            "reconstruction_rmse_processed": residual, "method": "Centered NumPy SVD; optional autoscaling by sample SD (n−1); no imputation or whitening",
            "warnings": warnings, "visualization": plot, "scree_visualization": visual("Principal component", "index", "Explained variance", "fraction", [series("variance", "Explained variance", list(range(1, len(variances)+1)), ratios.tolist(), "points")])}


OPERATORS = {"summarize_replicates": summarize_replicates, "compare_assay_groups": compare_assay_groups,
             "fit_calibration_curve": fit_calibration_curve, "analyze_spectrum": analyze_spectrum, "chemical_pca": chemical_pca}


def operator_specs() -> list[tuple]:
    def schema(properties: dict, required: tuple = ()) -> dict:
        return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}
    text_schema = {"type": "string", "minLength": 1, "maxLength": 160}
    num = {"type": "number", "minimum": -1e12, "maximum": 1e12}
    def vec(minimum=1, maximum=10000, nullable=False):
        return {"type": "array", "items": {"anyOf": [num, {"type": "null"}]} if nullable else num, "minItems": minimum, "maxItems": maximum}
    level = {"type": "number", "minimum": .5, "maximum": .999, "default": .95}
    sample = schema({"label": text_schema, "values": vec(nullable=True)}, ("label", "values"))
    return [
        ("summarize_replicates", "Replicate precision and uncertainty", "statistics", "Summarize analytical replicates with sample SD, RSD, SEM and a Student t interval; explicit missing-value handling.",
         schema({"groups": {"type": "array", "items": sample, "minItems": 1, "maxItems": 32}, "unit": text_schema, "confidence": level, "missing": {"type": "string", "enum": ["error", "omit"], "default": "error"}}, ("groups", "unit")),
         {"groups": [{"label": "Assay A", "values": [10.1, 9.9, 10.2, 10.0, 9.8]}, {"label": "Assay B", "values": [10.5, 10.4, 10.6, 10.3, 10.5]}], "unit": "mg/L", "confidence": .95, "missing": "error"}, "NumPy / SciPy", ["numpy", "scipy"]),
        ("compare_assay_groups", "Compare assay groups", "statistics", "Welch or explicitly paired two-sided t test, mean-difference confidence interval and defined standardized effect.",
         schema({"group_a": vec(2), "group_b": vec(2), "label_a": text_schema, "label_b": text_schema, "unit": text_schema, "method": {"type": "string", "enum": ["welch", "paired"]}, "confidence": level}, ("group_a", "group_b", "unit")),
         {"group_a": [10.1, 9.9, 10.2, 10.0, 9.8], "group_b": [10.5, 10.4, 10.6, 10.3, 10.5], "label_a": "Assay A", "label_b": "Assay B", "unit": "mg/L", "method": "welch", "confidence": .95}, "SciPy statistical methods / NumPy", ["numpy", "scipy"]),
        ("fit_calibration_curve", "Analytical calibration curve", "analysis", "Fit concentration-response standards using OLS or explicit inverse-variance weights; inspect residuals and back-calculate diluted unknowns.",
         schema({"concentrations": vec(3, 1000), "responses": vec(3, 1000), "weights": {**vec(3, 1000), "items": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e12}}, "concentration_unit": text_schema, "response_unit": text_schema, "confidence": level,
                 "unknowns": {"type": "array", "maxItems": 256, "items": schema({"label": text_schema, "response": num, "dilution_factor": {"type": "number", "minimum": 1e-12, "maximum": 1e12, "default": 1}}, ("response",))}}, ("concentrations", "responses", "concentration_unit", "response_unit")),
         {"concentrations": [0, 2, 4, 6, 8, 10], "responses": [.012, .174, .329, .491, .65, .811], "concentration_unit": "mg/L", "response_unit": "absorbance", "unknowns": [{"label": "Sample 1", "response": .411, "dilution_factor": 5}], "confidence": .95}, "NumPy least squares / SciPy Student t", ["numpy", "scipy"]),
        ("analyze_spectrum", "Spectrum and chromatogram analysis", "analysis", "Inspect supplied signal axes, optional Savitzky–Golay smoothing and endpoint baseline, peaks and region integrals with units.",
         schema({"x": vec(3), "y": vec(3), "x_label": text_schema, "x_unit": text_schema, "y_label": text_schema, "y_unit": text_schema, "baseline": {"type": "string", "enum": ["none", "linear_endpoints"]}, "smooth_window": {"type": "integer", "minimum": 0, "maximum": 501}, "polynomial_order": {"type": "integer", "minimum": 0, "maximum": 8}, "prominence": {"type": "number", "minimum": 0, "maximum": 1e12}, "distance_points": {"type": "integer", "minimum": 1, "maximum": 10000}, "polarity": {"type": "string", "enum": ["positive", "negative"]},
                 "regions": {"type": "array", "maxItems": 64, "items": schema({"label": text_schema, "start": num, "end": num}, ("start", "end"))}}, ("x", "y", "x_label", "x_unit", "y_label", "y_unit")),
         {"x": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "y": [.1, .12, .3, 1.2, .32, .16, .2, .85, .23, .13, .12], "x_label": "Retention time", "x_unit": "min", "y_label": "Detector response", "y_unit": "mAU", "baseline": "linear_endpoints", "smooth_window": 0, "polynomial_order": 2, "prominence": .15, "distance_points": 1, "polarity": "positive", "regions": [{"label": "Peak region 1", "start": 1, "end": 5}, {"label": "Peak region 2", "start": 5, "end": 9}]}, "SciPy signal / NumPy trapezoidal integration", ["numpy", "scipy"]),
        ("chemical_pca", "Chemical descriptor PCA", "analysis", "Centered PCA of an explicit numeric chemistry table, optional autoscaling, deterministic scores/loadings and variance diagnostics.",
         schema({"columns": {"type": "array", "items": text_schema, "minItems": 2, "maxItems": 128}, "samples": {"type": "array", "minItems": 3, "maxItems": 500, "items": schema({"id": text_schema, "values": vec(2, 128)}, ("id", "values"))}, "autoscale": {"type": "boolean", "default": True}, "components": {"type": "integer", "minimum": 1, "maximum": 128, "default": 2}}, ("columns", "samples")),
         {"columns": ["Molecular weight", "LogP", "Polar surface area"], "samples": [{"id": "Molecule A", "values": [46.07, -.3, 20.23]}, {"id": "Molecule B", "values": [78.11, 2.1, 0]}, {"id": "Molecule C", "values": [180.16, 1.2, 63.6]}, {"id": "Molecule D", "values": [151.16, .5, 49.3]}], "autoscale": True, "components": 2}, "NumPy SVD / OpenScience analysis workflow pattern", ["numpy"]),
    ]
