"""Pure retained-byte/mutation tests. Generated complete traces are MOCKS only.

The genuine parity files supply installed native gradient shapes and 34-atom
coordinates. They are never asserted to supply a fresh run, energy call or outer
electronic calculation. Mock headers/energy traces below exist only in memory.
"""

import copy
import hashlib
import json
from dataclasses import replace
from pathlib import Path

import pytest
from refinement_evidence_fixtures import FIXTURES, read_bound_artifact
from refinement_schema_fixture import synthetic_native_trace

from chem_workbench.molecular_refinement import validate_refinement_spec
from chem_workbench.refinement_execution import contract_result_evidence as evidence
from chem_workbench.refinement_execution import execution_contract
from chem_workbench.refinement_execution import native_dispersion_records as native

ROOT = Path(__file__).resolve().parents[1]
PARITY = FIXTURES / "parity"
NAMES = {
    "outer_request": "bridge-qcengine-input.json",
    "inner_request": "bridge-translated-dftd3-input.json",
    "outer_result": "bridge-qcengine-result.json",
    "inner_result": "bridge-translated-dftd3-result.json",
}


@pytest.fixture
def spec():
    return validate_refinement_spec(json.loads((FIXTURES / "input.json").read_text())["spec"])


def raw_call():
    return {key: (PARITY / name).read_bytes() for key, name in NAMES.items()}


def test_genuine_retained_gradient_pair_matches_installed_schema(spec):
    records = raw_call()
    before = copy.deepcopy(records)
    assert native.parse(records["outer_request"])["molecule"]["molecular_multiplicity"] == 1.0
    native.validate_call(
        **records, spec=spec, geometry=spec["geometry"], driver="gradient", native_version="1.6.0"
    )
    assert records == before


@pytest.mark.parametrize(
    "change",
    [
        "method",
        "level",
        "s9",
        "driver",
        "id",
        "mass",
        "tiny_mass_drift",
        "geometry",
        "bool_multiplicity",
        "fractional_multiplicity",
        "local_config",
        "result_input_data",
        "result_failure",
        "retry",
    ],
)
def test_native_mutations_rejected(spec, change):
    records = raw_call()
    key = "inner_request"
    value = native.parse(records[key])
    if change == "method":
        value["specification"]["model"]["method"] = "wb97x-d"
    elif change == "level":
        value["specification"]["keywords"]["level_hint"] = "d3zero"
    elif change == "s9":
        value["specification"]["keywords"]["params_tweaks"]["s9"] = 1.0
    elif change == "driver":
        value["specification"]["driver"] = "energy"
    elif change == "id":
        value["molecule"]["atom_labels"][0] = "other"
    elif change == "mass":
        value["molecule"]["masses"][0] += 1
    elif change == "tiny_mass_drift":
        value["molecule"]["masses"][0] += 1e-11
    elif change == "geometry":
        value["molecule"]["geometry"][0] += 0.01
    elif change == "bool_multiplicity":
        value["molecule"]["molecular_multiplicity"] = True
    elif change == "fractional_multiplicity":
        value["molecule"]["molecular_multiplicity"] = 1.1
    elif change == "local_config":
        value["specification"]["extras"]["_qcengine_local_config"] = {"retries": 3}
    else:
        key = "outer_result"
        value = native.parse(records[key])
        if change == "result_input_data":
            value["input_data"] = native.parse(records["outer_request"])
        elif change == "result_failure":
            value["success"] = False
        else:
            value["provenance"]["retries"] = True
    records[key] = json.dumps(value).encode()
    with pytest.raises(ValueError):
        native.validate_call(
            **records,
            spec=spec,
            geometry=spec["geometry"],
            driver="gradient",
            native_version="1.6.0",
        )


