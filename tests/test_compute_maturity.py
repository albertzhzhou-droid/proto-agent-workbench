"""Dependency-free checks for conservative computation maturity metadata."""
from __future__ import annotations

import ast
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from proto_agent.compute_maturity import METHOD_STAGES, SCHEMA_VERSION, maturity_for


ROOT = Path(__file__).resolve().parents[1]
STATISTICS = ("descriptive_statistics", "compare_two_groups", "correlation", "linear_regression",
              "one_way_anova", "adjust_pvalues", "principal_component_analysis", "contingency_test")
SPECIALIZED = ("fit_genomic_prediction_model", "bayesian_finemapping_with_deep_vi",
               "grade_adverse_events_using_vcog_ctcae", "analyze_accelerated_stability_of_pharmaceutical_formulations",
               "predict_o_glycosylation_hotspots", "analyze_abr_waveform_p1_metrics")


class ComputeMaturityTests(unittest.TestCase):
    def test_unknown_methods_remain_unassessed_and_do_not_inherit_name_prefixes(self):
        for name in ("new_method", "compare_two_groups_v2", "statistics_custom", "correlation_alias"):
            record = maturity_for(name, {})
            self.assertEqual(record["method_stage"], "method-implementation")
            self.assertEqual(record["evidence"], [])
            self.assertTrue(record["known_limitations"])

    def test_availability_and_caller_claims_cannot_promote_scientific_validity(self):
        claims = {"available": True, "implementation": "validated", "scientific_validation": "validated",
                  "domain_validation": "passed", "method_stage": "production-ready", "maturity": {"approved": True}}
        for name in STATISTICS + SPECIALIZED + ("unknown",):
            record = maturity_for(name, claims)
            self.assertEqual(record, maturity_for(name, {"available": False}))
            self.assertEqual(record["scientific_validation"], "not-established")
            self.assertEqual(record["domain_validation"], "not-established")
            self.assertFalse(record["automatic_promotion"])
            self.assertTrue(record["availability_is_separate"])
            self.assertNotIn("available", record)

    def test_statistics_map_real_reference_tests_without_claiming_current_run(self):
        for name in STATISTICS:
            record = maturity_for(name, {})
            self.assertEqual(record["method_stage"], "numerical-reference-tested")
            self.assertTrue(record["evidence"])
            for evidence in record["evidence"]:
                self.assertEqual(evidence["execution_status"], "not-evaluated-here")
                self.assertNotIn("passed", evidence)
                self.assertNotIn("checked_at", evidence)
                self.assertTrue(evidence["test_ids"])

    def test_curated_evidence_paths_and_test_selectors_exist(self):
        parsed = {}
        for name in STATISTICS + SPECIALIZED:
            for evidence in maturity_for(name, {})["evidence"]:
                path = ROOT / evidence["path"]
                self.assertTrue(path.is_file(), evidence["path"])
                if not evidence.get("test_ids"):
                    continue
                if path not in parsed:
                    tree = ast.parse(path.read_text(encoding="utf-8-sig"))
                    parsed[path] = {f"{node.name}.{method.name}" for node in tree.body if isinstance(node, ast.ClassDef)
                                    for method in node.body if isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef))}
                for selector in evidence["test_ids"]:
                    self.assertIn(selector, parsed[path], f"{evidence['path']}:{selector}")

    def test_gblup_discloses_fixed_iteration_and_in_sample_boundaries(self):
        record = maturity_for("fit_genomic_prediction_model", {})
        self.assertEqual(record["method_stage"], "demonstration")
        limits = " ".join(record["known_limitations"])
        self.assertIn("five fixed", limits)
        self.assertIn("in-sample", limits)
        self.assertIn("cross-validation", limits)
        self.assertTrue(any(item["kind"] == "behavioral-test-definition" for item in record["evidence"]))

    def test_deepvi_repeatability_never_becomes_posterior_calibration(self):
        record = maturity_for("bayesian_finemapping_with_deep_vi", {})
        self.assertEqual(record["method_stage"], "demonstration")
        limits = " ".join(record["known_limitations"])
        self.assertIn("uncalibrated", limits)
        self.assertIn("collapse", limits)
        self.assertIn("not evidence", limits)
        self.assertIn("Seed repeatability only", record["evidence"][1]["scope"])

    def test_veterinary_grading_is_not_a_clinical_validity_label(self):
        record = maturity_for("grade_adverse_events_using_vcog_ctcae", {})
        self.assertEqual(record["method_stage"], "heuristic")
        self.assertIn("veterinary", " ".join(record["applicability"]))
        self.assertIn("reported severity", " ".join(record["known_limitations"]))
        self.assertIn("not human CTCAE", " ".join(record["known_limitations"]))

    def test_all_metadata_is_json_native_and_returned_values_are_isolated(self):
        for name in STATISTICS + SPECIALIZED + ("unknown",):
            first = maturity_for(name, {})
            expected = json.dumps(first, sort_keys=True, allow_nan=False)
            self.assertEqual(first["schema_version"], SCHEMA_VERSION)
            self.assertIn(first["method_stage"], METHOD_STAGES)
            first["known_limitations"].clear()
            first["applicability"].append("changed")
            if first["evidence"]:
                first["evidence"][0]["path"] = "changed"
            self.assertEqual(json.dumps(maturity_for(name, {}), sort_keys=True, allow_nan=False), expected)

    def test_import_does_not_load_numerical_dependencies_or_registry(self):
        result = subprocess.run([sys.executable, "-c", "import sys; import proto_agent.compute_maturity; assert not ({'numpy', 'scipy', 'torch', 'proto_agent.compute'} & set(sys.modules))"],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_invalid_helper_inputs_are_explicit_errors(self):
        for name, metadata in (("", {}), (None, {}), (" method", {}), ("method", None), ("method", [])):
            with self.subTest(name=name, metadata=metadata), self.assertRaises(ValueError):
                maturity_for(name, metadata)


class ComputeMaturityIntegrationTests(unittest.TestCase):
    def test_summary_and_detail_catalogs_share_maturity_without_conflating_dependencies(self):
        from proto_agent.compute import compute_catalog
        for missing in ([], ["not-installed"]):
            with patch("proto_agent.compute._missing", return_value=missing):
                summary = compute_catalog()
                for entry in summary["tools"]:
                    self.assertEqual(entry["available"], not missing)
                    self.assertEqual(entry["maturity"]["scientific_validation"], "not-established")
                    self.assertEqual(entry["maturity"]["domain_validation"], "not-established")
                demo = next(entry for entry in summary["tools"] if entry["id"] == "fit_genomic_prediction_model")
                detail = compute_catalog(demo["id"])["tools"][0]
                self.assertEqual(demo["maturity"], detail["maturity"])
                self.assertEqual(detail["maturity"]["method_stage"], "demonstration")

    def test_real_dependency_free_run_retains_maturity_in_receipt_and_protected_manifest(self):
        from proto_agent.compute import compute_catalog, run_compute
        from proto_agent.provenance import verify_provenance
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            request = {"tool": "predict_o_glycosylation_hotspots",
                       "arguments": {"sequence": "MASSTTAPSTSA", "window": 7, "min_st_fraction": 0.4}}
            (workspace / "request.json").write_text(json.dumps(request), encoding="utf-8")
            receipt = run_compute("request.json", workspace_root=workspace)
            manifest_path = workspace / receipt["manifest_path"]
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            catalog_maturity = compute_catalog(request["tool"])["tools"][0]["maturity"]
            self.assertEqual(receipt["maturity"], catalog_maturity)
            self.assertEqual(manifest["maturity"], catalog_maturity)
            self.assertEqual(receipt["maturity"]["method_stage"], "heuristic")
            self.assertEqual(receipt["review_status"], "human_review_required")
            self.assertNotIn("maturity", receipt["result"])
            provenance_path = manifest_path.with_name("provenance.json")
            self.assertTrue(verify_provenance(provenance_path, workspace_root=workspace)["ok"])
            manifest["maturity"]["scientific_validation"] = "validated"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            self.assertFalse(verify_provenance(provenance_path, workspace_root=workspace)["ok"])


if __name__ == "__main__":
    unittest.main()
