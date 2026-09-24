"""Supplemental, read-only comparison of immutable v3 model evaluation bundles.

The original v3 repaired_success cohort only includes rows with record.repairs.
A controller exception may leave record=None after two observed provider calls.
This supplement derives the retry cohort from those calls without rewriting v3.
"""

from __future__ import annotations

import argparse
import json
import runpy
from pathlib import Path
from typing import Any

from chem_workbench.visualization import content_hash

INSPECTOR = Path(__file__).with_name("inspect_model_evaluation.py")


def _rate(passed: int, total: int) -> dict[str, Any]:
    return {"passed": passed, "total": total, "rate": passed / total if total else None}


def summarize_retry_observations(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Count observed retries, including failed attempts with no final record."""
    retried = [row for row in rows if len(row.get("provider_calls", [])) > 1]
    retry_details = []
    for row in retried:
        calls = row["provider_calls"]
        score = row["score"]
        native_success = (
            score.get("native_model_success") is True
            and score.get("passed") is True
            and row.get("outcome") == "completed"
            and row.get("error") is None
            and row.get("record") is not None
        )
        retry_details.append(
            {
                "id": row["id"],
                "row_hash": row.get("row_hash"),
                "provider_attempts": len(calls),
                "observed_retry_calls": len(calls) - 1,
                "native_success": native_success,
                "host_workflow_success": score.get("passed") is True
                and row.get("record") is not None,
                "record_present": row.get("record") is not None,
                "final_outcome": row.get("outcome"),
                "error": row.get("error"),
                "schema_observations": [call.get("schema_valid") for call in calls],
                "call_outcomes": [call.get("outcome") for call in calls],
            }
        )
    attempted = [row for row in rows if row.get("attempted") is True]
    observed = [row for row in rows if row.get("provider_calls")]
    return {
        "cohort_rule": (
            "At least two observed provider calls in the same case; no record.repairs requirement"
        ),
        "native_success_after_observed_retry": _rate(
            sum(item["native_success"] for item in retry_details), len(retried)
        ),
        "host_success_after_observed_retry": _rate(
            sum(item["host_workflow_success"] for item in retry_details), len(retried)
        ),
        "retry_calls_observed": sum(item["observed_retry_calls"] for item in retry_details),
        "retry_cases_without_final_record": sum(
            not item["record_present"] for item in retry_details
        ),
        "retry_cases": retry_details,
        "observation_coverage": {
            "suite_cases": len(rows),
            "attempted_cases": len(attempted),
            "unattempted_cases": sum(row.get("attempted") is False for row in rows),
            "cases_with_provider_calls": len(observed),
            "attempted_cases_without_provider_observations": sum(
                not row.get("provider_calls") for row in attempted
            ),
            "cases_with_unknown_first_schema": sum(
                row["provider_calls"][0].get("schema_valid") is None for row in observed
            ),
            "provider_calls": sum(len(row.get("provider_calls", [])) for row in rows),
            "native_result_unknown_cases": sum(
                row["score"].get("native_model_success") is None for row in rows
            ),
            "repair_intent_without_observed_retry": sum(
                bool((row.get("record") or {}).get("repairs"))
                and len(row.get("provider_calls", [])) < 2
                for row in rows
            ),
        },
        "interpretation": (
            "Unknown or absent observations are reported separately; "
            "no retry is inferred from a final record alone"
        ),
    }


def load_bundle(directory: Path) -> dict[str, Any]:
    """Reopen using the established verifier and bind every summary row to its report."""
    inspector = runpy.run_path(str(INSPECTOR))
    checked = inspector["checked"]
    frozen = checked(directory / "frozen.json", "freeze_hash")
    report = checked(directory / "report.json", "report_hash")
    if report.get("version") != "model-evaluation-report/v3":
        raise ValueError("COMPARISON_REQUIRES_V3")
    verification = inspector["inspect"](directory)
    if not verification["scores_recomputed"] or not verification["code_snapshot_verified"]:
        raise ValueError("COMPARISON_SCORES_NOT_RECOMPUTED")
    rows = []
    for identifier, digest in report["case_rows"].items():
        row = checked(directory / (identifier + ".json"), "row_hash")
        if row["id"] != identifier or row["row_hash"] != digest:
            raise ValueError("COMPARISON_ROW_CHANGED")
        rows.append(row)
    if (
        checked(directory / "frozen.json", "freeze_hash") != frozen
        or checked(directory / "report.json", "report_hash") != report
    ):
        raise ValueError("COMPARISON_INPUT_CHANGED")
    return {
        "directory": str(directory.resolve()),
        "frozen": frozen,
        "report": report,
        "rows": rows,
        "verification": verification,
    }


def compare(left: Path, right: Path) -> dict[str, Any]:
    bundles = [load_bundle(left), load_bundle(right)]
    first, second = (bundle["frozen"] for bundle in bundles)
    for field in ("suite", "code_identity", "oracles", "source_snapshots"):
        if first[field] != second[field]:
            raise ValueError("COMPARISON_MISMATCH: " + field)
    comparison = {
        "version": "model-evaluation-comparison-supplement/v1",
        "suite_hash": first["suite"]["suite_hash"],
        "shared_code_identity_hash": content_hash(first["code_identity"]),
        "shared_oracles_hash": content_hash(first["oracles"]),
        "shared_source_snapshots_hash": content_hash(first["source_snapshots"]),
        "comparison_script_hash": content_hash(Path(__file__).read_text(encoding="utf-8")),
        "comparable_inputs_verified": True,
        "complete_and_stable": all(
            bundle["report"]["complete"] and bundle["report"]["identity_stable"]
            for bundle in bundles
        ),
        "runs": [],
        "supplement_reason": (
            "Immutable v3 repaired_success/native_repaired_success aggregate cohorts rely on "
            "record.repairs and can omit failed retry cases with record=null. The observed-retry "
            "cohort below includes every case with at least two retained provider calls. "
            "Original v3 metrics are retained under original_v3_metrics, never silently corrected."
        ),
        "authenticated": False,
        "promotion_approved": False,
        "independent_human_review": "pending",
    }
    for bundle in bundles:
        frozen, report = bundle["frozen"], bundle["report"]
        comparison["runs"].append(
            {
                "directory": bundle["directory"],
                "model": frozen["model_identity"],
                "freeze_hash": frozen["freeze_hash"],
                "report_hash": report["report_hash"],
                "verification": bundle["verification"],
                "original_v3_metrics": report["metrics"],
                "original_v3_measured_thresholds_passed": report["measured_thresholds_passed"],
                "latency_seconds": report["latency_seconds"],
                "tokens": report["tokens"],
                "supplemental_retry_metrics": summarize_retry_observations(bundle["rows"]),
            }
        )
    comparison["comparison_hash"] = content_hash(comparison)
    return comparison


def write_comparison(output: Path, comparison: dict[str, Any]) -> None:
    resolved = output.resolve()
    if any(resolved.is_relative_to(Path(run["directory"]).resolve()) for run in comparison["runs"]):
        raise ValueError("OUTPUT_INSIDE_IMMUTABLE_BUNDLE")
    with output.open("x", encoding="utf-8") as stream:
        json.dump(comparison, stream, indent=2, allow_nan=False)
        stream.write("\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("left", type=Path)
    parser.add_argument("right", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    comparison = compare(args.left, args.right)
    write_comparison(args.output, comparison)
    print(
        json.dumps(
            {
                "output": str(args.output.resolve()),
                "comparison_hash": comparison["comparison_hash"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
