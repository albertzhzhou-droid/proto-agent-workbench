"""Run an explicit Python test profile and emit honest, machine-readable counts.

No test module is imported before dependency/platform preflight. New test files
must be classified here so they cannot silently disappear from CI coverage.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import platform
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
PROFILES = {
    "base": (
        "test_artifact_readers", "test_bioinformatics", "test_cli", "test_cli_security_commands",
        "test_compute", "test_compute_identity", "test_compute_maturity", "test_crawl_igem_parts", "test_dna_placements",
        "test_evidence_standing", "test_scientific_contracts",
        "test_execution_wsl", "test_ir_json", "test_materials",
        "test_materials_bundle", "test_materials_promotion", "test_mcp_runtime_recovery",
        "test_model_catalog", "test_protein", "test_provenance",
        "test_security_boundaries", "test_security_stress", "test_skill_sdk",
        "test_source_search", "test_structure_prediction_import", "test_test_profiles", "test_tool_contracts", "test_topology_contract",
        "test_workbench_bridge_retirement", "test_workflow_provenance",
    ),
    "compute": (
        "test_compute_bio", "test_compute_inference", "test_compute_ports", "test_compute_research",
        "test_compute_stats", "test_science_evidence_profiles", "test_protein_comparison", "test_protein_study", "test_rnaseq_data", "test_compute_rnaseq",
    ),
    "figures": ("test_figure_export",),
    "heavy": ("test_compute_batch3", "test_compute_batch4"),
    "linux-worker": ("test_bioinformatics_worker",),
    "xdl": ("test_chem_xdl_inspection",),
}
DEPENDENCIES = {
    "base": {"certifi": "certifi"},
    "compute": {"numpy": "numpy", "scipy": "scipy", "biopython": "Bio"},
    "figures": {"matplotlib": "matplotlib"},
    "heavy": {
        "numpy": "numpy", "scipy": "scipy", "torch": "torch",
        "pykalman": "pykalman", "scikit-learn": "sklearn",
        "opencv-python-headless": "cv2", "scikit-image": "skimage",
        "tifffile": "tifffile", "nibabel": "nibabel", "simpleitk": "SimpleITK",
        "rdkit": "rdkit", "viennarna": "RNA", "python-libsbml": "libsbml",
        "cobra": "cobra", "msprime": "msprime", "h5py": "h5py",
        "cooler": "cooler", "networkx": "networkx", "biopython": "Bio",
    },
    "linux-worker": {"certifi": "certifi"},
    "xdl": {},
}

# Optional independent readers and OS privileges are separate from renderer
# availability. Only these exact skipped cases/reasons are nonblocking; missing
# matplotlib fails preflight and every other scientific-lane skip still fails.
OPTIONAL_CAPABILITY_SKIPS = {
    "figures": {
        "test_figure_export.FigureRenderingTests.test_pdf_reopens_in_independent_pdfjs_with_selectable_units_and_title":
            {"independent local pdfjs parser unavailable"},
        "test_figure_export.FigureRenderingTests.test_existing_output_symlink_is_rejected_without_writing_target":
            {"symlink creation unavailable"},
    },
}


def blocking_skips(profile: str, result: unittest.TestResult) -> list[dict[str, str]]:
    if profile == "base":
        return []
    allowed = OPTIONAL_CAPABILITY_SKIPS.get(profile, {})
    return [{"test": test.id(), "reason": reason} for test, reason in result.skipped
            if reason not in allowed.get(test.id().removeprefix("tests."), set())]


def inventory_errors(tests_root: Path) -> list[str]:
    discovered = {path.stem for path in tests_root.glob("test_*.py")}
    classified = [module for modules in PROFILES.values() for module in modules]
    problems = []
    if len(classified) != len(set(classified)):
        problems.append("A test module belongs to more than one profile.")
    if discovered - set(classified):
        problems.append("Unclassified test modules: " + ", ".join(sorted(discovered - set(classified))))
    if set(classified) - discovered:
        problems.append("Classified test modules are missing: " + ", ".join(sorted(set(classified) - discovered)))
    return problems


def preflight(profile: str) -> tuple[dict[str, str], list[str]]:
    versions, problems = {}, []
    for distribution, module in DEPENDENCIES[profile].items():
        try:
            versions[distribution] = importlib.metadata.version(distribution)
            if importlib.util.find_spec(module) is None:
                problems.append(f"{distribution}: import module {module} is unavailable")
        except (importlib.metadata.PackageNotFoundError, ImportError, ValueError):
            problems.append(f"Missing dependency: {distribution} ({module})")
    if profile == "linux-worker" and sys.platform != "linux":
        problems.append("linux-worker requires Linux process groups and /proc; it is not a Windows WSL installation test.")
    if profile == "xdl":
        runtime = Path(os.environ.get("CHEM_XDL_PYTHON", str(ROOT.parent / "Chem CLI/.chem-backends/xdl/Scripts/python.exe")))
        if not runtime.is_file():
            problems.append("xdl requires an existing isolated parser runtime supplied by CHEM_XDL_PYTHON.")
    return versions, problems


class CountedResult(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.passed_ids: list[str] = []

    def addSuccess(self, test):
        super().addSuccess(test)
        self.passed_ids.append(test.id())


def execute_suite(suite: unittest.TestSuite, stream=None):
    runner = unittest.TextTestRunner(stream=stream or sys.stderr, verbosity=1, resultclass=CountedResult)
    return runner.run(suite)


def result_counts(result: CountedResult) -> dict:
    return {
        "run": result.testsRun, "passed": len(result.passed_ids),
        "failures": len(result.failures), "errors": len(result.errors),
        "skipped": len(result.skipped), "expected_failures": len(result.expectedFailures),
        "unexpected_successes": len(result.unexpectedSuccesses),
        "failed_tests": [test.id() for test, _ in result.failures + result.errors],
        "skipped_tests": [{"test": test.id(), "reason": reason} for test, reason in result.skipped],
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=PROFILES, required=True)
    parser.add_argument("--list", action="store_true", help="List the plan without importing or running tests.")
    parser.add_argument("--preflight", action="store_true", help="Check availability without running tests.")
    parser.add_argument("--module", action="append", default=[], help="Run only named modules in the chosen profile; report partial scope.")
    parser.add_argument("--report", type=Path, help="Write the same JSON report to this file.")
    options = parser.parse_args(argv)
    modules = options.module or list(PROFILES[options.profile])
    errors = inventory_errors(ROOT / "tests")
    if len(modules) != len(set(modules)) or set(modules) - set(PROFILES[options.profile]):
        errors.append("Selected modules must be unique members of the requested profile.")
    report = {
        "schema": "proto-agent.test-profile.v1", "profile": options.profile,
        "scope": "selected-modules" if options.module else "full-profile",
        "python": platform.python_version(), "platform": sys.platform,
        "modules": modules, "all_profiles": {name: list(items) for name, items in PROFILES.items()},
        "input_sha256": {
            str(path.relative_to(ROOT)).replace(os.sep, "/"): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in [ROOT / "pyproject.toml", ROOT / "uv.lock", Path(__file__),
                         *(ROOT / "tests" / f"{module}.py" for module in modules
                           if module in PROFILES[options.profile])] if path.is_file()
        },
        "status": "invalid-profile" if errors else "planned", "problems": errors,
        "counts": {"run": 0, "passed": 0, "failures": 0, "errors": 0, "skipped": 0},
        "live_wsl_integration": "not-run; requires the separately provisioned runtime and engine fixtures",
    }
    code = 2 if errors else 0
    if not errors and not options.list:
        versions, problems = preflight(options.profile)
        report.update(dependencies=versions, problems=problems)
        if problems:
            report["status"], code = "unsupported-environment", 2
        elif options.preflight:
            report["status"] = "ready-not-run"
        else:
            # The repository root carries namespace packages the tests import
            # directly, such as tools/. Running from scripts/ leaves it off
            # sys.path, so those modules fail to import here but not when the
            # same test is run from the root by hand.
            sys.path.insert(0, str(ROOT / "tests"))
            sys.path.insert(0, str(ROOT))
            loader = unittest.TestLoader()
            suite = unittest.TestSuite(loader.loadTestsFromName(module) for module in modules)
            result = execute_suite(suite)
            report["counts"] = result_counts(result)
            # Core numerical/runtime tests must execute. Explicit optional-reader
            # and privilege skips remain visible and are never counted as passes.
            report["blocking_skipped_tests"] = blocking_skips(options.profile, result)
            strict_skips = bool(report["blocking_skipped_tests"])
            success = result.wasSuccessful() and result.testsRun > 0 and not strict_skips
            report["status"] = ("passed-with-skips" if result.skipped else "passed") if success else "failed"
            code = 0 if success else 1
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    if options.report:
        options.report.parent.mkdir(parents=True, exist_ok=True)
        options.report.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
