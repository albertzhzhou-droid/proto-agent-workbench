"""Product pipeline with injected synthetic native values and host identity.

Retained 34-atom request bytes supply input shape only. Every native runtime,
energy, gradient, host identity and invocation here is synthetic. The original
parity result files are never read or represented as new native calculations.
"""

from __future__ import annotations

import copy
import hashlib
import json
import stat
import sys
import time
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from refinement_evidence_fixtures import read_bound_artifact
from refinement_schema_fixture import SyntheticSchema
from test_refinement_execution_recorder import Array, AtomicInput, JsonEnvelope, Molecule

from chem_workbench import molecular_refinement as records
from chem_workbench.refinement_execution import contract_result_evidence as evidence
from chem_workbench.refinement_execution import execution_contract
from chem_workbench.refinement_execution.observed_dispatch import ObservedPsiapiDispatch
from chem_workbench.refinement_execution.refinement_recorder import StagedGradientRecorder

ROOT = Path(__file__).resolve().parents[1]
STAGE = Path(__file__).resolve().parent
INPUT = "tests/fixtures/refinement_evidence_product/input.json"
PARITY = "tests/fixtures/refinement_evidence_product/parity/"
SOURCES = (
    "src/chem_workbench/refinement_backend.py",
    "src/chem_workbench/molecular_refinement.py",
    "src/chem_workbench/method_profiles.py",
    "src/chem_workbench/refinement_execution/execution_contract.py",
    "src/chem_workbench/refinement_execution/optimizer_policy.py",
    "src/chem_workbench/refinement_execution/nested_dispersion_observer.py",
    "src/chem_workbench/refinement_execution/observed_dispatch.py",
    "src/chem_workbench/refinement_execution/refinement_recorder.py",
    "tests/test_refinement_execution_recorder.py",
    "src/chem_workbench/refinement_execution/contract_result_evidence.py",
    "src/chem_workbench/refinement_execution/native_dispersion_records.py",
    "tests/refinement_evidence_fixtures.py",
    "tests/test_refinement_execution_pipeline.py",
    INPUT,
    PARITY + "bridge-qcengine-input.json",
    PARITY + "bridge-translated-dftd3-input.json",
)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def spec_refs(value):
    """Only explicitly declared retained spec artifacts can escape the test root."""
    found = set()
    if isinstance(value, dict):
        if {"path", "sha256"} <= set(value):
            found.add(value["path"])
        for item in value.values():
            found.update(spec_refs(item))
    elif isinstance(value, list):
        for item in value:
            found.update(spec_refs(item))
    return found


def contained_file(base, relative):
    """Bounded fixture reader with component checks, not a production supervisor."""
    candidate = base / relative
    assert candidate.resolve().is_relative_to(base.resolve())
    for component in (candidate, *candidate.parents):
        assert not component.is_symlink()
        attrs = getattr(component.stat(), "st_file_attributes", 0)
        assert not attrs & stat.FILE_ATTRIBUTE_REPARSE_POINT
        if component == base:
            break
    assert candidate.is_file() and candidate.stat().st_size <= 20 * 1024**2
    return candidate


class NativeModel:
    def __init__(self, body):
        self.body = copy.deepcopy(body)

    def json(self):
        return json.dumps(self.body, allow_nan=False)


