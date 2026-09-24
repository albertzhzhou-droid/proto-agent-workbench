"""Frozen functional fault injection. No live model or scientific execution evidence."""

from __future__ import annotations

import argparse
import copy
import getpass
import json
import time
import uuid
from pathlib import Path
from unittest.mock import patch

from chem_workbench import execution, orchestrator
from chem_workbench.evaluation import validate_case_id
from chem_workbench.intent import OPERATIONS
from chem_workbench.molecular_compute import molecular_proposal
from chem_workbench.visualization import compile_snapshot, content_hash

FAULTS = {
    "provider_unavailable",
    "provider_timeout",
    "malformed_json",
    "truncated_response",
    "unknown_tool",
    "extra_argument",
    "foreign_target",
    "unsupported_profile",
    "tool_rejection",
    "cancelled_job",
    "stale_approval",
}


def clean_requirements(case, snapshot):
    """Typed scenario fixture, never language interpretation or a model observation."""
    action = case["clean_action"]
    operation = next(key for key, value in OPERATIONS.items() if value == action["action"])
    target = next(
        (obj for obj in snapshot.document["objects"] if obj["id"] == action["object_id"]), None
    )
    finite = action["action"] == "plan_molecular_single_point"
    geometry = (
        "source_generated_conformer"
        if finite or (operation == "preview" and target["kind"] == "Molecule")
        else "not_applicable"
    )
    return {
        "operation": operation,
        "targets": [action["object_id"]] if target else [],
        "geometry_source": geometry,
        "scale_factors": action["scale_factors"],
        "method": "hf" if finite else "",
        "basis": "sto-3g" if finite else "",
        "phase": "gas" if finite else "",
        "temperature_kelvin": 0 if finite else None,
        "charge": 0 if finite else None,
        "multiplicity": 1 if finite else None,
        "execution_requested": False,
        "authority_override_requested": False,
        "missing_information": [],
        "unsupported_requirements": [],
        "disposition": "request_tool",
        "clarification": "",
        "request_summary": "Deterministic fault-harness requirements fixture; not model output.",
    }


