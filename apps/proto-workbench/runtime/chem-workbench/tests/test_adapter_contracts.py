"""Focused unit contracts for static, descriptor-only adapter governance."""

from __future__ import annotations

import copy
import hashlib
import importlib.metadata
import json
import pkgutil
import shutil
import socket
from collections.abc import Callable
from typing import Any

import pytest

from chem_workbench.adapters import (
    AdapterBindingError,
    AdapterContractError,
    AdapterRegistry,
    ComputeAdapter,
    assess_loss_report,
    bundled_registry_document,
    canonical_format_capability_hash,
    canonical_manifest_hash,
    canonical_registry_hash,
    load_bundled_registry,
    load_descriptor_bytes,
    validate_adapter_manifest,
    validate_adapter_registry,
    validate_format_capability,
    validate_loss_report,
)
from chem_workbench.chemir import canonical_bytes
from chem_workbench.version import __version__

Artifact = dict[str, Any]
ArtifactFactory = Callable[[], Artifact]
ArtifactValidator = Callable[[object], Artifact]


def _digest(digest_type: str, digit: str) -> dict[str, str]:
    return {"type": digest_type, "algorithm": "sha256", "value": digit * 64}


def _other_hash(value: str) -> str:
    replacement = "0" if value[0] != "0" else "1"
    return replacement + value[1:]


def _format_manifest() -> Artifact:
    return {
        "manifest_version": "adapter-capability/v1alpha1",
        "adapter_id": "org.example.sdf",
        "adapter_version": "1.0.0",
        "adapter_type": "FormatAdapter",
        "permission_class": "local_pure",
        "package_hash": _digest("adapter_package_hash", "a"),
        "schema_versions": ["chemir/v1alpha1", "loss/v1alpha1"],
        "operations": ["compare", "export_bytes", "import_bytes"],
        "supported_profiles": ["v1-core-structure-compute"],
        "required_backends": [],
        "network_policy": "deny",
        "environment_allowlist": [],
        "resource_ceilings": {},
        "licenses": ["BSD-3-Clause"],
        "expected_loss_codes": ["STEREOCHEMISTRY_DROPPED"],
    }


def _data_service_manifest() -> Artifact:
    return {
        "manifest_version": "adapter-capability/v1alpha1",
        "adapter_id": "org.example.pubchem",
        "adapter_version": "1.0.0",
        "adapter_type": "DataServiceConnector",
        "permission_class": "network_fetch",
        "package_hash": _digest("adapter_package_hash", "b"),
        "schema_versions": ["chemir/v1alpha1"],
        "operations": ["fetch"],
        "supported_profiles": ["v1-core-structure-compute"],
        "required_backends": [],
        "network_policy": "explicit_allowlist",
        "environment_allowlist": ["HTTPS_PROXY"],
        "resource_ceilings": {"wall_time_seconds": 30},
        "licenses": ["BSD-3-Clause"],
        "expected_loss_codes": [],
    }


def _compute_manifest() -> Artifact:
    return {
        "manifest_version": "adapter-capability/v1alpha1",
        "adapter_id": "org.example.compute",
        "adapter_version": "1.0.0",
        "adapter_type": "ComputeAdapter",
        "permission_class": "compute_descriptor",
        "package_hash": _digest("adapter_package_hash", "c"),
        "schema_versions": ["chemir/v1alpha1"],
        "operations": ["lower", "normalize", "resolve", "validate"],
        "supported_profiles": ["v1-core-structure-compute"],
        "required_backends": ["org.example.backend"],
        "network_policy": "deny",
        "environment_allowlist": ["OMP_NUM_THREADS"],
        "resource_ceilings": {
            "cpu_threads": 2,
            "memory_bytes": 536870912,
            "wall_time_seconds": 30,
        },
        "licenses": ["BSD-3-Clause"],
        "expected_loss_codes": [],
    }


