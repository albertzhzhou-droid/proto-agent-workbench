"""Verify V4 bundles without executing frozen code; preserve V2/V3 verifier behavior."""

from __future__ import annotations

import argparse
import json
import math
import runpy
from pathlib import Path

from chem_workbench.evaluation import (
    aggregate_v4,
    model_identity,
    score_case_v4,
    source_identity,
    validate_case_id,
    validate_suite,
)
from chem_workbench.visualization import content_hash

LEGACY = runpy.run_path(str(Path(__file__).with_name("inspect_model_evaluation.py")))
checked = LEGACY["checked"]
read_json = LEGACY["read_json"]


def inspect(directory: Path):
    frozen = checked(directory / "frozen.json", "freeze_hash")
    report = checked(directory / "report.json", "report_hash")
    if report.get("version") != "model-evaluation-report/v4":
        return LEGACY["inspect"](directory)
    if frozen.get("version") != "model-evaluation-freeze/v4":
        raise ValueError("FREEZE_VERSION_MISMATCH")
    suite = validate_suite(frozen["suite"])
    if (
        report["freeze_hash"] != frozen["freeze_hash"]
        or report["suite_hash"] != suite["suite_hash"]
    ):
        raise ValueError("BUNDLE_MISMATCH")
    sources = read_json(directory / "code-snapshot.json")
    if not isinstance(sources, dict) or any(
        not isinstance(value, str) for value in sources.values()
    ):
        raise ValueError("INVALID_CODE_SNAPSHOT")
    if {key: content_hash(value) for key, value in sources.items()} != frozen["code_identity"]:
        raise ValueError("CODE_SNAPSHOT_MISMATCH")
    cases = {case["id"]: case for case in suite["cases"]}
    ids = set(cases)
    if (
        set(report["case_rows"]) != ids
        or set(frozen["oracles"]) != ids
        or set(frozen["source_snapshots"]) != ids
    ):
        raise ValueError("INCOMPLETE_BUNDLE")
    if frozen["model_identity"] != model_identity(frozen["model"]):
        raise ValueError("MODEL_SNAPSHOT_MISMATCH")
    scorer_key = "src/chem_workbench/evaluation.py"
    scorer = Path(__file__).resolve().parents[1] / scorer_key
    scores_verified = sources.get(scorer_key) == scorer.read_text(encoding="utf-8")
    rows = []
    for identifier, digest in report["case_rows"].items():
        validate_case_id(identifier)
        row = checked(directory / (identifier + ".json"), "row_hash")
        case = cases[identifier]
        if row["row_hash"] != digest or row["id"] != identifier:
            raise ValueError("ROW_MISMATCH")
        if (
            row["category"] != case["category"]
            or row["family"] != case.get("family")
            or row["input_identity"] != source_identity(case)
        ):
            raise ValueError("ROW_SOURCE_MISMATCH")
        frozen_source = frozen["source_snapshots"][identifier]
        if {
            key: frozen_source[key] for key in ("source_hash", "attachment_hashes")
        } != source_identity(case):
            raise ValueError("SOURCE_SNAPSHOT_MISMATCH")
        if not isinstance(row["attempted"], bool) or row["outcome"] not in {
            "completed",
            "error",
            "not_run",
        }:
            raise ValueError("INVALID_ROW_OUTCOME")
        if (row["outcome"] == "not_run") == row["attempted"]:
            raise ValueError("ROW_ATTEMPT_MISMATCH")
        if (
            isinstance(row["seconds"], bool)
            or not isinstance(row["seconds"], (float, int))
            or not math.isfinite(row["seconds"])
            or row["seconds"] < 0
        ):
            raise ValueError("INVALID_ROW_TIMING")
        record = row.get("record")
        if not row["attempted"] and (record or row["provider_calls"] or row["seconds"]):
            raise ValueError("UNATTEMPTED_OBSERVATIONS")
        if record:
            if content_hash(
                {key: value for key, value in record.items() if key != "record_hash"}
            ) != record.get("record_hash"):
                raise ValueError("ORCHESTRATION_MISMATCH")
            mismatch = (
                record.get("source_hash") != frozen_source["source_hash"]
                or record.get("source_semantic_hash") != frozen_source["semantic_hash"]
                or record.get("objective") != case["objective"]
                or model_identity(record.get("model", {})) != frozen["model_identity"]
            )
            if mismatch and row.get("error") != "RECORD_CONTEXT_DRIFT":
                raise ValueError("ORCHESTRATION_CONTEXT_MISMATCH")
            if (
                record.get("provider_calls") != row["provider_calls"]
                and row.get("error") != "PROVIDER_OBSERVATION_MISMATCH"
            ):
                raise ValueError("PROVIDER_OBSERVATION_MISMATCH")
        if scores_verified:
            score = score_case_v4(
                case,
                record or {"provider_calls": row["provider_calls"]},
                frozen["oracles"][identifier],
            )
            if row["error"] and record:
                for key in (
                    "passed",
                    "native_model_success",
                    "native_first_attempt_success",
                    "reviewed_model_success",
                    "reviewed_model_abstention",
                    "host_workflow_success",
                    "repaired_success",
                ):
                    score[key] = False
                score["reasons"].append(row["error"])
            if row["score"] != score:
                raise ValueError("SCORE_MISMATCH")
        rows.append(row)
    if report["complete"] != all(row["attempted"] for row in rows):
        raise ValueError("FALSE_COMPLETENESS")
    if report["identity_stable"] and (
        frozen["code_identity"] != report["final_code_identity"]
        or frozen["model_identity"] != model_identity(report["final_model"])
        or any(
            row.get("error") in {"RECORD_CONTEXT_DRIFT", "PROVIDER_OBSERVATION_MISMATCH"}
            for row in rows
        )
    ):
        raise ValueError("FALSE_IDENTITY_STABILITY")
    summary = aggregate_v4(
        rows,
        complete=report["complete"],
        identity_stable=report["identity_stable"],
        cases=suite["cases"],
        runtime_manifest=frozen.get("runtime_manifest"),
    )
    if any(report.get(key) != value for key, value in summary.items()):
        raise ValueError("AGGREGATE_MISMATCH")
    return {
        "self_consistent": True,
        "cases": len(rows),
        "complete": report["complete"],
        "scores_recomputed": scores_verified,
        "code_snapshot_verified": True,
        "authenticated": False,
        "promotion_approved": False,
        "scope": "Bundle consistency only; full promotion requires separate original-gate evidence",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    print(json.dumps(inspect(parser.parse_args().directory), indent=2))