class SyntheticPipeline:
    """Product mechanisms; fake runtimes and an explicitly fake supervisor."""

    def __init__(self, tmp_path, fault=None):
        self.root = tmp_path
        self.run = tmp_path / "synthetic-run"
        self.run.mkdir()
        self.call_dir = self.run / "evaluation-0000-dispatch"
        self.fault = fault
        self.denied_reads = set()
        self.spec = json.loads((ROOT / INPUT).read_bytes())["spec"]
        self.contract = execution_contract.seal_execution_contract(self.spec, "gradient")
        self.outer_template = json.loads(
            (ROOT / (PARITY + "bridge-qcengine-input.json")).read_bytes()
        )
        inner_template = json.loads(
            (ROOT / (PARITY + "bridge-translated-dftd3-input.json")).read_bytes()
        )
        self.translated_info = inner_template["specification"]["extras"]
        self.run_id = "synthetic-full-pipeline-test"
        self.run_nonce = "b" * 32
        self.source = {path: sha((ROOT / path).read_bytes()) for path in SOURCES}
        self.source_before = dict(self.source)
        self.repo_allowlist = set(SOURCES) | spec_refs(self.spec)
        self.worker = {
            "kind": "psi4_refinement",
            "identity": "explicitly-synthetic-supervisor-and-injected-runtimes",
            "synthetic_test_only": True,
            "native_process_started": False,
        }
        self.state = SimpleNamespace(
            scratch=str(self.root / "synthetic-original-scratch"),
            threads=1,
            memory=1000,
            outer_calls=0,
            qce_drivers=[],
            inner_drivers=[],
        )
        self.native_version = "1.6.0"  # Fixture-bound compatibility label, never a probe.
        self.dftd3 = SimpleNamespace(run_qcschema=self.inner)
        self.qce = SimpleNamespace(compute=self.compute)
        self.original_compute = self.qce.compute
        self.original_inner = self.dftd3.run_qcschema
        manager = SimpleNamespace(
            get_default_path=lambda: self.state.scratch,
            set_default_path=lambda value: setattr(self.state, "scratch", value),
        )
        self.psi4 = SimpleNamespace(
            core=SimpleNamespace(
                IOManager=SimpleNamespace(shared_object=lambda: manager),
                get_num_threads=lambda: self.state.threads,
                get_memory=lambda: self.state.memory,
            ),
            set_num_threads=lambda value: setattr(self.state, "threads", value),
            set_memory=lambda value: setattr(self.state, "memory", value),
        )
        self.schema = SyntheticSchema(self.psi4)
        self.dispatch = ObservedPsiapiDispatch(
            spec=self.spec,
            contract=self.contract,
            root=self.root,
            run_directory=self.run,
            run_id=self.run_id,
            run_nonce=self.run_nonce,
            qcengine=self.qce,
            psi4=self.psi4,
            dftd3_qcschema=self.dftd3,
        )
        modules = {
            "qcelemental": SimpleNamespace(
                models=SimpleNamespace(
                    Molecule=Molecule, AtomicInput=AtomicInput, AtomicResult=JsonEnvelope
                )
            ),
            "qcengine": self.qce,
            "psi4": self.psi4,
            "numpy": SimpleNamespace(asarray=Array),
            "qcelemental.util.serialization": SimpleNamespace(json_dumps=json.dumps),
        }
        self.recorder = StagedGradientRecorder(
            self.spec,
            self.run / "output.json",
            self.root,
            import_module=modules.__getitem__,
            dispatch=self.dispatch,
        )
        self.config = copy.deepcopy(self.recorder.task_config)

    def inner(self, request):
        body = request.body
        driver = body["specification"]["driver"]
        self.state.inner_drivers.append(driver)
        if self.fault == "missing_nested_return" and driver == "gradient":
            raise RuntimeError("synthetic inner gradient failed before a return")
        gradient = [[0.001, -0.002, 0.003] for _ in range(34)]
        library = {"energy": -0.0125}
        if driver == "gradient":
            library["gradient"] = gradient
        return NativeModel(
            {
                "schema_name": "qcschema_atomic_result",
                "schema_version": 2,
                "id": None,
                "input_data": copy.deepcopy(body),
                "molecule": copy.deepcopy(body["molecule"]),
                "properties": {
                    "schema_name": "qcschema_atomic_properties",
                    "return_energy": -0.0125,
                },
                "return_result": -0.0125
                if driver == "energy"
                else [coordinate for row in gradient for coordinate in row],
                "wavefunction": None,
                "stdout": "Explicit synthetic fixture; no native calculation was performed.",
                "stderr": None,
                "native_files": {},
                "success": True,
                "provenance": {
                    "creator": "s-dftd3",
                    "version": self.native_version,
                    "routine": "synthetic.fixture",
                },
                "extras": {"dftd3": library, "synthetic_test_only": True},
            }
        )

    def compute(self, request, program, **kwargs):
        if program == "psi4" and not self.schema.in_gradient:
            return self.schema.compute(request, lambda: self.compute(request, program, **kwargs))
        if program == "s-dftd3":
            assert kwargs["return_version"] == 2 and kwargs["task_config"]["retries"] == 0
            body = copy.deepcopy(request.body)
            self.state.qce_drivers.append(body["specification"]["driver"])
            native = body["specification"]
            native["model"]["method"] = "wb97x"
            native["keywords"].pop("apply_qcengine_aliases")
            native["keywords"]["level_hint"] = "d3bj"
            native["keywords"]["params_tweaks"]["s9"] = 0.0
            native["extras"] = copy.deepcopy(self.translated_info)
            return self.dftd3.run_qcschema(NativeModel(body))
        assert program == "psi4" and kwargs["return_version"] == 1
        assert kwargs["raise_error"] is False and kwargs["task_config"]["retries"] == 0
        self.state.outer_calls += 1
        atomic_input = request.payload
        for driver in ("energy", "gradient"):
            body = copy.deepcopy(self.outer_template)
            body["specification"]["driver"] = driver
            body["molecule"]["geometry"] = copy.deepcopy(atomic_input["molecule"]["geometry"])
            body["provenance"] = {
                "creator": "Psi4",
                "version": self.spec["runtime_binding"]["versions"]["psi4"],
                "routine": "synthetic.fixture",
            }
            self.qce.compute(
                NativeModel(body),
                "s-dftd3",
                raise_error=True,
                return_version=2,
                task_config={"ncores": self.state.threads, "scratch_directory": self.state.scratch},
            )
        if self.fault == "native_input_mutation":
            atomic_input["extras"]["synthetic_native_mutation"] = True
        body = copy.deepcopy(atomic_input)
        body.update(
            schema_name="qcschema_output",
            success=self.fault != "native_failure",
            properties={"return_energy": -100.0},
            return_result=[[0.0, 0.0, 0.0] for _ in range(34)],
            provenance={
                "creator": "Psi4",
                "version": self.spec["runtime_binding"]["versions"]["psi4"],
            },
        )
        body["extras"]["synthetic_test_only"] = True
        if self.fault == "native_failure":
            body["error"] = {"error_type": "unknown_error", "error_message": "synthetic failure"}
        if self.fault == "wrong_controls":
            self.state.threads += 1
        self.native_returned = JsonEnvelope(**body)
        return self.native_returned

    def ref(self, path):
        if not path.is_file():
            return None
        raw = path.read_bytes()
        return {"path": path.relative_to(self.root).as_posix(), "sha256": sha(raw)}

    def put(self, path, body):
        path.write_bytes(json.dumps(body, allow_nan=False, indent=2).encode("utf-8"))
        return self.ref(path)

    def inventory(self):
        # Independent filesystem enumeration, never copied from worker observations.
        return [self.ref(path) for path in sorted(self.call_dir.rglob("*")) if path.is_file()]

    def bracket(self, phase, inventory):
        return self.put(
            self.run / f"host-{phase}.json",
            {
                "version": "refinement-observer-host-bracket/v1",
                "phase": phase,
                "run_id": self.run_id,
                "run_nonce": self.run_nonce,
                "spec_hash": self.spec["spec_hash"],
                "contract_hash": self.contract["contract_hash"],
                "worker_identity": self.worker,
                "source_identity": self.source,
                "runtime_binding_hash": self.spec["runtime_binding"]["binding_hash"],
                "basis_binding_hash": self.spec["basis_binding"]["binding_hash"],
                "native_task_config": self.config,
                "native_dispersion_version": self.native_version,
                "monotonic_seconds": time.monotonic(),
                "call_artifacts": inventory,
            },
        )

    def execute(self):
        assert not self.call_dir.exists()
        before = self.bracket("before", [])
        self.failure = None
        try:
            self.recorder.evaluate(json.loads(self.recorder.molecule(self.spec["geometry"]).json()))
        except (ValueError, RuntimeError) as error:
            self.failure = error
        self.result = self.recorder.result(None, self.failure)
        assert records.validate_refinement_result(self.spec, self.result) == self.result
        if self.fault == "extra_call_file":
            self.put(self.call_dir / "undisclosed-synthetic-call.json", {"synthetic": True})
        self.host_inventory = self.inventory()
        after = self.bracket("after", self.host_inventory)
        assert {path: sha((ROOT / path).read_bytes()) for path in SOURCES} == self.source_before
        self.context = evidence.HostContext(
            run_id=self.run_id,
            run_nonce=self.run_nonce,
            run_directory=self.run.relative_to(self.root).as_posix(),
            worker_identity=copy.deepcopy(self.worker),
            source_identity=copy.deepcopy(self.source),
            native_task_config=copy.deepcopy(self.config),
            native_dispersion_version=self.native_version,
            host_before=before,
            host_after=after,
        )
        frames = self.result["trajectory"]
        start = json.loads((self.call_dir / "outer-start.json").read_bytes())
        entry = {
            "evaluation_id": start["evaluation_id"],
            "attempt_index": 0,
            "frame_hash": frames[0]["frame_hash"] if frames else None,
            "outer_start": self.ref(self.call_dir / "outer-start.json"),
            "outer_request": self.ref(self.call_dir / "outer-input.json"),
            "outer_return": self.ref(self.call_dir / "outer-result.json"),
            "outer_exception": self.ref(self.call_dir / "outer-exception.json"),
            "observer_directory": (self.call_dir / "nested").relative_to(self.root).as_posix(),
            "observer_summary": self.ref(self.call_dir / "nested/summary.json"),
            "dispatch_observation": self.ref(self.call_dir / "dispatch-observation.json"),
        }
        body = {
            "version": evidence.VERSION,
            "run_id": self.run_id,
            "run_nonce": self.run_nonce,
            "contract_hash": self.contract["contract_hash"],
            "spec_hash": self.spec["spec_hash"],
            "result_hash": self.result["result_hash"],
            "host_before": before,
            "host_after": after,
            "evaluations": [entry],
            "optimizer_evidence": None,
        }
        self.evidence_ref = self.put(
            self.run / "execution-evidence.json", {**body, "evidence_hash": evidence.digest(body)}
        )
        self.put(self.run / "synthetic-scientific-result.json", self.result)
        assert self.qce.compute is self.original_compute
        assert self.dftd3.run_qcschema is self.original_inner
        assert self.state.scratch.endswith("synthetic-original-scratch")
        assert not {"psi4", "qcengine", "qcelemental", "optking", "dftd3"} & sys.modules.keys()
        return self

    def read(self, reference):
        relative = reference["path"]
        if relative in self.denied_reads:
            raise FileNotFoundError("synthetic unavailable artifact: " + relative)
        if relative in spec_refs(self.spec):
            return read_bound_artifact(reference)
        base = ROOT if relative in self.repo_allowlist else self.root
        return contained_file(base, relative).read_bytes()

    def kwargs(self):
        return {
            "evidence_ref": self.evidence_ref,
            "host_context": self.context,
            "read_artifact": self.read,
            "validate_contract": execution_contract.validate_execution_contract,
            "validate_scientific_result": records.validate_refinement_result,
            "validate_optimizer_evidence": None,
        }

    def assess(self):
        assessment = evidence.assess_contract_result(
            self.contract, self.spec, "gradient", self.result, **self.kwargs()
        )
        self.put(self.run / "execution-assessment.json", assessment)
        return assessment

    def assert_rejected(self):
        assessment = self.assess()
        assert assessment["complete"] is False and assessment["errors"]
        assert assessment["scientific_accuracy_validated"] is False
        assert assessment["minimum_certified"] is False
        assert records.validate_refinement_result(self.spec, self.result) == self.result
        with pytest.raises(ValueError):
            evidence.validate_contract_result(
                self.contract, self.spec, "gradient", self.result, **self.kwargs()
            )
        assert (self.call_dir / "outer-input.json").is_file()
        assert (self.call_dir / "nested/summary.json").is_file()
        return assessment


