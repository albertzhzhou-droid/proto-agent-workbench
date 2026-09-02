from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .execution import ExecutionBroker, ExecutionDenied, public_execution_command
from .security import (
    MAX_NOTEBOOK_FILE_BYTES,
    SecurityBoundaryError,
    WorkspacePaths,
    list_regular_files_bounded,
    read_json_bounded,
    write_text_bounded,
)


DEFAULT_NOTEBOOK_OUT_DIR = Path("build") / "notebooks"
MAX_NOTEBOOK_CELLS = 256
MAX_NOTEBOOK_CODE_CELLS = 128
MAX_NOTEBOOK_CELL_BYTES = 256 * 1024
MAX_NOTEBOOK_CODE_BYTES = 1024 * 1024


def run_notebook(
    notebook_path: str | Path,
    out_dir: str | Path = DEFAULT_NOTEBOOK_OUT_DIR,
    timeout: int = 120,
    *,
    broker: ExecutionBroker | None = None,
    workspace_root: str | Path | None = None,
    cancel_event: threading.Event | None = None,
) -> tuple[dict[str, Any], int]:
    try:
        paths = WorkspacePaths.create(workspace_root)
        notebook = paths.workspace_file(
            notebook_path,
            extensions={".ipynb"},
            max_bytes=MAX_NOTEBOOK_FILE_BYTES,
        )
        raw = read_json_bounded(notebook, MAX_NOTEBOOK_FILE_BYTES)
        code_cells = _validated_code_cells(raw)
        active_broker = broker or ExecutionBroker.from_environment(caller="library")
        active_broker.require_available()
        run_id = _run_id(notebook)
        run_dir = paths.run_directory(out_dir, run_id)
        script_path = run_dir / "notebook_cells.py"
        write_text_bounded(script_path, _script_from_cells(code_cells), boundary=paths.build)
        started_at = datetime.now(timezone.utc)
        result = active_broker.execute(
            runtime="python",
            script=script_path,
            args=(),
            workspace=paths.workspace,
            run_dir=run_dir,
            timeout=timeout,
            cancel_event=cancel_event,
        )
        finished_at = datetime.now(timezone.utc)
    except (SecurityBoundaryError, ExecutionDenied) as exc:
        return _failed_manifest(
            notebook_path,
            getattr(exc, "code", "EXECUTION_DENIED"),
            str(exc),
        )

    stdout_path = run_dir / "stdout.txt"
    stderr_path = run_dir / "stderr.txt"
    write_text_bounded(stdout_path, result.stdout, boundary=paths.build)
    write_text_bounded(stderr_path, result.stderr, boundary=paths.build)
    artifacts = [
        Path(path).relative_to(paths.workspace).as_posix()
        for path in list_regular_files_bounded(run_dir, exclude={"manifest.json"})
    ]
    manifest = {
        "schema_version": "proto-agent.notebook-run.v1",
        "ok": result.returncode == 0 and not result.timed_out and not result.cancelled,
        "run_id": run_id,
        "notebook": notebook.relative_to(paths.workspace).as_posix(),
        "code_cell_count": len(code_cells),
        "provider": result.provider,
        "sandboxed": result.provider in {"docker", "podman"},
        "command": public_execution_command(result.command, workspace=paths.workspace, run_dir=run_dir),
        "started_at": started_at.isoformat(),
        "finished_at": finished_at.isoformat(),
        "timeout_seconds": timeout,
        "timed_out": result.timed_out,
        "output_truncated": result.output_truncated,
        "resource_limit_exceeded": result.resource_limit_exceeded,
        "cancelled": result.cancelled,
        "returncode": result.returncode,
        "run_dir": run_dir.relative_to(paths.workspace).as_posix(),
        "artifacts": artifacts,
        "stdout_path": stdout_path.relative_to(paths.workspace).as_posix(),
        "stderr_path": stderr_path.relative_to(paths.workspace).as_posix(),
        "summary": "Notebook completed successfully." if result.returncode == 0 and not result.timed_out else "Notebook did not complete successfully.",
    }
    manifest_path = run_dir / "manifest.json"
    manifest["manifest_path"] = manifest_path.relative_to(paths.workspace).as_posix()
    write_text_bounded(
        manifest_path,
        json.dumps(manifest, indent=2) + "\n",
        boundary=paths.build,
    )
    return manifest, 0 if manifest["ok"] else 1