def _format_capability() -> Artifact:
    manifest = _format_manifest()
    return {
        "capability_version": "format-capability/v1alpha1",
        "capability_id": "org.example.sdf:export:v1-core-structure-compute",
        "adapter": {
            "id": manifest["adapter_id"],
            "version": manifest["adapter_version"],
            "manifest_hash": canonical_manifest_hash(manifest),
        },
        "format": {
            "name": "sdf",
            "dialect": "V2000",
            "media_type": "chemical/x-mdl-sdfile",
        },
        "direction": "export",
        "chemir_schema_version": "chemir/v1alpha1",
        "profile": "v1-core-structure-compute",
        "operations": ["compare", "export_bytes"],
        "classification": "LOSSY_WITH_REPORT",
        "normalization_profile": "source-preserving/v1alpha1",
        "aromaticity_policy": "source_preserving",
        "stereochemistry_policy": "source_preserving",
        "numeric_tolerance_policy": "exact_only",
        "supported_fields": ["/objects/0/payload/representations"],
        "allowed_loss_codes": ["STEREOCHEMISTRY_DROPPED"],
        "loss_report_version": "loss/v1alpha1",
    }


def _registry_document() -> Artifact:
    manifest = _format_manifest()
    capability = _format_capability()
    return {
        "registry_version": "adapter-registry/v1alpha1",
        "product": {"name": "chem-workbench", "version": __version__},
        "discovery": {
            "mode": "static_only",
            "python_entry_points": False,
            "module_scan": False,
            "path_scan": False,
            "executable_path_probe": False,
            "network_probe": False,
        },
        "adapters": [
            {
                "manifest": manifest,
                "manifest_hash": canonical_manifest_hash(manifest),
                "format_capabilities": [
                    {
                        "capability": capability,
                        "capability_hash": canonical_format_capability_hash(capability),
                    }
                ],
                "implementation_status": "installed_verified",
                "conformance_status": "normative",
                "enabled": True,
            }
        ],
    }


def _rebind_registry_hashes(document: Artifact) -> None:
    registration = document["adapters"][0]
    manifest_hash = canonical_manifest_hash(registration["manifest"])
    registration["manifest_hash"] = manifest_hash
    for record in registration["format_capabilities"]:
        record["capability"]["adapter"]["manifest_hash"] = copy.deepcopy(manifest_hash)
        record["capability_hash"] = canonical_format_capability_hash(record["capability"])


def _loss_report() -> Artifact:
    capability = _format_capability()
    return {
        "loss_report_version": "loss/v1alpha1",
        "adapter": copy.deepcopy(capability["adapter"]),
        "capability_hash": canonical_format_capability_hash(capability),
        "direction": "export",
        "format": copy.deepcopy(capability["format"]),
        "profile": capability["profile"],
        "input_hash": _digest("semantic_hash", "d"),
        "output_hash": _digest("artifact_sha256", "e"),
        "classification": "LOSSY_WITH_REPORT",
        "issues": [
            {
                "code": "STEREOCHEMISTRY_DROPPED",
                "severity": "warning",
                "location": {
                    "kind": "chemir_path",
                    "path": "/objects/0/payload/representations/0",
                },
                "feature": "tetrahedral stereochemistry",
                "disposition": "dropped",
                "message": "The V2000 target cannot preserve this stereochemical feature.",
                "suggestion": "Approve this exact loss or select a lossless target format.",
                "evidence_hashes": [],
            }
        ],
    }


def _semantic_equivalent_pair() -> tuple[Artifact, Artifact]:
    capability = _format_capability()
    capability["classification"] = "SEMANTIC_EQUIVALENT_UNDER_PROFILE"
    capability["allowed_loss_codes"] = []
    report = _loss_report()
    report["capability_hash"] = canonical_format_capability_hash(capability)
    report["classification"] = "SEMANTIC_EQUIVALENT_UNDER_PROFILE"
    report["issues"] = []
    return capability, report


ARTIFACT_CASES: tuple[
    tuple[str, ArtifactFactory, ArtifactValidator, str],
    ...,
] = (
    ("manifest", _format_manifest, validate_adapter_manifest, "manifest_version"),
    ("capability", _format_capability, validate_format_capability, "capability_version"),
    ("registry", _registry_document, validate_adapter_registry, "registry_version"),
    ("loss-report", _loss_report, validate_loss_report, "loss_report_version"),
)


