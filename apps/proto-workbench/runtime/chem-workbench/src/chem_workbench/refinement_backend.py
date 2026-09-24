"""First-party Psi4 gradient recorder and explicit OptKing iteration driver.

This module runs only inside the separately supervised scientific worker. Every
successful frame binds a genuine QCSchema gradient request and response. An
optimizer iteration is not physical time, and convergence does not prove a minimum.
"""

from __future__ import annotations

import copy
import hashlib
import importlib
import json
import time
from decimal import Decimal, localcontext
from pathlib import Path
from typing import Any

from chem_workbench.chemir.constraints import canonical_decimal
from chem_workbench.execution_validation import verify_hash
from chem_workbench.method_profiles import ANGSTROM_TO_BOHR, artifact_ref, gradient_driver_arguments
from chem_workbench.molecular_refinement import (
    FRAME_VERSION,
    OBSERVATION_VERSION,
    RESULT_VERSION,
    seal_refinement_frame,
    seal_refinement_geometry,
    seal_refinement_result,
    validate_refinement_spec,
)
from chem_workbench.refinement_isotopes import validate_isotope_binding
from chem_workbench.visualization import content_hash


def canonical(value: object) -> str:
    rendered = canonical_decimal(str(value))
    if rendered is None:
        raise ValueError("INVALID_NUMBER: nonfinite refinement value")
    return rendered


def verified_file(root: Path, reference: dict[str, Any]) -> Path:
    """Resolve a referenced file with component-level reparse and byte checks."""
    artifact_ref(reference)
    path = root
    for part in reference["path"].split("/"):
        path = path / part
        info = path.lstat()
        if path.is_symlink() or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("REFINEMENT_PATH_ESCAPE: reparse component")
    if not path.resolve().is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError("REFINEMENT_PATH_ESCAPE: file outside artifact root")
    with path.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual != reference["sha256"]:
        raise ValueError("APPROVAL_STALE: refinement artifact bytes changed")
    return path


def verify_spec_artifacts(spec: dict[str, Any], root: Path) -> None:
    for reference in [
        spec["source_binding"]["artifact"],
        spec["electronic_settings"]["effective_options_artifact"],
        *spec["basis_binding"]["files"],
        *spec["runtime_binding"]["files"],
    ]:
        verified_file(root, reference)
    cohort = json.loads(
        verified_file(root, spec["source_binding"]["artifact"]).read_text(encoding="utf-8")
    )
    if cohort.get("version") != "refinement-complex-cohort/v1":
        raise ValueError("UNSUPPORTED_PROFILE: validated candidate cohort required")
    verify_hash(cohort, "cohort_hash")
    targets = [
        target
        for target in cohort["targets"]
        if target["original_candidate_hash"] == spec["source_binding"]["candidate_hash"]
    ]
    if len(targets) != 1:
        raise ValueError("APPROVAL_STALE: candidate not uniquely bound in cohort")
    target = targets[0]
    verify_hash(target, "target_hash")
    if (
        target["geometry"] != spec["geometry"]
        or target["atom_identity_hash"] != spec["source_binding"]["atom_identity_hash"]
    ):
        raise ValueError("APPROVAL_STALE: candidate coordinates or atom IDs changed")
    snapshot_path = verified_file(root, target["retained_candidate_snapshot"])
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    verify_hash(snapshot, "candidate_hash")
    source_hash = "sha256:" + hashlib.sha256(snapshot["source"].encode()).hexdigest()
    if (
        snapshot["candidate_hash"] != spec["source_binding"]["candidate_hash"]
        or source_hash != spec["source_binding"]["source_hash"]
    ):
        raise ValueError("APPROVAL_STALE: candidate source or identity changed")
    # Verify the snapshot against the original retained evaluation row, not only its copy.
    original = target["original_artifacts"]
    row = json.loads(verified_file(root, original["evaluation_row"]).read_text(encoding="utf-8"))
    selected = row
    for token in original["candidate_json_pointer"].split("/")[1:]:
        selected = selected[int(token)] if isinstance(selected, list) else selected[token]
    if selected != snapshot:
        raise ValueError("APPROVAL_STALE: candidate snapshot differs from original run")
    exact = json.loads(snapshot_path.read_text(encoding="utf-8"), parse_float=Decimal)
    expected_atoms = [
        {
            "id": atom["id"],
            "element": atom["element"],
            "position": [canonical(c) for c in atom["position"]],
        }
        for atom in exact["geometry"]["atoms"]
    ]
    if expected_atoms != spec["geometry"]["atoms"]:
        raise ValueError("APPROVAL_STALE: coordinates differ from candidate numeric tokens")
    options = json.loads(
        verified_file(root, spec["electronic_settings"]["effective_options_artifact"]).read_text(
            encoding="utf-8"
        )
    )
    if options["native_keywords"] != spec["electronic_settings"]["native_keywords"]:
        raise ValueError("APPROVAL_STALE: effective options artifact differs from spec")
    # The host binds the full installed runtime manifest as one transitive artifact.
    from chem_workbench.runtime_identity import refinement_environment_identity

    runtime_refs = spec["runtime_binding"]["files"]
    if len(runtime_refs) != 1:
        raise ValueError("UNSUPPORTED_PROFILE: one complete runtime manifest required")
    expected = json.loads(verified_file(root, runtime_refs[0]).read_text(encoding="utf-8"))
    actual = refinement_environment_identity(root, profile_id=spec["profile"]["profile_id"])
    if expected != actual:
        raise ValueError("APPROVAL_STALE: installed refinement runtime changed")
    if "isotope_binding" in spec:
        binding = validate_isotope_binding(
            spec["isotope_binding"], spec["geometry"], spec["runtime_binding"]
        )
        observed = json.loads(verified_file(root, binding["artifact"]).read_text(encoding="utf-8"))
        verify_hash(observed, "observation_hash")
        expected_observation = {
            "version": "refinement-isotope-observation/v1",
            "policy": binding["policy"],
            "geometry_hash": binding["geometry_hash"],
            "runtime_binding_hash": binding["runtime_binding_hash"],
            "atoms": binding["atoms"],
        }
        if observed != {
            **expected_observation,
            "observation_hash": content_hash(expected_observation),
        }:
            raise ValueError("APPROVAL_STALE: isotope observation differs from binding")