def _validated_code_cells(raw: Any) -> list[str]:
    if not isinstance(raw, dict):
        raise SecurityBoundaryError("INVALID_NOTEBOOK", "Notebook JSON root must be an object.")
    cells = raw.get("cells")
    if not isinstance(cells, list):
        raise SecurityBoundaryError("INVALID_NOTEBOOK", "Notebook cells must be an array.")
    if len(cells) > MAX_NOTEBOOK_CELLS:
        raise SecurityBoundaryError(
            "NOTEBOOK_CELL_LIMIT",
            f"Notebook exceeds the {MAX_NOTEBOOK_CELLS}-cell limit.",
        )
    code_cells: list[str] = []
    total_code_bytes = 0
    for index, cell in enumerate(cells):
        if not isinstance(cell, dict):
            raise SecurityBoundaryError("INVALID_NOTEBOOK", f"Notebook cell {index} must be an object.")
        if cell.get("cell_type") != "code":
            continue
        source = cell.get("source", [])
        if isinstance(source, str):
            text = source
        elif isinstance(source, list) and all(isinstance(item, str) for item in source):
            if len(source) > 16_384:
                raise SecurityBoundaryError("NOTEBOOK_SOURCE_ARRAY_LIMIT", f"Notebook cell {index} has too many source fragments.")
            text = "".join(source)
        else:
            raise SecurityBoundaryError("INVALID_NOTEBOOK", f"Notebook cell {index} source must be a string or string array.")
        cell_bytes = len(text.encode("utf-8"))
        if cell_bytes > MAX_NOTEBOOK_CELL_BYTES:
            raise SecurityBoundaryError(
                "NOTEBOOK_CELL_TOO_LARGE",
                f"Notebook code cell {index} exceeds the {MAX_NOTEBOOK_CELL_BYTES}-byte limit.",
            )
        total_code_bytes += cell_bytes
        if total_code_bytes > MAX_NOTEBOOK_CODE_BYTES:
            raise SecurityBoundaryError(
                "NOTEBOOK_CODE_TOO_LARGE",
                f"Notebook code exceeds the {MAX_NOTEBOOK_CODE_BYTES}-byte aggregate limit.",
            )
        code_cells.append(text)
        if len(code_cells) > MAX_NOTEBOOK_CODE_CELLS:
            raise SecurityBoundaryError(
                "NOTEBOOK_CODE_CELL_LIMIT",
                f"Notebook exceeds the {MAX_NOTEBOOK_CODE_CELLS}-code-cell limit.",
            )
    return code_cells


def _run_id(notebook: Path) -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    return f"{notebook.stem}-{timestamp}"


def _script_from_cells(cells: list[str]) -> str:
    chunks = [
        "from __future__ import annotations",
        "",
        "# Generated from notebook code cells by proto-agent.",
    ]
    for index, cell in enumerate(cells, start=1):
        chunks.extend(["", f"# %% notebook cell {index}", cell])
    return "\n".join(chunks) + "\n"


def _failed_manifest(notebook_path: str | Path, code: str, message: str) -> tuple[dict[str, Any], int]:
    return {
        "schema_version": "proto-agent.notebook-run.v1",
        "ok": False,
        "notebook": str(notebook_path),
        "diagnostics": [
            {
                "severity": "error",
                "file": str(notebook_path),
                "line": 0,
                "code": code,
                "message": message,
            }
        ],
        "summary": message,
        "artifacts": [],
    }, 1
