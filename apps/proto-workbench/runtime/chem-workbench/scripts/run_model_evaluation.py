"""Freeze embedded fixtures and oracle results before inference; keep every denominator."""

from __future__ import annotations

import argparse
import contextlib
import copy
import hashlib
import json
import os
import platform
import runpy
import sys
import time
import uuid
from pathlib import Path

from chem_workbench import orchestrator
from chem_workbench.evaluation import (
    MAX_SUITE_BYTES,
    aggregate,
    aggregate_v4,
    model_identity,
    score_case,
    score_case_v4,
    source_identity,
    validate_suite,
    verify_complex_chemistry,
)
from chem_workbench.tool_gateway import invoke_tool
from chem_workbench.visualization import compile_snapshot, content_hash

ROOT = Path(__file__).resolve().parents[1]
RuntimeObserver = runpy.run_path(str(Path(__file__).with_name("model_resource_monitor.py")))[
    "RuntimeObserver"
]


def write_new(path, value):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write("\n")


def read_suite(path):
    with path.open("rb") as stream:
        data = stream.read(MAX_SUITE_BYTES + 1)
    if len(data) > MAX_SUITE_BYTES:
        raise ValueError("SUITE_LIMIT")
    return validate_suite(json.loads(data))


def code_snapshot(root, scoring_version=4):
    paths = set((root / "src/chem_workbench").rglob("*.py"))
    paths.update((root / "src/chem_workbench").rglob("*.json"))
    paths.update((root / "schemas").rglob("*.json"))
    if scoring_version == 4:
        paths.update(
            path
            for path in (root / "scripts").rglob("*")
            if path.suffix in {".py", ".cjs", ".js", ".mjs", ".ps1"}
        )
        paths.update((root / "tests").rglob("*.py"))
        desktop = root / "desktop"
        excluded = {
            "node_modules",
            "vendor",
            "build",
            "dist",
            "out",
            "release",
            "releases",
            "artifacts",
            "coverage",
            ".git",
        }
        paths.update(
            path
            for path in desktop.rglob("*")
            if path.suffix in {".js", ".cjs", ".mjs", ".json", ".html", ".css"}
            and not excluded.intersection(path.relative_to(desktop).parts)
        )
        assets = root / "src/chem_workbench/web_assets"
        paths.update(
            path
            for path in assets.rglob("*")
            if path.suffix in {".js", ".html", ".css"}
            and "vendor" not in path.relative_to(assets).parts
        )
        # Bind vendored bytes without embedding third-party source into the snapshot.
        vendor_manifest = {}
        for path in (assets / "vendor").rglob("*"):
            if path.is_file():
                if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
                    raise ValueError("CODE_SNAPSHOT_PATH_ESCAPE")
                vendor_manifest[path.relative_to(root).as_posix()] = hashlib.sha256(
                    path.read_bytes()
                ).hexdigest()
    else:
        paths.update(
            root / "scripts" / name
            for name in ("run_model_evaluation.py", "inspect_model_evaluation.py")
        )
        vendor_manifest = None
    paths.add(root / "uv.lock")
    sources = {}
    for path in sorted(paths):
        if not path.resolve().is_relative_to(root.resolve()) or path.is_symlink():
            raise ValueError("CODE_SNAPSHOT_PATH_ESCAPE")
        sources[path.relative_to(root).as_posix()] = path.read_text(encoding="utf-8")
    if vendor_manifest is not None:
        sources["snapshot-metadata/vendor-byte-hashes.json"] = json.dumps(
            vendor_manifest, sort_keys=True
        )
    return sources


