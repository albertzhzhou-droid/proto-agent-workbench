"""RNA-seq orchestration contracts with retained, explicitly synthetic engine files.

Only the existing bioinformatics adapter is mocked. CSV parsing, source
snapshots, output hashes, identity joins, QC and ORA run through real code.
These cases do not validate the DESeq2 estimator or an installed R runtime.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
from pathlib import Path
import threading
import unittest
from unittest.mock import patch
from uuid import uuid4

from proto_agent import compute_rnaseq


SAMPLES = ["sample-z", "sample-a", "sample-y", "sample-b"]
GENES = ["gene-up", "gene-down", "gene-flat", "gene-raw-na", "gene-adjusted-na", "gene-zero", "gene-low"]
COUNTS = [
    ["gene_id", *SAMPLES],
    ["gene-up", 10, 12, 100, 120],
    ["gene-down", 90, 100, 10, 12],
    ["gene-flat", 40, 40, 40, 40],
    ["gene-raw-na", 30, 40, 50, 60],
    ["gene-adjusted-na", 20, 30, 40, 50],
    ["gene-zero", 0, 0, 0, 0],
    ["gene-low", 1, 2, 1, 2],
]
METADATA = [["sample", "condition"], [SAMPLES[2], "treated"], [SAMPLES[0], "control"],
            [SAMPLES[3], "treated"], [SAMPLES[1], "control"]]
DE_HEADER = ["gene_id", "baseMean", "log2FoldChange", "lfcSE", "stat", "pvalue", "padj", "status"]
DE_ROWS = [
    ["gene-up", 60.5, 3, .4, 7.5, .001, .003, "available"],
    ["gene-down", 53, -3, .5, -6, .002, .004, "available"],
    ["gene-flat", 40, 0, .2, 0, .03, .05, "available"],
    ["gene-raw-na", 45, "NA", "NA", "NA", "NA", "NA", "p_value_unavailable"],
    ["gene-adjusted-na", 35, 1, 1, 1, .6, "NA", "adjusted_p_value_unavailable"],
    ["gene-zero", 0, "NA", "NA", "NA", "NA", "NA", "all_zero"],
    ["gene-low", 1.5, 0, .5, 0, 1, 1, "available"],
]
GENE_SETS = {"schema_version": "proto-agent.rnaseq-gene-sets.v1", "namespace": "synthetic IDs",
             "source": "Independent software fixture; no biological interpretation",
             "sets": [{"name": "up-and-down", "genes": ["gene-up", "gene-down", "absent"]},
                      {"name": "flat-only", "genes": ["gene-flat"]}]}


def csv_bytes(rows):
    output = io.StringIO(newline="")
    csv.writer(output, lineterminator="\r\n").writerows(rows)
    return output.getvalue().encode("utf-8")


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


class RnaseqOrchestrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.evidence_root = Path(__file__).resolve().parents[1] / "build" / "rnaseq-studies-20260922" / ("orchestration-fixtures-" + uuid4().hex)
        cls.evidence_root.mkdir(parents=True)

    def setUp(self):
        self.workspace = self.evidence_root / self._testMethodName
        (self.workspace / "data").mkdir(parents=True)
        self.inputs = {"counts_path": b"\xef\xbb\xbf" + csv_bytes(COUNTS), "samples_path": csv_bytes(METADATA)}
        self.arguments = {"counts_path": "data/counts.csv", "samples_path": "data/samples.csv",
                          "reference_level": "control", "comparison_level": "treated"}
        self.last_request = None
        self.last_receipt = None
        self.last_cancel_event = None

    def analyze(self, *, mutate=None, receipt_mutation=None, tamper=None, **options):
        arguments = {**self.arguments, **options}
        for key, raw in self.inputs.items():
            (self.workspace / arguments[key]).write_bytes(raw)
        with patch.object(compute_rnaseq, "run_bioinformatics", side_effect=self.producer(mutate, receipt_mutation, tamper)) as adapter:
            result = compute_rnaseq.analyze_rnaseq_study(arguments, dict(self.inputs), workspace_root=self.workspace,
                                                       cancel_event=getattr(self, "cancel_event", None))
        return result, adapter

    def tables(self, arguments):
        include_zero = arguments["min_count"] == 0
        de_rows = DE_ROWS if include_zero else DE_ROWS[:5]
        metadata = {
            "schema": "proto-agent.deseq2-analysis.v1", "design": "condition", "formula": "~condition",
            "contrast_factor": "condition", "reference_level": "control", "comparison_level": "treated",
            "alpha": "0.05", "min_count": str(arguments["min_count"]), "min_samples": "2",
            "pca_top_genes": "500", "size_factor_type": "ratio",
            "pca_transform": "varianceStabilizingTransformation", "pca_blind": "FALSE",
            "pca_center": "TRUE", "pca_scale": "FALSE", "pca_sign": "largest_absolute_loading_positive",
            "pca_feature_ties": "gene_id_radix", "pca_features_used": "2", "input_genes": "7",
            "retained_genes": str(len(de_rows)), "samples": "4", "model_rank": "2", "residual_df": "2",
            "lfc_shrinkage": "none", "test": "Wald", "independent_filtering": "TRUE",
            "p_adjust_method": "BH", "cooks_cutoff": "DESeq2_default",
            "min_replicates_for_replace": "DESeq2_default_7", "counts_normalization": "size_factor_scaled; not batch-corrected",
            "defaults": "design=condition;min_count=10;min_samples=2;pca_top_genes=500;size_factor_type=ratio;alpha=0.05",
            "DESeq2_version": "synthetic-test-producer", "R_version": "synthetic-test-no-R",
            "condition_level_1": "control", "condition_level_2": "treated",
        }
        return {
            "differential-expression.csv": [DE_HEADER, *[row.copy() for row in de_rows]],
            "pca-scores.csv": [["sample", "condition", "PC1", "PC2"],
                               [SAMPLES[0], "control", -3, 1], [SAMPLES[1], "control", -1, -1],
                               [SAMPLES[2], "treated", 1, -1], [SAMPLES[3], "treated", 3, 1]],
            "pca-variance.csv": [["component", "variance_fraction"], ["PC1", 5/6], ["PC2", 1/6]],
            "pca-features.csv": [["gene_id"], ["gene-down"], ["gene-up"]],
            "filter-status.csv": [["gene_id", "kept", "reason"], *[
                [gene, "TRUE" if include_zero or index < 5 else "FALSE", "kept" if include_zero or index < 5 else "below_min_count_in_min_samples"]
                for index, gene in enumerate(GENES)]],
            "size-factors.csv": [["sample", "size_factor"], *[[sample, 1] for sample in SAMPLES]],
            "analysis-metadata.csv": [["key", "value"], *[[key, value] for key, value in metadata.items()]],
        }

    def producer(self, mutate=None, receipt_mutation=None, tamper=None):
        def produce(request_path, *, workspace_root, cancel_event):
            self.assertEqual(Path(workspace_root), self.workspace)
            self.last_cancel_event = cancel_event
            request = json.loads((self.workspace / request_path).read_text(encoding="utf-8"))
            self.last_request = request
            self.assertEqual(request["operation"], "deseq2_fit")
            tables = self.tables(request["arguments"])
            if mutate:
                mutate(tables)
            run_id = uuid4().hex
            directory = self.workspace / "build" / "bioinformatics" / run_id
            (directory / "outputs").mkdir(parents=True)
            receipt = {"ok": True, "status": "completed", "operation": "deseq2_fit", "run_id": run_id,
                       "manifest_path": f"build/bioinformatics/{run_id}/manifest.json", "artifacts": [],
                       "runtime": {"synthetic_fixture": True, "actual_R_execution": False}}
            for name, rows in tables.items():
                raw = csv_bytes(rows)
                artifact_path = directory / "outputs" / name
                artifact_path.write_bytes(raw)
                receipt["artifacts"].append({"path": artifact_path.relative_to(self.workspace).as_posix(),
                                             "bytes": len(raw), "sha256": digest(raw)})
            if receipt_mutation:
                receipt_mutation(receipt)
            (self.workspace / receipt["manifest_path"]).write_text(json.dumps(receipt), encoding="utf-8")
            if tamper:
                tamper(self.workspace, receipt)
            self.last_receipt = receipt
            return receipt
        return produce

    def add_sets(self, raw=None):
        self.arguments["gene_sets_path"] = "data/gene-sets.json"
        self.inputs["gene_sets_path"] = raw if raw is not None else json.dumps(GENE_SETS).encode("utf-8")

    def test_validate_retains_exact_bom_crlf_snapshots_and_qc_without_calling_r(self):
        self.add_sets()
        result, adapter = self.analyze(analysis_mode="validate")
        adapter.assert_not_called()
        self.assertEqual(result["analysis"], {"mode": "validate", "status": "validated"})
        self.assertIsNone(result["pca"])
        self.assertIsNone(result["differential_expression"])
        self.assertEqual(result["enrichment"]["status"], "not-run")
        self.assertEqual(result["qc"]["condition_counts"], {"control": 2, "treated": 2})
        self.assertTrue(result["qc"]["metadata_reordered"])
        self.assertEqual([row["sample"] for row in result["qc"]["samples"]], SAMPLES)
        self.assertEqual([row["library_size"] for row in result["qc"]["samples"]], [191, 224, 241, 284])
        self.assertEqual(result["filter"], {"min_count": 10, "min_samples": 2, "input_genes": 7,
                                            "kept_genes": 5, "excluded_genes": ["gene-zero", "gene-low"]})
        for key, source in result["sources"].items():
            self.assertEqual((self.workspace / source["snapshot"]).read_bytes(), self.inputs[key])
            self.assertEqual((self.workspace / source["path"]).read_bytes(), self.inputs[key])
            self.assertEqual(source["sha256"], digest(self.inputs[key]))
            self.assertEqual(source["bytes"], len(self.inputs[key]))

    def test_optional_gene_sets_fail_before_execution_if_malformed(self):
        malformed = [b"not json", b'{"schema_version":"a","schema_version":"b"}',
                     json.dumps({**GENE_SETS, "sets": [{"name": "bad", "genes": ["gene-up", "gene-up"]}]}).encode(),
                     json.dumps({**GENE_SETS, "unexpected": True}).encode()]
        for raw in malformed:
            with self.subTest(raw=raw):
                self.add_sets(raw)
                with patch.object(compute_rnaseq, "run_bioinformatics") as adapter:
                    with self.assertRaises(ValueError):
                        compute_rnaseq.analyze_rnaseq_study({**self.arguments, "analysis_mode": "validate"}, self.inputs, workspace_root=self.workspace)
                    adapter.assert_not_called()

    def test_fit_joins_original_ids_exact_values_nulls_statuses_and_manifest(self):
        self.cancel_event = threading.Event()
        result, adapter = self.analyze()
        adapter.assert_called_once()
        self.assertIs(self.last_cancel_event, self.cancel_event)
        self.assertEqual(result["analysis"]["status"], "complete")
        self.assertEqual(result["analysis"]["manifest_sha256"], digest((self.workspace / self.last_receipt["manifest_path"]).read_bytes()))
        self.assertEqual(result["analysis"]["engine_run_id"], self.last_receipt["run_id"])
        self.assertEqual(result["analysis"]["runtime"], {"synthetic_fixture": True, "actual_R_execution": False})
        rows = result["differential_expression"]["rows"]
        self.assertEqual([row["gene_id"] for row in rows], GENES[:5])
        self.assertEqual(rows[0]["log2FoldChange"], 3)
        self.assertEqual(rows[1]["log2FoldChange"], -3)
        self.assertIsNone(rows[3]["pvalue"])
        self.assertIsNone(rows[3]["stat"])
        self.assertIsNone(rows[4]["padj"])
        self.assertEqual([row["status"] for row in rows], ["available"] * 3 + ["p_value_unavailable", "adjusted_p_value_unavailable"])
        self.assertEqual(result["differential_expression"]["summary"], {"modeled": 5, "pvalue_available": 4, "padj_available": 3,
                                                                       "significant_up": 1, "significant_down": 1, "significant_zero": 0})
        self.assertEqual([row["sample"] for row in result["pca"]["samples"]], SAMPLES)
        self.assertEqual([(row["pc1"], row["pc2"]) for row in result["pca"]["samples"]], [(-3, 1), (-1, -1), (1, -1), (3, 1)])
        self.assertEqual(result["pca"]["genes"], ["gene-down", "gene-up"])
        self.assertEqual([row["size_factor"] for row in result["qc"]["samples"]], [1, 1, 1, 1])
        self.assertEqual(result["enrichment"]["status"], "not-requested")
        request = self.last_request["arguments"]
        self.assertEqual((self.workspace / request["counts"]).read_bytes(), self.inputs["counts_path"])
        self.assertEqual((self.workspace / request["samples"]).read_bytes(), self.inputs["samples_path"])
        self.assertNotEqual(request["counts"], self.arguments["counts_path"])

    def test_all_zero_gene_can_be_retained_with_explicit_zero_filter(self):
        result, _ = self.analyze(min_count=0)
        self.assertEqual(result["filter"]["kept_genes"], 7)
        self.assertEqual(result["filter"]["excluded_genes"], [])
        zero = result["differential_expression"]["rows"][5]
        self.assertEqual(zero["gene_id"], "gene-zero")
        self.assertEqual(zero["status"], "all_zero")
        self.assertIsNone(zero["pvalue"])
        self.assertIsNone(zero["padj"])

    def test_hash_changed_artifact_is_rejected_before_projection(self):
        def tamper(workspace, receipt):
            artifact = workspace / receipt["artifacts"][0]["path"]
            artifact.write_bytes(artifact.read_bytes() + b"\n")
        with self.assertRaisesRegex(ValueError, "bytes no longer match"):
            self.analyze(tamper=tamper)

    def test_missing_or_duplicate_required_artifact_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "all required"):
            self.analyze(mutate=lambda tables: tables.pop("analysis-metadata.csv"))
        with self.assertRaisesRegex(ValueError, "duplicate or nested"):
            self.analyze(receipt_mutation=lambda receipt: receipt["artifacts"].append(receipt["artifacts"][0].copy()))

    def test_failed_cancelled_timed_out_and_nonterminal_receipts_never_complete(self):
        for status in ("failed", "cancelled", "timeout", "running", "completed"):
            with self.subTest(status=status):
                def change(receipt):
                    receipt.update(ok=False if status == "completed" else True, status=status,
                                   error={"code": "SYNTHETIC_FAILURE", "message": "Retained test failure"})
                with self.assertRaisesRegex(ValueError, "DESeq2 did not complete"):
                    self.analyze(receipt_mutation=change)
                self.assertTrue((self.workspace / self.last_receipt["manifest_path"]).exists())

    def test_gene_order_and_filter_membership_must_match_validated_counts(self):
        def reverse_genes(tables):
            tables["differential-expression.csv"][1:] = list(reversed(tables["differential-expression.csv"][1:]))
        with self.assertRaisesRegex(ValueError, "output genes do not match"):
            self.analyze(mutate=reverse_genes)
        def wrong_filter(tables):
            tables["filter-status.csv"][1][1] = "FALSE"
        with self.assertRaisesRegex(ValueError, "filtering disagrees"):
            self.analyze(mutate=wrong_filter)
        def wrong_filter_order(tables):
            tables["filter-status.csv"][1], tables["filter-status.csv"][2] = tables["filter-status.csv"][2], tables["filter-status.csv"][1]
        with self.assertRaisesRegex(ValueError, "filtering disagrees"):
            self.analyze(mutate=wrong_filter_order)

    def test_pca_and_size_factor_identities_and_metadata_cannot_drift(self):
        mutations = [
            ("pca-scores.csv", 1, 0, "unrelated-sample", "PCA sample identities"),
            ("pca-scores.csv", 1, 1, "treated", "PCA metadata differs"),
            ("pca-features.csv", 1, 0, "gene-zero", "PCA feature identities"),
            ("pca-features.csv", 1, 0, "gene-up", "PCA feature identities"),
            ("size-factors.csv", 1, 0, "unrelated-sample", "Size-factor sample identities"),
            ("size-factors.csv", 1, 1, 0, "size factors must be positive"),
        ]
        for filename, row, column, value, error in mutations:
            with self.subTest(filename=filename, row=row, value=value):
                def mutate(tables):
                    tables[filename][row][column] = value
                with self.assertRaisesRegex(ValueError, error):
                    self.analyze(mutate=mutate)

    def test_invalid_de_status_probability_and_unavailable_raw_p_are_rejected(self):
        for column, value, error in ((7, "all_zero", "availability status"), (6, 1.1, "declared range"),
                                     (6, -0.1, "declared range"), (5, "NA", "cannot exist without"),
                                     (2, "Inf", "non-finite")):
            with self.subTest(column=column, value=value):
                def mutate(tables):
                    tables["differential-expression.csv"][1][column] = value
                with self.assertRaisesRegex(ValueError, error):
                    self.analyze(mutate=mutate)

    def test_engine_metadata_cannot_claim_different_analysis(self):
        for key, value in (("comparison_level", "control"), ("design", "batch_condition"),
                           ("alpha", "0.5"), ("retained_genes", "999"), ("pca_blind", "TRUE"),
                           ("condition_level_1", "treated")):
            with self.subTest(key=key):
                def mutate(tables):
                    for row in tables["analysis-metadata.csv"][1:]:
                        if row[0] == key:
                            row[1] = value
                with self.assertRaisesRegex(ValueError, "metadata|factor levels"):
                    self.analyze(mutate=mutate)

    def test_unused_optional_sample_metadata_is_still_preserved(self):
        samples = [METADATA[0] + ["batch", "subject"]] + [row + ["batch-1", "subject-" + row[0]] for row in METADATA[1:]]
        self.inputs["samples_path"] = csv_bytes(samples)
        def mutate(tables):
            table = tables["pca-scores.csv"]
            table[0] += ["batch", "subject"]
            for row in table[1:]:
                row += ["batch-1", "subject-" + row[0]]
        result, _ = self.analyze(mutate=mutate)
        self.assertEqual([row["subject"] for row in result["pca"]["samples"]], ["subject-" + sample for sample in SAMPLES])
        with self.assertRaisesRegex(ValueError, "PCA metadata differs"):
            self.analyze()

    def test_enrichment_uses_only_finite_adjusted_p_and_strict_alpha(self):
        self.add_sets()
        result, _ = self.analyze()
        enrichment = result["enrichment"]
        self.assertEqual(enrichment["status"], "completed")
        self.assertEqual(enrichment["selected_genes"], ["gene-up", "gene-down"])
        self.assertEqual(enrichment["background_genes"], ["gene-up", "gene-down", "gene-flat"])
        self.assertEqual(enrichment["tested_gene_sets"], 2)
        by_name = {row["name"]: row for row in enrichment["rows"]}
        self.assertAlmostEqual(by_name["up-and-down"]["p_value"], 1/3)
        self.assertAlmostEqual(by_name["up-and-down"]["adjusted_p_value"], 2/3)
        self.assertEqual(by_name["up-and-down"]["excluded_members_outside_background"], 1)
        self.assertEqual(by_name["flat-only"]["p_value"], 1)

    def test_enrichment_full_background_above_five_thousand_is_not_truncated(self):
        rows = [{"gene_id": f"gene-{index}", "padj": .001 if index == 0 else .9} for index in range(6001)]
        supplied = {**GENE_SETS, "sets": [{"name": "singleton", "genes": ["gene-0"]},
                                         {"name": "other", "genes": ["gene-6000"]}]}
        result = compute_rnaseq._enrich(rows, .05, supplied)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(len(result["background_genes"]), 6001)
        self.assertEqual(result["background_genes"][-1], "gene-6000")
        self.assertEqual(result["selected_genes"], ["gene-0"])
        by_name = {row["name"]: row for row in result["rows"]}
        self.assertAlmostEqual(by_name["singleton"]["p_value"], 1/6001)
        self.assertAlmostEqual(by_name["singleton"]["adjusted_p_value"], 2/6001)


if __name__ == "__main__":
    unittest.main()
