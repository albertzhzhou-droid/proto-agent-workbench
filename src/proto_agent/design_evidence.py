"""Receipt standing derived from the exact parts library used by a design."""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any
from .evidence_standing import evidence_standing, library_data_origin
from .json_validation import strict_json_loads
from .security import MAX_JSON_FILE_BYTES, WorkspacePaths, read_bytes_bounded


def library_standing(payload: bytes, *, ok: bool, workspace: Path | None = None) -> dict:
    metadata = strict_json_loads(payload.decode("utf-8"), max_bytes=MAX_JSON_FILE_BYTES)
    standing = evidence_standing(method_maturity="not-established", data_origin=library_data_origin(metadata),
                                 execution_status="completed" if ok else "error")
    if workspace is not None:
        # Reuse the review gate: metadata labels alone never grant eligibility.
        from .review import _is_governed_materialized_parts_library
        if _is_governed_materialized_parts_library(payload, workspace=workspace):
            standing.update(dataOrigin="governed-snapshot", eligibility="DESIGN_ELIGIBLE")
    return standing


def checked_library_standing(path: Path, before: bytes, *, ok: bool, workspace: Path) -> dict:
    if read_bytes_bounded(path, MAX_JSON_FILE_BYTES) != before:
        raise ValueError("Parts library changed while checking the design; retry with stable input.")
    return library_standing(before, ok=ok, workspace=workspace)


def export_standing(ir: dict[str, Any], *, workspace: Path) -> dict:
    """Recheck a compiled library/source binding; arbitrary IR labels confer nothing.

Legacy IR can still export, with unknown origin. Sources that are unavailable,
changed or unbound cannot re-establish their old eligibility from IR metadata.
    """
    unknown = evidence_standing(method_maturity="not-established", execution_status="completed")
    provenance = ir.get("provenance", {})
    if not all(isinstance(provenance.get(key), str) for key in ("source", "parts_source", "parts_sha256")):
        return unknown
    try:
        from .compiler import compile_design
        paths = WorkspacePaths.create(workspace)
        parts = paths.workspace_file(provenance["parts_source"], extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
        source = paths.workspace_file(provenance["source"], extensions={".proto"})
        payload = read_bytes_bounded(parts, MAX_JSON_FILE_BYTES)
        if hashlib.sha256(payload).hexdigest() != provenance["parts_sha256"]:
            return unknown
        compiled, _ = compile_design(source, parts, workspace_root=workspace)
        if compiled is None or any(compiled.get(key) != ir.get(key) for key in
            ("schema_version", "domain", "design_id", "chassis", "constructs", "constraints")):
            return unknown
        if read_bytes_bounded(parts, MAX_JSON_FILE_BYTES) != payload:
            return unknown
        return library_standing(payload, ok=True, workspace=workspace)
    except (ValueError, OSError):
        return unknown
