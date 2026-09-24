"""Strict semantic validation and hashing for adapter contract artifacts."""

from __future__ import annotations

import copy
import hashlib
from dataclasses import dataclass
from typing import Any

from chem_workbench.chemir import canonical_bytes, typed_digest, validate_typed_digest
from chem_workbench.chemir.canonical import CanonicalizationError
from chem_workbench.chemir.schema_validation import (
    SchemaValidationError,
    validate_adapter_capability_schema,
    validate_adapter_registry_schema,
    validate_format_capability_schema,
    validate_loss_report_schema,
)

ADAPTER_MANIFEST_VERSION = "adapter-capability/v1alpha1"
FORMAT_CAPABILITY_VERSION = "format-capability/v1alpha1"
ADAPTER_REGISTRY_VERSION = "adapter-registry/v1alpha1"
LOSS_REPORT_VERSION = "loss/v1alpha1"

_HASH_DOMAINS = {
    "adapter_manifest_hash": b"chem-workbench:adapter-manifest:v1alpha1\x00",
    "format_capability_hash": b"chem-workbench:format-capability:v1alpha1\x00",
    "adapter_registry_hash": b"chem-workbench:adapter-registry:v1alpha1\x00",
}
_TYPE_PERMISSION = {
    "FormatAdapter": "local_pure",
    "DataServiceConnector": "network_fetch",
    "ComputeAdapter": "compute_descriptor",
}
_TYPE_OPERATIONS = {
    "FormatAdapter": frozenset({"compare", "export_bytes", "import_bytes"}),
    "DataServiceConnector": frozenset({"fetch"}),
    "ComputeAdapter": frozenset({"lower", "normalize", "resolve", "validate"}),
}
_NON_PUBLISHABLE_CLASSIFICATIONS = frozenset({"QUERY_ONLY", "UNSUPPORTED"})
_APPROVAL_DISPOSITIONS = frozenset({"approximated", "dropped"})
_BLOCKING_DISPOSITIONS = frozenset({"unresolved", "unsupported"})


class AdapterContractError(ValueError):
    """Raised when a descriptor is schema-valid but semantically inconsistent."""


class AdapterBindingError(AdapterContractError):
    """Raised when two otherwise valid adapter artifacts do not bind exactly."""


@dataclass(frozen=True, slots=True)
class PublicationDecision:
    """Fail-closed descriptor assessment without approval authority."""

    contract_eligible: bool
    publishable: bool
    reasons: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "contract_eligible": self.contract_eligible,
            "publishable": self.publishable,
            "reasons": list(self.reasons),
        }


