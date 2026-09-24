"""Immutable static adapter registry and exact binding resolution."""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import cache
from importlib.resources import files
from typing import Any, NoReturn, cast

from chem_workbench.chemir import canonical_bytes
from chem_workbench.version import __version__

from .validation import (
    AdapterBindingError,
    AdapterContractError,
    PublicationDecision,
    assess_loss_report,
    canonical_format_capability_hash,
    canonical_manifest_hash,
    canonical_registry_hash,
    validate_adapter_manifest,
    validate_adapter_registry,
    validate_format_capability,
    validate_loss_report,
)

MAX_REGISTRY_BYTES = 4 * 1024 * 1024
MAX_REGISTRY_NESTING = 64


class DuplicateRegistryKeyError(AdapterContractError):
    pass


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateRegistryKeyError(f"Duplicate JSON key {key!r}")
        result[key] = value
    return result


def _reject_constant(value: str) -> NoReturn:
    raise AdapterContractError(f"Non-finite JSON number {value!r} is not allowed")


def _reject_float(value: str) -> NoReturn:
    raise AdapterContractError(
        f"JSON decimal {value!r} is outside the exact-integer descriptor subset"
    )


def _check_nesting(content: bytes) -> None:
    depth = 0
    in_string = False
    escaped = False
    for byte in content:
        if in_string:
            if escaped:
                escaped = False
            elif byte == 0x5C:
                escaped = True
            elif byte == 0x22:
                in_string = False
            continue
        if byte == 0x22:
            in_string = True
        elif byte in (0x5B, 0x7B):
            depth += 1
            if depth > MAX_REGISTRY_NESTING:
                raise AdapterContractError(
                    f"Registry nesting exceeds the limit of {MAX_REGISTRY_NESTING}"
                )
        elif byte in (0x5D, 0x7D):
            depth = max(depth - 1, 0)


def load_descriptor_bytes(content: bytes) -> dict[str, Any]:
    """Load bounded, exact-integer JSON and reject duplicate keys."""
    if len(content) > MAX_REGISTRY_BYTES:
        raise AdapterContractError(f"Descriptor exceeds the limit of {MAX_REGISTRY_BYTES} bytes")
    _check_nesting(content)
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as error:
        raise AdapterContractError(
            f"Descriptor is not valid UTF-8 at byte {error.start}"
        ) from error
    try:
        value = json.loads(
            text,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_constant,
            parse_float=_reject_float,
        )
    except json.JSONDecodeError as error:
        raise AdapterContractError(f"Descriptor is not valid JSON: {error.msg}") from error
    if not isinstance(value, dict):
        raise AdapterContractError("Descriptor top-level value must be an object")
    return value


@cache
def _bundled_registry_canonical_bytes() -> bytes:
    resource = files("chem_workbench.adapters").joinpath("builtin-registry.json")
    document = load_descriptor_bytes(resource.read_bytes())
    product = document.get("product")
    if not isinstance(product, dict) or product.get("version") != __version__:
        raise AdapterContractError("Bundled adapter registry product version mismatch")
    return canonical_bytes(validate_adapter_registry(document))


@dataclass(frozen=True, slots=True)
class RegistryResolution:
    schema_valid: bool
    declared: bool
    registered: bool
    trusted: bool
    active: bool
    implementation_status: str
    conformance_status: str
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "active": self.active,
            "conformance_status": self.conformance_status,
            "declared": self.declared,
            "implementation_status": self.implementation_status,
            "reason": self.reason,
            "registered": self.registered,
            "schema_valid": self.schema_valid,
            "trusted": self.trusted,
        }


@dataclass(frozen=True, slots=True)
class LossReportResolution:
    state: RegistryResolution
    bindings_valid: bool
    contract_eligible: bool
    publishable: bool
    reasons: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        result = self.state.to_dict()
        result.update(
            {
                "bindings_valid": self.bindings_valid,
                "contract_eligible": self.contract_eligible,
                "publishable": self.publishable,
                "publication_reasons": list(self.reasons),
            }
        )
        return result