def rebind_synthetic_native_artifact(run, name, mutate):
    """Rehash all fake supervisor refs so tests reach semantic admission checks."""
    path = run.call_dir / name
    value = json.loads(path.read_bytes())
    mutate(value)
    reference = run.put(path, value)
    diagnostic_path = run.call_dir / "dispatch-observation.json"
    diagnostic = json.loads(diagnostic_path.read_bytes())
    for artifact in diagnostic["artifacts"]:
        if artifact["path"] == reference["path"]:
            artifact.update(reference, bytes=path.stat().st_size)
    diagnostic_ref = run.put(diagnostic_path, diagnostic)
    run.host_inventory = run.inventory()
    after = run.bracket("after", run.host_inventory)
    run.context = replace(run.context, host_after=after)
    envelope_path = run.run / "execution-evidence.json"
    envelope = json.loads(envelope_path.read_bytes())
    envelope.pop("evidence_hash")
    envelope["host_after"] = after
    envelope["evaluations"][0]["dispatch_observation"] = diagnostic_ref
    run.evidence_ref = run.put(
        envelope_path, {**envelope, "evidence_hash": evidence.digest(envelope)}
    )


@pytest.mark.parametrize(
    "field",
    [
        "effective_options",
        "function_kwargs",
        "outer_input_sha256",
        "evaluation_id",
        "option_scopes",
    ],
)
def test_independent_admission_rejects_fully_rehashed_native_entry_tamper(tmp_path, field):
    run = SyntheticPipeline(tmp_path).execute()

    def mutate(value):
        if field == "effective_options":
            value[field]["d_convergence"] = 1e-6
        elif field == "function_kwargs":
            value[field]["dertype"] = 0
        elif field == "option_scopes":
            value[field]["d_convergence"]["global_changed"] = False
        else:
            value[field] = "wrong"

    rebind_synthetic_native_artifact(run, "native-gradient-entry.json", mutate)
    assessment = run.assert_rejected()
    assert any("native schema" in error for error in assessment["errors"])