def run_case(case, root):
    validate_case_id(case["id"])
    kind, mode = case["fault"]["kind"], case["fault"]["mode"]
    if kind not in FAULTS or mode not in {"once", "persistent"}:
        raise ValueError("UNKNOWN_FAULT_CONTRACT")
    snapshot = compile_snapshot(case["source"], case["attachments"])
    if not snapshot.success:
        raise ValueError("INVALID_FAULT_SOURCE")
    calls, dispatches, launches = [], [], []
    record, error, host_result = None, None, None
    started = time.monotonic()
    clean = {**case["clean_action"], "message": "Synthetic fault-harness proposal."}
    requirements = clean_requirements(case, snapshot)
    original_request = orchestrator.request_action
    original_invoke = orchestrator.invoke_tool
    attempts = [0]

    def no_launch(*args, **kwargs):
        launches.append("unexpected_execution_attempt")
        raise AssertionError("Fault harness must not launch a calculator")

    def provider(*args, **kwargs):
        stage = orchestrator.MODEL_METRICS.stage
        if kind == "provider_timeout":
            raise ValueError("MODEL_TIMEOUT: injected provider timeout")
        value = requirements if stage == "requirements" else copy.deepcopy(clean)
        finish = "stop"
        if stage == "action":
            attempts[0] += 1
            corrupt = mode == "persistent" or attempts[0] == 1
            if corrupt:
                if kind == "malformed_json":
                    return {"choices": [{"finish_reason": "stop", "message": {"content": "{"}}]}
                if kind == "truncated_response":
                    finish = "length"
                if kind == "unknown_tool":
                    value["action"] = "unregistered_fault_tool"
                if kind == "extra_argument":
                    value["execution_authorized"] = True
        return {
            "model": "fault-double",
            "choices": [{"finish_reason": finish, "message": {"content": json.dumps(value)}}],
        }

    def request(*args, **kwargs):
        if orchestrator.MODEL_METRICS.stage == "action" and kind in {
            "foreign_target",
            "unsupported_profile",
        }:
            # Explicit parser-bypass fault: dispatch validation must remain independent.
            action = copy.deepcopy(clean)
            if kind == "foreign_target":
                action["object_id"] = "foreign_fault_target"
            else:
                action["action"] = "plan_cu_lattice_scan"
                action["scale_factors"] = [0.98, 1.0, 1.02]
            orchestrator.MODEL_METRICS.calls.append(
                {
                    "stage": "action",
                    "seconds": 0,
                    "schema_valid": False,
                    "proposed_action": action,
                    "fault_injected": "sampling_parser_bypass",
                }
            )
            return action
        return original_request(*args, **kwargs)

    def invoke(name, arguments, compiled):
        dispatches.append({"name": name, "arguments": arguments})
        if kind == "tool_rejection":
            raise ValueError("TOOL_REJECTED: injected first-party tool failure")
        return original_invoke(name, arguments, compiled)

    with patch.object(execution, "_execute", no_launch):
        if kind in {"cancelled_job", "stale_approval"}:
            store = execution.ExecutionStore(root)
            if kind == "cancelled_job":
                job_id = uuid.uuid4().hex
                store.save_job(
                    {
                        "job_id": job_id,
                        "owner": getpass.getuser(),
                        "workspace": str(store.root),
                        "status": "running",
                        "fixture": "synthetic_owned_running_job",
                    }
                )
                host_result = execution.cancel_job(store, job_id)
                assert (store.run_directory(job_id) / "cancel.request").is_file()
                outcome = host_result["status"]
            else:
                proposal = molecular_proposal(snapshot, clean["object_id"])
                plan = execution.build_molecular_resolved_plan(proposal)
                store.save_plan(plan)
                approval = execution.issue_approval(
                    store, plan["resolved_plan_hash"], actor="fault-harness", now=10, ttl_seconds=1
                )
                try:
                    execution.submit_run(store, approval["token"], now=12)
                except ValueError as exc:
                    error = str(exc)
                assert error and "APPROVAL_STALE" in error
                assert not list(store.jobs.glob("*.json"))
                outcome = "job_blocked"
        else:
            model = {
                "available": kind != "provider_unavailable",
                "model_id": "fault-double",
                "key": "fault-double",
                "message": "Injected model availability",
            }
            with (
                patch.object(orchestrator, "model_status", lambda: model),
                patch.object(orchestrator, "local_request", provider),
                patch.object(orchestrator, "request_action", request),
                patch.object(orchestrator, "invoke_tool", invoke),
            ):
                try:
                    record = orchestrator.orchestrate(case["objective"], snapshot)
                except ValueError as exc:
                    error = str(exc)
                calls = copy.deepcopy(orchestrator.MODEL_METRICS.calls)
            if record and record["state"] == "REPORTED":
                outcome = "completed_after_repair"
                assert all(
                    record["model_action"][key] == clean[key]
                    for key in ("action", "object_id", "scale_factors")
                )
            elif dispatches:
                outcome = "tool_rejected"
            else:
                outcome = "rejected_without_tool"
    expected = case["expected"]
    passed = (
        outcome == expected["outcome"]
        and len(calls) <= expected["max_model_calls"]
        and len(dispatches) <= expected["max_tool_calls"]
        and not launches
        and (not record or record["execution_authorized"] is False)
    )
    row = {
        "id": case["id"],
        "family": case["family"],
        "fault": case["fault"],
        "passed": passed,
        "outcome": outcome,
        "expected": expected,
        "record": record,
        "error": error,
        "provider_calls": calls,
        "tool_dispatches": dispatches,
        "calculator_launches": launches,
        "host_result": host_result,
        "seconds": round(time.monotonic() - started, 3),
        "input_hash": content_hash(case),
        "live_model_calls": 0,
        "scope": "Synthetic provider/host faults; no scientific evidence or model competence credit",
    }
    row["row_hash"] = content_hash(row)
    return row


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    assert manifest["suite_hash"] == content_hash(
        {k: v for k, v in manifest.items() if k != "suite_hash"}
    )
    assert len(manifest["cases"]) == 20
    assert len({c["id"] for c in manifest["cases"]}) == 20
    args.output.mkdir(parents=True, exist_ok=False)
    rows = []
    for case in manifest["cases"]:
        row = run_case(case, args.output / case["id"])
        (args.output / (case["id"] + ".json")).write_text(
            json.dumps(row, indent=2), encoding="utf-8"
        )
        rows.append(row)
        print(row["id"], row["passed"], row["outcome"], flush=True)
    report = {
        "version": "model-runtime-fault-report/v1",
        "manifest_hash": manifest["suite_hash"],
        "case_rows": {row["id"]: row["row_hash"] for row in rows},
        "passed": all(row["passed"] for row in rows),
        "total": len(rows),
        "passed_count": sum(row["passed"] for row in rows),
        "live_model_calls": 0,
        "calculator_launches": 0,
        "scope": "Functional fault injection only",
    }
    report["report_hash"] = content_hash(report)
    (args.output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    if not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
