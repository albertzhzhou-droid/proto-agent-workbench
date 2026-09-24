"""Freeze direct design oracles before inference, then evaluate matched local models.

Preparation never calls a model. Reuse the same fixtures.json for every model and
repeat, including its exact saved-pair references. Existing evidence is never overwritten.
"""

from __future__ import annotations

import argparse
import contextlib
import copy
import json
import os
import platform
import runpy
import sys
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

from chem_workbench import orchestrator
from chem_workbench.design_evaluation import (
    MAX_SUITE_BYTES,
    aggregate,
    check_hash,
    score_case,
    validate_runtime_manifest,
    validate_suite,
    verify_complex_outputs,
    verify_record,
    workflow_outcomes,
)
from chem_workbench.design_studio import DesignRunError, DesignStudio
from chem_workbench.evaluation import model_identity
from chem_workbench.execution_validation import digest_id
from chem_workbench.visualization import content_hash

ROOT = Path(__file__).resolve().parents[1]
SHARED = runpy.run_path(str(Path(__file__).with_name("run_model_evaluation.py")))
RuntimeObserver = SHARED["RuntimeObserver"]
MAX_EVIDENCE_BYTES = 256 * 1024 * 1024


def code_snapshot(root, *, scoring_version=4):
    """Bind dependency declarations in addition to the existing v4 source/lock boundary."""
    sources = SHARED["code_snapshot"](root, scoring_version=scoring_version)
    path = root / "pyproject.toml"
    if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("DESIGN_CODE_SNAPSHOT_PATH_ESCAPE")
    sources["pyproject.toml"] = path.read_text(encoding="utf-8")
    return sources


def write_new(path, value):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write("\n")


def read_json(path, limit=MAX_EVIDENCE_BYTES):
    with path.open("rb") as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError("DESIGN_EVIDENCE_SIZE_LIMIT")
    value = json.loads(data)
    json.dumps(value, allow_nan=False)
    return value


def code_identity(sources):
    return {name: content_hash(source) for name, source in sources.items()}


def scored_observation(record, calls):
    # A failure outside DesignRunError must still retain independently observed retries/costs.
    return record if record is not None else {"orchestration": {"provider_calls": calls}}


def direct_request(case):
    return {
        "prompt": case["prompt"],
        "study": copy.deepcopy(case["study"]),
        "mode": "direct",
        "decision": copy.deepcopy(case["expected"]["decision"]),
    }


def bind_interface_specifications(setup, record):
    """Fill graph identities only; every numeric value was supplied in the sealed suite."""
    from chem_workbench.interface_mechanisms import mechanism_for_candidate

    specs = []
    for item in setup.get("interface_specifications", []):
        try:
            organic = record["organic"]["candidates"][item["organic_index"]]
            inorganic = record["inorganic"]["candidates"][item["inorganic_index"]]
        except IndexError as error:
            raise ValueError("DESIGN_SETUP_CANDIDATE_INDEX") from error
        spec = copy.deepcopy(item["specification"])
        spec["candidate_hashes"] = {
            "organic": content_hash(organic),
            "inorganic": content_hash(inorganic),
        }
        spec["mechanism"] = mechanism_for_candidate(spec["profile"], organic, inorganic)
        specs.append(spec)
    return specs


