"""Portable frozen complex-molecule test bytes, independent of build artifacts.

Historical paths inside the spec remain provenance data. Tests resolve them
through this explicit fixture inventory, or materialize them under their own
temporary repository root. No native runtime is imported or called.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path, PurePosixPath
from typing import Any

FIXTURES = Path(__file__).parent / "fixtures/refinement_evidence_product"


def fixture_manifest() -> dict[str, Any]:
    value: dict[str, Any] = json.loads((FIXTURES / "manifest.json").read_bytes())
    return value


def read_bound_artifact(reference: dict[str, Any]) -> bytes:
    manifest = fixture_manifest()
    path = manifest["spec_artifacts"][reference["path"]]
    if not isinstance(path, str):
        raise ValueError("Fixture path must be a string")
    raw = (FIXTURES / path).read_bytes()
    if hashlib.sha256(raw).hexdigest() != reference["sha256"]:
        raise ValueError("Frozen spec fixture hash mismatch")
    return raw


def materialize_bound_artifacts(root: Path) -> None:
    """Create only the five declared fixture artifacts under a fresh test root."""
    manifest = fixture_manifest()
    for relative, fixture_path in manifest["spec_artifacts"].items():
        parsed = PurePosixPath(relative)
        if parsed.is_absolute() or ".." in parsed.parts or ":" in relative or "\\" in relative:
            raise ValueError("Invalid fixture-relative path")
        item = next(item for item in manifest["files"] if item["fixture_path"] == fixture_path)
        raw = read_bound_artifact({"path": relative, "sha256": item["sha256"]})
        destination = root.joinpath(*parsed.parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open("xb") as stream:
            stream.write(raw)
