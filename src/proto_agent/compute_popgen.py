"""Bounded population-genetic, chromatin, and network analyses adapted from Biomni.

Portions adapted from Biomni (Stanford SNAP), Apache License 2.0, commit
400c1f366b96a35ca253e13c9b06c5076af41d65. See
apps/proto-workbench/THIRD_PARTY_NOTICES.md and the packaged Apache license.
Modifications: JSON/worker-file inputs replace pandas/CSV orchestration, VCF
and artifact writes become structured results, a pure-Python Needleman-Wunsch
aligner replaces Bio.pairwise2 with the same scoring, the DDR network keeps
the gene list, edge rule, and centrality/synthetic-lethality logic while
routing enrichment to Proto's offline hypergeometric tool instead of Enrichr,
and the metabolic perturbation keeps the mass-action ODE loop over an SBML
model file (cobra) instead of running a runnable model object.
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


def _string(value, name, maximum=100):
    if not isinstance(value, str) or not 1 <= len(value) <= maximum or value.strip() != value:
        raise ValueError(f"{name} must be a nonempty trimmed string of at most {maximum} characters.")
    return value


def simulate_demographic_history(arguments, files=None):
    """msprime transcription of the five upstream demographic models."""
    samples = int(arguments.get("num_samples", 10)) if isinstance(arguments.get("num_samples", 10), int) and not isinstance(arguments.get("num_samples", 10), bool) and 2 <= arguments.get("num_samples", 10) <= 500 else None
    if samples is None:
        raise ValueError("num_samples must be an integer from 2 to 500.")
    length = _number(arguments.get("sequence_length", 1000000), "sequence_length", positive=True, maximum=1e9)
    recombination = _number(arguments.get("recombination_rate", 1e-8), "recombination_rate", minimum=0, maximum=1.0)
    mutation = _number(arguments.get("mutation_rate", 1e-8), "mutation_rate", minimum=0, maximum=1.0)
    model = arguments.get("demographic_model", "constant")
    if model not in ("constant", "bottleneck", "expansion", "contraction", "sawtooth"):
        raise ValueError("demographic_model must be constant, bottleneck, expansion, contraction, or sawtooth.")
    coalescent = arguments.get("coalescent_model", "kingman")
    if coalescent not in ("kingman", "beta"):
        raise ValueError("coalescent_model must be kingman or beta.")
    seed = int(arguments.get("random_seed", 7)) if isinstance(arguments.get("random_seed", 7), int) and not isinstance(arguments.get("random_seed", 7), bool) and 0 <= arguments.get("random_seed", 7) < 2**31 else None
    if seed is None:
        raise ValueError("random_seed must be an integer from 0 to 2147483647.")
    parameters = arguments.get("demographic_params", {})
    if not isinstance(parameters, dict) or any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in parameters.values()):
        raise ValueError("demographic_params must be a numeric object.")
    import msprime

    demography = msprime.Demography()
    if model == "constant":
        demography.add_population(name="pop0", initial_size=parameters.get("N", 10000))
    elif model == "bottleneck":
        demography.add_population(name="pop0", initial_size=parameters.get("N_initial", 10000))
        demography.add_population_parameters_change(time=parameters.get("T_recovery", 500), initial_size=parameters.get("N_bottleneck", 1000))
        demography.add_population_parameters_change(time=parameters.get("T_bottleneck", 1000), initial_size=parameters.get("N_initial", 10000))
    elif model in ("expansion", "contraction"):
        demography.add_population(name="pop0", initial_size=parameters.get("N_final", 10000 if model == "contraction" else 1000))
        demography.add_population_parameters_change(time=parameters.get(f"T_{model}", 1000), initial_size=parameters.get("N_initial", 1000 if model == "expansion" else 10000))
    else:
        sizes, times = parameters.get("N_values", [10000, 5000, 15000, 7500]), parameters.get("times", [500, 1000, 1500])
        if not isinstance(sizes, list) or not isinstance(times, list) or len(sizes) != len(times) + 1:
            raise ValueError("sawtooth needs N_values with exactly one more entry than times.")
        demography.add_population(name="pop0", initial_size=sizes[0])
        for index, time in enumerate(times):
            demography.add_population_parameters_change(time=time, initial_size=sizes[index + 1])
    coalescent_model = msprime.StandardCoalescent() if coalescent == "kingman" else msprime.BetaCoalescent(alpha=parameters.get("alpha", 1.5))
    ts = msprime.sim_ancestry(samples=samples, recombination_rate=recombination, sequence_length=length,
                              demography=demography, model=coalescent_model, random_seed=seed)
    mts = msprime.sim_mutations(ts, rate=mutation, random_seed=seed)
    diversity = float(mts.diversity())
    return {"samples": samples, "sequence_length": int(length), "demographic_model": model, "coalescent_model": coalescent,
            "segregating_sites": int(mts.num_sites), "num_trees": int(mts.num_trees),
            "nucleotide_diversity": round(diversity, 10), "random_seed": seed,
            "method": "msprime ancestry + mutations over the upstream demographic models (constant/bottleneck/expansion/contraction/sawtooth)",
            "limitations": ["Diversity is a genome-wide average; VCF output that upstream wrote is not produced.",
                            "Sawtooth and Beta-coalescent parameters are caller-supplied and unvalidated against any population."]}


def analyze_chromatin_interactions(arguments, files):
    """cooler-based enhancer-promoter loops and insulation TADs from a .cool file."""
    if files.get("hic_file_path") is None:
        raise ValueError("hic_file_path must reference a cooler (.cool/.mcool) file in the workspace.")
    elements = arguments.get("regulatory_elements")
    if not isinstance(elements, list) or not 1 <= len(elements) <= 5000:
        raise ValueError("regulatory_elements must contain 1 to 5000 entries.")
    parsed = []
    for index, element in enumerate(elements):
        if not isinstance(element, dict) or not {"chromosome", "start", "end", "name", "kind"} <= set(element):
            raise ValueError(f"regulatory_elements[{index}] must contain chromosome, start, end, name, and kind.")
        kind = element["kind"]
        if kind not in ("enhancer", "promoter"):
            raise ValueError(f"regulatory_elements[{index}].kind must be enhancer or promoter.")
        parsed.append((element["chromosome"], int(element["start"]), int(element["end"]), element["name"], kind))
    fold_threshold = _number(arguments.get("fold_enrichment_threshold", 2.0), "fold_enrichment_threshold", positive=True, maximum=1000)
    import tempfile
    from pathlib import Path

    import cooler
    import numpy as np
    from scipy import stats as scipy_stats

    with tempfile.NamedTemporaryFile(suffix=".cool", delete=False) as handle:
        handle.write(files["hic_file_path"])
        temporary = Path(handle.name)
    c = cooler.Cooler(str(temporary))
    binsize = c.binsize
    interactions = []
    by_chrom = {}
    for chromosome, start, end, name, kind in parsed:
        by_chrom.setdefault(chromosome, {"enhancer": [], "promoter": []})[kind].append((start, end, name))
    for chromosome, groups in by_chrom.items():
        if chromosome not in c.chromnames or not groups["enhancer"] or not groups["promoter"]:
            continue
        try:
            matrix = c.matrix(balance=True).fetch(chromosome)
        except ValueError:
            matrix = c.matrix(balance=False).fetch(chromosome)
        matrix = np.nan_to_num(np.asarray(matrix, dtype=float))
        for enh_start, _e, enh_name in groups["enhancer"]:
            enh_bin = int(enh_start // binsize)
            for prom_start, _p, prom_name in groups["promoter"]:
                prom_bin = int(prom_start // binsize)
                if enh_bin == prom_bin or enh_bin >= matrix.shape[0] or prom_bin >= matrix.shape[0]:
                    continue
                strength = float(matrix[enh_bin, prom_bin])
                distance = abs(enh_bin - prom_bin)
                diagonal = np.diagonal(matrix, offset=distance)
                expected = float(np.mean(diagonal)) if diagonal.size else 0.0
                if expected > 0 and strength / expected > fold_threshold:
                    interactions.append({"chromosome": chromosome, "enhancer": enh_name, "promoter": prom_name,
                                         "enhancer_start": enh_start, "promoter_start": prom_start,
                                         "interaction_strength": round(strength, 6),
                                         "fold_enrichment": round(strength / expected, 6)})
    interactions.sort(key=lambda row: -row["fold_enrichment"])
    tads = []
    window = 5
    for chromosome in c.chromnames:
        try:
            matrix = np.nan_to_num(np.asarray(c.matrix(balance=True).fetch(chromosome), dtype=float))
        except ValueError:
            continue
        if matrix.shape[0] <= 2 * window + 2:
            continue
        insulation = np.array([matrix[i - window:i, i:i + window].sum() for i in range(window, matrix.shape[0] - window)])
        if insulation.size == 0 or np.std(insulation) == 0:
            continue
        insulation = scipy_stats.zscore(insulation)
        boundaries = [i + window for i in range(1, len(insulation) - 1)
                      if insulation[i] < insulation[i - 1] and insulation[i] < insulation[i + 1] and insulation[i] < -1]
        tads.extend({"chromosome": chromosome, "start_bin": boundaries[i], "end_bin": boundaries[i + 1],
                     "start_bp": boundaries[i] * binsize, "end_bp": boundaries[i + 1] * binsize}
                    for i in range(len(boundaries) - 1))
    temporary.unlink()
    return {"resolution_bp": binsize, "chromosomes": c.chromnames[:50],
            "regulatory_elements": len(parsed),
            "interactions": interactions[:200], "interaction_count": len(interactions),
            "tads": tads[:200], "tad_count": len(tads),
            "method": "Cooler cis matrices: distance-expected fold enrichment for enhancer-promoter pairs; z-scored insulation minima as TAD boundaries",
            "limitations": ["Loop calling by diagonal mean is upstream's coarse expected-value heuristic, not HiCCUPS or FitHiC significance.",
                            "TAD boundaries use the upstream insulation window of 5 bins and a z < -1 cutoff; resolution-dependent.",
                            "Balancing falls back to raw counts when weights are missing; scales are then not comparable across datasets."]}


def simulate_metabolic_network_perturbation(arguments, files):
    """cobra SBML model + upstream mass-action ODE loop with a step perturbation."""
    if files.get("model_path") is None:
        raise ValueError("model_path must reference an SBML model file in the workspace.")
    import tempfile
    from pathlib import Path

    perturbation = arguments.get("perturbation")
    if (not isinstance(perturbation, dict)
            or not {"metabolite", "factor", "time"} <= set(perturbation)
            or any(isinstance(perturbation[k], bool) or not isinstance(perturbation[k], (int, float)) for k in ("factor", "time"))):
        raise ValueError("perturbation must contain metabolite, factor, and time numbers.")
    duration = _number(arguments.get("simulation_time", 10.0), "simulation_time", positive=True, maximum=1e4)
    points = int(arguments.get("time_points", 100)) if isinstance(arguments.get("time_points", 100), int) and not isinstance(arguments.get("time_points", 100), bool) and 10 <= arguments.get("time_points", 100) <= 1000 else None
    if points is None:
        raise ValueError("time_points must be an integer from 10 to 1000.")
    import cobra
    import numpy as np
    from scipy.integrate import solve_ivp

    with tempfile.NamedTemporaryFile(suffix=".xml", delete=False) as handle:
        handle.write(files["model_path"])
        temporary = Path(handle.name)
    model = cobra.io.read_sbml_model(str(temporary))
    temporary.unlink()
    metabolites = list(model.metabolites)
    identifiers = [metabolite.id for metabolite in metabolites]
    if perturbation["metabolite"] not in identifiers:
        raise ValueError(f"Perturbation metabolite {perturbation['metabolite']!r} is not in the model.")
    concentrations = np.ones(len(metabolites))
    index_of = {identifier: index for index, identifier in enumerate(identifiers)}
    reactions = [(reaction.id, [(index_of[m.id], c) for m, c in reaction.metabolites.items()]) for reaction in model.reactions]
    perturb_index, perturb_factor, perturb_time = index_of[perturbation["metabolite"]], float(perturbation["factor"]), float(perturbation["time"])
    applied = False

    def odes(t, y):
        nonlocal applied
        if not applied and t >= perturb_time:
            y[perturb_index] *= perturb_factor
            applied = True
        rates = []
        for _rid, stoichiometry in reactions:
            rate = 1.0
            for _index, coefficient in stoichiometry:
                if coefficient < 0:
                    rate *= max(y[_index], 0.0) ** abs(coefficient)
            rates.append(rate)
        derivative = np.zeros(len(y))
        for (_rid, stoichiometry), rate in zip(reactions, rates):
            for index, coefficient in stoichiometry:
                derivative[index] += coefficient * rate
        return derivative

    solution = solve_ivp(odes, (0.0, duration), concentrations, method="LSODA",
                         t_eval=np.linspace(0.0, duration, points), rtol=1e-6, atol=1e-9)
    if not solution.success or not np.isfinite(solution.y).all():
        raise ValueError(f"Perturbation simulation failed: {solution.message}.")
    transition = int(np.searchsorted(solution.t, perturb_time))
    pre, post = solution.y[:, max(transition - 1, 0)], solution.y[:, min(transition, points - 1)]
    changes = sorted(({"metabolite": identifiers[i],
                       "relative_change": round(abs(post[i] - pre[i]) / pre[i], 6) if pre[i] > 0 else None}
                      for i in range(len(identifiers))
                      if pre[i] > 0 and abs(post[i] - pre[i]) / pre[i] > 0.05),
                     key=lambda row: -(row["relative_change"] or 0))
    sampled = range(0, points, max(1, points // 50))
    return {"metabolites": len(identifiers), "reactions": len(reactions),
            "perturbation": {"metabolite": perturbation["metabolite"], "factor": perturb_factor, "time": perturb_time},
            "significant_changes": changes[:20], "significant_change_count": len(changes),
            "times": [round(float(solution.t[i]), 4) for i in sampled],
            "concentration_traces": {identifiers[i]: [round(float(solution.y[i, j]), 6) for j in sampled]
                                     for i in sorted({0, perturb_index} | {index_of[row["metabolite"]] for row in changes[:3]})},
            "method": "Unit-rate mass-action ODEs over the SBML stoichiometry with a one-off multiplicative perturbation (upstream's demonstration kinetics)",
            "limitations": ["All basal rate constants are 1.0 exactly as upstream; the model shows topology-driven propagation, not calibrated metabolism.",
                            "Substrate rates clamp negative concentrations to zero to keep the solver finite; exchange bounds and objectives are ignored."]}


_DDDR_GENES = ["ATM", "ATR", "PRKDC", "RAD50", "MRE11", "NBN", "CHEK1", "CHEK2", "TP53", "BRCA1", "BRCA2",
               "MDC1", "H2AX", "RAD51", "RAD52", "PALB2", "RAD54L", "XRCC4", "LIG4", "XRCC5", "XRCC6", "PARP1",
               "APEX1", "OGG1", "XRCC1", "XPA", "XPC", "ERCC1", "ERCC2", "ERCC3", "ERCC4", "ERCC5", "MLH1", "MSH2", "MSH6", "PMS2"]


def analyze_ddr_network_in_cancer(arguments, files=None):
    """Upstream's DDR correlation network with Enrichr swapped for offline ORA."""
    expression = arguments.get("expression_matrix")
    mutation = arguments.get("mutation_matrix")
    for name, value in (("expression_matrix", expression), ("mutation_matrix", mutation)):
        if not isinstance(value, list) or not 3 <= len(value) <= 200:
            raise ValueError(f"{name} must contain 3 to 200 gene rows of {{gene, values}}.")
    correlation_threshold = _number(arguments.get("correlation_threshold", 0.4), "correlation_threshold", minimum=0, maximum=1)

    def parse_matrix(matrix, name):
        rows, identifiers = [], []
        width = None
        for index, row in enumerate(matrix):
            if not isinstance(row, dict) or set(row) != {"gene", "values"} or not isinstance(row["values"], list):
                raise ValueError(f"{name}[{index}] must contain gene and values.")
            gene = _string(row["gene"], f"{name}[{index}].gene")
            values = row["values"]
            if width is None:
                width = len(values)
            if len(values) != width or not 3 <= len(values) <= 500:
                raise ValueError(f"{name} rows must share a sample count between 3 and 500.")
            for position, item in enumerate(values):
                if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(float(item)) or abs(float(item)) > 1e100:
                    raise ValueError(f"{name}[{index}].values must be finite numbers.")
            identifiers.append(gene)
            rows.append([float(v) for v in values])
        return identifiers, rows

    expr_genes, expr_rows = parse_matrix(expression, "expression_matrix")
    mut_genes, mut_rows = parse_matrix(mutation, "mutation_matrix")
    genes = [gene for gene in _DDDR_GENES if gene in expr_genes]
    if len(genes) < 5:
        raise ValueError("At least five DDR genes must be present in expression_matrix (upstream list).")
    mutation_frequency = {gene: (sum(mut_rows[mut_genes.index(gene)]) / len(mut_rows[0]) if gene in mut_genes else 0.0) for gene in genes}
    import numpy as np
    from scipy.stats import pearsonr

    matrix = {gene: np.asarray(expr_rows[expr_genes.index(gene)]) for gene in genes}
    edges = []
    for i, first in enumerate(genes):
        for second in genes[i + 1:]:
            correlation, p_value = pearsonr(matrix[first], matrix[second])
            if abs(correlation) > correlation_threshold and p_value < 0.05:
                edges.append((first, second, round(float(correlation), 6)))
    degree = {gene: 0 for gene in genes}
    for first, second, _c in edges:
        degree[first] += 1
        degree[second] += 1
    betweenness = {gene: 0.0 for gene in genes}
    # Unweighted shortest-path betweenness (Brandes) over the correlation graph.
    adjacency = {gene: [] for gene in genes}
    for first, second, _c in edges:
        adjacency[first].append(second)
        adjacency[second].append(first)
    import collections

    for source in genes:
        stack, queue, paths, distance = [], collections.deque([source]), {v: 1 for v in [source]}, {source: 0}
        predecessors = {v: [] for v in genes}
        while queue:
            node = queue.popleft()
            stack.append(node)
            for neighbor in adjacency[node]:
                if neighbor not in distance:
                    distance[neighbor] = distance[node] + 1
                    queue.append(neighbor)
                if distance.get(neighbor) == distance[node] + 1:
                    paths[neighbor] = paths.get(neighbor, 0) + paths.get(node, 0)
                    predecessors[neighbor].append(node)
        dependency = {v: 0.0 for v in genes}
        while stack:
            node = stack.pop()
            for predecessor in predecessors[node]:
                dependency[predecessor] += (paths.get(predecessor, 0) / paths.get(node, 1)) * (1 + dependency[node])
            if node != source:
                betweenness[node] += dependency[node]
    scale = max(1.0, (len(genes) - 1) * (len(genes) - 2))
    synthetic_lethal = []
    for first, second, correlation in edges:
        f1, f2 = mutation_frequency[first], mutation_frequency[second]
        if abs(correlation) > 0.6 and ((f1 > 0.1 and f2 < 0.05) or (f2 > 0.1 and f1 < 0.05)):
            pair = (first, second) if f1 > f2 else (second, first)
            synthetic_lethal.append({"mutated": pair[0], "dependency_candidate": pair[1], "correlation": correlation})
    synthetic_lethal.sort(key=lambda row: -mutation_frequency[row["mutated"]])
    hubs = sorted(((gene, degree[gene] / max(1, len(genes) - 1)) for gene in genes), key=lambda pair: -pair[1])
    bottlenecks = sorted(((gene, betweenness[gene] / scale) for gene in genes), key=lambda pair: -pair[1])
    mutated = sorted(mutation_frequency.items(), key=lambda pair: -pair[1])
    return {"ddr_genes_found": len(genes), "nodes": genes,
            "edges": [{"a": a, "b": b, "correlation": c} for a, b, c in edges][:400], "edge_count": len(edges),
            "hub_genes": [{"gene": gene, "degree_centrality": round(value, 6)} for gene, value in hubs[:5]],
            "bottleneck_genes": [{"gene": gene, "betweenness": round(value, 6)} for gene, value in bottlenecks[:5]],
            "top_mutated": [{"gene": gene, "frequency": round(frequency, 6)} for gene, frequency in mutated[:5]],
            "synthetic_lethality_candidates": synthetic_lethal[:5],
            "method": f"Pearson coexpression network over the upstream DDR list (|r| > {correlation_threshold}, p < 0.05) with Brandes betweenness and upstream's synthetic-lethality rule",
            "limitations": ["Upstream's Enrichr/GSEA step is replaced by Proto's offline gene_set_enrichment_analysis; run that tool for pathway ORA.",
                            "Louvain community detection from python-louvain is omitted; sub-pathway structure is not inferred.",
                            "Correlation networks are coexpression evidence only; edges are not regulatory interactions."]}


