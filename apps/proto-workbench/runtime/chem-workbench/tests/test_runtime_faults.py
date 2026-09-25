"""Exercise the independent fault harness using development molecules only."""

import runpy
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
RUN = runpy.run_path(str(ROOT / "scripts/verify_model_runtime_faults.py"))["run_case"]


@pytest.mark.parametrize(
    "fault,mode,outcome,model_calls,tool_calls",
    [
        ("provider_unavailable", "persistent", "rejected_without_tool", 0, 0),
        ("provider_timeout", "persistent", "rejected_without_tool", 1, 0),
        ("malformed_json", "once", "completed_after_repair", 3, 1),
        ("malformed_json", "persistent", "rejected_without_tool", 3, 0),
        ("truncated_response", "once", "completed_after_repair", 3, 1),
        ("truncated_response", "persistent", "rejected_without_tool", 3, 0),
        ("unknown_tool", "once", "completed_after_repair", 3, 1),
        ("extra_argument", "persistent", "rejected_without_tool", 3, 0),
        ("foreign_target", "persistent", "rejected_without_tool", 2, 0),
        ("unsupported_profile", "persistent", "rejected_without_tool", 2, 0),
        ("tool_rejection", "persistent", "tool_rejected", 2, 1),
        ("cancelled_job", "once", "cancellation_requested", 0, 0),
        ("stale_approval", "once", "job_blocked", 0, 0),
    ],
)
def test_fault_contract(fault, mode, outcome, model_calls, tool_calls, tmp_path):
    action = {"action": "plan_molecular_single_point", "object_id": "caffeine", "scale_factors": []}
    case = {
        "id": "development-fault",
        "family": "tool_runtime_failures",
        "fault": {"kind": fault, "mode": mode},
        "objective": "Prepare source-generated caffeine HF/STO-3G single point for review.",
        "source": (ROOT / "examples/molecules/caffeine.chem").read_text(),
        "attachments": {},
        "clean_action": action,
        "expected": {
            "outcome": outcome,
            "max_model_calls": model_calls,
            "max_tool_calls": tool_calls,
        },
    }
    result = RUN(case, tmp_path)
    assert result["passed"], result
    assert len(result["provider_calls"]) == model_calls
    assert len(result["tool_dispatches"]) == tool_calls
    assert result["calculator_launches"] == []
    assert result["live_model_calls"] == 0
