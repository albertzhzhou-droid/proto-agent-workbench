"""Static product registration and lowering tests; no runtimes or workers execute."""

from __future__ import annotations

import copy
import hashlib
import shutil
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest

from chem_workbench.adapters import governed_compute as adapter
from chem_workbench.adapters import registry
from chem_workbench.adapters.validation import canonical_manifest_hash, validate_adapter_registry
from chem_workbench.chemir import canonical_bytes
from chem_workbench.method_profiles import D3BJ_PROFILE_ID


def put(root, relative, raw=b"explicitly synthetic source fixture\n"):
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    return path


@pytest.fixture
def implementation(tmp_path, monkeypatch):
    package = tmp_path / "source-package"
    resources = tmp_path / "source-resources"
    names = set(adapter.IMPLEMENTATION_FILES) | {
        "refinement_execution/worker_entry.py",
        "refinement_execution/runtime_preflight.py",
        "refinement_execution/worker_lifecycle.py",
        "refinement_execution/governed_plan.py",
        "refinement_execution/execution_contract.py",
        "refinement_execution/optimizer_loop.py",
        "refinement_execution/method-policy.json",
        "other-transitive-module.py",
        "adapters/builtin-registry.json",
    }
    for name in names:
        put(package, name)
    for name in (
        "worker_mock.py",
        "worker_ase_emt.py",
        "worker_water_psi4.py",
        "worker_molecular_psi4.py",
        "worker_refinement_psi4.py",
        "run_psi4_python.ps1",
        "build_registry.py",
    ):
        put(resources, "scripts/" + name)
    put(resources, "uv.lock")
    put(resources, "schemas/adapters/v1alpha1/example.schema.json")
    put(resources, "examples/input.json")
    put(resources, "evaluations/policy.json")
    put(resources, "third_party/notice.json")
    monkeypatch.setattr(adapter, "_package_root", lambda: package)
    monkeypatch.setattr(adapter, "resource_root", lambda: resources)
    return package, resources


def current_document():
    document = registry.load_descriptor_bytes(registry._bundled_registry_canonical_bytes())
    document["adapters"] = [
        item
        for item in document["adapters"]
        if item["manifest"]["adapter_id"]
        not in {"chem.compute.governed", "chem.compute.refinement"}
    ] + adapter.compute_registrations()
    return validate_adapter_registry(document)


@pytest.fixture
def isolated_registry(implementation, tmp_path, monkeypatch):
    path = tmp_path / "isolated-registry.json"
    path.write_bytes(canonical_bytes(current_document()))
    # The actual package-owned trust predicate consumes these exact, independently
    # generated test bytes. No require_registration/AdapterRegistry check is skipped.
    monkeypatch.setattr(registry, "_bundled_registry_canonical_bytes", path.read_bytes)
    return path


def test_separate_registration_preserves_exact_legacy_descriptor_caps(implementation):
    original = registry.load_bundled_registry().document
    old = next(
        item["manifest"]
        for item in original["adapters"]
        if item["manifest"]["adapter_id"] == "chem.compute.governed"
    )
    legacy, refinement = adapter.compute_registrations()
    generated = legacy["manifest"]
    assert {key: value for key, value in old.items() if key != "package_hash"} == {
        key: value for key, value in generated.items() if key != "package_hash"
    }
    assert generated["resource_ceilings"] == adapter.LEGACY_RESOURCE_CEILINGS
    assert D3BJ_PROFILE_ID not in generated["supported_profiles"]
    assert refinement["manifest"]["adapter_id"] == "chem.compute.refinement"
    assert refinement["manifest"]["supported_profiles"] == [D3BJ_PROFILE_ID]
    assert refinement["manifest"]["resource_ceilings"]["memory_bytes"] == 16 * 1024**3
    assert "artifact_bytes" not in refinement["manifest"]["resource_ceilings"]
    assert refinement["conformance_status"] == "experimental"
    assert refinement["manifest"]["permission_class"] == "compute_descriptor"


def test_legacy_implementation_hash_algorithm_remains_exact(implementation):
    package, resources = implementation
    digest = hashlib.sha256()
    for name in adapter.IMPLEMENTATION_FILES:
        digest.update(name.encode())
        digest.update((package / name).read_bytes())
    for name in (
        "worker_mock.py",
        "worker_ase_emt.py",
        "worker_water_psi4.py",
        "worker_molecular_psi4.py",
        "run_psi4_python.ps1",
    ):
        digest.update(name.encode())
        digest.update((resources / "scripts" / name).read_bytes())
    assert adapter.implementation_hash() == digest.hexdigest()
    for profile in adapter.LEGACY_PROFILES:
        assert adapter.implementation_hash(profile) == digest.hexdigest()


