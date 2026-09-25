"""Shipped Design UI with a real projection of synthetic 34-atom pipeline output.

All energies, gradients and transport responses are synthetic. No native runtime,
server, model, operating-system worker or electronic calculation is invoked.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from test_refinement_execution_pipeline import SyntheticPipeline

from chem_workbench.molecular_refinement import seal_refinement_result
from chem_workbench.refinement_visualization import build_refinement_view


def test_design_refinement_workflow_ui(tmp_path: Path) -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is required for the shipped UI interaction check")
    pipeline = SyntheticPipeline(tmp_path)
    pipeline.execute()
    assert len(pipeline.spec["geometry"]["atoms"]) == 34
    # The recorder exercised by the pure fixture emits its production envelope.
    # Reseal a detached UI fixture with explicit synthetic origin before display.
    body = {key: value for key, value in pipeline.result.items() if key != "result_hash"}
    body["evidence_origin"] = "synthetic_validation"
    scientific = seal_refinement_result(pipeline.spec, body)
    view = build_refinement_view(pipeline.spec, scientific)
    assert view["evidence_origin"] == "synthetic_validation"
    assert view["state"] == "incomplete"
    fixture = tmp_path / "ui-fixture.json"
    fixture.write_text(
        json.dumps(
            {"spec": pipeline.spec, "scientific_result": scientific, "view": view},
            allow_nan=False,
        ),
        encoding="utf-8",
    )
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [node, str(root / "scripts/verify_refinement_workflow_ui.cjs"), str(fixture)],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "Design refinement UI: " in result.stdout
    assert "No native calculations or model requests." in result.stdout
