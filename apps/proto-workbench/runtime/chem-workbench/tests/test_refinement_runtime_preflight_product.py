"""Actual preflight code with synthetic native objects; no native imports or jobs.

The retained 34-atom spec supplies geometry and option shape. Runtime files,
process identity, package versions and basis objects below are explicitly fake.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from refinement_evidence_fixtures import FIXTURES, read_bound_artifact
from test_refinement_execution_recorder import Molecule

from chem_workbench.molecular_refinement import seal_refinement_spec
from chem_workbench.refinement_execution import runtime_preflight as preflight
from chem_workbench.refinement_isotopes import seal_isotope_binding
from chem_workbench.visualization import content_hash


def write(root, relative, value):
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = value if isinstance(value, bytes) else json.dumps(value, sort_keys=True).encode()
    path.write_bytes(raw)
    return {"path": relative, "sha256": hashlib.sha256(raw).hexdigest()}


class Harness:
    def __init__(self, tmp_path):
        self.root = tmp_path / "artifacts"
        self.code = tmp_path / "code"
        self.prefix = tmp_path / "synthetic-runtime"
        self.cwd = tmp_path / "cwd"
        for path in (self.root, self.code, self.prefix, self.cwd):
            path.mkdir()
        self.run = self.root / "owned-run"
        self.run.mkdir()
        original = json.loads((FIXTURES / "input.json").read_bytes())["spec"]
        for reference in [
            original["electronic_settings"]["effective_options_artifact"],
            *original["basis_binding"]["files"],
        ]:
            write(self.root, reference["path"], read_bound_artifact(reference))
        options_artifact = json.loads(
            read_bound_artifact(original["electronic_settings"]["effective_options_artifact"])
        )
        self.effective = {}
        self.controls = {"threads": 1, "memory_bytes": 1000}
        self.imports = []
        self.entries = {}
        self.modules = {}
        names = (
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
        )
        for name in names:
            relative = "Lib/site-packages/" + name.replace(".", "/") + "/__init__.py"
            reference = write(self.prefix, relative, b"# Explicitly synthetic runtime fixture.\n")
            self.entries[relative] = reference["sha256"]
            self.modules[name] = SimpleNamespace(__file__=str(self.prefix / relative))
        for name in ("psi4", "qcelemental", "qcengine", "optking"):
            self.modules[name].__version__ = original["runtime_binding"]["versions"][name]
        for relative, raw in (
            ("python.exe", b"Synthetic file, not an executable"),
            (
                "conda-meta/libxc-synthetic.json",
                {
                    "name": "libxc",
                    "version": original["runtime_binding"]["versions"]["libxc"],
                    "build": "synthetic",
                },
            ),
            (
                "Library/share/psi4/basis/def2-tzvppd.gbs",
                read_bound_artifact(original["basis_binding"]["files"][0]),
            ),
        ):
            self.entries[relative] = write(self.prefix, relative, raw)["sha256"]
        self.manifest = {
            "version": "refinement-runtime-content/v1",
            "profile_id": original["profile"]["profile_id"],
            "prefix": str(self.prefix),
            "entries": self.entries,
            "files": len(self.entries),
            "manifest_hash": content_hash(self.entries),
            "synthetic_test_only": True,
        }
        body = {key: copy.deepcopy(value) for key, value in original.items() if key != "spec_hash"}
        runtime = {
            key: value for key, value in body["runtime_binding"].items() if key != "binding_hash"
        }
        runtime["files"] = [write(self.root, "inputs/runtime.json", self.manifest)]
        body["runtime_binding"] = {**runtime, "binding_hash": content_hash(runtime)}
        isotope_body = {
            "version": "refinement-isotope-observation/v1",
            "policy": original["isotope_binding"]["policy"],
            "geometry_hash": body["geometry"]["geometry_hash"],
            "runtime_binding_hash": body["runtime_binding"]["binding_hash"],
            "atoms": original["isotope_binding"]["atoms"],
        }
        ref = write(
            self.root,
            "inputs/isotopes.json",
            {**isotope_body, "observation_hash": content_hash(isotope_body)},
        )
        body["isotope_binding"] = seal_isotope_binding(
            {**isotope_body, "version": "refinement-isotope-binding/v1", "artifact": ref},
            body["geometry"],
            body["runtime_binding"],
        )
        self.spec = seal_refinement_spec(body)
        self.context = SimpleNamespace(
            root=self.root,
            code_root=self.code,
            runtime_root=self.prefix,
            run_directory="owned-run",
            run_id="synthetic-preflight",
            run_nonce="a" * 32,
            native_task_config={
                "ncores": body["resources"]["threads"],
                "memory": body["resources"]["memory_bytes"] / 1024**3 * 0.6,
                "retries": 0,
                "scratch_directory": str(self.run / "scratch"),
            },
        )
        self.process = {
            "python": body["runtime_binding"]["versions"]["python"],
            "prefix": str(self.prefix),
            "executable": str(self.prefix / "python.exe"),
            "cwd": str(self.cwd),
            "psipath": "",
            "loaded_module_origins": {},
        }
        self.environment = Mock(
            side_effect=lambda code_root, *, profile_id: copy.deepcopy(self.manifest)
        )
        self.observe_process = Mock(side_effect=lambda: copy.deepcopy(self.process))
        self.basis = SimpleNamespace(
            name=Mock(return_value="DEF2-TZVPPD"),
            nbf=Mock(return_value=1234),
            nshell=Mock(return_value=123),
            has_puream=Mock(return_value=True),
        )
        self.native_molecule = SimpleNamespace(natom=Mock(return_value=34))
        psi4 = self.modules["psi4"]
        psi4.set_options = Mock(side_effect=self.apply_options)
        psi4.set_num_threads = Mock(side_effect=lambda value: self.controls.update(threads=value))
        psi4.set_memory = Mock(side_effect=lambda value: self.controls.update(memory_bytes=value))
        psi4.core = SimpleNamespace(
            get_option=Mock(side_effect=lambda module, key: self.effective[key.lower()]),
            get_num_threads=lambda: self.controls["threads"],
            get_memory=lambda: self.controls["memory_bytes"],
            get_datadir=Mock(return_value=str(self.prefix / "Library/share/psi4")),
            Molecule=SimpleNamespace(from_schema=Mock(return_value=self.native_molecule)),
            BasisSet=SimpleNamespace(build=Mock(return_value=self.basis)),
        )
        self.forbidden = Mock(
            side_effect=AssertionError("No native evaluation may run in preflight")
        )
        psi4.energy = psi4.gradient = psi4.optimize = self.forbidden
        isotope_by_element = {
            atom["element"]: atom for atom in self.spec["isotope_binding"]["atoms"]
        }
        qcel = self.modules["qcelemental"]
        qcel.models = SimpleNamespace(Molecule=Molecule)
        qcel.periodictable = SimpleNamespace(
            to_Z=lambda element: isotope_by_element[element]["atomic_number"],
            to_A=lambda element: isotope_by_element[element]["mass_number"],
            to_mass=Mock(
                side_effect=lambda element, *, return_decimal: isotope_by_element[element][
                    "mass_dalton"
                ]
            ),
        )
        self.available = Mock(return_value=True)
        self.modules["qcengine"].get_program = Mock(
            return_value=SimpleNamespace(found=self.available)
        )
        self.modules["qcengine"].compute = self.forbidden
        self.modules["psi4.driver.procrouting.dft.dft_builder"].functionals = {
            body["profile"]["method"]: options_artifact["functional_definition"]
        }
        self.functional = SimpleNamespace(
            name=lambda: "synthetic WB97X-D3BJ", needs_vv10=Mock(return_value=False)
        )
        self.dispersion = SimpleNamespace(
            engine="s-dftd3",
            dashlevel="d3bj2b",
            dashparams={
                key: value
                for key, value in body["profile"]["dispersion"]["parameters"].items()
                if key != "s9"
            },
        )
        self.modules["psi4.driver.procrouting.proc"].build_functional_and_disp = Mock(
            return_value=(self.functional, self.dispersion)
        )
        self.negotiate = Mock(return_value=(1, 1))
        self.modules["psi4.driver.driver_util"].negotiate_derivative_type = self.negotiate
        self.modules["psi4.driver.qcdb.libmintsbasisset"].basishorde = {}
        self.modules["dftd3.library"].get_api_version = Mock(return_value="synthetic-1.4.0")
        self.verifier = preflight.make_runtime_verifier(
            import_module=self.loader,
            environment_identity=self.environment,
            observe_process=self.observe_process,
        )

    def apply_options(self, options):
        self.effective.update(
            {
                key: int(value)
                if type(value) is bool
                else value.upper()
                if isinstance(value, str)
                else value
                for key, value in options.items()
            }
        )

    def loader(self, name):
        self.imports.append(name)
        return self.modules[name]

    def execute(self):
        return self.verifier(self.spec, self.context)

    def observation(self, index=0):
        raw = (self.run / preflight.RUNTIME_PREFLIGHT_FILES[index]).read_bytes()
        if len(self.verifier.observations) > index:
            assert hashlib.sha256(raw).hexdigest() == self.verifier.observations[index]["sha256"]
        return json.loads(raw)


@pytest.fixture
def harness(tmp_path):
    return Harness(tmp_path)


def test_first_and_terminal_calls_observe_actual_objects_without_evaluations(harness):
    assert harness.execute() is None
    assert harness.execute() is None
    first, terminal = harness.observation(), harness.observation(1)
    assert first["complete"] is terminal["complete"] is True
    assert first["options_applied"] is True and terminal["options_applied"] is False
    assert first["checks"]["effective_options"]["df_scf_guess"] == 0
    assert first["checks"]["basis"]["basis_functions"] == 1234
    assert first["checks"]["analytic_gradient_strategy"] == [1, 1]
    assert first["backend_dispatches"] == terminal["backend_dispatches"] == 0
    assert harness.modules["psi4"].set_options.call_count == 1
    assert harness.environment.call_count == 4
    assert all(call.args == (harness.code,) for call in harness.environment.call_args_list)
    assert harness.forbidden.call_count == 0
    assert not {"psi4", "qcelemental", "qcengine", "optking", "dftd3"} & sys.modules.keys()


def test_source_binding_is_not_forced_to_legacy_cohort(harness):
    assert not (harness.root / harness.spec["source_binding"]["artifact"]["path"]).exists()
    body = {key: value for key, value in harness.spec.items() if key != "spec_hash"}
    body["source_binding"]["artifact"] = {
        "path": "independent-host-design-admission.json",
        "sha256": "f" * 64,
    }
    harness.spec = seal_refinement_spec(body)
    harness.execute()
    assert harness.observation()["complete"] is True


def test_terminal_session_options_are_observed_without_claiming_execution_proof(harness):
    harness.execute()
    harness.effective["maxiter"] = 201
    harness.execute()
    assert harness.observation(1)["checks"]["effective_options"]["maxiter"] == 201
    assert harness.modules["psi4"].set_options.call_count == 1
    assert harness.observation(1)["complete"] is True
    assert harness.observation(1)["native_execution_options_verified"] is False
    assert harness.observation(1)["options_meaning"] == "post_call_session"


def test_qcschema_cleanup_does_not_make_unchanged_terminal_runtime_stale(harness):
    harness.execute()
    harness.effective.update(
        d_convergence=1e-6,
        e_convergence=1e-6,
        reference="RHF",
        scf_type="PK",
        dft_radial_points=75,
        dft_spherical_points=302,
    )
    harness.execute()
    assert harness.observation(1)["checks"]["effective_options"]["d_convergence"] == 1e-6
    assert harness.observation(1)["complete"] is True
    assert harness.observation(1)["checks"]["basis"]["basis_functions"] == 1234
    assert harness.modules["psi4"].set_options.call_count == 1
    assert harness.negotiate.call_count == 1
    assert harness.forbidden.call_count == 0


def test_cleanup_does_not_hide_runtime_bytes_drift(harness):
    harness.execute()
    harness.effective.update(d_convergence=1e-6)
    Path(harness.modules["qcengine"].__file__).write_text("changed after electronic call")
    with pytest.raises(ValueError, match="artifact bytes"):
        harness.execute()
    assert harness.observation(1)["complete"] is False


@pytest.mark.parametrize("field", ["python", "prefix", "executable"])
def test_actual_interpreter_identity_is_bound(harness, field):
    harness.process[field] = "wrong" if field == "python" else str(harness.cwd / "wrong")
    with pytest.raises(ValueError, match="APPROVAL_STALE"):
        harness.execute()
    assert harness.observation()["complete"] is False
    assert harness.forbidden.call_count == 0


@pytest.mark.parametrize("package", ["psi4", "qcelemental", "qcengine", "optking"])
def test_loaded_versions_not_requested_versions(harness, package):
    harness.modules[package].__version__ = "synthetic-drift"
    with pytest.raises(ValueError, match="actual runtime versions"):
        harness.execute()
    assert harness.observation()["checks"]["versions"][package] == "synthetic-drift"


def test_runtime_manifest_mismatch_is_retained_before_import(harness):
    harness.manifest["manifest_hash"] = "sha256:" + "0" * 64
    with pytest.raises(ValueError, match="installed runtime closure"):
        harness.execute()
    assert harness.imports == []
    assert harness.observation()["checks"]["runtime_manifest"] == harness.manifest


def test_bound_artifact_tamper_is_rejected_before_import(harness):
    path = harness.root / harness.spec["electronic_settings"]["effective_options_artifact"]["path"]
    path.write_bytes(path.read_bytes() + b"\n")
    with pytest.raises(ValueError, match="artifact bytes"):
        harness.execute()
    assert harness.imports == []


def test_imported_file_origin_outside_runtime_rejected(harness):
    harness.modules["qcengine"].__file__ = str(harness.cwd / "qcengine.py")
    with pytest.raises(ValueError, match="outside admitted prefix"):
        harness.execute()
    assert harness.observation()["complete"] is False


def test_loaded_transitive_module_origin_outside_runtime_rejected(harness):
    harness.process["loaded_module_origins"] = {"psi4.core": str(harness.cwd / "wrong.pyd")}
    with pytest.raises(ValueError, match="outside admitted prefix"):
        harness.execute()
    assert harness.forbidden.call_count == 0


def test_imported_runtime_bytes_tamper_rejected(harness):
    Path(harness.modules["qcengine"].__file__).write_text("changed synthetic file")
    with pytest.raises(ValueError, match="artifact bytes"):
        harness.execute()


def test_different_imported_object_at_terminal_is_rejected(harness):
    harness.execute()
    harness.modules["qcengine"] = copy.copy(harness.modules["qcengine"])
    with pytest.raises(ValueError, match="different native object"):
        harness.execute()


@pytest.mark.parametrize("strategy", [(1, 0), (True, True), [1, 1], None])
def test_finite_difference_or_untyped_strategy_is_rejected(harness, strategy):
    harness.negotiate.return_value = strategy
    with pytest.raises(ValueError, match="finite differences refused"):
        harness.execute()
    assert harness.observation()["checks"]["analytic_gradient_strategy"] == (
        list(strategy) if isinstance(strategy, tuple) else strategy
    )
    assert harness.forbidden.call_count == 0


def test_analytic_availability_error_preserves_earlier_observations(harness):
    harness.negotiate.side_effect = RuntimeError("synthetic analytic unavailable")
    with pytest.raises(RuntimeError, match="analytic unavailable"):
        harness.execute()
    value = harness.observation()
    assert value["error"]["type"] == "RuntimeError" and "basis" in value["checks"]


@pytest.mark.parametrize(
    "change", ["parameter", "vv10", "availability", "engine", "isotope", "functional"]
)
def test_actual_scientific_configuration_drift_rejected_without_dispatch(harness, change):
    if change == "parameter":
        harness.dispersion.dashparams["s8"] = "2"
    elif change == "vv10":
        harness.functional.needs_vv10.return_value = True
    elif change == "availability":
        harness.available.return_value = False
    elif change == "engine":
        harness.dispersion.engine = "other"
    elif change == "isotope":
        harness.modules["qcelemental"].periodictable.to_mass.side_effect = lambda *args, **kwargs: (
            "999"
        )
    else:
        harness.modules["psi4.driver.procrouting.dft.dft_builder"].functionals[
            harness.spec["profile"]["method"]
        ] = {"changed": True}
    with pytest.raises(ValueError, match="APPROVAL_STALE"):
        harness.execute()
    assert harness.observation()["complete"] is False
    assert harness.forbidden.call_count == 0


@pytest.mark.parametrize("location", ["cwd", "psipath", "custom_callable"])
def test_basis_search_or_callable_override_is_rejected(harness, location):
    if location == "custom_callable":
        harness.modules["psi4.driver.qcdb.libmintsbasisset"].basishorde["DEF2-TZVPPD"] = lambda: (
            None
        )
    else:
        directory = harness.cwd if location == "cwd" else harness.code
        (directory / "def2-tzvppd.gbs").write_text("synthetic shadowed basis")
        if location == "psipath":
            harness.process["psipath"] = str(directory)
    with pytest.raises(ValueError, match=r"overrides|shadows"):
        harness.execute()
    assert harness.modules["psi4"].core.BasisSet.build.call_count == 0


@pytest.mark.parametrize(
    "method,value", [("nbf", 0), ("nshell", 0), ("has_puream", False), ("name", "other")]
)
def test_actual_basis_construction_is_observed_and_checked(harness, method, value):
    getattr(harness.basis, method).return_value = value
    with pytest.raises(ValueError, match="spherical basis"):
        harness.execute()
    assert "basis" in harness.observation()["checks"]


def test_bound_run_cannot_be_reused_or_retargeted(harness):
    harness.execute()
    harness.context.run_nonce = "b" * 32
    with pytest.raises(ValueError, match="cannot change"):
        harness.execute()
    harness.context.run_nonce = "a" * 32
    harness.execute()
    with pytest.raises(ValueError, match="used twice"):
        harness.execute()


def test_existing_preflight_evidence_not_overwritten(harness):
    path = harness.run / preflight.RUNTIME_PREFLIGHT_FILES[0]
    path.write_bytes(b"preserved")
    with pytest.raises(FileExistsError):
        harness.execute()
    assert path.read_bytes() == b"preserved" and harness.imports == []


def test_progress_is_durable_before_native_failure_and_terminal_is_separate(harness):
    def fail(*args, **kwargs):
        value = harness.observation()
        assert value["complete"] is False and value["checks"]["effective_options"]
        raise RuntimeError("synthetic preflight allocation failure")

    harness.modules["psi4"].core.BasisSet.build.side_effect = fail
    with pytest.raises(RuntimeError, match="allocation failure"):
        harness.execute()
    original = (harness.run / preflight.RUNTIME_PREFLIGHT_FILES[0]).read_bytes()
    harness.modules["psi4"].core.BasisSet.build.side_effect = None
    harness.execute()
    assert (harness.run / preflight.RUNTIME_PREFLIGHT_FILES[0]).read_bytes() == original
    assert harness.observation(1)["complete"] is True


def test_observation_replacement_during_check_refuses_unrelated_file_write(harness):
    original_environment = harness.environment.side_effect
    displaced = harness.run / "displaced-original.json"

    def replace(*args, **kwargs):
        target = harness.run / preflight.RUNTIME_PREFLIGHT_FILES[0]
        target.rename(displaced)
        target.write_bytes(b"replacement must remain unchanged")
        return original_environment(*args, **kwargs)

    harness.environment.side_effect = replace
    with pytest.raises((ValueError, PermissionError)) as captured:
        harness.execute()
    if displaced.exists():
        assert "preflight file identity" in str(captured.value)
        assert (
            harness.run / preflight.RUNTIME_PREFLIGHT_FILES[0]
        ).read_bytes() == b"replacement must remain unchanged"
        assert json.loads(displaced.read_bytes())["complete"] is False
    else:
        # Windows denies rename while the writer handle is open.
        assert isinstance(captured.value, PermissionError)
        assert harness.observation()["error"]["type"] == "PermissionError"


def test_observation_hardlink_is_rejected(harness):
    original_environment = harness.environment.side_effect
    alias = harness.run / "unexpected-alias.json"

    def link(*args, **kwargs):
        os.link(harness.run / preflight.RUNTIME_PREFLIGHT_FILES[0], alias)
        return original_environment(*args, **kwargs)

    harness.environment.side_effect = link
    with pytest.raises(ValueError, match="preflight file identity"):
        harness.execute()
    assert json.loads(alias.read_bytes())["complete"] is False


def test_external_observation_growth_is_rejected_without_overwrite(harness):
    original_environment = harness.environment.side_effect
    captured = []

    def grow(*args, **kwargs):
        target = harness.run / preflight.RUNTIME_PREFLIGHT_FILES[0]
        with target.open("ab") as stream:
            stream.write(b"external-growth" * 4096)
        captured.append(target.read_bytes())
        return original_environment(*args, **kwargs)

    harness.environment.side_effect = grow
    with pytest.raises(ValueError, match="observation bytes changed"):
        harness.execute()
    assert (harness.run / preflight.RUNTIME_PREFLIGHT_FILES[0]).read_bytes() == captured[0]
    assert harness.imports == []


def test_factory_defaults_do_not_import_native_modules():
    verifier = preflight.make_runtime_verifier()
    assert verifier.observations == []
    assert not {"psi4", "qcengine", "qcelemental", "optking", "dftd3"} & sys.modules.keys()


def test_lifecycle_invokes_real_verifier_before_import_initialization_and_at_terminal(harness):
    from chem_workbench.refinement_execution.execution_contract import (
        build_worker_request,
        seal_execution_contract,
    )
    from chem_workbench.refinement_execution.worker_lifecycle import (
        RESOURCE_FIELDS,
        run_worker_lifecycle,
    )

    request = build_worker_request(harness.spec, seal_execution_contract(harness.spec, "gradient"))
    context = harness.context
    context.plan_context = {"synthetic_test_only": True}
    context.worker_identity = {"kind": "psi4_refinement", "synthetic_test_only": True}
    context.source_identity = {"synthetic-worker.py": "a" * 64}
    context.resolved_plan_hash = "sha256:" + "b" * 64
    context.prepared_input_hash = content_hash(request)
    context.input_artifact = write(harness.root, "inputs/request.json", request)
    context.resource_policy = {key: harness.spec["resources"][key] for key in RESOURCE_FIELDS}
    events = []

    def admitted(value, actual_context):
        assert actual_context is context and value == request
        assert harness.imports == []
        events.append("host")

    def subject(value, actual_context):
        assert value == harness.spec and actual_context is context
        events.append("subject")

    report = run_worker_lifecycle(
        request,
        context=context,
        verify_host_admission=admitted,
        verify_subject=subject,
        verify_runtime=harness.verifier,
        import_module=harness.loader,
    )
    # Deliberately omit dftd3.qcschema so native initialization fails after the
    # preflight. The lifecycle must still invoke the actual terminal verifier.
    assert report["runner_outcome"] == "failed"
    assert report["scientific_result"] is None
    assert report["execution_evidence_state"] == "unassessed"
    assert report["errors"][0]["stage"] == "native_initialization"
    assert events == ["host", "subject", "subject"]
    assert len(harness.verifier.observations) == 2
    assert harness.observation()["complete"] is True
    assert harness.observation(1)["complete"] is True
    assert harness.forbidden.call_count == 0
