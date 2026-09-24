"""Analytic and independent-library references for inference result contracts."""
from __future__ import annotations

import importlib.util
import json
import math
import unittest

from proto_agent.compute_stats import TOOLS, compare_two_groups, correlation


HAS_NUMERICS = all(importlib.util.find_spec(name) is not None for name in ("numpy", "scipy"))


class InferenceSchemaTests(unittest.TestCase):
    def test_confidence_schema_is_explicit_and_optional(self):
        for name in ("compare_two_groups", "correlation"):
            schema = TOOLS[name]["input_schema"]
            confidence = schema["properties"]["confidence_level"]
            self.assertEqual(confidence["default"], 0.95)
            self.assertEqual(confidence["exclusiveMinimum"], 0)
            self.assertEqual(confidence["exclusiveMaximum"], 1)
            self.assertNotIn("confidence_level", schema["required"])

    def test_confidence_rejects_endpoints_booleans_nonfinite_and_wrong_types(self):
        for value in (0, 1, -0.1, 1.1, True, None, "0.95", math.inf, math.nan):
            for method, args in (
                (compare_two_groups, {"group_a": [1, 2, 3], "group_b": [2, 3, 5]}),
                (correlation, {"x": [1, 2, 3], "y": [1, 3, 2]}),
            ):
                with self.subTest(value=value, operation=method.__name__), self.assertRaises(ValueError):
                    method({**args, "confidence_level": value})


