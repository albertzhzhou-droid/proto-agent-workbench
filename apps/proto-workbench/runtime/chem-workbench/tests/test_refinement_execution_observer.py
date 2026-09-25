"""Pure mocks: no scientific packages, providers or native backends imported."""

from __future__ import annotations

import copy
import hashlib
import json
from types import SimpleNamespace

import pytest

from chem_workbench.refinement_execution.nested_dispersion_observer import (
    BoundResources,
    NestedDispersionObserver,
)


class Model:
    def __init__(self, data):
        self.data = copy.deepcopy(data)

    def model_dump_json(self):
        return json.dumps(self.data, indent=3, ensure_ascii=False, allow_nan=False)


def request(driver="gradient", extras=None):
    return Model(
        {
            "schema_name": "qcschema_atomic_input",
            "schema_version": 2,
            "molecule": {"atom_labels": ["candidate_atom_001"], "geometry": [1, 2, 3]},
            "specification": {
                "driver": driver,
                "model": {"method": "wb97x-d3bj"},
                "keywords": {"level_hint": "d3bj2b", "params_tweaks": {"s9": 0}},
                "extras": {} if extras is None else extras,
            },
        }
    )


def read(directory, name):
    return json.loads((directory / name).read_text())


class Harness:
    def __init__(self, tmp_path):
        self.scratch = str(tmp_path / "original-scratch")
        self.qce_calls = []
        self.inner_calls = []
        self.fail_inner = False
        self.mutate_inner = False
        self.mutate_qce = False
        self.fail_qce = False
        self.failed_result = False
        self.returned = []
        self.qcschema = SimpleNamespace(run_qcschema=self.inner)
        self.qce = SimpleNamespace(compute=self.compute)
        self.original_compute = self.qce.compute
        self.original_inner = self.qcschema.run_qcschema
        self.tmp_path = tmp_path

    def inner(self, model):
        self.inner_calls.append(model)
        if self.mutate_inner:
            model.data["specification"]["keywords"]["mutated_by_inner"] = True
        if self.fail_inner:
            raise RuntimeError("retained native mock failure")
        result = Model({"success": not self.failed_result, "return_result": [4, 5, 6]})
        self.returned.append(result)
        return result

    def compute(self, model, program, **kwargs):
        self.qce_calls.append((model, program, copy.deepcopy(kwargs)))
        if self.mutate_qce:
            model.data["specification"]["keywords"]["mutated_by_qce"] = True
        if self.fail_qce:
            raise RuntimeError("retained outer mock failure")
        translated = copy.deepcopy(model)
        translated.data["specification"]["keywords"]["level_hint"] = "d3bj"
        return self.qcschema.run_qcschema(translated)

    def set_scratch(self, value):
        self.scratch = value

    def observer(self, name="evaluation-0", setter=None):
        scratch = self.tmp_path / (name + "-scratch")
        scratch.mkdir()
        return NestedDispersionObserver(
            qcengine=self.qce,
            dftd3_qcschema=self.qcschema,
            get_scratch=lambda: self.scratch,
            set_scratch=setter or self.set_scratch,
            resources=BoundResources(2, 4.8, scratch),
            directory=self.tmp_path / name,
            evaluation_id=name,
            spec_hash="sha256:" + "a" * 64,
        )

    def invoke(self, model, config=None, **kwargs):
        return self.qce.compute(
            model,
            kwargs.pop("program", "s-dftd3"),
            raise_error=True,
            task_config=config,
            return_version=2,
            **kwargs,
        )


def test_energy_and_gradient_exact_raw_results_and_independent_counts(tmp_path):
    harness = Harness(tmp_path)
    observer = harness.observer()
    requests = [request("energy"), request("gradient")]
    before = [item.model_dump_json() for item in requests]
    with observer:
        assert observer.original_compute is harness.original_compute
        for model in requests:
            result = harness.invoke(model, {"ncores": 2, "scratch_directory": harness.scratch})
            assert result is harness.returned[-1]
        assert observer.counts["qce_calls_forwarded"] == 2
        assert observer.counts["inner_calls_forwarded"] == 2
    assert [item.model_dump_json() for item in requests] == before
    summary = read(observer.directory, "summary.json")
    assert summary["context_exception"] is None
    assert summary["restoration_errors"] == []
    assert summary["counts"] == {
        "qce_calls_seen": 2,
        "qce_calls_forwarded": 2,
        "qce_calls_returned": 2,
        "inner_calls_seen": 2,
        "inner_calls_forwarded": 2,
        "inner_calls_returned": 2,
    }
    for index, model in enumerate(requests):
        assert (observer.directory / f"qce-{index:04d}-request.json").read_text() == before[index]
        forwarded = read(observer.directory, f"qce-{index:04d}-forwarded-config.json")
        assert forwarded["retries"] == 0
        assert forwarded["memory"] == 4.8
        assert forwarded["ncores"] == 2
        assert harness.qce_calls[index][0] is not model
    for artifact in summary["artifacts"]:
        data = (observer.directory / artifact["name"]).read_bytes()
        assert hashlib.sha256(data).hexdigest() == artifact["sha256"]
    assert harness.qce.compute is harness.original_compute
    assert harness.qcschema.run_qcschema is harness.original_inner
    assert harness.scratch.endswith("original-scratch")


