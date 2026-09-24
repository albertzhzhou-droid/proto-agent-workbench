"""Observed design fault injection; no live model or model-competence credit.

The real router parser, workflow dispatcher, chemistry modules and persistence
path run against explicitly injected provider/module/storage failures. A scoped
Python audit hook forbids network/process effects before they occur. This is not
an operating-system sandbox or independent scientific calibration evidence.
"""

from __future__ import annotations

import argparse
import copy
import json
import runpy
import sys
import traceback
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from chem_workbench import design_candidates, design_studio, interface_simulation, orchestrator
from chem_workbench.evaluation import validate_case_id
from chem_workbench.visualization import content_hash

ROOT = Path(__file__).resolve().parents[1]
LANES = ["organic_design", "inorganic_design", *design_studio.INTERFACES]
SLOTS = ["provider", "parser", "module", "storage"]
PARSER_FAULTS = {
    "organic_design": "malformed_json",
    "inorganic_design": "truncated_response",
    "electrode_electrolyte": "extra_action_field",
    "catalyst_reactant": "malformed_json",
    "solid_liquid": "truncated_response",
}


class NoExternalEffects:
    """Process-local instrumentation; hooks become dormant on context exit."""

    def __init__(self):
        self.active = False
        self.events = []

    def audit(self, event, args):
        if self.active and event in {
            "socket.connect",
            "socket.sendto",
            "subprocess.Popen",
            "os.system",
            "os.exec",
            "os.posix_spawn",
            "os.spawn",
        }:
            details = {"event": event, "outcome": "denied_before_effect"}
            if event == "subprocess.Popen":
                details["executable"] = str(args[0])[:300]
                details["arguments"] = repr(args[1])[:500]
                details["python_callers"] = [
                    {"file": frame.filename, "line": frame.lineno, "function": frame.name}
                    for frame in traceback.extract_stack(limit=12)[:-1]
                ]
            self.events.append(details)
            raise PermissionError("DESIGN_FAULT_HARNESS_EXTERNAL_EFFECT_DENIED")

    def __enter__(self):
        sys.addaudithook(self.audit)
        self.active = True
        return self

    def __exit__(self, *args):
        self.active = False


def cases():
    return [
        {
            "id": f"runtime-{lane.replace('_', '-')}-{slot}",
            "family": "tool_runtime_failures",
            "module_family": lane,
            "fault": PARSER_FAULTS[lane] if slot == "parser" else slot + "_failure",
            "slot": slot,
        }
        for lane in LANES
        for slot in SLOTS
    ]


def _request(case):
    study = design_studio.default_study()
    study["organic"].update(fragment_ids=["phenyl", "pyridyl"], source=case["id"] + " organic")
    study["inorganic"].update(
        a_elements=["Sr", "Ba"],
        b_pairs=[["Sc", "Nb"], ["Y", "Ta"]],
        source=case["id"] + " inorganic",
    )
    lane = case["module_family"]
    decision = design_studio.empty_decision(
        lane if lane in {"organic_design", "inorganic_design"} else "interface_design"
    )
    decision.update(max_candidates=2, interfaces=[lane] if lane in design_studio.INTERFACES else [])
    decision["message"] = "Synthetic fault-harness action; not a sampled model decision."
    return {
        "prompt": "Fault-injection fixture for " + lane + "; preserve all declared study inputs.",
        "study": study,
        "mode": "model",
        "decision": None,
    }, decision


def _valid_hash(record, field):
    return isinstance(record, dict) and record.get(field) == content_hash(
        {key: value for key, value in record.items() if key != field}
    )


