"""Completeness and integrity checks for the external materials catalogue.

The authoritative record normalization and snapshot writer live in
``proto_agent.materials``.  This module is intentionally small so installers,
CI, and management UI code have one stable integrity entry point.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..materials import MaterialsError, MaterialsStore, normalize_record


def check_material_record(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalize one untrusted record or raise a typed fail-closed error."""

    return normalize_record(raw)


def verify_materials_snapshot(root: str | Path, snapshot_id: str, *, workspace: str | Path | None = None) -> dict[str, Any]:
    """Verify manifest/catalog/quarantine digests and return a bounded report."""

    root = Path(root).absolute()
    if workspace is not None:
        workspace_path = Path(workspace).absolute()
    else:
        candidate = root.parent / "Proto CLI"
        workspace_path = candidate if candidate.is_dir() else root.parent
    store = MaterialsStore(workspace=workspace_path, root=root)
    manifest = store.manifest(snapshot_id)
    store._verify_snapshot(snapshot_id, manifest)
    status_counts = manifest.get("status_counts", {})
    return {
        "ok": True,
        "snapshot_id": snapshot_id,
        "record_count": int(manifest.get("record_count", 0)),
        "catalog_record_count": int(manifest.get("catalog_record_count", 0)),
        "quarantine_record_count": int(manifest.get("quarantine_record_count", 0)),
        "status_counts": status_counts,
        "complete_for_v1": int(manifest.get("record_count", 0)) >= 100_000,
        "notice": "Completeness is an indexing count, not a claim that every record is design-eligible or scientifically validated.",
    }


__all__ = ["check_material_record", "verify_materials_snapshot"]