def test_successful_raw_result_does_not_replace_missing_entry_evidence(tmp_path):
    run = SyntheticPipeline(tmp_path).execute()
    run.denied_reads.add(
        (run.call_dir / "native-gradient-entry.json").relative_to(run.root).as_posix()
    )
    assert run.result["trajectory"][0]["raw_result_json"]
    run.assert_rejected()


def test_complete_real_staged_pipeline_is_execution_complete_and_scientifically_incomplete(
    tmp_path,
):
    run = SyntheticPipeline(tmp_path).execute()
    assessment = run.assess()
    assert assessment["complete"] is True, assessment["errors"]
    evidence.validate_contract_result(
        run.contract, run.spec, "gradient", run.result, **run.kwargs()
    )
    assert run.result["state"] == "incomplete"
    assert run.result["timing"]["backend_attempts_observed"] == 1
    assert len(run.result["trajectory"]) == 1 and run.state.outer_calls == 1
    assert run.state.qce_drivers == run.state.inner_drivers == ["energy", "gradient"]
    frame = run.result["trajectory"][0]
    assert len(frame["geometry"]["atoms"]) == 34
    assert frame["geometry"] == run.spec["geometry"]
    assert (run.call_dir / "outer-input.json").read_bytes() == frame["raw_input_json"].encode()
    assert (run.call_dir / "outer-result.json").read_bytes() == frame["raw_result_json"].encode()
    assert assessment["evaluations"][0]["durable_counts"] == {key: 2 for key in evidence.COUNTS}
    assert assessment["outer_observed_counts"] == {
        "starts_read": 1,
        "returns_read": 1,
        "exceptions_read": 0,
        "successful_frames_bound": 1,
    }
    assert assessment["scientific_accuracy_validated"] is False
    assert assessment["minimum_certified"] is False
    observed = {item["reference"]["path"] for item in assessment["artifact_observations"]}
    assert {item["path"] for item in run.host_inventory} <= observed
    assert run.context.worker_identity["synthetic_test_only"] is True


