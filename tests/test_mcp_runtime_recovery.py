"""Bounded sidecar lifecycle and read-only DNA/protein integration checks."""
from __future__ import annotations

import hashlib
import io
import json
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from proto_agent.cli import main as cli_main
from proto_agent.mcp_server import McpServer, _validate_rpc_message
from proto_agent.json_validation import JsonValidationError
from proto_agent.protein import validate_protein_selection
from proto_agent.security import WorkspacePaths


ROOT = Path(__file__).resolve().parents[1]
SOURCE = (
    "# Toy development fixture; no biological validation.\r\n"
    "design preview_toy chassis ecoli_k12\r\n"
    "construct unit:\r\n"
    "  promoter pLac instance=p1\r\n"
    "  rbs B0034 instance=r1\r\n"
    "  cds tetR instance=c1\r\n"
    "  terminator B0015 instance=t1\r\n"
)


def request(tool="proto_connectors_check", arguments=None, request_id=1, token=None):
    message = {"jsonrpc": "2.0", "id": request_id, "method": "tools/call", "params": {
        "name": tool, "arguments": arguments or {},
    }}
    if token is not None:
        message["params"]["_meta"] = {"progressToken": token}
    return message


class McpRuntimeRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="proto-mcp-recovery-")
        self.addCleanup(self.temporary.cleanup)
        self.workspace = Path(self.temporary.name)
        self.server = McpServer(self.workspace)

    def test_progress_metadata_is_bounded_and_rejects_unknown_fields(self):
        for token in (0, 123, "mission-step-1"):
            _validate_rpc_message(request(token=token))
        for token in (True, 1.5, [], {}, "", "x" * 129, 2**53, "bad\x00token"):
            message = request()
            message["params"]["_meta"] = {"progressToken": token}
            with self.subTest(token=token), self.assertRaises(JsonValidationError):
                _validate_rpc_message(message)
        for metadata in ({}, {"progressToken": 1, "capability": "bypass"}):
            message = request()
            message["params"]["_meta"] = metadata
            with self.assertRaises(JsonValidationError):
                _validate_rpc_message(message)

    def test_language_reference_is_bounded_read_only_and_uses_placeholders(self):
        before = list(self.workspace.rglob("*"))
        for topic in ("all", "dna", "protein", "edits"):
            payload = self.server.handle_message(request("proto_language_reference", {"topic": topic}))["result"]["structuredContent"]
            self.assertTrue(payload["ok"], payload)
            self.assertTrue(payload["placeholders_are_not_resource_ids"])
            self.assertLess(len(json.dumps(payload)), 16000)
            self.assertEqual(set(payload["sections"]), {"dna", "protein", "edits"} if topic == "all" else {topic})
        invalid = self.server.handle_message(request("proto_language_reference", {"topic": "invent-part"}))["result"]["structuredContent"]
        self.assertFalse(invalid["ok"])
        self.assertEqual(list(self.workspace.rglob("*")), before)

    def test_permission_failures_are_actionable_without_exposing_host_paths(self):
        with patch.dict(self.server._tool_handlers, {"proto_connectors_check": lambda _: (_ for _ in ()).throw(PermissionError("private external path"))}):
            payload = self.server.handle_message(request())["result"]["structuredContent"]
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["diagnostics"][0]["code"], "TOOL_PERMISSION_DENIED")
        self.assertNotIn("private external path", json.dumps(payload))

    def test_worker_reports_progress_result_then_terminal_ack(self):
        message = request(token="step-2")
        response = {"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}
        with patch.object(self.server, "handle_message", return_value=response), patch.object(self.server, "_emit_response") as emit:
            self.server._tool_request_worker(message, 1, threading.Event())
        outputs = [call.args[0] for call in emit.call_args_list]
        self.assertEqual([item.get("method", "result") for item in outputs], [
            "notifications/progress", "notifications/progress", "result", "notifications/proto-request-finished",
        ])
        self.assertEqual(outputs[0]["params"]["progressToken"], "step-2")
        self.assertLess(outputs[0]["params"]["progress"], outputs[1]["params"]["progress"])
        self.assertEqual(outputs[-1]["params"], {"requestId": 1, "status": "completed"})

    def test_cancel_ack_waits_for_worker_exit_and_preserves_second_request(self):
        first_started, second_started, first_exit, second_exit = (threading.Event() for _ in range(4))
        outputs = []

        def execute(message, *, cancel_event):
            started, finish = (first_started, first_exit) if message["id"] == 1 else (second_started, second_exit)
            started.set()
            finish.wait(2)
            return {"jsonrpc": "2.0", "id": message["id"], "result": {"ok": True}}

        with patch.object(self.server, "handle_message", side_effect=execute), patch.object(self.server, "_emit_response", side_effect=outputs.append):
            try:
                self.server._start_tool_request(request(request_id=1))
                self.server._start_tool_request(request(request_id=2))
                self.assertTrue(first_started.wait(1))
                self.assertTrue(second_started.wait(1))
                first_worker, first_cancel = self.server._active_requests[1]
                second_worker, second_cancel = self.server._active_requests[2]
                self.server._cancel_request(1)
                self.assertTrue(first_cancel.is_set())
                self.assertFalse(second_cancel.is_set())
                self.assertEqual(outputs, [])
                first_exit.set()
                first_worker.join(1)
                self.assertFalse(first_worker.is_alive())
                self.assertEqual(outputs, [{"jsonrpc": "2.0", "method": "notifications/proto-request-finished", "params": {
                    "requestId": 1, "status": "cancelled",
                }}])
                self.assertIn(2, self.server._active_requests)
                second_exit.set()
                second_worker.join(1)
                self.assertEqual([item.get("id") for item in outputs if "result" in item], [2])
            finally:
                first_exit.set()
                second_exit.set()
                self.server._cancel_and_join_active_requests()

    def prepare_edit(self):
        source = self.workspace / "design.proto"
        source.write_bytes(SOURCE.encode("utf-8"))
        parts = self.workspace / "parts.json"
        parts.write_bytes((ROOT / "parts/ecoli_k12_library.json").read_bytes())
        return {
            "path": "design.proto", "parts_path": "parts.json",
            "commands": [{"type": "set_orientation", "construct": "unit", "instance_id": "c1", "orientation": "reverse"}],
            "expected_source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "expected_parts_sha256": hashlib.sha256(parts.read_bytes()).hexdigest(),
        }

    def test_design_edit_preview_is_digest_bound_checked_and_does_not_write(self):
        arguments = self.prepare_edit()
        before = {path.name: path.read_bytes() for path in self.workspace.iterdir() if path.is_file()}
        response = self.server.handle_message(request("proto_design_edit", arguments))
        payload = response["result"]["structuredContent"]
        self.assertTrue(payload["ok"], payload)
        self.assertIn("instance=c1 orientation=reverse\r\n", payload["candidate_source"])
        self.assertIn("+  cds tetR", payload["unified_diff"])
        self.assertEqual(payload["source_sha256"], arguments["expected_source_sha256"])
        self.assertEqual(payload["parts_sha256"], arguments["expected_parts_sha256"])
        self.assertEqual(before, {path.name: path.read_bytes() for path in self.workspace.iterdir() if path.is_file()})
        arguments["expected_source_sha256"] = "0" * 64
        stale = self.server.handle_message(request("proto_design_edit", arguments))["result"]["structuredContent"]
        self.assertFalse(stale["ok"])
        self.assertEqual(stale["diagnostics"][0]["code"], "DNA_EDIT_REBASE_REQUIRED")

    def test_design_edit_rejects_absolute_paths_and_untyped_changes(self):
        arguments = self.prepare_edit()
        for changes in ({"path": str(self.workspace / "design.proto")}, {"commands": [{"type": "set_sequence", "construct": "unit", "sequence": "ACGT"}]}):
            payload = self.server.handle_message(request("proto_design_edit", {**arguments, **changes}))["result"]["structuredContent"]
            self.assertFalse(payload["ok"])

    def test_cli_design_edit_outputs_preview_without_writing(self):
        arguments = self.prepare_edit()
        (self.workspace / "commands.json").write_text(json.dumps(arguments["commands"]), encoding="utf-8")
        output = io.StringIO()
        with patch("proto_agent.cli.WorkspacePaths.create", return_value=WorkspacePaths.create(self.workspace)), redirect_stdout(output):
            code = cli_main(["design", "edit", "design.proto", "--commands", "commands.json", "--parts", "parts.json", "--expected-source-sha256", arguments["expected_source_sha256"]])
        self.assertEqual(code, 0, output.getvalue())
        self.assertTrue(json.loads(output.getvalue())["ok"])
        self.assertEqual((self.workspace / "design.proto").read_bytes(), SOURCE.encode("utf-8"))

    def test_protein_validation_shares_compilation_checks_without_artifact(self):
        selection = self.workspace / "protein.json"
        selection.write_text("{}", encoding="utf-8")
        ok, diagnostics = validate_protein_selection(selection)
        self.assertFalse(ok)
        self.assertTrue(diagnostics)
        payload = self.server.handle_message(request("proto_protein_validate", {"path": "protein.json"}))["result"]["structuredContent"]
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["domain"], "protein")
        self.assertEqual(payload["artifacts"], [])
        self.assertEqual(payload["diagnostics"][0]["code"], diagnostics[0].code)
        self.assertEqual(list(self.workspace.rglob("*.json")), [selection])


if __name__ == "__main__":
    unittest.main()
