"""Bounded native statistical companions to the Biomni computational adapters.

These functions are Proto implementations, not ports of upstream Biomni code.
They never read files, run code supplied by callers, or access the network.
NumPy and SciPy are imported only when a calculation is requested.
"""
from __future__ import annotations

import math
import warnings
from typing import Any, Callable


MAX_VALUES = 5_000


def _array_schema(minimum: int = 1, maximum: int = MAX_VALUES) -> dict[str, Any]:
    return {"type": "array", "minItems": minimum, "maxItems": maximum, "items": {"type": "number"}}


def _confidence_schema() -> dict[str, Any]:
    return {"type": "number", "exclusiveMinimum": 0, "exclusiveMaximum": 1, "default": 0.95,
            "description": "Coverage for a two-sided confidence interval, when supported by the selected method."}


def _metadata(title: str, description: str, properties: dict[str, Any], required: list[str], example: dict[str, Any]) -> dict[str, Any]:
    return {
        "title": title, "description": description,
        "input_schema": {"type": "object", "properties": properties, "required": required, "additionalProperties": False},
        "example": example, "dependency": ["numpy", "scipy"],
        "implementation": "proto-native", "upstream_functions": [],
    }


TOOLS: dict[str, dict[str, Any]] = {
    "descriptive_statistics": _metadata(
        "Descriptive statistics", "Summarize finite numeric observations. Variance and standard error use the sample convention; quartiles use linear interpolation.",
        {"values": _array_schema()}, ["values"], {"values": [1, 2, 3, 4, 5]}),
    "compare_two_groups": _metadata(
        "Compare two groups", "Two-sided Welch, Student, paired t, or Mann-Whitney U test, with signed effect sizes and supported mean-difference confidence intervals. Paired data must be supplied in matching order; no missing-value deletion is performed.",
        {"group_a": _array_schema(2), "group_b": _array_schema(2), "method": {"type": "string", "enum": ["welch_t", "student_t", "paired_t", "mann_whitney"], "default": "welch_t"}, "confidence_level": _confidence_schema()},
        ["group_a", "group_b"], {"group_a": [1, 2, 3, 4], "group_b": [2, 4, 5, 7], "method": "welch_t"}),
    "correlation": _metadata(
        "Correlation", "Two-sided Pearson or Spearman correlation with a Fisher-z Pearson confidence interval when supported. Constant vectors are rejected; Spearman uses the asymptotic p-value and has no interval here.",
        {"x": _array_schema(3), "y": _array_schema(3), "method": {"type": "string", "enum": ["pearson", "spearman"], "default": "pearson"}, "confidence_level": _confidence_schema()},
        ["x", "y"], {"x": [1, 2, 3, 4, 5], "y": [2, 1, 4, 3, 5], "method": "pearson"}),
    "linear_regression": _metadata(
        "Simple linear regression", "Fit y = intercept + slope*x by ordinary least squares with an intercept. The slope p-value is two-sided; constant x or y is rejected.",
        {"x": _array_schema(3), "y": _array_schema(3)}, ["x", "y"], {"x": [0, 1, 2, 3, 4], "y": [1, 2, 2, 4, 5]}),
    "one_way_anova": _metadata(
        "One-way ANOVA", "Classical independent-group one-way ANOVA, assuming equal population variances. Each group needs at least two observations; total observations are bounded at 5000.",
        {"groups": {"type": "array", "minItems": 2, "maxItems": 20, "items": _array_schema(2)}},
        ["groups"], {"groups": [[1, 2, 3], [2, 3, 4], [4, 5, 6]]}),
    "adjust_pvalues": _metadata(
        "Adjust p-values", "Correct a prespecified family of p-values with Benjamini-Hochberg, Bonferroni, or Holm. Results preserve original order; the chosen alpha controls the reported rejection flags.",
        {"pvalues": {"type": "array", "minItems": 1, "maxItems": MAX_VALUES, "items": {"type": "number", "minimum": 0, "maximum": 1}}, "method": {"type": "string", "enum": ["bh", "bonferroni", "holm"], "default": "bh"}, "alpha": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.05}},
        ["pvalues"], {"pvalues": [0.01, 0.04, 0.03, 0.2], "method": "bh", "alpha": 0.05}),
    "principal_component_analysis": _metadata(
        "Principal component analysis", "Centered singular-value-decomposition PCA for a rows-by-features matrix. Optional scaling uses sample standard deviations. Component signs follow a deterministic largest-loading convention.",
        {"matrix": {"type": "array", "minItems": 2, "maxItems": 200, "items": _array_schema(1, 30)}, "n_components": {"type": "integer", "minimum": 1, "maximum": 30}, "standardize": {"type": "boolean", "default": False}},
        ["matrix"], {"matrix": [[1, 2], [2, 4], [3, 6], [4, 8]], "n_components": 1, "standardize": False}),
    "contingency_test": _metadata(
        "Contingency-table test", "Pearson chi-square independence test without Yates correction, or two-sided Fisher exact test for a 2x2 count table. Counts must be nonnegative integers and every marginal total must be positive.",
        {"table": {"type": "array", "minItems": 2, "maxItems": 20, "items": {"type": "array", "minItems": 2, "maxItems": 20, "items": {"type": "integer", "minimum": 0, "maximum": 1_000_000}}}, "method": {"type": "string", "enum": ["chi_square", "fisher_exact"], "default": "chi_square"}},
        ["table"], {"table": [[12, 5], [3, 10]], "method": "fisher_exact"}),
}


