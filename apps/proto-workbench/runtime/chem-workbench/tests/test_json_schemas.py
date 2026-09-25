"""Offline integration tests for the bundled ChemIR JSON Schema graph."""

from __future__ import annotations

import copy
import json
import subprocess
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from chem_workbench.compiler import compile_source

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_DIRECTORIES = (
    REPOSITORY_ROOT / "schemas" / "chemir" / "v1alpha1",
    REPOSITORY_ROOT / "schemas" / "review" / "v1alpha1",
    REPOSITORY_ROOT / "schemas" / "adapters" / "v1alpha1",
)
EXAMPLE_DIRECTORY = REPOSITORY_ROOT / "examples"
RunChem = Callable[..., subprocess.CompletedProcess[bytes]]


def load_schema_documents() -> dict[str, dict[str, Any]]:
    documents: dict[str, dict[str, Any]] = {}
    schema_paths = sorted(
        path for directory in SCHEMA_DIRECTORIES for path in directory.rglob("*.json")
    )
    for path in schema_paths:
        value = json.loads(path.read_text(encoding="utf-8"))
        assert isinstance(value, dict), f"{path.name} must contain a JSON object"
        schema_id = value.get("$id")
        assert schema_id == path.name, f"{path.name} must use its filename as $id"
        assert schema_id not in documents, f"duplicate schema $id {schema_id!r}"
        documents[schema_id] = value
    return documents


def schema_registry(documents: dict[str, dict[str, Any]]) -> Registry[Any]:
    resources = []
    for schema_id, document in documents.items():
        schema_id = document.get("$id")
        assert isinstance(schema_id, str)
        resources.append((schema_id, Resource.from_contents(document)))
    return Registry().with_resources(resources)


