"""Bounded, offline genomics and matrix analyses adapted from Biomni.

Portions adapted from Biomni (Stanford SNAP), Apache License 2.0, commit
400c1f366b96a35ca253e13c9b06c5076af41d65. See
apps/proto-workbench/THIRD_PARTY_NOTICES.md and the packaged Apache license.
Modifications: pure NumPy/SciPy reimplementation without pybedtools/pandas/
sklearn, JSON interval and matrix inputs, structured results, strict
validation, no files/network, and corrected upstream defects: region overlap
now uses half-open interval algebra with union-based base counts (upstream
summed pairwise pybedtools rows, double counting multi-set overlaps), and NMF
uses a deterministic seeded multiplicative-update solver instead of sklearn.
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


def _integer(value, name, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be an integer from {minimum} to {maximum}.")
    return value


def _string(value, name, maximum=100):
    if not isinstance(value, str) or not 1 <= len(value) <= maximum or value.strip() != value:
        raise ValueError(f"{name} must be a nonempty trimmed string of at most {maximum} characters.")
    return value


def analyze_genomic_region_overlap(arguments):
    """Half-open interval algebra; upstream summed pybedtools pairwise rows."""
    sets = arguments.get("region_sets")
    if not isinstance(sets, list) or not 2 <= len(sets) <= 10:
        raise ValueError("region_sets must contain 2 to 10 named sets.")
    parsed = []
    for set_index, region_set in enumerate(sets):
        if not isinstance(region_set, dict) or set(region_set) != {"name", "regions"} or not isinstance(region_set["regions"], list):
            raise ValueError(f"region_sets[{set_index}] must contain name and regions.")
        name = _string(region_set["name"], f"region_sets[{set_index}].name")
        if not 1 <= len(region_set["regions"]) <= 5000:
            raise ValueError(f"region_sets[{set_index}].regions must contain 1 to 5000 intervals.")
        regions = []
        for region_index, region in enumerate(region_set["regions"]):
            if not isinstance(region, dict) or not {"chromosome", "start", "end"} <= set(region) <= {"chromosome", "start", "end", "name"}:
                raise ValueError(f"region_sets[{set_index}].regions[{region_index}] must contain chromosome, start, and end.")
            chromosome = _string(region["chromosome"], "chromosome", maximum=40)
            start = _integer(region["start"], "start", 0, 2**31 - 1)
            end = _integer(region["end"], "end", 0, 2**31)
            if start >= end:
                raise ValueError(f"region_sets[{set_index}].regions[{region_index}] must have start < end (half-open).")
            regions.append((chromosome, start, end))
        parsed.append((name, regions))

    def merge(regions):
        merged = {}
        by_chromosome = {}
        for chromosome, start, end in regions:
            by_chromosome.setdefault(chromosome, []).append((start, end))
        for chromosome, intervals in by_chromosome.items():
            current = None
            for start, end in sorted(intervals):
                if current is None:
                    current = [start, end]
                elif start <= current[1]:
                    current[1] = max(current[1], end)
                else:
                    merged.setdefault(chromosome, []).append(tuple(current))
                    current = [start, end]
            if current is not None:
                merged.setdefault(chromosome, []).append(tuple(current))
        return merged

    def bases(merged):
        return sum(end - start for intervals in merged.values() for start, end in intervals)

    def intersect(merged_a, merged_b):
        result = {}
        for chromosome, intervals_a in merged_a.items():
            intervals_b = merged_b.get(chromosome)
            if not intervals_b:
                continue
            output = []
            pointer = 0
            for start, end in intervals_a:
                while pointer < len(intervals_b) and intervals_b[pointer][1] <= start:
                    pointer += 1
                scan = pointer
                while scan < len(intervals_b) and intervals_b[scan][0] < end:
                    overlap_start, overlap_end = max(start, intervals_b[scan][0]), min(end, intervals_b[scan][1])
                    if overlap_start < overlap_end:
                        output.append((overlap_start, overlap_end))
                    scan += 1
            if output:
                result[chromosome] = output
        return result

    summaries, pairwise = [], []
    merged_sets = {name: merge(regions) for name, regions in parsed}
    for name, regions in parsed:
        merged = merged_sets[name]
        summaries.append({"name": name, "regions_supplied": len(regions),
                          "merged_regions": sum(len(intervals) for intervals in merged.values()),
                          "total_bp": bases(merged)})
    for i in range(len(parsed)):
        for j in range(i + 1, len(parsed)):
            first, second = parsed[i][0], parsed[j][0]
            overlap = intersect(merged_sets[first], merged_sets[second])
            overlap_bp = bases(overlap)
            count_a = 0
            for chromosome, intervals in merged_sets[first].items():
                for start, end in intervals:
                    if any(os < end and oe > start for os, oe in merged_sets[second].get(chromosome, [])):
                        count_a += 1
            count_b = 0
            for chromosome, intervals in merged_sets[second].items():
                for start, end in intervals:
                    if any(os < end and oe > start for os, oe in merged_sets[first].get(chromosome, [])):
                        count_b += 1
            total_a, total_b = bases(merged_sets[first]), bases(merged_sets[second])
            pairwise.append({"set_1": first, "set_2": second,
                             "regions_in_set_1_overlapping": count_a,
                             "regions_in_set_2_overlapping": count_b,
                             "overlap_bp_union": overlap_bp,
                             "percent_of_set_1": round(overlap_bp / total_a * 100, 6) if total_a else 0.0,
                             "percent_of_set_2": round(overlap_bp / total_b * 100, 6) if total_b else 0.0,
                             "overlap_regions": {chromosome: [[start, end] for start, end in intervals]
                                                 for chromosome, intervals in sorted(overlap.items())[:50]}})
    return {
        "set_summaries": summaries, "pairwise": pairwise,
        "method": "Half-open [start, end) interval algebra on merged per-set intervals; overlap_bp_union counts each overlapped base once per pair",
        "limitations": ["Upstream summed pairwise pybedtools rows, double counting bases covered by multiple opposite-set regions; this port reports union base counts instead.",
                        "Intervals are name-collated only by chromosome string; alternative contig naming (chr1 vs 1) is not harmonized.",
                        "Strand is ignored; regions are treated as unstranded."],
    }


def fit_genomic_prediction_model(arguments):
    """GBLUP-style variance-component fit; upstream's 5-iteration demonstration loop."""
    genotypes = arguments.get("genotypes")
    if not isinstance(genotypes, list) or not 3 <= len(genotypes) <= 500:
        raise ValueError("genotypes must contain 3 to 500 genotype rows.")
    marker_count = None
    for index, row in enumerate(genotypes):
        if not isinstance(row, list) or not 1 <= len(row) <= 5000:
            raise ValueError(f"genotypes[{index}] must contain 1 to 5000 marker values.")
        if marker_count is None:
            marker_count = len(row)
        elif len(row) != marker_count:
            raise ValueError("All genotype rows must have the same marker count.")
        for value in row:
            if isinstance(value, bool) or not isinstance(value, (int, float)) or value not in (0, 1, 2):
                raise ValueError(f"genotypes[{index}] entries must be 0, 1, or 2 allele counts.")
    phenotypes = arguments.get("phenotypes")
    if not isinstance(phenotypes, list) or len(phenotypes) != len(genotypes):
        raise ValueError("phenotypes must contain one value per genotype row.")
    values = [_number(value, f"phenotypes[{index}]") for index, value in enumerate(phenotypes)]
    if len(set(values)) < 2:
        raise ValueError("phenotypes must vary.")
    model_type = arguments.get("model_type", "additive")
    if model_type not in ("additive", "additive_dominance"):
        raise ValueError("model_type must be additive or additive_dominance.")
    import numpy as np

    g = np.asarray(genotypes, dtype=float)
    y = np.asarray(values, dtype=float)
    n = len(y)
    centered = g - g.mean(axis=0)
    g_additive = centered @ centered.T / marker_count
    matrices = [g_additive]
    if model_type == "additive_dominance":
        dominance = np.where(g == 1, 1.0, 0.0)
        dominance = dominance - dominance.mean(axis=0)
        matrices.append(dominance @ dominance.T / marker_count)
    variance_total = float(np.var(y))
    variances = [variance_total * share for share in ((0.5, 0.5) if model_type == "additive" else (0.4, 0.1, 0.5))]
    ones = np.ones((n, 1))
    for _iteration in range(5):  # Upstream's demonstration iteration count.
        v = sum(variance * matrix for variance, matrix in zip(variances[:-1], matrices)) + variances[-1] * np.eye(n)
        try:
            v_inverse = np.linalg.inv(v)
        except np.linalg.LinAlgError:
            raise ValueError("The joint covariance matrix is singular; check for duplicated individuals or markers.")
        projection = v_inverse - v_inverse @ ones @ ones.T @ v_inverse / float((ones.T @ v_inverse @ ones).item())
        py = projection @ y
        for index, matrix in enumerate(matrices):
            numerator = float(py @ matrix @ py)
            denominator = float(np.trace(projection @ matrix))
            if denominator > 1e-12:
                variances[index] = max(0.01, numerator / denominator)
        denominator = float(np.trace(projection))
        if denominator > 1e-12:
            variances[-1] = max(0.01, float(py @ py) / denominator)
    v = sum(variance * matrix for variance, matrix in zip(variances[:-1], matrices)) + variances[-1] * np.eye(n)
    v_inverse = np.linalg.inv(v)
    adjusted = y  # No fixed-effect covariates are accepted in this port.
    breeding_values = variances[0] * g_additive @ v_inverse @ adjusted
    predicted = breeding_values.copy()
    dominance_deviations = None
    if model_type == "additive_dominance":
        dominance_deviations = variances[1] * matrices[1] @ v_inverse @ adjusted
        predicted = predicted + dominance_deviations
    accuracy = float(np.corrcoef(y, predicted)[0, 1]) if np.std(predicted) > 0 else None
    result = {
        "individuals": n, "markers": marker_count, "model_type": model_type,
        "variance_components": {"additive_genetic": round(variances[0], 8),
                                "residual": round(variances[-1], 8)},
        "heritability": round(variances[0] / sum(variances), 8),
        "prediction_accuracy_correlation": round(accuracy, 8) if accuracy is not None and math.isfinite(accuracy) else None,
        "breeding_values": [round(float(value), 8) for value in breeding_values],
        "predicted_phenotypes": [round(float(value), 8) for value in predicted],
        "method": "GBLUP with additive genomic relationship matrix and 5 demonstration REML-style iterations (upstream scope)",
        "limitations": ["Five iterations mirror upstream's demonstration loop and are not a converged REML estimate.",
                        "Accuracy is in-sample correlation (no cross-validation); fixed-effect covariates from upstream are not accepted.",
                        "Markers must be 0/1/2 allele counts on the same scale; missing data must be imputed beforehand."],
    }
    if dominance_deviations is not None:
        result["variance_components"]["dominance_genetic"] = round(variances[1], 8)
        result["dominance_deviations"] = [round(float(value), 8) for value in dominance_deviations]
        result["narrow_heritability"] = round(variances[0] / sum(variances), 8)
        result["broad_heritability"] = round((variances[0] + variances[1]) / sum(variances), 8)
    return result


