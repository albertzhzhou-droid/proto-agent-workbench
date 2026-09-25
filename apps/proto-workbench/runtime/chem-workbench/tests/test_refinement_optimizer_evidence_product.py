"""Synthetic native API records for the real product loop/evidence callback.

The retained 34-atom geometry is real input data. All energies, gradients, native
history/parameter events and supervisor inventories created here are test mocks.
No installed optimizer, electronic engine, provider or scientific job is called.
"""

from __future__ import annotations

import copy
import hashlib
import json

import pytest
from test_refinement_backend import mocked_runtime as mocked_runtime
from test_refinement_execution_optimizer_loop import environment as environment
from test_refinement_execution_optimizer_recorder import integrated as integrated

from chem_workbench.molecular_refinement import validate_refinement_result
from chem_workbench.refinement_execution.execution_contract import seal_execution_contract
from chem_workbench.refinement_execution.optimizer_evidence import make_optimizer_validator
from chem_workbench.visualization import content_hash


def rehash(value, field):
    value[field] = content_hash({key: item for key, item in value.items() if key != field})


def inventory(state):
    return [
        {
            "path": path.relative_to(state.root).as_posix(),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "bytes": path.stat().st_size,
        }
        for path in sorted((state.root / "run").iterdir())
        if path.is_file()
    ]


@pytest.fixture
def record_shape(integrated):
    state = integrated
    (state.root / "run").mkdir()
    state.recorder.output = state.root / "run/worker-result.json"
    original = state.runtime.modules["optking.optimize"].OptimizationManager
    seen = set()
    state.native_projection_shift = 0.0

    class SyntheticCompleteHistoryManager(original):
        """Extend the original minimal mocks to actual Step.to_dict field shape."""

        def take_step(self, *args, **kwargs):
            displacement = super().take_step(*args, **kwargs)
            for step in self.history.steps:
                if id(step) in seen:
                    continue
                seen.add(id(step))
                frame = state.recorder.frames[-1]
                gradient = [float(v) for row in frame["gradient_hartree_per_bohr"] for v in row]
                # Explicit synthetic transformation fixture, not a computed projection.
                transformed = [value + state.native_projection_shift for value in gradient]
                record = {
                    "geom": step.geom.tolist(),
                    "E": float(frame["energy_hartree"]),
                    "forces": [-value for value in transformed],
                    "cart_grad": transformed,
                    "projectedDE": None,
                    "Dq": [0.0] * len(gradient),
                    "followedUnitVector": [0.0] * len(gradient),
                    "oneDgradient": None,
                    "oneDhessian": None,
                    "decent": True,
                }
                step.to_dict = lambda record=record: copy.deepcopy(record)
            return displacement

    state.runtime.modules["optking.optimize"].OptimizationManager = SyntheticCompleteHistoryManager
    state.contract = seal_execution_contract(state.spec, "optimization", state.binding)
    return state


@pytest.fixture
def completed(record_shape):
    state = record_shape
    assert state.run() is True
    state.result = state.recorder.result(True, None)
    assert state.result["state"] == "succeeded"
    return state


def raw(state, identity):
    artifact = next(
        item for item in state.result["raw_artifacts"] if item["artifact_id"] == identity
    )
    return (state.root / artifact["path"]).read_bytes()


def check(state, *, files=None, entry=None, reader=None):
    validator = make_optimizer_validator(
        read_artifact=reader or (lambda ref: (state.root / ref["path"]).read_bytes()),
        run_directory="run",
        retained_inventory=inventory(state) if files is None else files,
    )
    return validator(
        state.contract,
        state.spec,
        state.result,
        raw(state, "optimizer-observation") if entry is None else entry,
    )


