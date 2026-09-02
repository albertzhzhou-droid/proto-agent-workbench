from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .execution import ExecutionBroker, ExecutionDenied, public_execution_command
from .security import (
    MAX_TEXT_FILE_BYTES,
    SecurityBoundaryError,
    WorkspacePaths,
    list_regular_files_bounded,
    write_text_bounded,
)


DEFAULT_ANALYSIS_OUT_DIR = Path("build") / "analysis"


def run_python_analysis(
    script_path: str | Path,
    script_args: list[str] | None = None,
    out_dir: str | Path = DEFAULT_ANALYSIS_OUT_DIR,
    timeout: int = 60,
    *,
    broker: ExecutionBroker | None = None,
    workspace_root: str | Path | None = None,
    cancel_event: threading.Event | None = None,
) -> tuple[dict[str, Any], int]:
    args = script_args or []
    try:
        paths = WorkspacePaths.create(workspace_root)
        script = paths.workspace_file(script_path, extensions={".py"}, max_bytes=MAX_TEXT_FILE_BYTES)
        active_broker = broker or ExecutionBroker.from_environment(caller="library")
        active_broker.require_available()
        run_id = _run_id(script)
        run_dir = paths.run_directory(out_dir, run_id)
        started_at = datetime.now(timezone.utc)
        result = active_broker.execute(
            runtime="python",
            script=script,
            args=args,
            workspace=paths.workspace,
            run_dir=run_dir,
            timeout=timeout,
            cancel_event=cancel_event,
        )
        finished_at = datetime.now(timezone.utc)
    except (SecurityBoundaryError, ExecutionDenied) as exc:
        return _failed_manifest(
            script_path,
            args,
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
        "schema_version": "proto-agent.analysis-run.v1",
        "ok": result.returncode == 0 and not result.timed_out and not result.cancelled,
        "run_id": run_id,
        "script": script.relative_to(paths.workspace).as_posix(),
        "args": args,
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
        "summary": "Analysis completed successfully." if result.returncode == 0 and not result.timed_out else "Analysis did not complete successfully.",
    }
    manifest_path = run_dir / "manifest.json"
    manifest["manifest_path"] = manifest_path.relative_to(paths.workspace).as_posix()
    write_text_bounded(
        manifest_path,
        json.dumps(manifest, indent=2) + "\n",
        boundary=paths.build,
    )
    return manifest, 0 if manifest["ok"] else 1


def _run_id(script: Path) -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    return f"{script.stem}-{timestamp}"


def _failed_manifest(script_path: str | Path, args: list[str], code: str, message: str) -> tuple[dict[str, Any], int]:
    return {
        "schema_version": "proto-agent.analysis-run.v1",
        "ok": False,
        "script": str(script_path),
        "args": args,
        "diagnostics": [
            {
                "severity": "error",
                "file": str(script_path),
                "line": 0,
                "code": code,
                "message": message,
            }
        ],
        "summary": message,
        "artifacts": [],
    }, 1
