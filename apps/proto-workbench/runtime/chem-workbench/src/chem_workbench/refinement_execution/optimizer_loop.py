"""OptKing loop with bound options and final accepted-point reevaluation.

The recorder and native imports are injected; the
caller must run in its supervised isolated worker. This module adds no minimum
or physical-time claim, and never promotes a proposed unevaluated coordinate.
"""

from __future__ import annotations

import copy
import hashlib
import importlib
import json
from collections.abc import Callable
from decimal import Decimal
from pathlib import Path
from typing import Any

from chem_workbench.molecular_refinement import _metrics, seal_refinement_frame
from chem_workbench.refinement_backend import verified_file
from chem_workbench.refinement_execution.optimizer_policy import (
    observe_parameters,
    requested_options,
    validate_binding,
    verify_step_parameters,
)
from chem_workbench.visualization import content_hash


def observation_body(spec: dict[str, Any], binding: dict[str, Any]) -> dict[str, Any]:
    """Expected shape of the separately retained, actually observed parameter file."""
    return {
        "version": "refinement-optimizer-parameters/v1",
        "runtime_binding_hash": spec["runtime_binding"]["binding_hash"],
        "optimizer_settings_hash": content_hash(spec["optimizer_settings"]),
        "requested_native_options": binding["requested_native_options"],
        "effective_native_parameters": binding["effective_native_parameters"],
    }


def verify_bound_optimizer_artifact(
    spec: dict[str, Any], binding: dict[str, Any], root: Path
) -> dict[str, Any]:
    checked = validate_binding(
        binding, spec["optimizer_settings"], spec["runtime_binding"]["binding_hash"]
    )
    path = verified_file(root, checked["observation_artifact"])
    actual_bytes = path.read_bytes()
    if hashlib.sha256(actual_bytes).hexdigest() != checked["observation_artifact"]["sha256"]:
        raise ValueError("APPROVAL_STALE: optimizer observation changed while read")
    actual = json.loads(actual_bytes)
    expected = observation_body(spec, checked)
    if content_hash(actual) != content_hash(expected):
        raise ValueError("APPROVAL_STALE: optimizer observation differs from bound parameters")
    return checked


