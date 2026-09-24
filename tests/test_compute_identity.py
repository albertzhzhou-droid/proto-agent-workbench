from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from proto_agent import compute, compute_identity as identity
from proto_agent.bioinformatics_worker import R_IDENTITY_SOURCE, r_environment_identity
from proto_agent.mcp_server import McpServer
from proto_agent.security import SecurityBoundaryError


class ComputeIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.workspace = Path(self.temporary.name)
        self.payload = {"tool": "find_n_glycosylation_motifs", "arguments": {"sequence": "MNATNPTNVS"}}
        self.write()

    def write(self, payload=None, name="request.json"):
        (self.workspace / name).write_text(json.dumps(payload or self.payload), encoding="utf-8")
        return name

    def fingerprint(self, name="request.json"):
        return identity.compute_fingerprint(name, workspace_root=self.workspace)

    def test_read_only_identity_is_compact_without_creating_artifacts(self):
        value = self.fingerprint()
        self.assertTrue(value["cacheable"], value["reasons"])
        self.assertEqual(value["schema_version"], "proto-agent.compute-fingerprint.v1")
        self.assertEqual(set(value["materials"]), {"request", "files", "implementation", "runtime"})
        self.assertEqual(len(value["fingerprint_sha256"]), 64)
        self.assertLess(len(json.dumps(value)), 16000)
        self.assertEqual(list(self.workspace.iterdir()), [self.workspace / "request.json"])

    def test_filename_format_and_explicit_defaults_do_not_change_key(self):
        tool = "descriptive_statistics"
        original = {"tool": tool, "arguments": {"values": [1, 2, 3]}}
        self.write(original)
        first = self.fingerprint()
        properties = compute.TOOLS[tool]["input_schema"]["properties"]
        defaults = {key: value["default"] for key, value in properties.items() if "default" in value}
        explicit = {"arguments": {**original["arguments"], **defaults}, "tool": tool}
        (self.workspace / "different-uuid.json").write_text(json.dumps(explicit, indent=4), encoding="utf-8-sig")
        second = self.fingerprint("different-uuid.json")
        self.assertNotEqual(first["materials"]["request"], second["materials"]["request"])
        self.assertEqual(first["fingerprint_sha256"], second["fingerprint_sha256"])
        original["arguments"]["values"] = [1, 2, 4]
        self.write(original)
        self.assertNotEqual(first["fingerprint_sha256"], self.fingerprint()["fingerprint_sha256"])

    def test_declared_input_bytes_are_bound_and_boundary_checked(self):
        self.write({"tool": "analyze_pixel_distribution", "arguments": {"image_path": "image.png"}})
        data = self.workspace / "image.png"
        data.write_bytes(b"first image bytes; preflight does not execute the decoder")
        first = self.fingerprint()
        self.assertEqual(first["materials"]["files"][0]["sha256"], hashlib.sha256(data.read_bytes()).hexdigest())
        data.write_bytes(b"changed image bytes")
        self.assertNotEqual(first["fingerprint_sha256"], self.fingerprint()["fingerprint_sha256"])
        for path in ("../outside.png", str(data.resolve())):
            self.write({"tool": "analyze_pixel_distribution", "arguments": {"image_path": path}})
            with self.assertRaises(SecurityBoundaryError):
                self.fingerprint()

    def test_invalid_unknown_duplicate_nonfinite_and_path_requests_fail(self):
        for raw in ('{"tool":"missing","arguments":{}}', '{"tool":"x","tool":"y","arguments":{}}',
                    '{"tool":"descriptive_statistics","arguments":{"values":[NaN]}}',
                    json.dumps({**self.payload, "command": "forbidden"}),
                    json.dumps({"tool": self.payload["tool"], "arguments": {"sequence": True}})):
            with self.subTest(raw=raw):
                (self.workspace / "request.json").write_text(raw)
                with self.assertRaises(ValueError):
                    self.fingerprint()
        with self.assertRaises(SecurityBoundaryError):
            self.fingerprint("../request.json")

    def test_code_source_and_schema_drift_disable_cache_and_change_key(self):
        first = self.fingerprint()
        tree = identity._source_tree()
        tree["compute_bio.py"] += b"\n# changed implementation source\n"
        with patch.object(identity, "_source_tree", return_value=tree):
            changed = self.fingerprint()
        self.assertFalse(changed["cacheable"])
        self.assertIn("IMPLEMENTATION_CHANGED_SINCE_PROCESS_START", changed["reasons"])
        self.assertNotEqual(first["fingerprint_sha256"], changed["fingerprint_sha256"])
        altered = copy.deepcopy(compute.TOOLS[self.payload["tool"]])
        altered["input_schema"]["properties"]["sequence"]["maxLength"] += 1
        with patch.dict(compute.TOOLS, {self.payload["tool"]: altered}):
            changed = self.fingerprint()
        self.assertFalse(changed["cacheable"])
        self.assertNotEqual(first["fingerprint_sha256"], changed["fingerprint_sha256"])

    def test_stale_loaded_class_method_is_not_certified_by_new_disk_source(self):
        name = "proto_agent.fingerprint_fixture"
        module = types.ModuleType(name)
        module.__file__ = str(self.workspace / "fingerprint_fixture.py")
        exec(compile("class Adapter:\n    def run(self):\n        return 1\n", module.__file__, "exec"), module.__dict__)
        with patch.dict(sys.modules, {name: module}):
            reasons = identity._loaded_code_reasons({"fingerprint_fixture.py": b"class Adapter:\n    def run(self):\n        return 2\n"})
        self.assertIn("LOADED_IMPLEMENTATION_DIFFERS_FROM_DISK:" + name, reasons)

    @unittest.skipUnless(importlib.util.find_spec("packaging"), "Optional packaging requirement parser is not installed")
    def test_package_version_drift_and_missing_dependency_are_not_cacheable(self):
        self.write({"tool": "descriptive_statistics", "arguments": {"values": [1, 2, 3]}})
        inventory = {name: {"name": name, "version": "1.0", "metadata_sha256": name, "requires": []}
                     for name in ("numpy", "scipy", "packaging")}
        with patch.object(identity, "_installed_inventory", return_value=inventory), \
             patch.object(identity, "_PACKAGE_BASELINE", {name: name for name in inventory}):
            first = self.fingerprint()
        changed_inventory = copy.deepcopy(inventory)
        changed_inventory["numpy"].update(version="999.0", metadata_sha256="0" * 64)
        with patch.object(identity, "_installed_inventory", return_value=changed_inventory):
            changed = self.fingerprint()
        self.assertNotEqual(first["fingerprint_sha256"], changed["fingerprint_sha256"])
        self.assertFalse(changed["cacheable"])
        self.assertIn("PACKAGE_ENVIRONMENT_CHANGED_SINCE_PROCESS_START:numpy", changed["reasons"])
        inventory.pop("numpy")
        with patch.object(identity, "_installed_inventory", return_value=inventory):
            missing = self.fingerprint()
        self.assertIn("RUNTIME_DEPENDENCY_UNAVAILABLE:numpy", missing["reasons"])
        self.assertFalse(missing["cacheable"])

    @unittest.skipUnless(importlib.util.find_spec("packaging"), "Optional packaging requirement parser is not installed")
    def test_dependency_closure_includes_transitive_extras_and_version_constraints(self):
        def item(name, requires=(), version="1.0"):
            return {"name": name, "version": version, "metadata_sha256": name, "requires": list(requires)}
        inventory = {"numpy": item("numpy", ["child[extra]>=2"]), "child": item("child", ['leaf; extra == "extra"']),
                     "leaf": item("leaf"), "packaging": item("packaging")}
        packages, reasons = identity._dependency_closure(["numpy"], inventory)
        self.assertEqual({row["name"] for row in packages}, set(inventory))
        self.assertIn("RUNTIME_DEPENDENCY_VERSION_MISMATCH:child", reasons)

    @unittest.skipUnless(importlib.util.find_spec("packaging"), "Optional packaging requirement parser is not installed")
    def test_loaded_dependency_version_drift_is_not_certified(self):
        self.write({"tool": "descriptive_statistics", "arguments": {"values": [1, 2, 3]}})
        module = types.ModuleType("numpy")
        module.__version__ = "0.0.0"
        inventory = {name: {"name": name, "version": "1.0", "metadata_sha256": name, "requires": []}
                     for name in ("numpy", "scipy", "packaging")}
        with patch.dict(sys.modules, {"numpy": module}), patch.object(identity, "_installed_inventory", return_value=inventory):
            value = self.fingerprint()
        self.assertFalse(value["cacheable"])
        self.assertIn("LOADED_PACKAGE_VERSION_DIFFERS_FROM_INSTALLED:numpy", value["reasons"])

    def test_frozen_policy_covers_catalog_but_never_assumes_new_tools(self):
        self.assertEqual(identity.REVIEWED_TOOLS, set(compute.TOOLS))
        self.assertEqual(len(identity.REVIEWED_TOOLS), 127)
        self.assertLessEqual(set(identity.UNCACHEABLE_TOOLS), identity.REVIEWED_TOOLS)
        self.assertLessEqual(set(identity.FIXED_SEEDS), identity.REVIEWED_TOOLS)
        self.write({"tool": "future_tool", "arguments": self.payload["arguments"]})
        with patch.dict(compute.TOOLS, {"future_tool": compute.TOOLS[self.payload["tool"]]}), \
             patch.dict(compute.HANDLERS, {"future_tool": compute.HANDLERS[self.payload["tool"]]}):
            value = self.fingerprint()
        self.assertIn("TOOL_CACHE_POLICY_NOT_REVIEWED", value["reasons"])
        self.assertFalse(value["cacheable"])

    def test_seed_is_bound_and_global_randomness_exceptions_are_explicit(self):
        tool = "perform_gene_expression_nmf_analysis"
        arguments = copy.deepcopy(compute.TOOLS[tool]["example"])
        self.write({"tool": tool, "arguments": arguments})
        first = self.fingerprint()
        arguments["seed"] += 1
        self.write({"tool": tool, "arguments": arguments})
        self.assertNotEqual(first["fingerprint_sha256"], self.fingerprint()["fingerprint_sha256"])
        self.assertEqual(first["materials"]["implementation"]["determinism"]["effective_seeds"]["seed"], arguments["seed"] - 1)
        for name, reason in identity.UNCACHEABLE_TOOLS.items():
            self.write({"tool": name, "arguments": compute.TOOLS[name]["example"]})
            value = self.fingerprint()
            self.assertFalse(value["cacheable"])
            self.assertIn(reason, value["reasons"])

    def rna_request(self, mode="fit"):
        (self.workspace / "counts.csv").write_text("gene_id,s1,s2\ng1,1,2\n")
        (self.workspace / "samples.csv").write_text("sample,condition\ns1,a\ns2,b\n")
        self.write({"tool": "analyze_rnaseq_study", "arguments": {"counts_path": "counts.csv", "samples_path": "samples.csv",
                   "reference_level": "a", "comparison_level": "b", "analysis_mode": mode}})

    def test_external_r_environment_is_actual_probe_bound_and_unavailability_explicit(self):
        self.rna_request()
        runtime = {"checked": True, "available": True, "R": "R fixture", "DESeq2": "fixture", "packages_sha256": "a" * 64}
        with patch.object(identity, "_external_r_identity", return_value=(runtime, [])):
            first = self.fingerprint()
        with patch.object(identity, "_external_r_identity", return_value=({**runtime, "packages_sha256": "b" * 64}, [])):
            changed = self.fingerprint()
        self.assertNotEqual(first["fingerprint_sha256"], changed["fingerprint_sha256"])
        with patch.object(identity, "_external_r_identity", return_value=({"available": False}, ["EXTERNAL_R_IDENTITY_UNAVAILABLE"])):
            unavailable = self.fingerprint()
        self.assertFalse(unavailable["cacheable"])
        self.assertIn("EXTERNAL_R_IDENTITY_UNAVAILABLE", unavailable["reasons"])
        self.rna_request("validate")
        with patch.object(identity, "_external_r_identity") as probe:
            self.fingerprint()
        probe.assert_not_called()

    def test_probe_launcher_failure_returns_unknown_without_running_any_fit(self):
        with patch("proto_agent.bioinformatics._worker_command", return_value=["fixed-worker", "identity", "--engine", "deseq2"]), \
             patch("subprocess.run", side_effect=subprocess.TimeoutExpired("fixed-worker", 45)) as run:
            runtime, reasons = identity._external_r_identity()
        self.assertFalse(runtime["available"])
        self.assertEqual(reasons, ["EXTERNAL_R_IDENTITY_UNAVAILABLE"])
        self.assertIn("identity", run.call_args.args[0])

    def test_actual_execution_binds_same_preflight_and_saved_receipt(self):
        before = self.fingerprint()
        result = compute.run_compute("request.json", workspace_root=self.workspace)
        bound = result["execution_fingerprint"]
        self.assertTrue(bound["cacheable"], bound["reasons"])
        self.assertTrue(bound["verified_unchanged"])
        self.assertEqual(bound["fingerprint_sha256"], before["fingerprint_sha256"])
        saved = json.loads((self.workspace / result["manifest_path"]).read_text())
        self.assertEqual(saved["execution_fingerprint"], bound)

    def test_input_drift_during_execution_preserves_result_but_disables_reuse(self):
        handler = compute.HANDLERS[self.payload["tool"]]
        def calculate(arguments):
            result = handler(arguments)
            self.write({"tool": self.payload["tool"], "arguments": {"sequence": "NAT"}})
            return result
        with patch.dict(compute.HANDLERS, {self.payload["tool"]: calculate}):
            result = compute.run_compute("request.json", workspace_root=self.workspace)
        self.assertTrue(result["ok"])
        self.assertFalse(result["execution_fingerprint"]["cacheable"])
        self.assertFalse(result["execution_fingerprint"]["verified_unchanged"])
        self.assertIn("EXECUTION_IDENTITY_CHANGED", result["execution_fingerprint"]["reasons"])
        self.assertTrue((self.workspace / result["manifest_path"]).is_file())
        saved_input = json.loads((self.workspace / result["inputs"]["request_snapshot"]).read_text())
        self.assertEqual(saved_input, self.payload)

    def test_successful_uncacheable_execution_can_still_verify_unchanged(self):
        with patch.object(identity, "UNCACHEABLE_TOOLS", {self.payload["tool"]: "TEST_UNKNOWN_DETERMINISM"}):
            result = compute.run_compute("request.json", workspace_root=self.workspace)
        self.assertTrue(result["ok"])
        self.assertFalse(result["execution_fingerprint"]["cacheable"])
        self.assertTrue(result["execution_fingerprint"]["verified_unchanged"])

    def test_cancellation_during_identity_never_starts_handler_or_publishes(self):
        for target in ("fingerprint_prepared", "bind_execution_fingerprint"):
            event = threading.Event()
            original = getattr(identity, target)
            def cancel(*args, **kwargs):
                value = original(*args, **kwargs)
                event.set()
                return value
            with self.subTest(target=target), patch.object(identity, target, side_effect=cancel):
                with self.assertRaises(compute.ComputeError) as caught:
                    compute.run_compute("request.json", workspace_root=self.workspace, cancel_event=event)
            self.assertEqual(caught.exception.code, "COMPUTE_CANCELLED")
            self.assertFalse((self.workspace / "build/compute").exists())

    def test_mcp_fingerprint_dispatch_and_extra_fields(self):
        server = McpServer(self.workspace)
        def call(arguments):
            return server.handle_message({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                "params": {"name": "proto_compute_fingerprint", "arguments": arguments}})["result"]["structuredContent"]
        self.assertTrue(call({"path": "request.json"})["ok"])
        self.assertFalse(call({"path": "request.json", "execute": True})["ok"])
        self.assertFalse(call({"path": "../outside.json"})["ok"])

    def test_cold_preflight_does_not_import_numerical_packages(self):
        script = "import json,sys; from proto_agent.compute_identity import compute_fingerprint; value=compute_fingerprint('request.json',workspace_root=sys.argv[1]); print(json.dumps({'cacheable':value['cacheable'],'loaded':[name for name in ('numpy','scipy','torch','sklearn','pandas') if name in sys.modules],'reasons':value['reasons']}))"
        result = subprocess.run([sys.executable, "-c", script, str(self.workspace)], capture_output=True, text=True, timeout=30, check=True)
        value = json.loads(result.stdout)
        self.assertTrue(value["cacheable"], value["reasons"])
        self.assertEqual(value["loaded"], [])