def alter(state, identity, mutate):
    """TEST ONLY: rebind outer test hashes to expose semantic evidence contradictions."""
    item = next(item for item in state.result["raw_artifacts"] if item["artifact_id"] == identity)
    data = json.loads(raw(state, identity))
    mutate(data)
    value = json.dumps(data, sort_keys=True, allow_nan=False).encode()
    (state.root / item["path"]).write_bytes(value)
    item["sha256"] = hashlib.sha256(value).hexdigest()
    rehash(state.result, "result_hash")


def test_real_product_loop_records_match_callback_without_native_calls(completed):
    assert len(completed.result["trajectory"]) == 3
    assert check(completed) is None
    event = json.loads(raw(completed, "optimizer-events"))["events"][0]
    standalone = json.loads(raw(completed, "optimizer-0000-convergence"))
    assert len(event["parameter_observation_artifact_ids"]) == 4
    assert len(standalone["parameter_observation_artifact_ids"]) == 3
    assert completed.result["convergence"]["minimum_status"] == "not_evaluated"


def test_rejected_point_and_final_older_accepted_anchor_are_supported(record_shape):
    state = record_shape
    state.converge_at, state.reject_at, state.shift = 3, 3, 1e-7
    assert state.run() is True
    state.result = state.recorder.result(True, None)
    assert [frame["step_status"] for frame in state.result["trajectory"]] == [
        "initial",
        "accepted",
        "rejected",
        "reevaluation",
    ]
    assert check(state) is None


def test_native_transformed_gradient_is_not_mislabeled_as_actual_raw_gradient(record_shape):
    state = record_shape
    state.native_projection_shift = 0.001
    assert state.run() is True
    state.result = state.recorder.result(True, None)
    assert check(state) is None
    native = json.loads(raw(state, "optimizer-events"))["events"][-1]["history"][-1]
    assert native["cart_grad"][0] != float(
        state.result["trajectory"][-1]["gradient_hartree_per_bohr"][0][0]
    )


@pytest.mark.parametrize(
    "identity",
    [
        "optimizer-events",
        "optimizer-effective-initial",
        "optimizer-0001-after-convergence",
        "optimizer-0001-native-step-returned",
        "optimizer-final-reevaluation",
    ],
)
def test_missing_independent_inventory_file_is_not_replaced_by_result_declaration(
    completed, identity
):
    path = "run/" + identity + ".json"
    with pytest.raises(ValueError, match="independent host inventory"):
        check(completed, files=[item for item in inventory(completed) if item["path"] != path])


def test_raw_entry_must_be_exactly_the_retained_observation(completed):
    with pytest.raises(ValueError, match="entry observation"):
        check(completed, entry=b"{}")


def test_actual_file_change_after_factory_creation_is_detected(completed):
    validator = make_optimizer_validator(
        read_artifact=lambda ref: (completed.root / ref["path"]).read_bytes(),
        run_directory="run",
        retained_inventory=inventory(completed),
    )
    path = completed.root / "run/optimizer-events.json"
    path.write_bytes(path.read_bytes() + b"\n")
    with pytest.raises(ValueError, match="actual raw hash"):
        validator(
            completed.contract,
            completed.spec,
            completed.result,
            raw(completed, "optimizer-observation"),
        )


def test_no_hidden_optimizer_file_in_host_inventory(completed):
    (completed.root / "run/optimizer-hidden.json").write_text("{}")
    with pytest.raises(ValueError, match="complete host optimizer inventory"):
        check(completed)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda event: event.update(new_evaluated_entry_retained=False),
        lambda event: event.update(retained_evaluated_point=1),
        lambda event: event.update(prior_history_entry_count=True),
        lambda event: event.update(iteration=True),
        lambda event: event["history"][-1].update(E=True),
        lambda event: event["history"][-1].update(E=-101.0),
        lambda event: event["history"][-1].update(decent=1),
        lambda event: event["history"][-1]["geom"][0].__setitem__(0, 999.0),
        lambda event: event.update(raw_input_artifact_id="gradient-9999-input"),
        lambda event: event["evaluated_geometry_bohr"][0].__setitem__(0, 999.0),
        lambda event: event["parameter_observation_artifact_ids"].pop(),
        lambda event: event.update(optimizer_binding_hash="sha256:" + "0" * 64),
    ],
)
def test_rehashed_event_booleans_and_history_cannot_replace_evaluated_evidence(completed, mutation):
    alter(completed, "optimizer-events", lambda data: mutation(data["events"][-1]))
    assert validate_refinement_result(completed.spec, completed.result) == completed.result
    with pytest.raises(ValueError):
        check(completed)


