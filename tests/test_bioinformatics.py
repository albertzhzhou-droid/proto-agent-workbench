from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from proto_agent.bioinformatics import (BioinformaticsError, OPERATIONS, _configuration,
                                       bioinformatics_catalog, run_bioinformatics)
from proto_agent.bioinformatics_worker import DESEQ2_SOURCE, OPERATION_ENGINES, plan
from proto_agent.compute import _validate
from proto_agent.security import SecurityBoundaryError


class BioinformaticsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.workspace = Path(self.temporary.name)
        (self.workspace / "input.vcf").write_text("##fileformat=VCFv4.2\n")
        self.request = self.workspace / "request.json"
        self.payload = {"operation": "bcftools_stats", "arguments": {"variants": "input.vcf"}}
        self.request.write_text(json.dumps(self.payload))

    def fake_invoke(self, command, root, cancel_event):
        request = json.loads((root / "worker-request.json").read_text())
        self.assertEqual(request["operation"], "bcftools_stats")
        source = root / request["files"]["variants"]["file"]
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), request["files"]["variants"]["sha256"])
        (root / "outputs/statistics.txt").write_text("Actual engine output fixture\n")
        (root / "worker-result.json").write_text(json.dumps({"ok": True, "status": "completed", "steps": [{"exit_code": 0}], "runtime": {"checked": True}}))
        return 0

    def run_fake(self):
        with patch("proto_agent.bioinformatics._linux_path", side_effect=lambda path, _config: str(path)), \
             patch("proto_agent.bioinformatics._worker_command", return_value=["fixed-worker"]), \
             patch("proto_agent.bioinformatics._invoke", side_effect=self.fake_invoke):
            return run_bioinformatics("request.json", workspace_root=self.workspace)

    def test_nine_engine_families_have_typed_schemas_and_current_status_not_invented(self):
        catalog = bioinformatics_catalog()
        self.assertEqual(catalog["count"], 9)
        self.assertEqual(set(OPERATIONS), set(OPERATION_ENGINES))
        self.assertTrue(all(item["available"] is None for item in catalog["operations"]))
        for name in OPERATIONS:
            detail = bioinformatics_catalog(name)["operations"][0]
            self.assertFalse(detail["input_schema"]["additionalProperties"])
            self.assertTrue(detail["example"])

    def test_runtime_availability_separate_from_installed_version(self):
        response = {"checked": True, "available": False, "engines": {"bcftools": {
            "available": False, "package": {"version": "1.24"}, "version": None, "error": "could not launch"}}}
        with patch("proto_agent.bioinformatics._probe", return_value=response):
            entry = bioinformatics_catalog("bcftools_stats", probe=True)["operations"][0]
        self.assertFalse(entry["available"])
        self.assertEqual(entry["runtime"]["package"]["version"], "1.24")

    def test_every_operation_rejects_unknown_fields_and_wrong_value_types(self):
        for name, metadata in OPERATIONS.items():
            with self.subTest(operation=name):
                _validate(metadata["example"], metadata["input_schema"])
                with self.assertRaises(ValueError):
                    _validate({**metadata["example"], "command": "unreviewed"}, metadata["input_schema"])
                field = metadata["input_schema"]["required"][0]
                with self.assertRaises(ValueError):
                    _validate({**metadata["example"], field: ["wrong type"]}, metadata["input_schema"])

    def test_frozen_sidecar_uses_bundled_worker_source(self):
        from proto_agent.bioinformatics import _worker_command
        package = self.workspace / "proto_agent"
        package.mkdir()
        (package / "bioinformatics_worker.py").write_text("# bundled worker")
        with patch("sys._MEIPASS", str(self.workspace), create=True), \
             patch("proto_agent.bioinformatics._linux_path", side_effect=lambda path, _config: str(path)):
            command = _worker_command(["status"], _configuration())
        self.assertIn(str(package / "bioinformatics_worker.py"), command)

    def test_success_receipt_contains_real_snapshot_and_output_hashes(self):
        result = self.run_fake()
        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "completed")
        self.assertTrue(result["manifest_path"].startswith("build/bioinformatics/"))
        artifact = result["artifacts"][0]
        self.assertEqual(artifact["sha256"], hashlib.sha256((self.workspace / artifact["path"]).read_bytes()).hexdigest())
        self.assertEqual(result["source"]["sha256"], hashlib.sha256(self.request.read_bytes()).hexdigest())
        (self.workspace / "input.vcf").write_text("changed after run")
        snapshot = self.workspace / result["inputs"]["variants"]["snapshot"]
        self.assertEqual(snapshot.read_text(), "##fileformat=VCFv4.2\n")

    def test_unknown_operations_extra_fields_and_wrong_file_type_rejected(self):
        for payload in ({"operation": "bash", "arguments": {}},
                        {"operation": "bcftools_stats", "arguments": {"variants": "input.vcf", "command": "echo bad"}},
                        {"operation": "bcftools_stats", "arguments": {"variants": "request.json"}},
                        {"operation": "bcftools_stats", "arguments": {"variants": "input.vcf"}, "shell": True}):
            self.request.write_text(json.dumps(payload))
            with self.subTest(payload=payload), patch("proto_agent.bioinformatics._invoke") as invoke:
                with self.assertRaises(ValueError):
                    run_bioinformatics("request.json", workspace_root=self.workspace)
                invoke.assert_not_called()

    def test_traversal_and_absolute_paths_rejected_before_external_execution(self):
        for path in ("../input.vcf", str(self.workspace / "input.vcf")):
            self.payload["arguments"]["variants"] = path
            self.request.write_text(json.dumps(self.payload))
            with self.subTest(path=path), patch("proto_agent.bioinformatics._invoke") as invoke:
                with self.assertRaises(SecurityBoundaryError):
                    run_bioinformatics("request.json", workspace_root=self.workspace)
                invoke.assert_not_called()

    def test_duplicate_keys_and_nan_rejected(self):
        for raw in ('{"operation":"bcftools_stats","operation":"bash","arguments":{}}',
                    '{"operation":"cnvkit_call","arguments":{"purity":NaN}}'):
            self.request.write_text(raw)
            with self.assertRaises(BioinformaticsError):
                run_bioinformatics("request.json", workspace_root=self.workspace)

    def test_cancelled_job_does_not_launch_and_midrun_cancel_cannot_publish_success(self):
        event = threading.Event()
        event.set()
        with patch("proto_agent.bioinformatics._invoke") as invoke:
            with self.assertRaises(BioinformaticsError):
                run_bioinformatics("request.json", workspace_root=self.workspace, cancel_event=event)
            invoke.assert_not_called()
        event.clear()
        def cancel_during(command, root, cancel_event):
            code = self.fake_invoke(command, root, cancel_event)
            event.set()
            return code
        with patch("proto_agent.bioinformatics._linux_path", side_effect=lambda path, _config: str(path)), \
             patch("proto_agent.bioinformatics._worker_command", return_value=["fixed-worker"]), \
             patch("proto_agent.bioinformatics._invoke", side_effect=cancel_during):
            result = run_bioinformatics("request.json", workspace_root=self.workspace, cancel_event=event)
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "cancelled")

    def test_worker_failure_remains_failure_with_saved_manifest(self):
        with patch("proto_agent.bioinformatics._linux_path", side_effect=lambda path, _config: str(path)), \
             patch("proto_agent.bioinformatics._worker_command", return_value=["fixed-worker"]), \
             patch("proto_agent.bioinformatics._invoke", side_effect=FileNotFoundError("WSL unavailable")):
            result = run_bioinformatics("request.json", workspace_root=self.workspace)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "BIO_EXECUTION_FAILED")
        self.assertTrue((self.workspace / result["manifest_path"]).is_file())

    def test_runtime_configuration_cannot_be_shell_or_traversal(self):
        for values in ({"PROTO_AGENT_BIO_WSL_DISTRO": "Ubuntu --exec sh"},
                       {"PROTO_AGENT_BIO_ROOT": "/tmp/../etc"},
                       {"PROTO_AGENT_BIO_ROOT": "/tmp/evil;echo"}):
            with self.subTest(values=values), patch.dict(os.environ, values):
                with self.assertRaises(BioinformaticsError):
                    _configuration()

    def test_deseq2_uses_fixed_source_and_passes_labels_as_data(self):
        label = 'treated; system("touch BAD")'
        arguments = {"reference_level": "control", "comparison_level": label}
        steps = plan("deseq2_fit", arguments, {"counts": "/inputs/counts.csv", "samples": "/inputs/samples.csv"}, self.workspace)
        self.assertEqual((self.workspace / "analysis.R").read_text(), DESEQ2_SOURCE)
        self.assertNotIn(label, DESEQ2_SOURCE)
        self.assertIn(label, steps[0][0])

    def test_deseq2_documents_defaults_and_legacy_request_selects_them(self):
        properties = OPERATIONS["deseq2_fit"]["input_schema"]["properties"]
        expected = {"design": "condition", "min_count": 10, "min_samples": 2,
                    "pca_top_genes": 500, "size_factor_type": "ratio", "alpha": 0.05}
        self.assertEqual({key: properties[key]["default"] for key in expected}, expected)
        arguments = {"reference_level": "control", "comparison_level": "treated"}
        step = plan("deseq2_fit", arguments, {"counts": "/counts.csv", "samples": "/samples.csv"}, self.workspace)[0][0]
        self.assertEqual(step[3:], ["/counts.csv", "/samples.csv", "control", "treated", "0.05", "condition", "10", "2", "500", "ratio"])

    def test_deseq2_fixed_design_options_are_bounded_not_formulas(self):
        schema = OPERATIONS["deseq2_fit"]["input_schema"]
        base = OPERATIONS["deseq2_fit"]["example"]
        for design in ("condition", "batch_condition", "subject_condition"):
            selected = {**base, "design": design, "min_count": 0, "min_samples": 1,
                        "pca_top_genes": 2, "size_factor_type": "poscounts", "alpha": 0.01}
            _validate(selected, schema)
            step = plan("deseq2_fit", selected, {"counts": "/counts.csv", "samples": "/samples.csv"}, self.workspace)[0][0]
            self.assertEqual(step[-6:], ["0.01", design, "0", "1", "2", "poscounts"])
        for key, value in (("design", "~ batch + condition"), ("design", "system('bad')"),
                           ("min_count", -1), ("min_count", 1000001), ("min_count", 0.5),
                           ("min_samples", 0), ("min_samples", 101), ("pca_top_genes", 1),
                           ("pca_top_genes", 5001), ("size_factor_type", "arbitrary")):
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                _validate({**base, key: value}, schema)

    def test_engine_options_not_arbitrary_cli(self):
        steps = plan("lumpy_bedpe", {}, {"bedpe": "/inputs/sample.bedpe", "chromosomes": "/inputs/genome.txt"}, self.workspace)
        self.assertEqual(steps[0][0][-1], "bedpe_file:/inputs/sample.bedpe,id:sample,weight:1")
        self.assertEqual(steps[0][1], "structural-variants.vcf")
        with self.assertRaises(ValueError):
            plan("arbitrary", {}, {}, self.workspace)


if __name__ == "__main__":
    unittest.main()