@pytest.mark.parametrize(
    "area,name",
    [
        ("package", "refinement_execution/worker_entry.py"),
        ("package", "refinement_execution/execution_contract.py"),
        ("package", "refinement_execution/optimizer_loop.py"),
        ("package", "refinement_execution/method-policy.json"),
        ("package", "other-transitive-module.py"),
        ("resources", "scripts/worker_refinement_psi4.py"),
        ("resources", "scripts/build_registry.py"),
        ("resources", "schemas/adapters/v1alpha1/example.schema.json"),
        ("resources", "uv.lock"),
    ],
)
def test_refinement_identity_changes_for_actual_code_policy_and_generator(
    implementation, area, name
):
    package, resources = implementation
    before = adapter.implementation_hash(D3BJ_PROFILE_ID)
    path = (package if area == "package" else resources) / name
    path.write_bytes(path.read_bytes() + b"changed\n")
    assert adapter.implementation_hash(D3BJ_PROFILE_ID) != before


def test_new_transitive_source_files_invalidate_identity(implementation):
    package, _ = implementation
    before = adapter.implementation_hash(D3BJ_PROFILE_ID)
    put(package, "refinement_execution/newly-added-validator.py")
    assert adapter.implementation_hash(D3BJ_PROFILE_ID) != before


def test_only_actual_registry_self_reference_is_excluded(implementation):
    package, _ = implementation
    before = adapter.implementation_hash(D3BJ_PROFILE_ID)
    put(package, "adapters/builtin-registry.json", b"different generated registry")
    put(package, "__pycache__/irrelevant.py", b"ignored cache")
    assert adapter.implementation_hash(D3BJ_PROFILE_ID) == before
    put(package, "refinement_execution/builtin-registry.json", b"an actual policy dependency")
    assert adapter.implementation_hash(D3BJ_PROFILE_ID) != before


def test_source_and_installed_resource_layouts_have_same_identity(
    implementation, tmp_path, monkeypatch
):
    package, resources = implementation
    original = adapter.refinement_implementation_files()
    installed = tmp_path / "installed-package"
    shutil.copytree(package, installed)
    shutil.copytree(resources, installed / "runtime")
    shutil.copytree(resources / "schemas", installed / "schemas")
    monkeypatch.setattr(adapter, "_package_root", lambda: installed)
    monkeypatch.setattr(adapter, "resource_root", lambda: installed / "runtime")
    assert adapter.refinement_implementation_files() == original


def test_missing_actual_worker_entry_fails_closed(implementation):
    package, _ = implementation
    (package / "refinement_execution/worker_entry.py").rename(package / "moved-worker.txt")
    with pytest.raises(ValueError, match="incomplete refinement implementation"):
        adapter.implementation_hash(D3BJ_PROFILE_ID)


def test_real_static_registry_accepts_each_explicit_profile(isolated_registry):
    assert registry.load_bundled_registry().active_adapter_count == 3
    for profile in (*adapter.LEGACY_PROFILES, D3BJ_PROFILE_ID):
        assert adapter.require_registration(profile) is None


def mutate_registry(path, change):
    document = registry.load_descriptor_bytes(path.read_bytes())
    entry = next(
        item
        for item in document["adapters"]
        if item["manifest"]["adapter_id"] == "chem.compute.refinement"
    )
    change(entry)
    entry["manifest_hash"] = canonical_manifest_hash(entry["manifest"])
    path.write_bytes(canonical_bytes(validate_adapter_registry(document)))


@pytest.mark.parametrize(
    "change",
    [
        lambda entry: entry.update(enabled=False),
        lambda entry: entry.update(implementation_status="not_installed"),
        lambda entry: entry.update(conformance_status="unqualified"),
    ],
)
def test_inactive_refinement_entry_cannot_borrow_legacy_registration(isolated_registry, change):
    mutate_registry(isolated_registry, change)
    with pytest.raises(ValueError, match="COMPUTE_NOT_REGISTERED"):
        adapter.require_registration(D3BJ_PROFILE_ID)
    adapter.require_registration(adapter.LEGACY_PROFILES[0])


def test_stale_refinement_source_rejects_actual_registration(implementation, isolated_registry):
    package, _ = implementation
    put(package, "refinement_execution/method-policy.json", b"changed policy")
    with pytest.raises(ValueError, match="COMPUTE_REGISTRATION_STALE"):
        adapter.require_registration(D3BJ_PROFILE_ID)
    adapter.require_registration(adapter.LEGACY_PROFILES[0])


