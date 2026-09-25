"""Pure transport mocks with the actual 34-atom input; no computed values accepted."""

import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from refinement_schema_fixture import SyntheticSchema

from chem_workbench.refinement_execution.execution_contract import seal_execution_contract
from chem_workbench.refinement_execution.observed_dispatch import ObservedPsiapiDispatch

ROOT = Path(__file__).resolve().parents[1]


class Model:
    def __init__(self, body):
        self.body = copy.deepcopy(body)

    def json(self):
        return json.dumps(self.body, allow_nan=False)


@pytest.fixture
def harness(tmp_path):
    spec = json.loads((ROOT / "tests/fixtures/refinement_evidence_product/input.json").read_text())[
        "spec"
    ]
    nested = json.loads(
        (
            ROOT / "tests/fixtures/refinement_evidence_product/parity/bridge-qcengine-input.json"
        ).read_text()
    )
    contract = seal_execution_contract(spec, "gradient")
    state = SimpleNamespace(
        scratch=str(tmp_path / "original-scratch"),
        threads=1,
        memory=1000,
        reject_controls=False,
        mutate=False,
        drift=False,
        fail_inner=False,
        outer_calls=0,
        inner_calls=0,
        returned=None,
        spec=spec,
        root=tmp_path,
    )
    outer_input = Model(
        {
            "schema_name": "qcschema_input",
            "schema_version": 1,
            "driver": "gradient",
            "extras": {"psiapi": True},
            "keywords": spec["electronic_settings"]["native_keywords"],
            "model": {"method": spec["profile"]["method"], "basis": spec["profile"]["basis"]},
            "molecule": nested["molecule"],
        }
    )

    def inner(request):
        state.inner_calls += 1
        if state.fail_inner:
            raise RuntimeError("synthetic inner D3 failure")
        return Model({"success": True, "input_data": request.body, "return_result": [0.0] * 102})

    dftd3 = SimpleNamespace(run_qcschema=inner)

    def compute(request, program, **kwargs):
        if program == "psi4" and not state.schema.in_gradient:
            return state.schema.compute(request, lambda: compute(request, program, **kwargs))
        if program == "psi4":
            state.outer_calls += 1
            assert kwargs["return_version"] == 1
            assert kwargs["task_config"]["retries"] == 0
            if state.mutate:
                request.body["extras"]["mutated_in_backend"] = True
            for driver in ("energy", "gradient"):
                body = copy.deepcopy(nested)
                body["specification"]["driver"] = driver
                qce.compute(
                    Model(body),
                    "s-dftd3",
                    raise_error=True,
                    return_version=2,
                    task_config={"ncores": state.threads, "scratch_directory": state.scratch},
                )
            state.returned = Model(
                {
                    **copy.deepcopy(request.body),
                    "schema_name": "qcschema_output",
                    "success": True,
                    "return_result": [[0.0] * 3 for _ in range(34)],
                    "provenance": {"creator": "synthetic_transport_fixture"},
                }
            )
            if state.drift:
                state.threads += 1
            return state.returned
        assert program == "s-dftd3"
        assert kwargs["task_config"]["retries"] == 0
        translated = copy.deepcopy(request)
        return dftd3.run_qcschema(translated)

    qce = SimpleNamespace(compute=compute)

    def set_threads(value):
        if not state.reject_controls:
            state.threads = value

    def set_memory(value):
        state.memory = value

    def set_scratch(value):
        state.scratch = value

    manager = SimpleNamespace(get_default_path=lambda: state.scratch, set_default_path=set_scratch)
    psi4 = SimpleNamespace(
        core=SimpleNamespace(
            IOManager=SimpleNamespace(shared_object=lambda: manager),
            get_num_threads=lambda: state.threads,
            get_memory=lambda: state.memory,
        ),
        set_num_threads=set_threads,
        set_memory=set_memory,
    )
    state.psi4 = psi4
    state.schema = SyntheticSchema(psi4)
    state.dispatch = ObservedPsiapiDispatch(
        spec=spec,
        contract=contract,
        root=tmp_path,
        run_directory=tmp_path,
        run_id="synthetic-dispatch-test",
        run_nonce="a" * 32,
        qcengine=qce,
        psi4=psi4,
        dftd3_qcschema=dftd3,
    )
    state.input = outer_input
    state.qce, state.original_compute = qce, compute
    state.dftd3, state.original_inner = dftd3, inner
    state.config = {
        "ncores": spec["resources"]["threads"],
        "memory": spec["resources"]["memory_bytes"] / 1024**3 * 0.6,
        "retries": 0,
        "scratch_directory": str(tmp_path / "scratch"),
    }
    state.invoke = lambda: state.dispatch(
        state.input, "psi4", raise_error=False, task_config=state.config
    )
    return state


