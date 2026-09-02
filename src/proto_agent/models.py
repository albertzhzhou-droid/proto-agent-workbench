from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


ConstructTopology = Literal["linear", "circular", "unknown"]
DECLARED_CONSTRUCT_TOPOLOGIES = frozenset({"linear", "circular"})
IR_CONSTRUCT_TOPOLOGIES = frozenset({*DECLARED_CONSTRUCT_TOPOLOGIES, "unknown"})


@dataclass
class Diagnostic:
    severity: str
    file: str
    line: int
    code: str
    message: str
    suggestion: str | None = None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "severity": self.severity,
            "file": self.file,
            "line": self.line,
            "code": self.code,
            "message": self.message,
        }
        if self.suggestion:
            payload["suggestion"] = self.suggestion
        return payload


@dataclass
class PartRef:
    type: str
    id: str
    line: int


@dataclass
class Construct:
    name: str
    line: int
    parts: list[PartRef] = field(default_factory=list)
    topology: ConstructTopology = "unknown"


@dataclass
class Constraint:
    type: str
    line: int
    params: dict[str, str] = field(default_factory=dict)


@dataclass
class Design:
    design_id: str
    chassis: str
    source_path: str
    constructs: list[Construct] = field(default_factory=list)
    constraints: list[Constraint] = field(default_factory=list)
