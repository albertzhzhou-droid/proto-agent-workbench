"""Analytic and boundary checks for chemistry analysis and statistical operators."""
from __future__ import annotations

import copy
import hashlib
import importlib.metadata
import importlib.util
import json
import math
from pathlib import Path
import sys
import unittest

import numpy as np
from scipy import stats

APP = Path(__file__).resolve().parents[1]
ROOT = APP.parents[1]
MODULE = APP / "runtime/chem-integration/chem_analysis.py"
spec = importlib.util.spec_from_file_location("chem_analysis", MODULE)
analysis = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analysis)
EVIDENCE = []


def example(name):
    return copy.deepcopy(next(row[5] for row in analysis.operator_specs() if row[0] == name))


class ChemistryAnalysisTests(unittest.TestCase):
    def test_every_catalog_example_runs_with_json_and_plot_contract(self):
        for operator, _, _, _, schema, data, _, _ in analysis.operator_specs():
            with self.subTest(operator=operator):
                result = analysis.OPERATORS[operator](copy.deepcopy(data))
                json.dumps(result, allow_nan=False)
                self.assertTrue(result["rows"])
                self.assertFalse(set(schema["required"]) - set(data))
                for plot in (value for key, value in result.items() if key.endswith("visualization")):
                    self.assertEqual(set(plot), {"x_label", "x_unit", "y_label", "y_unit", "series"})
                    for series in plot["series"]:
                        self.assertEqual(len(series["x"]), len(series["y"]))
                        self.assertIn(series["style"], {"line", "points"})
                EVIDENCE.append({"case": "catalog_example", "operator": operator, "rows": len(result["rows"]), "result_sha256": hashlib.sha256(json.dumps(result, sort_keys=True, allow_nan=False).encode()).hexdigest()})

    def test_replicates_known_sample_sd_and_t_interval(self):
        result = analysis.summarize_replicates({"groups": [{"label": "standard", "values": [1, 2, 3, 4, 5]}], "unit": "mg/L"})["rows"][0]
        self.assertEqual(result["n"], 5)
        self.assertEqual(result["mean"], 3)
        self.assertAlmostEqual(result["sd"], math.sqrt(2.5), places=14)
        self.assertAlmostEqual(result["sem"], math.sqrt(.5), places=14)
        self.assertAlmostEqual(result["ci_low"], 1.0367568385, places=9)
        self.assertAlmostEqual(result["ci_high"], 4.9632431615, places=9)
        self.assertAlmostEqual(result["rsd_percent"], 100*math.sqrt(2.5)/3, places=12)
        EVIDENCE.append({"case": "replicate_known_values", **result})

    def test_missing_replicates_require_explicit_policy_and_preserve_positions(self):
        data = {"groups": [{"label": "standard", "values": [1, None, 3]}], "unit": "mg/L"}
        with self.assertRaises(analysis.AnalysisError) as caught:
            analysis.summarize_replicates(data)
        self.assertEqual(caught.exception.code, "MISSING_VALUES")
        data["missing"] = "omit"
        result = analysis.summarize_replicates(data)
        self.assertEqual(result["rows"][0]["n_missing"], 1)
        self.assertEqual(result["rows"][0]["mean"], 2)
        self.assertEqual(result["visualization"]["series"][0]["y"], [1, None, 3])

    def test_singleton_empty_after_omission_and_zero_mean_are_explicit(self):
        result = analysis.summarize_replicates({"groups": [{"label": "single", "values": [7]}, {"label": "empty", "values": [None]}, {"label": "zero", "values": [-1, 1]}], "unit": "a.u.", "missing": "omit"})
        self.assertIsNone(result["rows"][0]["sd"])
        self.assertIsNone(result["rows"][0]["ci_low"])
        self.assertIsNone(result["rows"][1]["mean"])
        self.assertEqual(result["rows"][1]["n"], 0)
        self.assertIsNone(result["rows"][2]["rsd_percent"])
        json.dumps(result, allow_nan=False)

    def test_welch_formula_matches_scipy_independent_reference(self):
        a, b = [1, 2, 3], [2, 4, 6]
        result = analysis.compare_assay_groups({"group_a": a, "group_b": b, "unit": "mg/L"})["rows"][0]
        reference = stats.ttest_ind(a, b, equal_var=False)
        interval = reference.confidence_interval()
        self.assertAlmostEqual(result["mean_difference"], -2)
        self.assertAlmostEqual(result["standard_error"], math.sqrt(5/3))
        self.assertAlmostEqual(result["degrees_of_freedom"], 50/17)
        self.assertAlmostEqual(result["t_statistic"], float(reference.statistic), places=13)
        self.assertAlmostEqual(result["p_value_two_sided"], float(reference.pvalue), places=13)
        self.assertAlmostEqual(result["ci_low"], float(interval.low), places=13)
        self.assertAlmostEqual(result["ci_high"], float(interval.high), places=13)
        EVIDENCE.append({"case": "welch_scipy_reference", **result})

    def test_paired_known_differences_and_strict_pairing(self):
        data = {"group_a": [1, 2, 3], "group_b": [2, 4, 4], "unit": "mg/L", "method": "paired"}
        result = analysis.compare_assay_groups(data)["rows"][0]
        reference = stats.ttest_rel(data["group_a"], data["group_b"])
        self.assertAlmostEqual(result["t_statistic"], -4)
        self.assertAlmostEqual(result["p_value_two_sided"], float(reference.pvalue), places=13)
        self.assertAlmostEqual(result["ci_low"], float(reference.confidence_interval().low), places=13)
        data["group_b"].append(5)
        with self.assertRaises(analysis.AnalysisError) as caught:
            analysis.compare_assay_groups(data)
        self.assertEqual(caught.exception.code, "PAIRING_MISMATCH")

    def test_zero_variance_assay_never_returns_infinite_statistic_or_fake_pvalue(self):
        for method in ["welch", "paired"]:
            result = analysis.compare_assay_groups({"group_a": [1, 1, 1], "group_b": [2, 2, 2], "unit": "mg/L", "method": method})
            self.assertEqual(result["rows"][0]["mean_difference"], -1)
            self.assertIsNone(result["rows"][0]["p_value_two_sided"])
            self.assertIsNone(result["rows"][0]["t_statistic"])
            self.assertIsNone(result["rows"][0]["ci_low"])
            self.assertTrue(result["warnings"])
            json.dumps(result, allow_nan=False)

    def test_calibration_exact_line_inverse_and_dilution(self):
        data = {"concentrations": [0, 1, 2, 3, 4], "responses": [1, 3, 5, 7, 9], "concentration_unit": "mg/L", "response_unit": "mAU", "unknowns": [{"label": "diluted", "response": 5, "dilution_factor": 3}]}
        result = analysis.fit_calibration_curve(data)
        self.assertAlmostEqual(result["fit"]["slope"], 2, places=13)
        self.assertAlmostEqual(result["fit"]["intercept"], 1, places=13)
        self.assertAlmostEqual(result["unknowns"][0]["measured_concentration"], 2, places=13)
        self.assertAlmostEqual(result["unknowns"][0]["original_concentration"], 6, places=13)
        self.assertFalse(result["unknowns"][0]["extrapolated"])
        self.assertLess(result["fit"]["residual_rmse"], 1e-13)
        EVIDENCE.append({"case": "calibration_exact_line_and_dilution", "fit": result["fit"], "unknown": result["unknowns"][0]})

    def test_weighted_fit_matches_closed_form_and_weight_scale_invariance(self):
        x, y, w = np.asarray([0., 1., 2., 3.]), np.asarray([1., 2.8, 5.3, 6.7]), np.asarray([1., 4., 9., 16.])
        data = {"concentrations": x.tolist(), "responses": y.tolist(), "weights": w.tolist(), "concentration_unit": "mg/L", "response_unit": "mAU"}
        result = analysis.fit_calibration_curve(data)
        xm, ym = np.average(x, weights=w), np.average(y, weights=w)
        slope = float(np.sum(w*(x-xm)*(y-ym))/np.sum(w*(x-xm)**2))
        intercept = float(ym-slope*xm)
        self.assertAlmostEqual(result["fit"]["slope"], slope, places=13)
        self.assertAlmostEqual(result["fit"]["intercept"], intercept, places=13)
        data["weights"] = (w*10).tolist()
        rescaled = analysis.fit_calibration_curve(data)
        self.assertEqual(result["coefficients"], rescaled["coefficients"])

    def test_calibration_flat_extrapolation_zero_weights_and_singular(self):
        data = {"concentrations": [0, 1, 2, 3], "responses": [2, 2, 2, 2], "concentration_unit": "mg/L", "response_unit": "mAU", "unknowns": [{"response": 5}]}
        result = analysis.fit_calibration_curve(data)
        self.assertIsNone(result["unknowns"][0]["measured_concentration"])
        data["responses"] = [1, 3, 5, 7]
        data["unknowns"] = [{"response": 11}]
        self.assertTrue(analysis.fit_calibration_curve(data)["unknowns"][0]["extrapolated"])
        for invalid in [{"weights": [1, 1, 0, 1]}, {"concentrations": [1, 1, 1, 1]}, {"responses": [1, 3, 5]}]:
            with self.subTest(invalid=invalid), self.assertRaises(analysis.AnalysisError):
                analysis.fit_calibration_curve({**data, **invalid})

    def test_calibration_is_stable_under_large_concentration_offset(self):
        result = analysis.fit_calibration_curve({"concentrations": [1e9+i for i in range(5)], "responses": [1, 3, 5, 7, 9], "concentration_unit": "mg/L", "response_unit": "mAU"})
        self.assertAlmostEqual(result["fit"]["slope"], 2, places=12)
        self.assertLess(result["fit"]["residual_rmse"], 1e-13)

    def test_spectrum_triangular_peak_and_interpolated_region_area(self):
        result = analysis.analyze_spectrum({"x": [-2, -1, 0, 1, 2], "y": [0, 0, 1, 0, 0], "x_label": "Time", "x_unit": "min", "y_label": "Response", "y_unit": "mAU", "regions": [{"start": -.5, "end": .5}]})
        self.assertEqual(len(result["peaks"]), 1)
        self.assertEqual(result["peaks"][0]["x"], 0)
        self.assertEqual(result["peaks"][0]["half_prominence_width"], 1)
        self.assertEqual(result["total_area"], 1)
        self.assertEqual(result["integrations"][0]["area"], .75)
        EVIDENCE.append({"case": "triangular_peak_and_boundary_interpolation", "peak": result["peaks"][0], "area": result["total_area"], "region": result["integrations"][0]})

    def test_gaussian_peak_area_and_width_match_analytic_values(self):
        x = np.linspace(-6, 6, 1201)
        result = analysis.analyze_spectrum({"x": x.tolist(), "y": np.exp(-x**2/2).tolist(), "x_label": "Wavenumber", "x_unit": "cm^-1", "y_label": "Absorbance", "y_unit": "a.u."})
        self.assertLess(abs(result["total_area"]-math.sqrt(2*math.pi)), 1e-8)
        self.assertLess(abs(result["peaks"][0]["half_prominence_width"]-2*math.sqrt(2*math.log(2))), 1e-5)
        EVIDENCE.append({"case": "gaussian_analytic", "area_error": abs(result["total_area"]-math.sqrt(2*math.pi)), "width_error": abs(result["peaks"][0]["half_prominence_width"]-2*math.sqrt(2*math.log(2)))})

    def test_smoothing_preserves_quadratic_and_requires_uniform_axis(self):
        x = np.arange(11.)
        data = {"x": x.tolist(), "y": (2*x*x+3*x+1).tolist(), "x_label": "Time", "x_unit": "min", "y_label": "Response", "y_unit": "mAU", "smooth_window": 5, "polynomial_order": 2}
        result = analysis.analyze_spectrum(data)
        self.assertLess(max(abs(row["smoothed"]-row["raw"]) for row in result["rows"]), 1e-10)
        data["x"][-1] = 10.1
        with self.assertRaises(analysis.AnalysisError) as caught:
            analysis.analyze_spectrum(data)
        self.assertEqual(caught.exception.code, "NONUNIFORM_SMOOTHING")

    def test_nonuniform_endpoint_baseline_uses_coordinate_not_sample_index(self):
        result = analysis.analyze_spectrum({"x": [0, 1, 4, 10], "y": [2, 5, 14, 32], "x_label": "Time", "x_unit": "min", "y_label": "Response", "y_unit": "mAU", "baseline": "linear_endpoints"})
        self.assertEqual(result["total_area"], 0)
        self.assertTrue(all(row["corrected"] == 0 for row in result["rows"]))

    def test_descending_spectrum_and_negative_peaks_are_supported(self):
        result = analysis.analyze_spectrum({"x": [4, 3, 2, 1, 0], "y": [0, 0, -1, 0, 0], "x_label": "Shift", "x_unit": "ppm", "y_label": "Response", "y_unit": "a.u.", "polarity": "negative"})
        self.assertEqual(result["rows"][0]["x"], 0)
        self.assertEqual(result["peaks"][0]["x"], 2)
        self.assertEqual(result["peaks"][0]["height"], -1)
        self.assertEqual(result["total_area"], -1)

    def test_spectrum_rejects_duplicate_axis_bad_window_and_region(self):
        data = example("analyze_spectrum")
        for patch in [{"x": [0]*11}, {"smooth_window": 4}, {"regions": [{"start": -1, "end": 1}]}]:
            with self.subTest(patch=patch), self.assertRaises(analysis.AnalysisError):
                analysis.analyze_spectrum({**data, **patch})

    def test_pca_known_rank_one_variance_and_constant_feature(self):
        data = {"columns": ["x", "twice x", "constant"], "samples": [{"id": str(i), "values": [i, 2*i, 7]} for i in range(1, 6)], "autoscale": True, "components": 2}
        result = analysis.chemical_pca(data)
        self.assertEqual(result["dropped_columns"], ["constant"])
        self.assertAlmostEqual(result["explained_variance"][0]["variance"], 2, places=13)
        self.assertAlmostEqual(result["explained_variance"][0]["explained_variance_ratio"], 1, places=13)
        self.assertAlmostEqual(result["loadings"][0]["PC1"], 1/math.sqrt(2), places=13)
        self.assertAlmostEqual(result["loadings"][1]["PC1"], 1/math.sqrt(2), places=13)
        self.assertAlmostEqual(result["rows"][0]["PC1"], -2*math.sqrt(2)/math.sqrt(2.5), places=13)
        self.assertLess(result["reconstruction_rmse_processed"], 1e-14)
        self.assertEqual(result, analysis.chemical_pca(data))
        EVIDENCE.append({"case": "pca_known_rank_one", "variance": result["explained_variance"], "loadings": result["loadings"], "reconstruction_rmse": result["reconstruction_rmse_processed"]})

    def test_pca_matches_covariance_eigenvalues_without_scaling(self):
        data = {"columns": ["a", "b"], "samples": [{"id": str(i), "values": row} for i, row in enumerate([[1, 3], [2, 1], [4, 9], [6, 5]])], "autoscale": False, "components": 2}
        result = analysis.chemical_pca(data)
        covariance = np.cov(np.asarray([s["values"] for s in data["samples"]]), rowvar=False, ddof=1)
        expected = np.linalg.eigvalsh(covariance)[::-1]
        for actual, value in zip(result["explained_variance"], expected):
            self.assertAlmostEqual(actual["variance"], float(value), places=12)
        self.assertLess(result["reconstruction_rmse_processed"], 1e-14)

    def test_pca_rejects_missing_duplicate_ids_and_insufficient_variation(self):
        data = example("chemical_pca")
        cases = []
        missing = copy.deepcopy(data)
        missing["samples"][0]["values"][0] = None
        cases.append(missing)
        duplicate = copy.deepcopy(data)
        duplicate["samples"][1]["id"] = duplicate["samples"][0]["id"]
        cases.append(duplicate)
        constant = copy.deepcopy(data)
        for sample in constant["samples"]:
            sample["values"] = [1, 1, 1]
        cases.append(constant)
        cases.append({**data, "components": 100})
        for invalid in cases:
            with self.subTest(invalid=invalid), self.assertRaises(analysis.AnalysisError):
                analysis.chemical_pca(invalid)

    def test_numeric_booleans_nan_infinity_and_unknown_fields_rejected(self):
        for bad in [True, float("nan"), float("inf"), "1"]:
            for name, field in [("compare_assay_groups", "group_a"), ("fit_calibration_curve", "responses"), ("analyze_spectrum", "y")]:
                data = example(name)
                data[field][0] = bad
                with self.subTest(operator=name, bad=bad), self.assertRaises(analysis.AnalysisError):
                    analysis.OPERATORS[name](data)
        for name in analysis.OPERATORS:
            with self.subTest(operator=name), self.assertRaises(analysis.AnalysisError):
                analysis.OPERATORS[name]({**example(name), "execute_code": "ignored?"})


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ChemistryAnalysisTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    destination = ROOT / "build/chem-analysis-qa"
    destination.mkdir(parents=True, exist_ok=True)
    receipt = {"scope": "Local numerical and invalid-input checks; no model, UI, clinical or instrument-validation claims", "passed": result.wasSuccessful(), "tests_run": result.testsRun,
               "failures": [str(case) for case, _ in result.failures], "errors": [str(case) for case, _ in result.errors],
               "python": sys.version, "dependencies": {key: importlib.metadata.version(key) for key in ("numpy", "scipy")},
               "source_sha256": hashlib.sha256(MODULE.read_bytes()).hexdigest(), "cases": EVIDENCE}
    (destination / "analysis-numerical-acceptance.json").write_text(json.dumps(receipt, indent=2, allow_nan=False), encoding="utf-8")
    sys.exit(0 if result.wasSuccessful() else 1)