@pytest.mark.parametrize("field", ["profile", "package_hash"])
def test_missing_profile_and_package_hash_rejected(isolated_registry, field):
    def change(entry):
        if field == "profile":
            entry["manifest"]["supported_profiles"] = []
        else:
            entry["manifest"]["package_hash"]["value"] = "0" * 64

    mutate_registry(isolated_registry, change)
    with pytest.raises(ValueError, match="COMPUTE_REGISTRATION_STALE"):
        adapter.require_registration(D3BJ_PROFILE_ID)


def test_absent_refinement_entry_is_not_authorized_by_legacy_entry(isolated_registry):
    document = registry.load_descriptor_bytes(isolated_registry.read_bytes())
    document["adapters"] = [
        item
        for item in document["adapters"]
        if item["manifest"]["adapter_id"] != "chem.compute.refinement"
    ]
    isolated_registry.write_bytes(canonical_bytes(validate_adapter_registry(document)))
    with pytest.raises(ValueError, match="COMPUTE_NOT_REGISTERED"):
        adapter.require_registration(D3BJ_PROFILE_ID)
    adapter.require_registration(adapter.LEGACY_PROFILES[0])


def test_new_lowering_requires_host_context_and_exact_refs(isolated_registry, monkeypatch):
    from chem_workbench.refinement_execution import governed_plan

    builder = Mock(return_value={"synthetic_plan": True})
    monkeypatch.setattr(governed_plan, "prepare", builder)
    proposal = {
        "spec_ref": {},
        "subject_ref": {},
        "execution_contract_ref": {},
        "mode": "gradient",
        "disk_budget": {},
    }
    with pytest.raises(ValueError, match="HOST_CONTEXT_REQUIRED"):
        adapter.resolve(D3BJ_PROFILE_ID, proposal)
    with pytest.raises(ValueError, match="exact refinement lowering"):
        adapter.resolve(
            D3BJ_PROFILE_ID,
            {**proposal, "worker_identity": {}},
            root=Path("/host"),
            observed_worker_identity={},
        )
    assert builder.call_count == 0
    supplied = copy.deepcopy(proposal)
    result = adapter.resolve(
        D3BJ_PROFILE_ID, proposal, root=Path("/host"), observed_worker_identity={"synthetic": True}
    )
    assert result == {"synthetic_plan": True} and proposal == supplied
    builder.assert_called_once_with(
        **proposal, root=Path("/host"), observed_worker_identity={"synthetic": True}
    )


def test_inactive_registration_stops_lowering_before_validation_or_files(
    isolated_registry, monkeypatch
):
    from chem_workbench.refinement_execution import governed_plan

    builder = Mock(side_effect=AssertionError("No lowering after registration rejection"))
    monkeypatch.setattr(governed_plan, "prepare", builder)
    mutate_registry(isolated_registry, lambda entry: entry.update(enabled=False))
    with pytest.raises(ValueError, match="COMPUTE_NOT_REGISTERED"):
        adapter.resolve(D3BJ_PROFILE_ID, {})
    assert builder.call_count == 0


@pytest.mark.parametrize(
    "profile,function",
    [
        ("ase.emt.cu.scan.v1", "build_cu_resolved_plan"),
        ("qcengine.psi4.hf_sto3g.smoke.v1", "build_water_resolved_plan"),
        ("qcengine.psi4.hf_sto3g.organic.v1", "build_molecular_resolved_plan"),
    ],
)
def test_legacy_lowering_still_calls_original_facade(monkeypatch, profile, function):
    from chem_workbench import execution

    builder = Mock(return_value={"legacy": profile})
    monkeypatch.setattr(execution, function, builder)
    proposal = {"synthetic": True}
    assert adapter.resolve(profile, proposal) == {"legacy": profile}
    builder.assert_called_once_with(proposal)


def test_no_implicit_registration_for_old_refinement_or_unknown_profile():
    for profile in ("psi4.wb97x_v.def2_tzvppd.optimize.v1", "unregistered.profile.v1"):
        with pytest.raises(ValueError, match="UNSUPPORTED_PROFILE"):
            adapter.require_registration(profile)
        with pytest.raises(ValueError, match="UNSUPPORTED_PROFILE"):
            adapter.resolve(profile, {})
    assert not {"psi4", "qcengine", "qcelemental", "optking", "dftd3"} & sys.modules.keys()
