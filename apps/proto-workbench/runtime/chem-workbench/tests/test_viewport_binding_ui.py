"""Exercise geometry binding through shipped frontend handlers without a browser."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest


def test_viewport_binding_ui() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is required for frontend binding tests")
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [node, str(root / "tests/verify_viewport_binding.cjs")],
        cwd=root,
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "Viewport binding: 21 scenarios passed" in result.stdout