class MockRun:
    """Explicit in-memory host/observer fixture, not an actual-run evidence builder."""

    def __init__(self, spec):
        self.spec = spec
        self.contract = execution_contract.seal_execution_contract(spec, "gradient")
        self.storage = {}
        self.directory = "mock/current-run"
        self.nested = self.directory + "/evaluation-0/nested"
        self.call_refs = []
        self.inventory = []
        self.task_config = {
            "retries": 0,
            "ncores": spec["resources"]["threads"],
            "memory": 8.0,
            "scratch_directory": "C:\\mock\\scratch",
        }
        self.evaluation_config = {
            **self.task_config,
            "scratch_directory": "C:\\mock\\scratch\\evaluation-0000",
        }
        self.worker = {"kind": "psi4_refinement", "fixture": "synthetic supervisor"}
        source = self.put("mock/source.py", b"# synthetic source fixture\n")
        self.source = {source["path"]: source["sha256"]}
        self.base = {"evaluation_id": "evaluation-0", "spec_hash": spec["spec_hash"]}
        outer_input = {
            "schema_name": "qcschema_input",
            "schema_version": 1,
            "driver": "gradient",
            "model": {"method": spec["profile"]["method"], "basis": spec["profile"]["basis"]},
            "keywords": spec["electronic_settings"]["native_keywords"],
            "extras": {"psiapi": True},
            "molecule": copy.deepcopy(native.parse(raw_call()["outer_request"])["molecule"]),
        }
        frame_input = json.dumps(outer_input)
        frame_return = json.dumps({"fixture": "mock electronic return, not a scientific record"})
        frame = {
            "frame_hash": evidence.digest("mock frame"),
            "geometry": spec["geometry"],
            "raw_input_json": frame_input,
            "raw_result_json": frame_return,
        }
        self.result = {
            "result_hash": evidence.digest("mock result"),
            "trajectory": [frame],
            "timing": {"backend_attempts_observed": 1},
            "evidence_origin": "worker_record",
        }
        outer_request_ref = self.call("outer-input.json", frame_input.encode())
        start = {
            "version": "refinement-electronic-call-start/v1",
            "run_id": "current",
            "run_nonce": "a" * 32,
            **self.base,
            "contract_hash": self.contract["contract_hash"],
            "program": "psi4",
            "dispatch": self.contract["dispatch"],
            "task_config": self.evaluation_config,
            "input_sha256": outer_request_ref["sha256"],
            "monotonic_seconds": 110.0,
        }
        self.entry = {
            "evaluation_id": "evaluation-0",
            "attempt_index": 0,
            "frame_hash": frame["frame_hash"],
            "outer_start": self.call("outer-start.json", start),
            "outer_request": outer_request_ref,
            "outer_return": self.call("outer-result.json", frame_return.encode()),
            "outer_exception": None,
            "observer_directory": self.nested,
            "observer_summary": None,
        }
        self.observer_file(
            "context-start.json",
            {
                **self.base,
                "monotonic_seconds": 111.0,
                "scratch_before": "C:\\mock\\old",
                "scratch_forwarded": self.evaluation_config["scratch_directory"],
                "ncores": self.task_config["ncores"],
                "memory_gib": 8.0,
                "nested_retries": 0,
                "scope": "synthetic trace fixture",
            },
        )
        for index, driver in enumerate(("energy", "gradient")):
            records = {key: native.parse(raw) for key, raw in raw_call().items()}
            # A MOCK energy trace is derived explicitly; no genuine energy trace is claimed.
            if driver == "energy":
                for key in ("outer_request", "inner_request"):
                    records[key]["specification"]["driver"] = driver
                for key in ("outer_result", "inner_result"):
                    records[key]["input_data"]["specification"]["driver"] = driver
                    records[key]["return_result"] = records[key]["properties"]["return_energy"]
            for layer in ("qce", "inner"):
                prefix = f"{layer}-{index:04d}"
                self.observer_file(
                    prefix + "-start.json",
                    {
                        **self.base,
                        "monotonic_seconds": 120.0 + index * 10 + (1 if layer == "inner" else 0),
                        **(
                            {"program": "s-dftd3"}
                            if layer == "qce"
                            else {"parent_qce_call": f"qce-{index:04d}"}
                        ),
                    },
                )
                which = "outer" if layer == "qce" else "inner"
                self.observer_file(prefix + "-request.json", records[which + "_request"])
                self.observer_file(prefix + "-return.json", records[which + "_result"])
                self.observer_file(
                    prefix + "-forwarded-request-after.json", records[which + "_request"]
                )
                if layer == "qce":
                    self.observer_file(
                        prefix + "-requested-config.json", {"ncores": self.task_config["ncores"]}
                    )
                    self.observer_file(prefix + "-forwarded-config.json", self.evaluation_config)
        self.summary = {
            **self.base,
            "monotonic_seconds": 140.0,
            "version": "nested-d3-observation-staged/v1",
            "finalized": True,
            "context_exception": None,
            "restoration_errors": [],
            "counts": {key: 2 for key in evidence.COUNTS},
            "artifacts": self.inventory.copy(),
            "scientific_accuracy_validated": False,
            "outer_electronic_attempts_observed": False,
        }
        self.entry["observer_summary"] = self.call("nested/summary.json", self.summary)
        self.call(
            "outer-dispatch-controls.json",
            {
                "requested_task_config": self.task_config,
                "forwarded_task_config": self.evaluation_config,
                "return_version": 1,
                "program": "psi4",
                "raise_error": False,
            },
        )
        for phase in ("before", "after"):
            self.call(
                "native-controls-" + phase + ".json",
                {
                    "stage": phase,
                    "threads": self.task_config["ncores"],
                    "memory_bytes": int(self.task_config["memory"] * 1024**3),
                    "scratch": self.evaluation_config["scratch_directory"],
                },
            )
        self.call("outer-forwarded-input-after.json", frame_input.encode())
        synthetic_native_trace(
            outer_input,
            {
                "run_id": "current",
                "run_nonce": "a" * 32,
                **self.base,
                "contract_hash": self.contract["contract_hash"],
                "outer_input_sha256": outer_request_ref["sha256"],
            },
            lambda name, value, raw: self.call(name, value.encode() if raw else value),
            timestamp=112.0,
        )
        self.create_brackets()

    def put(self, path, value):
        raw = value if type(value) is bytes else json.dumps(value).encode()
        self.storage[path] = raw
        return {"path": path, "sha256": hashlib.sha256(raw).hexdigest()}

    def call(self, name, value):
        ref = self.put(self.directory + "/evaluation-0/" + name, value)
        self.call_refs.append(ref)
        return ref

    def observer_file(self, name, value):
        ref = self.call("nested/" + name, value)
        self.inventory.append(
            {"name": name, "sha256": ref["sha256"], "bytes": len(self.storage[ref["path"]])}
        )

    def create_brackets(self):
        directory = self.directory + "/evaluation-0"
        observation_path = directory + "/dispatch-observation.json"
        self.call_refs = [r for r in self.call_refs if r["path"] != observation_path]
        dispatch = {
            "evaluation_id": self.entry["evaluation_id"],
            "outer_forwarded": True,
            "nested_summary_present": self.entry["observer_summary"] is not None,
            "artifacts": [
                {**r, "bytes": len(self.storage[r["path"]])}
                for r in self.call_refs
                if Path(r["path"]).parent.as_posix() == directory
            ],
        }
        if self.entry["observer_summary"] is not None:
            nested_ref = self.entry["observer_summary"]
            dispatch["nested_summary"] = {
                **nested_ref,
                "bytes": len(self.storage[nested_ref["path"]]),
            }
        self.entry["dispatch_observation"] = self.put(observation_path, dispatch)
        self.call_refs.append(self.entry["dispatch_observation"])
        common = {
            "version": "refinement-observer-host-bracket/v1",
            "run_id": "current",
            "run_nonce": "a" * 32,
            "spec_hash": self.spec["spec_hash"],
            "contract_hash": self.contract["contract_hash"],
            "worker_identity": self.worker,
            "source_identity": self.source,
            "runtime_binding_hash": self.spec["runtime_binding"]["binding_hash"],
            "basis_binding_hash": self.spec["basis_binding"]["binding_hash"],
            "native_task_config": self.task_config,
            "native_dispersion_version": "1.6.0",
        }
        before = self.put(
            self.directory + "/host-before.json",
            {**common, "phase": "before", "monotonic_seconds": 100.0, "call_artifacts": []},
        )
        after = self.put(
            self.directory + "/host-after.json",
            {
                **common,
                "phase": "after",
                "monotonic_seconds": 200.0,
                "call_artifacts": self.call_refs,
            },
        )
        self.context = evidence.HostContext(
            run_id="current",
            run_nonce="a" * 32,
            run_directory=self.directory,
            worker_identity=self.worker,
            source_identity=self.source,
            native_task_config=self.task_config,
            native_dispersion_version="1.6.0",
            host_before=before,
            host_after=after,
        )
        self.envelope = {
            "version": evidence.VERSION,
            "run_id": "current",
            "run_nonce": "a" * 32,
            "contract_hash": self.contract["contract_hash"],
            "spec_hash": self.spec["spec_hash"],
            "result_hash": self.result["result_hash"],
            "host_before": before,
            "host_after": after,
            "evaluations": [self.entry],
            "optimizer_evidence": None,
        }

    def assess(self):
        body = {k: v for k, v in self.envelope.items() if k != "evidence_hash"}
        ref = self.put(
            self.directory + "/evidence.json", {**body, "evidence_hash": evidence.digest(body)}
        )

        def read(reference):
            if reference["path"] in self.storage:
                return self.storage[reference["path"]]
            # Only genuine existing spec refs, never a scientific invocation.
            return read_bound_artifact(reference)

        return evidence.assess_contract_result(
            self.contract,
            self.spec,
            "gradient",
            self.result,
            evidence_ref=ref,
            host_context=self.context,
            read_artifact=read,
            validate_contract=execution_contract.validate_execution_contract,
            validate_scientific_result=lambda spec, result: copy.deepcopy(result),
            validate_optimizer_evidence=None,
        )