def run_suite(
    suite, destination, *, root=ROOT, scoring_version=4, runtime_manifest=None, observe_runtime=None
):
    if scoring_version not in {3, 4}:
        raise ValueError("UNSUPPORTED_SCORING_VERSION")
    if observe_runtime is None:
        observe_runtime = scoring_version == 4
    suite = copy.deepcopy(validate_suite(suite))
    cases = suite["cases"]
    model = copy.deepcopy(orchestrator.model_status())
    if not model.get("available"):
        raise RuntimeError(model.get("message", "LM Studio unavailable"))
    sources = code_snapshot(root, scoring_version=scoring_version)
    code = {k: content_hash(v) for k, v in sources.items()}
    prepared = []
    for case in cases:
        snapshot = compile_snapshot(case["source"], case["attachments"])
        if not snapshot.success:
            raise ValueError(f"Invalid source fixture: {case['id']}")
        expected = case["expected"]
        oracle = None
        if expected["action"] != "needs_input":
            arguments = (
                {}
                if expected["action"] == "capabilities_list"
                else {"object_id": expected["object_id"]}
            )
            if expected["action"] == "plan_cu_lattice_scan":
                arguments["scale_factors"] = expected["scale_factors"]
            output = invoke_tool(expected["action"], arguments, snapshot)
            if output.get("status") != "succeeded":
                raise ValueError(f"Invalid direct oracle: {case['id']}")
            oracle = output["data"]
        prepared.append((case, snapshot, oracle))
    destination.mkdir(parents=True, exist_ok=False)
    frozen = {
        "version": f"model-evaluation-freeze/v{scoring_version}",
        "suite": suite,
        "model": model,
        "model_identity": model_identity(model),
        "code_identity": code,
        "oracles": {c["id"]: o for c, _, o in prepared},
        "source_snapshots": {
            c["id"]: {**source_identity(c), "semantic_hash": s.semantic_hash}
            for c, s, _ in prepared
        },
        "review_status": "evidence_checklist_required"
        if scoring_version == 4
        else "pending_human_review",
        "suite_review_status": suite["review_status"],
        "execution_authority": False,
    }
    if scoring_version == 4:
        frozen["run_id"] = uuid.uuid4().hex
        frozen["hardware_accounting"] = {
            "host": platform.node(),
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "processor": platform.processor(),
            "logical_cpu_count": os.cpu_count(),
        }
        frozen["runtime_manifest"] = copy.deepcopy(runtime_manifest)
        frozen["runtime_observation_policy"] = {
            "enabled": observe_runtime,
            "sampling_interval_seconds": 1.0,
            "allowed_controller_endpoint": "127.0.0.1:1234",
            "instrumentation": "exact nvidia-smi query from monitor thread only",
            "scope": "Python controller process; not an operating-system sandbox",
        }
        try:
            frozen["complexity_verification"] = verify_complex_chemistry(cases)
        except ImportError as exc:
            frozen["complexity_verification"] = {
                "passed": False,
                "status": "not_checked",
                "error": str(exc),
            }
    frozen["freeze_hash"] = content_hash(frozen)
    write_new(destination / "frozen.json", frozen)
    write_new(destination / "code-snapshot.json", sources)
    print(f"Frozen before inference: {destination}", flush=True)
    rows = []
    stable = True
    failures = 0
    stop_reason = None

    def observe_identity():
        current_code = {
            k: content_hash(v)
            for k, v in code_snapshot(root, scoring_version=scoring_version).items()
        }
        current_model = orchestrator.model_status()
        return current_code, current_model

    for case, snapshot, oracle in prepared:
        if stop_reason is None:
            try:
                current_code, current_model = observe_identity()
                if current_code != code or model_identity(current_model) != model_identity(model):
                    stable = False
                    stop_reason = "IDENTITY_DRIFT"
            except (OSError, ValueError, RuntimeError) as exc:
                stable = False
                stop_reason = "IDENTITY_UNOBSERVED: " + str(exc)
        start = time.monotonic()
        error = stop_reason
        record = None
        runtime_observer = None
        runtime_observations = None
        calls = []
        attempted = stop_reason is None
        if attempted:
            orchestrator.MODEL_METRICS.calls = []
            try:
                runtime_observer = RuntimeObserver() if observe_runtime else None
                context = (
                    runtime_observer if runtime_observer is not None else contextlib.nullcontext()
                )
                with context:
                    record = orchestrator.orchestrate(case["objective"], snapshot)
                failures = 0
            except (ValueError, RuntimeError, OSError, TypeError, KeyError) as exc:
                error = f"{type(exc).__name__}: {exc}"
                failures += 1
            finally:
                if runtime_observer is not None and runtime_observer.started is not None:
                    runtime_observations = runtime_observer.report()
            calls = list(orchestrator.MODEL_METRICS.calls)
            if record:
                if record.get("provider_calls") != calls:
                    error = "PROVIDER_OBSERVATION_MISMATCH"
                    stable = False
                if (
                    model_identity(record.get("model", {})) != model_identity(model)
                    or record.get("source_hash") != snapshot.source_sha256
                    or record.get("objective") != case["objective"]
                    or record.get("source_semantic_hash") != snapshot.semantic_hash
                ):
                    error = "RECORD_CONTEXT_DRIFT"
                    stable = False
                if not stable:
                    stop_reason = error
        scored_record = record or {"provider_calls": calls}
        scorer = score_case_v4 if scoring_version == 4 else score_case
        score = scorer(case, scored_record, oracle)
        if error and record:
            score["passed"] = False
            score["native_model_success"] = False
            if scoring_version == 4:
                score["native_first_attempt_success"] = False
                score["reviewed_model_success"] = False
                score["reviewed_model_abstention"] = False
                score["host_workflow_success"] = False
                score["repaired_success"] = False
            score["reasons"].append(error)
        row = {
            "id": case["id"],
            "category": case["category"],
            "attempted": attempted,
            "outcome": "not_run" if not attempted else "error" if error else "completed",
            "input_identity": source_identity(case),
            "score": score,
            "record": record,
            "provider_calls": calls,
            "error": error,
            "seconds": round(time.monotonic() - start, 3) if attempted else 0,
        }
        if scoring_version == 4:
            row["family"] = case.get("family")
            row["runtime_observations"] = runtime_observations
        row["row_hash"] = content_hash(row)
        write_new(destination / (case["id"] + ".json"), row)
        rows.append(row)
        print(
            json.dumps(
                {
                    "id": case["id"],
                    "outcome": row["outcome"],
                    "passed": row["score"]["passed"],
                    "native_model_success": row["score"]["native_model_success"],
                    "reasons": row["score"]["reasons"],
                    "seconds": row["seconds"],
                }
            ),
            flush=True,
        )
        if failures >= 3 and stop_reason is None:
            stop_reason = "PROVIDER_FAILURE_BREAKER"
    try:
        final_code, final_model = observe_identity()
        stable = (
            stable and final_code == code and model_identity(final_model) == model_identity(model)
        )
    except (OSError, ValueError, RuntimeError) as exc:
        final_code, final_model = None, {"error": str(exc)}
        stable = False
    summary = (
        aggregate_v4(
            rows,
            complete=all(r["attempted"] for r in rows),
            identity_stable=stable,
            cases=cases,
            runtime_manifest=runtime_manifest,
        )
        if scoring_version == 4
        else aggregate(
            rows,
            complete=all(r["attempted"] for r in rows),
            identity_stable=stable,
            native_metrics=True,
        )
    )
    report = {
        "version": f"model-evaluation-report/v{scoring_version}",
        "freeze_hash": frozen["freeze_hash"],
        "suite_hash": suite["suite_hash"],
        "case_rows": {r["id"]: r["row_hash"] for r in rows},
        "final_code_identity": final_code,
        "final_model": final_model,
        "stop_reason": stop_reason,
        **summary,
    }
    report["report_hash"] = content_hash(report)
    write_new(destination / "report.json", report)
    print(json.dumps(report, indent=2), flush=True)
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--suite", type=Path, default=ROOT / "evaluations/gemma-e2b-next-cycle-01.json"
    )
    parser.add_argument("--scoring-version", type=int, choices=[3, 4], default=4)
    parser.add_argument("--runtime-manifest", type=Path)
    parser.add_argument("--observe-runtime", action=argparse.BooleanOptionalAction, default=None)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--model", choices=sorted(orchestrator.ALLOWED_MODEL_KEYS), default=orchestrator.MODEL_KEY
    )
    args = parser.parse_args()
    os.environ["CHEM_MODEL_KEY"] = args.model
    manifest = None
    if args.runtime_manifest:
        with args.runtime_manifest.open("rb") as stream:
            raw = stream.read(MAX_SUITE_BYTES + 1)
        if len(raw) > MAX_SUITE_BYTES:
            raise ValueError("RUNTIME_MANIFEST_LIMIT")
        manifest = json.loads(raw)
    report = run_suite(
        read_suite(args.suite),
        args.output or ROOT / "build/model-evaluations" / uuid.uuid4().hex,
        scoring_version=args.scoring_version,
        runtime_manifest=manifest,
        observe_runtime=args.observe_runtime,
    )
    return 0 if report["complete"] and report["identity_stable"] else 2


if __name__ == "__main__":
    sys.exit(main())