def _align(reference, query, match=2.0, mismatch=-1.0, gap_open=-2.0, gap_extend=-0.5):
    """Global Needleman-Wunsch with affine gaps (upstream pairwise2.globalms scoring)."""
    n, m = len(reference), len(query)
    score = [[0.0] * (m + 1) for _ in range(n + 1)]
    pointer = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        score[i][0] = gap_open + (i - 1) * gap_extend
        pointer[i][0] = 1
    for j in range(1, m + 1):
        score[0][j] = gap_open + (j - 1) * gap_extend
        pointer[0][j] = 2
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            diagonal = score[i - 1][j - 1] + (match if reference[i - 1] == query[j - 1] else mismatch)
            if pointer[i - 1][j] == 1:
                up = score[i - 1][j] + gap_extend
            else:
                up = score[i - 1][j] + gap_open
            if pointer[i][j - 1] == 2:
                left = score[i][j - 1] + gap_extend
            else:
                left = score[i][j - 1] + gap_open
            best, pointer[i][j] = max((diagonal, 0), (up, 1), (left, 2))
            score[i][j] = best
    aligned_reference, aligned_query = [], []
    i, j = n, m
    while i or j:
        direction = pointer[i][j] if (i and j) else (1 if i else 2)
        if direction == 0:
            aligned_reference.append(reference[i - 1]); aligned_query.append(query[j - 1]); i, j = i - 1, j - 1
        elif direction == 1:
            aligned_reference.append(reference[i - 1]); aligned_query.append("-"); i -= 1
        else:
            aligned_reference.append("-"); aligned_query.append(query[j - 1]); j -= 1
    return "".join(reversed(aligned_reference)), "".join(reversed(aligned_query)), score[n][m]