def test_complete_mock_trace_counts_layers_separately(spec):
    run = MockRun(spec)
    result = run.assess()
    assert result["complete"] is True, result["errors"]
    assert result["outer_entries_declared"] == 1
    assert result["evaluations"][0]["durable_counts"] == {key: 2 for key in evidence.COUNTS}
    assert result["scientific_accuracy_validated"] is False
    assert result["minimum_certified"] is False


@pytest.mark.parametrize(
    "change",
    [
        "run_nonce",
        "worker",
        "source",
        "raw_hash",
        "retry",
        "missing_summary",
        "missing_return",
        "extra_call",
        "declared_counter",
        "old_clock",
        "parent",
    ],
)
def test_complete_claim_denied_for_mutated_or_partial_trace(spec, change):
    run = MockRun(spec)
    if change == "run_nonce":
        run.envelope["run_nonce"] = "b" * 32
    elif change == "worker":
        run.context = replace(
            run.context, worker_identity={"kind": "psi4_refinement", "fixture": "other"}
        )
    elif change == "source":
        run.storage["mock/source.py"] = b"changed source"
    elif change == "raw_hash":
        run.storage[run.nested + "/qce-0000-request.json"] = b"changed raw input"
    elif change == "missing_summary":
        run.entry["observer_summary"] = None
    elif change == "missing_return":
        path = run.nested + "/inner-0001-return.json"
        run.call_refs = [r for r in run.call_refs if r["path"] != path]
        run.create_brackets()
    elif change == "extra_call":
        run.call(
            "nested/qce-0002-start.json",
            {**run.base, "monotonic_seconds": 150.0, "program": "s-dftd3"},
        )
        run.create_brackets()
    else:
        if change == "retry":
            name = "qce-0000-forwarded-config.json"
            value = {**run.evaluation_config, "retries": 1}
        elif change == "declared_counter":
            name = "summary.json"
            value = copy.deepcopy(run.summary)
            value["counts"]["inner_calls_returned"] = True
        elif change == "old_clock":
            name = "context-start.json"
            value = native.parse(run.storage[run.nested + "/" + name])
            value["monotonic_seconds"] = 90.0
        else:
            name = "inner-0000-start.json"
            value = native.parse(run.storage[run.nested + "/" + name])
            value["parent_qce_call"] = "qce-0001"
        # Rehash the altered inventory, summary and bracket to reach semantic checks.
        path = run.nested + "/" + name
        newref = run.put(path, value)
        run.call_refs = [newref if r["path"] == path else r for r in run.call_refs]
        if name != "summary.json":
            run.summary["artifacts"] = [
                {"name": item["name"], "sha256": newref["sha256"], "bytes": len(run.storage[path])}
                if item["name"] == name
                else item
                for item in run.summary["artifacts"]
            ]
            summary_path = run.nested + "/summary.json"
            summaryref = run.put(summary_path, run.summary)
            run.call_refs = [summaryref if r["path"] == summary_path else r for r in run.call_refs]
            run.entry["observer_summary"] = summaryref
        else:
            run.entry["observer_summary"] = newref
        run.create_brackets()
    result = run.assess()
    assert result["complete"] is False
    assert result["errors"]
    assert result["scientific_result_hash"] == run.result["result_hash"]


