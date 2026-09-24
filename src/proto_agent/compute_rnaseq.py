"""Source-bound RNA-seq studies using the existing fixed DESeq2 adapter.

This module validates data and joins existing analysis engines. It does not
implement a replacement differential-expression estimator or execute user code.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
from pathlib import Path
from uuid import uuid4

from .compute_bio import gene_set_enrichment_analysis
from .rnaseq_data import parse_rnaseq_inputs
from .security import WorkspacePaths, read_bytes_bounded, write_text_bounded

SCHEMA = "proto-agent.rnaseq-study.v1"
MAX_FILE = 32 * 1024 * 1024
MAX_RESULT = 32 * 1024 * 1024
DEFAULTS = {"analysis_mode": "fit", "design": "condition", "alpha": .05,
            "min_count": 10, "min_samples": 2, "pca_top_genes": 500,
            "size_factor_type": "ratio"}
ENRICHMENT_METHOD = "hypergeometric ORA with Benjamini-Hochberg correction"
BACKGROUND_RULE = "genes with finite adjusted p-value in this contrast"
SELECTION_RULE = "padj < alpha; both directions"


def run_bioinformatics(*args, **kwargs):
    # The existing adapter imports the shared Compute request validator. Delay
    # this import until execution to keep catalogue discovery acyclic.
    from .bioinformatics import run_bioinformatics as execute
    return execute(*args, **kwargs)


def _digest(data):
    return hashlib.sha256(data).hexdigest()


def _csv(data, required, *, maximum=100000):
    try:
        reader = csv.DictReader(io.StringIO(data.decode("utf-8-sig"), newline=""), strict=True)
        header = reader.fieldnames
        if not header or len(header) != len(set(header)) or not set(required) <= set(header):
            raise ValueError("Engine CSV has missing or duplicated columns.")
        rows = []
        for row in reader:
            if None in row or any(value is None for value in row.values()):
                raise ValueError("Engine CSV contains an incomplete or ragged row.")
            rows.append(row)
            if len(rows) > maximum:
                raise ValueError("Engine CSV exceeds its row bound.")
        return rows
    except (UnicodeError, csv.Error) as exc:
        raise ValueError("Engine CSV is not valid bounded UTF-8 CSV.") from exc


def _number(value, *, nullable=False, probability=False, nonnegative=False):
    if nullable and value in ("NA", "", "NaN"):
        return None
    try:
        number = float(value)
    except (ValueError, TypeError) as exc:
        raise ValueError("Engine output contains an invalid numeric value.") from exc
    if not math.isfinite(number) or abs(number) > 1e100:
        raise ValueError("Engine output contains a non-finite or excessive numeric value.")
    if probability and not 0 <= number <= 1 or nonnegative and number < 0:
        raise ValueError("Engine numeric output lies outside its declared range.")
    return number


def _gene_sets(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate gene-set JSON keys are not allowed.")
            result[key] = value
        return result
    value = json.loads(data.decode("utf-8-sig"), object_pairs_hook=pairs,
                       parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite gene-set JSON.")))
    if not isinstance(value, dict) or set(value) != {"schema_version", "namespace", "source", "sets"} or value["schema_version"] != "proto-agent.rnaseq-gene-sets.v1":
        raise ValueError("Gene sets require schema_version, namespace, source and sets.")
    for key in ("namespace", "source"):
        text = value[key]
        if not isinstance(text, str) or not 1 <= len(text) <= 1000 or text != text.strip() or any(ord(c) < 32 for c in text):
            raise ValueError("Gene-set namespace and source must be bounded printable text.")
    if not isinstance(value["sets"], list) or not 1 <= len(value["sets"]) <= 200:
        raise ValueError("Supply 1 to 200 named gene sets.")
    names, total = set(), 0
    for item in value["sets"]:
        if not isinstance(item, dict) or set(item) != {"name", "genes"}:
            raise ValueError("Each gene set needs exactly name and genes.")
        name, genes = item["name"], item["genes"]
        if not isinstance(name, str) or not 1 <= len(name) <= 100 or name != name.strip() or name in names or any(ord(c) < 32 for c in name):
            raise ValueError("Gene-set names must be unique bounded printable labels.")
        names.add(name)
        if not isinstance(genes, list) or not 1 <= len(genes) <= 5000:
            raise ValueError("Each gene set needs 1 to 5000 identifiers.")
        if any(not isinstance(g, str) or not 1 <= len(g) <= 100 or any(c.isspace() or ord(c) < 32 for c in g) for g in genes) or len(set(genes)) != len(genes):
            raise ValueError("Gene-set identifiers must be unique, bounded and contain no whitespace.")
        total += len(genes)
        if total > 50000:
            raise ValueError("Gene sets exceed 50000 total memberships.")
    return value


def _enrich(rows, alpha, supplied):
    result = {"status": "not-requested", "method": ENRICHMENT_METHOD,
              "background_rule": BACKGROUND_RULE, "selection_rule": SELECTION_RULE}
    if supplied is None:
        return result
    result["gene_set_source"] = {k: supplied[k] for k in ("namespace", "source")}
    if rows is None:
        return {**result, "status": "not-run", "reason": "Validation mode does not fit differential expression."}
    background = [r["gene_id"] for r in rows if r["padj"] is not None]
    selected = [r["gene_id"] for r in rows if r["padj"] is not None and r["padj"] < alpha]
    result.update(selected_genes=selected, background_genes=background)
    if not background:
        return {**result, "status": "no-background", "reason": "No genes have finite adjusted p-values."}
    if not selected:
        return {**result, "status": "empty-selection", "reason": "No adjusted p-value is below the declared alpha."}
    if len(selected) == len(background):
        return {**result, "status": "no-contrast", "reason": "All eligible background genes are selected; no proper subset exists."}
    # Reuse the reviewed offline ORA implementation with its explicit
    # transcriptome-sized universe bound; do not truncate gene identifiers.
    computed = gene_set_enrichment_analysis({"genes": selected, "background": background,
        "gene_sets": supplied["sets"], "top_k": len(supplied["sets"])}, max_universe=100000)
    return {**result, "status": "completed", "tested_gene_sets": computed["tested_gene_sets"],
            "rows": computed["results"]}


def _outputs(paths, receipt):
    if receipt.get("ok") is not True or receipt.get("status") != "completed":
        error = receipt.get("error") or {}
        raise ValueError(f"DESeq2 did not complete ({receipt.get('status', 'failed')}): {error}. "
                         f"Retained execution evidence: {receipt.get('manifest_path', 'unavailable')}.")
    run_id = receipt.get("run_id", "")
    if len(run_id) != 32 or any(c not in "0123456789abcdef" for c in run_id) or receipt.get("operation") != "deseq2_fit":
        raise ValueError("DESeq2 returned an incompatible execution identity.")
    prefix = f"build/bioinformatics/{run_id}/outputs/"
    result = {}
    for item in receipt.get("artifacts", []):
        path = item.get("path", "")
        if not path.startswith(prefix):
            raise ValueError("DESeq2 artifact escapes its registered output directory.")
        name = path[len(prefix):]
        if "/" in name or name in result:
            raise ValueError("Unexpected duplicate or nested DESeq2 output.")
        # Normalized matrices may exceed the study projection. Their full bytes
        # stay with the existing engine receipt; parse only the required tables.
        if name not in {"differential-expression.csv", "pca-scores.csv", "pca-variance.csv", "pca-features.csv", "filter-status.csv", "size-factors.csv", "analysis-metadata.csv"}:
            continue
        file = paths.workspace_file(path, max_bytes=MAX_FILE)
        raw = read_bytes_bounded(file, MAX_FILE)
        if len(raw) != item.get("bytes") or _digest(raw) != item.get("sha256"):
            raise ValueError("DESeq2 output bytes no longer match the engine receipt.")
        result[name] = raw
    required = {"differential-expression.csv", "pca-scores.csv", "pca-variance.csv", "pca-features.csv", "filter-status.csv", "size-factors.csv", "analysis-metadata.csv"}
    if set(result) != required:
        raise ValueError("DESeq2 did not retain all required study output tables.")
    return result


def analyze_rnaseq_study(arguments, input_files, *, workspace_root, cancel_event=None):
    options = {**DEFAULTS, **arguments}
    data = parse_rnaseq_inputs(input_files["counts_path"], input_files["samples_path"],
        reference_level=options["reference_level"], comparison_level=options["comparison_level"], design=options["design"])
    supplied = _gene_sets(input_files["gene_sets_path"]) if "gene_sets_path" in input_files else None
    kept = [gene for gene, row in zip(data["gene_ids"], data["counts"])
            if sum(count >= options["min_count"] for count in row) >= options["min_samples"]]
    if len(kept) < 2:
        raise ValueError("The declared count filter retains fewer than two genes; change the explicit filter or supply other data.")
    kept_set = set(kept)
    paths = WorkspacePaths.create(workspace_root)
    prepared = paths.run_directory("build/rnaseq-inputs", uuid4().hex)
    relative = lambda file: file.relative_to(paths.workspace).as_posix()
    sources = {}
    for field, raw in input_files.items():
        snapshot = prepared / (field + (".json" if field == "gene_sets_path" else ".csv"))
        write_text_bounded(snapshot, raw.decode("utf-8"), max_bytes=MAX_FILE, boundary=paths.build)
        if _digest(read_bytes_bounded(snapshot, MAX_FILE)) != _digest(raw):
            raise ValueError("RNA study snapshot bytes changed during publication.")
        sources[field] = {"path": arguments[field], "sha256": _digest(raw), "bytes": len(raw), "snapshot": relative(snapshot)}
    result = {"schema_version": SCHEMA, "analysis": {"mode": options["analysis_mode"], "status": "validated"},
        "sources": sources, "design": data["design"], "qc": data["qc"],
        "filter": {"min_count": options["min_count"], "min_samples": options["min_samples"],
                   "input_genes": len(data["gene_ids"]), "kept_genes": len(kept),
                   "excluded_genes": [gene for gene in data["gene_ids"] if gene not in kept_set]},
        "pca": None, "differential_expression": None, "enrichment": _enrich(None, options["alpha"], supplied),
        "warnings": data.get("warnings", []), "limitations": [
            "Raw counts and sample identities are retained; no automatic sample exclusion or count imputation is performed.",
            "Design rank and replication checks do not establish biological independence or rule out unmeasured confounding.",
            "Positive log2 fold change means comparison over reference. No LFC shrinkage is applied.",
            "PCA uses a design-aware DESeq2 variance-stabilizing transform; it does not remove batch effects.",
            "Unavailable p-values remain null. They do not mean no effect or nonsignificance.",
            "Offline ORA uses only supplied gene sets and genes with finite adjusted p-values; identifiers are not remapped.",
            "Results and synthetic/reference checks require domain review; scientific validity is not established."]}
    if options["analysis_mode"] == "validate":
        result["warnings"].append("Validation only: no DESeq2 fit, normalization, PCA or enrichment was executed.")
        return result
    request = {"operation": "deseq2_fit", "arguments": {
        "counts": sources["counts_path"]["snapshot"], "samples": sources["samples_path"]["snapshot"],
        **{key: options[key] for key in ("reference_level", "comparison_level", "design", "alpha", "min_count", "min_samples", "pca_top_genes", "size_factor_type")}}}
    request_path = prepared / "deseq2-request.json"
    write_text_bounded(request_path, json.dumps(request, ensure_ascii=False), boundary=paths.build)
    receipt = run_bioinformatics(relative(request_path), workspace_root=paths.workspace, cancel_event=cancel_event)
    tables = _outputs(paths, receipt)
    filter_rows = _csv(tables["filter-status.csv"], ["gene_id", "kept"])
    if [r["gene_id"] for r in filter_rows] != data["gene_ids"] or [r["gene_id"] for r in filter_rows if r["kept"].upper() == "TRUE"] != kept or any(r["kept"].upper() not in ("TRUE", "FALSE") for r in filter_rows):
        raise ValueError("DESeq2 gene filtering disagrees with the validated raw counts.")
    rows = []
    for row in _csv(tables["differential-expression.csv"], ["gene_id", "baseMean", "log2FoldChange", "lfcSE", "stat", "pvalue", "padj", "status"]):
        parsed = {"gene_id": row["gene_id"], "status": row["status"]}
        for key in ("baseMean", "log2FoldChange", "lfcSE", "stat", "pvalue", "padj"):
            parsed[key] = _number(row[key], nullable=True, probability=key in ("pvalue", "padj"), nonnegative=key in ("baseMean", "lfcSE"))
        if parsed["padj"] is not None and parsed["pvalue"] is None:
            raise ValueError("An adjusted p-value cannot exist without its raw p-value.")
        expected_status = "all_zero" if parsed["baseMean"] == 0 else "p_value_unavailable" if parsed["pvalue"] is None else "adjusted_p_value_unavailable" if parsed["padj"] is None else "available"
        if parsed["status"] != expected_status:
            raise ValueError("DESeq2 availability status disagrees with its numeric values.")
        rows.append(parsed)
    if [r["gene_id"] for r in rows] != kept:
        raise ValueError("DESeq2 output genes do not match the retained model rows in order.")
    pca_samples = _csv(tables["pca-scores.csv"], ["sample", "condition", "PC1", "PC2"], maximum=100)
    if [r["sample"] for r in pca_samples] != data["sample_ids"]:
        raise ValueError("PCA sample identities or order do not match validated count columns.")
    points = []
    for row, sample in zip(pca_samples, data["samples"]):
        for field in ("condition", "batch", "subject"):
            if field in sample and row.get(field) != sample[field]:
                raise ValueError("PCA metadata differs from the original sample sheet.")
        points.append({**sample, "pc1": _number(row["PC1"]), "pc2": _number(row["PC2"])})
    variances = _csv(tables["pca-variance.csv"], ["component", "variance_fraction"], maximum=100)
    if len(variances) < 2 or [r["component"] for r in variances[:2]] != ["PC1", "PC2"]:
        raise ValueError("PCA variance table is missing its first two components.")
    variance = [_number(r["variance_fraction"], probability=True) for r in variances[:2]]
    if sum(variance) > 1 + 1e-8:
        raise ValueError("PCA variance fractions exceed one.")
    pca_genes = [r["gene_id"] for r in _csv(tables["pca-features.csv"], ["gene_id"], maximum=5000)]
    if not 2 <= len(pca_genes) <= options["pca_top_genes"] or len(set(pca_genes)) != len(pca_genes) or not set(pca_genes) <= kept_set:
        raise ValueError("PCA feature identities do not match the modeled genes.")
    size_factors = _csv(tables["size-factors.csv"], ["sample", "size_factor"], maximum=100)
    if [r["sample"] for r in size_factors] != data["sample_ids"]:
        raise ValueError("Size-factor sample identities do not match the count columns.")
    for row, sample in zip(size_factors, result["qc"]["samples"]):
        factor = _number(row["size_factor"], nonnegative=True)
        if factor <= 0:
            raise ValueError("DESeq2 size factors must be positive.")
        sample["size_factor"] = factor
    significant = [r for r in rows if r["padj"] is not None and r["padj"] < options["alpha"]]
    result.update(analysis={"mode": "fit", "status": "complete", "engine_run_id": receipt["run_id"],
        "manifest_path": receipt["manifest_path"], "manifest_sha256": _digest(read_bytes_bounded(paths.workspace_file(receipt["manifest_path"], max_bytes=2*1024*1024), 2*1024*1024)),
        "runtime": receipt.get("runtime", {}), "engine_artifacts": receipt["artifacts"]},
        pca={"samples": points, "variance_fraction": variance, "genes": pca_genes,
             "transform": "DESeq2 varianceStabilizingTransformation blind=FALSE", "center": True, "scale": False},
        differential_expression={"rows": rows, "alpha": options["alpha"], "contrast": {
            "numerator": options["comparison_level"], "denominator": options["reference_level"]},
            "summary": {"modeled": len(rows), "pvalue_available": sum(r["pvalue"] is not None for r in rows),
                "padj_available": sum(r["padj"] is not None for r in rows),
                "significant_up": sum(r["log2FoldChange"] is not None and r["log2FoldChange"] > 0 for r in significant),
                "significant_down": sum(r["log2FoldChange"] is not None and r["log2FoldChange"] < 0 for r in significant),
                "significant_zero": sum(r["log2FoldChange"] == 0 for r in significant)}},
        enrichment=_enrich(rows, options["alpha"], supplied))
    metadata_rows = _csv(tables["analysis-metadata.csv"], ["key", "value"], maximum=100)
    if len({r["key"] for r in metadata_rows}) != len(metadata_rows):
        raise ValueError("DESeq2 metadata keys are duplicated.")
    result["analysis"]["engine_metadata"] = {r["key"]: r["value"] for r in metadata_rows}
    metadata = result["analysis"]["engine_metadata"]
    expected_text = {"schema": "proto-agent.deseq2-analysis.v1", "design": options["design"],
        "contrast_factor": "condition", "reference_level": options["reference_level"],
        "comparison_level": options["comparison_level"], "size_factor_type": options["size_factor_type"],
        "pca_transform": "varianceStabilizingTransformation", "pca_blind": "FALSE", "pca_center": "TRUE", "pca_scale": "FALSE",
        "lfc_shrinkage": "none", "test": "Wald", "independent_filtering": "TRUE", "p_adjust_method": "BH"}
    if any(metadata.get(key) != value for key, value in expected_text.items()) or "".join(metadata.get("formula", "").split()) != "".join(data["design"]["formula"].split()):
        raise ValueError("DESeq2 method metadata disagrees with the requested design, contrast or fixed analysis settings.")
    expected_numbers = {key: options[key] for key in ("alpha", "min_count", "min_samples", "pca_top_genes")}
    expected_numbers.update(input_genes=len(data["gene_ids"]), retained_genes=len(kept), samples=len(data["sample_ids"]),
        model_rank=data["design"]["rank"], residual_df=data["design"]["residual_df"], pca_features_used=len(pca_genes))
    if any(_number(metadata.get(key)) != value for key, value in expected_numbers.items()):
        raise ValueError("DESeq2 metadata counts or numeric settings disagree with the validated study.")
    if any(not isinstance(metadata.get(key), str) or not 1 <= len(metadata[key]) <= 300 for key in ("R_version", "DESeq2_version")):
        raise ValueError("DESeq2 runtime version metadata is missing or invalid.")
    for factor, levels in data["design"]["factor_levels"].items():
        if any(metadata.get(f"{factor}_level_{index}") != level for index, level in enumerate(levels, 1)):
            raise ValueError("DESeq2 factor levels differ from the validated design.")
    return result


def _string(description):
    return {"type": "string", "minLength": 1, "maxLength": 512, "description": description}


TOOLS = {"analyze_rnaseq_study": {
    "title": "RNA-seq study", "description": "Validate raw counts and sample design, or fit the existing local WSL DESeq2 engine with PCA, exact differential-expression results and optional supplied-set enrichment.",
    "implementation": "proto-native", "upstream_functions": [], "dependency": ["numpy", "scipy"],
    "method_references": ["https://doi.org/10.1186/s13059-014-0550-8", "https://bioconductor.org/packages/release/bioc/vignettes/DESeq2/inst/doc/DESeq2.html"],
    "execution_requirements": "Fit mode additionally requires the configured local DESeq2 bioinformatics runtime. Validation mode does not invoke R.",
    "max_result_bytes": MAX_RESULT,
    "file_inputs": {"counts_path": {"extensions": [".csv"], "max_bytes": MAX_FILE},
                    "samples_path": {"extensions": [".csv"], "max_bytes": MAX_FILE},
                    "gene_sets_path": {"extensions": [".json"], "max_bytes": MAX_FILE, "required": False}},
    "input_schema": {"type": "object", "additionalProperties": False, "required": ["counts_path", "samples_path", "reference_level", "comparison_level"], "properties": {
        "counts_path": _string("Raw integer-count CSV: gene_id followed by unique sample IDs."),
        "samples_path": _string("Sample CSV: sample,condition plus optional batch or subject; exact count sample identities."),
        "gene_sets_path": _string("Optional local reviewed gene-set JSON; no download or identifier conversion."),
        "reference_level": _string("Reference condition; fold changes use comparison / reference."),
        "comparison_level": _string("Comparison condition; must have at least two samples."),
        "analysis_mode": {"type": "string", "enum": ["validate", "fit"], "default": "fit"},
        "design": {"type": "string", "enum": ["condition", "batch_condition", "subject_condition"], "default": "condition"},
        "alpha": {"type": "number", "minimum": .001, "maximum": .5, "default": .05},
        "min_count": {"type": "integer", "minimum": 0, "maximum": 1000000, "default": 10},
        "min_samples": {"type": "integer", "minimum": 1, "maximum": 100, "default": 2},
        "pca_top_genes": {"type": "integer", "minimum": 2, "maximum": 5000, "default": 500},
        "size_factor_type": {"type": "string", "enum": ["ratio", "poscounts"], "default": "ratio"}}},
    "example": {"counts_path": "data/rnaseq/counts.csv", "samples_path": "data/rnaseq/samples.csv", "reference_level": "control", "comparison_level": "treated", **DEFAULTS}
}}
HANDLERS = {"analyze_rnaseq_study": analyze_rnaseq_study}
