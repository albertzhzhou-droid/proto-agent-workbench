"""Explicit local CPU integration checks for the installed, fixed DESeq2 adapter.

No package installation, dataset download or biological sequence construction.
Every attempt retains its request, receipt and engine outputs in build/.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import random
import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

REPOSITORY = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPOSITORY / "src"))
from proto_agent.bioinformatics import run_bioinformatics


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", choices=("all", "condition_keep_zeros"), default="all")
    selected_case = parser.parse_args().case
    destination = REPOSITORY / "build/rnaseq-studies-20260922" / ("deseq2-integration-" + uuid4().hex)
    destination.mkdir(parents=True)
    relative = lambda path: path.relative_to(REPOSITORY).as_posix()
    sources = [REPOSITORY / "src/proto_agent/bioinformatics.py", REPOSITORY / "src/proto_agent/bioinformatics_worker.py",
               Path(__file__).resolve()]
    hashes = lambda: {relative(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in sources}
    before = hashes()
    rng = random.Random(22109)
    samples = [f"sample{i}" for i in range(6)]
    rows = []
    for gene in range(140):
        mean = rng.randint(30, 250)
        rows.append([f"synthetic_gene_{gene:03}", *[round(rng.gammavariate(8, mean * (2 if gene < 20 and i >= 3 else 1) / 8)) for i in range(6)]])
    rows.extend([["synthetic_all_zero", *([0] * 6)], ["synthetic_low_constant", *([1] * 6)]])
    metadata = [[sample, "control" if i < 3 else "treated", "batch_a" if i % 2 == 0 else "batch_b", f"subject{i % 3}"] for i, sample in enumerate(samples)]

    def write_csv(path, contents):
        with path.open("w", encoding="utf-8", newline="") as stream:
            csv.writer(stream).writerows(contents)

    counts = destination / "counts.csv"
    annotations = destination / "samples.csv"
    write_csv(counts, [["gene_id", *samples], *rows])
    write_csv(annotations, [["sample", "condition", "batch", "subject"], *reversed(metadata)])
    base = {"counts": relative(counts), "samples": relative(annotations), "reference_level": "control", "comparison_level": "treated"}
    cases = []
    successful = {}

    def read_table(outputs, name):
        with outputs[name].open(encoding="utf-8", newline="") as stream:
            return list(csv.DictReader(stream))

    def execute(name, extra=None, expect_error=None):
        if selected_case != "all" and selected_case != name:
            return
        request_path = destination / (name + "-request.json")
        request_path.write_text(json.dumps({"operation": "deseq2_fit", "arguments": {**base, **(extra or {})}}, indent=2), encoding="utf-8")
        receipt = run_bioinformatics(relative(request_path), workspace_root=REPOSITORY)
        (destination / (name + "-receipt.json")).write_text(json.dumps(receipt, indent=2), encoding="utf-8")
        outputs = {Path(item["path"]).name: REPOSITORY / item["path"] for item in receipt["artifacts"]}
        checks = {}
        checks["artifact_hashes"] = all(hashlib.sha256((REPOSITORY / item["path"]).read_bytes()).hexdigest() == item["sha256"] for item in receipt["artifacts"])
        if expect_error:
            logs = "\n".join(path.read_text(encoding="utf-8", errors="replace") for key, path in outputs.items() if key.endswith(".log"))
            checks["failed_not_succeeded"] = receipt["ok"] is False and receipt["status"] == "failed"
            checks["diagnostic"] = expect_error in logs
            checks["no_fitted_result"] = "differential-expression.csv" not in outputs
        else:
            checks["completed"] = receipt["ok"] is True and receipt["status"] == "completed"
            expected = {"differential-expression.csv", "filter-status.csv", "normalized-counts.csv", "size-factors.csv", "pca-scores.csv", "pca-variance.csv", "pca-features.csv", "analysis-metadata.csv", "R-session-info.txt"}
            checks["outputs"] = expected <= outputs.keys()
            if checks["completed"] and checks["outputs"]:
                de = read_table(outputs, "differential-expression.csv")
                filters = read_table(outputs, "filter-status.csv")
                pca = read_table(outputs, "pca-scores.csv")
                variance = read_table(outputs, "pca-variance.csv")
                info = {row["key"]: row["value"] for row in read_table(outputs, "analysis-metadata.csv")}
                checks["all_filter_rows_preserved"] = [row["gene_id"] for row in filters] == [row[0] for row in rows]
                checks["result_gene_ids_match_filter"] = [row["gene_id"] for row in de] == [row["gene_id"] for row in filters if row["kept"] == "TRUE"]
                checks["result_headers"] = set(de[0]) == {"gene_id", "baseMean", "log2FoldChange", "lfcSE", "stat", "pvalue", "padj", "status", "max_cooks"}
                checks["sample_order_and_finite_pca"] = [row["sample"] for row in pca] == samples and all(math.isfinite(float(row[key])) for row in pca for key in ("PC1", "PC2"))
                checks["optional_sample_metadata_preserved"] = all(row.get("batch") == expected[2] and row.get("subject") == expected[3] for row, expected in zip(pca, metadata))
                checks["pca_centered"] = all(abs(sum(float(row[key]) for row in pca)) < 1e-7 for key in ("PC1", "PC2"))
                checks["pca_variance_sum"] = math.isclose(sum(float(row["variance_fraction"]) for row in variance), 1.0, abs_tol=1e-12)
                checks["finite_positive_size_factors"] = all(math.isfinite(float(row["size_factor"])) and float(row["size_factor"]) > 0 for row in read_table(outputs, "size-factors.csv"))
                checks["normalization_and_shrinkage_named"] = info["lfc_shrinkage"] == "none" and info["pca_blind"] == "FALSE" and info["pca_scale"] == "FALSE"
                checks["explicit_factor_order"] = info["condition_level_1"] == (extra or {}).get("reference_level", "control")
                if (extra or {}).get("min_count") == 0:
                    zero = next(row for row in de if row["gene_id"] == "synthetic_all_zero")
                    checks["zero_gene_na_preserved"] = zero["baseMean"] == "0" and zero["status"] == "all_zero" and all(zero[key] == "NA" for key in ("log2FoldChange", "lfcSE", "stat", "pvalue", "padj"))
                else:
                    checks["explicit_prefilter"] = all(row["kept"] == "FALSE" for row in filters if row["gene_id"] in {"synthetic_all_zero", "synthetic_low_constant"})
                successful[name] = {"de": de, "metadata": info}
        case = {"name": name, "passed": all(checks.values()), "checks": checks, "run_id": receipt["run_id"], "manifest_path": receipt["manifest_path"]}
        cases.append(case)
        print(json.dumps(case), flush=True)

    execute("condition_keep_zeros", {"min_count": 0})
    execute("condition_reverse", {"min_count": 0, "reference_level": "treated", "comparison_level": "control"})
    execute("batch_defaults", {"design": "batch_condition"})
    execute("subject_poscounts", {"design": "subject_condition", "size_factor_type": "poscounts"})
    if "condition_keep_zeros" in successful and "condition_reverse" in successful:
        forward = successful["condition_keep_zeros"]["de"]
        reverse = successful["condition_reverse"]["de"]
        comparisons = [(a, b) for a, b in zip(forward, reverse) if a["log2FoldChange"] != "NA" and b["log2FoldChange"] != "NA"]
        lfc_check = all(math.isclose(float(a["log2FoldChange"]), -float(b["log2FoldChange"]), abs_tol=2e-5) for a, b in comparisons)
        p_check = all(a["pvalue"] == b["pvalue"] == "NA" or a["pvalue"] != "NA" and b["pvalue"] != "NA" and math.isclose(float(a["pvalue"]), float(b["pvalue"]), rel_tol=1e-3, abs_tol=1e-7) for a, b in comparisons)
        cases.append({"name": "contrast_reversal", "passed": bool(comparisons) and lfc_check and p_check, "checks": {"opposite_lfc": lfc_check, "consistent_pvalue": p_check}})
    bad_counts = destination / "fractional-counts.csv"
    write_csv(bad_counts, [["gene_id", *samples], [rows[0][0], "1.5", *rows[0][2:]], *rows[1:]])
    execute("reject_fractional", {"counts": relative(bad_counts)}, "Raw counts must be nonnegative integer tokens")
    duplicate_counts = destination / "duplicate-samples.csv"
    write_csv(duplicate_counts, [["gene_id", samples[1], *samples[1:]], *rows])
    execute("reject_duplicate_header", {"counts": relative(duplicate_counts)}, "CSV headers must be unique")
    bad_samples = destination / "mismatched-samples.csv"
    write_csv(bad_samples, [["sample", "condition", "batch", "subject"], ["missing", *metadata[0][1:]], *metadata[1:]])
    execute("reject_mismatched_samples", {"samples": relative(bad_samples)}, "Metadata samples must exactly match")
    confounded_samples = destination / "confounded-samples.csv"
    write_csv(confounded_samples, [["sample", "condition", "batch", "subject"], *[[row[0], row[1], row[1], row[3]] for row in metadata]])
    execute("reject_confounded_batch", {"samples": relative(confounded_samples), "design": "batch_condition"}, "Design matrix is not full rank")
    execute("reject_filter_removes_all", {"min_count": 1000000}, "At least two genes must pass")
    summary = {"schema": "proto.rnaseq-deseq2-integration.v1", "createdAt": datetime.now(timezone.utc).isoformat(),
               "scope": "Actual installed DESeq2 CPU runs on synthetic regression fixtures; no biological validity claim", "selectedCase": selected_case,
               "sourceHashesBefore": before, "sourceHashesAfter": hashes(), "cases": cases,
               "passed": all(case["passed"] for case in cases) and before == hashes()}
    (destination / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(relative(destination / "summary.json"), flush=True)
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