def read(harness, name):
    return json.loads((harness.root / "evaluation-0000-dispatch" / name).read_text())


def test_outer_genuine_result_and_two_nested_calls_are_retained(harness):
    before = harness.input.json()
    returned = harness.invoke()
    assert returned is harness.returned
    assert len(harness.input.body["molecule"]["symbols"]) == 34
    assert harness.input.json() == before
    assert harness.outer_calls == 1 and harness.inner_calls == 2
    summary = read(harness, "nested/summary.json")
    assert all(value == 2 for value in summary["counts"].values())
    assert summary["restoration_errors"] == []
    assert read(harness, "outer-input.json") == harness.input.body
    assert read(harness, "outer-result.json") == returned.body
    start = read(harness, "outer-start.json")
    assert start["version"] == "refinement-electronic-call-start/v1"
    assert start["run_nonce"] == "a" * 32
    assert start["task_config"]["scratch_directory"].endswith("evaluation-0000")
    assert harness.qce.compute is harness.original_compute
    assert harness.dftd3.run_qcschema is harness.original_inner
    assert harness.scratch.endswith("original-scratch")


def test_outer_input_mutation_isolated_and_original_return_preserved(harness):
    harness.mutate = True
    original = harness.input.json()
    result = harness.invoke()
    assert harness.input.json() == original
    assert result.body["extras"]["mutated_in_backend"] is True
    assert read(harness, "outer-forwarded-input-after.json")["extras"]["mutated_in_backend"] is True


@pytest.mark.parametrize(
    "key,value",
    [("retries", 1), ("retries", False), ("ncores", 4), ("memory", 1.0), ("unknown", 0)],
)
def test_outer_resource_drift_rejected_before_forward(harness, key, value):
    harness.config[key] = value
    with pytest.raises(ValueError, match="bound route/resources"):
        harness.invoke()
    assert harness.outer_calls == harness.inner_calls == 0


@pytest.mark.parametrize(
    "extras", [{}, {"psiapi": 1}, {"psiapi": True, "_qcengine_local_config": {}}]
)
def test_psiapi_flag_is_explicit_exact_and_host_owned(harness, extras):
    harness.input.body["extras"] = extras
    with pytest.raises(ValueError, match="bound psiapi contract"):
        harness.invoke()
    assert harness.outer_calls == 0


def test_unapplied_native_controls_fail_before_forward_and_restore_observer(harness):
    harness.reject_controls = True
    with pytest.raises(ValueError, match="actual native controls"):
        harness.invoke()
    assert harness.outer_calls == 0
    assert read(harness, "outer-exception.json")["outer_forwarded"] is False
    assert harness.qce.compute is harness.original_compute
    assert harness.scratch.endswith("original-scratch")


def test_native_control_drift_after_result_preserves_raw_return(harness):
    harness.drift = True
    with pytest.raises(ValueError, match="actual native controls"):
        harness.invoke()
    assert read(harness, "outer-result.json")["success"] is True
    assert read(harness, "outer-exception.json")["outer_forwarded"] is True
    assert harness.qce.compute is harness.original_compute


def test_inner_failure_keeps_partial_accounting_without_outer_success(harness):
    harness.fail_inner = True
    with pytest.raises(RuntimeError, match="inner D3 failure"):
        harness.invoke()
    counts = read(harness, "nested/summary.json")["counts"]
    assert counts["inner_calls_forwarded"] == 1 and counts["inner_calls_returned"] == 0
    assert not (harness.root / "evaluation-0000-dispatch/outer-result.json").exists()
    assert harness.scratch.endswith("original-scratch")
    assert harness.dispatch.active is False


def test_attempt_budget_prevents_a_second_dispatch(harness):
    harness.invoke()
    with pytest.raises(ValueError, match="outer dispatch budget"):
        harness.invoke()
    assert harness.outer_calls == 1


def test_existing_evaluation_directory_is_not_overwritten(harness):
    (harness.root / "evaluation-0000-dispatch").mkdir()
    with pytest.raises(FileExistsError):
        harness.invoke()
    assert harness.outer_calls == 0


