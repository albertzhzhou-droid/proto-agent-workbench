from __future__ import annotations

from pathlib import Path
from typing import Any

from .security import MAX_JSON_FILE_BYTES, WorkspacePaths, read_json_bounded

DEFAULT_CONNECTORS_PATH = Path("connectors") / "proto_workbench.json"


def load_connector_registry(path: str | Path = DEFAULT_CONNECTORS_PATH) -> dict[str, Any]:
    payload = read_json_bounded(path, MAX_JSON_FILE_BYTES)
    if not isinstance(payload, dict):
        raise ValueError("Connector registry must be a JSON object.")
    return payload


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
    connectors = registry.get("connectors", [])
    if not isinstance(connectors, list) or len(connectors) > 256 or not all(isinstance(item, dict) for item in connectors):
        raise ValueError("Connector registry entries are malformed or exceed the limit.")
    counts: dict[str, int] = {}
    issues: list[dict[str, str]] = []
    for connector in connectors:
        status = connector.get("status", "unknown")
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