def test_missing_summary_preserves_durable_counters_without_assuming_zero(spec):
    run = MockRun(spec)
    run.entry["observer_summary"] = None
    result = run.assess()
    assert result["complete"] is False
    assert result["evaluations"][0]["summary_declared_counts"] is None
    assert result["evaluations"][0]["durable_counts"]["qce_calls_seen"] == 2


def test_failed_outer_and_native_exception_records_survive_assessment(spec):
    run = MockRun(spec)
    run.result["trajectory"] = []
    run.entry["frame_hash"] = None
    run.entry["outer_return"] = None
    exception = run.call("outer-exception.json", {"type": "MockFailure", "message": "synthetic"})
    run.entry["outer_exception"] = exception
    run.call(
        "nested/inner-0001-exception.json",
        {**run.base, "monotonic_seconds": 132.0, "type": "MockFailure", "message": "synthetic"},
    )
    run.summary["context_exception"] = {"type": "MockFailure", "message": "synthetic"}
    run.entry["observer_summary"] = None
    run.create_brackets()
    result = run.assess()
    assert result["complete"] is False
    assert result["outer_observed_counts"]["exceptions_read"] == 1
    assert result["outer_observed_counts"]["successful_frames_bound"] == 0
    assert result["evaluations"][0]["exception_artifacts"]
    assert result["evaluations"][0]["summary_declared_counts"] is None