@pytest.mark.parametrize("fault", ["native_failure", "missing_nested_return", "wrong_controls"])
def test_failed_native_or_controls_preserve_partial_and_deny_completion(tmp_path, fault):
    run = SyntheticPipeline(tmp_path, fault).execute()
    assessment = run.assert_rejected()
    assert run.failure is not None and run.result["state"] == "failed"
    assert run.result["trajectory"] == []
    assert run.result["timing"]["backend_attempts_observed"] == 1
    assert assessment["outer_observed_counts"]["starts_read"] == 1
    summary = json.loads((run.call_dir / "nested/summary.json").read_bytes())
    if fault == "missing_nested_return":
        assert summary["counts"]["inner_calls_forwarded"] == 2
        assert summary["counts"]["inner_calls_returned"] == 1
        durable = assessment["evaluations"][0]["durable_counts"]
        assert durable["inner_calls_forwarded"] == durable["qce_calls_forwarded"] == 2
        assert durable["inner_calls_returned"] == durable["qce_calls_returned"] == 1
        assert len(assessment["evaluations"][0]["exception_artifacts"]) == 2
        assert (run.call_dir / "nested/inner-0001-exception.json").is_file()
        assert not (run.call_dir / "nested/inner-0001-return.json").exists()
        assert not (run.call_dir / "outer-result.json").exists()
    else:
        assert all(value == 2 for value in summary["counts"].values())
        returned = json.loads((run.call_dir / "outer-result.json").read_bytes())
        assert returned["success"] is (fault == "wrong_controls")
    if fault == "wrong_controls":
        controls = json.loads((run.call_dir / "native-controls-after.json").read_bytes())
        assert controls["threads"] != run.spec["resources"]["threads"]
        assert any("native thread" in error for error in assessment["errors"])