def perform_gene_expression_nmf_analysis(arguments):
    """Seeded multiplicative-update NMF; upstream wraps sklearn's random-init NMF."""
    matrix = arguments.get("expression_matrix")
    if not isinstance(matrix, list) or not 2 <= len(matrix) <= 2000:
        raise ValueError("expression_matrix must contain 2 to 2000 gene rows.")
    width = None
    for index, row in enumerate(matrix):
        if not isinstance(row, list) or not 2 <= len(row) <= 500:
            raise ValueError(f"expression_matrix[{index}] must contain 2 to 500 sample values.")
        if width is None:
            width = len(row)
        elif len(row) != width:
            raise ValueError("All expression rows must have the same sample count.")
    values = [[_number(value, f"expression_matrix[{index}][{position}]") for position, value in enumerate(row)]
              for index, row in enumerate(matrix)]
    genes = arguments.get("gene_names")
    if genes is not None:
        if not isinstance(genes, list) or len(genes) != len(matrix) or any(not isinstance(gene, str) for gene in genes):
            raise ValueError("gene_names must contain one name per expression row.")
    components = _integer(arguments.get("n_components", 3), "n_components", 2, min(20, len(matrix), width))
    iterations = _integer(arguments.get("max_iterations", 500), "max_iterations", 10, 2000)
    seed = _integer(arguments.get("seed", 0), "seed", 0, 2**31 - 1)
    import numpy as np

    x = np.asarray(values, dtype=float)
    x = np.abs(x)
    scale = x.max()
    if scale <= 0:
        raise ValueError("expression_matrix must contain positive signal.")
    x = x / scale
    rng = np.random.default_rng(seed)
    w = rng.random((x.shape[0], components)) + 0.1
    h = rng.random((components, x.shape[1])) + 0.1
    previous_error = None
    converged_at = iterations
    for iteration in range(iterations):
        h *= (w.T @ x) / np.maximum(w.T @ w @ h, 1e-12)
        w *= (x @ h.T) / np.maximum(w @ h @ h.T, 1e-12)
        error = float(np.linalg.norm(x - w @ h, "fro"))
        if previous_error is not None and abs(previous_error - error) < 1e-9 * max(previous_error, 1e-12):
            converged_at = iteration + 1
            break
        previous_error = error
    reconstruction_error = float(np.linalg.norm(x - w @ h, "fro"))
    total_variation = float(np.linalg.norm(x, "fro"))
    gene_labels = genes if genes is not None else [f"gene_{index + 1}" for index in range(len(matrix))]
    metagenes = {}
    for component in range(components):
        order = np.argsort(-w[:, component])
        metagenes[f"metagene_{component + 1}"] = {
            "top_genes": [{"gene": gene_labels[int(index)], "weight": round(float(w[index, component]), 8)}
                          for index in order[:20]],
            "sample_weights": [round(float(value), 8) for value in h[component]]}
    return {
        "genes": len(matrix), "samples": width, "n_components": components, "seed": seed,
        "iterations_run": converged_at,
        "reconstruction_error_normalized": round(reconstruction_error / total_variation, 8) if total_variation > 0 else None,
        "metagenes": metagenes,
        "method": "Deterministic seeded Lee-Seung multiplicative-update NMF on row-max-scaled nonnegative counts",
        "limitations": ["Multiplicative updates can converge to local minima; vary the seed before interpreting factors.",
                        "Negative inputs are replaced by their absolute values exactly as upstream; normalize with domain knowledge first.",
                        "Metagene biology (pathways, subtypes) requires downstream interpretation; no clustering or clinical association is performed."],
    }