@unittest.skipUnless(HAS_NUMERICS, "NumPy and SciPy are required for numerical inference checks.")
class InferenceNumericalTests(unittest.TestCase):
    def assert_interval(self, result, lower, upper, places=11):
        interval = result["confidence_interval"]
        self.assertEqual(interval["status"], "available")
        self.assertAlmostEqual(interval["lower"], lower, places=places)
        self.assertAlmostEqual(interval["upper"], upper, places=places)
        self.assertLess(interval["lower"], interval["upper"])
        json.dumps(result, allow_nan=False)

    def test_paired_two_observation_interval_uses_exact_cauchy_quantile(self):
        # Differences [1, 3]: mean=2, SE=1, df=1. The t_1 CDF is a Cauchy CDF.
        result = compare_two_groups({"group_a": [2, 7], "group_b": [1, 4], "method": "paired_t"})
        critical = math.tan(math.pi * 0.475)
        self.assert_interval(result, 2-critical, 2+critical, places=8)
        self.assertEqual(result["degrees_of_freedom"], 1)
        self.assertEqual(result["standard_error"], 1)
        self.assertEqual(result["confidence_level"], 0.95)
        self.assertEqual(result["mean_difference_orientation"], "group_a_minus_group_b")
        self.assertEqual(result["effect_sizes"][0]["name"], "cohen_dz")
        self.assertAlmostEqual(result["effect_sizes"][0]["estimate"], math.sqrt(2))

    def test_student_interval_tabulated_t4_and_gamma_correction_closed_form(self):
        result = compare_two_groups({"group_a": [1, 2, 3], "group_b": [2, 4, 6], "method": "student_t"})
        # NIST t-table t(.975, 4)=2.776445105..., pooled variance=2.5.
        margin = 2.7764451051977987 * math.sqrt(5/3)
        self.assert_interval(result, -2-margin, -2+margin)
        effects = {item["name"]: item for item in result["effect_sizes"]}
        self.assertAlmostEqual(effects["cohen_d"]["estimate"], -math.sqrt(8/5))
        # J(4)=Gamma(2)/(sqrt(2)*Gamma(3/2))=sqrt(2/pi).
        self.assertAlmostEqual(effects["hedges_g"]["bias_correction"], math.sqrt(2/math.pi))
        self.assertAlmostEqual(effects["hedges_g"]["estimate"], -4/math.sqrt(5*math.pi))

    def test_welch_unequal_sizes_and_variances_matches_reference_result_interval(self):
        from scipy.stats import ttest_ind
        a, b = [1, 2, 3], [2, 4, 6, 8, 10]
        result = compare_two_groups({"group_a": a, "group_b": b, "confidence_level": 0.9})
        reference = ttest_ind(a, b, equal_var=False).confidence_interval(confidence_level=0.9)
        self.assert_interval(result, reference.low, reference.high)
        self.assertAlmostEqual(result["degrees_of_freedom"], 98/19)
        self.assertAlmostEqual(result["standard_error"], math.sqrt(7/3))
        self.assertEqual(result["confidence_interval"]["method"], "welch_t")
        self.assertEqual([effect["name"] for effect in result["effect_sizes"]], ["cohen_d"])
        self.assertTrue(any("unequal variances" in text for text in result["assumptions"]))

    def test_swapping_groups_reverses_effects_and_interval_preserving_pvalue(self):
        for method in ("welch_t", "student_t", "paired_t", "mann_whitney"):
            a, b = [1, 3, 6, 10], [0, 1, 3, 6]
            first = compare_two_groups({"group_a": a, "group_b": b, "method": method})
            reverse = compare_two_groups({"group_a": b, "group_b": a, "method": method})
            with self.subTest(method=method):
                self.assertAlmostEqual(first["p_value"], reverse["p_value"])
                self.assertAlmostEqual(first["mean_difference"], -reverse["mean_difference"])
                for effect, reversed_effect in zip(first["effect_sizes"], reverse["effect_sizes"]):
                    self.assertAlmostEqual(effect["estimate"], -reversed_effect["estimate"])
                if method != "mann_whitney":
                    self.assertAlmostEqual(first["confidence_interval"]["lower"], -reverse["confidence_interval"]["upper"])
                    self.assertAlmostEqual(first["confidence_interval"]["upper"], -reverse["confidence_interval"]["lower"])

    def test_one_constant_group_has_real_positive_uncertainty(self):
        result = compare_two_groups({"group_a": [1, 1, 1], "group_b": [1, 2, 3]})
        # The t_2 97.5% quantile follows from F(t)=1/2+t/(2*sqrt(t*t+2)).
        critical = math.sqrt(2*0.95**2/(1-0.95**2))
        # SciPy's inverse t CDF differs from this closed form by about 3e-11.
        self.assert_interval(result, -1-critical/math.sqrt(3), -1+critical/math.sqrt(3), places=9)
        self.assertGreater(result["standard_error"], 0)

    def test_paired_difference_avoids_cancellation_between_large_group_means(self):
        result = compare_two_groups({"group_a": [1e16, 1e16+2, 1e16+8],
                                     "group_b": [1e16, 1e16, 1e16], "method": "paired_t"})
        self.assertAlmostEqual(result["mean_difference"], 10/3)
        self.assertAlmostEqual(result["confidence_interval"]["estimate"], 10/3)
        self.assertAlmostEqual(result["statistic"], result["mean_difference"]/result["standard_error"])

    def test_mann_whitney_tie_effect_is_pairwise_probability_difference(self):
        # A=[1,2,2], B=[2,3]: 0 wins, 4 losses and 2 ties => effect=-4/6.
        result = compare_two_groups({"group_a": [1, 2, 2], "group_b": [2, 3], "method": "mann_whitney"})
        effect = result["effect_sizes"][0]
        self.assertEqual(effect["name"], "rank_biserial")
        self.assertAlmostEqual(effect["estimate"], -2/3)
        self.assertEqual(result["confidence_interval"]["status"], "unavailable")
        self.assertIsNone(result["confidence_interval"]["lower"])
        self.assertIsNone(result["confidence_interval"]["upper"])
        self.assertIsNone(result["standard_error"])

    def test_pearson_zero_correlation_interval_known_normal_quantile(self):
        result = correlation({"x": [-1, -1, 1, 1], "y": [-1, 1, -1, 1]})
        expected = math.tanh(1.959963984540054)
        self.assert_interval(result, -expected, expected)
        self.assertEqual(result["confidence_interval"]["method"], "fisher_z")

    def test_pearson_interval_matches_scipy_reference_at_nonsymmetric_correlation(self):
        from scipy.stats import pearsonr
        x, y = [1, 2, 3, 4, 5], [2, 1, 4, 3, 5]
        reference = pearsonr(x, y).confidence_interval(confidence_level=0.9)
        result = correlation({"x": x, "y": y, "confidence_level": 0.9})
        self.assert_interval(result, reference.low, reference.high)
        self.assertGreaterEqual(result["confidence_interval"]["lower"], -1)
        self.assertLessEqual(result["confidence_interval"]["upper"], 1)

    def test_perfect_tiny_and_rank_correlations_do_not_report_zero_uncertainty(self):
        cases = [
            {"x": [1, 2, 3], "y": [3, 1, 2]},
            {"x": [1, 2, 3, 4], "y": [2, 4, 6, 8]},
            {"x": [1, 2, 3, 4], "y": [-2, -4, -6, -8]},
            {"x": [1, 2, 3, 4, 5], "y": [2, 1, 4, 3, 5], "method": "spearman"},
        ]
        for args in cases:
            with self.subTest(args=args):
                result = correlation(args)
                interval = result["confidence_interval"]
                self.assertEqual(interval["status"], "unavailable")
                self.assertIsNone(interval["lower"])
                self.assertIsNone(interval["upper"])
                self.assertTrue(interval["reason"])
                self.assertTrue(result["warnings"])
                json.dumps(result, allow_nan=False)

    def test_confidence_level_changes_coverage_without_changing_effect_or_pvalue(self):
        args = {"group_a": [1, 2, 3], "group_b": [2, 4, 6]}
        narrow = compare_two_groups({**args, "confidence_level": 0.8})
        broad = compare_two_groups({**args, "confidence_level": 0.99})
        self.assertEqual(narrow["p_value"], broad["p_value"])
        self.assertEqual(narrow["effect_sizes"], broad["effect_sizes"])
        self.assertLess(broad["confidence_interval"]["lower"], narrow["confidence_interval"]["lower"])
        self.assertGreater(broad["confidence_interval"]["upper"], narrow["confidence_interval"]["upper"])

    def test_degenerate_variance_and_constant_correlation_remain_explicit_errors(self):
        cases = [
            (compare_two_groups, {"group_a": [1, 1], "group_b": [2, 2]}),
            (compare_two_groups, {"group_a": [2, 3], "group_b": [1, 2], "method": "paired_t"}),
            (correlation, {"x": [1, 1, 1, 1], "y": [1, 2, 3, 4]}),
        ]
        for method, args in cases:
            with self.subTest(operation=method.__name__), self.assertRaises(ValueError):
                method(args)

    def test_unresolvable_confidence_level_does_not_return_a_zero_width_interval(self):
        for method, args in (
            (compare_two_groups, {"group_a": [1, 2, 3], "group_b": [2, 4, 6]}),
            (correlation, {"x": [-1, -1, 1, 1], "y": [-1, 1, -1, 1]}),
        ):
            with self.subTest(operation=method.__name__), self.assertRaisesRegex(ValueError, "floating-point"):
                method({**args, "confidence_level": math.nextafter(0, 1)})


if __name__ == "__main__":
    unittest.main()
