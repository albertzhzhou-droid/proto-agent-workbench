from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class CliSecurityCommandTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory(prefix="proto-cli-security-")
        self.workspace = Path(self._temporary.name).resolve()
        for name in (
            "designs",
            "parts",
            "workflows",
            "literature",
            "connectors",
            ".codex",
        ):
            shutil.copytree(ROOT / name, self.workspace / name)
        shutil.copytree(
            ROOT / "tests" / "security_corpus",
            self.workspace / "tests" / "security_corpus",
        )
        temp_root = self.workspace / "build" / "test-temp"
        temp_root.mkdir(parents=True)
        self.environment = {
            name: os.environ[name]
            for name in ("SystemRoot", "WINDIR", "COMSPEC", "PATHEXT")
            if name in os.environ
        }
        self.environment.update(
            {
                "PYTHONPATH": str(ROOT / "src"),
                "PYTHONIOENCODING": "utf-8",
                "PYTHONUTF8": "1",
                "TEMP": str(temp_root),
                "TMP": str(temp_root),
            }
        )

    def tearDown(self) -> None:
        self._temporary.cleanup()

    def run_cli(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-m", "proto_agent.cli", *arguments],
            cwd=self.workspace,
            env=self.environment,
            text=True,
            encoding="utf-8",
            capture_output=True,
            timeout=30,
            check=False,
        )

    def test_workflow_provenance_can_be_verified_by_cli(self) -> None:
        workflow = self.run_cli("workflow", "run", "designs/toggle_switch.proto")
        self.assertEqual(workflow.returncode, 0, workflow.stderr)
        payload = json.loads(workflow.stdout)
        provenance = self.workspace / payload["provenance_path"]
        self.assertTrue(provenance.is_file())

        relative = provenance.relative_to(self.workspace).as_posix()
        verification = self.run_cli("provenance", "verify", relative)
        self.assertEqual(verification.returncode, 0, verification.stderr)
        result = json.loads(verification.stdout)
        self.assertTrue(result["ok"], result["mismatches"])

        request = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "proto_provenance_verify",
                    "arguments": {"path": relative},
                },
            }
        )
        mcp = self.run_cli("mcp", "--once", request)
        self.assertEqual(mcp.returncode, 0, mcp.stderr)
        response = json.loads(mcp.stdout)
        self.assertTrue(response["result"]["structuredContent"]["ok"])
        self.assertFalse(response["result"]["isError"])

    def test_offline_stress_cli_is_bounded_and_writes_inside_build(self) -> None:
        result = self.run_cli(
            "security",
            "stress",
            "--max-cases",
            "8",
            "--max-total-seconds",
            "2",
            "--max-case-seconds",
            "0.2",
            "--max-input-bytes",
            "4096",
            "--report",
            "security/cli-stress.json",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"], payload)
        self.assertTrue(payload["offline"])
        self.assertEqual(payload["external_processes_started"], 0)
        self.assertEqual(payload["network_requests_made"], 0)
        self.assertEqual(payload["summary"]["executed_cases"], 8)
        self.assertTrue((self.workspace / "build" / "security" / "cli-stress.json").is_file())

    def test_stress_cli_rejects_unbounded_request(self) -> None:
        result = self.run_cli("security", "stress", "--max-total-seconds", "3600")
        self.assertEqual(result.returncode, 2)
        payload = json.loads(result.stderr)
        self.assertEqual(payload["diagnostics"][0]["code"], "INVALID_INPUT")


if __name__ == "__main__":
    unittest.main()
