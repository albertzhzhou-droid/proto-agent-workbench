"""Exercise the numerical workbench against retained complex result fixtures."""

import shutil
import subprocess
from pathlib import Path

import pytest


def test_interface_workbench_values_exports_and_lifecycle() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is required for the interface visualization contract")
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [node, "--test", str(root / "tests/interface_workbench.test.cjs")],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=45,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
