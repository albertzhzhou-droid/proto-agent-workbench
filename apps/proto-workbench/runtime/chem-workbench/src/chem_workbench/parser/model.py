"""Syntax tree types for the bounded declarative alpha language."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from chem_workbench.diagnostics import Diagnostic


@dataclass(frozen=True, slots=True)
class SourceSpan:
    file: str
    line: int
    column: int
    end_line: int
    end_column: int


@dataclass(frozen=True, slots=True)
class Declaration:
    kind: str
    identifier: str
    fields: dict[str, Any]
    field_spans: dict[str, SourceSpan]
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class ParsedSource:
    language_version: str
    declarations: tuple[Declaration, ...]


@dataclass(frozen=True, slots=True)
class ParseResult:
    source: ParsedSource | None
    diagnostics: tuple[Diagnostic, ...] = field(default_factory=tuple)