def _indel_blocks(aligned_reference, aligned_query):
    deletions, insertions = [], []
    i = 0
    while i < len(aligned_reference):
        if aligned_reference[i] == "-":
            start = i
            while i < len(aligned_reference) and aligned_reference[i] == "-":
                i += 1
            insertions.append((start, i - start))
        elif aligned_query[i] == "-":
            start = i
            while i < len(aligned_query) and aligned_query[i] == "-":
                i += 1
            deletions.append((start, i - start))
        else:
            i += 1
    return deletions, insertions


_DNA = frozenset("ACGT")
_COMPLEMENT = {"A": "T", "T": "A", "C": "G", "G": "C"}


def _dna(value, name, maximum=20000):
    if not isinstance(value, str) or not value.isascii() or not 4 <= len(value) <= maximum:
        raise ValueError(f"{name} must contain 4 to {maximum} bases.")
    sequence = value.upper()
    if not set(sequence) <= _DNA:
        raise ValueError(f"{name} must contain only A, C, G, and T.")
    return sequence


def _revcomp(sequence):
    return "".join(_COMPLEMENT[base] for base in reversed(sequence))


def analyze_cas9_mutation_outcomes(arguments, files=None):
    """Upstream's pairwise2 alignment replaced by the same-scoring NW aligner."""
    sites = arguments.get("target_sites")
    if not isinstance(sites, list) or not 1 <= len(sites) <= 200:
        raise ValueError("target_sites must contain 1 to 200 entries.")
    total_reads = 0
    categorized = {"no_mutation": 0, "short_deletion": 0, "medium_deletion": 0, "long_deletion": 0,
                   "single_insertion": 0, "longer_insertion": 0, "indel": 0}
    rows = []
    for index, site in enumerate(sites):
        if not isinstance(site, dict) or set(site) != {"reference", "reads"} or not isinstance(site["reads"], list):
            raise ValueError(f"target_sites[{index}] must contain reference and reads.")
        reference = _dna(site["reference"], f"target_sites[{index}].reference")
        if not 1 <= len(site["reads"]) <= 500:
            raise ValueError(f"target_sites[{index}].reads must contain 1 to 500 sequences.")
        for read_index, read in enumerate(site["reads"]):
            read = _dna(read, f"target_sites[{index}].reads[{read_index}]")
            aligned_reference, aligned_query, _score = _align(reference, read)
            deletions, insertions = _indel_blocks(aligned_reference, aligned_query)
            deletion_count = sum(length for _s, length in deletions)
            insertion_count = sum(length for _s, length in insertions)
            if deletion_count and insertion_count:
                kind = "indel"
            elif deletion_count:
                kind = "short_deletion" if deletion_count <= 10 else "medium_deletion" if deletion_count <= 30 else "long_deletion"
            elif insertion_count:
                kind = "single_insertion" if insertion_count == 1 else "longer_insertion"
            else:
                kind = "no_mutation"
            categorized[kind] += 1
            total_reads += 1
            rows.append({"site": index, "read": read_index, "mutation_type": kind,
                         "deleted_bases": deletion_count, "inserted_bases": insertion_count})
    return {"reads": total_reads, "mutation_counts": categorized,
            "mutation_percent": {kind: round(count / total_reads * 100, 4) for kind, count in categorized.items()},
            "reads_detail": rows[:500],
            "method": "Global affine-gap alignment (match 2, mismatch -1, gap open -2, extend -0.5) with upstream's size-based outcome categories",
            "limitations": ["Upstream aligned with Bio.pairwise2; this port's Needleman-Wunsch uses the same scoring but may break ties differently.",
                            "Categories count net aligned gap bases; microhomology-mediated deletions are not modeled separately."]}


