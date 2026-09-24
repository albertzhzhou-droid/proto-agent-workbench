"""Actual-byte admission of the retained optimizer loop's completion evidence.

The host supplies a contained reader and its independently captured run inventory.
Hashes alone do not authenticate a worker. This callback checks parameter/history
observations against evaluated frames and recomputes the product force/displacement
criteria; it does not rerun OptKing's full convergence algorithm. Its reported flag
remains a bound observation. Partial/unknown evidence fails complete admission and
must remain retained by the caller. No minimum or accuracy is certified here.
"""

from __future__ import annotations

import copy
import hashlib
from decimal import Decimal
from pathlib import PurePosixPath
from typing import Any, cast

from chem_workbench.molecular_refinement import (
    _metrics,
    seal_refinement_frame,
    validate_refinement_result,
)
from chem_workbench.refinement_execution.contract_result_evidence import OptimizerValidator, Reader
from chem_workbench.refinement_execution.execution_contract import validate_execution_contract
from chem_workbench.refinement_execution.optimizer_policy import verify_step_parameters
from chem_workbench.refinement_execution.worker_subject_replay import (
    MAX_BYTES,
    artifact_ref,
    canonical_hash,
    closed,
    load_json,
)

Record = dict[str, Any]
_STAGES = ("before-start", "after-start", "after-step", "after-convergence")
_STEP_KEYS = {
    "geom",
    "E",
    "forces",
    "cart_grad",
    "projectedDE",
    "Dq",
    "followedUnitVector",
    "oneDgradient",
    "oneDhessian",
    "decent",
}
_EVENT_KEYS = {
    "iteration",
    "requested_geometry_bohr",
    "evaluated_geometry_bohr",
    "raw_input_artifact_id",
    "history",
    "prior_history_entry_count",
    "new_evaluated_entry_retained",
    "proposed_geometry_bohr",
    "retained_evaluated_point",
    "reported_converged",
    "parameter_observation_artifact_ids",
    "optimizer_binding_hash",
}


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError("OPTIMIZER_EVIDENCE: " + message)


def _same(left: object, right: object, message: str) -> None:
    _require(canonical_hash(left) == canonical_hash(right), message)


def _number(value: object) -> Decimal:
    _require(type(value) in (int, float), "native numeric JSON required, without coercion")
    result = Decimal(str(value))
    _require(result.is_finite(), "finite native number required")
    return result


def _vector(value: object, count: int, *, allow_empty: bool = False) -> list[Decimal]:
    _require(type(value) is list, "native numerical array required")
    flattened: list[Decimal] = []
    for item in cast(list[Any], value):
        if type(item) is list:
            _require(len(item) == 3, "native Cartesian row requires three numbers")
            flattened.extend(_number(component) for component in item)
        else:
            flattened.append(_number(item))
    _require(len(flattened) == count or (allow_empty and not flattened), "native array size")
    return flattened


def _step_core(value: object, count: int) -> tuple[list[Decimal], Decimal, list[Decimal]]:
    step = closed(value, _STEP_KEYS, "native Step.to_dict")
    _require(type(step["decent"]) is bool, "native decent flag type")
    for key in ("projectedDE", "oneDgradient", "oneDhessian"):
        if step[key] is not None:
            _number(step[key])
    _vector(step["forces"], count)
    _vector(step["Dq"], count, allow_empty=True)
    _vector(step["followedUnitVector"], count, allow_empty=True)
    return _vector(step["geom"], count), _number(step["E"]), _vector(step["cart_grad"], count)


