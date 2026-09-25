"""Real retained Design graph/byte preparation, with synthetic optimizer envelopes.

No native import, calculation, embedding, model, runtime discovery or authority
callback is used. Frozen observation bytes exercise inheritance, not acceptance.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import asdict, replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from refinement_evidence_fixtures import FIXTURES, materialize_bound_artifacts

from chem_workbench.refinement_execution import optimizer_loop, optimizer_policy
from chem_workbench.refinement_execution import preparation as prep
from chem_workbench.refinement_execution.disk_budget import DiskBudget
from chem_workbench.refinement_execution.execution_contract import validate_worker_request
from chem_workbench.refinement_execution.refinement_subject import verify_design_subject_for_spec

HERE = Path(__file__).resolve().parent
OBSERVATIONS = HERE / "fixtures/refinement_preparation_observations"
SUBJECT = HERE / "fixtures/refinement_execution_subject"
DIRECTORY = "build/refinement-d3bj-complex-gradient-20260913"
RESOURCES = prep.RefinementResources(
    wall_seconds=21600,
    cpu_seconds=86400,
    memory_bytes=16 * 1024**3,
    threads=8,
    max_output_bytes=20 * 1024**2,
)
DISK = DiskBudget(
    max_run_bytes=32 * 1024**3,
    max_entries=20000,
    minimum_free_bytes=8 * 1024**3,
    scan_timeout_seconds=5,
    interval_seconds=2,
)


def ref(root, path):
    return {"path": path, "sha256": hashlib.sha256((root / path).read_bytes()).hexdigest()}


def read(root, reference):
    return json.loads(prep._read(root, reference))


def materialize_observations(root):
    """Copy only pinned portable fixture bytes, without reading live build/runtime."""
    materialize_bound_artifacts(root)
    directory = root / DIRECTORY
    (directory / "input.json").write_bytes((FIXTURES / "input.json").read_bytes())
    manifest = json.loads((OBSERVATIONS / "manifest.json").read_bytes())
    for entry in manifest["files"]:
        raw = (OBSERVATIONS / entry["path"]).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == entry["sha256"]
        assert len(raw) == entry["bytes"]
        (directory / entry["path"]).write_bytes(raw)


@pytest.fixture
def arguments(tmp_path):
    materialize_observations(tmp_path)
    original = (SUBJECT / "design-record.original.json").read_bytes()
    record = json.loads(original)
    path = "store/designs/" + record["record_hash"].removeprefix("sha256:") + ".json"
    (tmp_path / path).parent.mkdir(parents=True)
    (tmp_path / path).write_bytes(original)
    observations = prep.load_trusted_preparation_observations(
        root=tmp_path,
        observation_directory=DIRECTORY,
    )
    return {
        "root": tmp_path,
        "preparation_directory": "new-preparation",
        "record_ref": ref(tmp_path, path),
        "selection": {
            "run_ref": record["record_hash"],
            "candidate_hash": record["organic"]["candidates"][2]["candidate_hash"],
        },
        "electronic_state": {"charge": 0, "multiplicity": 1},
        "observations": observations,
        "optimizer_settings": observations.source_optimizer_settings,
        "resources": RESOURCES,
        "disk_budget": DISK,
        "mode": "gradient",
    }


@pytest.mark.parametrize("candidate_index,atom_count", [(0, 31), (1, 30), (2, 34)])
def test_real_candidates_build_fresh_specs_with_exact_store_source_and_derived_masses(
    arguments, candidate_index, atom_count
):
    root = arguments["root"]
    record = read(root, arguments["record_ref"])
    candidate = record["organic"]["candidates"][candidate_index]
    arguments["selection"]["candidate_hash"] = candidate["candidate_hash"]
    result = prep.prepare_design_refinement(**arguments)
    request = read(root, result["request_ref"])
    assert validate_worker_request(request) == request
    spec = request["spec"]
    subject = verify_design_subject_for_spec(spec, root)
    receipt = read(root, result["preparation_ref"])
    assert len(spec["geometry"]["atoms"]) == atom_count
    assert subject["design_record"]["artifact"] == arguments["record_ref"]
    assert (
        prep._read(root, receipt["outputs"]["design_record_backup"])
        == (SUBJECT / "design-record.original.json").read_bytes()
    )
    assert prep._read(root, subject["source_snapshot"]["artifact"]) == candidate["source"].encode()
    assert spec["source_binding"]["artifact"] == result["subject_ref"]
    assert spec["source_binding"]["candidate_hash"] == candidate["candidate_hash"]
    assert spec["resources"] == {
        **asdict(RESOURCES),
        "backend_retry_policy": {
            "requested_retries": 0,
            "effective_retries": 0,
            "accounting": "observe_every_backend_attempt",
        },
    }
    assert result["disk_budget"] == asdict(DISK)
    assert "disk_budget" not in request and "disk_budget" not in spec["resources"]
    assert receipt["candidate_basis_functions"] is None
    assert receipt["candidate_runtime_preflight_required"] is True
    assert receipt["isotope_derivation"]["new_candidate_native_observation"] is False
    assert receipt["isotope_derivation"]["kind"] == "derived_from_observed_element_defaults"
    assert receipt["computation_authorized"] is receipt["execution_authorized"] is False
    assert receipt["electronic_evaluations"] == receipt["dispersion_evaluations"] == 0
    assert receipt["preparation_complete"] is True
    old = json.loads((FIXTURES / "input.json").read_bytes())["spec"]
    assert spec["spec_hash"] != old["spec_hash"]
    assert spec["runtime_binding"] == old["runtime_binding"]
    assert spec["basis_binding"] == old["basis_binding"]
    assert spec["electronic_settings"] == old["electronic_settings"]
    assert request["execution_contract"]["optimizer_binding"] is None
    result["selection"]["candidate_hash"] = "mutated"
    assert arguments["selection"]["candidate_hash"] == candidate["candidate_hash"]


def test_missing_optimizer_is_not_invented_from_historical_settings(arguments):
    arguments["mode"] = "optimization"
    with pytest.raises(ValueError, match="OPTIMIZER_NOT_PREPARED"):
        prep.prepare_design_refinement(**arguments)
    assert not (arguments["root"] / "new-preparation").exists()


def synthetic_optimizer(arguments):
    """Explicit mock effective state; never native acceptance or production fallback."""
    spec = json.loads((FIXTURES / "input.json").read_bytes())["spec"]
    receipt = json.loads(
        (HERE / "fixtures/refinement_execution/synthetic_optimizer_receipt.json").read_bytes()
    )["native_parameters"][0]
    actual = {**receipt["effective"], **receipt["active_criteria"]}
    for key, value in optimizer_policy.requested_options(arguments["optimizer_settings"]).items():
        native = next(
            (target for source, target in optimizer_policy._CRITERIA.values() if source == key), key
        )
        actual[native] = value.upper() if isinstance(value, str) and key != "program" else value
    binding = optimizer_policy.seal_binding(
        arguments["optimizer_settings"],
        actual,
        runtime_binding_hash=spec["runtime_binding"]["binding_hash"],
        observation_artifact={"path": "synthetic-optimizer.json", "sha256": "0" * 64},
    )
    body = optimizer_loop.observation_body(spec, binding)
    raw = json.dumps(body, allow_nan=False).encode()
    (arguments["root"] / "synthetic-optimizer.json").write_bytes(raw)
    return optimizer_policy.seal_binding(
        arguments["optimizer_settings"],
        actual,
        runtime_binding_hash=spec["runtime_binding"]["binding_hash"],
        observation_artifact=ref(arguments["root"], "synthetic-optimizer.json"),
    )


def test_optimization_verifies_original_observation_bytes_and_new_runtime_settings(arguments):
    arguments.update(mode="optimization", optimizer_binding=synthetic_optimizer(arguments))
    result = prep.prepare_design_refinement(**arguments)
    request = read(arguments["root"], result["request_ref"])
    assert validate_worker_request(request) == request
    assert request["execution_contract"]["optimizer_binding"] == arguments["optimizer_binding"]
    assert (
        request["execution_contract"]["optimizer_binding"][
            "final_accepted_geometry_reevaluation_required"
        ]
        is True
    )
    assert (
        read(arguments["root"], result["preparation_ref"])["optimizer_observation"]
        == arguments["optimizer_binding"]["observation_artifact"]
    )


@pytest.mark.parametrize("change", ["bytes", "settings", "runtime", "gradient-capacity"])
def test_optimization_binding_drift_fails_with_partial_original_evidence(arguments, change):
    binding = synthetic_optimizer(arguments)
    arguments.update(mode="optimization", optimizer_binding=binding)
    if change == "bytes":
        (arguments["root"] / "synthetic-optimizer.json").write_bytes(b"{}")
    elif change == "settings":
        arguments["optimizer_settings"]["maximum_iterations"] += 1
    elif change == "runtime":
        binding["runtime_binding_hash"] = "sha256:" + "0" * 64
    else:
        arguments["optimizer_settings"]["max_gradient_evaluations"] = 1
    with pytest.raises(ValueError):
        prep.prepare_design_refinement(**arguments)
    partial = json.loads(
        (arguments["root"] / "new-preparation/preparation-failure.json").read_bytes()
    )
    assert partial["preparation_complete"] is False
    assert "source" in partial["outputs"] and "subject" in partial["outputs"]
    assert not (arguments["root"] / "new-preparation/worker-request.json").exists()


@pytest.mark.parametrize("field", list(prep.LIMITS))
@pytest.mark.parametrize("value", [True, 0, -1, 1.5])
def test_resource_types_and_limits_are_not_coerced(arguments, field, value):
    arguments["resources"] = replace(RESOURCES, **{field: value})
    with pytest.raises(ValueError, match="resource bound"):
        prep.prepare_design_refinement(**arguments)
    assert not (arguments["root"] / "new-preparation").exists()


@pytest.mark.parametrize("field", list(prep.LIMITS))
def test_governed_resource_ceilings_are_preserved(arguments, field):
    arguments["resources"] = replace(RESOURCES, **{field: prep.LIMITS[field] + 1})
    with pytest.raises(ValueError, match="resource bound"):
        prep.prepare_design_refinement(**arguments)


@pytest.mark.parametrize("name", ["resources", "disk_budget"])
def test_typed_policy_objects_required(arguments, name):
    arguments[name] = asdict(arguments[name])
    with pytest.raises(ValueError, match="typed explicit"):
        prep.prepare_design_refinement(**arguments)


def test_independent_disk_budget_is_validated(arguments):
    arguments["disk_budget"] = replace(DISK, max_run_bytes=True)
    with pytest.raises(ValueError, match="disk budget integer"):
        prep.prepare_design_refinement(**arguments)


@pytest.mark.parametrize("name", [*sorted(prep._OBSERVATION_FILES), "preparation.json"])
def test_every_pinned_original_observation_is_rechecked(arguments, name):
    path = arguments["root"] / DIRECTORY / name
    path.write_bytes(path.read_bytes() + b" ")
    with pytest.raises(ValueError, match="artifact bytes changed"):
        prep.prepare_design_refinement(**arguments)
    assert not (arguments["root"] / "new-preparation").exists()


def alter_observation(root, name, mutate):
    directory = root / DIRECTORY
    value = json.loads((directory / name).read_bytes())
    mutate(value)
    raw = json.dumps(value, allow_nan=False).encode()
    (directory / name).write_bytes(raw)
    receipt = json.loads((directory / "preparation.json").read_bytes())
    receipt["files"][name] = hashlib.sha256(raw).hexdigest()
    (directory / "preparation.json").write_bytes(json.dumps(receipt).encode())


@pytest.mark.parametrize(
    "name,mutate",
    [
        ("effective-native-options.json", lambda d: d.__setitem__("maxiter", True)),
        ("effective-native-options.json", lambda d: d.__setitem__("puream", True)),
        ("effective-native-options.json", lambda d: d.pop("e_convergence")),
        ("derivative-preflight.json", lambda d: d.__setitem__("observed_strategy", [1, 0])),
        ("dispersion-preflight.json", lambda d: d.__setitem__("engine", "dftd3")),
        (
            "isotope-defaults-observed.json",
            lambda d: d["atoms"][0].__setitem__("mass_dalton", "16"),
        ),
        ("basis-observation.json", lambda d: d.__setitem__("atoms", 12)),
        ("preflight-atomic-input.json", lambda d: d.__setitem__("driver", "energy")),
    ],
)
def test_rehashed_observation_still_requires_cross_record_agreement(arguments, name, mutate):
    alter_observation(arguments["root"], name, mutate)
    with pytest.raises(ValueError):
        prep.load_trusted_preparation_observations(
            root=arguments["root"], observation_directory=DIRECTORY
        )


def test_original_design_store_drift_cannot_be_hidden_by_snapshot(arguments):
    path = arguments["root"] / arguments["record_ref"]["path"]
    path.write_bytes(path.read_bytes() + b" ")
    with pytest.raises(ValueError, match="artifact bytes changed"):
        prep.prepare_design_refinement(**arguments)


def test_loader_prior_receipt_pin_and_detached_settings(arguments):
    observations = arguments["observations"]
    supplied = observations.receipt_ref
    supplied["sha256"] = "0" * 64
    with pytest.raises(ValueError, match="artifact bytes changed"):
        prep.load_trusted_preparation_observations(
            root=arguments["root"], observation_directory=DIRECTORY, expected_receipt_ref=supplied
        )
    changed = observations.source_optimizer_settings
    changed["maximum_iterations"] = 1
    assert observations.source_optimizer_settings == arguments["optimizer_settings"]


def test_output_directory_never_overwritten(arguments):
    target = arguments["root"] / "new-preparation"
    target.mkdir()
    (target / "existing.txt").write_bytes(b"retained")
    with pytest.raises(FileExistsError):
        prep.prepare_design_refinement(**arguments)
    assert (target / "existing.txt").read_bytes() == b"retained"


@pytest.mark.parametrize("path", ["../escape", "wrong\\path", "C:/escape", "CON", "trailing."])
def test_output_path_must_be_safe_and_contained(arguments, path):
    arguments["preparation_directory"] = path
    with pytest.raises(ValueError):
        prep.prepare_design_refinement(**arguments)


def test_hardlinked_design_file_is_rejected(arguments):
    original = arguments["root"] / arguments["record_ref"]["path"]
    os.link(original, arguments["root"] / "extra-design-link.json")
    with pytest.raises(ValueError, match="single-link"):
        prep.prepare_design_refinement(**arguments)


def test_conda_hardlinked_basis_bytes_are_allowed_only_with_stable_manifest_pins(arguments):
    root = arguments["root"]
    spec = json.loads((FIXTURES / "input.json").read_bytes())["spec"]
    reference = spec["basis_binding"]["files"][0]
    path = root / reference["path"]
    os.link(path, root / "synthetic-conda-cache-link.gbs")
    loaded = prep.load_trusted_preparation_observations(root=root, observation_directory=DIRECTORY)
    assert loaded.receipt_ref == arguments["observations"].receipt_ref
    (root / "synthetic-conda-cache-link.gbs").write_bytes(b"changed cache bytes")
    with pytest.raises(ValueError, match="artifact bytes changed"):
        prep.load_trusted_preparation_observations(root=root, observation_directory=DIRECTORY)


def test_stale_design_edit_during_real_subject_verification_retains_failure(arguments, monkeypatch):
    original = prep.prepare_design_candidate_subject

    def changed(*args, **kwargs):
        value = original(*args, **kwargs)
        path = arguments["root"] / arguments["record_ref"]["path"]
        path.write_bytes(path.read_bytes() + b" ")
        return value

    monkeypatch.setattr(prep, "prepare_design_candidate_subject", changed)
    with pytest.raises(ValueError):
        prep.prepare_design_refinement(**arguments)
    partial = json.loads(
        (arguments["root"] / "new-preparation/preparation-failure.json").read_bytes()
    )
    assert partial["preparation_complete"] is False
    assert (
        prep._read(arguments["root"], partial["outputs"]["design_record_backup"])
        == (SUBJECT / "design-record.original.json").read_bytes()
    )


def test_missing_element_observation_cannot_be_filled_from_default_constants(
    arguments, monkeypatch
):
    original = prep._read_observations

    def missing(*args, **kwargs):
        data = original(*args, **kwargs)
        data["defaults"].pop("O")
        return data

    monkeypatch.setattr(prep, "_read_observations", missing)
    with pytest.raises(ValueError, match="no observed isotope default for element O"):
        prep.prepare_design_refinement(**arguments)
    assert not (arguments["root"] / "new-preparation/worker-request.json").exists()


def test_preparation_does_not_import_native_or_call_calculators(arguments, monkeypatch):
    import builtins

    original = builtins.__import__

    def guarded(name, *args, **kwargs):
        assert name.split(".")[0] not in {"psi4", "qcengine", "qcelemental", "optking", "dftd3"}
        return original(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded)
    result = prep.prepare_design_refinement(**arguments)
    assert read(arguments["root"], result["preparation_ref"])["preparation_complete"] is True


def test_stability_state_ignores_read_atime_but_retains_write_metadata(tmp_path):
    path = tmp_path / "read.bin"
    path.write_bytes(b"retained")
    info = path.lstat()
    fields = {name: getattr(info, name) for name in dir(info) if name.startswith("st_")}
    baseline = prep._state(info)
    assert prep._state(SimpleNamespace(**{**fields, "st_atime_ns": 123})) == baseline
    for field in ("st_mtime_ns", "st_ctime_ns", "st_size", "st_ino"):
        assert prep._state(SimpleNamespace(**{**fields, field: fields[field] + 1})) != baseline


def test_changed_output_bytes_are_refused_and_partial_failure_is_retained(arguments, monkeypatch):
    original = prep._write
    changed = False

    def mutate(owned, name, raw):
        nonlocal changed
        reference = original(owned, name, raw)
        if name == "spec.json" and not changed:
            changed = True
            (owned.repository_root / reference["path"]).write_bytes(raw + b" ")
        return reference

    monkeypatch.setattr(prep, "_write", mutate)
    with pytest.raises(ValueError, match="artifact bytes changed"):
        prep.prepare_design_refinement(**arguments)
    receipt = json.loads(
        (arguments["root"] / "new-preparation/preparation-failure.json").read_bytes()
    )
    assert receipt["preparation_complete"] is False
    assert not (arguments["root"] / "new-preparation/preparation.json").exists()


@pytest.mark.parametrize(
    "mutate",
    [
        lambda d: d.__setitem__("preparation_complete", False),
        lambda d: d.__setitem__("spec_hash", "sha256:" + "0" * 64),
        lambda d: d.__setitem__("runtime_files", 0),
        lambda d: d["files"].pop("basis-observation.json"),
    ],
)
def test_receipt_claims_do_not_replace_complete_cross_checked_observations(arguments, mutate):
    path = arguments["root"] / DIRECTORY / "preparation.json"
    body = json.loads(path.read_bytes())
    mutate(body)
    path.write_bytes(json.dumps(body).encode())
    with pytest.raises(ValueError):
        prep.load_trusted_preparation_observations(
            root=arguments["root"], observation_directory=DIRECTORY
        )
