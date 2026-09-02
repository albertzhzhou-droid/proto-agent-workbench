from __future__ import annotations

import io
import json
import unittest
from contextlib import redirect_stderr
from pathlib import Path

from proto_agent.workbench_bridge import main


ROOT = Path(__file__).resolve().parents[1]


class WorkbenchBridgeRetirementTests(unittest.TestCase):
    def test_legacy_bridge_always_fails_closed_without_echoing_arguments(self) -> None:
        private_argument = "C:\\private-model-catalog-sentinel"
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            status = main(["scan-models", private_argument, "--cache", private_argument])

        self.assertEqual(status, 2)
        payload = json.loads(stderr.getvalue())
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["code"], "LEGACY_WORKBENCH_SIDECAR_RETIRED")
        self.assertEqual(payload["replacement"]["provider"], "lmstudio")
        self.assertEqual(payload["replacement"]["endpoint"], "http://127.0.0.1:1234")
        self.assertNotIn(private_argument, stderr.getvalue())

    def test_installed_package_exposes_no_legacy_bridge_console_command(self) -> None:
        pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
        self.assertNotIn("proto-workbench-sidecar", pyproject)


if __name__ == "__main__":
    unittest.main()