def freeze_fixtures(suite, destination, *, root=ROOT):
    """Compute every direct oracle and seal all inputs before any inference."""
    suite = validate_suite(suite)
    sources = code_snapshot(root, scoring_version=4)
    code = code_identity(sources)
    destination.mkdir(parents=True, exist_ok=False)
    studio = DesignStudio(destination / "preparation")
    prepared, oracles, setups, complexity = [], {}, {}, {}
    for original in suite["cases"]:
        case = copy.deepcopy(original)
        setup = case["setup"]
        if setup is not None:
            record = studio.run(
                {
                    "prompt": "Frozen design evaluation candidate preparation.",
                    "study": setup["study"],
                    "decision": setup["decision"],
                    "mode": "direct",
                }
            )
            verify_record(record)
            if record["state"] != "completed" or not verify_complex_outputs(record)["passed"]:
                raise ValueError("DESIGN_SETUP_COMPLEXITY_OR_COMPLETION: " + case["id"])
            case["study"]["selected_candidates"] = {
                "run_ref": record["record_hash"],
                "organic_hash": record["organic"]["candidates"][0]["candidate_hash"],
                "inorganic_hash": record["inorganic"]["candidates"][0]["candidate_hash"],
            }
            if "interface_specifications" in setup:
                case["study"]["interface_parameters"]["specifications"] = (
                    bind_interface_specifications(setup, record)
                )
            setups[record["record_hash"]] = record
        oracle = None
        if case["expected"]["decision"] != {"action": "needs_input"}:
            oracle = studio.run(direct_request(case))
            verify_record(oracle)
            complexity[case["id"]] = verify_complex_outputs(oracle)
            if not workflow_outcomes(oracle, case["expected"]["workflow_outcomes"]):
                raise ValueError("DESIGN_DIRECT_ORACLE_OUTCOMES: " + case["id"])
            if not complexity[case["id"]]["passed"]:
                raise ValueError("DESIGN_DIRECT_ORACLE_COMPLEXITY: " + case["id"])
        oracles[case["id"]] = oracle
        prepared.append(case)
    if code_identity(code_snapshot(root, scoring_version=4)) != code:
        raise ValueError("DESIGN_CODE_CHANGED_DURING_PREPARATION")
    fixtures = {
        "version": "design-model-fixtures/v1",
        "suite": suite,
        "code_identity": code,
        "cases": prepared,
        "oracles": oracles,
        "setup_records": setups,
        "complexity": complexity,
        "inference_performed": False,
        "scope": "Direct registered workflows only; no model or promotion decision",
    }
    fixtures["fixtures_hash"] = content_hash(fixtures)
    write_new(destination / "code-snapshot.json", sources)
    write_new(destination / "fixtures.json", fixtures)
    print(
        json.dumps(
            {
                "fixtures": str(destination / "fixtures.json"),
                "fixtures_hash": fixtures["fixtures_hash"],
                "cases": len(prepared),
                "oracles": len(complexity),
            }
        ),
        flush=True,
    )
    return fixtures


def validate_fixtures(fixtures, sources, *, root=ROOT):
    check_hash(fixtures, "fixtures_hash")
    if fixtures.get("version") != "design-model-fixtures/v1":
        raise ValueError("DESIGN_FIXTURES_VERSION")
    suite = validate_suite(fixtures["suite"])
    if (
        fixtures.get("inference_performed") is not False
        or code_identity(sources) != fixtures.get("code_identity")
        or code_identity(code_snapshot(root, scoring_version=4)) != fixtures["code_identity"]
    ):
        raise ValueError("DESIGN_FIXTURE_CODE_MISMATCH")
    originals = {case["id"]: case for case in suite["cases"]}
    cases = fixtures["cases"]
    if (
        len(cases) != len(originals)
        or [case["id"] for case in cases] != list(originals)
        or set(fixtures["oracles"]) != set(originals)
    ):
        raise ValueError("DESIGN_FIXTURE_DENOMINATOR")
    expected_setup_refs = set()
    for case in cases:
        original = originals[case["id"]]
        expected = copy.deepcopy(original)
        if original["setup"] is not None:
            selection = case["study"]["selected_candidates"]
            ref = selection["run_ref"]
            setup = fixtures["setup_records"][ref]
            verify_record(setup)
            if ref != setup["record_hash"] or setup["request"] != {
                "prompt": "Frozen design evaluation candidate preparation.",
                "study": original["setup"]["study"],
                "decision": original["setup"]["decision"],
                "mode": "direct",
            }:
                raise ValueError("DESIGN_FIXTURE_SETUP_BINDING")
            if (
                selection
                != {
                    "run_ref": ref,
                    "organic_hash": setup["organic"]["candidates"][0]["candidate_hash"],
                    "inorganic_hash": setup["inorganic"]["candidates"][0]["candidate_hash"],
                }
                or not verify_complex_outputs(setup)["passed"]
            ):
                raise ValueError("DESIGN_FIXTURE_PAIR_BINDING")
            expected["study"]["selected_candidates"] = selection
            if "interface_specifications" in original["setup"]:
                expected["study"]["interface_parameters"]["specifications"] = (
                    bind_interface_specifications(original["setup"], setup)
                )
            expected_setup_refs.add(ref)
        if case != expected:
            raise ValueError("DESIGN_FIXTURE_CASE_DRIFT")
        oracle = fixtures["oracles"][case["id"]]
        if case["expected"]["decision"] == {"action": "needs_input"}:
            if oracle is not None:
                raise ValueError("DESIGN_NEGATIVE_ORACLE")
            continue
        verify_record(oracle)
        complexity = verify_complex_outputs(oracle)
        if (
            oracle["request"] != direct_request(case)
            or not workflow_outcomes(oracle, case["expected"]["workflow_outcomes"])
            or not complexity["passed"]
            or fixtures["complexity"].get(case["id"]) != complexity
        ):
            raise ValueError("DESIGN_FIXTURE_ORACLE_BINDING")
    if set(fixtures["setup_records"]) != expected_setup_refs:
        raise ValueError("DESIGN_FIXTURE_UNDECLARED_SETUP")
    return copy.deepcopy(fixtures)


