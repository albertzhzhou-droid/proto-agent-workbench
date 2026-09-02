from __future__ import annotations

import ast
import hashlib
import importlib
import json
import os
import sys
import tempfile
import time
import tracemalloc
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
CORPUS = ROOT / "tests" / "security_corpus"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

import proto_agent.stress as stress  # noqa: E402


class SecurityStressTests(unittest.TestCase):
    def test_preprocessing_deadline_covers_corpus_verification(self) -> None:
        with self.assertRaises(TimeoutError):
            stress._verify_corpus(CORPUS, deadline=time.perf_counter() - 0.001)

    def test_blns_case_materialization_has_a_record_limit(self) -> None:
        payload = json.dumps(
            [
                {"upstream_index": index, "value": str(index)}
                for index in range(stress._MAX_BLNS_RECORDS + 1)
            ]
        ).encode("utf-8")
        with self.assertRaisesRegex(ValueError, "record-count|bounded UTF-8 JSON"):
            stress._blns_cases(
                {"blns_subset.json": payload},
                4096,
                deadline=time.perf_counter() + 1,
            )

    def test_production_hardlink_boundary_case_rejects_alias(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            case_root = Path(temporary_directory) / "case"
            case_root.mkdir()
            result = stress._hardlink_boundary_case().execute(case_root)
        self.assertTrue(result["passed"], result)
        self.assertIn(result["outcome"], {"rejected", "hardlink_unavailable"})

    def test_small_offline_run_is_bounded_and_writes_only_under_build(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            test_root = Path(temporary_directory)
            build_root = test_root / "build"
            report = stress.run_stress(
                corpus_dir=CORPUS,
                workspace_root=test_root,
                build_dir=build_root,
                report_path="security/stress-report.json",
                seed=12345,
                max_cases=12,
                max_total_seconds=2.0,
                max_case_seconds=0.2,
                max_input_bytes=4096,
            )

            self.assertTrue(report["ok"], report)
            self.assertTrue(report["offline"])
            self.assertEqual(report["external_processes_started"], 0)
            self.assertEqual(report["network_requests_made"], 0)
            self.assertEqual(report["summary"]["executed_cases"], 12)
            self.assertLessEqual(report["summary"]["executed_cases"], 12)
            self.assertLessEqual(report["resources"]["processed_input_bytes"], 12 * 4096)
            self.assertEqual(
                {case["category"] for case in report["cases"]},
                {"json", "multi_boundary", "parser", "path", "schema"},
            )
            self.assertTrue(report["leak_sentinels"]["environment_unchanged"])
            self.assertTrue(report["leak_sentinels"]["environment_restored"])
            self.assertTrue(report["leak_sentinels"]["temporary_outputs_contained"])
            self.assertTrue(report["leak_sentinels"]["sentinel_not_in_result"])
            self.assertTrue(report["leak_sentinels"]["temporary_path_not_in_result"])
            self.assertTrue(report["leak_sentinels"]["temporary_directory_removed"])

            report_path = build_root / "security" / "stress-report.json"
            self.assertTrue(report_path.is_file())
            on_disk = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertTrue(on_disk["report"]["written"])
            rendered = json.dumps(on_disk, sort_keys=True)
            self.assertNotIn("proto-security-stress-", rendered)

            unexpected_files = [
                path
                for path in test_root.rglob("*")
                if path.is_file() and path != report_path
            ]
            self.assertEqual(unexpected_files, [])

    def test_seed_determines_case_order(self) -> None:
        options = {
            "corpus_dir": CORPUS,
            "seed": 7,
            "max_cases": 6,
            "max_total_seconds": 2.0,
            "max_case_seconds": 0.2,
            "max_input_bytes": 4096,
        }
        first = stress.run_stress(**options)
        second = stress.run_stress(**options)
        self.assertEqual(
            [case["name"] for case in first["cases"]],
            [case["name"] for case in second["cases"]],
        )

    def test_report_path_escape_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            build_root = Path(temporary_directory) / "build"
            with self.assertRaises(ValueError):
                stress.run_stress(
                    corpus_dir=CORPUS,
                    workspace_root=Path(temporary_directory),
                    build_dir=build_root,
                    report_path="../escape.json",
                    max_cases=1,
                )

    def test_unrelated_directory_named_build_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            test_root = Path(temporary_directory)
            workspace = test_root / "workspace"
            unrelated = test_root / "unrelated"
            workspace.mkdir()
            unrelated.mkdir()
            with self.assertRaises(ValueError):
                stress.run_stress(
                    corpus_dir=CORPUS,
                    workspace_root=workspace,
                    build_dir=unrelated / "build",
                    report_path="stress.json",
                    max_cases=1,
                )

    def test_case_environment_mutation_is_detected_and_restored(self) -> None:
        key = "PROTO_AGENT_STRESS_ENVIRONMENT_TEST"
        original_present = key in os.environ
        original_value = os.environ.get(key)

        def mutate_environment(_: Path) -> dict[str, object]:
            os.environ[key] = "mutated"
            return {"passed": True}

        case = stress._StressCase("environment-mutation", "isolation", 1, mutate_environment)
        tracing_before = tracemalloc.is_tracing()
        with (
            mock.patch.object(stress, "_json_cases", return_value=[]),
            mock.patch.object(stress, "_blns_cases", return_value=[]),
            mock.patch.object(stress, "_path_cases", return_value=[]),
            mock.patch.object(stress, "_schema_cases", return_value=[]),
            mock.patch.object(stress, "_parser_cases", return_value=[case]),
        ):
            report = stress.run_stress(corpus_dir=CORPUS, max_cases=1)

        self.assertFalse(report["ok"])
        self.assertEqual(report["summary"]["case_environment_mutations"], 1)
        self.assertTrue(report["leak_sentinels"]["environment_restored"])
        self.assertEqual(tracemalloc.is_tracing(), tracing_before)
        self.assertEqual(key in os.environ, original_present)
        self.assertEqual(os.environ.get(key), original_value)

    def test_corpus_provenance_and_checksums_match_local_bytes(self) -> None:
        provenance = json.loads((CORPUS / "PROVENANCE.json").read_text(encoding="utf-8"))
        commits = {source["id"]: source["commit"] for source in provenance["sources"]}
        self.assertEqual(commits["blns"], stress.BLNS_COMMIT)
        self.assertEqual(commits["json-test-suite"], stress.JSON_TEST_SUITE_COMMIT)

        expected: dict[str, str] = {}
        for line in (CORPUS / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
            digest, relative = line.split("  ", 1)
            expected[relative] = digest
        self.assertGreaterEqual(len(expected), 13)
        for relative, digest in expected.items():
            with self.subTest(path=relative):
                path = CORPUS / relative
                self.assertTrue(path.is_file())
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), digest)

        by_path = {entry["path"]: entry for entry in provenance["files"]}
        for relative, entry in by_path.items():
            path = CORPUS / relative
            self.assertEqual(path.stat().st_size, entry["bytes"])
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), entry["sha256"])

    def test_module_has_no_process_or_network_imports_and_no_import_time_run(self) -> None:
        source_path = SRC / "proto_agent" / "stress.py"
        tree = ast.parse(source_path.read_text(encoding="utf-8"))
        imported_roots: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported_roots.update(alias.name.split(".", 1)[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported_roots.add(node.module.split(".", 1)[0])
            elif isinstance(node, ast.Call):
                if isinstance(node.func, ast.Name):
                    self.assertNotIn(node.func.id, {"exec", "eval", "compile", "__import__"})
                elif (
                    isinstance(node.func, ast.Attribute)
                    and isinstance(node.func.value, ast.Name)
                    and node.func.value.id == "os"
                ):
                    self.assertNotIn(
                        node.func.attr,
                        {"system", "popen", "spawnl", "spawnle", "spawnlp", "spawnv", "spawnve"},
                    )
        self.assertTrue(
            imported_roots.isdisjoint(
                {"subprocess", "socket", "urllib", "http", "requests", "asyncio"}
            )
        )

        with mock.patch.object(
            tempfile,
            "TemporaryDirectory",
            side_effect=AssertionError("stress executed during import"),
        ):
            importlib.reload(stress)


if __name__ == "__main__":
    unittest.main()