def test_bundled_registry_is_deterministic_static_and_performs_no_discovery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def forbidden_discovery(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("dynamic adapter discovery was attempted")

    monkeypatch.setattr(importlib.metadata, "entry_points", forbidden_discovery)
    monkeypatch.setattr(pkgutil, "iter_modules", forbidden_discovery)
    monkeypatch.setattr(pkgutil, "walk_packages", forbidden_discovery)
    monkeypatch.setattr(shutil, "which", forbidden_discovery)
    monkeypatch.setattr(socket, "create_connection", forbidden_discovery)

    first = load_bundled_registry()
    second = load_bundled_registry()
    first_document = first.document

    assert first.adapter_count == second.adapter_count == 3
    assert first.active_adapter_count == second.active_adapter_count == 3
    assert first.digest == second.digest
    assert first_document == second.document == bundled_registry_document()
    assert [item["manifest"]["adapter_id"] for item in first_document["adapters"]] == [
        "chem.cif.probe",
        "chem.compute.governed",
        "chem.compute.refinement",
    ]
    assert first_document["discovery"] == {
        "executable_path_probe": False,
        "mode": "static_only",
        "module_scan": False,
        "network_probe": False,
        "path_scan": False,
        "python_entry_points": False,
    }

    bundled_ids = [item["manifest"]["adapter_id"] for item in first.document["adapters"]]
    first_document["adapters"].append({"caller_mutation": True})
    assert [item["manifest"]["adapter_id"] for item in first.document["adapters"]] == bundled_ids
    assert [
        item["manifest"]["adapter_id"] for item in load_bundled_registry().document["adapters"]
    ] == bundled_ids


@pytest.mark.parametrize(
    ("_name", "factory", "validator", "version_field"),
    ARTIFACT_CASES,
    ids=[case[0] for case in ARTIFACT_CASES],
)
def test_all_artifacts_reject_unknown_fields_and_versions(
    _name: str,
    factory: ArtifactFactory,
    validator: ArtifactValidator,
    version_field: str,
) -> None:
    unknown = factory()
    unknown["unknown_authority"] = True
    with pytest.raises(AdapterContractError):
        validator(unknown)

    unsupported_version = factory()
    unsupported_version[version_field] = "unsupported/v9"
    with pytest.raises(AdapterContractError):
        validator(unsupported_version)


@pytest.mark.parametrize(
    ("_name", "factory", "validator", "version_field"),
    ARTIFACT_CASES,
    ids=[case[0] for case in ARTIFACT_CASES],
)
def test_all_artifacts_reject_duplicate_keys_and_floats_during_loading(
    _name: str,
    factory: ArtifactFactory,
    validator: ArtifactValidator,
    version_field: str,
) -> None:
    value = factory()
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    assert validator(load_descriptor_bytes(encoded)) == value

    duplicate = (
        b"{"
        + json.dumps(version_field).encode("utf-8")
        + b":"
        + json.dumps(value[version_field]).encode("utf-8")
        + b","
        + encoded[1:]
    )
    with pytest.raises(AdapterContractError, match="Duplicate JSON key"):
        load_descriptor_bytes(duplicate)

    floating = encoded[:-1] + b',"floating_probe":0.5}'
    with pytest.raises(AdapterContractError, match="JSON decimal"):
        load_descriptor_bytes(floating)


@pytest.mark.parametrize(
    ("factory", "wrong_permission"),
    [
        (_format_manifest, "network_fetch"),
        (_data_service_manifest, "local_pure"),
        (_compute_manifest, "local_pure"),
    ],
    ids=["format", "data-service", "compute"],
)
def test_manifest_adapter_type_and_permission_must_match(
    factory: ArtifactFactory,
    wrong_permission: str,
) -> None:
    manifest = factory()
    assert validate_adapter_manifest(manifest) == manifest

    manifest["permission_class"] = wrong_permission
    with pytest.raises(AdapterContractError):
        validate_adapter_manifest(manifest)


def test_compute_adapter_cannot_declare_or_expose_execute() -> None:
    manifest = _compute_manifest()
    manifest["operations"] = ["execute", "lower", "normalize", "resolve", "validate"]

    with pytest.raises(AdapterContractError):
        validate_adapter_manifest(manifest)
    assert "execute" not in ComputeAdapter.__dict__
    assert not hasattr(ComputeAdapter, "execute")


def _reverse_mapping_order(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _reverse_mapping_order(value[key]) for key in reversed(tuple(value))}
    if isinstance(value, list):
        return [_reverse_mapping_order(item) for item in value]
    return value


def test_canonical_hashes_are_deterministic_and_domain_separated() -> None:
    manifest = _format_manifest()
    capability = _format_capability()
    registry = _registry_document()
    cases = (
        (
            manifest,
            canonical_manifest_hash,
            "adapter_manifest_hash",
            b"chem-workbench:adapter-manifest:v1alpha1\x00",
        ),
        (
            capability,
            canonical_format_capability_hash,
            "format_capability_hash",
            b"chem-workbench:format-capability:v1alpha1\x00",
        ),
        (
            registry,
            canonical_registry_hash,
            "adapter_registry_hash",
            b"chem-workbench:adapter-registry:v1alpha1\x00",
        ),
    )

    hashes: list[dict[str, str]] = []
    for document, hash_function, digest_type, domain in cases:
        digest = hash_function(document)
        hashes.append(digest)
        assert digest == hash_function(copy.deepcopy(document))
        assert digest == hash_function(_reverse_mapping_order(document))
        assert digest == {
            "type": digest_type,
            "algorithm": "sha256",
            "value": hashlib.sha256(domain + canonical_bytes(document)).hexdigest(),
        }

    assert len({digest["value"] for digest in hashes}) == len(hashes)


def test_self_contained_registry_binds_exactly_but_cannot_grant_itself_trust() -> None:
    document = _registry_document()
    manifest = copy.deepcopy(document["adapters"][0]["manifest"])
    capability = copy.deepcopy(document["adapters"][0]["format_capabilities"][0]["capability"])

    assert validate_adapter_registry(document) == document
    registry = AdapterRegistry(document)
    assert registry.adapter_count == 1
    assert registry.active_adapter_count == 0
    assert registry.digest == canonical_registry_hash(document)

    expected_state = {
        "active": False,
        "conformance_status": "unqualified",
        "declared": False,
        "implementation_status": "not_registered",
        "reason": "REGISTRY_NOT_PACKAGE_TRUSTED",
        "registered": False,
        "schema_valid": True,
        "trusted": False,
    }
    assert registry.resolve_manifest(manifest).to_dict() == expected_state
    assert registry.resolve_format_capability(capability).to_dict() == expected_state


@pytest.mark.parametrize(
    "tamper_target",
    ["manifest-hash", "capability-hash", "capability-manifest-binding"],
)
def test_registry_rejects_binding_tampering(tamper_target: str) -> None:
    document = _registry_document()
    registration = document["adapters"][0]
    record = registration["format_capabilities"][0]

    if tamper_target == "manifest-hash":
        digest = registration["manifest_hash"]
        digest["value"] = _other_hash(digest["value"])
    elif tamper_target == "capability-hash":
        digest = record["capability_hash"]
        digest["value"] = _other_hash(digest["value"])
    else:
        digest = record["capability"]["adapter"]["manifest_hash"]
        digest["value"] = _other_hash(digest["value"])
        record["capability_hash"] = canonical_format_capability_hash(record["capability"])

    with pytest.raises(AdapterBindingError):
        validate_adapter_registry(document)
    with pytest.raises(AdapterBindingError):
        AdapterRegistry(document)


@pytest.mark.parametrize(
    ("binding", "expected_message"),
    [
        ("operations", "exceeds manifest operations"),
        ("profile", "uses an unsupported profile"),
        ("chemir-schema", "uses an undeclared ChemIR schema"),
        ("loss-schema", "uses an undeclared loss schema"),
    ],
)
def test_registry_rejects_manifest_capability_cross_binding_failures(
    binding: str,
    expected_message: str,
) -> None:
    document = _registry_document()
    registration = document["adapters"][0]
    manifest = registration["manifest"]

    if binding == "operations":
        manifest["operations"] = ["export_bytes", "import_bytes"]
    elif binding == "profile":
        manifest["supported_profiles"] = ["v1-other-profile"]
    elif binding == "chemir-schema":
        manifest["schema_versions"] = ["loss/v1alpha1"]
    else:
        manifest["schema_versions"] = ["chemir/v1alpha1"]
    _rebind_registry_hashes(document)

    capability = registration["format_capabilities"][0]["capability"]
    assert validate_adapter_manifest(manifest) == manifest
    assert validate_format_capability(capability) == capability
    with pytest.raises(AdapterBindingError, match=expected_message):
        validate_adapter_registry(document)


def test_registry_rejects_duplicate_direction_coordinates() -> None:
    document = _registry_document()
    records = document["adapters"][0]["format_capabilities"]
    duplicate = copy.deepcopy(records[0]["capability"])
    duplicate["capability_id"] = "org.example.sdf:export:v1-core-structure-compute-alias"
    records.append(
        {
            "capability": duplicate,
            "capability_hash": canonical_format_capability_hash(duplicate),
        }
    )

    assert [record["capability"]["capability_id"] for record in records] == sorted(
        record["capability"]["capability_id"] for record in records
    )
    with pytest.raises(AdapterContractError, match="ambiguous direction coordinate"):
        validate_adapter_registry(document)


def test_schema_valid_external_artifacts_remain_unregistered_in_bundled_registry() -> None:
    manifest = _format_manifest()
    capability = _format_capability()
    assert validate_adapter_manifest(manifest) == manifest
    assert validate_format_capability(capability) == capability

    registry = load_bundled_registry()
    for state in (
        registry.resolve_manifest(manifest),
        registry.resolve_format_capability(capability),
    ):
        assert state.schema_valid is True
        assert state.declared is False
        assert state.registered is False
        assert state.trusted is False
        assert state.active is False
        assert state.reason == "NO_STATIC_REGISTRATION"


@pytest.mark.parametrize(
    "binding",
    [
        "adapter-id",
        "adapter-version",
        "manifest-hash",
        "capability-hash",
        "direction",
        "format",
        "profile",
        "classification",
    ],
)
def test_loss_report_requires_exact_capability_binding(binding: str) -> None:
    capability = _format_capability()
    report = _loss_report()

    if binding == "adapter-id":
        report["adapter"]["id"] = "org.example.other"
    elif binding == "adapter-version":
        report["adapter"]["version"] = "2.0.0"
    elif binding == "manifest-hash":
        digest = report["adapter"]["manifest_hash"]
        digest["value"] = _other_hash(digest["value"])
    elif binding == "capability-hash":
        digest = report["capability_hash"]
        digest["value"] = _other_hash(digest["value"])
    elif binding == "direction":
        report["direction"] = "import"
        report["input_hash"] = _digest("source_sha256", "d")
        report["output_hash"] = _digest("semantic_hash", "e")
    elif binding == "format":
        report["format"]["dialect"] = "V3000"
    elif binding == "profile":
        report["profile"] = "v1-other-profile"
    else:
        report["classification"] = "ONE_WAY"

    assert validate_loss_report(report) == report
    with pytest.raises(AdapterBindingError, match="binding mismatch"):
        assess_loss_report(report, capability)


@pytest.mark.parametrize(
    ("failure", "expected_reason"),
    [
        ("unknown-loss-code", "LOSS_CODE_NOT_ALLOWED:COORDINATES_DROPPED"),
        ("error", "ERROR_ISSUE:STEREOCHEMISTRY_DROPPED"),
        ("lossy-dropped", "LOSS_APPROVAL_UNAVAILABLE:STEREOCHEMISTRY_DROPPED"),
        ("lossy-approximated", "LOSS_APPROVAL_UNAVAILABLE:STEREOCHEMISTRY_DROPPED"),
    ],
)
def test_loss_publication_fails_closed(failure: str, expected_reason: str) -> None:
    capability = _format_capability()
    report = _loss_report()

    if failure == "unknown-loss-code":
        report["issues"][0]["code"] = "COORDINATES_DROPPED"
    elif failure == "error":
        report["issues"][0]["severity"] = "error"
    elif failure == "lossy-approximated":
        report["issues"][0]["disposition"] = "approximated"

    decision = assess_loss_report(report, capability)
    assert decision.contract_eligible is False
    assert decision.publishable is False
    assert expected_reason in decision.reasons
    assert "PUBLICATION_PATH_UNAVAILABLE" in decision.reasons


def test_lossy_report_has_no_approval_or_publication_path() -> None:
    capability = _format_capability()
    report = _loss_report()

    decision = assess_loss_report(report, capability)
    assert decision.to_dict() == {
        "contract_eligible": False,
        "publishable": False,
        "reasons": [
            "LOSS_APPROVAL_UNAVAILABLE:STEREOCHEMISTRY_DROPPED",
            "PUBLICATION_PATH_UNAVAILABLE",
        ],
    }


def test_semantic_equivalent_report_can_be_contract_eligible_but_never_publishable() -> None:
    capability, report = _semantic_equivalent_pair()

    decision = assess_loss_report(report, capability)
    assert decision.contract_eligible is True
    assert decision.publishable is False
    assert decision.reasons == ("PUBLICATION_PATH_UNAVAILABLE",)


def test_caller_registry_keeps_exact_bindings_but_grants_no_authority() -> None:
    report = _loss_report()

    resolution = AdapterRegistry(_registry_document()).resolve_loss_report(report)
    assert resolution.bindings_valid is True
    assert resolution.contract_eligible is False
    assert resolution.publishable is False
    assert resolution.reasons == (
        "LOSS_APPROVAL_UNAVAILABLE:STEREOCHEMISTRY_DROPPED",
        "PUBLICATION_PATH_UNAVAILABLE",
        "REGISTRY_NOT_PACKAGE_TRUSTED",
    )
    assert resolution.state.declared is False
    assert resolution.state.registered is False
    assert resolution.state.trusted is False
    assert resolution.state.active is False
    assert resolution.state.implementation_status == "not_registered"
    assert resolution.state.conformance_status == "unqualified"
    assert resolution.state.reason == "REGISTRY_NOT_PACKAGE_TRUSTED"


def test_unregistered_report_stays_non_publishable_with_the_registered_registry() -> None:
    capability, report = _semantic_equivalent_pair()
    decision = assess_loss_report(report, capability)
    assert decision.contract_eligible is True
    assert decision.publishable is False

    registry = load_bundled_registry()
    resolution = registry.resolve_loss_report(report)
    assert registry.adapter_count == registry.active_adapter_count == 3
    assert resolution.bindings_valid is False
    assert resolution.contract_eligible is False
    assert resolution.publishable is False
    assert resolution.reasons == ("NO_STATIC_REGISTRATION",)
    assert resolution.state.declared is False
    assert resolution.state.registered is False
    assert resolution.state.trusted is False
    assert resolution.state.active is False
    assert resolution.state.reason == "NO_STATIC_REGISTRATION"


def test_lossy_report_requires_a_genuinely_lossy_issue() -> None:
    report = _loss_report()
    report["issues"][0]["disposition"] = "normalized"

    with pytest.raises(AdapterContractError):
        validate_loss_report(report)


def test_direct_python_float_cannot_bypass_manifest_integer_contract() -> None:
    manifest = _compute_manifest()
    manifest["resource_ceilings"]["cpu_threads"] = 1.0

    with pytest.raises(AdapterContractError):
        validate_adapter_manifest(manifest)


@pytest.mark.parametrize("coordinate", ["line", "column"])
def test_direct_python_float_cannot_bypass_loss_location_integer_contract(
    coordinate: str,
) -> None:
    report = _loss_report()
    report["issues"][0]["location"] = {
        "kind": "source",
        "source_hash": _digest("source_sha256", "f"),
        "line": 1,
        "column": 1,
    }
    report["issues"][0]["location"][coordinate] = 1.0

    with pytest.raises(AdapterContractError):
        validate_loss_report(report)