@pytest.mark.parametrize("stage", ["qce", "inner"])
def test_failure_retained_inputs_isolated_and_wrappers_restored(tmp_path, stage):
    harness = Harness(tmp_path)
    observer = harness.observer()
    model = request()
    original = model.model_dump_json()
    harness.mutate_qce = stage == "qce"
    harness.fail_qce = stage == "qce"
    harness.mutate_inner = stage == "inner"
    harness.fail_inner = stage == "inner"
    with pytest.raises(RuntimeError, match="mock failure"), observer:
        harness.invoke(model)
    assert model.model_dump_json() == original
    assert (observer.directory / "qce-0000-exception.json").exists()
    assert (observer.directory / f"{stage}-0000-exception.json").exists()
    after = observer.directory / f"{stage}-0000-forwarded-request-after.json"
    assert "mutated_by_" in after.read_text()
    summary = read(observer.directory, "summary.json")
    assert summary["counts"]["qce_calls_forwarded"] == 1
    assert summary["counts"]["qce_calls_returned"] == 0
    assert summary["context_exception"]["type"] == "RuntimeError"
    assert harness.qce.compute is harness.original_compute
    assert harness.qcschema.run_qcschema is harness.original_inner
    assert harness.scratch.endswith("original-scratch")


def test_native_mutation_on_success_does_not_leak_and_result_is_not_rebuilt(tmp_path):
    harness = Harness(tmp_path)
    harness.mutate_inner = True
    harness.mutate_qce = True
    harness.failed_result = True
    observer = harness.observer()
    model = request()
    original = model.model_dump_json()
    with observer:
        result = harness.invoke(model)
        assert result is harness.returned[-1]
        assert result.data["success"] is False
    assert model.model_dump_json() == original
    assert read(observer.directory, "qce-0000-return.json")["success"] is False


@pytest.mark.parametrize(
    "config",
    [
        {"retries": 1},
        {"retries": True},
        {"ncores": 2.0},
        {"ncores": 3},
        {"memory": True},
        {"memory": 6},
        {"unknown": 1},
        {"scratch_directory": "relative"},
    ],
)
def test_bad_retry_or_resource_control_refuses_before_dispatch(tmp_path, config):
    harness = Harness(tmp_path)
    observer = harness.observer()
    original = copy.deepcopy(config)
    with pytest.raises(ValueError), observer:
        harness.invoke(request(), config)
    assert config == original
    assert harness.qce_calls == []
    assert read(observer.directory, "summary.json")["counts"]["qce_calls_forwarded"] == 0


@pytest.mark.parametrize("override", [{}, {"retries": 0}, {"retries": 1}])
def test_local_config_override_refuses_even_when_zero_or_empty(tmp_path, override):
    harness = Harness(tmp_path)
    observer = harness.observer()
    with pytest.raises(ValueError, match="local-config"), observer:
        harness.invoke(request(extras={"_qcengine_local_config": override}))
    assert harness.qce_calls == []


@pytest.mark.parametrize("program,driver", [("psi4", "gradient"), ("s-dftd3", "hessian")])
def test_unknown_program_or_driver_refuses(tmp_path, program, driver):
    harness = Harness(tmp_path)
    observer = harness.observer()
    with pytest.raises(ValueError), observer:
        harness.invoke(request(driver), program=program)
    assert harness.qce_calls == []


