"""Pure host inventory bridge regressions; no worker or native runtime is started.

Optimizer file payloads here are empty shape placeholders for filename admission
tests only. Their contents must still pass the separate actual-byte optimizer
evidence callback before a result can be eligible.
"""

from __future__ import annotations

import json

import pytest
from test_refinement_execution_contract import synthetic_binding
from test_refinement_host_evidence_product import SPEC, Fixture

from chem_workbench.refinement_execution.execution_contract import seal_execution_contract

STAGES = (
    "before-start",
    "after-start",
    "after-step",
    "after-convergence",
    "after-reevaluation",
    "native-step-returned",
    "native-step-exception",
    "convergence",
)


def fixture(tmp_path, *, mode="optimization"):
    if mode == "gradient":
        return Fixture(tmp_path)
    spec = json.loads(SPEC.read_bytes())["spec"]
    contract = seal_execution_contract(spec, mode, synthetic_binding(spec))
    return Fixture(tmp_path, mode=mode, contract=contract)


def test_actual_loop_optimizer_filenames_are_classified_after_host_begin(tmp_path):
    state = fixture(tmp_path)
    state.session.begin()
    names = ["optimizer-effective-initial.json", "optimizer-final-reevaluation.json"]
    last = state.spec["optimizer_settings"]["maximum_iterations"] - 1
    names += [
        f"optimizer-{iteration:04d}-{stage}.json" for iteration in (0, last) for stage in STAGES
    ]
    for name in names:
        (state.path / name).write_text("{}")
    inventory = state.session._inventory()
    assert inventory["unknown_paths"] == []
    assert {item["path"] for item in inventory["files"]} == {
        state.run + "/" + name for name in names
    }


@pytest.mark.parametrize(
    "name",
    [
        "optimizer-0000-unobserved-stage.json",
        "optimizer-0000-before-start-extra.json",
        "optimizer-00000-before-start.json",
        "optimizer--001-before-start.json",
        "optimizer-0000-before-start.txt",
        "optimizer-arbitrary.json",
    ],
)
def test_optimizer_filename_admission_does_not_allow_unbounded_prefix(tmp_path, name):
    state = fixture(tmp_path)
    state.session.begin()
    (state.path / name).write_text("{}")
    assert state.run + "/" + name in state.session._inventory()["unknown_paths"]


def test_optimizer_iteration_at_budget_boundary_is_not_an_admitted_filename(tmp_path):
    state = fixture(tmp_path)
    state.session.begin()
    maximum = state.spec["optimizer_settings"]["maximum_iterations"]
    name = f"optimizer-{maximum:04d}-before-start.json"
    (state.path / name).write_text("{}")
    assert state.run + "/" + name in state.session._inventory()["unknown_paths"]


def test_optimizer_filename_cannot_disguise_directory(tmp_path):
    state = fixture(tmp_path)
    state.session.begin()
    name = "optimizer-0000-before-start.json"
    (state.path / name).mkdir()
    assert state.run + "/" + name in state.session._inventory()["unknown_paths"]


@pytest.mark.parametrize(
    "name",
    [
        "optimizer-effective-initial.json",
        "optimizer-final-reevaluation.json",
        "optimizer-0000-native-step-returned.json",
        "optimizer-0000-before-start.json",
    ],
)
def test_begin_still_rejects_preexisting_optimizer_artifacts(tmp_path, name):
    state = fixture(tmp_path)
    (state.path / name).write_text("{}")
    with pytest.raises(ValueError):
        state.session.begin()
    assert (state.path / name).read_text() == "{}"


@pytest.mark.parametrize(
    "name",
    [
        "optimizer-effective-initial.json",
        "optimizer-0000-before-start.json",
    ],
)
def test_gradient_run_does_not_admit_optimizer_stage_artifacts(tmp_path, name):
    state = fixture(tmp_path, mode="gradient")
    state.session.begin()
    (state.path / name).write_text("{}")
    assert state.run + "/" + name in state.session._inventory()["unknown_paths"]
