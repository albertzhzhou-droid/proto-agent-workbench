from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .security import MAX_JSON_FILE_BYTES, WorkspacePaths, read_json_bounded

DEFAULT_CONNECTORS_PATH = Path("connectors") / "proto_workbench.json"
CONNECTOR_SCHEMA_VERSION = "proto-agent.connectors.v1"

_REGISTRY_FIELDS = {"schema_version", "workbench", "description", "connectors"}
_CONNECTOR_FIELDS = {
    "id",
    "kind",
    "status",
    "purpose",
    "base_url",
    "http_routes",
    "governed_operations",
    "credential_environment",
    "safety_notes",
    "path",
    "commands",
    "tools",
    "external_root",
    "environment_override",
    "documentation",
    "artifacts",
}
_CONNECTOR_STATUSES = {
    "available",
    "planned",
    "local_configuration_required",
    "sandbox_required",
}
_CONNECTOR_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
_CONNECTOR_KIND = re.compile(r"[a-z][a-z0-9_]{0,63}")
_TOOL_NAME = re.compile(r"[a-z][a-z0-9_]{0,127}")
_ENVIRONMENT_NAME = re.compile(r"[A-Z][A-Z0-9_]{0,127}")
_GOVERNED_OPERATION = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
_HTTP_ROUTE = re.compile(r"(?:GET|POST) /(?:[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,255})")

_ARRAY_LIMITS = {
    "commands": (64, 256),
    "tools": (64, 128),
    "http_routes": (32, 261),
    "governed_operations": (32, 64),
    "credential_environment": (16, 128),
    "safety_notes": (32, 2_048),
    "artifacts": (64, 1_024),
}


def load_connector_registry(path: str | Path = DEFAULT_CONNECTORS_PATH) -> dict[str, Any]:
    payload = read_json_bounded(path, MAX_JSON_FILE_BYTES)
    if not isinstance(payload, dict):
        raise ValueError("Connector registry must be a JSON object.")
    _validate_connector_registry(payload)
    return payload


def _validate_connector_registry(payload: dict[str, Any]) -> None:
    unknown = sorted(set(payload) - _REGISTRY_FIELDS)
    if unknown:
        raise ValueError(f"Connector registry contains unsupported fields: {', '.join(unknown)}")
    if payload.get("schema_version") != CONNECTOR_SCHEMA_VERSION:
        raise ValueError(f"Connector registry must use {CONNECTOR_SCHEMA_VERSION}.")
    for field, maximum in (("workbench", 128), ("description", 2_048)):
        if field in payload:
            _bounded_text(payload[field], f"Connector registry {field}", maximum)
    connectors = payload.get("connectors")
    if not isinstance(connectors, list) or len(connectors) > 256:
        raise ValueError("Connector registry entries are malformed or exceed the limit.")
    seen_ids: set[str] = set()
    for index, connector in enumerate(connectors):
        if not isinstance(connector, dict):
            raise ValueError(f"Connector registry entry {index} must be an object.")
        _validate_connector(connector, index, seen_ids)