@dataclass(frozen=True, slots=True, init=False)
class AdapterRegistry:
    """Validated registry; only the package-owned instance is a trust root."""

    _document_bytes: bytes
    _package_owned: bool

    def __init__(self, document: object) -> None:
        document_bytes = canonical_bytes(validate_adapter_registry(document))
        object.__setattr__(self, "_document_bytes", document_bytes)
        object.__setattr__(
            self,
            "_package_owned",
            document_bytes == _bundled_registry_canonical_bytes(),
        )

    @property
    def document(self) -> dict[str, Any]:
        return load_descriptor_bytes(self._document_bytes)

    @property
    def digest(self) -> dict[str, str]:
        return canonical_registry_hash(self.document)

    @property
    def adapter_count(self) -> int:
        return len(self.document["adapters"])

    @property
    def active_adapter_count(self) -> int:
        if not self._package_owned:
            return 0
        return sum(self._registration_active(item) for item in self.document["adapters"])

    @staticmethod
    def _registration_active(registration: dict[str, Any]) -> bool:
        return bool(
            registration["enabled"]
            and registration["implementation_status"] == "installed_verified"
            and registration["conformance_status"] in {"experimental", "normative"}
        )

    def _state(
        self,
        registration: dict[str, Any] | None,
        *,
        declared: bool,
        exact: bool,
        reason: str,
    ) -> RegistryResolution:
        declared = bool(declared and self._package_owned)
        registered = bool(exact and declared)
        active = bool(
            registered and registration is not None and self._registration_active(registration)
        )
        if registration is None or not self._package_owned:
            implementation_status = "not_registered"
            conformance_status = "unqualified"
        else:
            implementation_status = registration["implementation_status"]
            conformance_status = registration["conformance_status"]
        if registration is not None and not self._package_owned:
            reason = "REGISTRY_NOT_PACKAGE_TRUSTED"
        elif registered and not active:
            assert registration is not None
            if not registration["enabled"]:
                reason = "DISABLED_BY_POLICY"
            elif registration["implementation_status"] != "installed_verified":
                reason = "IMPLEMENTATION_NOT_VERIFIED"
            else:
                reason = "CONFORMANCE_UNQUALIFIED"
        elif active:
            reason = "ACTIVE"
        return RegistryResolution(
            schema_valid=True,
            declared=declared,
            registered=registered,
            trusted=registered,
            active=active,
            implementation_status=implementation_status,
            conformance_status=conformance_status,
            reason=reason,
        )

    def _find_identity(self, adapter_id: str, adapter_version: str) -> dict[str, Any] | None:
        for registration in self.document["adapters"]:
            manifest = registration["manifest"]
            if (
                manifest["adapter_id"] == adapter_id
                and manifest["adapter_version"] == adapter_version
            ):
                return cast(dict[str, Any], registration)
        return None

    def resolve_manifest(self, value: object) -> RegistryResolution:
        manifest = validate_adapter_manifest(value)
        registration = self._find_identity(
            manifest["adapter_id"],
            manifest["adapter_version"],
        )
        if registration is None:
            return self._state(
                None,
                declared=False,
                exact=False,
                reason="NO_STATIC_REGISTRATION",
            )
        exact = canonical_bytes(registration["manifest_hash"]) == canonical_bytes(
            canonical_manifest_hash(manifest)
        ) and canonical_bytes(registration["manifest"]) == canonical_bytes(manifest)
        return self._state(
            registration,
            declared=True,
            exact=exact,
            reason="MANIFEST_BINDING_MISMATCH" if not exact else "REGISTERED",
        )

    def _find_capability(
        self,
        capability_hash: dict[str, Any],
        adapter_id: str,
        adapter_version: str,
    ) -> tuple[dict[str, Any], dict[str, Any]] | None:
        registration = self._find_identity(adapter_id, adapter_version)
        if registration is None:
            return None
        for record in registration["format_capabilities"]:
            if canonical_bytes(record["capability_hash"]) == canonical_bytes(capability_hash):
                return registration, record["capability"]
        return None

    def resolve_format_capability(self, value: object) -> RegistryResolution:
        capability = validate_format_capability(value)
        binding = capability["adapter"]
        found = self._find_capability(
            canonical_format_capability_hash(capability),
            binding["id"],
            binding["version"],
        )
        registration = self._find_identity(binding["id"], binding["version"])
        if found is None:
            return self._state(
                registration,
                declared=registration is not None,
                exact=False,
                reason=(
                    "NO_STATIC_REGISTRATION"
                    if registration is None
                    else "CAPABILITY_NOT_REGISTERED"
                ),
            )
        _, registered_capability = found
        exact = canonical_bytes(registered_capability) == canonical_bytes(capability)
        return self._state(
            registration,
            declared=True,
            exact=exact,
            reason="CAPABILITY_BINDING_MISMATCH" if not exact else "REGISTERED",
        )

    def resolve_loss_report(
        self,
        value: object,
    ) -> LossReportResolution:
        report = validate_loss_report(value)
        binding = report["adapter"]
        found = self._find_capability(
            report["capability_hash"],
            binding["id"],
            binding["version"],
        )
        registration = self._find_identity(binding["id"], binding["version"])
        if found is None:
            state = self._state(
                registration,
                declared=registration is not None,
                exact=False,
                reason=(
                    "NO_STATIC_REGISTRATION"
                    if registration is None
                    else "CAPABILITY_NOT_REGISTERED"
                ),
            )
            return LossReportResolution(
                state=state,
                bindings_valid=False,
                contract_eligible=False,
                publishable=False,
                reasons=(state.reason,),
            )
        registration, capability = found
        try:
            decision: PublicationDecision = assess_loss_report(report, capability)
        except AdapterBindingError as error:
            state = self._state(
                registration,
                declared=True,
                exact=False,
                reason="LOSS_REPORT_BINDING_MISMATCH",
            )
            return LossReportResolution(
                state=state,
                bindings_valid=False,
                contract_eligible=False,
                publishable=False,
                reasons=(str(error),),
            )
        state = self._state(
            registration,
            declared=True,
            exact=True,
            reason="REGISTERED",
        )
        reasons = list(decision.reasons)
        if not state.active:
            reasons.append(state.reason)
        unique_reasons = tuple(dict.fromkeys(reasons))
        return LossReportResolution(
            state=state,
            bindings_valid=True,
            contract_eligible=decision.contract_eligible,
            publishable=False,
            reasons=unique_reasons,
        )


def load_bundled_registry() -> AdapterRegistry:
    """Load only the package-owned static registry; perform no discovery."""
    return AdapterRegistry(load_descriptor_bytes(_bundled_registry_canonical_bytes()))


def bundled_registry_document() -> dict[str, Any]:
    return load_bundled_registry().document
