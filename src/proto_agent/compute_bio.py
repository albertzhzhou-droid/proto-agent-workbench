"""Bounded, offline biological data calculations adapted from Biomni.

Portions adapted from Biomni (Stanford SNAP), Apache License 2.0, commit
400c1f366b96a35ca253e13c9b06c5076af41d65. See
apps/proto-workbench/THIRD_PARTY_NOTICES.md and the packaged Apache license.
Modifications: structured results, strict validation, no files/network/execution,
corrected RNA topology, prealigned conservation, offline enrichment, identifiable
cosinor fitting. Michaelis-Menten fitting is a Proto-native measured-data tool.
"""

from __future__ import annotations

from collections import Counter
import math
import warnings


_AMINO_ACIDS = frozenset("ACDEFGHIKLMNPQRSTVWY")
_MAX_SEQUENCE = 10_000


def _sequence(value, name="sequence", *, gaps=False):
    if not isinstance(value, str) or not value.isascii() or not 1 <= len(value) <= _MAX_SEQUENCE:
        raise ValueError(f"{name} must contain 1 to {_MAX_SEQUENCE} residues.")
    sequence = value.upper()
    alphabet = _AMINO_ACIDS | {"-"} if gaps else _AMINO_ACIDS
    if not set(sequence) <= alphabet:
        raise ValueError(f"{name} must contain canonical amino-acid letters" + (" or '-' gaps." if gaps else "."))
    return sequence


