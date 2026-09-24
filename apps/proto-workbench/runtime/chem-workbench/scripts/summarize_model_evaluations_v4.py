"""Compare immutable V4 runs and report descriptive variation across actual repeats."""

from __future__ import annotations

import argparse
import json
import runpy
import statistics
from pathlib import Path

from chem_workbench.visualization import content_hash

INSPECTOR = runpy.run_path(str(Path(__file__).with_name("inspect_model_evaluation_v4.py")))


def summarize(directories):
    if len(directories) < 2 or len(directories) != len({path.resolve() for path in directories}):
        raise ValueError("DISTINCT_EVALUATION_RUNS_REQUIRED")
    bundles = []
    run_ids = set()
    for directory in directories:
        verification = INSPECTOR["inspect"](directory)
        if not verification["scores_recomputed"]:
            raise ValueError("REPEAT_SCORES_NOT_RECOMPUTED")
        frozen = INSPECTOR["checked"](directory / "frozen.json", "freeze_hash")
        report = INSPECTOR["checked"](directory / "report.json", "report_hash")
        if report.get("version") != "model-evaluation-report/v4":
            raise ValueError("REPEATS_REQUIRE_V4")
        run_id = frozen.get("run_id")
        if not isinstance(run_id, str) or not run_id or run_id in run_ids:
            raise ValueError("DISTINCT_RUN_IDENTITIES_REQUIRED")
        run_ids.add(run_id)
        bundles.append(
            {
                "directory": str(directory.resolve()),
                "frozen": frozen,
                "report": report,
                "verification": verification,
            }
        )
    first = bundles[0]["frozen"]
    for bundle in bundles[1:]:
        for field in (
            "suite",
            "code_identity",
            "source_snapshots",
            "oracles",
            "runtime_manifest",
            "hardware_accounting",
            "complexity_verification",
            "runtime_observation_policy",
        ):
            if bundle["frozen"].get(field) != first.get(field):
                raise ValueError("EVALUATION_COMPARISON_MISMATCH: " + field)
    groups = {}
    for bundle in bundles:
        identity_hash = content_hash(bundle["frozen"]["model_identity"])
        groups.setdefault(identity_hash, []).append(bundle)
    models = []
    for identity_hash, group in groups.items():
        metrics = {}
        for name in group[0]["report"]["metrics"]:
            observed = [bundle["report"]["metrics"][name] for bundle in group]
            rates = [metric["rate"] for metric in observed if metric["rate"] is not None]
            metrics[name] = {
                "runs": observed,
                "mean_rate": statistics.mean(rates) if rates else None,
                "minimum_rate": min(rates) if rates else None,
                "maximum_rate": max(rates) if rates else None,
                "sample_standard_deviation": statistics.stdev(rates) if len(rates) > 1 else None,
                "total_passed_observations": sum(metric["passed"] for metric in observed),
                "total_observations": sum(metric["total"] for metric in observed),
            }
        models.append(
            {
                "model_identity_hash": identity_hash,
                "model_identity": group[0]["frozen"]["model_identity"],
                "runs": [
                    {
                        "directory": bundle["directory"],
                        "run_id": bundle["frozen"]["run_id"],
                        "report_hash": bundle["report"]["report_hash"],
                        "freeze_hash": bundle["frozen"]["freeze_hash"],
                        "complete": bundle["report"]["complete"],
                        "identity_stable": bundle["report"]["identity_stable"],
                        "latency_seconds": bundle["report"]["latency_seconds"],
                        "model_seconds": bundle["report"]["model_seconds"],
                        "tool_seconds": bundle["report"]["tool_seconds"],
                        "tokens": bundle["report"]["tokens"],
                    }
                    for bundle in group
                ],
                "run_count": len(group),
                "repeats_observed": len(group) >= 2,
                "all_measured_thresholds_passed": all(
                    bundle["report"]["measured_thresholds_passed"] for bundle in group
                ),
                "metrics": metrics,
            }
        )
    result = {
        "version": "model-evaluation-repeats-comparison/v1",
        "suite_hash": first["suite"]["suite_hash"],
        "shared_code_identity_hash": content_hash(first["code_identity"]),
        "shared_oracles_hash": content_hash(first["oracles"]),
        "matched_inputs_verified": True,
        "distinct_model_configurations": len(models),
        "complete_and_stable": all(
            bundle["report"]["complete"] and bundle["report"]["identity_stable"]
            for bundle in bundles
        ),
        "all_model_configurations_repeated": all(model["repeats_observed"] for model in models),
        "models": models,
        "scope": "Descriptive variation on repeated correlated scenarios; "
        "repeated trials are not independent new tasks",
        "promotion_approved": False,
        "execution_authority": False,
    }
    result["comparison_hash"] = content_hash(result)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directories", type=Path, nargs="+")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = summarize(args.directories)
    if any(
        args.output.resolve().is_relative_to(directory.resolve()) for directory in args.directories
    ):
        raise ValueError("OUTPUT_INSIDE_IMMUTABLE_BUNDLE")
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, indent=2, allow_nan=False)
        stream.write("\n")
    print(json.dumps(result, indent=2))