def test_restoration_after_body_failure_and_no_cross_evaluation_leakage(tmp_path):
    harness = Harness(tmp_path)
    first = harness.observer("evaluation-0")
    with pytest.raises(RuntimeError, match="body"), first:
        second = harness.observer("evaluation-1")  # constructed while first wrapper is active
        harness.invoke(request("energy"))
        raise RuntimeError("body")
    with second:
        assert second.original_compute is harness.original_compute
        harness.invoke(request("gradient"))
    for observer in (first, second):
        summary = read(observer.directory, "summary.json")
        assert summary["counts"]["qce_calls_forwarded"] == 1
        assert summary["counts"]["inner_calls_forwarded"] == 1
        assert summary["evaluation_id"] == observer.evaluation_id
    assert harness.qce.compute is harness.original_compute
    assert harness.qcschema.run_qcschema is harness.original_inner


def test_setup_failure_restores_scratch_and_does_not_lock_later_scope(tmp_path):
    harness = Harness(tmp_path)
    original = harness.scratch

    def setter(value):
        harness.scratch = value
        if value != original:
            raise RuntimeError("scratch setup")

    failed = harness.observer("setup-failure", setter=setter)
    with pytest.raises(RuntimeError, match="scratch setup"), failed:
        pytest.fail("unreachable")
    assert harness.scratch == original
    assert harness.qce.compute is harness.original_compute
    assert harness.qcschema.run_qcschema is harness.original_inner
    with harness.observer("later"):
        harness.invoke(request())


def test_exclusive_directory_and_single_use(tmp_path):
    harness = Harness(tmp_path)
    observer = harness.observer()
    with observer:
        pass
    before = (observer.directory / "summary.json").read_bytes()
    with pytest.raises(RuntimeError, match="single-use"), observer:
        pytest.fail("unreachable")
    assert (observer.directory / "summary.json").read_bytes() == before
    duplicate = harness.observer("other")
    duplicate.directory = observer.directory
    with pytest.raises(FileExistsError), duplicate:
        pytest.fail("unreachable")


def test_scratch_trailing_separator_is_same_owned_path(tmp_path):
    harness = Harness(tmp_path)
    observer = harness.observer()
    with observer:
        requested = {"scratch_directory": str(observer.resources.scratch_directory) + "/"}
        original = requested.copy()
        harness.invoke(request(), requested)
        assert requested == original


def test_orphan_inner_call_is_recorded_and_never_forwarded(tmp_path):
    harness = Harness(tmp_path)
    observer = harness.observer()
    with pytest.raises(ValueError, match="Orphan"), observer:
        harness.qcschema.run_qcschema(request())
    summary = read(observer.directory, "summary.json")
    assert summary["counts"]["inner_calls_seen"] == 1
    assert summary["counts"]["inner_calls_forwarded"] == 0
    assert harness.inner_calls == []


@pytest.mark.parametrize("recursive", [False, True])
def test_repeated_or_recursive_inner_attempt_retained_but_not_forwarded(tmp_path, recursive):
    harness = Harness(tmp_path)

    if recursive:

        def inner(model):
            harness.inner_calls.append(model)
            return harness.qcschema.run_qcschema(model)

        harness.qcschema.run_qcschema = inner
    else:

        def compute(model, program, **kwargs):
            harness.qcschema.run_qcschema(model)
            return harness.qcschema.run_qcschema(model)

        harness.qce.compute = compute
    observer = harness.observer()
    with pytest.raises(ValueError, match="zero retries"), observer:
        harness.invoke(request())
    summary = read(observer.directory, "summary.json")
    assert summary["counts"]["inner_calls_seen"] == 2
    assert summary["counts"]["inner_calls_forwarded"] == 1
    assert len(harness.inner_calls) == 1
    assert (observer.directory / "inner-0001-exception.json").exists()


def test_restore_failure_does_not_skip_other_attribute_or_scratch(tmp_path):
    harness = Harness(tmp_path)

    class Owner:
        def __init__(self):
            self._compute = harness.original_compute
            self.fail_restore = False

        @property
        def compute(self):
            return self._compute

        @compute.setter
        def compute(self, value):
            if self.fail_restore and value is harness.original_compute:
                raise RuntimeError("injected attribute restoration failure")
            self._compute = value

    owner = Owner()
    harness.qce = owner
    observer = harness.observer()
    with pytest.raises(RuntimeError, match="restoration failed"), observer:
        harness.invoke(request())
        owner.fail_restore = True
    assert harness.qcschema.run_qcschema is harness.original_inner
    assert harness.scratch.endswith("original-scratch")
    summary = read(observer.directory, "summary.json")
    assert summary["restoration_errors"] == ["injected attribute restoration failure"]
