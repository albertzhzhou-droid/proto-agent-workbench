"""Offline DOM checks of retained dispersion-only records; no scientific execution."""

import shutil
import subprocess
from pathlib import Path

import pytest


def test_dispersion_diagnostics_offline_dom_and_precision() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is required for offline frontend contracts")
    root = Path(__file__).resolve().parents[1]
    completed = subprocess.run(
        [node, "--test", str(root / "tests/dispersion_diagnostics.test.cjs")],
        capture_output=True,
        text=True,
        cwd=root,
        timeout=45,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