class RIdentityWorkerTests(unittest.TestCase):
    def test_fixed_readonly_query_parser_and_package_hash(self):
        rows = "kind\tname\tversion\tlocation\nruntime\tR\tR test\t\nruntime\tDESeq2\t1.0\t\nruntime\tplatform\tx86-test\t\nruntime\tarch\tx86\t\npackage\tDESeq2\t1.0\t/env/library\n"
        process = MagicMock(returncode=0)
        process.communicate.return_value = (rows, "")
        with patch("proto_agent.bioinformatics_worker.subprocess.Popen", return_value=process) as launch:
            value = r_environment_identity(Path("/fixed-root"))
        self.assertTrue(value["available"])
        self.assertEqual(value["identity"]["package_count"], 1)
        self.assertEqual(launch.call_args.args[0][-1], R_IDENTITY_SOURCE)
        self.assertTrue(launch.call_args.kwargs["start_new_session"])
        process.communicate.assert_called_once_with(timeout=35)
        process.communicate.return_value = (rows.replace("package\tDESeq2\t1.0", "package\tDESeq2\t2.0"), "")
        with patch("proto_agent.bioinformatics_worker.subprocess.Popen", return_value=process):
            self.assertFalse(r_environment_identity(Path("/fixed-root"))["available"])

    def test_timed_out_probe_stops_its_owned_process_group(self):
        process = MagicMock()
        process.communicate.side_effect = subprocess.TimeoutExpired("fixed R query", 35)
        with patch("proto_agent.bioinformatics_worker.subprocess.Popen", return_value=process), \
             patch("proto_agent.bioinformatics_worker.stop_group") as stop:
            value = r_environment_identity(Path("/fixed-root"))
        stop.assert_called_once_with(process)
        self.assertFalse(value["available"])


if __name__ == "__main__":
    unittest.main()
