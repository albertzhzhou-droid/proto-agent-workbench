"""Shared version routing. This is not domain, integrity or trust validation."""
from __future__ import annotations

from functools import lru_cache
from importlib.resources import files
import json
from typing import Any


@lru_cache(maxsize=1)
def reader_catalog() -> dict[str, Any]:
    return json.loads(files("proto_agent").joinpath("data/artifact-readers.json").read_text(encoding="utf-8"))


def select_artifact_reader(family: str, artifact: Any) -> dict[str, Any]:
    entry = next((row for row in reader_catalog()["families"] if family in (row["family"], row.get("alias"))), None)
    version = artifact.get(entry["versionField"] if entry else "schema_version") if isinstance(artifact, dict) else None
    if not isinstance(version, str):
        version = None
    status = "current" if entry and version in entry["current"] else "legacy-readonly" if entry and version in entry["legacy"] else "unsupported-version"
    code = {"current": "CURRENT_VERSION", "legacy-readonly": "LEGACY_READ_ONLY", "unsupported-version": "UNSUPPORTED_VERSION"}[status]
    return {"family": family, "schemaVersion": version, "status": status, "code": code, "readOnly": status != "current"}


def require_current_artifact(family: str, artifact: Any) -> None:
    reader = select_artifact_reader(family, artifact)
    if reader["readOnly"]:
        raise ValueError(f"{reader['code']}: {family} schema_version {reader['schemaVersion']!r} is retained for read-only inspection; execution and linking are disabled.")