@pytest.mark.parametrize("filename", ["outer-result.json", "nested/inner-0001-return.json"])
def test_changed_raw_bytes_deny_completion_and_keep_original_and_scientific_frame(
    tmp_path, filename
):
    run = SyntheticPipeline(tmp_path).execute()
    target = run.call_dir / filename
    original = target.read_bytes()
    backup = run.run / "retained-original-before-synthetic-tamper.json"
    backup.write_bytes(original)
    target.write_bytes(original + b"\n")
    assessment = run.assert_rejected()
    assert any("actual bytes/hash mismatch" in error for error in assessment["errors"])
    assert backup.read_bytes() == original and target.read_bytes() == original + b"\n"
    assert run.result["state"] == "incomplete" and len(run.result["trajectory"]) == 1


def test_unavailable_nested_return_denies_completion_without_deleting_partial_bytes(tmp_path):
    run = SyntheticPipeline(tmp_path).execute()
    missing = run.call_dir / "nested/inner-0001-return.json"
    original = missing.read_bytes()
    run.denied_reads.add(missing.relative_to(run.root).as_posix())
    assessment = run.assert_rejected()
    assert any("FileNotFoundError" in error for error in assessment["errors"])
    assert missing.read_bytes() == original
    assert run.result["state"] == "incomplete"


def test_independent_inventory_exposes_unlisted_emitted_file(tmp_path):
    run = SyntheticPipeline(tmp_path, "extra_call_file").execute()
    assessment = run.assert_rejected()
    assert any("inventory" in error or "disclosed" in error for error in assessment["errors"])
    assert any(
        item["path"].endswith("undisclosed-synthetic-call.json") for item in run.host_inventory
    )
    assert run.result["state"] == "incomplete"


def test_native_input_mutation_is_disclosed_without_replacing_original_bytes(tmp_path):
    run = SyntheticPipeline(tmp_path, "native_input_mutation").execute()
    assessment = run.assess()
    assert assessment["complete"] is True, assessment["errors"]
    assert run.result["state"] == "incomplete"
    original = json.loads((run.call_dir / "outer-input.json").read_bytes())
    forwarded = json.loads((run.call_dir / "outer-forwarded-input-after.json").read_bytes())
    assert original["extras"] == {"psiapi": True}
    assert forwarded["extras"]["synthetic_native_mutation"] is True
    assert assessment["dispatch_observations"][0]["forwarded_input_changed"] is True