def run_suite(
    fixtures, sources, destination, *, root=ROOT, runtime_manifest=None, observe_runtime=True
):
    fixtures = validate_fixtures(fixtures, sources, root=root)
    suite, cases, code = fixtures["suite"], fixtures["cases"], fixtures["code_identity"]
    model = copy.deepcopy(orchestrator.model_status())
    if not model.get("available"):
        raise RuntimeError("DESIGN_MODEL_UNAVAILABLE: " + str(model.get("message")))
    if runtime_manifest is not None:
        validate_runtime_manifest(runtime_manifest, suite["suite_hash"])
        if runtime_manifest.get("code_identity") != code:
            raise ValueError("DESIGN_RUNTIME_CODE_BINDING")
        if runtime_manifest.get("suite_hash") != suite["suite_hash"]:
            raise ValueError("DESIGN_RUNTIME_SUITE_BINDING")
    destination.mkdir(parents=True, exist_ok=False)
    studio = DesignStudio(destination / "workspace")
    for ref, record in fixtures["setup_records"].items():
        write_new(studio.directory / (digest_id(ref) + ".json"), record)
    frozen = {
        "version": "design-model-freeze/v1",
        "frozen_at_utc": datetime.now(UTC).isoformat(),
        "run_id": uuid.uuid4().hex,
        "fixtures_hash": fixtures["fixtures_hash"],
        "suite_hash": suite["suite_hash"],
        "model": model,
        "model_identity": model_identity(model),
        "code_identity": code,
        "runtime_manifest": runtime_manifest,
        "hardware_accounting": {
            "host": platform.node(),
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "processor": platform.processor(),
            "logical_cpu_count": os.cpu_count(),
        },
        "runtime_observation_policy": {
            "enabled": observe_runtime,
            "sampling_interval_seconds": 1.0,
            "allowed_controller_endpoint": "127.0.0.1:1234",
            "scope": "Python controller process; not an operating-system sandbox",
        },
        "execution_authority": False,
    }
    frozen["freeze_hash"] = content_hash(frozen)
    write_new(destination / "fixtures.json", fixtures)
    write_new(destination / "code-snapshot.json", sources)
    write_new(destination / "frozen.json", frozen)
    print("Frozen before inference: " + str(destination), flush=True)
    rows, stable, stop_reason, failures = [], True, None, 0

    def observe_identity():
        return code_identity(code_snapshot(root, scoring_version=4)), orchestrator.model_status()

    for case in cases:
        if stop_reason is None:
            try:
                current_code, current_model = observe_identity()
                if current_code != code or model_identity(current_model) != model_identity(model):
                    stable, stop_reason = False, "DESIGN_IDENTITY_DRIFT"
            except (OSError, ValueError, RuntimeError) as error:
                stable, stop_reason = False, "DESIGN_IDENTITY_UNOBSERVED: " + str(error)
        started = time.monotonic()
        attempted, record, observation = stop_reason is None, None, None
        error, calls = stop_reason, []
        if attempted:
            orchestrator.MODEL_METRICS.calls = []
            observer = RuntimeObserver() if observe_runtime else None
            try:
                with observer if observer is not None else contextlib.nullcontext():
                    record = studio.run(
                        {
                            "prompt": case["prompt"],
                            "study": case["study"],
                            "mode": "model",
                            "decision": None,
                        }
                    )
                failures = 0
            except DesignRunError as failure:
                record = failure.record
                error = str(failure)
                failures = failures + 1 if record.get("error", {}).get("phase") == "routing" else 0
            except (OSError, ValueError, TypeError, KeyError, RuntimeError) as failure:
                error = type(failure).__name__ + ": " + str(failure)
                failures += 1
            finally:
                calls = copy.deepcopy(orchestrator.MODEL_METRICS.calls)
                if observer is not None and observer.started is not None:
                    observation = observer.report()
            if record is not None:
                routing = record.get("orchestration") or {}
                if routing.get("provider_calls") != calls or model_identity(
                    routing.get("model") or {}
                ) != model_identity(model):
                    error = "DESIGN_PROVIDER_OBSERVATION_MISMATCH"
                    stable, stop_reason = False, error
        score = score_case(case, scored_observation(record, calls), fixtures["oracles"][case["id"]])
        if error:
            for field in ("passed", "native_first_attempt_success", "sampled_correct_abstention"):
                score[field] = False
        row = {
            "version": "design-model-row/v1",
            "id": case["id"],
            "family": case["family"],
            "module_family": case["module_family"],
            "attempted": attempted,
            "outcome": "not_run" if not attempted else "error" if error else "completed",
            "case_hash": content_hash(case),
            "fixtures_hash": fixtures["fixtures_hash"],
            "freeze_hash": frozen["freeze_hash"],
            "score": score,
            "record": record,
            "provider_calls": calls,
            "runtime_observations": observation,
            "error": error,
            "seconds": round(time.monotonic() - started, 6) if attempted else 0,
        }
        row["row_hash"] = content_hash(row)
        write_new(destination / (case["id"] + ".json"), row)
        rows.append(row)
        print(
            json.dumps(
                {
                    "id": case["id"],
                    "passed": score["passed"],
                    "outcome": row["outcome"],
                    "seconds": row["seconds"],
                }
            ),
            flush=True,
        )
        if failures >= 3 and stop_reason is None:
            stop_reason = "DESIGN_PROVIDER_FAILURE_BREAKER"
    try:
        final_code, final_model = observe_identity()
        stable = (
            stable and final_code == code and model_identity(final_model) == model_identity(model)
        )
    except (OSError, ValueError, RuntimeError) as error:
        final_code, final_model, stable = None, {"error": str(error)}, False
    summary = aggregate(
        rows,
        suite,
        complete=all(row["attempted"] for row in rows),
        identity_stable=stable,
        runtime_manifest=runtime_manifest,
    )
    report = {
        **summary,
        "version": "design-model-report/v1",
        "completed_at_utc": datetime.now(UTC).isoformat(),
        "freeze_hash": frozen["freeze_hash"],
        "fixtures_hash": fixtures["fixtures_hash"],
        "suite_hash": suite["suite_hash"],
        "case_rows": {r["id"]: r["row_hash"] for r in rows},
        "final_code_identity": final_code,
        "final_model": final_model,
        "stop_reason": stop_reason,
    }
    report["report_hash"] = content_hash(report)
    write_new(destination / "report.json", report)
    print(
        json.dumps(
            {
                "report": str(destination / "report.json"),
                "metrics": report["metrics"],
                "complete": report["complete"],
                "identity_stable": stable,
            }
        ),
        flush=True,
    )
    return report


