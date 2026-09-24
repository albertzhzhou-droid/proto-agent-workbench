"""Observed runtime admission for a separately authorized refinement worker.

Create one verifier per lifecycle and share its injected importer with that
lifecycle. The first call applies and observes session options; the second records
post-call session state. Neither is proof of options used inside QCSchema: the
dispatch's native gradient-entry observation supplies that independent evidence.
Both calls authenticate the installed closure and retain partial observations.
Subject/approval verification is separate. No electronic or dispersion evaluation
is requested here, and importing this module loads no native runtime.
"""

from __future__ import annotations

import copy
import hashlib
import importlib
import json
import os
import platform
import stat
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

from chem_workbench.method_profiles import D3BJ_PROFILE_ID, gradient_driver_arguments
from chem_workbench.molecular_refinement import MASS_BOUND_SPEC_VERSION, _json_object, _raw_geometry
from chem_workbench.refinement_backend import GradientRecorder, canonical, verified_file
from chem_workbench.refinement_execution.native_options import option_matches
from chem_workbench.refinement_execution.worker_lifecycle import _directory
from chem_workbench.refinement_isotopes import validate_isotope_binding
from chem_workbench.runtime_identity import refinement_environment_identity
from chem_workbench.visualization import content_hash

Record = dict[str, Any]
RUNTIME_PREFLIGHT_FILES = ("runtime-preflight-0000.json", "runtime-preflight-0001.json")
NATIVE_PACKAGES = {
    "psi4",
    "optking",
    "qcengine",
    "qcelemental",
    "numpy",
    "pydantic",
    "pydantic_core",
    "msgpack",
    "dftd3",
}


class RuntimeContext(Protocol):
    @property
    def root(self) -> Path: ...

    @property
    def code_root(self) -> Path: ...

    @property
    def runtime_root(self) -> Path: ...

    @property
    def run_directory(self) -> str: ...

    @property
    def run_id(self) -> str: ...

    @property
    def run_nonce(self) -> str: ...

    @property
    def native_task_config(self) -> Record: ...


class EnvironmentIdentity(Protocol):
    def __call__(self, repository: Path, *, profile_id: str) -> Record: ...


def process_identity() -> Record:
    """Observe the actual interpreter and loaded native-package source locations."""
    return {
        "python": platform.python_version(),
        "prefix": str(Path(sys.prefix).resolve()),
        "executable": str(Path(sys.executable).resolve()),
        "cwd": os.getcwd(),
        "psipath": os.environ.get("PSIPATH", ""),
        "loaded_module_origins": {
            name: str(module.__file__)
            for name, module in list(sys.modules.items())
            if name.partition(".")[0] in NATIVE_PACKAGES
            and module is not None
            and getattr(module, "__file__", None) is not None
        },
    }


def _same(actual: object, expected: object, label: str) -> None:
    if content_hash(actual) != content_hash(expected):
        raise ValueError("APPROVAL_STALE: " + label + " differs from binding")


def _read(root: Path, reference: Record) -> Record:
    value = json.loads(verified_file(root, reference).read_bytes())
    if not isinstance(value, dict):
        raise ValueError("APPROVAL_STALE: bound object required")
    return value


class _Observation:
    """One owned, durable file; retain progress even when a later check fails."""

    def __init__(self, context: RuntimeContext, name: str, body: Record):
        self.context = context
        self.path = _directory(context.root, context.run_directory) / name
        self.stream = self.path.open("x+b", buffering=0)
        self.identity = os.fstat(self.stream.fileno())
        self.body = body
        self.raw = b""

    def flush(self) -> None:
        _directory(self.context.root, self.context.run_directory)
        path_info = self.path.lstat()
        handle_info = os.fstat(self.stream.fileno())
        for info in (path_info, handle_info):
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_nlink != 1
                or getattr(info, "st_file_attributes", 0) & 0x400
                or (info.st_dev, info.st_ino) != (self.identity.st_dev, self.identity.st_ino)
            ):
                raise ValueError("REFINEMENT_PATH_ESCAPE: preflight file identity changed")
        self.stream.seek(0)
        if self.stream.read(len(self.raw) + 1) != self.raw:
            raise ValueError("APPROVAL_STALE: preflight observation bytes changed")
        raw = json.dumps(self.body, sort_keys=True, allow_nan=False).encode()
        self.stream.seek(0)
        self.stream.write(raw)
        self.stream.truncate()
        os.fsync(self.stream.fileno())
        self.raw = raw
        after = self.path.lstat()
        if (after.st_dev, after.st_ino, after.st_nlink) != (
            self.identity.st_dev,
            self.identity.st_ino,
            1,
        ):
            raise ValueError("REFINEMENT_PATH_ESCAPE: preflight file replaced during write")

    def reference(self) -> Record:
        return {
            "path": self.path.relative_to(self.context.root).as_posix(),
            "sha256": hashlib.sha256(self.raw).hexdigest(),
        }


