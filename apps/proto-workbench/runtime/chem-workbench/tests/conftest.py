"""Shared fixtures for offline Chem Workbench tests."""

from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

import pytest

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = REPOSITORY_ROOT / "src"

# Keep the tests runnable from a fresh source checkout without requiring an
# editable install or any network-backed dependency resolution.
sys.path.insert(0, str(SOURCE_ROOT))


@pytest.fixture
def run_chem() -> Callable[..., subprocess.CompletedProcess[bytes]]:
    """Run the real module entry point in an isolated child process."""

    def run(*arguments: object) -> subprocess.CompletedProcess[bytes]:
        environment = os.environ.copy()
        existing_python_path = environment.get("PYTHONPATH")
        environment["PYTHONPATH"] = str(SOURCE_ROOT)
        if existing_python_path:
            environment["PYTHONPATH"] += os.pathsep + existing_python_path
        return subprocess.run(
            [sys.executable, "-m", "chem_workbench", *(str(item) for item in arguments)],
            cwd=REPOSITORY_ROOT,
            env=environment,
            check=False,
            capture_output=True,
        )

    return run