def inspect_run(directory, *, root=ROOT):
    """Recompute every score and binding from immutable evidence without inference."""
    fixtures = read_json(directory / "fixtures.json")
    check_hash(fixtures, "fixtures_hash")
    sources = read_json(directory / "code-snapshot.json")
    validate_fixtures(fixtures, sources, root=root)
    frozen = check_hash(read_json(directory / "frozen.json"), "freeze_hash")
    report = check_hash(read_json(directory / "report.json"), "report_hash")
    if (
        frozen["fixtures_hash"] != fixtures["fixtures_hash"]
        or report["fixtures_hash"] != fixtures["fixtures_hash"]
        or report["freeze_hash"] != frozen["freeze_hash"]
        or frozen["code_identity"] != fixtures["code_identity"]
        or frozen["suite_hash"] != fixtures["suite"]["suite_hash"]
        or report["suite_hash"] != frozen["suite_hash"]
        or frozen["model_identity"] != model_identity(frozen["model"])
    ):
        raise ValueError("DESIGN_RUN_FREEZE_BINDING")
    if report["identity_stable"] and (
        report["final_code_identity"] != frozen["code_identity"]
        or model_identity(report["final_model"]) != frozen["model_identity"]
    ):
        raise ValueError("DESIGN_REPORTED_IDENTITY_DRIFT")
    if frozen["runtime_manifest"] is not None:
        validate_runtime_manifest(frozen["runtime_manifest"], frozen["suite_hash"])
        if frozen["runtime_manifest"].get("code_identity") != frozen["code_identity"]:
            raise ValueError("DESIGN_RUNTIME_CODE_BINDING")
    rows = []
    for case in fixtures["cases"]:
        row = check_hash(read_json(directory / (case["id"] + ".json")), "row_hash")
        if (
            row["id"] != case["id"]
            or row["case_hash"] != content_hash(case)
            or row["fixtures_hash"] != fixtures["fixtures_hash"]
            or row["freeze_hash"] != frozen["freeze_hash"]
            or report["case_rows"].get(case["id"]) != row["row_hash"]
        ):
            raise ValueError("DESIGN_ROW_BINDING")
        score = score_case(
            case,
            scored_observation(row["record"], row["provider_calls"]),
            fixtures["oracles"][case["id"]],
        )
        if row["error"]:
            for field in ("passed", "native_first_attempt_success", "sampled_correct_abstention"):
                score[field] = False
        if score != row["score"]:
            raise ValueError("DESIGN_SCORE_REPLAY_MISMATCH")
        if row["record"] is not None and row["provider_calls"] != (
            row["record"].get("orchestration") or {}
        ).get("provider_calls"):
            raise ValueError("DESIGN_RAW_CALL_REPLAY_MISMATCH")
        if row["record"] is not None and report["identity_stable"]:
            observed_model = (row["record"].get("orchestration") or {}).get("model") or {}
            if model_identity(observed_model) != frozen["model_identity"]:
                raise ValueError("DESIGN_ROW_MODEL_IDENTITY_MISMATCH")
        rows.append(row)
    if len(report["case_rows"]) != len(rows):
        raise ValueError("DESIGN_REPORT_DENOMINATOR")
    summary = aggregate(
        rows,
        fixtures["suite"],
        complete=all(row["attempted"] for row in rows),
        identity_stable=report["identity_stable"],
        runtime_manifest=frozen["runtime_manifest"],
    )
    if any(report.get(key) != value for key, value in summary.items() if key != "version"):
        raise ValueError("DESIGN_SUMMARY_REPLAY_MISMATCH")
    return {
        "verified": True,
        "report_hash": report["report_hash"],
        "cases": len(rows),
        "scope": "Artifact consistency and score replay; not file signing or model promotion",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", type=Path)
    parser.add_argument("--freeze-only", action="store_true")
    parser.add_argument("--fixtures", type=Path)
    parser.add_argument("--inspect", type=Path)
    parser.add_argument("--runtime-manifest", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--model", choices=sorted(orchestrator.ALLOWED_MODEL_KEYS), default=orchestrator.MODEL_KEY
    )
    parser.add_argument("--observe-runtime", action=argparse.BooleanOptionalAction, default=True)
    args = parser.parse_args()
    if args.inspect:
        if args.freeze_only or args.suite or args.fixtures or args.output:
            parser.error("--inspect is a separate read-only mode")
        print(json.dumps(inspect_run(args.inspect), indent=2))
        return 0
    if args.freeze_only:
        if not args.suite or args.fixtures or args.runtime_manifest or not args.output:
            parser.error("--freeze-only requires --suite and --output only")
        freeze_fixtures(read_json(args.suite, MAX_SUITE_BYTES), args.output)
        return 0
    if not args.fixtures or args.suite:
        parser.error("Inference requires precomputed --fixtures; use --freeze-only first")
    os.environ["CHEM_MODEL_KEY"] = args.model
    report = run_suite(
        read_json(args.fixtures),
        read_json(args.fixtures.parent / "code-snapshot.json"),
        args.output or ROOT / "build/design-evaluations" / uuid.uuid4().hex,
        runtime_manifest=read_json(args.runtime_manifest) if args.runtime_manifest else None,
        observe_runtime=args.observe_runtime,
    )
    # Exit zero certifies these local checks only. Full promotion remains a separate assessment.
    return 0 if report["local_acceptance_checks_passed"] else 2


if __name__ == "__main__":
    sys.exit(main())