def _number(value, name, *, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite number.")
    try:
        result = float(value)
    except (OverflowError, ValueError):
        raise ValueError(f"{name} must be a finite number.") from None
    if not math.isfinite(result) or abs(result) > 1e100 or (positive and result <= 0):
        raise ValueError(f"{name} must be finite, have magnitude <= 1e100" + (", and be positive." if positive else "."))
    return result


def _numbers(value, name, *, minimum=4):
    if not isinstance(value, list) or not minimum <= len(value) <= 5000:
        raise ValueError(f"{name} must contain {minimum} to 5000 numbers.")
    return [_number(item, f"{name}[{index}]") for index, item in enumerate(value)]


def _boolean(value, name):
    if not isinstance(value, bool):
        raise ValueError(f"{name} must be a boolean.")
    return value


def analyze_rna_secondary_structure_features(arguments):
    """Describe well-nested secondary-structure topology; do not infer energy."""
    structure = arguments.get("dot_bracket_structure")
    if not isinstance(structure, str) or not 1 <= len(structure) <= 10_000:
        raise ValueError("dot_bracket_structure must contain 1 to 10000 symbols.")
    if not set(structure) <= set(".()[]{}"):
        raise ValueError("Only '.', '()', '[]', and '{}' notation is supported.")
    sequence = arguments.get("sequence")
    if sequence is not None:
        if not isinstance(sequence, str) or not sequence.isascii() or len(sequence) != len(structure) or not set(sequence.upper()) <= set("ACGU"):
            raise ValueError("sequence must use A/C/G/U and match the structure length.")
        sequence = sequence.upper()
    stack, pair_ends, children = [], {}, {}
    matches = {")": "(", "]": "[", "}": "{"}
    for index, symbol in enumerate(structure):
        if symbol in "([{":
            children[index] = []
            if stack:
                children[stack[-1][0]].append(index)
            stack.append((index, symbol))
        elif symbol in ")]}":
            if not stack or stack[-1][1] != matches[symbol]:
                raise ValueError("Brackets must be balanced and well-nested; crossing pseudoknots are unsupported.")
            start, _ = stack.pop()
            pair_ends[start] = index
    if stack:
        raise ValueError("Brackets must be balanced.")
    pairs = sorted(pair_ends.items())
    stems = []
    for start, end in pairs:
        if stems and start == stems[-1][-1][0] + 1 and end == stems[-1][-1][1] - 1:
            stems[-1].append((start, end))
        else:
            stems.append([(start, end)])
    loops = []
    for start, end in pairs:
        enclosed = children[start]
        if len(enclosed) == 1 and enclosed[0] == start + 1 and pair_ends[enclosed[0]] == end - 1:
            continue  # Adjacent stacked pair, not a loop.
        unpaired = end - start - 1 - sum(pair_ends[child] - child + 1 for child in enclosed)
        if not enclosed:
            kind = "hairpin"
        elif len(enclosed) >= 2:
            kind = "multibranch"
        else:
            child = enclosed[0]
            left, right = child - start - 1, end - pair_ends[child] - 1
            kind = "internal" if left and right else "bulge"
        loops.append({"type": kind, "closing_pair": [start + 1, end + 1], "unpaired_bases": unpaired})
    counts = Counter(loop["type"] for loop in loops)
    paired_bases = 2 * len(pairs)
    result = {
        "length": len(structure), "base_pair_count": len(pairs),
        "paired_bases": paired_bases, "unpaired_bases": len(structure) - paired_bases,
        "paired_fraction": paired_bases / len(structure),
        "stem_count": len(stems), "longest_stem_length": max(map(len, stems), default=0),
        "average_stem_length": len(pairs) / len(stems) if stems else 0.0,
        "stems": [{"base_pair_count": len(stem), "pairs": [[a + 1, b + 1] for a, b in stem]} for stem in stems],
        "loop_counts": {kind: counts[kind] for kind in ("hairpin", "bulge", "internal", "multibranch")},
        "loops": loops, "external_unpaired_bases": len(structure) - paired_bases - sum(loop["unpaired_bases"] for loop in loops),
        "position_basis": "1-based", "method": "Well-nested dot-bracket topology",
        "limitations": ["Topology only; no folding, free energy, pseudoknot, or physical-viability prediction."],
    }
    if sequence is not None:
        classes = Counter("canonical" if sequence[a] + sequence[b] in {"AU", "UA", "GC", "CG"} else "wobble" if sequence[a] + sequence[b] in {"GU", "UG"} else "other" for a, b in pairs)
        result["pair_types"] = {name: classes[name] for name in ("canonical", "wobble", "other")}
    return result


def find_n_glycosylation_motifs(arguments):
    sequence = _sequence(arguments.get("sequence"))
    overlap = _boolean(arguments.get("allow_overlap", False), "allow_overlap")
    matches, index = [], 0
    while index <= len(sequence) - 3:
        motif = sequence[index:index + 3]
        if motif[0] == "N" and motif[1] != "P" and motif[2] in "ST":
            matches.append({"position": index + 1, "motif": motif})
            index += 1 if overlap else 3
        else:
            index += 1
    return {
        "length": len(sequence), "motif": "N-X-[S/T], X != P", "allow_overlap": overlap,
        "count": len(matches), "matches": matches, "position_basis": "1-based",
        "limitations": ["Sequence sequons indicate candidate sites, not experimentally established glycosylation.",
                        "With allow_overlap=false, a match skips the next two start positions."],
    }


def predict_o_glycosylation_hotspots(arguments):
    sequence = _sequence(arguments.get("sequence"))
    window = arguments.get("window", 7)
    if isinstance(window, bool) or not isinstance(window, int) or not 3 <= window <= 101 or window % 2 == 0:
        raise ValueError("window must be an odd integer from 3 to 101.")
    threshold = _number(arguments.get("min_st_fraction", 0.4), "min_st_fraction")
    if not 0 <= threshold <= 1:
        raise ValueError("min_st_fraction must be between 0 and 1.")
    disallow = _boolean(arguments.get("disallow_proline_next", True), "disallow_proline_next")
    candidates = []
    half = window // 2
    for index, residue in enumerate(sequence):
        if residue not in "ST" or (disallow and index + 1 < len(sequence) and sequence[index + 1] == "P"):
            continue
        start, end = max(0, index - half), min(len(sequence), index + half + 1)
        fraction = sum(residue in "ST" for residue in sequence[start:end]) / (end - start)
        if fraction >= threshold:
            candidates.append({"position": index + 1, "residue": residue, "st_fraction": round(fraction, 3), "window_start": start + 1, "window_end": end})
    return {
        "length": len(sequence), "window": window, "min_st_fraction": threshold,
        "disallow_proline_next": disallow, "count": len(candidates), "candidates": candidates,
        "position_basis": "1-based inclusive", "method": "Unvalidated local S/T density heuristic",
        "limitations": ["Heuristic candidates only; scores are residue fractions, not glycosylation probabilities.",
                        "Optional next-proline suppression reproduces the upstream heuristic and is not a universal biological rule."],
    }


def analyze_protein_conservation(arguments):
    supplied = arguments.get("aligned_sequences")
    if not isinstance(supplied, list) or not 2 <= len(supplied) <= 200:
        raise ValueError("aligned_sequences must contain 2 to 200 prealigned strings.")
    sequences = [_sequence(value, f"aligned_sequences[{index}]", gaps=True) for index, value in enumerate(supplied)]
    if sum(map(len, sequences)) > _MAX_SEQUENCE:
        raise ValueError("Total aligned sequence length must not exceed 10000 characters.")
    if len({len(value) for value in sequences}) != 1:
        raise ValueError("Sequences must already be aligned and have equal lengths; no padding or alignment is performed.")
    if any(not set(sequence) - {"-"} for sequence in sequences):
        raise ValueError("Each aligned sequence must contain at least one residue.")
    columns, consensus, conserved = [], [], []
    for index, column in enumerate(zip(*sequences)):
        counts = Counter(residue for residue in column if residue != "-")
        observed = sum(counts.values())
        if observed:
            top = min(counts, key=lambda residue: (-counts[residue], residue))
            score = counts[top] / len(sequences)
            entropy = -sum((count / observed) * math.log2(count / observed) for count in counts.values())
        else:
            top, score, entropy = None, 0.0, None
        consensus.append(top or "-")
        columns.append({"position": index + 1, "consensus": top, "conservation_fraction": score,
                        "occupancy_fraction": observed / len(sequences), "residue_identity_fraction": counts[top] / observed if observed else None,
                        "entropy_bits": entropy, "gap_count": len(sequences) - observed})
        if score > 0.8:
            conserved.append(index + 1)
    return {
        "sequence_count": len(sequences), "alignment_length": len(sequences[0]),
        "consensus": "".join(consensus), "columns": columns, "conserved_positions": conserved,
        "conserved_threshold": 0.8, "threshold_comparison": ">", "position_basis": "1-based alignment columns",
        "method": "Most frequent non-gap residue count divided by total sequences; ties use alphabetical order",
        "limitations": ["Inputs must be biologically valid prealignments; equal length alone does not establish an alignment.",
                        "Gaps reduce conservation; all-gap columns have zero conservation and null residue identity/entropy. No phylogeny is inferred."],
    }


def _gene_list(value, name, maximum=5000):
    if not isinstance(value, list) or not 1 <= len(value) <= maximum:
        raise ValueError(f"{name} must contain 1 to {maximum} gene identifiers.")
    if any(not isinstance(gene, str) or not 1 <= len(gene) <= 100 or gene != gene.strip() or any(character.isspace() for character in gene) for gene in value):
        raise ValueError(f"{name} must contain nonempty identifiers of at most 100 characters without whitespace.")
    return set(value)


def gene_set_enrichment_analysis(arguments, *, max_universe=5000):
    """Offline over-representation analysis; not ranked GSEA or Enrichr parity."""
    if max_universe not in (5000, 100000):
        raise ValueError("Unsupported reviewed gene-universe bound.")
    genes = _gene_list(arguments.get("genes"), "genes", max_universe)
    background = _gene_list(arguments.get("background"), "background", max_universe)
    if not genes < background:
        raise ValueError("genes must be a nonempty proper subset of the explicit background.")
    supplied = arguments.get("gene_sets")
    if not isinstance(supplied, list) or not 1 <= len(supplied) <= 200:
        raise ValueError("gene_sets must contain 1 to 200 named gene sets.")
    gene_sets, names, membership_count = [], set(), 0
    for item in supplied:
        if not isinstance(item, dict) or set(item) != {"name", "genes"}:
            raise ValueError("Each gene set must contain exactly name and genes.")
        name = item["name"]
        if not isinstance(name, str) or not 1 <= len(name) <= 100 or not name.strip() or name in names:
            raise ValueError("Gene set names must be unique nonempty strings of at most 100 characters.")
        names.add(name)
        members = _gene_list(item["genes"], f"gene_sets[{name}].genes")
        membership_count += len(item["genes"])
        if membership_count > 50_000:
            raise ValueError("Total supplied gene-set memberships must not exceed 50000.")
        gene_sets.append((name, members))
    top_k = arguments.get("top_k", len(gene_sets))
    if isinstance(top_k, bool) or not isinstance(top_k, int) or not 1 <= top_k <= 200:
        raise ValueError("top_k must be an integer from 1 to 200.")
    from scipy.stats import hypergeom

    rows = []
    for name, members in gene_sets:
        eligible = members & background
        overlap = sorted(genes & eligible)
        expected = len(genes) * len(eligible) / len(background)
        rows.append({"name": name, "set_size_in_background": len(eligible),
                     "excluded_members_outside_background": len(members - background),
                     "overlap_count": len(overlap), "overlap_genes": overlap,
                     "expected_overlap": expected, "fold_enrichment": len(overlap) / expected if expected else None,
                     "p_value": float(hypergeom.sf(len(overlap) - 1, len(background), len(eligible), len(genes)))})
    ordered = sorted(range(len(rows)), key=lambda index: rows[index]["p_value"])
    adjusted = 1.0
    for rank in range(len(rows), 0, -1):
        index = ordered[rank - 1]
        adjusted = min(adjusted, rows[index]["p_value"] * len(rows) / rank)
        rows[index]["adjusted_p_value"] = adjusted
    rows.sort(key=lambda row: (row["p_value"], row["name"]))
    return {
        "query_size": len(genes), "background_size": len(background), "tested_gene_sets": len(rows),
        "query_duplicates_removed": len(arguments["genes"]) - len(genes),
        "background_duplicates_removed": len(arguments["background"]) - len(background),
        "results": rows[:top_k], "method": "One-sided hypergeometric over-representation test; Benjamini-Hochberg across ALL supplied gene sets before top_k",
        "limitations": ["Offline scope adaptation of Biomni's remote Enrichr wrapper; results are not Enrichr scores or ranked GSEA.",
                        "Identifiers are case-sensitive. Gene sets are intersected with the supplied background; biological relevance depends on that universe and set provenance."],
    }


def perform_cosinor_analysis(arguments):
    times = _numbers(arguments.get("time_data"), "time_data")
    values = _numbers(arguments.get("physiological_data"), "physiological_data")
    if len(times) != len(values):
        raise ValueError("time_data and physiological_data must have equal lengths.")
    period = _number(arguments.get("period", 24.0), "period", positive=True)
    if len(set(values)) < 2:
        raise ValueError("Constant physiological_data cannot identify a rhythm.")
    import numpy as np

    angles = (np.remainder(np.asarray(times), period) / period) * (2 * np.pi)
    design = np.column_stack((np.ones(len(times)), np.cos(angles), np.sin(angles)))
    if np.linalg.matrix_rank(design) < 3 or np.linalg.cond(design) > 1e10:
        raise ValueError("Sampling phases do not identify a stable fixed-period cosinor model.")
    scale = max(abs(value) for value in values)
    measured = np.asarray(values) / scale
    coefficients, _, _, _ = np.linalg.lstsq(design, measured, rcond=None)
    fitted = design @ coefficients
    residuals = measured - fitted
    ss_residual = float(residuals @ residuals)
    ss_total = float(np.sum((measured - measured.mean()) ** 2))
    if ss_total <= np.finfo(float).eps ** 2 * len(values):
        raise ValueError("physiological_data variation is too small for stable fitting.")
    # Form covariance from the original design's SVD. Normal equations square
    # its condition number and can severely understate uncertainty for clustered
    # sampling phases even when the least-squares fit remains identifiable.
    design_pseudoinverse = np.linalg.pinv(design)
    covariance = (design_pseudoinverse @ design_pseudoinverse.T) * (ss_residual / (len(values) - 3))
    mesor, cosine, sine = map(float, coefficients)
    amplitude = math.hypot(cosine, sine)
    phase = math.atan2(sine, cosine) % (2 * math.pi) if amplitude > 1e-12 else None
    return {
        "n": len(values), "period": period, "mesor": mesor * scale, "amplitude": amplitude * scale,
        "cosine_coefficient": cosine * scale, "sine_coefficient": sine * scale,
        "acrophase_radians": phase, "peak_time": phase * period / (2 * math.pi) if phase is not None else None,
        "r_squared": 1.0 - ss_residual / ss_total, "residual_degrees_of_freedom": len(values) - 3,
        "coefficient_standard_errors": [float(value) * scale for value in np.sqrt(np.maximum(np.diag(covariance), 0.0))],
        "coefficient_order": ["mesor", "cosine", "sine"], "fitted_values": (fitted * scale).tolist(),
        "residuals": (residuals * scale).tolist(),
        "method": "Fixed-period ordinary least squares: mesor + cosine*cos(2*pi*t/period) + sine*sin(2*pi*t/period)",
        "limitations": ["Time and period must use the same units; peak_time is relative to input time zero, modulo period.",
                        "Period is specified, not estimated. Standard errors assume independent homoscedastic residuals; no rhythm significance or clinical interpretation is inferred.",
                        "Phase and peak are null when the fitted harmonic amplitude is numerically negligible."],
    }


def fit_michaelis_menten(arguments):
    substrates = _numbers(arguments.get("substrate_concentrations"), "substrate_concentrations")
    velocities = _numbers(arguments.get("velocities"), "velocities")
    if len(substrates) != len(velocities):
        raise ValueError("substrate_concentrations and velocities must have equal lengths.")
    if min(substrates) < 0 or min(velocities) < 0 or len({value for value in substrates if value > 0}) < 3:
        raise ValueError("Use nonnegative measurements and at least three distinct positive substrate concentrations.")
    if len(set(velocities)) < 2 or max(velocities) <= 0:
        raise ValueError("Velocities must have positive, nonconstant variation.")
    units = {}
    for key, default in (("substrate_unit", "input concentration unit"), ("velocity_unit", "input velocity unit")):
        unit = arguments.get(key, default)
        if not isinstance(unit, str) or not 1 <= len(unit) <= 80 or not unit.strip():
            raise ValueError(f"{key} must be a nonempty string of at most 80 characters.")
        units[key] = unit
    import numpy as np
    from scipy.optimize import OptimizeWarning, curve_fit

    substrate_scale = float(np.median([value for value in substrates if value > 0]))
    velocity_scale = max(velocities)
    try:
        with np.errstate(over="raise", divide="raise", invalid="raise"):
            x, y = np.asarray(substrates) / substrate_scale, np.asarray(velocities) / velocity_scale
    except FloatingPointError:
        raise ValueError("Input dynamic range exceeds stable numeric fitting limits.") from None
    if max(x) > 1e100 or min(x[x > 0]) < 1e-100:
        raise ValueError("Substrate dynamic range exceeds stable numeric fitting limits.")

    def model(concentration, vmax, km):
        return vmax * concentration / (km + concentration)

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", OptimizeWarning)
            warnings.simplefilter("error", RuntimeWarning)
            parameters, covariance = curve_fit(model, x, y, p0=[1.0, 1.0], bounds=([0.0, 1e-12], [np.inf, np.inf]), maxfev=20_000)
    except (RuntimeError, ValueError, OptimizeWarning, RuntimeWarning, FloatingPointError) as error:
        raise ValueError("Michaelis-Menten fitting did not converge to identifiable parameters.") from error
    vmax, km = map(float, parameters)
    jacobian = np.column_stack((x / (km + x), -vmax * x / (km + x) ** 2))
    if not np.isfinite(parameters).all() or not np.isfinite(covariance).all() or vmax <= 0 or km <= 1.01e-12 or np.linalg.cond(jacobian) > 1e8:
        raise ValueError("Measured data do not identify stable positive Michaelis-Menten parameters.")
    predicted = model(x, vmax, km)
    residuals = y - predicted
    ss_total = float(np.sum((y - y.mean()) ** 2))
    if ss_total <= np.finfo(float).eps ** 2 * len(y):
        raise ValueError("Velocity variation is too small for stable fitting.")
    errors = np.sqrt(np.maximum(np.diag(covariance), 0.0))
    result = {
        "n": len(x), "vmax": vmax * velocity_scale, "km": km * substrate_scale,
        "vmax_standard_error": float(errors[0]) * velocity_scale, "km_standard_error": float(errors[1]) * substrate_scale,
        "r_squared": 1.0 - float(residuals @ residuals) / ss_total,
        "residual_degrees_of_freedom": len(x) - 2, "fitted_velocities": (predicted * velocity_scale).tolist(),
        "residuals": (residuals * velocity_scale).tolist(), **units,
        "method": "Unweighted nonlinear least squares: v = Vmax * S / (Km + S), positive parameters",
        "limitations": ["Fits only supplied measured concentrations and initial velocities; no measurements are simulated.",
                        "Km uses substrate_unit and Vmax uses velocity_unit. No kcat or catalytic efficiency is inferred.",
                        "Fit quality does not establish a reaction mechanism; parameter errors assume independent homoscedastic residuals."],
    }
    if not all(math.isfinite(result[key]) for key in ("vmax", "km", "vmax_standard_error", "km_standard_error", "r_squared")):
        raise ValueError("Fit exceeds the supported finite numeric range.")
    return result


def _schema(properties, required):
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


_PROTEIN_SCHEMA = {"type": "string", "minLength": 1, "maxLength": 10000}
_NUMBERS_SCHEMA = {"type": "array", "items": {"type": "number"}, "minItems": 4, "maxItems": 5000}
_GENES_SCHEMA = {"type": "array", "items": {"type": "string", "minLength": 1, "maxLength": 100}, "minItems": 1, "maxItems": 5000}


def _tool(title, description, schema, example, path, function, *, dependency=False, native=False):
    return {"title": title, "description": description, "input_schema": schema, "example": example,
            "dependency": ["numpy", "scipy"] if dependency else [], "implementation": "proto-native" if native else "biomni-adapted",
            "upstream_functions": [{"path": path, "name": function}]}


TOOLS = {
    "analyze_rna_secondary_structure_features": _tool(
        "RNA secondary-structure features", "Count stems and correctly nested loop topology from supplied dot-bracket notation; no energy inference.",
        _schema({"dot_bracket_structure": _PROTEIN_SCHEMA, "sequence": _PROTEIN_SCHEMA}, ["dot_bracket_structure"]),
        {"dot_bracket_structure": "(((...)))", "sequence": "GGGAAACCC"}, "biomni/tool/biochemistry.py", "analyze_rna_secondary_structure_features"),
    "find_n_glycosylation_motifs": _tool(
        "N-glycosylation sequon scan", "Find canonical N-X-[S/T] sequence motifs; motif presence does not establish glycosylation.",
        _schema({"sequence": _PROTEIN_SCHEMA, "allow_overlap": {"type": "boolean", "default": False}}, ["sequence"]),
        {"sequence": "MNNSTANPTNAT", "allow_overlap": True}, "biomni/tool/glycoengineering.py", "find_n_glycosylation_motifs"),
    "predict_o_glycosylation_hotspots": _tool(
        "Heuristic O-glycosylation hotspots", "Unvalidated S/T density heuristic; returns candidate sites, not probabilities or confirmed modifications.",
        _schema({"sequence": _PROTEIN_SCHEMA, "window": {"type": "integer", "minimum": 3, "maximum": 101, "default": 7},
                 "min_st_fraction": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.4}, "disallow_proline_next": {"type": "boolean", "default": True}}, ["sequence"]),
        {"sequence": "MASSTTAPSTSA", "window": 7, "min_st_fraction": 0.4}, "biomni/tool/glycoengineering.py", "predict_o_glycosylation_hotspots"),
    "analyze_protein_conservation": _tool(
        "Prealigned protein conservation", "Calculate column conservation on supplied alignments; gaps lower conservation. No alignment or phylogenetic inference.",
        _schema({"aligned_sequences": {"type": "array", "items": _PROTEIN_SCHEMA, "minItems": 2, "maxItems": 200}}, ["aligned_sequences"]),
        {"aligned_sequences": ["ACD-EF", "ACDGEF", "ACE-EF"]}, "biomni/tool/biochemistry.py", "analyze_protein_conservation"),
    "gene_set_enrichment_analysis": _tool(
        "Offline gene-set over-representation", "Hypergeometric over-representation with explicit gene sets and background, plus BH correction over all tested sets. Not Enrichr or ranked GSEA parity.",
        _schema({"genes": _GENES_SCHEMA, "background": _GENES_SCHEMA,
                 "gene_sets": {"type": "array", "minItems": 1, "maxItems": 200, "items": _schema({"name": {"type": "string", "minLength": 1, "maxLength": 100}, "genes": _GENES_SCHEMA}, ["name", "genes"])},
                 "top_k": {"type": "integer", "minimum": 1, "maximum": 200}}, ["genes", "background", "gene_sets"]),
        {"genes": ["gene_a", "gene_b"], "background": ["gene_a", "gene_b", "gene_c", "gene_d", "gene_e"],
         "gene_sets": [{"name": "illustrative_set", "genes": ["gene_a", "gene_b"]}]}, "biomni/tool/genomics.py", "gene_set_enrichment_analysis", dependency=True),
    "perform_cosinor_analysis": _tool(
        "Fixed-period cosinor fit", "Fit a supplied time series with linear sine/cosine terms and a positive-amplitude phase convention.",
        _schema({"time_data": _NUMBERS_SCHEMA, "physiological_data": _NUMBERS_SCHEMA, "period": {"type": "number", "exclusiveMinimum": 0, "default": 24}}, ["time_data", "physiological_data"]),
        {"time_data": [0, 4, 8, 12, 16, 20], "physiological_data": [12, 11, 9, 8, 9, 11], "period": 24}, "biomni/tool/physiology.py", "perform_cosinor_analysis", dependency=True),
    "fit_michaelis_menten": _tool(
        "Measured-data Michaelis-Menten fit", "Fit Vmax and Km from supplied substrate concentrations and measured velocities; returns no simulated data or kcat.",
        _schema({"substrate_concentrations": _NUMBERS_SCHEMA, "velocities": _NUMBERS_SCHEMA,
                 "substrate_unit": {"type": "string", "minLength": 1, "maxLength": 80}, "velocity_unit": {"type": "string", "minLength": 1, "maxLength": 80}}, ["substrate_concentrations", "velocities"]),
        {"substrate_concentrations": [1, 2, 4, 8, 16], "velocities": [2, 3.3333333333, 5, 6.6666666667, 8], "substrate_unit": "concentration units", "velocity_unit": "rate units"},
        "biomni/tool/biochemistry.py", "analyze_enzyme_kinetics_assay", dependency=True, native=True),
}
TOOLS["fit_michaelis_menten"]["upstream_functions"].append({"path": "biomni/tool/biochemistry.py", "name": "analyze_protease_kinetics"})

HANDLERS = {name: globals()[name] for name in TOOLS}