def make_optimizer_validator(
    *, read_artifact: Reader, run_directory: str, retained_inventory: object
) -> OptimizerValidator:
    """Create the four-argument callback from independently obtained host data.

    ``retained_inventory`` is exactly the host inventory's ``files`` list, with
    path/raw SHA-256/byte count entries. A per-call cache avoids duplicate reads;
    subsequent callback calls read the files again. The external bound optimizer
    parameter observation is checked by its contract reference, outside the run
    inventory. Run evidence must all be in the independently inventoried run.
    """
    artifact_ref({"path": run_directory + "/owned", "sha256": "0" * 64})
    _require(
        type(retained_inventory) is list and len(retained_inventory) <= 200000,
        "bounded independent host inventory required",
    )
    inventory: dict[str, Record] = {}
    prefix = run_directory.casefold() + "/"
    for value in cast(list[Any], retained_inventory):
        item = closed(value, {"path", "sha256", "bytes"}, "host inventory entry")
        reference = artifact_ref({key: item[key] for key in ("path", "sha256")})
        key = reference["path"].casefold()
        _require(key.startswith(prefix), "host inventory file outside owned run")
        _require(key not in inventory, "duplicate host inventory path")
        _require(type(item["bytes"]) is int and item["bytes"] >= 0, "host byte count")
        inventory[key] = copy.deepcopy(item)

    def validate(contract: Record, spec: Record, result: Record, raw_optimizer: bytes) -> None:
        _same(validate_execution_contract(contract, spec, "optimization"), contract, "contract")
        _same(validate_refinement_result(spec, result), result, "scientific result")
        _require(result["state"] == "succeeded", "partial optimization is not complete evidence")
        binding = contract["optimizer_binding"]
        cache: dict[str, bytes] = {}

        def read(reference: object, *, owned: bool) -> bytes:
            ref = artifact_ref(reference)
            key = ref["path"].casefold()
            if owned:
                _require(key in inventory, "artifact absent from independent host inventory")
                _same(ref, {k: inventory[key][k] for k in ("path", "sha256")}, "host raw ref")
            if key not in cache:
                raw = read_artifact(copy.deepcopy(ref))
                _require(type(raw) is bytes and len(raw) <= MAX_BYTES, "bounded actual bytes")
                _require(hashlib.sha256(raw).hexdigest() == ref["sha256"], "actual raw hash")
                if owned:
                    _require(len(raw) == inventory[key]["bytes"], "actual host byte count")
                cache[key] = raw
            else:
                _require(
                    hashlib.sha256(cache[key]).hexdigest() == ref["sha256"], "same-path raw hash"
                )
            return cache[key]

        artifacts = {item["artifact_id"]: item for item in result["raw_artifacts"]}
        used_optimizer: set[str] = set()

        def artifact(identity: str, role: str) -> bytes:
            _require(identity in artifacts, "missing retained artifact: " + identity)
            item = artifacts[identity]
            _require(item["role"] == role, "artifact role: " + identity)
            if identity.startswith("optimizer-"):
                _require(
                    item["path"] == run_directory + "/" + identity + ".json",
                    "optimizer artifact filename/ownership",
                )
                used_optimizer.add(item["path"].casefold())
            return read({key: item[key] for key in ("path", "sha256")}, owned=True)

        # Check actual frame/raw-result bytes too; embedded JSON cannot replace
        # independently retained, host-inventoried input and result files.
        for item in artifacts.values():
            read({key: item[key] for key in ("path", "sha256")}, owned=True)
        for frame in result["trajectory"]:
            for kind, role in (("input", "atomic_input"), ("result", "atomic_result")):
                _require(
                    artifact(frame["raw_" + kind + "_artifact_id"], role)
                    == frame["raw_" + kind + "_json"].encode(),
                    "frame embedded raw bytes",
                )
        observation = artifact("optimizer-observation", "optimizer_observation")
        _require(type(raw_optimizer) is bytes and raw_optimizer == observation, "entry observation")
        _require(
            observation == result["convergence"]["optimizer_observation_json"].encode(),
            "result optimizer observation bytes",
        )
        observed = load_json(observation)
        _same(observed["source_artifact_ids"], ["optimizer-events"], "optimizer event source")
        _same(
            load_json(read(binding["observation_artifact"], owned=False)),
            {
                "version": "refinement-optimizer-parameters/v1",
                "runtime_binding_hash": spec["runtime_binding"]["binding_hash"],
                "optimizer_settings_hash": canonical_hash(spec["optimizer_settings"]),
                "requested_native_options": binding["requested_native_options"],
                "effective_native_parameters": binding["effective_native_parameters"],
            },
            "bound native parameter observation",
        )
        _same(
            load_json(artifact("optimizer-effective-initial", "optimizer_raw")),
            {
                "binding_hash": binding["binding_hash"],
                "requested": binding["requested_native_options"],
                "effective": binding["effective_native_parameters"],
            },
            "actual initialized parameters",
        )
        event_record = closed(
            load_json(artifact("optimizer-events", "optimizer_raw")), {"events"}, "events"
        )
        events = event_record["events"]
        frames = result["trajectory"]
        _require(
            type(events) is list and len(events) == len(frames) - 1, "one event per native step"
        )
        _require(len(events) >= 2, "accepted pair and final reevaluation required")
        count = len(spec["geometry"]["atoms"]) * 3
        previous_history: list[tuple[list[Decimal], Decimal, list[Decimal]]] = []
        accepted: list[Record] = []

        def parameters(identity: str, stage: str, iteration: int) -> None:
            record = closed(
                load_json(artifact(identity, "optimizer_raw")),
                {"binding_hash", "iteration", "stage", "effective"},
                "parameter observation",
            )
            _same(
                {key: record[key] for key in ("binding_hash", "iteration", "stage")},
                {"binding_hash": binding["binding_hash"], "iteration": iteration, "stage": stage},
                "parameter step binding",
            )
            verify_step_parameters(binding, record["effective"])

        for iteration, value in enumerate(events):
            event = closed(value, _EVENT_KEYS, "optimizer event")
            frame = frames[iteration]
            _same(event["iteration"], iteration, "native iteration")
            _same(frame["optimizer_iteration"], iteration, "frame iteration")
            _same(event["optimizer_binding_hash"], binding["binding_hash"], "event binding")
            _same(event["raw_input_artifact_id"], frame["raw_input_artifact_id"], "event input")
            _same(event["prior_history_entry_count"], len(previous_history), "prior history count")
            history = event["history"]
            _require(type(history) is list, "native history list")
            actual_history = [_step_core(step, count) for step in history]
            retained = len(actual_history) == len(previous_history) + 1
            _require(
                len(actual_history) in (len(previous_history), len(previous_history) + 1)
                and actual_history[: len(previous_history)] == previous_history,
                "native evaluated history prefix/count changed",
            )
            requested = _vector(event["requested_geometry_bohr"], count)
            submitted = load_json(frame["raw_input_json"].encode())["molecule"]["geometry"]
            _require(
                _vector(event["evaluated_geometry_bohr"], count) == _vector(submitted, count),
                "evaluated submitted coordinates",
            )
            _vector(event["proposed_geometry_bohr"], count)
            if retained:
                geom, energy, _native_cartesian_gradient = actual_history[-1]
                _require(geom == requested, "retained history requested coordinates")
                _same(
                    history[-1]["geom"],
                    event["requested_geometry_bohr"],
                    "retained native coordinate array shape",
                )
                _require(energy == Decimal(frame["energy_hartree"]), "history evaluated energy")
                # OptKing stores gradient_to_cartesians(-fq), which can involve
                # internal-coordinate projection. It is retained and checked for
                # consistent history, not mislabeled as the raw electronic gradient.
                # The final physical criteria below use the actual evaluated frame.
            status = (
                "initial" if iteration == 0 and retained else "accepted" if retained else "rejected"
            )
            _same(event["new_evaluated_entry_retained"], retained, "retained flag from history")
            _same(event["retained_evaluated_point"], retained, "evaluated point from history")
            _same(frame["step_status"], status, "frame attribution from history")
            if retained:
                accepted.append(frame)
            previous_history = actual_history
            ids = [f"optimizer-{iteration:04d}-{stage}" for stage in _STAGES]
            _same(event["parameter_observation_artifact_ids"], ids, "complete parameter stages")
            for identity, stage in zip(ids, _STAGES, strict=True):
                parameters(identity, stage, iteration)
            native = load_json(
                artifact(f"optimizer-{iteration:04d}-native-step-returned", "optimizer_raw")
            )
            pre_frame = seal_refinement_frame(
                {
                    **{key: item for key, item in frame.items() if key != "frame_hash"},
                    "optimizer_iteration": None,
                    "step_status": "unknown",
                    "reevaluates_frame_hash": None,
                }
            )
            _same(
                native,
                {
                    "iteration": iteration,
                    "stage": "returned",
                    "requested_geometry_bohr": event["requested_geometry_bohr"],
                    "submitted_geometry_bohr": submitted,
                    "evaluated_frame_hash_before_attribution": pre_frame["frame_hash"],
                    "history": history,
                    "prior_history_entry_count": event["prior_history_entry_count"],
                    "proposed_geometry_bohr": event["proposed_geometry_bohr"],
                    "optimizer_binding_hash": binding["binding_hash"],
                },
                "native step and actual evaluated frame",
            )
            convergence = load_json(
                artifact(f"optimizer-{iteration:04d}-convergence", "optimizer_raw")
            )
            _require(type(event["reported_converged"]) is bool, "native convergence report type")
            _same(
                convergence,
                {**event, "parameter_observation_artifact_ids": ids[:-1]},
                "retained convergence event",
            )

        final = frames[-1]
        _require(
            len(accepted) >= 2 and events[-1]["reported_converged"] is True,
            "final native report/accepted pair",
        )
        target = accepted[-1]
        _same(final["step_status"], "reevaluation", "final evaluated status")
        _same(final["reevaluates_frame_hash"], target["frame_hash"], "final accepted anchor")
        _same(final["geometry"], target["geometry"], "final exact accepted geometry")
        _same(final["optimizer_iteration"], target["optimizer_iteration"], "final anchor iteration")
        _same(
            load_json(final["raw_input_json"].encode())["molecule"],
            load_json(target["raw_input_json"].encode())["molecule"],
            "final raw accepted molecule",
        )
        _require(
            final["raw_input_artifact_id"] != target["raw_input_artifact_id"]
            and final["raw_result_artifact_id"] != target["raw_result_artifact_id"],
            "fresh final evaluation artifacts",
        )
        for value in (target, final):
            _require(
                all(
                    metric <= Decimal(spec["optimizer_settings"]["criteria"][key])
                    for key, metric in _metrics(accepted[-2], target, value).items()
                ),
                "actual accepted displacement and evaluated gradient criteria",
            )
        _same(
            load_json(artifact("optimizer-final-reevaluation", "optimizer_raw")),
            {
                "optimizer_binding_hash": binding["binding_hash"],
                "accepted_frame_hash": target["frame_hash"],
                "reevaluation_frame_hash": final["frame_hash"],
                "accepted_geometry_hash": target["geometry"]["geometry_hash"],
                "native_optimizer_step": False,
            },
            "final reevaluation record",
        )
        parameters(
            f"optimizer-{len(events) - 1:04d}-after-reevaluation",
            "after-reevaluation",
            len(events) - 1,
        )
        _same(
            result["convergence"]["optimizer_reported_converged"],
            events[-1]["reported_converged"],
            "final report",
        )
        host_optimizer = {
            key
            for key, item in inventory.items()
            if PurePosixPath(item["path"]).parent.as_posix().casefold() == run_directory.casefold()
            and PurePosixPath(item["path"]).name.casefold().startswith("optimizer-")
        }
        _same(sorted(used_optimizer), sorted(host_optimizer), "complete host optimizer inventory")

    return validate
