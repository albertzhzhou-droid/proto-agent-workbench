"""CLI tests for the descriptor-only adapter capability boundary."""

from __future__ import annotations

import json
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

from chem_workbench.adapters import (
    canonical_format_capability_hash,
    canonical_manifest_hash,
)
from chem_workbench.chemir import pretty_bytes

RunChem = Callable[..., subprocess.CompletedProcess[bytes]]


def adapter_manifest() -> dict[str, object]:
    return {
        "manifest_version": "adapter-capability/v1alpha1",
        "adapter_id": "example.sdf",
        "adapter_version": "0.1.0",
        "adapter_type": "FormatAdapter",
        "permission_class": "local_pure",
        "package_hash": {
            "type": "adapter_package_hash",
            "algorithm": "sha256",
            "value": "0" * 64,
        },
        "schema_versions": ["chemir/v1alpha1", "loss/v1alpha1"],
        "operations": ["compare", "export_bytes"],
        "supported_profiles": ["v1-core-structure-compute"],
        "required_backends": [],
        "network_policy": "deny",
        "environment_allowlist": [],
        "resource_ceilings": {},
        "licenses": ["MIT"],
        "expected_loss_codes": ["STEREOCHEMISTRY_DROPPED"],
    }


def format_capability() -> dict[str, object]:
    manifest = adapter_manifest()
    return {
        "capability_version": "format-capability/v1alpha1",
        "capability_id": "example.sdf.export",
        "adapter": {
            "id": "example.sdf",
            "version": "0.1.0",
            "manifest_hash": canonical_manifest_hash(manifest),
        },
        "format": {
            "name": "sdf",
            "dialect": "v2000",
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
        "numeric_tolerance_policy": "not_applicable",
        "supported_fields": ["/objects/*/payload/representations"],
        "allowed_loss_codes": ["STEREOCHEMISTRY_DROPPED"],
        "loss_report_version": "loss/v1alpha1",
    }


def loss_report() -> dict[str, object]:
    capability = format_capability()
    return {
        "loss_report_version": "loss/v1alpha1",
        "adapter": capability["adapter"],
        "capability_hash": canonical_format_capability_hash(capability),
        "direction": "export",
        "format": capability["format"],
        "profile": "v1-core-structure-compute",
        "input_hash": {
            "type": "semantic_hash",
            "algorithm": "sha256",
            "value": "1" * 64,
        },
        "output_hash": {
            "type": "artifact_sha256",
            "algorithm": "sha256",
            "value": "2" * 64,
        },
        "classification": "LOSSY_WITH_REPORT",
        "issues": [
            {
                "code": "STEREOCHEMISTRY_DROPPED",
                "severity": "review_required",
                "location": {
                    "kind": "chemir_path",
                    "path": "/objects/0/payload/representations/0",
                },
                "feature": "stereochemistry",
                "disposition": "dropped",
                "message": "The target dialect cannot encode this stereochemical feature.",
                "suggestion": "Choose a capable dialect or approve this exact loss code.",
                "evidence_hashes": [],
            }
        ],
    }


def test_capabilities_json_is_deterministic_static_and_registered(run_chem: RunChem) -> None:
    first = run_chem("capabilities")
    second = run_chem("capabilities", "--json")

    assert first.returncode == second.returncode == 0
    assert first.stderr == second.stderr == b""
    assert first.stdout == second.stdout
    registry = json.loads(first.stdout)
    assert registry["registry_version"] == "adapter-registry/v1alpha1"
    assert registry["product"] == {"name": "chem-workbench", "version": "0.1.0a2"}
    assert [item["manifest"]["adapter_id"] for item in registry["adapters"]] == [
        "chem.cif.probe",
        "chem.compute.governed",
        "chem.compute.refinement",
    ]
    assert registry["discovery"] == {
        "executable_path_probe": False,
        "mode": "static_only",
        "module_scan": False,
        "network_probe": False,
        "path_scan": False,
        "python_entry_points": False,
    }
    lowered = first.stdout.lower()
    assert b"c:\\" not in lowered
    assert b"users\\" not in lowered
    assert b"timestamp" not in lowered


def test_capabilities_can_write_and_inspect_the_exact_registry(
    tmp_path: Path,
    run_chem: RunChem,
) -> None:
    output = tmp_path / "capabilities.json"

    emitted = run_chem("capabilities", "--output", output)
    inspected = run_chem("inspect", output)

    assert emitted.returncode == 0
    assert output.is_file()
    assert inspected.returncode == 0
    summary = json.loads(inspected.stdout)
    assert summary["artifact_type"] == "AdapterRegistry"
    assert summary["schema_valid"] is True
    assert summary["bindings_valid"] is True
    assert summary["matches_bundled_registry"] is True
    assert summary["trusted"] is True
    assert summary["registered_adapter_count"] == 3
    assert summary["active_adapter_count"] == 3


def test_capabilities_text_is_explicit_about_disabled_authorities(run_chem: RunChem) -> None:
    completed = run_chem("capabilities", "--format", "text")

    assert completed.returncode == 0
    assert completed.stderr == b""
    assert b"registered_adapters=3" in completed.stdout
    assert b"active_adapters=3" in completed.stdout
    assert b"dynamic_discovery=false" in completed.stdout
    assert b"process_execution=false" in completed.stdout
    assert b"network_probe=false" in completed.stdout
    assert b"laboratory_control=false" in completed.stdout


def test_text_capabilities_refuse_artifact_output(
    tmp_path: Path,
    run_chem: RunChem,
) -> None:
    output = tmp_path / "must-not-exist.txt"

    completed = run_chem("capabilities", "--format", "text", "--output", output)

    assert completed.returncode == 2
    assert completed.stdout == b""
    assert b"CHM9006" in completed.stderr
    assert not output.exists()


@pytest.mark.parametrize(
    ("artifact_type", "factory", "expected_type"),
    [
        ("manifest", adapter_manifest, "AdapterCapability"),
        ("capability", format_capability, "FormatCapability"),
        ("loss", loss_report, "LossReport"),
    ],
)
def test_inspect_validates_but_does_not_activate_external_adapter_artifacts(
    artifact_type: str,
    factory: Callable[[], dict[str, object]],
    expected_type: str,
    tmp_path: Path,
    run_chem: RunChem,
) -> None:
    artifact = tmp_path / f"{artifact_type}.json"
    artifact.write_bytes(pretty_bytes(factory()))

    completed = run_chem("inspect", artifact)

    assert completed.returncode == 0, completed.stderr.decode("utf-8", errors="replace")
    assert completed.stderr == b""
    summary = json.loads(completed.stdout)
    assert summary["artifact_type"] == expected_type
    assert summary["schema_valid"] is True
    assert summary["registered"] is False
    assert summary["trusted"] is False
    assert summary["active"] is False
    if artifact_type == "loss":
        assert summary["bindings_valid"] is False
        assert summary["publishable"] is False
        assert summary["publication_reasons"] == ["NO_STATIC_REGISTRATION"]


@pytest.mark.parametrize("factory", [adapter_manifest, format_capability, loss_report])
def test_inspect_rejects_unknown_adapter_artifact_fields(
    factory: Callable[[], dict[str, object]],
    tmp_path: Path,
    run_chem: RunChem,
) -> None:
    value = factory()
    value["unknown_authority"] = True
    artifact = tmp_path / "unknown-field.json"
    artifact.write_bytes(pretty_bytes(value))

    completed = run_chem("inspect", artifact)

    assert completed.returncode == 2
    assert completed.stdout == b""
    assert b"CHM9004" in completed.stderr
    assert b"Traceback" not in completed.stderr
