from __future__ import annotations

import hashlib
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from proto_agent.compute import ComputeError, compute_catalog, run_compute
from proto_agent.mcp_server import McpServer
from proto_agent.provenance import verify_provenance
from proto_agent.security import SecurityBoundaryError


class ComputeIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name)
        self.job = self.workspace / "request.json"
        self.payload = {"tool": "find_n_glycosylation_motifs", "arguments": {"sequence": "MNATNPTNVS"}}
        self.job.write_text(json.dumps(self.payload), encoding="utf-8")

    def run_job(self):
        return run_compute("request.json", workspace_root=self.workspace)

    def test_catalog_has_explicit_implementation_and_schema(self):
        catalog = compute_catalog()
        self.assertEqual(catalog["count"], 127)
        self.assertEqual(len({item["id"] for item in catalog["tools"]}), 127)
        for item in catalog["tools"]:
            self.assertIn(item["implementation"], {"proto-native", "biomni-adapted"})
            self.assertNotIn("input_schema", item)
            detail = compute_catalog(item["id"])["tools"][0]
            self.assertIn("input_schema", detail)
            self.assertIn("example", detail)

    def test_result_and_snapshot_are_bound_to_verifiable_provenance(self):
        original = self.job.read_bytes()
        result = self.run_job()
        self.assertTrue(result["ok"])
        self.assertEqual(result["review_status"], "human_review_required")
        self.assertEqual(result["source"]["sha256"], hashlib.sha256(original).hexdigest())
        for artifact in result["artifacts"]:
            self.assertTrue(artifact.startswith("build/compute/"))
            self.assertTrue((self.workspace / artifact).is_file())
        provenance = self.workspace / result["artifacts"][-1]
        self.assertTrue(verify_provenance(provenance, workspace_root=self.workspace)["ok"])
        self.job.write_text("changed after run", encoding="utf-8")
        self.assertTrue(verify_provenance(provenance, workspace_root=self.workspace)["ok"])
        (self.workspace / result["artifacts"][0]).write_text("{}", encoding="utf-8")
        self.assertFalse(verify_provenance(provenance, workspace_root=self.workspace)["ok"])

    def test_utf8_bom_snapshot_preserves_exact_input(self):
        self.job.write_text(json.dumps(self.payload), encoding="utf-8-sig")
        original = self.job.read_bytes()
        result = self.run_job()
        self.assertEqual((self.workspace / result["inputs"]["request_snapshot"]).read_bytes(), original)

    def test_invalid_jobs_do_not_publish_computations(self):
        for payload in (
            {"tool": "os.system", "arguments": {}},
            {"tool": "find_n_glycosylation_motifs", "arguments": {"sequence": "NAT", "code": "print(1)"}},
            {"tool": "find_n_glycosylation_motifs", "arguments": {"sequence": True}},
            {**self.payload, "out": "outside.json"},
        ):
            with self.subTest(payload=payload):
                self.job.write_text(json.dumps(payload), encoding="utf-8")
                with self.assertRaises(ValueError):
                    self.run_job()
                self.assertFalse((self.workspace / "build/compute").exists())

    def test_nonstandard_and_duplicate_json_rejected(self):
        for raw in ('{"tool":"x","tool":"y","arguments":{}}', '{"tool":"x","arguments":{"x":NaN}}',
                    '{"tool":"x","arguments":{"x":Infinity}}', '[' * 100 + '0' + ']' * 100):
            self.job.write_text(raw, encoding="utf-8")
            with self.assertRaises(ValueError):
                self.run_job()

    def test_huge_numbers_and_nonfinite_exponents_are_input_errors(self):
        for number in ("9" * 400, "1e999"):
            self.job.write_text('{"tool":"descriptive_statistics","arguments":{"values":[' + number + ']}}', encoding="utf-8")
            with self.assertRaises(ValueError):
                self.run_job()

    def test_paths_and_missing_dependencies_fail_closed(self):
        with self.assertRaises(SecurityBoundaryError):
            run_compute("../outside.json", workspace_root=self.workspace)
        self.job.write_text(json.dumps({"tool": "descriptive_statistics", "arguments": {"values": [1, 2, 3]}}), encoding="utf-8")
        with patch("proto_agent.compute._missing", return_value=["scipy"]):
            with self.assertRaises(ComputeError) as error:
                self.run_job()
            self.assertEqual(error.exception.code, "COMPUTE_DEPENDENCY_MISSING")

    def test_cancelled_run_and_repeated_runs(self):
        event = threading.Event()
        event.set()
        with self.assertRaises(ComputeError):
            run_compute("request.json", workspace_root=self.workspace, cancel_event=event)
        left, right = self.run_job(), self.run_job()
        self.assertNotEqual(left["run_id"], right["run_id"])
        self.assertEqual(left["result_sha256"], right["result_sha256"])

    def test_actual_mcp_dispatch_success_and_invalid_path(self):
        server = McpServer(self.workspace)
        def call(name, arguments):
            return server.handle_message({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                          "params": {"name": name, "arguments": arguments}})["result"]["structuredContent"]
        self.assertTrue(call("proto_compute_catalog", {})["ok"])
        self.assertTrue(call("proto_compute_run", {"path": "request.json"})["ok"])
        self.assertFalse(call("proto_compute_run", {"path": "../outside.json"})["ok"])
        self.assertFalse(call("proto_compute_run", {"path": "request.json", "code": "x"})["ok"])


if __name__ == "__main__":
    unittest.main()