class _MoleculeProbe(GradientRecorder):
    """Reuse only the legacy explicit-mass molecule constructor, without its imports."""

    def __init__(self, spec: Record, qcel: Any):
        self.spec = spec
        self.qcel = qcel


class RuntimePreflight:
    """Stateful two-call verifier; object shape does not grant launch authority."""

    def __init__(
        self,
        *,
        import_module: Callable[[str], Any] = importlib.import_module,
        environment_identity: EnvironmentIdentity = refinement_environment_identity,
        observe_process: Callable[[], Record] = process_identity,
    ):
        self._import = import_module
        self._environment = environment_identity
        self._process = observe_process
        self._calls = 0
        self._bound: str | None = None
        self._modules: dict[str, Any] = {}
        self.observations: list[Record] = []

    def __call__(self, spec: Record, context: RuntimeContext) -> None:
        from chem_workbench.molecular_refinement import validate_refinement_spec

        checked = validate_refinement_spec(spec)
        if (
            checked["version"] != MASS_BOUND_SPEC_VERSION
            or checked["profile"]["profile_id"] != D3BJ_PROFILE_ID
        ):
            raise ValueError("UNSUPPORTED_PROFILE: mass-bound D3BJ runtime required")
        if self._calls >= len(RUNTIME_PREFLIGHT_FILES):
            raise ValueError("APPROVAL_STALE: runtime verifier already used twice")
        for root in (context.code_root, context.runtime_root):
            if not isinstance(root, Path) or not root.is_absolute() or not root.is_dir():
                raise ValueError("HOST_ADMISSION_REQUIRED: absolute existing code/runtime roots")
        bound = content_hash(
            {
                "spec": checked,
                "run_id": context.run_id,
                "run_nonce": context.run_nonce,
                "root": str(context.root),
                "code_root": str(context.code_root),
                "runtime_root": str(context.runtime_root),
                "run_directory": context.run_directory,
                "native_task_config": context.native_task_config,
            }
        )
        if self._bound is not None and self._bound != bound:
            raise ValueError("APPROVAL_STALE: runtime verifier cannot change its admitted run")
        self._bound = bound
        index = self._calls
        self._calls += 1
        body: Record = {
            "version": "refinement-runtime-preflight/v2",
            "invocation_index": index,
            "run_id": context.run_id,
            "run_nonce": context.run_nonce,
            "spec_hash": checked["spec_hash"],
            "runtime_binding_hash": checked["runtime_binding"]["binding_hash"],
            "basis_binding_hash": checked["basis_binding"]["binding_hash"],
            "options_applied": False,
            "phase": "initial" if index == 0 else "terminal",
            "options_meaning": "applied_preflight_session" if index == 0 else "post_call_session",
            "native_execution_options_verified": False,
            "complete": False,
            "backend_dispatches": 0,
            "dispersion_evaluations": 0,
            "scientific_accuracy_validated": False,
            "started_monotonic_seconds": time.monotonic(),
            "checks": {},
        }
        observation = _Observation(context, RUNTIME_PREFLIGHT_FILES[index], body)
        failure: BaseException | None = None
        try:
            observation.flush()
            self._verify(checked, context, body["checks"], observation, apply=index == 0)
            body["complete"] = True
        except BaseException as error:
            failure = error
            body["error"] = {"type": type(error).__name__, "message": str(error)[:4096]}
            raise
        finally:
            body["finished_monotonic_seconds"] = time.monotonic()
            try:
                observation.flush()
                self.observations.append(observation.reference())
            except BaseException as retention_error:
                if failure is not None:
                    failure.add_note("Preflight retention also failed: " + str(retention_error))
                    raise failure from retention_error
                raise
            finally:
                observation.stream.close()

    def _common(self, spec: Record, context: RuntimeContext, observations: Record) -> Record:
        options = _read(context.root, spec["electronic_settings"]["effective_options_artifact"])
        _same(
            options["native_keywords"],
            spec["electronic_settings"]["native_keywords"],
            "declared options",
        )
        for reference in spec["basis_binding"]["files"]:
            verified_file(context.root, reference)
        runtime_refs = spec["runtime_binding"]["files"]
        if len(runtime_refs) != 1:
            raise ValueError("UNSUPPORTED_PROFILE: one complete runtime manifest required")
        expected = _read(context.root, runtime_refs[0])
        actual = self._environment(context.code_root, profile_id=spec["profile"]["profile_id"])
        observations["runtime_manifest"] = copy.deepcopy(actual)
        _same(actual, expected, "installed runtime closure")
        if Path(actual["prefix"]).resolve() != context.runtime_root.resolve():
            raise ValueError("APPROVAL_STALE: host runtime root differs from installed closure")
        binding = validate_isotope_binding(
            spec["isotope_binding"], spec["geometry"], spec["runtime_binding"]
        )
        isotope = _read(context.root, binding["artifact"])
        expected_isotope = {
            "version": "refinement-isotope-observation/v1",
            "policy": binding["policy"],
            "geometry_hash": binding["geometry_hash"],
            "runtime_binding_hash": binding["runtime_binding_hash"],
            "atoms": binding["atoms"],
        }
        _same(
            isotope,
            {**expected_isotope, "observation_hash": content_hash(expected_isotope)},
            "bound isotope artifact",
        )
        return copy.deepcopy(actual)

    @staticmethod
    def _origin(path: Path, prefix: Path, manifest: Record) -> Record:
        if not path.is_absolute() or not path.resolve().is_relative_to(prefix.resolve()):
            raise ValueError("APPROVAL_STALE: loaded runtime file outside admitted prefix")
        relative = path.relative_to(prefix).as_posix()
        digest = manifest["entries"].get(relative)
        if digest is None:
            raise ValueError("APPROVAL_STALE: loaded runtime file absent from manifest")
        verified_file(prefix, {"path": relative, "sha256": digest})
        return {"path": str(path), "runtime_relative_path": relative, "sha256": digest}

    def _verify(
        self,
        spec: Record,
        context: RuntimeContext,
        checks: Record,
        log: _Observation,
        *,
        apply: bool,
    ) -> None:
        manifest = self._common(spec, context, checks)
        checks["runtime_manifest"] = manifest
        log.flush()
        prefix = context.runtime_root
        before = self._process()
        checks["process_before"] = before
        if Path(before["prefix"]).resolve() != prefix.resolve():
            raise ValueError("APPROVAL_STALE: actual interpreter prefix differs")
        self._origin(Path(before["executable"]), prefix, manifest)
        modules: dict[str, Any] = {}
        origins: Record = {}
        checks["imported_modules"] = origins
        for name in (
            "psi4",
            "qcelemental",
            "qcengine",
            "optking",
            "numpy",
            "pydantic",
            "pydantic_core",
            "msgpack",
            "psi4.driver.procrouting.dft.dft_builder",
            "psi4.driver.procrouting.proc",
            "psi4.driver.driver_util",
            "psi4.driver.qcdb.libmintsbasisset",
            "dftd3.library",
        ):
            module = self._import(name)
            if name in self._modules and module is not self._modules[name]:
                raise ValueError(
                    "APPROVAL_STALE: shared importer returned a different native object"
                )
            self._modules[name] = module
            modules[name] = module
            origins[name] = self._origin(Path(module.__file__), prefix, manifest)
            log.flush()
        psi4, qcel, qce = (modules[name] for name in ("psi4", "qcelemental", "qcengine"))
        versions = {
            name: modules[name].__version__
            for name in ("psi4", "qcelemental", "qcengine", "optking")
        }
        versions["python"] = before["python"]
        libxc_records = []
        for path in sorted((prefix / "conda-meta").glob("libxc*.json")):
            self._origin(path, prefix, manifest)
            libxc_records.append(json.loads(path.read_bytes()))
        observed_versions = {record["version"] for record in libxc_records}
        if len(observed_versions) != 1:
            raise ValueError("APPROVAL_STALE: missing or ambiguous installed LibXC version")
        versions["libxc"] = observed_versions.pop()
        checks["versions"] = versions
        checks["libxc_package_records"] = libxc_records
        log.flush()
        _same(versions, spec["runtime_binding"]["versions"], "actual runtime versions")
        keywords = spec["electronic_settings"]["native_keywords"]
        _same(
            keywords.get("function_kwargs"),
            gradient_driver_arguments(spec["profile"]),
            "forced analytic arguments",
        )
        options = {key: value for key, value in keywords.items() if key != "function_kwargs"}
        _same(
            context.native_task_config,
            {
                "ncores": spec["resources"]["threads"],
                "memory": spec["resources"]["memory_bytes"] / 1024**3 * 0.6,
                "retries": 0,
                "scratch_directory": str(context.root / context.run_directory / "scratch"),
            },
            "host native configuration",
        )
        if apply:
            psi4.set_options(copy.deepcopy(options))
            psi4.set_num_threads(spec["resources"]["threads"])
            psi4.set_memory(int(spec["resources"]["memory_bytes"] * 0.6))
            log.body["options_applied"] = True
        effective = {key: psi4.core.get_option("SCF", key.upper()) for key in options}
        checks["effective_options"] = effective
        checks["native_controls"] = {
            "threads": psi4.core.get_num_threads(),
            "memory_bytes": psi4.core.get_memory(),
        }
        log.flush()
        if apply:
            for key, value in options.items():
                if not option_matches(effective[key], value):
                    raise ValueError("APPROVAL_STALE: native option not applied: " + key)
        _same(
            checks["native_controls"],
            {
                "threads": spec["resources"]["threads"],
                "memory_bytes": int(spec["resources"]["memory_bytes"] * 0.6),
            },
            "native resource controls",
        )
        definition = modules["psi4.driver.procrouting.dft.dft_builder"].functionals[
            spec["profile"]["method"]
        ]
        checks["functional_definition"] = copy.deepcopy(definition)
        log.flush()
        _same(
            content_hash(definition),
            spec["electronic_settings"]["functional_definition_hash"],
            "functional definition",
        )
        atoms = [
            {
                "atom_id": atom["id"],
                "element": atom["element"],
                "atomic_number": int(qcel.periodictable.to_Z(atom["element"])),
                "mass_number": int(qcel.periodictable.to_A(atom["element"])),
                "mass_dalton": canonical(
                    qcel.periodictable.to_mass(atom["element"], return_decimal=True)
                ),
            }
            for atom in spec["geometry"]["atoms"]
        ]
        checks["isotope_defaults"] = atoms
        log.flush()
        _same(atoms, spec["isotope_binding"]["atoms"], "actual isotope defaults")
        self._basis(spec, modules, context, before, manifest, checks, log)
        if apply:
            declared = spec["profile"]["dispersion"]
            functional, dispersion = modules[
                "psi4.driver.procrouting.proc"
            ].build_functional_and_disp(spec["profile"]["method"], True, engine=declared["engine"])
            observed = {
                "engine": dispersion.engine,
                "level": dispersion.dashlevel,
                "functional_name": functional.name(),
                "needs_vv10": functional.needs_vv10(),
                "parameters": {
                    key: canonical(value) for key, value in dispersion.dashparams.items()
                },
                "library_api_version": modules["dftd3.library"].get_api_version(),
                "program_available": qce.get_program(declared["engine"]).found(raise_error=True),
            }
            checks["dispersion"] = observed
            log.flush()
            if observed["program_available"] is not True or observed["needs_vv10"] is not False:
                raise ValueError("APPROVAL_STALE: required dispersion implementation unavailable")
            if (
                not isinstance(observed["library_api_version"], str)
                or not observed["library_api_version"]
            ):
                raise ValueError("APPROVAL_STALE: unavailable dispersion library API version")
            _same(
                observed["parameters"],
                {key: value for key, value in declared["parameters"].items() if key != "s9"},
                "dispersion parameters",
            )
            _same(
                [observed["engine"], observed["level"]],
                [declared["engine"], declared["type"]],
                "dispersion route",
            )
            strategy = modules["psi4.driver.driver_util"].negotiate_derivative_type(
                "gradient", spec["profile"]["method"], 1, verbose=0
            )
            checks["analytic_gradient_strategy"] = strategy
            log.flush()
            if (
                type(strategy) is not tuple
                or len(strategy) != 2
                or any(type(order) is not int or order != 1 for order in strategy)
            ):
                raise ValueError(
                    "UNSUPPORTED_PROFILE: analytic gradient unavailable; finite differences refused"
                )
        after = self._process()
        checks["process_after"] = after
        for key in ("python", "prefix", "executable", "cwd", "psipath"):
            _same(after[key], before[key], "process " + key)
        checks["loaded_module_origins"] = {
            name: self._origin(Path(path), prefix, manifest)
            for name, path in after["loaded_module_origins"].items()
        }
        log.flush()
        final_common: Record = {}
        checks["post_preflight_artifacts"] = final_common
        _same(
            self._common(spec, context, final_common), manifest, "post-preflight installed closure"
        )

    def _basis(
        self,
        spec: Record,
        modules: dict[str, Any],
        context: RuntimeContext,
        process: Record,
        manifest: Record,
        checks: Record,
        log: _Observation,
    ) -> None:
        psi4 = modules["psi4"]
        basis_name = spec["profile"]["basis"]
        horde = modules["psi4.driver.qcdb.libmintsbasisset"].basishorde
        if any(str(key).casefold() == basis_name.casefold() for key in horde):
            raise ValueError("APPROVAL_STALE: custom basis callable overrides the bound basis")
        library = Path(psi4.core.get_datadir()) / "basis" / (basis_name + ".gbs")
        expected = self._origin(library, context.runtime_root, manifest)
        bound_hashes = {ref["sha256"] for ref in spec["basis_binding"]["files"]}
        if expected["sha256"] not in bound_hashes:
            raise ValueError("APPROVAL_STALE: actual basis data differs from basis binding")
        search = [
            Path(process["cwd"]),
            *[
                Path(p) if Path(p).is_absolute() else Path(process["cwd"]) / p
                for p in process["psipath"].split(os.pathsep)
            ],
            library.parent,
        ]
        selected = next(
            (path / library.name for path in search if (path / library.name).is_file()), None
        )
        checks["basis_resolution"] = {
            "search_paths": [str(path) for path in search],
            "selected": None if selected is None else str(selected),
            "library": expected,
        }
        log.flush()
        if selected is None or selected.resolve() != library.resolve():
            raise ValueError("APPROVAL_STALE: search path shadows the bound basis file")
        molecule = _MoleculeProbe(spec, modules["qcelemental"]).molecule(spec["geometry"])
        raw_text = molecule.json()
        raw = json.loads(raw_text)
        checks["molecule_json"] = raw_text
        log.flush()
        _raw_geometry(_json_object(raw_text), spec["geometry"], spec["isotope_binding"])
        native = psi4.core.Molecule.from_schema(raw, nonphysical=True)
        basis = psi4.core.BasisSet.build(native, "BASIS", basis_name, puream=1)
        observed = {
            "name": basis.name(),
            "basis_functions": basis.nbf(),
            "shells": basis.nshell(),
            "puream": basis.has_puream(),
            "atoms": native.natom(),
            "integrals_evaluated": False,
        }
        checks["basis"] = observed
        log.flush()
        if not (
            isinstance(observed["name"], str)
            and observed["name"].casefold() == basis_name.casefold()
            and type(observed["basis_functions"]) is int
            and observed["basis_functions"] > 0
            and type(observed["shells"]) is int
            and observed["shells"] > 0
            and observed["puream"] is True
            and observed["atoms"] == len(spec["geometry"]["atoms"])
        ):
            raise ValueError("APPROVAL_STALE: actual spherical basis construction differs")


def make_runtime_verifier(
    *,
    import_module: Callable[[str], Any] = importlib.import_module,
    environment_identity: EnvironmentIdentity = refinement_environment_identity,
    observe_process: Callable[[], Record] = process_identity,
) -> RuntimePreflight:
    """Make a two-call verifier; native defaults are invoked only by the callback."""
    return RuntimePreflight(
        import_module=import_module,
        environment_identity=environment_identity,
        observe_process=observe_process,
    )
