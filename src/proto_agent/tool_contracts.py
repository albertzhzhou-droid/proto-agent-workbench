"""MCP contract view generated from the host's canonical ToolContract table.

Edit ``apps/proto-workbench/src/shared/tool-contracts.ts`` and run
``node --experimental-strip-types scripts/export-tool-contracts.mjs`` from the
Workbench directory. The generated package resource is checked against the
live host table in CI; this module does not maintain a second list of tools.
"""

from __future__ import annotations

from dataclasses import dataclass
from importlib.resources import files
import json
from typing import Any, Literal

CONTRACT_SCHEMA_VERSION = "proto-agent.tool-contract.v1"

ToolEffect = Literal["read", "write"]
ToolAccess = Literal["auto", "grant-network", "grant-execution", "grant-write", "denied"]


class UnknownCapabilityError(ValueError):
    """Raised when a name has no contract row, so no effect can be assumed."""

    code = "UNKNOWN_CAPABILITY"


@dataclass(frozen=True, slots=True)
class ToolContract:
    name: str
    effect: ToolEffect
    network: bool
    access: ToolAccess
    capability_id: str
    preconditions: tuple[str, ...]
    produces: tuple[str, ...]
    idempotent: bool
    cost_class: Literal["cheap", "metered", "external"]
    max_calls_per_run: int


def _load_rows() -> tuple[ToolContract, ...]:
    resource = files("proto_agent").joinpath("data", "tool-contracts.json")
    payload = json.loads(resource.read_text(encoding="utf-8"))
    if payload.get("schema_version") != CONTRACT_SCHEMA_VERSION or not isinstance(payload.get("tools"), list):
        raise RuntimeError("Generated tool contract resource has an unsupported schema.")
    rows = tuple(ToolContract(**{**row, "preconditions": tuple(row["preconditions"]),
                                "produces": tuple(row["produces"])}) for row in payload["tools"])
    if any(row.effect not in {"read", "write"} or type(row.network) is not bool
           or row.access not in {"auto", "grant-network", "grant-execution", "grant-write", "denied"}
           or not row.name.startswith("proto_") or not row.capability_id
           or not row.preconditions or any(condition not in {"schema-validated", "within-run-budget", "material-binding"} for condition in row.preconditions)
           or not row.produces or any(not isinstance(artifact, str) or not artifact for artifact in row.produces)
           or type(row.idempotent) is not bool or row.idempotent != (row.effect == "read")
           or row.cost_class not in {"cheap", "metered", "external"}
           or type(row.max_calls_per_run) is not int or not 1 <= row.max_calls_per_run <= 9_007_199_254_740_991
           for row in rows):
        raise RuntimeError("Generated tool contract resource contains an invalid row.")
    return rows


_ROWS = _load_rows()

TOOL_CONTRACTS: dict[str, ToolContract] = {contract.name: contract for contract in _ROWS}

if len(TOOL_CONTRACTS) != len(_ROWS):  # pragma: no cover - a duplicate name is a coding error
    raise RuntimeError("Tool contract names must be unique.")

# The signed network capability is required for exactly the rows that declare it.
# Deriving the set removes the separate frozenset that used to drift from the host.
DATABASE_NETWORK_TOOLS: frozenset[str] = frozenset(
    contract.name for contract in _ROWS if contract.network and contract.access == "grant-network" and contract.effect == "read"
)
NETWORK_TOOLS: frozenset[str] = frozenset(contract.name for contract in _ROWS if contract.network)


def contract_for(name: str) -> ToolContract:
    """Return the contract for a tool name, refusing to guess for unknown names."""
    contract = TOOL_CONTRACTS.get(name)
    if contract is None:
        raise UnknownCapabilityError(f"{name} has no registered tool contract.")
    return contract


def tool_effect(name: str) -> ToolEffect:
    return contract_for(name).effect


def export_contracts() -> dict[str, Any]:
    """Machine-readable table for the host's cross-language contract check."""
    return {
        "schema_version": CONTRACT_SCHEMA_VERSION,
        "tools": [
            {
                "name": contract.name,
                "effect": contract.effect,
                "network": contract.network,
                "access": contract.access,
                "capability_id": contract.capability_id,
                "preconditions": list(contract.preconditions),
                "produces": list(contract.produces),
                "idempotent": contract.idempotent,
                "cost_class": contract.cost_class,
                "max_calls_per_run": contract.max_calls_per_run,
            }
            for contract in _ROWS
        ],
    }


def verify_tool_contracts(declared_names: list[str], handler_names: list[str]) -> None:
    """Fail when the advertised schemas, the dispatch table and this table disagree.

    A tool that can be called but carries no contract would fall back to a guessed
    effect, which is exactly the drift this table exists to prevent, so the
    mismatch is raised rather than logged.
    """
    contracts = set(TOOL_CONTRACTS)
    declared, handlers = set(declared_names), set(handler_names)
    problems: list[str] = []
    for label, names in (("advertised schemas", declared), ("dispatch handlers", handlers)):
        if missing := sorted(names - contracts):
            problems.append(f"{label} without a contract row: {', '.join(missing)}")
        if extra := sorted(contracts - names):
            problems.append(f"contract rows with no {label}: {', '.join(extra)}")
    if len(declared_names) != len(declared) or len(handler_names) != len(handlers):
        problems.append("tool names must be unique")
    if problems:
        raise UnknownCapabilityError("; ".join(problems))
