"""Stable, source-linked diagnostics shared by every compiler stage."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class Severity(StrEnum):
    ERROR = "error"
    WARNING = "warning"
    INFO = "info"
    REVIEW_REQUIRED = "review_required"


@dataclass(frozen=True, slots=True)
class SourceLocation:
    file: str
    line: int
    column: int
    end_line: int | None = None
    end_column: int | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "file": self.file,
            "line": self.line,
            "column": self.column,
        }
        if self.end_line is not None:
            result["end_line"] = self.end_line
        if self.end_column is not None:
            result["end_column"] = self.end_column
        return result


@dataclass(frozen=True, slots=True)
class Diagnostic:
    severity: Severity
    code: str
    message: str
    location: SourceLocation
    suggestion: str
    chemir_path: str | None = None
    evidence_references: tuple[str, ...] = field(default_factory=tuple)

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "severity": self.severity.value,
            "code": self.code,
            "message": self.message,
            **self.location.to_dict(),
            "suggestion": self.suggestion,
            "evidence_references": list(self.evidence_references),
        }
        if self.chemir_path is not None:
            result["chemir_path"] = self.chemir_path
        return result