def _validate_connector(connector: dict[str, Any], index: int, seen_ids: set[str]) -> None:
    unknown = sorted(set(connector) - _CONNECTOR_FIELDS)
    if unknown:
        raise ValueError(f"Connector registry entry {index} contains unsupported fields: {', '.join(unknown)}")
    required = {"id", "kind", "status", "purpose", "safety_notes"}
    missing = sorted(required - connector.keys())
    if missing:
        raise ValueError(f"Connector registry entry {index} is missing: {', '.join(missing)}")
    connector_id = _bounded_text(connector["id"], f"Connector registry entry {index} id", 64)
    if not _CONNECTOR_ID.fullmatch(connector_id) or connector_id in seen_ids:
        raise ValueError(f"Connector registry entry {index} has an invalid or duplicate id.")
    seen_ids.add(connector_id)
    kind = _bounded_text(connector["kind"], f"Connector {connector_id} kind", 64)
    if not _CONNECTOR_KIND.fullmatch(kind):
        raise ValueError(f"Connector {connector_id} has an invalid kind.")
    status = _bounded_text(connector["status"], f"Connector {connector_id} status", 64)
    if status not in _CONNECTOR_STATUSES:
        raise ValueError(f"Connector {connector_id} has an unsupported status.")
    _bounded_text(connector["purpose"], f"Connector {connector_id} purpose", 1_024)

    for field, (maximum_items, maximum_length) in _ARRAY_LIMITS.items():
        if field not in connector:
            continue
        values = connector[field]
        if not isinstance(values, list) or not values or len(values) > maximum_items:
            raise ValueError(f"Connector {connector_id} {field} must be a bounded array.")
        normalized = [
            _bounded_text(item, f"Connector {connector_id} {field}", maximum_length)
            for item in values
        ]
        if len(set(normalized)) != len(normalized):
            raise ValueError(f"Connector {connector_id} {field} contains duplicate entries.")
        _validate_capability_values(connector_id, field, normalized)

    for field, maximum in (
        ("base_url", 2_048),
        ("path", 512),
        ("external_root", 512),
        ("documentation", 2_048),
    ):
        if field in connector:
            _bounded_text(connector[field], f"Connector {connector_id} {field}", maximum)
    if "environment_override" in connector:
        environment_name = _bounded_text(
            connector["environment_override"],
            f"Connector {connector_id} environment_override",
            128,
        )
        if not _ENVIRONMENT_NAME.fullmatch(environment_name):
            raise ValueError(f"Connector {connector_id} has an invalid environment_override.")


def _validate_capability_values(connector_id: str, field: str, values: list[str]) -> None:
    for value in values:
        if any(character in value for character in ("\x00", "\r", "\n")):
            raise ValueError(f"Connector {connector_id} {field} contains control-line characters.")
        if field == "tools" and not _TOOL_NAME.fullmatch(value):
            raise ValueError(f"Connector {connector_id} declares an invalid MCP tool.")
        if field == "http_routes" and (
            not _HTTP_ROUTE.fullmatch(value)
            or ".." in value
            or "?" in value
            or "#" in value
        ):
            raise ValueError(f"Connector {connector_id} declares an invalid HTTP route.")
        if field == "governed_operations" and not _GOVERNED_OPERATION.fullmatch(value):
            raise ValueError(f"Connector {connector_id} declares an invalid governed operation.")
        if field == "credential_environment" and not _ENVIRONMENT_NAME.fullmatch(value):
            raise ValueError(f"Connector {connector_id} declares an invalid credential environment name.")


def _bounded_text(value: Any, field: str, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"{field} must be a non-empty string of at most {maximum} characters.")
    return value.strip()


def connector_summary(
    path: str | Path = DEFAULT_CONNECTORS_PATH,
    *,
    workspace_root: str | Path | None = None,
) -> dict[str, Any]:
    workspace = WorkspacePaths.create(workspace_root)
    registry_path = workspace.workspace_file(
        path,
        extensions={".json"},
        max_bytes=MAX_JSON_FILE_BYTES,
    )
    registry = load_connector_registry(registry_path)
    connectors = registry["connectors"]
    counts: dict[str, int] = {}
    issues: list[dict[str, str]] = []
    for connector in connectors:
        status = connector["status"]
        counts[status] = counts.get(status, 0) + 1
        connector_path = connector.get("path")
        if status == "available" and connector_path:
            if not isinstance(connector_path, str) or len(connector_path) > 512:
                raise ValueError("Connector path must be a bounded relative string.")
            try:
                workspace.workspace_entry(connector_path)
            except (OSError, ValueError):
                issues.append(
                    {
                        "connector": connector.get("id", "<unknown>"),
                        "code": "CONNECTOR_PATH_NOT_FOUND",
                        "message": f"Declared connector path does not exist: {connector_path}",
                    }
                )
    return {
        "ok": not issues,
        "registry": registry_path.relative_to(workspace.workspace).as_posix(),
        "workbench": registry.get("workbench"),
        "connector_count": len(connectors),
        "status_counts": counts,
        "connectors": connectors,
        "issues": issues,
    }
