"""Numeric display/export contracts do not constitute chemistry acceptance."""

import shutil
import subprocess
from pathlib import Path

import pytest


def test_geometry_view_preserves_numeric_and_revision_data() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is required for the desktop geometry contract")
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [node, str(root / "scripts/verify_geometry_view_model.cjs")],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
