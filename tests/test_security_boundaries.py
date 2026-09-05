from __future__ import annotations

import io
import hashlib
import hmac
import json
import os
import stat
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from proto_agent.analysis import run_python_analysis
from proto_agent.cli import main as cli_main
from proto_agent.connectors import connector_summary
from proto_agent.execution import (
    MAX_CAPTURE_BYTES,
    ExecutionBroker,
    ExecutionDenied,
    SandboxConfig,
    _drain_stream,
    build_host_argv,
    build_oci_argv,
    minimal_execution_environment,
    public_execution_command,
)
from proto_agent.json_validation import JsonValidationError, strict_json_loads
from proto_agent.mcp_server import (
    NETWORK_CAPABILITY_VERSION,
    McpServer,
    _stable_json_bytes,
    _tool_result,
)
from proto_agent.notebook import (
    MAX_NOTEBOOK_CELL_BYTES,
    MAX_NOTEBOOK_CELLS,
    _validated_code_cells,
)
from proto_agent.review import _validate_manifest
from proto_agent.security import (
    SecurityBoundaryError,
    WorkspacePaths,
    is_reparse_point,
    public_workspace_payload,
    read_text_bounded,
    write_text_bounded,
)


class SecurityBoundaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.workspace = Path(self.temporary.name)
        (self.workspace / "scripts").mkdir()
        (self.workspace / "scripts" / "side_effect.py").write_text(
            "from pathlib import Path\nPath('unexpected-marker').write_text('ran')\n",
            encoding="utf-8",
        )
        for relative in (
            "parts/ecoli_k12_library.json",
            "connectors/proto_workbench.json",
            "literature/seed_sources.json",
            "workflows/design_review.json",
        ):
            target = self.workspace / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("{}\n", encoding="utf-8")
        self.paths = WorkspacePaths.create(self.workspace)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_workspace_rejects_absolute_unc_device_and_traversal_paths(self) -> None:
        bad_paths = [
            str((self.workspace / "scripts" / "side_effect.py").resolve()),
            "../outside.py",
            r"\\server\share\outside.py",
            r"\\?\C:\outside.py",
            r"\\.\PhysicalDrive0",
            "scripts/../side_effect.py",
        ]
        for value in bad_paths:
            with self.subTest(value=value):
                with self.assertRaises(SecurityBoundaryError):
                    self.paths.workspace_file(value, extensions={".py"})
        for value in ("%2e%2e/%2foutside.py", "scripts/%5coutside.py", "line\nbreak.py"):
            with self.subTest(encoded_or_control=value):
                with self.assertRaises(SecurityBoundaryError):
                    self.paths.workspace_file(value, extensions={".py"})

        with self.assertRaises(SecurityBoundaryError):
            self.paths.workspace_file("scripts", extensions={".py"})
        with self.assertRaises(SecurityBoundaryError):
            self.paths.workspace_file("scripts/side_effect.py", extensions={".r"})
        with self.assertRaises(SecurityBoundaryError):
            self.paths.workspace_file("scripts/side_effect.py", extensions={".py"}, max_bytes=1)

    def test_workspace_rejects_symlink_escape_when_supported(self) -> None:
        outside = self.workspace.parent / f"{self.workspace.name}-outside.txt"
        outside.write_text("outside", encoding="utf-8")
        link = self.workspace / "scripts" / "escape.py"
        try:
            os.symlink(outside, link)
        except (OSError, NotImplementedError):
            outside.unlink(missing_ok=True)
            self.skipTest("Creating a symlink is not permitted on this platform.")
        try:
            with self.assertRaises(SecurityBoundaryError):
                self.paths.workspace_file("scripts/escape.py", extensions={".py"})
        finally:
            link.unlink(missing_ok=True)
            outside.unlink(missing_ok=True)

    def test_workspace_rejects_hardlink_to_outside_file(self) -> None:
        outside = self.workspace.parent / f"{self.workspace.name}-outside-hardlink.json"
        alias = self.workspace / "parts" / "outside-hardlink.json"
        outside.write_text('{"secret":"outside"}\n', encoding="utf-8")
        try:
            os.link(outside, alias)
        except (OSError, NotImplementedError):
            outside.unlink(missing_ok=True)
            self.skipTest("Creating a hard link is not permitted on this platform.")
        try:
            with self.assertRaisesRegex(SecurityBoundaryError, "multiple hard links"):
                self.paths.workspace_file(alias.relative_to(self.workspace), extensions={".json"})
            with self.assertRaisesRegex(SecurityBoundaryError, "multiple hard links"):
                read_text_bounded(alias)
        finally:
            alias.unlink(missing_ok=True)
            outside.unlink(missing_ok=True)

    def test_windows_reparse_attribute_is_treated_as_unsafe(self) -> None:
        fake_stat = SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=0x400)
        with patch("proto_agent.security._lstat_or_none", return_value=fake_stat):
            self.assertTrue(is_reparse_point(self.workspace / "junction"))

    def test_atomic_writer_rejects_simulated_windows_reparse_target(self) -> None:
        target = self.paths.build / "reparse-target.txt"
        import proto_agent.security as security_module

        real_check = security_module._is_reparse_or_symlink

        def simulated_check(path: Path) -> bool:
            return path == target or real_check(path)

        with patch("proto_agent.security._is_reparse_or_symlink", side_effect=simulated_check):
            with self.assertRaises(SecurityBoundaryError):
                write_text_bounded(target, "blocked", boundary=self.paths.build)
        self.assertFalse(target.exists())

    def test_atomic_writer_rejects_existing_symlink_target_when_supported(self) -> None:
        outside = self.workspace.parent / f"{self.workspace.name}-write-outside.txt"
        outside.write_text("unchanged", encoding="utf-8")
        target = self.paths.build / "linked.txt"
        try:
            os.symlink(outside, target)
        except (OSError, NotImplementedError):
            outside.unlink(missing_ok=True)
            self.skipTest("Creating a symlink is not permitted on this platform.")
        try:
            with self.assertRaises(SecurityBoundaryError):
                write_text_bounded(target, "changed", boundary=self.paths.build)
            self.assertEqual(outside.read_text(encoding="utf-8"), "unchanged")
        finally:
            target.unlink(missing_ok=True)
            outside.unlink(missing_ok=True)

    def test_untrusted_execution_is_denied_by_default_without_side_effect(self) -> None:
        broker = ExecutionBroker(SandboxConfig(caller="library"))
        manifest, code = run_python_analysis(
            "scripts/side_effect.py",
            broker=broker,
            workspace_root=self.workspace,
        )
        self.assertEqual(code, 1)
        self.assertFalse(manifest["ok"])
        self.assertEqual(manifest["diagnostics"][0]["code"], "EXECUTION_DISABLED")
        self.assertFalse((self.workspace / "unexpected-marker").exists())

    def test_host_execution_constructor_is_cli_only(self) -> None:
        with self.assertRaises(ExecutionDenied):
            ExecutionBroker(SandboxConfig(unsafe_host=True, caller="mcp"))
        python_argv = build_host_argv("python", self.workspace / "scripts" / "side_effect.py", [])
        self.assertIn("-I", python_argv)
        self.assertIn("-B", python_argv)
        r_argv = build_host_argv("r", self.workspace / "scripts" / "analysis.r", [], "Rscript")
        self.assertIn("--vanilla", r_argv)
        environment = minimal_execution_environment(self.workspace, self.paths.build)
        self.assertNotIn("HOME", environment)
        self.assertNotIn("USERPROFILE", environment)
        self.assertNotIn("COMSPEC", environment)

    def test_provider_visibility_does_not_claim_smoke_verification(self) -> None:
        broker = ExecutionBroker(
            SandboxConfig(
                provider="docker",
                image=f"example/proto@sha256:{'a' * 64}",
                caller="cli",
            )
        )
        with patch("proto_agent.execution.shutil.which", return_value=str(self.workspace / "docker")):
            status = broker.status()
        self.assertTrue(status["configured"])
        self.assertTrue(status["provider_visible"])
        self.assertFalse(status["smoke_verified"])

    def test_oci_argv_is_digest_pinned_non_root_and_argument_safe(self) -> None:
        run_dir = self.paths.run_directory("build/runs", "run-123")
        script = self.paths.workspace_file("scripts/side_effect.py", extensions={".py"})
        attacker_argument = "; touch /tmp/escaped"
        argv = build_oci_argv(
            executable="docker",
            provider="docker",
            image=f"example/proto@sha256:{'a' * 64}",
            runtime="python",
            script=script,
            args=[attacker_argument],
            workspace=self.paths.workspace,
            run_dir=run_dir,
            container_name="proto-agent-12345678",
            container_user="65532:65532",
        )
        self.assertIn("--user", argv)
        self.assertIn("65532:65532", argv)
        self.assertIn("--network", argv)
        self.assertIn("none", argv)
        self.assertIn("--read-only", argv)
        self.assertIn("no-new-privileges=true", argv)
        self.assertIn("--pids-limit", argv)
        self.assertIn("--memory", argv)
        self.assertIn("--cpus", argv)
        self.assertIn("--pull", argv)
        self.assertIn("never", argv)
        self.assertEqual(argv[-1], attacker_argument)

        r_script = self.workspace / "scripts" / "analysis.r"
        r_script.write_text("print('ok')\n", encoding="utf-8")
        r_argv = build_oci_argv(
            executable="podman",
            provider="podman",
            image=f"example/proto-r@sha256:{'b' * 64}",
            runtime="r",
            script=r_script,
            args=[],
            workspace=self.paths.workspace,
            run_dir=run_dir,
            container_name="proto-agent-abcdef12",
            container_user="65532:65532",
        )
        self.assertIn("--vanilla", r_argv)

    def test_public_execution_command_redacts_host_roots(self) -> None:
        run_dir = self.paths.run_directory("build/runs", "public-command")
        command = [
            str(self.workspace / "runtime" / "python.exe"),
            "--mount",
            f"{self.workspace}:/workspace:ro",
            f"{run_dir}:/run:rw",
        ]
        public = public_execution_command(
            command,
            workspace=self.paths.workspace,
            run_dir=run_dir,
        )
        serialized = json.dumps(public)
        self.assertNotIn(str(self.workspace), serialized)
        self.assertIn("<workspace>", serialized)
        self.assertIn("<run>", serialized)

    def test_public_workspace_payload_relativizes_internal_paths(self) -> None:
        cache = self.paths.cache / "provider" / "entry.json"
        payload = public_workspace_payload(
            {
                "cache_path": str(cache),
                "diagnostics": [{"file": str(cache), "code": "MISS"}],
                "ir": {"provenance": {"source": str(self.workspace / "designs" / "input.proto")}},
                "steps": [{"diagnostics": [{"file": str(self.workspace.parent / "outside.proto")}]}],
            },
            self.workspace,
        )
        rendered = json.dumps(payload)
        self.assertNotIn(str(self.workspace), rendered)
        self.assertEqual(payload["cache_path"], "build/cache/provider/entry.json")
        self.assertEqual(payload["ir"]["provenance"]["source"], "designs/input.proto")
        self.assertEqual(payload["steps"][0]["diagnostics"][0]["file"], "<outside-workspace>")

    def test_connector_registry_at_workspace_root_cannot_redefine_workspace(self) -> None:
        container = self.workspace / "connector-root-test"
        workspace = container / "workspace"
        workspace.mkdir(parents=True)
        registry = workspace / "registry.json"
        registry.write_text(
            json.dumps(
                {
                    "schema_version": "proto-agent.connectors.v1",
                    "workbench": "test",
                    "connectors": [],
                }
            ),
            encoding="utf-8",
        )
        outside_build = container / "build"

        result = connector_summary("registry.json", workspace_root=workspace)

        self.assertTrue(result["ok"])
        self.assertEqual(result["registry"], "registry.json")
        self.assertFalse(outside_build.exists())

    def test_output_capture_is_bounded(self) -> None:
        state: dict[str, int | bool] = {"size": 0, "truncated": False}
        chunks: list[bytes] = []
        _drain_stream(io.BytesIO(b"x" * (MAX_CAPTURE_BYTES + 1024)), chunks, state)
        self.assertEqual(sum(len(chunk) for chunk in chunks), MAX_CAPTURE_BYTES)
        self.assertTrue(state["truncated"])

    def test_json_rejects_huge_exponent_integer_and_depth(self) -> None:
        for text in ("1e999", str(2**80), "[" * 40 + "0" + "]" * 40):
            with self.subTest(text=text[:20]):
                with self.assertRaises(JsonValidationError):
                    strict_json_loads(text, max_bytes=4096)

    def test_notebook_cell_count_and_cell_byte_limits(self) -> None:
        with self.assertRaises(SecurityBoundaryError):
            _validated_code_cells(
                {"cells": [{"cell_type": "markdown", "source": []}] * (MAX_NOTEBOOK_CELLS + 1)}
            )
        with self.assertRaises(SecurityBoundaryError):
            _validated_code_cells(
                {"cells": [{"cell_type": "code", "source": "x" * (MAX_NOTEBOOK_CELL_BYTES + 1)}]}
            )

    def test_mcp_rejects_unknown_rpc_and_tool_fields(self) -> None:
        server = McpServer(self.workspace)
        rpc_response = server.handle_message(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}, "extra": True}
        )
        self.assertEqual(rpc_response["error"]["code"], -32600)

        tool_response = server.handle_message(
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "proto_r_status", "arguments": {"unexpected": True}},
            }
        )
        structured = tool_response["result"]["structuredContent"]
        self.assertFalse(structured["ok"])
        self.assertEqual(structured["diagnostics"][0]["code"], "INVALID_TOOL_ARGUMENTS")

        network_response = server.handle_message(
            {
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {
                    "name": "proto_pubmed_search",
                    "arguments": {"query": "test", "cache_dir": "elsewhere", "cafile": "ca.pem"},
                },
            }
        )
        network_structured = network_response["result"]["structuredContent"]
        self.assertFalse(network_structured["ok"])
        self.assertEqual(network_structured["diagnostics"][0]["code"], "INVALID_TOOL_ARGUMENTS")

    def test_mcp_execution_tool_fails_closed(self) -> None:
        server = McpServer(self.workspace)
        response = server.handle_message(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "proto_run_analysis",
                    "arguments": {"script": "scripts/side_effect.py"},
                },
            }
        )
        structured = response["result"]["structuredContent"]
        self.assertFalse(structured["ok"])
        self.assertEqual(structured["diagnostics"][0]["code"], "EXECUTION_DISABLED")
        self.assertFalse((self.workspace / "unexpected-marker").exists())

    def test_mcp_live_network_requires_bound_one_time_capability(self) -> None:
        key = bytes.fromhex("42" * 32)
        arguments = {"query": "bounded test", "retmax": 1, "offline": False}

        def capability(for_arguments: dict[str, object], *, nonce: str = "ab" * 16) -> dict[str, object]:
            now = int(time.time() * 1000)
            unsigned: dict[str, object] = {
                "version": NETWORK_CAPABILITY_VERSION,
                "tool": "proto_pubmed_search",
                "argumentsSha256": hashlib.sha256(_stable_json_bytes(for_arguments)).hexdigest(),
                "runId": "run-network-test",
                "approvalId": "approval-network-test",
                "issuedAtMs": now,
                "expiresAtMs": now + 30_000,
                "nonce": nonce,
            }
            return {
                **unsigned,
                "mac": hmac.new(key, _stable_json_bytes(unsigned), hashlib.sha256).hexdigest(),
            }

        def request(for_arguments: dict[str, object], token: dict[str, object] | None = None) -> dict[str, object]:
            params: dict[str, object] = {
                "name": "proto_pubmed_search",
                "arguments": for_arguments,
            }
            if token is not None:
                params["capability"] = token
            return {
                "jsonrpc": "2.0",
                "id": 90,
                "method": "tools/call",
                "params": params,
            }

        with patch.dict(
            os.environ,
            {"PROTO_WORKBENCH_WORKSPACE_CAPABILITY": key.hex()},
            clear=False,
        ):
            server = McpServer(self.workspace)
        denied = server.handle_message(request(arguments))
        self.assertEqual(
            denied["result"]["structuredContent"]["diagnostics"][0]["code"],
            "NETWORK_CAPABILITY_REQUIRED",
        )

        token = capability(arguments)
        with patch(
            "proto_agent.mcp_server.search_pubmed",
            return_value={"ok": True, "matches": [], "source_ids": []},
        ) as search:
            allowed = server.handle_message(request(arguments, token))
        self.assertTrue(allowed["result"]["structuredContent"]["ok"])
        self.assertTrue(search.call_args.args[3])

        replayed = server.handle_message(request(arguments, token))
        self.assertEqual(
            replayed["result"]["structuredContent"]["diagnostics"][0]["code"],
            "NETWORK_CAPABILITY_REQUIRED",
        )

        tampered = {**arguments, "query": "different"}
        rejected = server.handle_message(request(tampered, capability(arguments, nonce="cd" * 16)))
        self.assertEqual(
            rejected["result"]["structuredContent"]["diagnostics"][0]["code"],
            "NETWORK_CAPABILITY_REQUIRED",
        )

    def test_mcp_propagates_cancellation_and_discards_late_response(self) -> None:
        server = McpServer(self.workspace)
        cancel_event = threading.Event()
        captured: dict[str, object] = {}

        def fake_run(*args: object, **kwargs: object) -> tuple[dict[str, object], int]:
            captured["cancel_event"] = kwargs.get("cancel_event")
            return {"ok": False, "diagnostics": []}, 1

        message = {
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/call",
            "params": {"name": "proto_run_analysis", "arguments": {"script": "scripts/side_effect.py"}},
        }
        with patch("proto_agent.mcp_server.run_python_analysis", side_effect=fake_run):
            server.handle_message(message, cancel_event=cancel_event)
        self.assertIs(captured["cancel_event"], cancel_event)

        cancel_event.set()
        with patch.object(server, "handle_message", return_value={"jsonrpc": "2.0", "id": 7, "result": {}}), patch.object(
            server, "_emit_response"
        ) as emit:
            server._tool_request_worker(message, 7, cancel_event)
        emit.assert_called_once_with({"jsonrpc": "2.0", "method": "notifications/proto-request-finished", "params": {
            "requestId": 7, "status": "cancelled",
        }})

    def test_tool_response_limit_returns_small_structured_error(self) -> None:
        result = _tool_result({"ok": True, "data": "x" * (600 * 1024)})
        self.assertTrue(result["isError"])
        self.assertEqual(
            result["structuredContent"]["diagnostics"][0]["code"],
            "TOOL_RESPONSE_TOO_LARGE",
        )

    def test_doctor_and_capabilities_json_do_not_smoke_run_provider(self) -> None:
        for argv in (["doctor", "--json"], ["capabilities", "--json"], ["sandbox", "status", "--json"]):
            output = io.StringIO()
            with redirect_stdout(output), patch.object(Path, "cwd", return_value=self.workspace):
                code = cli_main(list(argv))
            self.assertEqual(code, 0)
            payload = json.loads(output.getvalue())
            self.assertTrue(payload["ok"])
            if argv[0] in {"doctor", "sandbox"}:
                sandbox = payload["sandbox"] if argv[0] == "doctor" else payload
                self.assertFalse(sandbox["smoke_verified"])

    def test_cancel_event_is_accepted_without_enabling_execution(self) -> None:
        event = threading.Event()
        event.set()
        broker = ExecutionBroker(SandboxConfig(caller="library"))
        with self.assertRaises(ExecutionDenied):
            broker.execute(
                runtime="python",
                script=self.workspace / "scripts" / "side_effect.py",
                args=[],
                workspace=self.workspace,
                run_dir=self.paths.run_directory("build/runs", "cancel-test"),
                timeout=1,
                cancel_event=event,
            )

    def test_review_manifest_run_id_cannot_escape_output_directory(self) -> None:
        with self.assertRaises(ValueError):
            _validate_manifest({"run_id": "../escape", "steps": [], "artifacts": []})


if __name__ == "__main__":
    unittest.main()
