"""Executed evidence-profile contracts; no external scientific engines are run."""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from proto_agent.compute import TOOLS, ComputeError, compute_catalog, read_compute_value, run_compute
from proto_agent.compute_identity import compute_fingerprint
from proto_agent.compute_quantities import QUANTITY_SUPPORTED
from proto_agent.compute_quantity_exemptions import QUANTITY_EXEMPT
from proto_agent.evidence_standing import evidence_standing, standing_from_manifest
from proto_agent.mcp_server import McpServer

ROOT = Path(__file__).resolve().parents[1]


class ScienceEvidenceProfileTests(unittest.TestCase):
    def setUp(self):
        base = ROOT / "build" / "science-evidence-profiles"
        base.mkdir(parents=True, exist_ok=True)
        # Preserve run receipts, including failed-test fixtures, for inspection.
        self.workspace = Path(tempfile.mkdtemp(dir=base)).resolve()
        shutil.copytree(ROOT / "examples" / "compute", self.workspace / "examples" / "compute")

    def write(self, path, value):
        target = self.workspace / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
        return path

    def test_census_classifies_exactly_every_catalog_tool_without_running_exempt_tools(self):
        self.assertEqual(set(TOOLS), QUANTITY_SUPPORTED | set(QUANTITY_EXEMPT))
        self.assertFalse(QUANTITY_SUPPORTED & set(QUANTITY_EXEMPT))
        self.assertTrue(all(isinstance(reason, str) and len(reason) > 30 for reason in QUANTITY_EXEMPT.values()))
        for tool in compute_catalog()["tools"]:
            self.assertEqual(tool["quantity_profile"]["status"], "requires-dataset-binding" if tool["id"] in QUANTITY_SUPPORTED else "exempt")

    def test_two_real_catalog_examples_emit_locatable_quantities_and_consistent_standing(self):
        for stem, tool, pointer, expected, unit in (
            ("quantity-statistics", "descriptive_statistics", "/quantities/mean/value", 3.0, "mol/L"),
            ("quantity-counts", "normalize_gene_expression_counts", "/quantities/libraries/0/total_counts/value", 200.0, "count"),
        ):
            with self.subTest(tool=tool):
                path = f"examples/compute/{stem}.json"
                request = json.loads((self.workspace / path).read_text())
                self.assertEqual(request["arguments"], TOOLS[tool]["example"])
                receipt = run_compute(path, workspace_root=self.workspace)
                manifest = json.loads((self.workspace / receipt["manifest_path"]).read_text())
                standing = receipt["evidence_standing"]
                self.assertEqual(standing, manifest["evidence_standing"])
                self.assertEqual(standing["methodMaturity"], receipt["maturity"]["method_stage"])
                self.assertEqual(standing["dataOrigin"], "fixture")
                self.assertEqual(standing["humanReview"], "required")
                self.assertEqual(standing_from_manifest(manifest), standing)
                entry = next(item for item in manifest["result_value_index"]["entries"] if item["pointer"] == pointer)
                self.assertTrue(entry["quantity"]["contract_validated"])
                result_path = next(item for item in receipt["artifacts"] if item.endswith("/result.json"))
                read = read_compute_value(result_path, pointer, receipt["result_sha256"], receipt["manifest_sha256"], workspace_root=self.workspace)
                self.assertEqual(read["value"], expected)
                self.assertEqual(read["quantity"]["unit"], unit)
                self.assertTrue(read["quantity"]["contract_validated"])
                # The ordinary scientific scalar result remains unchanged.
                self.assertIn("mean" if tool == "descriptive_statistics" else "rows", receipt["result"])

    def test_invalid_units_and_mismatched_data_fail_before_method_execution(self):
        original = json.loads((self.workspace / "examples/compute/quantity-statistics.json").read_text())
        original["quantity_bindings"]["values"]["unit"] = "invented-unit"
        path = self.write("inputs/invalid-unit.json", original)
        with patch("proto_agent.compute.HANDLERS", {"descriptive_statistics": lambda _: self.fail("must reject before execution")}):
            with self.assertRaises(ComputeError) as error:
                run_compute(path, workspace_root=self.workspace)
        self.assertEqual(error.exception.code, "QUANTITY_UNIT_UNSUPPORTED")
        dataset_path = self.workspace / original["dataset_manifests"][0]
        dataset = json.loads(dataset_path.read_text())
        dataset["quantities"][0]["unit"] = "invalid-declared-unit"
        self.write(original["dataset_manifests"][0], dataset)
        with self.assertRaises(ComputeError) as declared_error:
            run_compute(path, workspace_root=self.workspace)
        self.assertEqual(declared_error.exception.code, "QUANTITY_UNIT_UNSUPPORTED")
        dataset["quantities"][0]["unit"] = "mol/L"
        self.write(original["dataset_manifests"][0], dataset)
        original["quantity_bindings"]["values"]["unit"] = "mol/L"
        original["arguments"]["values"][0] = 999
        self.write(path, original)
        with self.assertRaisesRegex(ComputeError, "must equal"):
            run_compute(path, workspace_root=self.workspace)

    def test_inline_and_imported_origins_and_binding_changes_fingerprint(self):
        request = json.loads((self.workspace / "examples/compute/quantity-statistics.json").read_text())
        path = self.write("inputs/imported.json", request)
        bound = compute_fingerprint(path, workspace_root=self.workspace)
        receipt = run_compute(path, workspace_root=self.workspace)
        self.assertEqual(receipt["evidence_standing"]["dataOrigin"], "imported")
        del request["quantity_bindings"]
        self.write(path, request)
        self.assertNotEqual(bound["fingerprint_sha256"], compute_fingerprint(path, workspace_root=self.workspace)["fingerprint_sha256"])
        del request["dataset_manifests"]
        self.write(path, request)
        receipt = run_compute(path, workspace_root=self.workspace)
        self.assertEqual(receipt["evidence_standing"]["dataOrigin"], "synthetic")
        self.assertNotIn("quantities", receipt["result"])

    def test_standing_requires_explicit_maturity_and_reopen_preserves_recorded_axes(self):
        with self.assertRaises(TypeError):
            evidence_standing(execution_status="completed")
        saved = {"dataOrigin": "imported", "methodMaturity": "heuristic", "executionStatus": "incomplete-evidence", "humanReview": "reviewed-rejected"}
        self.assertEqual(standing_from_manifest({"ok": True, "evidence_standing": saved}), saved)
        legacy = standing_from_manifest({"ok": True, "maturity": {"method_stage": "numerical-reference-tested"}})
        self.assertEqual(legacy["methodMaturity"], "not-established")
        self.assertEqual(legacy["humanReview"], "required")

    def test_toy_check_compile_export_receipts_and_ir_keep_fixture_standing(self):
        for name in ("designs", "parts"):
            shutil.copytree(ROOT / name, self.workspace / name)
        server = McpServer(self.workspace)
        check = server._tool_check({"path": "designs/toggle_switch.proto"})
        compiled = server._tool_compile({"path": "designs/toggle_switch.proto", "out": "build/test.ir.json"})
        exported = server._tool_export({"ir_path": "build/test.ir.json", "format": "fasta", "out": "build/test.fasta"})
        for receipt in (check, compiled, compiled["ir"], exported):
            self.assertEqual(receipt["evidence_standing"]["dataOrigin"], "fixture")
            self.assertEqual(receipt["evidence_standing"]["humanReview"], "required")
            self.assertNotIn("eligibility", receipt["evidence_standing"])
        # Forged labels in editable IR cannot promote an export receipt.
        ir = compiled["ir"]
        ir["evidence_standing"].update(dataOrigin="governed-snapshot", eligibility="DESIGN_ELIGIBLE")
        ir["provenance"]["parts_sha256"] = "0" * 64
        self.write("build/test.ir.json", ir)
        exported = server._tool_export({"ir_path": "build/test.ir.json", "format": "fasta", "out": "build/unbound.fasta"})
        self.assertEqual(exported["evidence_standing"]["dataOrigin"], "unknown")
        self.assertNotIn("eligibility", exported["evidence_standing"])


if __name__ == "__main__":
    unittest.main()
