"""Verify shipped browser provenance and execution lifecycle with synthetic responses."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest


def test_workflow_ui_provenance_and_model_status_interactions() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is required for the desktop UI interaction check")
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [node, str(root / "scripts/verify_workflow_ui.cjs")],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "provenance, model status, and execution lifecycle regressions passed" in result.stdout
    assert "Execution lifecycle: 30 scenarios passed." in result.stdout
