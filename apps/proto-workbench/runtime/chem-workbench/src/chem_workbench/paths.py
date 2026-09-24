"""Host configuration and packaged resource locations; never model-authored paths."""

from __future__ import annotations

import os
from pathlib import Path


def resource_root() -> Path:
    source = Path(__file__).resolve().parents[2]
    return (
        source
        if (source / "scripts/worker_mock.py").is_file()
        else Path(__file__).with_name("runtime")
    )


def psi4_prefix(repository: Path) -> Path:
    configured = os.environ.get("CHEM_PSI4_PREFIX")
    return Path(configured).resolve() if configured else repository / ".chem-backends/psi4"