def run_case(case, root):
    """Return full observed evidence, including failures; never substitute a test boolean."""
    validate_case_id(case["id"])
    if case not in cases():
        raise ValueError("UNKNOWN_DESIGN_RUNTIME_FAULT_CASE")
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=False)
    studio = design_studio.DesignStudio(root)
    request, action = _request(case)
    requirements = {
        "requested_workflow": action["workflow"],
        "requested_properties": [],
        "missing_inputs": [],
        "unsupported_requests": [],
        "disposition": "admitted",
        "message": "Synthetic fault-harness requirements; not sampled model output.",
    }
    saved_request = copy.deepcopy(request)
    lane, slot = case["module_family"], case["slot"]
    target = lane
    expected_modules = (
        [lane]
        if lane in {"organic_design", "inorganic_design"}
        else [
            "organic_design",
            "inorganic_design",
            lane,
        ]
    )
    transports, dispatches, writes = [], [], []
    record, exception = None, None
    effects = NoExternalEffects()
    original_write = studio.store._write

    def transport(path, body=None, timeout=12):
        observed = {"path": path, "body": copy.deepcopy(body), "timeout": timeout}
        transports.append(observed)
        if slot == "provider":
            observed["injected_error"] = "MODEL_TIMEOUT: injected provider timeout"
            raise ValueError(observed["injected_error"])
        proposal = requirements if orchestrator.MODEL_METRICS.stage == "requirements" else action
        content, finish = json.dumps(proposal), "stop"
        if slot == "parser":
            if case["fault"] == "malformed_json":
                content = "{design-runtime-fault: malformed JSON"
            elif case["fault"] == "truncated_response":
                content, finish = json.dumps(proposal)[:53], "length"
            else:
                content = json.dumps({**proposal, "approve_external_worker": True})
        response = {
            "model": "design-fault-double",
            "choices": [{"finish_reason": finish, "message": {"content": content}}],
            "usage": None,
        }
        observed["response"] = copy.deepcopy(response)
        return response

    def module(name, original):
        def wrapped(*args, **kwargs):
            item = {"module": name, "input_hash": content_hash(args[0]), "status": "started"}
            dispatches.append(item)
            try:
                if slot == "module" and name == target:
                    raise ValueError("INJECTED_DESIGN_MODULE_FAILURE: " + target)
                result = original(*args, **kwargs)
            except Exception as error:
                item.update(
                    status="failed", error={"type": type(error).__name__, "message": str(error)}
                )
                raise
            item.update(
                status="succeeded",
                output_hash=content_hash(result)
                if name in design_studio.INTERFACES
                else result["result_hash"],
            )
            return result

        return wrapped

    def simulation(spec, organic, inorganic):
        return module(spec["profile"], original_simulation)(spec, organic, inorganic)

    def write(path, value):
        resolved = path.resolve()
        item = {"path": str(resolved.relative_to(root)), "record_hash": value.get("record_hash")}
        writes.append(item)
        if not resolved.is_relative_to(studio.directory):
            raise PermissionError("UNEXPECTED_RUNTIME_STORE_DESTINATION")
        if slot == "storage":
            item["injected_error"] = "Injected design-store write permission failure"
            raise PermissionError(item["injected_error"])
        original_write(path, value)
        item["persisted"] = True

    original_simulation = interface_simulation.simulate_interface
    with ExitStack() as stack:
        stack.enter_context(
            patch.object(
                orchestrator,
                "model_status",
                lambda: {
                    "available": True,
                    "model_id": "design-fault-double",
                    "key": "synthetic-only",
                    "scope": "Explicit mock; no LM Studio inventory request was made",
                },
            )
        )
        stack.enter_context(patch.object(orchestrator, "local_request", transport))
        stack.enter_context(
            patch.object(
                design_candidates,
                "organic_candidates",
                module(
                    "organic_design",
                    design_candidates.organic_candidates,
                ),
            )
        )
        stack.enter_context(
            patch.object(
                design_candidates,
                "inorganic_candidates",
                module(
                    "inorganic_design",
                    design_candidates.inorganic_candidates,
                ),
            )
        )
        stack.enter_context(patch.object(interface_simulation, "simulate_interface", simulation))
        stack.enter_context(patch.object(studio.store, "_write", write))
        stack.enter_context(effects)
        try:
            record = studio.run(request)
        except Exception as error:
            exception = {"type": type(error).__name__, "message": str(error)}
            if isinstance(error, design_studio.DesignRunError):
                record = error.record
    disk_records = list(studio.directory.glob("*.json"))
    reopened, reopen_error = None, None
    if record and disk_records:
        try:
            reopened = studio.read(record["record_hash"])
        except Exception as error:
            reopen_error = {"type": type(error).__name__, "message": str(error)}
    calls = (record or {}).get("orchestration", {}).get("provider_calls", [])
    trace = (record or {}).get("trace", [])
    expected_phase = (
        "routing"
        if slot in {"provider", "parser"}
        else ("persistence" if slot == "storage" else "workflow")
    )
    expected_dispatches = [] if slot in {"provider", "parser"} else expected_modules
    expected_count = 1 if slot == "provider" else 2
    transport_hashes_retained = len(calls) == len(transports) and all(
        call.get("request_body_hash") == content_hash(observed["body"])
        and (
            "response" not in observed
            or (
                call.get("response_hash") == content_hash(observed["response"])
                and call.get("response_text")
                == observed["response"]["choices"][0]["message"]["content"]
            )
        )
        for call, observed in zip(calls, transports, strict=False)
    )
    source_checks = {
        "request_unchanged": request == saved_request,
        "request_retained": (record or {}).get("request") == saved_request,
        "request_hash": (record or {}).get("request_hash") == content_hash(saved_request),
        "study_hash": (record or {}).get("study_hash") == content_hash(saved_request["study"]),
        "route_prompt_hash": (record or {}).get("orchestration", {}).get("prompt_hash")
        == content_hash(saved_request["prompt"]),
        "route_study_hash": (record or {}).get("orchestration", {}).get("study_hash")
        == content_hash(saved_request["study"]),
    }
    for family in ("organic", "inorganic"):
        generated = (record or {}).get(family)
        if generated:
            source_checks[family + "_source"] = (
                generated["request"].get("source") == (saved_request["study"][family]["source"])
            )
            source_checks[family + "_result_hash"] = _valid_hash(generated, "result_hash")
            source_checks[family + "_candidate_binding"] = all(
                candidate["request_hash"] == content_hash(generated["request"])
                and _valid_hash(candidate, "candidate_hash")
                for candidate in generated["candidates"]
            )
    checks = {
        "typed_failure_with_retained_record": bool(exception)
        and exception["type"] == "DesignRunError"
        and bool(record),
        "terminal_failure_state": (record or {}).get("state") == "failed",
        "correct_failure_phase": (record or {}).get("error", {}).get("phase") == expected_phase,
        "record_hash_valid": _valid_hash(record, "record_hash"),
        "source_provenance": all(source_checks.values()),
        "provider_count_exact": len(transports) == len(calls) == expected_count,
        "provider_stages_exact": [call.get("stage") for call in calls]
        == (
            ["requirements", "action"]
            if slot in {"module", "storage"}
            else ["requirements"] * expected_count
        ),
        "raw_provider_evidence_retained": transport_hashes_retained,
        "bounded_repair": (record or {}).get("orchestration", {}).get("repairs")
        == (1 if slot == "parser" else 0),
        "only_expected_modules_dispatched": [row["module"] for row in dispatches]
        == expected_dispatches,
        "dispatch_trace_retained": [row.get("module") for row in trace] == expected_dispatches
        and [row.get("status") for row in trace] == [row["status"] for row in dispatches],
        "dispatch_hashes_retained": len(trace) == len(dispatches)
        and all(
            retained.get("input_hash") == observed["input_hash"]
            and retained.get("output_hash") == observed.get("output_hash")
            and retained.get("seconds", -1) >= 0
            and (observed["status"] != "failed" or retained.get("error") == observed["error"])
            for retained, observed in zip(trace, dispatches, strict=False)
        ),
        "no_external_effect_attempt": not effects.events,
        "no_execution_artifacts": not any(
            path.is_file()
            for directory in (
                studio.store.plans,
                studio.store.approvals,
                studio.store.jobs,
                studio.store.runs,
            )
            for path in directory.rglob("*")
        ),
        "authority_not_granted_by_model": (record or {})
        .get("authorization", {})
        .get("model_grants_authority")
        is False
        and (record or {}).get("authorization", {}).get("external_workers") is False
        and (record or {}).get("authorization", {}).get("network") is False,
        "one_persistence_attempt": len(writes) == 1,
        "honest_persistence_outcome": (not disk_records and reopened is None)
        if slot == "storage"
        else len(disk_records) == 1 and reopened == record,
        "persistence_failure_disclosed": slot != "storage"
        or (record or {}).get("persistence", {}).get("saved") is False,
        "locks_released": not orchestrator.MODEL_LOCK.locked()
        and not design_studio.DESIGN_LOCK.locked(),
    }
    evidence = {
        "injection": {
            "kind": case["fault"],
            "slot": slot,
            "target_module": target,
            "synthetic": True,
        },
        "request": saved_request,
        "input_hash": content_hash(saved_request),
        "record": record,
        "exception": exception,
        "provider_transport_observations": transports,
        "module_dispatches": dispatches,
        "persistence_attempts": writes,
        "persisted_record_files": [p.name for p in disk_records],
        "reopen_error": reopen_error,
        "source_provenance_checks": source_checks,
        "checks": checks,
        "external_effect_events": effects.events,
        "live_model_calls": 0,
        "scope": "Injected functional faults with real host parser/dispatch/storage; "
        "no model competence, operating-system sandbox or calibrated scientific evidence credit",
    }
    evidence["evidence_hash"] = content_hash(evidence)
    row = {key: case[key] for key in ("id", "family", "module_family")}
    row.update(passed=all(checks.values()), evidence=evidence)
    return row