def _dependencies() -> tuple[Any, Any]:
    try:
        import numpy as np
        from scipy import stats
    except ImportError as exc:
        raise ValueError("Statistical computations require the optional NumPy and SciPy dependencies.") from exc
    return np, stats


def _arguments(name: str, value: Any) -> dict[str, Any]:
    schema = TOOLS[name]["input_schema"]
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise ValueError("Arguments must be an object with string keys.")
    unknown = set(value) - set(schema["properties"])
    missing = set(schema["required"]) - set(value)
    if unknown or missing:
        raise ValueError(f"Invalid arguments: unknown={sorted(unknown)}, missing={sorted(missing)}.")
    return value


def _number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must contain finite numbers, not booleans or strings.")
    try:
        result = float(value)
    except OverflowError as exc:
        raise ValueError(f"{label} exceeds the supported numeric range.") from exc
    if not math.isfinite(result):
        raise ValueError(f"{label} must contain finite numbers.")
    return result


def _vector(value: Any, label: str, minimum: int = 1, maximum: int = MAX_VALUES) -> list[float]:
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        raise ValueError(f"{label} must be an array with {minimum} to {maximum} values.")
    return [_number(item, label) for item in value]


def _method(args: dict[str, Any], tool: str) -> str:
    schema = TOOLS[tool]["input_schema"]["properties"]["method"]
    value = args.get("method", schema["default"])
    if not isinstance(value, str) or value not in schema["enum"]:
        raise ValueError(f"Unsupported {tool} method.")
    return value


def _confidence_level(args: dict[str, Any]) -> float:
    value = _number(args.get("confidence_level", 0.95), "confidence_level")
    if not 0 < value < 1:
        raise ValueError("confidence_level must be strictly between 0 and 1.")
    return value


def _unavailable_interval(estimate: float, confidence: float, estimand: str, reason: str) -> dict[str, Any]:
    return {"status": "unavailable", "method": None, "confidence_level": confidence,
            "estimand": estimand, "estimate": estimate, "lower": None, "upper": None, "reason": reason}


def _t_interval(estimate: float, standard_error: float, df: float, confidence: float, method: str, stats: Any) -> dict[str, Any]:
    critical = _finite(stats.t.isf((1-confidence)/2, df), "t critical value")
    if critical <= 0 or standard_error <= 0:
        raise ValueError("The confidence interval cannot be resolved at floating-point precision.")
    margin = _finite(critical * standard_error, "confidence interval margin")
    lower = _finite(estimate-margin, "confidence interval lower bound")
    upper = _finite(estimate+margin, "confidence interval upper bound")
    if lower >= upper:
        raise ValueError("The confidence interval cannot be resolved at floating-point precision.")
    return {"status": "available", "method": method, "confidence_level": confidence,
            "estimand": "population_mean_difference_a_minus_b", "estimate": estimate,
            "lower": lower, "upper": upper}


