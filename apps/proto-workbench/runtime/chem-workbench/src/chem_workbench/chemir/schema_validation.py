"""Offline validation against the JSON Schemas bundled with the package."""

from __future__ import annotations

import json
from functools import cache, lru_cache
from importlib.resources import files
from itertools import islice
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator  # type: ignore[import-untyped]
from referencing import Registry, Resource


class SchemaValidationError(ValueError):
    """Raised when an artifact does not conform to a bundled schema."""


def _schema_texts() -> dict[str, str]:
    relative_directories = (
        ("chemir", "v1alpha1"),
        ("review", "v1alpha1"),
        ("adapters", "v1alpha1"),
    )
    package_root = files("chem_workbench").joinpath("schemas")
    package_texts: dict[str, str] = {}
    for family, version in relative_directories:
        directory = package_root.joinpath(family).joinpath(version)
        if directory.is_dir():
            package_texts.update(
                {
                    child.name: child.read_text(encoding="utf-8")
                    for child in directory.iterdir()
                    if child.name.endswith(".json")
                }
            )
    if package_texts:
        return package_texts

    repository_root = Path(__file__).resolve().parents[3] / "schemas"
    repository_texts: dict[str, str] = {}
    for family, version in relative_directories:
        directory = repository_root / family / version
        if directory.is_dir():
            repository_texts.update(
                {path.name: path.read_text(encoding="utf-8") for path in directory.glob("*.json")}
            )
    if repository_texts:
        return repository_texts
    raise SchemaValidationError("Bundled Chem Workbench schemas are unavailable")


@lru_cache(maxsize=1)
def _schema_documents() -> dict[str, dict[str, Any]]:
    try:
        documents: dict[str, dict[str, Any]] = {}
        for filename, text in _schema_texts().items():
            value = json.loads(text)
            if not isinstance(value, dict) or value.get("$id") != filename:
                raise SchemaValidationError(f"Bundled schema {filename!r} has an invalid $id")
            Draft202012Validator.check_schema(value)
            documents[filename] = value
        return documents
    except SchemaValidationError:
        raise
    except Exception as error:
        raise SchemaValidationError(f"Cannot load bundled schemas: {error}") from error


@cache
def _validator(schema_name: str) -> Draft202012Validator:
    documents = _schema_documents()
    try:
        root = documents[schema_name]
    except KeyError as error:
        raise SchemaValidationError(f"Bundled schema {schema_name!r} is unavailable") from error
    resources = [
        (filename, Resource.from_contents(document)) for filename, document in documents.items()
    ]
    registry: Registry[Any] = Registry().with_resources(resources)
    return Draft202012Validator(root, registry=registry)


def validate_against_schema(instance: object, schema_name: str) -> None:
    """Validate one instance and report bounded, deterministic error details."""
    try:
        errors = sorted(
            islice(_validator(schema_name).iter_errors(instance), 9),
            key=lambda error: (tuple(str(part) for part in error.absolute_path), error.message),
        )
    except SchemaValidationError:
        raise
    except Exception as error:
        raise SchemaValidationError(
            f"Cannot evaluate bundled schema {schema_name!r}: {error}"
        ) from error
    if not errors:
        return
    details: list[str] = []
    for validation_error in errors[:8]:
        path = "$"
        for part in validation_error.absolute_path:
            path += f"[{part}]" if isinstance(part, int) else f".{part}"
        details.append(f"{path}: {validation_error.message}")
    suffix = "; additional errors omitted" if len(errors) > 8 else ""
    raise SchemaValidationError("Schema validation failed: " + "; ".join(details) + suffix)


def validate_chemir_schema(instance: object) -> None:
    validate_against_schema(instance, "chemir.schema.json")


def validate_review_packet_schema(instance: object) -> None:
    validate_against_schema(instance, "review-packet.schema.json")


def validate_adapter_capability_schema(instance: object) -> None:
    validate_against_schema(instance, "adapter-capability.schema.json")


def validate_format_capability_schema(instance: object) -> None:
    validate_against_schema(instance, "format-capability.schema.json")


def validate_adapter_registry_schema(instance: object) -> None:
    validate_against_schema(instance, "adapter-registry.schema.json")


def validate_loss_report_schema(instance: object) -> None:
    validate_against_schema(instance, "loss-report.schema.json")