def iter_references(value: object) -> Iterator[str]:
    if isinstance(value, dict):
        reference = value.get("$ref")
        if isinstance(reference, str):
            yield reference
        for child in value.values():
            yield from iter_references(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_references(child)


def format_validation_errors(validator: Draft202012Validator, instance: object) -> str:
    errors = sorted(validator.iter_errors(instance), key=lambda item: list(item.absolute_path))
    return "\n".join(f"{error.json_path}: {error.message}" for error in errors)


def test_all_schema_files_are_valid_draft_2020_12_documents() -> None:
    documents = load_schema_documents()

    assert "chemir.schema.json" in documents
    assert "object.schema.json" in documents
    assert "review-packet.schema.json" in documents
    assert "adapter-capability.schema.json" in documents
    assert "format-capability.schema.json" in documents
    assert "adapter-registry.schema.json" in documents
    assert "loss-report.schema.json" in documents
    for schema_id, document in documents.items():
        try:
            Draft202012Validator.check_schema(document)
        except Exception as error:
            pytest.fail(f"{schema_id} is not a valid Draft 2020-12 schema: {error}")


def test_every_cross_file_and_fragment_reference_resolves_offline() -> None:
    documents = load_schema_documents()
    registry = schema_registry(documents)
    review_references = set(iter_references(documents["review-packet.schema.json"]))
    adapter_registry_references = set(iter_references(documents["adapter-registry.schema.json"]))
    loss_report_references = set(iter_references(documents["loss-report.schema.json"]))

    assert "chemir.schema.json" in review_references
    assert any(reference.startswith("common.schema.json#") for reference in review_references)
    assert "adapter-capability.schema.json" in adapter_registry_references
    assert "format-capability.schema.json" in adapter_registry_references
    assert any(
        reference.startswith("format-capability.schema.json#")
        for reference in loss_report_references
    )

    for schema_id, document in documents.items():
        resolver = registry.resolver(base_uri=schema_id)
        for reference in iter_references(document):
            try:
                resolved = resolver.lookup(reference)
            except Exception as error:
                pytest.fail(f"Unresolved $ref {reference!r} in {schema_id}: {error}")
            assert resolved.contents is not None


@pytest.mark.parametrize(
    "relative_path",
    [
        Path("molecules/water.chem"),
        Path("molecules/chiral.chem"),
        Path("crystals/silicon.chem"),
        Path("crystals/fcc-copper.chem"),
        Path("surfaces/cu111-adatom-diffusion.chem"),
    ],
    ids=("water", "chiral", "silicon", "fcc-copper", "cu111-adatom-diffusion"),
)
def test_supported_example_compiler_output_conforms_to_top_level_schema(
    relative_path: Path,
) -> None:
    source_path = EXAMPLE_DIRECTORY / relative_path
    result = compile_source(source_path.read_bytes(), source_path.as_posix())
    assert result.success
    assert result.document is not None

    documents = load_schema_documents()
    validator = Draft202012Validator(
        documents["chemir.schema.json"],
        registry=schema_registry(documents),
    )

    errors = format_validation_errors(validator, result.document)
    assert not errors, f"{relative_path} emitted non-conforming ChemIR:\n{errors}"


def test_both_actual_review_packet_paths_conform_to_review_schema(
    tmp_path: Path,
    run_chem: RunChem,
) -> None:
    source_path = EXAMPLE_DIRECTORY / "molecules" / "water.chem"
    result = compile_source(source_path.read_bytes(), source_path.as_posix())
    assert result.success
    assert result.artifact_bytes is not None

    documents = load_schema_documents()
    validator = Draft202012Validator(
        documents["review-packet.schema.json"],
        registry=schema_registry(documents),
    )

    source_packet = result.review_packet()
    source_errors = format_validation_errors(validator, source_packet)
    assert not source_errors, f"source review packet is not schema-valid:\n{source_errors}"
    assert source_packet["verification_scope"] == "self_consistency"
    assert source_packet["signature_status"] == "unsigned"
    assert "claims" not in source_packet
    assert [item["observation_type"] for item in source_packet["observations"]] == [
        "SOURCE_PARSE_ACCEPTED"
    ]
    assert {entry["claim"] for entry in source_packet["not_claimed"]} == {
        "PARSE_VALID",
        "STRUCTURE_MODEL_CONSISTENT",
        "CHEMISTRY_CHECKED",
    }

    chemir_path = tmp_path / "water.chemir.json"
    chemir_path.write_bytes(result.artifact_bytes)
    completed = run_chem("review-compile", chemir_path)
    assert completed.returncode == 0, completed.stderr.decode("utf-8", errors="replace")
    existing_chemir_packet = json.loads(completed.stdout)
    existing_errors = format_validation_errors(validator, existing_chemir_packet)
    assert not existing_errors, (
        f"existing-ChemIR review packet is not schema-valid:\n{existing_errors}"
    )
    assert existing_chemir_packet["verification_scope"] == "self_consistency"
    assert existing_chemir_packet["signature_status"] == "unsigned"
    assert "claims" not in existing_chemir_packet
    assert existing_chemir_packet["observations"] == []
    assert {entry["claim"] for entry in existing_chemir_packet["not_claimed"]} == {
        "PARSE_VALID",
        "STRUCTURE_MODEL_CONSISTENT",
        "CHEMISTRY_CHECKED",
    }


@pytest.mark.parametrize(
    "invalidity",
    (
        "unknown-observation",
        "wrong-typed-digest",
        "unknown-top-level-field",
        "unknown-observation-field",
    ),
)
def test_review_packet_schema_rejects_unsupported_content(invalidity: str) -> None:
    source_path = EXAMPLE_DIRECTORY / "molecules" / "water.chem"
    result = compile_source(source_path.read_bytes(), source_path.as_posix())
    assert result.success

    packet = copy.deepcopy(result.review_packet())
    if invalidity == "unknown-observation":
        packet["observations"][0]["observation_type"] = "LAB_EXECUTION_APPROVED"
    elif invalidity == "wrong-typed-digest":
        packet["chemir_artifact_hash"]["type"] = "semantic_hash"
    elif invalidity == "unknown-top-level-field":
        packet["unknown"] = True
    else:
        packet["observations"][0]["unknown"] = True

    documents = load_schema_documents()
    validator = Draft202012Validator(
        documents["review-packet.schema.json"],
        registry=schema_registry(documents),
    )

    errors = format_validation_errors(validator, packet)
    assert errors, f"review packet with {invalidity} unexpectedly passed validation"


def test_ferrocene_preview_still_fails_before_chemir_emission() -> None:
    source_path = EXAMPLE_DIRECTORY / "coordination" / "ferrocene.preview.chem"

    result = compile_source(source_path.read_bytes(), source_path.as_posix())

    assert not result.success
    assert result.document is None
    assert result.artifact_bytes is None
    assert "CHM2001" in {diagnostic.code for diagnostic in result.diagnostics}