def _paired(args: dict[str, Any]) -> tuple[list[float], list[float]]:
    x, y = _vector(args["x"], "x", 3), _vector(args["y"], "y", 3)
    if len(x) != len(y):
        raise ValueError("x and y must have equal lengths and matching observation order.")
    if min(x) == max(x) or min(y) == max(y):
        raise ValueError("Constant x or y has no defined correlation or regression inference.")
    return x, y


def _finite(value: Any, label: str) -> float:
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{label} is undefined or exceeds the supported numeric range for these data.")
    return result


def _calculate(operation: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    """Do not emit runtime warnings onto the MCP transport or serialize NaN."""
    np, _ = _dependencies()
    with warnings.catch_warnings():
        warnings.simplefilter("error", RuntimeWarning)
        try:
            with np.errstate(over="raise", invalid="raise", divide="raise", under="ignore"):
                return operation()
        except (FloatingPointError, RuntimeWarning, OverflowError) as exc:
            raise ValueError("The data are numerically degenerate or exceed the supported numeric range.") from exc


def descriptive_statistics(arguments: dict[str, Any]) -> dict[str, Any]:
    args = _arguments("descriptive_statistics", arguments)
    values = _vector(args["values"], "values")
    np, _ = _dependencies()
    def calculate() -> dict[str, Any]:
        array = np.asarray(values, dtype=float)
        q1, median, q3 = np.quantile(array, [0.25, 0.5, 0.75], method="linear")
        variance = _finite(np.var(array, ddof=1), "sample variance") if len(values) > 1 else None
        deviation = math.sqrt(variance) if variance is not None else None
        return {"n": len(values), "mean": _finite(np.mean(array), "mean"), "median": float(median),
                "minimum": float(np.min(array)), "maximum": float(np.max(array)),
                "q1": float(q1), "q3": float(q3), "interquartile_range": _finite(q3-q1, "interquartile range"),
                "sample_variance": variance, "sample_standard_deviation": deviation,
                "standard_error": deviation / math.sqrt(len(values)) if deviation is not None else None,
                "variance_ddof": 1, "quartile_method": "linear",
                "warnings": [] if len(values) > 1 else ["Sample variance, sample standard deviation and standard error require at least two observations."]}
    return _calculate(calculate)


def compare_two_groups(arguments: dict[str, Any]) -> dict[str, Any]:
    args = _arguments("compare_two_groups", arguments)
    a, b = _vector(args["group_a"], "group_a", 2), _vector(args["group_b"], "group_b", 2)
    method = _method(args, "compare_two_groups")
    confidence = _confidence_level(args)
    np, stats = _dependencies()
    if method == "paired_t" and len(a) != len(b):
        raise ValueError("Paired t-test groups must have equal lengths and matching observation order.")
    def calculate() -> dict[str, Any]:
        degrees_of_freedom = None
        if method == "paired_t":
            differences = np.asarray(a) - np.asarray(b)
            if np.ptp(differences) == 0:
                raise ValueError("Paired differences have zero variance; t-test inference is undefined.")
            result = stats.ttest_rel(a, b, alternative="two-sided")
            degrees_of_freedom = _finite(result.df, "degrees of freedom")
        elif method == "mann_whitney":
            if min(a + b) == max(a + b):
                raise ValueError("All observations are identical; Mann-Whitney inference is degenerate.")
            result = stats.mannwhitneyu(a, b, alternative="two-sided", method="asymptotic", use_continuity=True)
        else:
            constant_a, constant_b = min(a) == max(a), min(b) == max(b)
            if constant_a and constant_b:
                raise ValueError("Both groups have zero variance; t-test inference is undefined.")
            if constant_a or constant_b:
                # One zero sample variance is valid when the other is positive.
                # Summary statistics avoid SciPy's constant-vector precision
                # warning without suppressing warnings for ill-conditioned data.
                result = stats.ttest_ind_from_stats(
                    np.mean(a), np.std(a, ddof=1), len(a),
                    np.mean(b), np.std(b, ddof=1), len(b),
                    equal_var=method == "student_t", alternative="two-sided",
                )
                degrees_of_freedom = len(a)+len(b)-2 if method == "student_t" else (len(b)-1 if constant_a else len(a)-1)
            else:
                result = stats.ttest_ind(a, b, equal_var=method == "student_t", alternative="two-sided")
                degrees_of_freedom = _finite(result.df, "degrees of freedom")
        mean_a, mean_b = _finite(np.mean(a), "group_a mean"), _finite(np.mean(b), "group_b mean")
        # Average within-pair differences before rounding large group means.
        difference = _finite(np.mean(differences) if method == "paired_t" else mean_a-mean_b, "mean difference")
        effect_sizes: list[dict[str, Any]] = []
        standard_error = None
        messages = []
        if method == "mann_whitney":
            effect_sizes.append({"name": "rank_biserial", "estimate": _finite(2*result.statistic/(len(a)*len(b))-1, "rank-biserial effect"),
                                 "orientation": "positive_when_group_a_tends_larger",
                                 "definition": "P(A>B)-P(A<B); ties contribute zero"})
            interval = _unavailable_interval(difference, confidence, "population_mean_difference_a_minus_b",
                                            "The Mann-Whitney rank test does not provide a confidence interval for a population mean difference; no rank-effect interval is implemented.")
            assumptions = ["Observations and groups are independent, with at least ordinal measurements.",
                           "The null concerns distributions; interpreting this as a location or median shift requires comparable distribution shapes."]
            messages.append("Mann-Whitney uses a tie-corrected asymptotic p-value with continuity correction; small samples may need exact inference.")
        elif method == "paired_t":
            deviation = _finite(np.std(differences, ddof=1), "paired-difference standard deviation")
            standard_error = _finite(deviation/math.sqrt(len(a)), "mean-difference standard error")
            effect_sizes.append({"name": "cohen_dz", "estimate": _finite(difference/deviation, "Cohen dz"),
                                 "standardizer": "sample_standard_deviation_of_paired_differences", "standardizer_value": deviation})
            interval = _t_interval(difference, standard_error, degrees_of_freedom, confidence, "paired_t", stats)
            assumptions = ["Pairs are correctly matched; pairs are independent of other pairs.",
                           "The t interval is exact under normally distributed paired differences; small samples cannot establish that assumption."]
        else:
            variance_a = _finite(np.var(a, ddof=1), "group_a sample variance")
            variance_b = _finite(np.var(b, ddof=1), "group_b sample variance")
            pooled_df = len(a)+len(b)-2
            pooled_sd = math.sqrt(_finite(((len(a)-1)*variance_a+(len(b)-1)*variance_b)/pooled_df, "pooled variance"))
            if pooled_sd <= 0:
                raise ValueError("The pooled standard deviation is numerically degenerate.")
            d = _finite(difference/pooled_sd, "Cohen d")
            effect_sizes.append({"name": "cohen_d", "estimate": d, "standardizer": "sample_size_weighted_pooled_standard_deviation",
                                 "standardizer_value": pooled_sd})
            assumptions = ["Observations and groups are independent; observations represent their target populations."]
            if method == "student_t":
                standard_error = _finite(pooled_sd*math.sqrt(1/len(a)+1/len(b)), "mean-difference standard error")
                correction = math.exp(math.lgamma(pooled_df/2)-0.5*math.log(pooled_df/2)-math.lgamma((pooled_df-1)/2))
                effect_sizes.append({"name": "hedges_g", "estimate": _finite(correction*d, "Hedges g"),
                                     "standardizer": "sample_size_weighted_pooled_standard_deviation",
                                     "standardizer_value": pooled_sd, "bias_correction": correction,
                                     "bias_correction_method": "exact_gamma_ratio", "bias_correction_df": pooled_df})
                assumptions.append("Student t and the Hedges correction assume normally distributed populations with equal variances.")
            else:
                standard_error = math.sqrt(_finite(variance_a/len(a)+variance_b/len(b), "mean-difference variance"))
                assumptions.append("Welch-Satterthwaite inference allows unequal variances; its small-sample approximation assumes normally distributed populations.")
                messages.append("Pooled-SD Cohen d is a descriptive standardized difference under unequal variances; no common population SD or bias-corrected Hedges g is asserted.")
            interval = _t_interval(difference, standard_error, degrees_of_freedom, confidence, method, stats)
        assumptions.append("Effect sizes are point estimates; their confidence intervals are not implemented. The reported interval, when available, covers the raw mean difference.")
        return {"method": method, "alternative": "two-sided", "group_a_n": len(a), "group_b_n": len(b),
                "group_a_mean": mean_a, "group_b_mean": mean_b, "mean_difference": difference,
                "statistic": _finite(result.statistic, "test statistic"), "p_value": _finite(result.pvalue, "p-value"),
                "degrees_of_freedom": degrees_of_freedom,
                "mean_difference_orientation": "group_a_minus_group_b", "standard_error": standard_error,
                "confidence_level": confidence, "confidence_interval": interval, "effect_sizes": effect_sizes,
                "assumptions": assumptions, "warnings": messages}
    return _calculate(calculate)


def correlation(arguments: dict[str, Any]) -> dict[str, Any]:
    args = _arguments("correlation", arguments)
    x, y = _paired(args)
    method = _method(args, "correlation")
    confidence = _confidence_level(args)
    _, stats = _dependencies()
    def calculate() -> dict[str, Any]:
        result = stats.pearsonr(x, y, alternative="two-sided") if method == "pearson" else stats.spearmanr(x, y, alternative="two-sided")
        coefficient = _finite(result.statistic, "correlation")
        messages = []
        assumptions = ["Observation pairs are independent and correctly matched; association does not establish causation."]
        if method == "spearman":
            interval = _unavailable_interval(coefficient, confidence, "population_spearman_correlation",
                                            "A Spearman confidence interval is not implemented; the Pearson Fisher-z formula is not substituted for a rank-correlation interval.")
            messages.append("Spearman p-value is asymptotic and may be inaccurate for small samples.")
            assumptions.append("Spearman measures monotonic rank association, with average ranks for ties.")
        elif len(x) <= 3:
            interval = _unavailable_interval(coefficient, confidence, "population_pearson_correlation",
                                            "Fisher-z inference requires more than three paired observations.")
        elif abs(coefficient) >= 1-8*math.ulp(1.0):
            interval = _unavailable_interval(coefficient, confidence, "population_pearson_correlation",
                                            "Perfect or numerically saturated correlation cannot support a nondegenerate Fisher-z interval.")
        else:
            critical = _finite(stats.norm.isf((1-confidence)/2), "normal critical value")
            if critical <= 0:
                raise ValueError("The confidence interval cannot be resolved at floating-point precision.")
            margin = critical/math.sqrt(len(x)-3)
            center = math.atanh(coefficient)
            lower, upper = math.tanh(center-margin), math.tanh(center+margin)
            if lower >= upper:
                raise ValueError("The confidence interval cannot be resolved at floating-point precision.")
            interval = {"status": "available", "method": "fisher_z", "confidence_level": confidence,
                        "estimand": "population_pearson_correlation", "estimate": coefficient,
                        "lower": lower, "upper": upper}
        if method == "pearson":
            assumptions.append("The Fisher-z interval is an approximation for pairs drawn from a bivariate normal population; small samples and outliers can compromise coverage.")
        if interval["status"] == "unavailable":
            messages.append(interval["reason"])
        return {"method": method, "n": len(x), "coefficient": coefficient,
                "p_value": _finite(result.pvalue, "p-value"), "alternative": "two-sided",
                "confidence_level": confidence, "confidence_interval": interval,
                "assumptions": assumptions, "warnings": messages}
    return _calculate(calculate)


def linear_regression(arguments: dict[str, Any]) -> dict[str, Any]:
    args = _arguments("linear_regression", arguments)
    x, y = _paired(args)
    _, stats = _dependencies()
    def calculate() -> dict[str, Any]:
        result = stats.linregress(x, y, alternative="two-sided")
        return {"n": len(x), "slope": _finite(result.slope, "slope"), "intercept": _finite(result.intercept, "intercept"),
                "r_value": _finite(result.rvalue, "correlation"), "r_squared": _finite(result.rvalue**2, "R-squared"),
                "slope_standard_error": _finite(result.stderr, "slope standard error"),
                "intercept_standard_error": _finite(result.intercept_stderr, "intercept standard error"),
                "p_value": _finite(result.pvalue, "slope p-value"), "degrees_of_freedom": len(x)-2,
                "alternative": "two-sided", "warnings": []}
    return _calculate(calculate)


def one_way_anova(arguments: dict[str, Any]) -> dict[str, Any]:
    args = _arguments("one_way_anova", arguments)
    raw = args["groups"]
    if not isinstance(raw, list) or not 2 <= len(raw) <= 20:
        raise ValueError("groups must contain 2 to 20 groups.")
    groups = [_vector(group, f"groups[{index}]", 2) for index, group in enumerate(raw)]
    count = sum(map(len, groups))
    if count > MAX_VALUES:
        raise ValueError("ANOVA total observations must not exceed 5000.")
    if all(min(group) == max(group) for group in groups):
        raise ValueError("All groups have zero within-group variance; ANOVA inference is undefined.")
    np, stats = _dependencies()
    def calculate() -> dict[str, Any]:
        result = stats.f_oneway(*groups)
        return {"statistic": _finite(result.statistic, "F statistic"), "p_value": _finite(result.pvalue, "p-value"),
                "group_sizes": list(map(len, groups)), "group_means": [_finite(np.mean(group), "group mean") for group in groups],
                "degrees_of_freedom_between": len(groups)-1, "degrees_of_freedom_within": count-len(groups),
                "warnings": ["Classical ANOVA assumes independent observations, normally distributed residuals, and equal population variances."]}
    return _calculate(calculate)


def adjust_pvalues(arguments: dict[str, Any]) -> dict[str, Any]:
    args = _arguments("adjust_pvalues", arguments)
    values = _vector(args["pvalues"], "pvalues")
    if any(value < 0 or value > 1 for value in values):
        raise ValueError("pvalues must lie between 0 and 1 inclusive.")
    method = _method(args, "adjust_pvalues")
    alpha = _number(args.get("alpha", 0.05), "alpha")
    if not 0 < alpha < 1:
        raise ValueError("alpha must be strictly between 0 and 1.")
    _dependencies()
    size = len(values)
    order = sorted(range(size), key=lambda index: values[index])
    adjusted = [0.0] * size
    running = 1.0 if method == "bh" else 0.0
    for position in range(size-1, -1, -1) if method == "bh" else range(size):
        index = order[position]
        if method == "bh":
            running = min(running, values[index] * size / (position+1))
        elif method == "holm":
            running = max(running, min(1.0, values[index] * (size-position)))
        else:
            running = min(1.0, values[index] * size)
        adjusted[index] = running
    return {"method": method, "alpha": alpha, "n_tests": size, "adjusted_pvalues": adjusted,
            "rejected": [value <= alpha for value in adjusted],
            "warnings": ["Benjamini-Hochberg FDR control assumes independent tests or suitable positive dependence."] if method == "bh" else []}


def principal_component_analysis(arguments: dict[str, Any]) -> dict[str, Any]:
    args = _arguments("principal_component_analysis", arguments)
    raw = args["matrix"]
    if not isinstance(raw, list) or not 2 <= len(raw) <= 200:
        raise ValueError("matrix must contain 2 to 200 observation rows.")
    rows = [_vector(row, f"matrix[{index}]", 1, 30) for index, row in enumerate(raw)]
    width = len(rows[0])
    if any(len(row) != width for row in rows):
        raise ValueError("matrix rows must have equal numbers of features.")
    standardize = args.get("standardize", False)
    if not isinstance(standardize, bool):
        raise ValueError("standardize must be a boolean.")
    maximum = min(len(rows)-1, width)
    count = args.get("n_components", maximum)
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= maximum:
        raise ValueError(f"n_components must be an integer from 1 to min(rows-1, columns)={maximum}.")
    np, _ = _dependencies()
    def calculate() -> dict[str, Any]:
        matrix = np.asarray(rows, dtype=float)
        means = matrix.mean(axis=0)
        centered = matrix - means
        deviations = centered.std(axis=0, ddof=1)
        constant = np.flatnonzero(deviations == 0).tolist()
        if standardize and constant:
            raise ValueError("Cannot standardize constant features; remove them or set standardize=false.")
        scales = deviations if standardize else np.ones(width)
        centered = centered / scales
        total_variance = _finite(np.sum(centered**2) / (len(rows)-1), "total variance")
        if total_variance == 0:
            raise ValueError("PCA requires nonzero total variance.")
        try:
            _, singular_values, vectors = np.linalg.svd(centered, full_matrices=False)
        except np.linalg.LinAlgError as exc:
            raise ValueError("PCA singular-value decomposition did not converge.") from exc
        components = vectors[:count].copy()
        for component in components:
            if component[int(np.argmax(np.abs(component)))] < 0:
                component *= -1
        scores = centered @ components.T
        explained = singular_values[:count]**2 / (len(rows)-1)
        for array in (means, scales, components, scores, explained):
            if not np.isfinite(array).all():
                raise ValueError("PCA produced a non-finite result.")
        return {"n_samples": len(rows), "n_features": width, "n_components": count, "standardize": standardize,
                "means": means.tolist(), "scales": scales.tolist(), "components": components.tolist(), "scores": scores.tolist(),
                "explained_variance": explained.tolist(), "explained_variance_ratio": (explained / total_variance).tolist(),
                "total_variance": total_variance, "variance_ddof": 1,
                "warnings": ([f"Constant features retained without scaling: zero-based columns {constant}."] if constant else [])
                + ["Signs use the largest absolute loading as positive; repeated singular values do not define a unique component basis."]}
    return _calculate(calculate)


def contingency_test(arguments: dict[str, Any]) -> dict[str, Any]:
    args = _arguments("contingency_test", arguments)
    raw = args["table"]
    if not isinstance(raw, list) or not 2 <= len(raw) <= 20:
        raise ValueError("table must contain 2 to 20 rows.")
    if any(not isinstance(row, list) or not 2 <= len(row) <= 20 for row in raw):
        raise ValueError("table must contain 2 to 20 columns per row.")
    if any(len(row) != len(raw[0]) for row in raw):
        raise ValueError("table rows must have equal lengths.")
    if any(isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 1_000_000 for row in raw for value in row):
        raise ValueError("Counts must be integers between 0 and 1000000, not booleans.")
    if any(sum(row) == 0 for row in raw) or any(sum(column) == 0 for column in zip(*raw)):
        raise ValueError("Every row and column must have a positive marginal total.")
    method = _method(args, "contingency_test")
    if method == "fisher_exact" and (len(raw) != 2 or len(raw[0]) != 2):
        raise ValueError("Fisher exact test requires a 2x2 table.")
    _, stats = _dependencies()
    def calculate() -> dict[str, Any]:
        if method == "fisher_exact":
            result = stats.fisher_exact(raw, alternative="two-sided")
            finite_odds = math.isfinite(float(result.statistic))
            return {"method": method, "alternative": "two-sided", "odds_ratio": float(result.statistic) if finite_odds else None,
                    "p_value": _finite(result.pvalue, "p-value"), "n": sum(map(sum, raw)),
                    "warnings": [] if finite_odds else ["The sample odds ratio is infinite because a denominator cell is zero; it is reported as null."]}
        result = stats.chi2_contingency(raw, correction=False)
        return {"method": method, "statistic": _finite(result.statistic, "chi-square statistic"),
                "p_value": _finite(result.pvalue, "p-value"), "degrees_of_freedom": int(result.dof),
                "expected_counts": result.expected_freq.tolist(), "yates_correction": False, "n": sum(map(sum, raw)),
                "warnings": ["At least one expected cell count is below 5; the chi-square approximation may be inaccurate."] if (result.expected_freq < 5).any() else []}
    return _calculate(calculate)


HANDLERS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "descriptive_statistics": descriptive_statistics,
    "compare_two_groups": compare_two_groups,
    "correlation": correlation,
    "linear_regression": linear_regression,
    "one_way_anova": one_way_anova,
    "adjust_pvalues": adjust_pvalues,
    "principal_component_analysis": principal_component_analysis,
    "contingency_test": contingency_test,
}