def run_bound_optimization(
    recorder: Any,
    binding: dict[str, Any],
    *,
    import_module: Callable[[str], Any] = importlib.import_module,
) -> bool:
    """Drive the real native API; tests inject mocks and do not imply native acceptance.

    ``recorder.evaluate`` must admit ``expected_geometry=`` for reevaluation and
    validate both actual raw input/result against it before appending a frame.
    The final gradient is an extra recorded evaluation, with fresh raw artifacts.
    """
    spec = recorder.spec
    checked = verify_bound_optimizer_artifact(spec, binding, recorder.root)
    recorder.phase = "optimization"
    opt = import_module("optking.optimize")
    wrappers = import_module("optking.compute_wrappers")
    optwrapper = import_module("optking.optwrapper")
    history_module = import_module("optking.history")
    molsys_module = import_module("optking.molsys")
    serialization = import_module("qcelemental.util.serialization")
    options = spec["optimizer_settings"]
    requested = requested_options(options)
    params = optwrapper.initialize_options(copy.deepcopy(requested), silent=True)
    initial = observe_parameters(params)
    recorder.retain_json(
        "optimizer-effective-initial",
        "optimizer_raw",
        {"binding_hash": checked["binding_hash"], "requested": requested, "effective": initial},
    )
    if content_hash(initial) != content_hash(checked["effective_native_parameters"]):
        raise ValueError("APPROVAL_STALE: initialized optimizer differs from bound snapshot")

    def observe(stage: str, iteration: int) -> str:
        observed = observe_parameters(params)
        identity = f"optimizer-{iteration:04d}-{stage}"
        recorder.retain_json(
            identity,
            "optimizer_raw",
            {
                "binding_hash": checked["binding_hash"],
                "iteration": iteration,
                "stage": stage,
                "effective": observed,
            },
        )
        verify_step_parameters(checked, observed)
        return identity

    def compute(computer: Any, driver: str) -> Any:
        if driver != "gradient":
            raise ValueError("UNSUPPORTED_PROFILE: optimizer requested non-gradient")
        return recorder.qcel.models.AtomicResult(**recorder.evaluate(computer.molecule))

    computer_class = type(
        "BoundRecordedGradientComputer", (wrappers.ComputeWrapper,), {"_compute": compute}
    )
    molecule = json.loads(recorder.molecule(spec["geometry"]).json())
    computer = computer_class(
        molecule,
        {"method": spec["profile"]["method"], "basis": spec["profile"]["basis"]},
        spec["electronic_settings"]["native_keywords"],
        "psi4",
        {},
        1,
    )
    system = molsys_module.Molsys.from_schema(molecule)
    history = history_module.History(params)
    opt.make_internal_coords(system, params)
    manager = opt.OptimizationManager(system, history, params, computer)
    hessian = 0
    for iteration in range(options["maximum_iterations"]):
        # The independent final gradient is part of the same bounded budget.
        if recorder.attempts >= options["max_gradient_evaluations"] - 1:
            raise ValueError("RESOURCE_LIMIT: final gradient reserve reached before optimizer step")
        observations = [observe("before-start", iteration)]
        prior_count = len(recorder.frames)
        hessian, force, energy = manager.start_step(hessian)
        observations.append(observe("after-start", iteration))
        if len(recorder.frames) != prior_count + 1:
            raise ValueError("UNSUPPORTED_PROFILE: unexpected optimizer evaluation pattern")
        evaluated = recorder.np.asarray(computer.molecule["geometry"]).reshape((-1, 3)).copy()
        submitted = json.loads(recorder.frames[-1]["raw_input_json"])["molecule"]["geometry"]
        prior_history_ids = [id(step) for step in history.steps]
        recorder.phase = "optimization"

        def retain_native_step(
            stage: str,
            iteration: int = iteration,
            evaluated: Any = evaluated,
            submitted: Any = submitted,
            prior_history_count: int = len(prior_history_ids),
        ) -> None:
            # OptKing history uses requested coordinates; QCSchema may round
            # submitted coordinates. Preserve both without treating them as equal.
            raw_step = {
                "iteration": iteration,
                "stage": stage,
                "requested_geometry_bohr": evaluated.tolist(),
                "submitted_geometry_bohr": submitted,
                "evaluated_frame_hash_before_attribution": recorder.frames[-1]["frame_hash"],
                "history": copy.deepcopy([step.to_dict() for step in history.steps]),
                "prior_history_entry_count": prior_history_count,
                "proposed_geometry_bohr": system.geom.tolist(),
                "optimizer_binding_hash": checked["binding_hash"],
            }
            recorder.retain(
                f"optimizer-{iteration:04d}-native-step-{stage}",
                "optimizer_raw",
                serialization.json_dumps(raw_step),
            )

        try:
            displacement = manager.take_step(force, hessian, energy, return_str=False)
        except Exception as error:
            try:
                retain_native_step("exception")
            except Exception as retention_error:
                error.add_note("Native step retention failed: " + str(retention_error))
            raise
        # Durable native history precedes option/history admission and can include
        # arrays requiring the genuine native serializer rather than json.dumps.
        retain_native_step("returned")
        observations.append(observe("after-step", iteration))
        after_history_ids = [id(step) for step in history.steps]
        retained = (
            len(after_history_ids) == len(prior_history_ids) + 1
            and after_history_ids[:-1] == prior_history_ids
            and recorder.np.array_equal(evaluated, history.steps[-1].geom)
        )
        if not retained and after_history_ids != prior_history_ids:
            raise ValueError("UNSUPPORTED_PROFILE: unexplained optimizer history change")
        status = (
            "initial" if iteration == 0 and retained else "accepted" if retained else "rejected"
        )
        event = {
            "iteration": iteration,
            "requested_geometry_bohr": evaluated.tolist(),
            "evaluated_geometry_bohr": recorder.np.asarray(submitted).reshape((-1, 3)).tolist(),
            "raw_input_artifact_id": recorder.frames[-1]["raw_input_artifact_id"],
            "history": copy.deepcopy([step.to_dict() for step in history.steps]),
            "prior_history_entry_count": len(prior_history_ids),
            "new_evaluated_entry_retained": retained,
            "proposed_geometry_bohr": system.geom.tolist(),
            "retained_evaluated_point": retained,
            "reported_converged": None,
            "parameter_observation_artifact_ids": observations,
            "optimizer_binding_hash": checked["binding_hash"],
        }
        recorder.optimizer_events.append(event)
        recorder.attribute(iteration, status)
        reported = manager.converged(energy, force, displacement) is True
        recorder.last_native_report = reported
        event["reported_converged"] = reported
        recorder.retain(
            f"optimizer-{iteration:04d}-convergence",
            "optimizer_raw",
            serialization.json_dumps(event),
        )
        observations.append(observe("after-convergence", iteration))
        if reported:
            accepted = [f for f in recorder.frames if f["step_status"] in {"initial", "accepted"}]
            if not accepted:
                raise ValueError(
                    "INVALID_TOOL_OUTPUT: convergence lacks an accepted evaluated point"
                )
            # Native convergence checks its proposed displacement. Product
            # admission requires two actually evaluated accepted points instead.
            if len(accepted) < 2 or not all(
                value <= Decimal(options["criteria"][key])
                for key, value in _metrics(accepted[-2], accepted[-1], accepted[-1]).items()
            ):
                continue
            target = copy.deepcopy(accepted[-1])
            raw_molecule = json.loads(target["raw_input_json"])["molecule"]
            before = len(recorder.frames)
            recorder.evaluate(raw_molecule, expected_geometry=copy.deepcopy(target["geometry"]))
            if len(recorder.frames) != before + 1:
                raise ValueError("INVALID_TOOL_OUTPUT: final gradient was not recorded once")
            frame = recorder.frames[-1]
            if frame["geometry"] != target["geometry"]:
                raise ValueError("APPROVAL_STALE: final reevaluation changed accepted geometry")
            body = {key: value for key, value in frame.items() if key != "frame_hash"}
            body.update(
                optimizer_iteration=target["optimizer_iteration"],
                step_status="reevaluation",
                reevaluates_frame_hash=target["frame_hash"],
            )
            recorder.frames[-1] = seal_refinement_frame(body)
            recorder.retain_json(
                "optimizer-final-reevaluation",
                "optimizer_raw",
                {
                    "optimizer_binding_hash": checked["binding_hash"],
                    "accepted_frame_hash": target["frame_hash"],
                    "reevaluation_frame_hash": recorder.frames[-1]["frame_hash"],
                    "accepted_geometry_hash": target["geometry"]["geometry_hash"],
                    "native_optimizer_step": False,
                },
            )
            observe("after-reevaluation", iteration)
            return True
    return False
