"""Read-only consistency verification; frozen code is data and is never executed."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from chem_workbench.evaluation import (
    aggregate,
    model_identity,
    score_case,
    source_identity,
    validate_case_id,
    validate_suite,
)
from chem_workbench.visualization import content_hash

MAX_BUNDLE_FILE_BYTES = 32 * 1024 * 1024


def read_json(path: Path):
    if path.is_symlink() or path.resolve().parent != path.parent.resolve():
        raise ValueError("BUNDLE_PATH_ESCAPE")
    with path.open("rb") as stream:
        data = stream.read(MAX_BUNDLE_FILE_BYTES + 1)
    if len(data) > MAX_BUNDLE_FILE_BYTES:
        raise ValueError("BUNDLE_FILE_LIMIT")
    return json.loads(data)


def checked(path: Path, field: str):
    value = read_json(path)
    if not isinstance(value, dict) or content_hash(
        {k: v for k, v in value.items() if k != field}
    ) != value.get(field):
        raise ValueError(f"INTEGRITY_MISMATCH: {path.name}")
    return value


def inspect(directory: Path):
    frozen = checked(directory / "frozen.json", "freeze_hash")
    report = checked(directory / "report.json", "report_hash")
    suite = frozen["suite"]
    if content_hash({k: v for k, v in suite.items() if k != "suite_hash"}) != suite["suite_hash"]:
        raise ValueError("SUITE_MISMATCH")
    if (
        report["freeze_hash"] != frozen["freeze_hash"]
        or report["suite_hash"] != suite["suite_hash"]
    ):
        raise ValueError("BUNDLE_MISMATCH")
    v3 = report.get("version") == "model-evaluation-report/v3"
    if report.get("version") not in {
        None,
        "model-evaluation-report/v2",
        "model-evaluation-report/v3",
    }:
        raise ValueError("UNSUPPORTED_REPORT_VERSION")
    if v3:
        validate_suite(suite)
    snapshot = directory / "code-snapshot.json"
    sources = None
    if snapshot.exists():
        sources = read_json(snapshot)
        if not isinstance(sources, dict) or any(not isinstance(v, str) for v in sources.values()):
            raise ValueError("INVALID_CODE_SNAPSHOT")
        if {k: content_hash(v) for k, v in sources.items()} != frozen["code_identity"]:
            raise ValueError("CODE_SNAPSHOT_MISMATCH")
    elif v3:
        raise ValueError("CODE_SNAPSHOT_MISSING")
    ids = {validate_case_id(case["id"]) for case in suite["cases"]}
    if len(ids) != len(suite["cases"]):
        raise ValueError("DUPLICATE_CASE")
    if not set(report["case_rows"]).issubset(ids):
        raise ValueError("UNKNOWN_CASE")
    if (report["complete"] or v3) and set(report["case_rows"]) != ids:
        raise ValueError("INCOMPLETE_BUNDLE")
    cases = {case["id"]: case for case in suite["cases"]}
    rows = []
    for identifier, expected in report["case_rows"].items():
        validate_case_id(identifier)
        row = checked(directory / (identifier + ".json"), "row_hash")
        if row["row_hash"] != expected or row["id"] != identifier:
            raise ValueError("ROW_MISMATCH")
        record = row.get("record")
        if record and content_hash(
            {k: v for k, v in record.items() if k != "record_hash"}
        ) != record.get("record_hash"):
            raise ValueError("ORCHESTRATION_MISMATCH")
        if v3:
            case = cases[identifier]
            if row["category"] != case["category"] or row["input_identity"] != source_identity(
                case
            ):
                raise ValueError("ROW_SOURCE_MISMATCH")
            frozen_source = frozen["source_snapshots"][identifier]
            if {
                k: frozen_source[k] for k in ("source_hash", "attachment_hashes")
            } != source_identity(case):
                raise ValueError("SOURCE_SNAPSHOT_MISMATCH")
            if not isinstance(row["attempted"], bool) or row["outcome"] not in {
                "completed",
                "error",
                "not_run",
            }:
                raise ValueError("INVALID_ROW_OUTCOME")
            if (
                isinstance(row["seconds"], bool)
                or not isinstance(row["seconds"], (int, float))
                or not math.isfinite(row["seconds"])
                or row["seconds"] < 0
            ):
                raise ValueError("INVALID_ROW_TIMING")
            if (row["outcome"] == "not_run") == row["attempted"]:
                raise ValueError("ROW_ATTEMPT_MISMATCH")
            if not row["attempted"] and (record or row["provider_calls"] or row["seconds"] != 0):
                raise ValueError("UNATTEMPTED_OBSERVATIONS")
            if record:
                context_mismatch = (
                    record.get("source_hash") != frozen_source["source_hash"]
                    or record.get("objective") != case["objective"]
                    or record.get("source_semantic_hash") != frozen_source["semantic_hash"]
                    or model_identity(record.get("model", {})) != frozen["model_identity"]
                )
                if context_mismatch and row.get("error") != "RECORD_CONTEXT_DRIFT":
                    raise ValueError("ORCHESTRATION_CONTEXT_MISMATCH")
                if (
                    record.get("provider_calls") != row["provider_calls"]
                    and row.get("error") != "PROVIDER_OBSERVATION_MISMATCH"
                ):
                    raise ValueError("PROVIDER_OBSERVATION_MISMATCH")
            rows.append(row)
    scores_verified = False
    if v3:
        if frozen["model_identity"] != model_identity(frozen["model"]):
            raise ValueError("MODEL_SNAPSHOT_MISMATCH")
        if set(frozen["oracles"]) != ids or set(frozen["source_snapshots"]) != ids:
            raise ValueError("ORACLE_DENOMINATOR_MISMATCH")
        if report["identity_stable"] and (
            frozen["code_identity"] != report["final_code_identity"]
            or frozen["model_identity"] != model_identity(report["final_model"])
            or any(
                row.get("error") in {"RECORD_CONTEXT_DRIFT", "PROVIDER_OBSERVATION_MISMATCH"}
                for row in rows
            )
        ):
            raise ValueError("FALSE_IDENTITY_STABILITY")
        if report["complete"] != all(row["attempted"] for row in rows):
            raise ValueError("FALSE_COMPLETENESS")
        # Recompute supported v3 scoring only when the frozen scorer matches this verifier.
        # Old bundles remain verifiable without executing their embedded Python snapshots.
        current_scorer = Path(__file__).resolve().parents[1] / "src/chem_workbench/evaluation.py"
        scorer_key = "src/chem_workbench/evaluation.py"
        if sources is not None and sources.get(scorer_key) == current_scorer.read_text(
            encoding="utf-8"
        ):
            for row in rows:
                record = row.get("record")
                score = score_case(
                    cases[row["id"]],
                    record or {"provider_calls": row["provider_calls"]},
                    frozen["oracles"][row["id"]],
                )
                if row["error"] and record:
                    score["passed"] = False
                    score["native_model_success"] = False
                    score["reasons"].append(row["error"])
                if score != row["score"]:
                    raise ValueError("SCORE_MISMATCH")
            scores_verified = True
        summary = aggregate(
            rows,
            complete=report["complete"],
            identity_stable=report["identity_stable"],
            native_metrics=True,
        )
        if any(report.get(k) != value for k, value in summary.items()):
            raise ValueError("AGGREGATE_MISMATCH")
    return {
        "self_consistent": True,
        "cases": len(report["case_rows"]),
        "complete": report["complete"],
        "scores_recomputed": scores_verified,
        "code_snapshot_verified": sources is not None,
        "authenticated": False,
        "promotion_approved": False,
        "scope": "Hash and cross-record consistency; no publisher authentication or human approval",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    print(json.dumps(inspect(parser.parse_args().directory), indent=2))