class GradientRecorder:
    def __init__(self, spec: dict[str, Any], output: Path, root: Path):
        self.spec = validate_refinement_spec(spec)
        self.output = output
        self.root = root
        self.started = time.monotonic()
        self.phase = "preflight"
        self.frames: list[dict[str, Any]] = []
        self.artifacts: list[dict[str, Any]] = []
        self.attempts = 0
        self.qcel = importlib.import_module("qcelemental")
        self.qcengine = importlib.import_module("qcengine")
        self.psi4 = importlib.import_module("psi4")
        self.np = importlib.import_module("numpy")
        self.optimizer_events: list[dict[str, Any]] = []
        retry = spec["resources"]["backend_retry_policy"]
        if retry["requested_retries"] != 0 or retry["effective_retries"] != 0:
            raise ValueError("UNSUPPORTED_PROFILE: direct recorder admits zero retries only")
        self.task_config = {
            "ncores": spec["resources"]["threads"],
            "memory": spec["resources"]["memory_bytes"] / 1024**3 * 0.6,
            "retries": 0,
            "scratch_directory": str(output.parent / "scratch"),
        }

    def retain(self, identity: str, role: str, text: str) -> str:
        path = self.output.parent / (identity + ".json")
        data = text.encode("utf-8")
        with path.open("xb") as stream:
            stream.write(data)
        self.artifacts.append(
            {
                "artifact_id": identity,
                "role": role,
                "path": path.relative_to(self.root).as_posix(),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
        )
        return identity

    def retain_json(self, identity: str, role: str, value: object) -> str:
        text = json.dumps(value, sort_keys=True, allow_nan=False)
        self.retain(identity, role, text)
        return text

    def settings(self) -> dict[str, Any]:
        keywords = self.spec["electronic_settings"]["native_keywords"]
        # Psi4's QCSchema wrapper forwards function_kwargs to the driver instead
        # of treating it as an SCF option. Preserve it in the actual AtomicInput.
        scf_keywords = {key: value for key, value in keywords.items() if key != "function_kwargs"}
        self.psi4.set_options(scf_keywords)
        self.psi4.set_num_threads(self.spec["resources"]["threads"])
        self.psi4.set_memory(int(self.spec["resources"]["memory_bytes"] * 0.6))
        functional_module = importlib.import_module("psi4.driver.procrouting.dft.dft_builder")
        definition = functional_module.functionals[self.spec["profile"]["method"]]
        if (
            content_hash(definition)
            != self.spec["electronic_settings"]["functional_definition_hash"]
        ):
            raise ValueError("APPROVAL_STALE: effective functional definition changed")
        effective = {key: self.psi4.core.get_option("SCF", key.upper()) for key in scf_keywords}
        for key, value in scf_keywords.items():
            actual = effective[key]
            if isinstance(value, str):
                matches = isinstance(actual, str) and actual.casefold() == value.casefold()
            elif key in {"fail_on_maxiter", "df_scf_guess", "puream"} and type(value) is bool:
                # Psi4 1.11's native Options API exposes boolean options as ints.
                # Preserve this observed native value; the actual input stays bool.
                matches = type(actual) is int and actual == int(value)
            else:
                matches = type(actual) is type(value) and actual == value
            if not matches:
                raise ValueError("APPROVAL_STALE: native option not applied: " + key)
        return effective

    def verify_dispersion_support(self) -> None:
        """Record the installed functor and exact named-method parameters before SCF."""
        declared = self.spec["profile"].get("dispersion")
        if declared is None:
            return
        proc = importlib.import_module("psi4.driver.procrouting.proc")
        library = importlib.import_module("dftd3.library")
        functional, dispersion = proc.build_functional_and_disp(
            self.spec["profile"]["method"], True, engine=declared["engine"]
        )
        available = self.qcengine.get_program(declared["engine"]).found(raise_error=True)
        parameters = {key: canonical(value) for key, value in dispersion.dashparams.items()}
        # The named Psi4 functor exposes the two-body parameters. The bound
        # QCEngine 2b alias supplies s9=0 to the installed s-dftd3 API.
        expected = {key: value for key, value in declared["parameters"].items() if key != "s9"}
        evidence = {
            "version": "refinement-dispersion-preflight/v1",
            "spec_hash": self.spec["spec_hash"],
            "engine": dispersion.engine,
            "level": dispersion.dashlevel,
            "functional_name": functional.name(),
            "needs_vv10": functional.needs_vv10(),
            "parameters": parameters,
            "library_api_version": library.get_api_version(),
            "program_available": available,
            "backend_dispatches": 0,
            "nested_program": "s-dftd3",
            "nested_attempts_observed": None,
        }
        self.retain_json("dispersion-preflight", "log", evidence)
        if (
            available is not True
            or dispersion.engine != declared["engine"]
            or dispersion.dashlevel != declared["type"]
            or parameters != expected
            or functional.needs_vv10() is not False
        ):
            raise ValueError(
                "APPROVAL_STALE: effective dispersion implementation differs from profile"
            )

    def verify_derivative_support(self) -> None:
        """Refuse implicit finite differences before any backend computation."""
        self.phase = "preflight"
        kwargs = self.spec["electronic_settings"]["native_keywords"].get("function_kwargs")
        if kwargs != gradient_driver_arguments(self.spec["profile"]):
            raise ValueError("UNSUPPORTED_PROFILE: actual gradient request must force dertype=1")
        utility = importlib.import_module("psi4.driver.driver_util")
        evidence: dict[str, Any] = {
            "version": "refinement-derivative-preflight/v1",
            "spec_hash": self.spec["spec_hash"],
            "method": self.spec["profile"]["method"],
            "driver": "gradient",
            "required_derivative_order": 1,
            "backend_dispatches": 0,
        }
        try:
            strategy = utility.negotiate_derivative_type(
                "gradient", self.spec["profile"]["method"], 1, verbose=0
            )
            evidence["observed_strategy"] = strategy
            admitted = (
                type(strategy) is tuple
                and len(strategy) == 2
                and all(type(order) is int and order == 1 for order in strategy)
            )
        except Exception as error:
            evidence["error"] = {"type": type(error).__name__, "message": str(error)[:4096]}
            admitted = False
        evidence["analytic_gradient_available"] = admitted
        self.retain_json("derivative-preflight", "log", evidence)
        if not admitted:
            raise ValueError(
                "UNSUPPORTED_PROFILE: installed runtime cannot supply the requested analytic "
                "gradient; implicit finite differences are not admitted"
            )

    def verify_isotope_defaults(self) -> None:
        """Match every explicitly bound isotope against this installed runtime."""
        binding = self.spec.get("isotope_binding")
        if binding is None:
            return
        actual = [
            {
                "atom_id": atom["id"],
                "element": atom["element"],
                "atomic_number": int(self.qcel.periodictable.to_Z(atom["element"])),
                "mass_number": int(self.qcel.periodictable.to_A(atom["element"])),
                "mass_dalton": canonical(
                    self.qcel.periodictable.to_mass(atom["element"], return_decimal=True)
                ),
            }
            for atom in self.spec["geometry"]["atoms"]
        ]
        self.retain_json(
            "isotope-defaults-observed",
            "log",
            {
                "binding_hash": binding["binding_hash"],
                "atoms": actual,
                "matches_bound_defaults": actual == binding["atoms"],
                "backend_dispatches": 0,
            },
        )
        if actual != binding["atoms"]:
            raise ValueError("APPROVAL_STALE: bound nuclear identity differs from runtime defaults")

    def molecule(self, geometry: dict[str, Any]) -> Any:
        isotope_kwargs = {}
        if "isotope_binding" in self.spec:
            atoms = self.spec["isotope_binding"]["atoms"]
            isotope_kwargs = {
                "masses": [float(atom["mass_dalton"]) for atom in atoms],
                "mass_numbers": [atom["mass_number"] for atom in atoms],
                "atomic_numbers": [atom["atomic_number"] for atom in atoms],
            }
        return self.qcel.models.Molecule(
            symbols=[atom["element"] for atom in geometry["atoms"]],
            atom_labels=[atom["id"] for atom in geometry["atoms"]],
            geometry=[
                float(coordinate) * float(ANGSTROM_TO_BOHR)
                for atom in geometry["atoms"]
                for coordinate in atom["position"]
            ],
            molecular_charge=geometry["charge"],
            molecular_multiplicity=geometry["multiplicity"],
            fix_com=True,
            fix_orientation=True,
            fix_symmetry="c1",
            **isotope_kwargs,
        )

    def evaluated_geometry(self, molecule: dict[str, Any]) -> dict[str, Any]:
        if not self.frames:
            return copy.deepcopy(self.spec["geometry"])
        values = self.np.asarray(molecule["geometry"]).reshape((-1, 3)).tolist()
        atoms = []
        with localcontext() as context:
            context.prec = 40
            for atom, position in zip(self.spec["geometry"]["atoms"], values, strict=True):
                atoms.append(
                    {
                        "id": atom["id"],
                        "element": atom["element"],
                        "position": [
                            canonical(Decimal(str(c)) / Decimal(ANGSTROM_TO_BOHR)) for c in position
                        ],
                    }
                )
        return seal_refinement_geometry(
            {
                "version": "refinement-geometry/v1",
                "units": "angstrom",
                "charge": self.spec["geometry"]["charge"],
                "multiplicity": self.spec["geometry"]["multiplicity"],
                "atoms": atoms,
            }
        )

    def evaluate(self, molecule: dict[str, Any]) -> dict[str, Any]:
        self.phase = "gradient"
        if len(self.frames) >= self.spec["optimizer_settings"]["max_gradient_evaluations"]:
            raise ValueError("RESOURCE_LIMIT: gradient evaluation budget exhausted")
        if time.monotonic() - self.started >= self.spec["resources"]["wall_seconds"]:
            raise ValueError("RESOURCE_LIMIT: worker wall budget exhausted")
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
        )
        input_text = atomic_input.json()
        input_id = self.retain(prefix + "-input", "atomic_input", input_text)
        # Check the genuine schema envelope before spending a gradient evaluation.
        from chem_workbench.molecular_refinement import _raw_geometry

        raw_input_molecule = json.loads(input_text)["molecule"]
        expected_input_geometry = self.evaluated_geometry(raw_input_molecule)
        _raw_geometry(
            json.loads(input_text, parse_float=Decimal)["molecule"],
            expected_input_geometry,
            self.spec.get("isotope_binding"),
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
            },
        )
        self.attempts += 1
        try:
            result = self.qcengine.compute(
                atomic_input, "psi4", raise_error=False, task_config=dict(self.task_config)
            )
        except Exception as error:
            self.retain_json(
                prefix + "-attempt",
                "backend_attempt",
                {
                    "attempt_index": index,
                    "task_config": self.task_config,
                    "input_artifact_id": input_id,
                    "result_artifact_id": None,
                    "elapsed_seconds": canonical(time.monotonic() - attempt_start),
                    "success": False,
                    "exception_type": type(error).__name__,
                    "exception_message": str(error)[:4096],
                    "observed_qcengine_retries": None,
                },
            )
            raise
        raw_text = result.json()
        result_id = self.retain(prefix + "-result", "atomic_result", raw_text)
        self.retain_json(
            prefix + "-attempt",
            "backend_attempt",
            {
                "attempt_index": index,
                "task_config": self.task_config,
                "input_artifact_id": input_id,
                "result_artifact_id": result_id,
                "elapsed_seconds": canonical(time.monotonic() - attempt_start),
                "success": result.success is True,
                "observed_qcengine_retries": getattr(result.provenance, "retries", None)
                if result.success is True
                else None,
            },
        )
        if result.success is not True:
            raise ValueError("BACKEND_FAILURE: " + str(getattr(result, "error", "unknown"))[:1500])
        # Validate the installed real schema before projecting the smaller product envelope.
        checked = self.qcel.models.AtomicResult.parse_raw(raw_text)
        raw = json.loads(checked.json())
        if not isinstance(raw, dict):
            raise ValueError("INVALID_TOOL_OUTPUT: expected AtomicResult object")
        _raw_geometry(
            json.loads(raw_text, parse_float=Decimal)["molecule"],
            expected_input_geometry,
            self.spec.get("isotope_binding"),
        )
        gradient = self.np.asarray(raw["return_result"]).reshape((-1, 3)).tolist()
        geometry = self.evaluated_geometry(raw["molecule"])
        frame = seal_refinement_frame(
            {
                "version": FRAME_VERSION,
                "evaluation_index": len(self.frames),
                "optimizer_iteration": None,
                "step_status": "unknown",
                "reevaluates_frame_hash": None,
                "geometry": geometry,
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
        self.frames.append(frame)
        self.retain_json(prefix + "-frame", "log", frame)
        print(
            json.dumps(
                {
                    "event": "gradient_completed",
                    "evaluation": len(self.frames),
                    "energy_hartree": frame["energy_hartree"],
                    "elapsed": frame["elapsed_wall_seconds"],
                }
            ),
            flush=True,
        )
        return raw

    def attribute(self, iteration: int, status: str) -> None:
        body = {key: value for key, value in self.frames[-1].items() if key != "frame_hash"}
        body.update(optimizer_iteration=iteration, step_status=status)
        self.frames[-1] = seal_refinement_frame(body)

    def optimize(self) -> bool:
        self.phase = "optimization"
        opt = importlib.import_module("optking.optimize")
        wrappers = importlib.import_module("optking.compute_wrappers")
        optwrapper = importlib.import_module("optking.optwrapper")
        history_module = importlib.import_module("optking.history")
        molsys_module = importlib.import_module("optking.molsys")
        options = self.spec["optimizer_settings"]
        criteria = options["criteria"]
        params = optwrapper.initialize_options(
            {
                "program": "psi4",
                "opt_coordinates": "cartesian",
                "step_type": "rfo",
                "full_hess_every": -1,
                "intrafrag_hess": "simple",
                "linesearch": False,
                "write_trajectory": False,
                "geom_maxiter": options["maximum_iterations"],
                "flexible_g_convergence": False,
                "max_force_g_convergence": float(criteria["max_force_hartree_per_bohr"]),
                "rms_force_g_convergence": float(criteria["rms_force_hartree_per_bohr"]),
                "max_disp_g_convergence": float(criteria["max_displacement_bohr"]),
                "rms_disp_g_convergence": float(criteria["rms_displacement_bohr"]),
            },
            silent=True,
        )
        recorder = self

        def compute(computer: Any, driver: str) -> Any:
            if driver != "gradient":
                raise ValueError("UNSUPPORTED_PROFILE: optimizer requested non-gradient")
            return recorder.qcel.models.AtomicResult(**recorder.evaluate(computer.molecule))

        computer_class = type(
            "RecordedGradientComputer", (wrappers.ComputeWrapper,), {"_compute": compute}
        )

        molecule = json.loads(self.molecule(self.spec["geometry"]).json())
        computer = computer_class(
            molecule,
            {"method": self.spec["profile"]["method"], "basis": self.spec["profile"]["basis"]},
            self.spec["electronic_settings"]["native_keywords"],
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
            previous_count = len(self.frames)
            hessian, force, energy = manager.start_step(hessian)
            if len(self.frames) != previous_count + 1:
                raise ValueError("UNSUPPORTED_PROFILE: unexpected optimizer evaluation pattern")
            evaluated = self.np.asarray(computer.molecule["geometry"]).reshape((-1, 3)).copy()
            prior_history_ids = [id(step) for step in history.steps]
            self.phase = "optimization"
            displacement = manager.take_step(force, hessian, energy, return_str=False)
            # OptKing appends evaluated points and removes a rejected backstep.
            # Bind the observed history immediately; never use its proposed next geometry.
            after_history_ids = [id(step) for step in history.steps]
            retained = (
                len(after_history_ids) == len(prior_history_ids) + 1
                and after_history_ids[:-1] == prior_history_ids
                and self.np.array_equal(evaluated, history.steps[-1].geom)
            )
            if not retained and after_history_ids != prior_history_ids:
                raise ValueError("UNSUPPORTED_PROFILE: unexplained optimizer history change")
            status = (
                "initial" if iteration == 0 and retained else "accepted" if retained else "rejected"
            )
            event = {
                "iteration": iteration,
                "evaluated_geometry_bohr": evaluated.tolist(),
                "history": copy.deepcopy([step.to_dict() for step in history.steps]),
                "prior_history_entry_count": len(prior_history_ids),
                "new_evaluated_entry_retained": retained,
                "proposed_geometry_bohr": system.geom.tolist(),
                "retained_evaluated_point": retained,
                "reported_converged": None,
            }
            self.optimizer_events.append(event)
            self.attribute(iteration, status)
            reported = manager.converged(energy, force, displacement) is True
            event["reported_converged"] = reported
            if reported:
                return True
        return False

    def result(self, reported: bool | None, failure: Exception | None) -> dict[str, Any]:
        observation_text = None
        observation_id = None
        if self.optimizer_events:
            serializer = importlib.import_module("qcelemental.util.serialization")
            optimizer_text = serializer.json_dumps({"events": self.optimizer_events})
            self.retain("optimizer-events", "optimizer_raw", optimizer_text)
            observation_id = "optimizer-observation"
            observation_text = self.retain_json(
                observation_id,
                "optimizer_observation",
                {
                    "version": OBSERVATION_VERSION,
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
        elif reported is not None:
            reported = None
        accepted = [f for f in self.frames if f["step_status"] in {"initial", "accepted"}]
        geometry_status = "not_checked"
        if len(accepted) >= 2 and self.frames[-1] is accepted[-1]:
            from chem_workbench.molecular_refinement import _metrics

            metrics = _metrics(accepted[-2], accepted[-1], self.frames[-1])
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
                {"type": type(failure).__name__, "message": str(failure)[:4096]},
            )
            failure_record = {
                "phase": self.phase,
                "code": type(failure).__name__,
                "message": str(failure)[:4096] or "Unknown worker error",
                "last_evaluated_frame_hash": self.frames[-1]["frame_hash"] if self.frames else None,
                "artifact_id": "worker-failure",
            }
        return seal_refinement_result(
            self.spec,
            {
                "version": RESULT_VERSION,
                "spec_hash": self.spec["spec_hash"],
                "state": "failed"
                if failure
                else "succeeded"
                if reported is True and geometry_status == "satisfied"
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


def run(request: dict[str, Any], output: Path, root: Path) -> dict[str, Any]:
    if (
        set(request) != {"version", "mode", "spec"}
        or request["version"] != "refinement-worker-request/v1"
        or request["mode"] not in {"gradient", "optimization"}
    ):
        raise ValueError("INVALID_ARGUMENT: refinement worker request")
    spec = validate_refinement_spec(request["spec"])
    verify_spec_artifacts(spec, root)
    recorder = GradientRecorder(spec, output, root)
    failure = None
    reported = None
    try:
        recorder.retain_json("effective-options-observed", "log", recorder.settings())
        recorder.verify_isotope_defaults()
        recorder.verify_dispersion_support()
        recorder.verify_derivative_support()
        if request["mode"] == "gradient":
            recorder.evaluate(json.loads(recorder.molecule(spec["geometry"]).json()))
        else:
            reported = recorder.optimize()
    except Exception as error:
        failure = error
    # Preserve evaluated frames in a failed envelope when post-run binding drifts.
    try:
        verify_spec_artifacts(spec, root)
    except Exception as error:
        recorder.retain_json(
            "post-run-binding-failure",
            "log",
            {
                "type": type(error).__name__,
                "message": str(error)[:4096],
            },
        )
        failure = error
    return recorder.result(reported, failure)