@pytest.mark.parametrize(
    "identity", ["optimizer-0000-before-start", "optimizer-0001-after-reevaluation"]
)
def test_step_parameter_drift_is_rejected_even_with_updated_raw_hashes(completed, identity):
    alter(completed, identity, lambda data: data["effective"].update(hess_update="BOFILL"))
    with pytest.raises(ValueError, match="optimizer parameter changed"):
        check(completed)


def test_bound_preflight_native_options_are_read_as_actual_bytes(completed):
    path = completed.root / completed.binding["observation_artifact"]["path"]
    path.write_bytes(path.read_bytes() + b"\n")
    with pytest.raises(ValueError, match="actual raw hash"):
        check(completed)


def test_retained_initial_options_cannot_be_a_self_declared_pass(completed):
    alter(
        completed,
        "optimizer-effective-initial",
        lambda data: data.update(effective={"passed": True}),
    )
    with pytest.raises(ValueError, match="actual initialized parameters"):
        check(completed)


def test_native_before_attribution_frame_hash_is_reconstructed(completed):
    alter(
        completed,
        "optimizer-0001-native-step-returned",
        lambda data: data.update(
            evaluated_frame_hash_before_attribution=completed.result["trajectory"][1]["frame_hash"]
        ),
    )
    with pytest.raises(ValueError, match="native step and actual evaluated frame"):
        check(completed)


def test_standalone_convergence_record_is_bound_separately(completed):
    alter(
        completed, "optimizer-0001-convergence", lambda data: data.update(reported_converged=False)
    )
    with pytest.raises(ValueError, match="retained convergence event"):
        check(completed)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda record: record.update(native_optimizer_step=True),
        lambda record: record.update(accepted_frame_hash="sha256:" + "0" * 64),
        lambda record: record.update(reevaluation_frame_hash="sha256:" + "0" * 64),
    ],
)
def test_final_reevaluation_requires_exact_accepted_and_fresh_frame_bindings(completed, mutation):
    alter(completed, "optimizer-final-reevaluation", mutation)
    with pytest.raises(ValueError, match="final reevaluation record"):
        check(completed)


def test_partial_evidence_stays_partial_without_invented_final_frame(record_shape):
    state = record_shape
    state.converge_at = None
    assert state.run() is False
    state.result = state.recorder.result(False, None)
    assert state.result["state"] == "incomplete"
    before = copy.deepcopy(state.result)
    with pytest.raises(ValueError, match="partial optimization"):
        check(state)
    assert state.result == before


@pytest.mark.parametrize(
    "mutation",
    [
        lambda files: files.append(copy.deepcopy(files[0])),
        lambda files: files[0].update(path="other-run/file.json"),
        lambda files: files[0].update(bytes=True),
        lambda files: files[0].update(extra=True),
    ],
)
def test_factory_requires_independent_closed_owned_inventory(completed, mutation):
    files = inventory(completed)
    mutation(files)
    with pytest.raises(ValueError):
        check(completed, files=files)


def test_actual_byte_counts_are_not_just_metadata(completed):
    files = inventory(completed)
    files[0]["bytes"] += 1
    with pytest.raises(ValueError, match="actual host byte count"):
        check(completed, files=files)


def test_reader_cannot_return_a_parsed_self_attestation(completed):
    with pytest.raises(ValueError, match="bounded actual bytes"):
        check(completed, reader=lambda ref: {"passed": True})