def _schema(properties, required):
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


def _tool(title, description, schema, example, path, function):
    return {"title": title, "description": description, "input_schema": schema, "example": example,
            "dependency": ["numpy", "scipy"], "implementation": "biomni-adapted",
            "upstream_functions": [{"path": path, "name": function}]}


_REGION_ITEM = _schema({"chromosome": {"type": "string", "minLength": 1, "maxLength": 40},
                        "start": {"type": "integer", "minimum": 0, "maximum": 2147483647},
                        "end": {"type": "integer", "minimum": 0, "maximum": 2147483648},
                        "name": {"type": "string", "maxLength": 100}}, ["chromosome", "start", "end"])


TOOLS = {
    "analyze_genomic_region_overlap": _tool(
        "Genomic region overlap", "Pairwise overlap statistics between named interval sets with merged half-open interval algebra and union base counts.",
        _schema({"region_sets": {"type": "array", "minItems": 2, "maxItems": 10, "items": _schema(
                     {"name": {"type": "string", "minLength": 1, "maxLength": 100},
                      "regions": {"type": "array", "minItems": 1, "maxItems": 5000, "items": _REGION_ITEM}},
                     ["name", "regions"])}}, ["region_sets"]),
        {"region_sets": [
            {"name": "peaks", "regions": [{"chromosome": "chr1", "start": 100, "end": 300},
                                          {"chromosome": "chr1", "start": 500, "end": 900},
                                          {"chromosome": "chr2", "start": 50, "end": 150}]},
            {"name": "genes", "regions": [{"chromosome": "chr1", "start": 200, "end": 600},
                                          {"chromosome": "chr2", "start": 100, "end": 400}]}]},
        "biomni/tool/genomics.py", "analyze_genomic_region_overlap"),
    "fit_genomic_prediction_model": _tool(
        "GBLUP genomic prediction", "Fit additive (optionally additive+dominance) genomic relationship models and report heritability and in-sample accuracy.",
        _schema({"genotypes": {"type": "array", "minItems": 3, "maxItems": 500,
                               "items": {"type": "array", "items": {"type": "number", "enum": [0, 1, 2]}, "minItems": 1, "maxItems": 5000}},
                 "phenotypes": {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 500},
                 "model_type": {"type": "string", "enum": ["additive", "additive_dominance"], "default": "additive"}},
                ["genotypes", "phenotypes"]),
        {"genotypes": [[0, 1, 2, 0], [1, 1, 0, 2], [2, 0, 1, 1], [0, 0, 2, 2], [1, 2, 1, 0], [2, 2, 0, 1]],
         "phenotypes": [10.2, 12.5, 15.1, 9.8, 11.4, 14.6], "model_type": "additive"},
        "biomni/tool/genetics.py", "fit_genomic_prediction_model"),
    "perform_gene_expression_nmf_analysis": _tool(
        "Gene expression NMF", "Extract metagenes from a nonnegative expression matrix with seeded multiplicative-update NMF.",
        _schema({"expression_matrix": {"type": "array", "minItems": 2, "maxItems": 2000,
                                       "items": {"type": "array", "items": {"type": "number"}, "minItems": 2, "maxItems": 500}},
                 "gene_names": {"type": "array", "items": {"type": "string", "minLength": 1, "maxLength": 100}, "minItems": 2, "maxItems": 2000},
                 "n_components": {"type": "integer", "minimum": 2, "maximum": 20, "default": 3},
                 "max_iterations": {"type": "integer", "minimum": 10, "maximum": 2000, "default": 500},
                 "seed": {"type": "integer", "minimum": 0, "maximum": 2147483647, "default": 0}},
                ["expression_matrix"]),
        {"expression_matrix": [[5, 5, 0, 0, 1], [4, 6, 0, 0, 1], [0, 0, 7, 6, 2], [0, 1, 8, 7, 1], [1, 0, 6, 5, 2], [6, 5, 0, 1, 0]],
         "gene_names": ["gene_a", "gene_b", "gene_c", "gene_d", "gene_e", "gene_f"],
         "n_components": 2, "seed": 1},
        "biomni/tool/cancer_biology.py", "perform_gene_expression_nmf_analysis"),
}
HANDLERS = {name: globals()[name] for name in TOOLS}
