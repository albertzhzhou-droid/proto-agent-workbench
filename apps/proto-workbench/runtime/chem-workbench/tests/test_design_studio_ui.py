"""Shipped Design Studio event handlers with synthetic transport and scientific test separation."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest


def test_design_studio_lifecycle_and_evidence_interactions() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is required for the Design Studio UI lifecycle check")
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [node, str(root / "scripts/verify_design_studio_ui.cjs")],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "lifecycle and evidence scenarios passed" in result.stdout