def _schema_checked(value: object, validator: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise AdapterContractError("Adapter artifact must be a JSON object")
    document = copy.deepcopy(value)
    try:
        canonical_bytes(document)
    except (CanonicalizationError, UnicodeError) as error:
        raise AdapterContractError(str(error)) from error
    try:
        validator(document)
    except SchemaValidationError as error:
        raise AdapterContractError(str(error)) from error
    return document


def _require_sorted_unique_strings(document: dict[str, Any], field: str) -> None:
    values = document[field]
    if not isinstance(values, list) or any(not isinstance(item, str) for item in values):
        raise AdapterContractError(f"{field} must be an array of strings")
    if values != sorted(set(values)):
        raise AdapterContractError(f"{field} must be sorted and contain no duplicates")


def validate_adapter_manifest(value: object) -> dict[str, Any]:
    """Validate one closed adapter descriptor without granting authority."""
    document = _schema_checked(value, validate_adapter_capability_schema)
    adapter_type = document["adapter_type"]
    permission_class = document["permission_class"]
    if _TYPE_PERMISSION.get(adapter_type) != permission_class:
        raise AdapterContractError(
            f"{adapter_type} cannot request permission class {permission_class!r}"
        )
    operations = document["operations"]
    if set(operations) - _TYPE_OPERATIONS[adapter_type]:
        raise AdapterContractError(f"{adapter_type} declares an operation outside its class")
    if "execute" in operations:
        raise AdapterContractError("Compute adapters cannot declare process execution")
    for field in (
        "schema_versions",
        "operations",
        "supported_profiles",
        "required_backends",
        "environment_allowlist",
        "licenses",
        "expected_loss_codes",
    ):
        _require_sorted_unique_strings(document, field)
    return document


def validate_format_capability(value: object) -> dict[str, Any]:
    """Validate a single direction-specific format capability."""
    document = _schema_checked(value, validate_format_capability_schema)
    _require_sorted_unique_strings(document, "operations")
    _require_sorted_unique_strings(document, "supported_fields")
    _require_sorted_unique_strings(document, "allowed_loss_codes")

    direction = document["direction"]
    classification = document["classification"]
    primary_operation = "import_bytes" if direction == "import" else "export_bytes"
    operations = set(document["operations"])
    if classification == "UNSUPPORTED":
        if operations:
            raise AdapterContractError("UNSUPPORTED capability cannot declare operations")
    elif primary_operation not in operations:
        raise AdapterContractError(f"{direction} capability must declare {primary_operation!r}")
    opposite = "export_bytes" if direction == "import" else "import_bytes"
    if opposite in operations:
        raise AdapterContractError("A format capability cannot imply the opposite direction")
    if classification == "LOSSY_WITH_REPORT" and not document["allowed_loss_codes"]:
        raise AdapterContractError("LOSSY_WITH_REPORT requires at least one allowed loss code")
    return document


def validate_loss_report(value: object) -> dict[str, Any]:
    """Validate loss-report shape and local classification invariants."""
    document = _schema_checked(value, validate_loss_report_schema)
    issues = document["issues"]
    classification = document["classification"]
    if classification == "BYTE_IDENTICAL" and issues:
        raise AdapterContractError("BYTE_IDENTICAL reports cannot contain loss issues")
    if classification in {"LOSSY_WITH_REPORT", "UNSUPPORTED"} and not issues:
        raise AdapterContractError(f"{classification} requires at least one issue")
    if classification == "LOSSY_WITH_REPORT" and not any(
        issue["disposition"] in {"approximated", "dropped", "unresolved", "unsupported"}
        for issue in issues
    ):
        raise AdapterContractError("LOSSY_WITH_REPORT requires at least one lossy disposition")
    if classification == "SEMANTIC_EQUIVALENT_UNDER_PROFILE":
        forbidden = {
            issue["disposition"]
            for issue in issues
            if issue["disposition"] not in {"preserved", "normalized"}
        }
        if forbidden:
            raise AdapterContractError(
                "SEMANTIC_EQUIVALENT_UNDER_PROFILE contains a lossy disposition"
            )
    if classification == "UNSUPPORTED" and not any(
        issue["severity"] == "error" or issue["disposition"] == "unsupported" for issue in issues
    ):
        raise AdapterContractError("UNSUPPORTED report requires a blocking issue")
    return document


def _canonical_document_hash(
    document: dict[str, Any],
    digest_type: str,
) -> dict[str, str]:
    material = _HASH_DOMAINS[digest_type] + canonical_bytes(document)
    digest = f"sha256:{hashlib.sha256(material).hexdigest()}"
    result = typed_digest(digest_type, digest)
    return {
        "type": result["type"],
        "algorithm": result["algorithm"],
        "value": result["value"],
    }


def canonical_manifest_hash(value: object) -> dict[str, str]:
    return _canonical_document_hash(validate_adapter_manifest(value), "adapter_manifest_hash")


def canonical_format_capability_hash(value: object) -> dict[str, str]:
    return _canonical_document_hash(
        validate_format_capability(value),
        "format_capability_hash",
    )


def canonical_registry_hash(value: object) -> dict[str, str]:
    return _canonical_document_hash(validate_adapter_registry(value), "adapter_registry_hash")


def _binding_digest(value: object, digest_type: str) -> str:
    try:
        return validate_typed_digest(value, digest_type)
    except ValueError as error:
        raise AdapterBindingError(str(error)) from error


def _same_json(left: object, right: object) -> bool:
    return canonical_bytes(left) == canonical_bytes(right)


def validate_adapter_registry(value: object) -> dict[str, Any]:
    """Validate a self-contained static registry and every bound descriptor."""
    document = _schema_checked(value, validate_adapter_registry_schema)
    registrations = document["adapters"]
    identities: list[tuple[str, str]] = []

    for registration in registrations:
        manifest = validate_adapter_manifest(registration["manifest"])
        identity = (manifest["adapter_id"], manifest["adapter_version"])
        identities.append(identity)
        expected_manifest_hash = canonical_manifest_hash(manifest)
        if not _same_json(registration["manifest_hash"], expected_manifest_hash):
            raise AdapterBindingError(
                f"Registry manifest hash mismatch for {identity[0]} {identity[1]}"
            )

        capability_ids: list[str] = []
        capability_coordinates: list[tuple[bytes, str, str, str]] = []
        allowed_loss_codes: set[str] = set()
        for record in registration["format_capabilities"]:
            capability = validate_format_capability(record["capability"])
            capability_ids.append(capability["capability_id"])
            expected_capability_hash = canonical_format_capability_hash(capability)
            if not _same_json(record["capability_hash"], expected_capability_hash):
                raise AdapterBindingError(
                    f"Registry format capability hash mismatch for {capability['capability_id']}"
                )
            binding = capability["adapter"]
            if (binding["id"], binding["version"]) != identity:
                raise AdapterBindingError(
                    f"Format capability {capability['capability_id']} names another adapter"
                )
            if not _same_json(binding["manifest_hash"], expected_manifest_hash):
                raise AdapterBindingError(
                    f"Format capability {capability['capability_id']} has a stale manifest hash"
                )
            if not set(capability["operations"]).issubset(set(manifest["operations"])):
                raise AdapterBindingError(
                    f"Format capability {capability['capability_id']} exceeds manifest operations"
                )
            if capability["profile"] not in manifest["supported_profiles"]:
                raise AdapterBindingError(
                    f"Format capability {capability['capability_id']} uses an unsupported profile"
                )
            if capability["chemir_schema_version"] not in manifest["schema_versions"]:
                raise AdapterBindingError(
                    "Format capability "
                    f"{capability['capability_id']} uses an undeclared ChemIR schema"
                )
            if capability["loss_report_version"] not in manifest["schema_versions"]:
                raise AdapterBindingError(
                    "Format capability "
                    f"{capability['capability_id']} uses an undeclared loss schema"
                )
            capability_coordinates.append(
                (
                    canonical_bytes(capability["format"]),
                    capability["direction"],
                    capability["chemir_schema_version"],
                    capability["profile"],
                )
            )
            allowed_loss_codes.update(capability["allowed_loss_codes"])

        if capability_ids != sorted(set(capability_ids)):
            raise AdapterContractError(
                f"Format capabilities for {identity[0]} must be sorted and unique by capability_id"
            )
        if len(set(capability_coordinates)) != len(capability_coordinates):
            raise AdapterContractError(
                f"Format capabilities for {identity[0]} contain an ambiguous direction coordinate"
            )
        if manifest["adapter_type"] == "FormatAdapter" and not capability_ids:
            raise AdapterContractError("FormatAdapter registration requires a format capability")
        if manifest["adapter_type"] != "FormatAdapter" and capability_ids:
            raise AdapterContractError(
                f"{manifest['adapter_type']} cannot register format capabilities"
            )
        if manifest["expected_loss_codes"] != sorted(allowed_loss_codes):
            raise AdapterBindingError(
                f"Manifest expected loss codes do not match its capabilities for {identity[0]}"
            )

    if identities != sorted(set(identities)):
        raise AdapterContractError("Registry adapters must be sorted and unique by identity")
    return document


def assess_loss_report(
    report_value: object,
    capability_value: object,
) -> PublicationDecision:
    """Evaluate local bindings without granting registration or approval authority."""
    report = validate_loss_report(report_value)
    capability = validate_format_capability(capability_value)
    capability_hash = canonical_format_capability_hash(capability)
    binding = report["adapter"]
    capability_binding = capability["adapter"]
    binding_fields = (
        (binding["id"], capability_binding["id"], "adapter id"),
        (binding["version"], capability_binding["version"], "adapter version"),
        (
            _binding_digest(binding["manifest_hash"], "adapter_manifest_hash"),
            _binding_digest(capability_binding["manifest_hash"], "adapter_manifest_hash"),
            "manifest hash",
        ),
        (
            _binding_digest(report["capability_hash"], "format_capability_hash"),
            _binding_digest(capability_hash, "format_capability_hash"),
            "capability hash",
        ),
        (report["direction"], capability["direction"], "direction"),
        (report["profile"], capability["profile"], "profile"),
        (report["classification"], capability["classification"], "classification"),
    )
    for actual, expected, label in binding_fields:
        if actual != expected:
            raise AdapterBindingError(f"Loss report {label} binding mismatch")
    if not _same_json(report["format"], capability["format"]):
        raise AdapterBindingError("Loss report format binding mismatch")

    allowed = set(capability["allowed_loss_codes"])
    reasons: list[str] = []
    if report["classification"] in _NON_PUBLISHABLE_CLASSIFICATIONS:
        reasons.append(f"CLASSIFICATION_NOT_PUBLISHABLE:{report['classification']}")
    if report["output_hash"] is None:
        reasons.append("OUTPUT_HASH_MISSING")
    for issue in report["issues"]:
        code = issue["code"]
        if code not in allowed:
            reasons.append(f"LOSS_CODE_NOT_ALLOWED:{code}")
        if issue["severity"] == "error":
            reasons.append(f"ERROR_ISSUE:{code}")
        if issue["disposition"] in _BLOCKING_DISPOSITIONS:
            reasons.append(f"BLOCKING_DISPOSITION:{code}")
        if issue["disposition"] in _APPROVAL_DISPOSITIONS or issue["severity"] == "review_required":
            reasons.append(f"LOSS_APPROVAL_UNAVAILABLE:{code}")
    contract_eligible = not reasons
    reasons.append("PUBLICATION_PATH_UNAVAILABLE")
    unique_reasons = tuple(dict.fromkeys(reasons))
    return PublicationDecision(
        contract_eligible=contract_eligible,
        publishable=False,
        reasons=unique_reasons,
    )
