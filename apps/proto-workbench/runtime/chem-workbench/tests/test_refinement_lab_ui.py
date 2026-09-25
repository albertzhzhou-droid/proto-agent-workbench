"""Offline DOM/renderer contracts using synthetic validated records; no scientific compute."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from test_molecular_refinement import _body, _evaluation_series, _geometry, _spec

from chem_workbench.molecular_refinement import seal_refinement_result
from chem_workbench.refinement_visualization import build_refinement_view


def test_refinement_lab_dom_viewer_precision_and_lifecycle(tmp_path: Path) -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is required for offline frontend contracts")
    spec = _spec(_geometry("-0.1234567890123456789012345"))
    body = _body(spec, attribution=False)
    fixtures = {
        "precise": build_refinement_view(spec, seal_refinement_result(spec, body)),
    }
    body["state"] = "failed"
    body["failure"] = {
        "phase": "gradient",
        "code": "SYNTHETIC_SCF_FAILED",
        "message": "Synthetic failure <script>must remain text</script>",
        "last_evaluated_frame_hash": body["final_frame_hash"],
        "artifact_id": "failure",
    }
    body["raw_artifacts"].append(
        {
            "artifact_id": "failure",
            "role": "failure",
            "path": "fixture/failure.json",
            "sha256": "a" * 64,
        }
    )
    fixtures["failure"] = build_refinement_view(spec, seal_refinement_result(spec, body))
    body = _body(spec, attribution=False)
    body["trajectory"] = []
    body["final_frame_hash"] = None
    body["raw_artifacts"] = []
    body["timing"]["backend_attempts_observed"] = 0
    fixtures["empty"] = build_refinement_view(spec, seal_refinement_result(spec, body))
    spec = _spec()
    fixtures["success"] = build_refinement_view(spec, seal_refinement_result(spec, _body(spec)))
    body = _evaluation_series(
        spec,
        [
            ("0", "0", 0, "initial", None),
            ("0.1", "0", 1, "accepted", None),
            ("0.2", "0.1", 2, "rejected", None),
            ("0.1", "0", 1, "reevaluation", 1),
        ],
        "not_satisfied",
    )
    fixtures["reevaluation"] = build_refinement_view(spec, seal_refinement_result(spec, body))
    fixture = tmp_path / "synthetic-refinement-views.json"
    fixture.write_text(json.dumps(fixtures), encoding="utf-8")
    root = Path(__file__).resolve().parents[1]
    completed = subprocess.run(
        [node, str(root / "tests/refinement_lab.test.cjs"), str(fixture)],
        text=True,
        capture_output=True,
        cwd=root,
        timeout=45,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