def test_v2_schema_conversion_reads_options_after_actual_application(harness):
    harness.schema.input_version = 2
    # Pre-dispatch values differ. The actual schema applies its own input values.
    harness.schema.options.update(d_convergence=1e-6)
    harness.invoke()
    assert read(harness, "native-schema-input.json")["schema_version"] == 2
    observed = read(harness, "native-gradient-entry.json")
    assert observed["effective_options"]["d_convergence"] == 1e-9
    assert observed["option_scopes"]["d_convergence"]["global_changed"] is True
    assert harness.schema.options["d_convergence"] == 1e-6
    assert harness.psi4.schema_wrapper.run_qcschema is harness.schema.original_schema
    assert harness.psi4.schema_wrapper.methods_dict_["gradient"] is harness.schema.original_gradient


@pytest.mark.parametrize(
    "key,value", [("d_convergence", 1e-6), ("reference", "RHF"), ("df_scf_guess", True)]
)
def test_unapplied_schema_options_fail_before_actual_gradient(harness, key, value):
    harness.schema.before_gradient = lambda: harness.schema.options.update({key: value})
    with pytest.raises(ValueError, match="effective option"):
        harness.invoke()
    assert harness.outer_calls == harness.inner_calls == 0
    assert read(harness, "native-gradient-entry.json")["effective_options"][key] == value
    assert read(harness, "native-schema-observation.json")["counts"]["gradient_forwarded"] == 0


def test_matching_default_values_without_application_flags_are_rejected(harness):
    harness.schema.global_changed = False
    with pytest.raises(ValueError, match="explicit option"):
        harness.invoke()
    assert harness.outer_calls == 0


@pytest.mark.parametrize(
    "kwargs",
    [{"dertype": 0}, {"engine": "other"}, {"return_wfn": False}, {"restart_file": "unbound.npy"}],
)
def test_actual_gradient_arguments_are_verified_before_forwarding(harness, kwargs):
    harness.schema.gradient_kwargs = kwargs
    with pytest.raises(ValueError, match="native schema"):
        harness.invoke()
    assert harness.outer_calls == harness.inner_calls == 0


def test_actual_native_geometry_is_checked_before_forwarding(harness):
    def move(molecule):
        molecule["geometry"][0] += 0.1

    harness.schema.molecule_override = move
    with pytest.raises(ValueError, match="geometry"):
        harness.invoke()
    assert harness.outer_calls == 0
    assert (
        read(harness, "native-gradient-entry.json")["molecule"]["geometry"][0]
        != harness.input.body["molecule"]["geometry"][0]
    )


def test_missing_entry_cannot_be_replaced_by_successful_outer_result(harness):
    harness.schema.skip_gradient = True
    # Avoid re-entering the schema in this explicit adversarial fake backend.
    harness.schema.before_gradient = lambda: setattr(harness.schema, "in_gradient", True)
    with pytest.raises(ValueError, match="missing/repeated"):
        harness.invoke()
    assert read(harness, "outer-result.json")["success"] is True
    assert read(harness, "native-schema-observation.json")["complete"] is False
    assert not (harness.root / "evaluation-0000-dispatch/native-gradient-entry.json").exists()


def test_second_gradient_is_rejected_before_second_native_forward(harness):
    harness.schema.gradient_calls = 2
    with pytest.raises(ValueError, match="invocation count"):
        harness.invoke()
    counts = read(harness, "native-schema-observation.json")["counts"]
    assert counts["gradient_seen"] == 2 and counts["gradient_forwarded"] == 1
    assert harness.outer_calls == 1


def test_cleanup_false_is_not_an_allowed_workaround(harness):
    harness.schema.call_kwargs["clean"] = False
    with pytest.raises(ValueError, match="cleanup policy"):
        harness.invoke()
    assert harness.outer_calls == 0


def test_replaced_hook_is_retained_and_restored(harness):
    harness.schema.schema_fault = lambda: setattr(
        harness.psi4.schema_wrapper, "run_qcschema", lambda *a, **kw: None
    )
    with pytest.raises(ValueError, match="hook identity changed"):
        harness.invoke()
    assert read(harness, "outer-result.json")["success"] is True
    assert read(harness, "native-schema-observation.json")["restoration_errors"] == [
        "schema hook replaced"
    ]
    assert harness.psi4.schema_wrapper.run_qcschema is harness.schema.original_schema