def code_identity(root):
    snapshot = runpy.run_path(str(ROOT / "scripts/run_design_evaluation.py"))["code_snapshot"]
    return {key: content_hash(value) for key, value in snapshot(root, scoring_version=4).items()}


def run_manifest(suite_hash, destination, *, root=ROOT, expected_code_identity=None):
    if (
        not isinstance(suite_hash, str)
        or len(suite_hash) != 71
        or not suite_hash.startswith("sha256:")
    ):
        raise ValueError("DESIGN_RUNTIME_SUITE_HASH_REQUIRED")
    try:
        int(suite_hash[7:], 16)
    except ValueError as error:
        raise ValueError("DESIGN_RUNTIME_SUITE_HASH_REQUIRED") from error
    identity = code_identity(root)
    if expected_code_identity is not None and identity != expected_code_identity:
        raise ValueError("DESIGN_RUNTIME_CODE_FREEZE_MISMATCH")
    destination = Path(destination)
    if destination.exists():
        raise FileExistsError(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    evidence_root = destination.with_suffix(".evidence")
    evidence_root.mkdir(exist_ok=False)
    rows = []
    for case in cases():
        row = run_case(case, evidence_root / case["id"])
        rows.append(row)
        print(row["id"], "PASS" if row["passed"] else "FAIL", flush=True)
    after = code_identity(root)
    unchanged = identity == after
    manifest = {
        "version": "design-runtime-manifest/v1",
        "suite_hash": suite_hash,
        "code_identity": identity,
        "code_identity_hash": content_hash(identity),
        "code_identity_unchanged": unchanged,
        "cases": rows,
        "passed": unchanged and all(row["passed"] for row in rows),
        "total": len(rows),
        "passed_count": sum(row["passed"] for row in rows),
        "live_model_calls": 0,
        "scope": "Functional fault injection only; no model promotion credit",
    }
    manifest["manifest_hash"] = content_hash(manifest)
    with destination.open("x", encoding="utf-8") as stream:
        json.dump(manifest, stream, indent=2, allow_nan=False)
        stream.write("\n")
    return manifest


def fixture_identity(path, suite_hash):
    fixture = json.loads(Path(path).read_text(encoding="utf-8"))
    if not _valid_hash(fixture, "fixtures_hash") or fixture.get("version") != (
        "design-model-fixtures/v1"
    ):
        raise ValueError("DESIGN_RUNTIME_FIXTURES_HASH_MISMATCH")
    suite = fixture.get("suite")
    if not _valid_hash(suite, "suite_hash") or suite["suite_hash"] != suite_hash:
        raise ValueError("DESIGN_RUNTIME_SUITE_FREEZE_MISMATCH")
    return fixture["code_identity"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite-hash", required=True)
    parser.add_argument("--fixtures", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    identity = None
    if args.fixtures:
        identity = fixture_identity(args.fixtures, args.suite_hash)
    manifest = run_manifest(args.suite_hash, args.output, expected_code_identity=identity)
    if not manifest["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
