"""Typed, side-effect-free interfaces for future chemistry adapters.

The protocols in this module describe values exchanged with a future isolated
host.  They do not discover, import, activate, or sandbox implementation code.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Protocol


class AdapterType(StrEnum):
    FORMAT = "FormatAdapter"
    DATA_SERVICE = "DataServiceConnector"
    COMPUTE = "ComputeAdapter"


class PermissionClass(StrEnum):
    LOCAL_PURE = "local_pure"
    NETWORK_FETCH = "network_fetch"
    COMPUTE_DESCRIPTOR = "compute_descriptor"


class FormatDirection(StrEnum):
    IMPORT = "import"
    EXPORT = "export"


class ConversionClassification(StrEnum):
    BYTE_IDENTICAL = "BYTE_IDENTICAL"
    SEMANTIC_EQUIVALENT = "SEMANTIC_EQUIVALENT_UNDER_PROFILE"
    LOSSY = "LOSSY_WITH_REPORT"
    ONE_WAY = "ONE_WAY"
    QUERY_ONLY = "QUERY_ONLY"
    UNSUPPORTED = "UNSUPPORTED"


@dataclass(frozen=True, slots=True)
class ImportResult:
    """Structured return value for a future pure import operation."""

    chemir: dict[str, Any]
    loss_report: dict[str, Any]


@dataclass(frozen=True, slots=True)
class ExportResult:
    """Structured return value for a future pure export operation."""

    content: bytes
    loss_report: dict[str, Any]


@dataclass(frozen=True, slots=True)
class FetchResult:
    """Future connector result; downloaded bytes stay separate from parsing."""

    content: bytes
    retrieval_evidence: dict[str, Any]


@dataclass(frozen=True, slots=True)
class SemanticComparison:
    """Bounded comparison result produced without granting side effects."""

    equivalent: bool
    profile: str
    diagnostics: tuple[dict[str, Any], ...]


class FormatAdapter(Protocol):
    """Future value-only format interface; this is not an activation API."""

    def import_bytes(self, source: bytes) -> ImportResult: ...

    def export_bytes(self, node: dict[str, Any]) -> ExportResult: ...

    def compare(
        self,
        left: dict[str, Any],
        right: dict[str, Any],
    ) -> SemanticComparison: ...


class DataServiceConnector(Protocol):
    """Future explicit-fetch interface; no connector is registered in this alpha."""

    def fetch(self, request: dict[str, Any]) -> FetchResult: ...


class ComputeAdapter(Protocol):
    """Future descriptor interface, intentionally without an execute method."""

    def validate(self, specification: dict[str, Any]) -> tuple[dict[str, Any], ...]: ...

    def lower(self, specification: dict[str, Any]) -> dict[str, Any]: ...

    def resolve(self, logical_plan: dict[str, Any]) -> dict[str, Any]: ...

    def normalize(self, raw_result: dict[str, Any]) -> dict[str, Any]: ...