def analyze_crispr_genome_editing(arguments, files=None):
    original = _dna(arguments.get("original_sequence"), "original_sequence")
    edited = _dna(arguments.get("edited_sequence"), "edited_sequence")
    guide = _dna(arguments.get("guide_rna"), "guide_rna", 40)
    repair = arguments.get("repair_template")
    if repair is not None:
        repair = _dna(repair, "repair_template")
    strand = "+"
    position = original.find(guide)
    if position == -1:
        position = original.find(_revcomp(guide))
        strand = "-"
    aligned_original, aligned_edited, _score = _align(original, edited)
    substitutions, insertions, deletions = [], [], []
    reference_offset = 0
    for index, (base, other) in enumerate(zip(aligned_original, aligned_edited)):
        if base != other:
            if base == "-":
                insertions.append({"position": reference_offset, "inserted": other})
            elif other == "-":
                deletions.append({"position": reference_offset, "deleted": base})
            else:
                substitutions.append({"position": reference_offset, "from": base, "to": other})
        if base != "-":
            reference_offset += 1
    on_target = []
    if position != -1:
        window_start, window_end = position - 3, position + len(guide) + 3
        for edit in substitutions:
            if window_start <= edit["position"] < window_end:
                on_target.append({"kind": "substitution", **edit})
        for edit in deletions:
            if window_start <= edit["position"] < window_end:
                on_target.append({"kind": "deletion", **edit})
        for edit in insertions:
            if window_start <= edit["position"] <= window_end:
                on_target.append({"kind": "insertion", **edit})
    hdr = None
    if repair:
        marker_size = min(10, len(repair) // 3)
        marker = repair[len(repair) // 2 - marker_size // 2: len(repair) // 2 + marker_size // 2]
        hdr = {"marker": marker, "found_in_edited": marker in edited, "absent_in_original": marker not in original}
    editing_detected = bool(substitutions or insertions or deletions)
    return {"guide_found": position != -1, "guide_position_0based": position if position != -1 else None, "guide_strand": strand,
            "substitutions": substitutions, "deletions": deletions, "insertions": insertions,
            "substitution_count": len(substitutions), "deletion_count": len(deletions), "insertion_count": len(insertions),
            "on_target_edits": on_target, "repair_template_evidence": hdr,
            "editing_detected": editing_detected,
            "likely_mechanism": (None if hdr is None else ("homology_directed_repair" if hdr["found_in_edited"] and hdr["absent_in_original"] else "non_homologous_end_joining")),
            "position_basis": "0-based on the original sequence",
            "method": "Guide search on both strands, affine-gap edit enumeration, and upstream's centered-marker HDR check",
            "limitations": ["A global alignment attributes differences uniquely; repeat structure can misplace edit positions.",
                            "The HDR marker is upstream's centered-k-mer heuristic; short markers can occur by chance.",
                            "On-target calls use a +/-3 base window around the guide exactly as upstream."]}


def _schema(properties, required):
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


def _tool(title, description, schema, example, path, function, dependency=("numpy", "scipy"), file_inputs=None):
    entry = {"title": title, "description": description, "input_schema": schema, "example": example,
             "dependency": list(dependency), "implementation": "biomni-adapted",
             "upstream_functions": [{"path": path, "name": function}]}
    if file_inputs:
        entry["file_inputs"] = file_inputs
    return entry


_COOL_FILE = {"hic_file_path": {"extensions": [".cool", ".mcool"], "max_bytes": 512 * 1024 * 1024}}
_SBML_FILE = {"model_path": {"extensions": [".xml", ".sbml"], "max_bytes": 64 * 1024 * 1024}}


TOOLS = {
    "simulate_demographic_history": _tool(
        "Demographic history simulation", "Simulate sequence ancestry and mutations under constant, bottleneck, expansion, contraction, or sawtooth demographies (msprime).",
        _schema({"num_samples": {"type": "integer", "minimum": 2, "maximum": 500, "default": 10},
                 "sequence_length": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e9, "default": 1000000},
                 "recombination_rate": {"type": "number", "minimum": 0, "maximum": 1, "default": 1e-8},
                 "mutation_rate": {"type": "number", "minimum": 0, "maximum": 1, "default": 1e-8},
                 "demographic_model": {"type": "string", "enum": ["constant", "bottleneck", "expansion", "contraction", "sawtooth"], "default": "constant"},
                 "coalescent_model": {"type": "string", "enum": ["kingman", "beta"], "default": "kingman"},
                 "demographic_params": {"type": "object", "properties": {
                     "N": {"type": "number"}, "N_initial": {"type": "number"}, "N_bottleneck": {"type": "number"},
                     "T_bottleneck": {"type": "number"}, "T_recovery": {"type": "number"},
                     "T_expansion": {"type": "number"}, "T_contraction": {"type": "number"}, "N_final": {"type": "number"},
                     "N_values": {"type": "array", "items": {"type": "number"}, "minItems": 2, "maxItems": 20},
                     "times": {"type": "array", "items": {"type": "number"}, "minItems": 1, "maxItems": 19},
                     "alpha": {"type": "number"}}, "additionalProperties": False},
                 "random_seed": {"type": "integer", "minimum": 0, "maximum": 2147483647, "default": 7}}, []),
        {"num_samples": 8, "sequence_length": 100000, "demographic_model": "bottleneck",
         "demographic_params": {"N_initial": 10000, "N_bottleneck": 1000, "T_bottleneck": 500, "T_recovery": 200},
         "random_seed": 11},
        "biomni/tool/genetics.py", "simulate_demographic_history", ("msprime",)),
    "analyze_chromatin_interactions": _tool(
        "Hi-C enhancer-promoter interactions", "Call distance-enriched enhancer-promoter contacts and insulation-based TADs from a workspace cooler file.",
        _schema({"hic_file_path": {"type": "string", "minLength": 1, "maxLength": 400},
                 "regulatory_elements": {"type": "array", "minItems": 1, "maxItems": 5000, "items": _schema(
                     {"chromosome": {"type": "string", "minLength": 1, "maxLength": 40},
                      "start": {"type": "integer", "minimum": 0, "maximum": 2147483647},
                      "end": {"type": "integer", "minimum": 0, "maximum": 2147483648},
                      "name": {"type": "string", "minLength": 1, "maxLength": 100},
                      "kind": {"type": "string", "enum": ["enhancer", "promoter"]}},
                     ["chromosome", "start", "end", "name", "kind"])},
                 "fold_enrichment_threshold": {"type": "number", "exclusiveMinimum": 0, "maximum": 1000, "default": 2}},
                ["hic_file_path", "regulatory_elements"]),
        {"hic_file_path": "build/compute-inputs/hic.cool",
         "regulatory_elements": [{"chromosome": "chr1", "start": 2000000, "end": 2002000, "name": "e1", "kind": "enhancer"},
                                 {"chromosome": "chr1", "start": 2050000, "end": 2052000, "name": "p1", "kind": "promoter"}]},
        "biomni/tool/genomics.py", "analyze_chromatin_interactions", ("numpy", "scipy", "cooler"), _COOL_FILE),
    "simulate_metabolic_network_perturbation": _tool(
        "Metabolic perturbation simulation", "Run upstream's mass-action kinetics over an SBML model with a one-off metabolite perturbation (cobra + SciPy).",
        _schema({"model_path": {"type": "string", "minLength": 1, "maxLength": 400},
                 "perturbation": _schema({"metabolite": {"type": "string", "minLength": 1, "maxLength": 100},
                                          "factor": {"type": "number", "exclusiveMinimum": 0},
                                          "time": {"type": "number", "minimum": 0}}, ["metabolite", "factor", "time"]),
                 "simulation_time": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e4, "default": 10},
                 "time_points": {"type": "integer", "minimum": 10, "maximum": 1000, "default": 100}},
                ["model_path", "perturbation"]),
        {"model_path": "build/compute-inputs/network.xml",
         "perturbation": {"metabolite": "A", "factor": 0.1, "time": 2.0}, "simulation_time": 6.0, "time_points": 60},
        "biomni/tool/systems_biology.py", "simulate_metabolic_network_perturbation", ("numpy", "scipy", "cobra"), _SBML_FILE),
    "analyze_ddr_network_in_cancer": _tool(
        "DDR coexpression network", "Build the upstream DDR-gene correlation network with hubs, bottlenecks, mutation ranks, and synthetic-lethality candidates.",
        _schema({"expression_matrix": {"type": "array", "minItems": 3, "maxItems": 200, "items": _schema(
                     {"gene": {"type": "string", "minLength": 1, "maxLength": 100},
                      "values": {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 500}}, ["gene", "values"])},
                 "mutation_matrix": {"type": "array", "minItems": 3, "maxItems": 200, "items": _schema(
                     {"gene": {"type": "string", "minLength": 1, "maxLength": 100},
                      "values": {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 500}}, ["gene", "values"])},
                 "correlation_threshold": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.4}},
                ["expression_matrix", "mutation_matrix"]),
        {"expression_matrix": [{"gene": "ATM", "values": [5.1, 5.3, 4.9, 5.2]}, {"gene": "ATR", "values": [4.2, 4.4, 4.0, 4.3]},
                               {"gene": "TP53", "values": [7.0, 7.1, 6.8, 7.2]}, {"gene": "BRCA1", "values": [6.1, 6.0, 6.2, 6.1]},
                               {"gene": "BRCA2", "values": [3.3, 3.1, 3.4, 3.2]}],
         "mutation_matrix": [{"gene": "ATM", "values": [1, 1, 0, 1]}, {"gene": "ATR", "values": [0, 0, 0, 0]},
                             {"gene": "TP53", "values": [1, 0, 1, 1]}, {"gene": "BRCA1", "values": [0, 0, 0, 0]},
                             {"gene": "BRCA2", "values": [0, 0, 0, 0]}]},
        "biomni/tool/cancer_biology.py", "analyze_ddr_network_in_cancer"),
    "analyze_cas9_mutation_outcomes": _tool(
        "Cas9 mutation outcomes", "Align edited reads to references and categorize indel outcomes with upstream's size buckets.",
        _schema({"target_sites": {"type": "array", "minItems": 1, "maxItems": 200, "items": _schema(
                     {"reference": {"type": "string", "minLength": 4, "maxLength": 20000},
                      "reads": {"type": "array", "minItems": 1, "maxItems": 500, "items": {"type": "string", "minLength": 4, "maxLength": 20000}}},
                     ["reference", "reads"])}}, ["target_sites"]),
        {"target_sites": [{"reference": "ACGTACGTGGGACGTACGTACGTACGTCACGT", "reads": [
            "ACGTACGTGGGACGTACGTACGTACGTCACGT",
            "ACGTACGTGGGACGTACGTACGTCACGT",
            "ACGTACGTGGGACGTACGTATTTTCGTACGTCACGT",
            "ACGTACGTGGGACGTACGCACGT"]}]},
        "biomni/tool/genetics.py", "analyze_cas9_mutation_outcomes", ()),
    "analyze_crispr_genome_editing": _tool(
        "CRISPR editing analysis", "Enumerate substitutions, insertions, and deletions between original and edited sequences relative to the guide site.",
        _schema({"original_sequence": {"type": "string", "minLength": 4, "maxLength": 20000},
                 "edited_sequence": {"type": "string", "minLength": 4, "maxLength": 20000},
                 "guide_rna": {"type": "string", "minLength": 4, "maxLength": 40},
                 "repair_template": {"type": "string", "minLength": 4, "maxLength": 2000}},
                ["original_sequence", "edited_sequence", "guide_rna"]),
        {"original_sequence": "TTTACGTACGTGGGACGTACGTACGTACGTACGTCCC",
         "edited_sequence": "TTTACGTACGTGGTACGTACGTACGTACGTACGTCCC",
         "guide_rna": "ACGTACGTGGGACGTACGTA", "repair_template": "TTTACGTACGTGGGACGTACGTACGTACGTACGTCCC"},
        "biomni/tool/genetics.py", "analyze_crispr_genome_editing", ()),
}
HANDLERS = {name: globals()[name] for name in TOOLS}
