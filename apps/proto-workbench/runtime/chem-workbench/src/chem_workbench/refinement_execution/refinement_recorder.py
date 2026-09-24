"""Request-v2 recorder hooks; native dependencies and transport are injected.

This does not admit a worker request, authenticate transitive files, run an
optimizer, or establish nested-call observation. The supervising new-contract
worker must do those jobs separately. Importing this module loads no chemistry
runtime. The legacy product class remains unchanged.
"""

from __future__ import annotations

import copy
import hashlib
import json
import time
from collections.abc import Callable
from decimal import Decimal
from pathlib import Path
from typing import Any

from chem_workbench import molecular_refinement as records
from chem_workbench.method_profiles import D3BJ_PROFILE_ID
from chem_workbench.refinement_backend import GradientRecorder, canonical


class StagedGradientRecorder(GradientRecorder):
    """New-contract recorder with explicit accepted-point reevaluation support."""

    def __init__(
        self,
        spec: dict[str, Any],
        output: Path,
        root: Path,
        *,
        import_module: Callable[[str], Any],
        dispatch: Callable[..., Any] | None = None,
    ) -> None:
        self.spec = records.validate_refinement_spec(spec)
        if (
            self.spec["version"] != records.MASS_BOUND_SPEC_VERSION
            or self.spec["profile"]["profile_id"] != D3BJ_PROFILE_ID
        ):
            raise ValueError("UNSUPPORTED_PROFILE: staged recorder requires mass-bound D3BJ v2")
        retry = self.spec["resources"]["backend_retry_policy"]
        if retry["requested_retries"] != 0 or retry["effective_retries"] != 0:
            raise ValueError("UNSUPPORTED_PROFILE: staged recorder admits zero retries only")
        self.output = output
        self.root = root
        self.started = time.monotonic()
        self.phase = "preflight"
        self.frames: list[dict[str, Any]] = []
        self.artifacts: list[dict[str, Any]] = []
        self.attempts = 0
        self.optimizer_events: list[dict[str, Any]] = []
        self.last_native_report: bool | None = None
        self.qcel = import_module("qcelemental")
        self.qcengine = import_module("qcengine")
        self.psi4 = import_module("psi4")
        self.np = import_module("numpy")
        self._serialization = import_module("qcelemental.util.serialization")
        self._dispatch = dispatch if dispatch is not None else self.qcengine.compute
        self.task_config = {
            "ncores": self.spec["resources"]["threads"],
            "memory": self.spec["resources"]["memory_bytes"] / 1024**3 * 0.6,
            "retries": 0,
            "scratch_directory": str(output.parent / "scratch"),
        }

    def _accepted_override(
        self, molecule: dict[str, Any], expected_geometry: object
    ) -> dict[str, Any]:
        """Require a genuinely retained accepted frame and its exact raw molecule."""
        accepted = [
            frame for frame in self.frames if frame["step_status"] in {"initial", "accepted"}
        ]
        if not accepted:
            raise ValueError("APPROVAL_STALE: geometry override requires an accepted evaluation")
        target = accepted[-1]
        # Verify the complete sealed frame and its embedded raw/reference bindings.
        records._frame(
            self.spec,
            target,
            target["evaluation_index"],
            {reference["artifact_id"]: reference for reference in self.artifacts},
        )
        checked_geometry = records._geometry(copy.deepcopy(expected_geometry))
        if checked_geometry != target["geometry"]:
            raise ValueError("APPROVAL_STALE: override differs from latest accepted geometry")
        original = records._json_object(target["raw_input_json"])["molecule"]
        supplied = records._json_object(json.dumps(molecule, allow_nan=False))
        if not records._same_typed_json(supplied, original):
            raise ValueError("APPROVAL_STALE: reevaluation must reuse accepted raw molecule")
        records._raw_geometry(supplied, checked_geometry, self.spec.get("isotope_binding"))
        return copy.deepcopy(checked_geometry)

    def evaluate(
        self, molecule: dict[str, Any], *, expected_geometry: object = None
    ) -> dict[str, Any]:
        self.phase = "gradient"
        if self.attempts >= self.spec["optimizer_settings"]["max_gradient_evaluations"]:
            raise ValueError("RESOURCE_LIMIT: gradient attempt budget exhausted")
        if time.monotonic() - self.started >= self.spec["resources"]["wall_seconds"]:
            raise ValueError("RESOURCE_LIMIT: worker wall budget exhausted")
        override = (
            None
            if expected_geometry is None
            else self._accepted_override(molecule, expected_geometry)
        )
        index = self.attempts
        prefix = f"evaluation-{index:04d}"
        atomic_input = self.qcel.models.AtomicInput(
            molecule=self.qcel.models.Molecule(**molecule),
            driver="gradient",
            model={
                "method": self.spec["profile"]["method"],
                "basis": self.spec["profile"]["basis"],
            },
            keywords=copy.deepcopy(self.spec["electronic_settings"]["native_keywords"]),
            extras={"psiapi": True},
        )
        input_text = atomic_input.json()
        input_id = self.retain(prefix + "-input", "atomic_input", input_text)
        raw_input = records._json_object(input_text)
        checked_geometry = (
            copy.deepcopy(override)
            if override is not None
            else self.evaluated_geometry(json.loads(input_text)["molecule"])
        )
        records._geometry(checked_geometry)
        records._raw_geometry(
            raw_input["molecule"], checked_geometry, self.spec.get("isotope_binding")
        )
        if override is not None:
            accepted = [f for f in self.frames if f["step_status"] in {"initial", "accepted"}][-1]
            original = records._json_object(accepted["raw_input_json"])["molecule"]
            if not records._same_typed_json(raw_input["molecule"], original):
                raise ValueError(
                    "APPROVAL_STALE: native reconstruction changed accepted raw molecule"
                )
        attempt_start = time.monotonic()
        self.retain_json(
            prefix + "-start",
            "log",
            {
                "spec_hash": self.spec["spec_hash"],
                "input_sha256": hashlib.sha256(input_text.encode()).hexdigest(),
                "task_config": self.task_config,
                "attempt_index": index,
                "requested_dispatch": "psi4_qcengine_psiapi_v1",
            },
        )
        self.attempts += 1
        result = None
        result_id = None
        try:
            result = self._dispatch(
                atomic_input, "psi4", raise_error=False, task_config=dict(self.task_config)
            )
            raw_text = result.json()
            result_id = self.retain(prefix + "-result", "atomic_result", raw_text)
        except Exception as error:
            self.retain_json(
                prefix + "-attempt",
                "backend_attempt",
                {
                    "attempt_index": index,
                    "task_config": self.task_config,
                    "input_artifact_id": input_id,
                    "result_artifact_id": result_id,
                    "elapsed_seconds": canonical(time.monotonic() - attempt_start),
                    "success": False,
                    "returned_native_success": getattr(result, "success", None),
                    "exception_type": type(error).__name__,
                    "exception_message": str(error)[:4096],
                    "observed_qcengine_retries": None,
                },
            )
            raise
        native_success = getattr(result, "success", None) is True
        self.retain_json(
            prefix + "-attempt",
            "backend_attempt",
            {
                "attempt_index": index,
                "task_config": self.task_config,
                "input_artifact_id": input_id,
                "result_artifact_id": result_id,
                "elapsed_seconds": canonical(time.monotonic() - attempt_start),
                "success": native_success,
                "observed_qcengine_retries": getattr(
                    getattr(result, "provenance", None), "retries", None
                )
                if native_success
                else None,
            },
        )
        if not native_success:
            raise ValueError("BACKEND_FAILURE: " + str(getattr(result, "error", "unknown"))[:1500])
        checked = self.qcel.models.AtomicResult.parse_raw(raw_text)
        raw = json.loads(checked.json())
        if not isinstance(raw, dict):
            raise ValueError("INVALID_TOOL_OUTPUT: expected AtomicResult object")
        records._raw_geometry(
            records._json_object(raw_text)["molecule"],
            checked_geometry,
            self.spec.get("isotope_binding"),
        )
        gradient = self.np.asarray(raw["return_result"]).reshape((-1, 3)).tolist()
        frame = records.seal_refinement_frame(
            {
                "version": records.FRAME_VERSION,
                "evaluation_index": len(self.frames),
                "optimizer_iteration": None,
                "step_status": "unknown",
                "reevaluates_frame_hash": None,
                "geometry": copy.deepcopy(checked_geometry),
                "energy_hartree": canonical(raw["properties"]["return_energy"]),
                "gradient_hartree_per_bohr": [[canonical(c) for c in row] for row in gradient],
                "elapsed_wall_seconds": canonical(time.monotonic() - self.started),
                "physical_time_s": None,
                "raw_input_json": input_text,
                "raw_result_json": raw_text,
                "raw_input_artifact_id": input_id,
                "raw_result_artifact_id": result_id,
            }
        )
        # Admit the full raw envelope (including method, keywords and provenance)
        # before an optimizer can receive its energy or force.
        records._frame(
            self.spec,
            frame,
            len(self.frames),
            {reference["artifact_id"]: reference for reference in self.artifacts},
        )
        self.frames.append(frame)
        self.retain_json(prefix + "-frame", "log", frame)
        return raw

    def result(self, reported: bool | None, failure: Exception | None) -> dict[str, Any]:
        """Seal partial evidence with the same geometric eligibility as the validator."""
        if self.last_native_report is not None:
            if type(self.last_native_report) is not bool:
                raise ValueError(
                    "INVALID_TOOL_OUTPUT: native convergence must be boolean or unknown"
                )
            reported = self.last_native_report
        observation_text = None
        observation_id = None
        if self.optimizer_events:
            self.retain(
                "optimizer-events",
                "optimizer_raw",
                self._serialization.json_dumps({"events": self.optimizer_events}),
            )
            observation_id = "optimizer-observation"
            observation_text = self.retain_json(
                observation_id,
                "optimizer_observation",
                {
                    "version": records.OBSERVATION_VERSION,
                    "spec_hash": self.spec["spec_hash"],
                    "engine": "optking",
                    "reported_converged": reported,
                    "final_frame_hash": self.frames[-1]["frame_hash"] if self.frames else None,
                    "attributions": [
                        {
                            key: frame[key]
                            for key in (
                                "frame_hash",
                                "optimizer_iteration",
                                "step_status",
                                "reevaluates_frame_hash",
                            )
                        }
                        for frame in self.frames
                    ],
                    "backend_attempts_observed": self.attempts,
                    "source_artifact_ids": ["optimizer-events"],
                },
            )
        else:
            reported = None
        accepted = [
            frame for frame in self.frames if frame["step_status"] in {"initial", "accepted"}
        ]
        eligible = (
            observation_text is not None
            and len(accepted) >= 2
            and (
                self.frames[-1] is accepted[-1]
                or (
                    self.frames[-1]["step_status"] == "reevaluation"
                    and self.frames[-1]["reevaluates_frame_hash"] == accepted[-1]["frame_hash"]
                )
            )
        )
        if eligible and any(
            frame["step_status"] == "unknown"
            for frame in self.frames[accepted[-2]["evaluation_index"] + 1 :]
        ):
            eligible = False
        geometry_status = "not_checked"
        if eligible:
            metrics = records._metrics(accepted[-2], accepted[-1], self.frames[-1])
            geometry_status = (
                "satisfied"
                if all(
                    value <= Decimal(self.spec["optimizer_settings"]["criteria"][key])
                    for key, value in metrics.items()
                )
                else "not_satisfied"
            )
        failure_record = None
        if failure is not None:
            self.retain_json(
                "worker-failure",
                "failure",
                {
                    "type": type(failure).__name__,
                    "message": str(failure)[:4096],
                    "notes": [str(note)[:4096] for note in getattr(failure, "__notes__", [])],
                },
            )
            failure_record = {
                "phase": self.phase,
                "code": type(failure).__name__,
                "message": str(failure)[:4096] or "Unknown worker error",
                "last_evaluated_frame_hash": self.frames[-1]["frame_hash"] if self.frames else None,
                "artifact_id": "worker-failure",
            }
        final_reevaluation = bool(self.frames and self.frames[-1]["step_status"] == "reevaluation")
        return records.seal_refinement_result(
            self.spec,
            {
                "version": records.RESULT_VERSION,
                "spec_hash": self.spec["spec_hash"],
                "state": "failed"
                if failure is not None
                else "succeeded"
                if reported is True and geometry_status == "satisfied" and final_reevaluation
                else "incomplete",
                "evidence_origin": "worker_record",
                "runtime_binding_hash": self.spec["runtime_binding"]["binding_hash"],
                "basis_binding_hash": self.spec["basis_binding"]["binding_hash"],
                "trajectory": self.frames,
                "final_frame_hash": self.frames[-1]["frame_hash"] if self.frames else None,
                "convergence": {
                    "geometry_status": geometry_status,
                    "minimum_status": "not_evaluated",
                    "optimizer_reported_converged": reported,
                    "optimizer_observation_json": observation_text,
                    "optimizer_observation_artifact_id": observation_id,
                },
                "timing": {
                    "clock": "wall",
                    "elapsed_seconds": canonical(time.monotonic() - self.started),
                    "physical_duration_seconds": None,
                    "backend_attempts_observed": self.attempts,
                },
                "failure": failure_record,
                "raw_artifacts": self.artifacts,
            },
        )