def test_boolean_byte_reader_claim_cannot_authenticate_evidence(spec):
    run = MockRun(spec)
    result = evidence.assess_contract_result(
        run.contract,
        spec,
        "gradient",
        run.result,
        evidence_ref={"path": run.directory + "/evidence.json", "sha256": "a" * 64},
        host_context=run.context,
        read_artifact=lambda _: True,
        validate_contract=execution_contract.validate_execution_contract,
        validate_scientific_result=lambda _, result: result,
        validate_optimizer_evidence=None,
    )
    assert result["complete"] is False
    assert "actual bytes" in str(result["errors"])


def test_historical_parity_cannot_be_promoted_as_current_run_evidence(spec):
    run = MockRun(spec)
    raw = (PARITY / "receipt.json").read_bytes()
    result = evidence.assess_contract_result(
        run.contract,
        spec,
        "gradient",
        run.result,
        evidence_ref={
            "path": (PARITY / "receipt.json").relative_to(ROOT).as_posix(),
            "sha256": hashlib.sha256(raw).hexdigest(),
        },
        host_context=run.context,
        read_artifact=lambda _: raw,
        validate_contract=execution_contract.validate_execution_contract,
        validate_scientific_result=lambda _, result: result,
        validate_optimizer_evidence=None,
    )
    assert result["complete"] is False
    assert "current owned run" in str(result["errors"])


def test_strict_plan_callback_rejects_missing_real_evidence(spec):
    run = MockRun(spec)
    with pytest.raises(ValueError, match="EVIDENCE_REJECTED"):
        evidence.validate_contract_result(
            run.contract,
            spec,
            "gradient",
            run.result,
            evidence_ref={"path": run.directory + "/missing.json", "sha256": "a" * 64},
            host_context=run.context,
            read_artifact=lambda _: b"{}",
            validate_contract=execution_contract.validate_execution_contract,
            validate_scientific_result=lambda _, result: result,
            validate_optimizer_evidence=None,
        )


@pytest.mark.parametrize(
    "change", ["memory", "bool_threads", "scratch", "retry", "error_mode", "missing_after"]
)
def test_actual_native_dispatch_controls_are_required(spec, change):
    run = MockRun(spec)
    name = (
        "outer-dispatch-controls.json"
        if change in {"retry", "error_mode"}
        else "native-controls-after.json"
    )
    path = run.directory + "/evaluation-0/" + name
    value = native.parse(run.storage[path])
    if change == "memory":
        value["memory_bytes"] -= 1
    elif change == "bool_threads":
        value["threads"] = True
    elif change == "scratch":
        value["scratch"] = "C:\\mock\\other"
    elif change == "retry":
        value["forwarded_task_config"]["retries"] = 1
    elif change == "error_mode":
        value["raise_error"] = True
    if change == "missing_after":
        run.call_refs = [r for r in run.call_refs if r["path"] != path]
    else:
        ref = run.put(path, value)
        run.call_refs = [ref if r["path"] == path else r for r in run.call_refs]
    run.create_brackets()
    result = run.assess()
    assert result["complete"] is False
    assert any("dispatcher" in message for message in result["errors"])
    assert result["evaluations"][0]["durable_counts"]["inner_calls_seen"] == 2


def test_native_forwarded_input_mutation_is_retained_without_replacing_frame(spec):
    run = MockRun(spec)
    path = run.directory + "/evaluation-0/outer-forwarded-input-after.json"
    value = native.parse(run.storage[path])
    value["extras"]["native_mutation_fixture"] = "observed only"
    before = copy.deepcopy(run.result)
    ref = run.put(path, value)
    run.call_refs = [ref if r["path"] == path else r for r in run.call_refs]
    run.create_brackets()
    result = run.assess()
    assert result["complete"] is True, result["errors"]
    assert result["dispatch_observations"][0]["forwarded_input_changed"] is True
    assert run.result == before
