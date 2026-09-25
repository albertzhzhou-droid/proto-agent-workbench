"""The CI selector must not hide missing tests, dependencies or skipped work."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("test_profile_runner", Path(__file__).resolve().parents[1] / "scripts/run-test-profile.py")
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


class TestProfilesTests(unittest.TestCase):
    def test_every_test_module_has_exactly_one_profile(self):
        self.assertEqual(RUNNER.inventory_errors(RUNNER.ROOT / "tests"), [])

    def test_unclassified_tests_fail_instead_of_disappearing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for modules in RUNNER.PROFILES.values():
                for module in modules:
                    (root / f"{module}.py").touch()
            (root / "test_unassigned_new_science.py").touch()
            self.assertIn("Unclassified test modules", RUNNER.inventory_errors(root)[0])

    def test_missing_science_dependency_is_unsupported_not_skipped_success(self):
        output = io.StringIO()
        with patch.object(RUNNER, "preflight", return_value=({}, ["Missing dependency: numpy"])), contextlib.redirect_stdout(output):
            status = RUNNER.main(["--profile", "compute", "--preflight"])
        report = json.loads(output.getvalue())
        self.assertEqual(status, 2)
        self.assertEqual(report["status"], "unsupported-environment")
        self.assertEqual(report["counts"]["passed"], 0)

    def test_result_counts_do_not_turn_skips_or_failures_into_passes(self):
        class SyntheticCases(unittest.TestCase):
            def test_pass(self):
                pass
            def test_skip(self):
                self.skipTest("synthetic missing capability")
            def test_fail(self):
                self.fail("synthetic negative control")
        result = RUNNER.execute_suite(unittest.defaultTestLoader.loadTestsFromTestCase(SyntheticCases), io.StringIO())
        counts = RUNNER.result_counts(result)
        self.assertEqual((counts["run"], counts["passed"], counts["failures"], counts["skipped"]), (3, 1, 1, 1))
        self.assertIn("synthetic missing capability", counts["skipped_tests"][0]["reason"])

    def test_compute_preflight_requires_schema_validator_used_by_protein_tests(self):
        def installed_version(distribution):
            if distribution == "jsonschema":
                raise RUNNER.importlib.metadata.PackageNotFoundError(distribution)
            return "test-installed"
        with patch.object(RUNNER.importlib.metadata, "version", side_effect=installed_version), \
             patch.object(RUNNER.importlib.util, "find_spec", return_value=object()):
            versions, problems = RUNNER.preflight("compute")
        self.assertNotIn("jsonschema", versions)
        self.assertEqual(problems, ["Missing dependency: jsonschema (jsonschema)"])

    def test_list_is_only_a_plan_and_does_not_import_optional_test_modules(self):
        output = io.StringIO()
        with patch.object(RUNNER, "preflight", side_effect=AssertionError("must not probe")), contextlib.redirect_stdout(output):
            status = RUNNER.main(["--profile", "heavy", "--list"])
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(output.getvalue())["status"], "planned")

    def test_selection_cannot_cross_profile_boundaries(self):
        with contextlib.redirect_stdout(io.StringIO()):
            status = RUNNER.main(["--profile", "base", "--module", "test_compute_batch4", "--list"])
        self.assertEqual(status, 2)

    def test_figures_profile_requires_renderer_but_classifies_optional_reader_skips(self):
        self.assertEqual(RUNNER.PROFILES["figures"], ("test_figure_export",))
        self.assertEqual(RUNNER.DEPENDENCIES["figures"], {"matplotlib": "matplotlib"})
        class Case:
            def __init__(self, name):
                self.name = name
            def id(self):
                return self.name
        result = unittest.TestResult()
        result.skipped = [
            (Case("test_figure_export.FigureRenderingTests.test_pdf_reopens_in_independent_pdfjs_with_selectable_units_and_title"), "independent local pdfjs parser unavailable"),
            (Case("test_figure_export.FigureRenderingTests.test_real_vectors_exact_table_source_bindings_methods_and_hashes_reopen"), "optional matplotlib runtime unavailable"),
        ]
        blocked = RUNNER.blocking_skips("figures", result)
        self.assertEqual(len(blocked), 1)
        self.assertIn("test_real_vectors", blocked[0]["test"])
        self.assertEqual(len(RUNNER.blocking_skips("compute", result)), 2)

    def test_figures_optional_case_cannot_hide_a_different_skip_reason(self):
        class Case:
            def id(self):
                return "test_figure_export.FigureRenderingTests.test_pdf_reopens_in_independent_pdfjs_with_selectable_units_and_title"
        result = unittest.TestResult()
        result.skipped = [(Case(), "renderer failed")]
        self.assertEqual(len(RUNNER.blocking_skips("figures", result)), 1)


if __name__ == "__main__":
    unittest.main()
