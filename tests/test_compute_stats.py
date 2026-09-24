"""Independent numerical answers and boundary checks for native statistics."""
from __future__ import annotations

import builtins
import copy
import importlib.util
import json
import math
import subprocess
import sys
import unittest
from unittest.mock import patch

from proto_agent.compute_stats import HANDLERS, TOOLS


HAS_NUMERICS = all(importlib.util.find_spec(name) is not None for name in ("numpy", "scipy"))


class ComputeStatsContractTests(unittest.TestCase):
    def test_catalog_matches_handlers_and_clearly_labels_native_implementations(self):
        self.assertEqual(set(TOOLS), set(HANDLERS))
        self.assertEqual(len(TOOLS), 8)
        for metadata in TOOLS.values():
            self.assertEqual(metadata["implementation"], "proto-native")
            self.assertEqual(metadata["upstream_functions"], [])
            self.assertEqual(metadata["dependency"], ["numpy", "scipy"])
            self.assertFalse(metadata["input_schema"]["additionalProperties"])
            json.dumps(metadata, allow_nan=False)

    def test_import_does_not_load_optional_scientific_dependencies(self):
        result = subprocess.run(
            [sys.executable, "-c", "import sys; import proto_agent.compute_stats; assert 'numpy' not in sys.modules; assert 'scipy' not in sys.modules"],
            capture_output=True, text=True, timeout=20,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_optional_dependency_has_actionable_failure(self):
        original_import = builtins.__import__
        def blocked(name, *args, **kwargs):
            if name == "numpy":
                raise ImportError("test missing NumPy")
            return original_import(name, *args, **kwargs)
        with patch("builtins.__import__", side_effect=blocked):
            with self.assertRaisesRegex(ValueError, "optional NumPy and SciPy"):
                HANDLERS["descriptive_statistics"]({"values": [1, 2, 3]})

    def test_unknown_fields_and_missing_arguments_fail(self):
        for name, metadata in TOOLS.items():
            with self.subTest(tool=name), self.assertRaises(ValueError):
                HANDLERS[name]({**metadata["example"], "execute": "untrusted"})
            with self.subTest(tool=name), self.assertRaises(ValueError):
                HANDLERS[name]({})

    def test_numbers_reject_booleans_nonfinite_strings_and_huge_integers(self):
        for value in (True, False, "2", None, float("inf"), float("-inf"), float("nan"), 10**1000):
            with self.subTest(value=repr(value)[:40]), self.assertRaises(ValueError):
                HANDLERS["descriptive_statistics"]({"values": [1, value]})

    def test_arrays_require_explicit_bounded_lists(self):
        for values in ([], (1, 2), "123", [1] * 5001):
            with self.subTest(length=len(values)), self.assertRaises(ValueError):
                HANDLERS["descriptive_statistics"]({"values": values})

    def test_pca_rectangular_and_resource_bounds(self):
        for arguments in (
            {"matrix": [[1, 2], [3]]}, {"matrix": [[1] * 31, [2] * 31]},
            {"matrix": [[1]] * 201}, {"matrix": [[1, 2], [3, 4]], "n_components": 2},
            {"matrix": [[1], [2]], "n_components": True}, {"matrix": [[1], [2]], "standardize": 1},
        ):
            with self.subTest(arguments=str(arguments)[:80]), self.assertRaises(ValueError):
                HANDLERS["principal_component_analysis"](arguments)

    def test_contingency_counts_and_marginal_bounds(self):
        for table in ([[[1]]], [[1.5, 2], [3, 4]], [[True, 2], [3, 4]], [[-1, 2], [3, 4]],
                      [[1_000_001, 2], [3, 4]], [[0, 0], [3, 4]], [[0, 1], [0, 2]],
                      [[1, 2], [3]], [[1, 2]], [[1, 2]] * 21):
            with self.subTest(table=str(table)[:80]), self.assertRaises(ValueError):
                HANDLERS["contingency_test"]({"table": table})
        with self.assertRaisesRegex(ValueError, "2x2"):
            HANDLERS["contingency_test"]({"table": [[1, 2, 3], [4, 5, 6]], "method": "fisher_exact"})

    def test_anova_total_bound(self):
        with self.assertRaisesRegex(ValueError, "total observations"):
            HANDLERS["one_way_anova"]({"groups": [[1, 2] * 1500, [3, 4] * 1500]})


@unittest.skipUnless(HAS_NUMERICS, "Install the NumPy/SciPy compute extra for numerical verification.")
class ComputeStatsNumericalTests(unittest.TestCase):
    def test_all_examples_are_json_native_finite_and_preserve_inputs(self):
        for name, metadata in TOOLS.items():
            arguments = copy.deepcopy(metadata["example"])
            before = copy.deepcopy(arguments)
            with self.subTest(tool=name):
                result = HANDLERS[name](arguments)
                self.assertIsInstance(result, dict)
                json.dumps(result, allow_nan=False)
                self.assertEqual(arguments, before)

    def test_sample_statistics_known_answer(self):
        result = HANDLERS["descriptive_statistics"]({"values": [1, 2, 3, 4, 5]})
        self.assertEqual(result["n"], 5)
        self.assertEqual(result["mean"], 3)
        self.assertEqual(result["median"], 3)
        self.assertEqual(result["q1"], 2)
        self.assertEqual(result["q3"], 4)
        self.assertEqual(result["sample_variance"], 2.5)
        self.assertAlmostEqual(result["sample_standard_deviation"], math.sqrt(2.5))
        self.assertAlmostEqual(result["standard_error"], math.sqrt(0.5))

    def test_singleton_is_explicitly_nullable_and_constant_sample_is_valid(self):
        result = HANDLERS["descriptive_statistics"]({"values": [7]})
        self.assertEqual(result["mean"], 7)
        for key in ("sample_variance", "sample_standard_deviation", "standard_error"):
            self.assertIsNone(result[key])
        self.assertTrue(result["warnings"])
        self.assertEqual(HANDLERS["descriptive_statistics"]({"values": [7, 7, 7]})["sample_variance"], 0)

    def test_welch_and_student_statistics_and_degrees_of_freedom(self):
        args = {"group_a": [1, 2, 3], "group_b": [2, 4, 6]}
        welch = HANDLERS["compare_two_groups"]({**args, "method": "welch_t"})
        self.assertAlmostEqual(welch["statistic"], -math.sqrt(12/5))
        self.assertAlmostEqual(welch["degrees_of_freedom"], 50/17)
        student = HANDLERS["compare_two_groups"]({**args, "method": "student_t"})
        self.assertAlmostEqual(student["statistic"], -math.sqrt(12/5))
        self.assertEqual(student["degrees_of_freedom"], 4)
        same = HANDLERS["compare_two_groups"]({"group_a": [1, 2, 3], "group_b": [1, 2, 3]})
        self.assertEqual(same["statistic"], 0)
        self.assertEqual(same["p_value"], 1)

    def test_paired_t_test_matches_closed_form_t3_tail(self):
        result = HANDLERS["compare_two_groups"]({"group_a": [1, 3, 6, 10], "group_b": [0, 1, 3, 6], "method": "paired_t"})
        self.assertAlmostEqual(result["statistic"], math.sqrt(15))
        self.assertEqual(result["degrees_of_freedom"], 3)
        expected_p = 1 - 2 / math.pi * (math.atan(math.sqrt(5)) + math.sqrt(5)/6)
        self.assertAlmostEqual(result["p_value"], expected_p, places=13)

    def test_one_constant_group_preserves_valid_welch_and_student_inference(self):
        args = {"group_a": [1, 1, 1], "group_b": [1, 2, 3]}
        welch = HANDLERS["compare_two_groups"]({**args, "method": "welch_t"})
        self.assertAlmostEqual(welch["statistic"], -math.sqrt(3))
        self.assertEqual(welch["degrees_of_freedom"], 2)
        self.assertAlmostEqual(welch["p_value"], 1-math.sqrt(3/5), places=13)
        student = HANDLERS["compare_two_groups"]({**args, "method": "student_t"})
        self.assertAlmostEqual(student["statistic"], -math.sqrt(3))
        self.assertEqual(student["degrees_of_freedom"], 4)
        u = math.sqrt(3/7)
        self.assertAlmostEqual(student["p_value"], 1-1.5*u+0.5*u**3, places=13)
        reversed_ = HANDLERS["compare_two_groups"]({"group_a": args["group_b"], "group_b": args["group_a"]})
        self.assertAlmostEqual(reversed_["statistic"], math.sqrt(3))
        self.assertAlmostEqual(reversed_["p_value"], welch["p_value"])

    def test_mann_whitney_matches_normal_tail_and_continuity_correction(self):
        result = HANDLERS["compare_two_groups"]({"group_a": [1, 2, 3], "group_b": [4, 5, 6], "method": "mann_whitney"})
        self.assertEqual(result["statistic"], 0)
        expected_p = math.erfc((4.5-0.5) / math.sqrt(5.25) / math.sqrt(2))
        self.assertAlmostEqual(result["p_value"], expected_p, places=13)
        self.assertIsNone(result["degrees_of_freedom"])
        self.assertTrue(result["warnings"])

    def test_pearson_spearman_and_regression_known_answers(self):
        # The centered vectors are orthogonal: the two-sided p-value is one.
        pearson = HANDLERS["correlation"]({"x": [-1, 0, 1], "y": [1, -2, 1]})
        self.assertAlmostEqual(pearson["coefficient"], 0)
        self.assertAlmostEqual(pearson["p_value"], 1)
        spearman = HANDLERS["correlation"]({"x": [1, 2, 3, 4, 5], "y": [2, 1, 4, 3, 5], "method": "spearman"})
        self.assertAlmostEqual(spearman["coefficient"], 0.8)
        fit = HANDLERS["linear_regression"]({"x": [0, 1, 2, 3, 4], "y": [1, 3, 5, 7, 9]})
        self.assertAlmostEqual(fit["slope"], 2)
        self.assertAlmostEqual(fit["intercept"], 1)
        self.assertAlmostEqual(fit["r_squared"], 1)
        self.assertAlmostEqual(fit["slope_standard_error"], 0)

    def test_anova_matches_closed_form_f_2_6_tail(self):
        result = HANDLERS["one_way_anova"]({"groups": [[1, 2, 3], [2, 3, 4], [4, 5, 6]]})
        self.assertAlmostEqual(result["statistic"], 7)
        self.assertEqual(result["degrees_of_freedom_between"], 2)
        self.assertEqual(result["degrees_of_freedom_within"], 6)
        self.assertAlmostEqual(result["p_value"], (6/(6+2*7))**3)

    def test_multiple_testing_known_answers_original_order_and_ties(self):
        pvalues = [0.2, 0.01, 0.04, 0.03]
        answers = {"bh": [0.2, 0.04, 0.16/3, 0.16/3], "holm": [0.2, 0.04, 0.09, 0.09], "bonferroni": [0.8, 0.04, 0.16, 0.12]}
        for method, expected in answers.items():
            result = HANDLERS["adjust_pvalues"]({"pvalues": pvalues, "method": method})
            with self.subTest(method=method):
                for actual, wanted in zip(result["adjusted_pvalues"], expected):
                    self.assertAlmostEqual(actual, wanted)
                self.assertEqual(result["rejected"], [False, True, False, False])
        ties = HANDLERS["adjust_pvalues"]({"pvalues": [0, 0.01, 0.01, 1]})
        self.assertEqual(ties["adjusted_pvalues"], [0, 0.04/3, 0.04/3, 1])

    def test_pca_covariance_and_sample_standardization_known_answers(self):
        matrix = [[1, 2], [2, 4], [3, 6]]
        result = HANDLERS["principal_component_analysis"]({"matrix": matrix, "n_components": 1})
        self.assertEqual(result["means"], [2, 4])
        self.assertAlmostEqual(result["components"][0][0], 1/math.sqrt(5))
        self.assertAlmostEqual(result["components"][0][1], 2/math.sqrt(5))
        self.assertAlmostEqual(result["scores"][0][0], -math.sqrt(5))
        self.assertAlmostEqual(result["scores"][2][0], math.sqrt(5))
        self.assertAlmostEqual(result["explained_variance"][0], 5)
        self.assertAlmostEqual(result["explained_variance_ratio"][0], 1)
        scaled = HANDLERS["principal_component_analysis"]({"matrix": matrix, "n_components": 1, "standardize": True})
        self.assertEqual(scaled["scales"], [1, 2])
        self.assertAlmostEqual(scaled["explained_variance"][0], 2)
        self.assertAlmostEqual(scaled["scores"][0][0], -math.sqrt(2))

    def test_chi_square_matches_erfc_tail(self):
        result = HANDLERS["contingency_test"]({"table": [[10, 20], [20, 10]]})
        self.assertAlmostEqual(result["statistic"], 20/3)
        self.assertAlmostEqual(result["p_value"], math.erfc(math.sqrt((20/3)/2)), places=13)
        self.assertEqual(result["expected_counts"], [[15, 15], [15, 15]])
        self.assertFalse(result["yates_correction"])

    def test_fisher_exact_matches_combinatorial_hypergeometric_tail(self):
        result = HANDLERS["contingency_test"]({"table": [[1, 9], [11, 3]], "method": "fisher_exact"})
        weights = [math.comb(12, k)*math.comb(12, 10-k) for k in range(11)]
        expected = sum(weight for weight in weights if weight <= weights[1]) / math.comb(24, 10)
        self.assertAlmostEqual(result["odds_ratio"], 1/33)
        self.assertAlmostEqual(result["p_value"], expected, places=13)
        infinite = HANDLERS["contingency_test"]({"table": [[1, 0], [0, 1]], "method": "fisher_exact"})
        self.assertIsNone(infinite["odds_ratio"])
        self.assertTrue(infinite["warnings"])
        self.assertEqual(infinite["p_value"], 1)
        json.dumps(infinite, allow_nan=False)

    def test_invalid_methods_pvalues_and_degenerate_inputs_fail(self):
        cases = [
            ("compare_two_groups", {"group_a": [1, 1], "group_b": [2, 2]}),
            ("compare_two_groups", {"group_a": [1, 2], "group_b": [1, 2, 3], "method": "paired_t"}),
            ("compare_two_groups", {"group_a": [1, 2], "group_b": [0, 1], "method": "paired_t"}),
            ("compare_two_groups", {"group_a": [1, 1], "group_b": [1, 1], "method": "mann_whitney"}),
            ("correlation", {"x": [1, 1, 1], "y": [1, 2, 3]}),
            ("correlation", {"x": [1, 2, 3], "y": [1, 2, 3, 4]}),
            ("linear_regression", {"x": [1, 2, 3], "y": [2, 2, 2]}),
            ("one_way_anova", {"groups": [[1, 1], [2, 2]]}),
            ("adjust_pvalues", {"pvalues": [-0.1, 0.2]}),
            ("adjust_pvalues", {"pvalues": [1.1]}),
            ("adjust_pvalues", {"pvalues": [0.1], "alpha": 0}),
            ("adjust_pvalues", {"pvalues": [0.1], "alpha": 1}),
            ("adjust_pvalues", {"pvalues": [0.1], "method": "unknown"}),
            ("principal_component_analysis", {"matrix": [[1, 1], [1, 1]]}),
            ("principal_component_analysis", {"matrix": [[1, 1], [2, 1]], "standardize": True}),
            ("descriptive_statistics", {"values": [1e308, -1e308]}),
        ]
        for name, args in cases:
            with self.subTest(tool=name, arguments=args), self.assertRaises(ValueError):
                HANDLERS[name](args)


if __name__ == "__main__":
    unittest.main()
