from __future__ import annotations

import json
import shutil
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


DEFAULT_R_OUT_DIR = Path("build") / "r"


def _r_status_snapshot(active_broker: ExecutionBroker) -> dict[str, Any]:
    rscript = shutil.which("Rscript")
    sandbox = active_broker.status()
    return {
        "ok": True,
        "runtime": "Rscript",
        "available": rscript is not None,
        "host_available": rscript is not None,
        "executable": Path(rscript).name if rscript else None,
        "sandbox": sandbox,
        "summary": "Rscript runtime is available." if rscript else "Rscript runtime was not found on PATH; a configured OCI image may still provide R.",
    }


def r_status(*, broker: ExecutionBroker | None = None, workspace_root: str | Path | None = None,
             cancel_event: threading.Event | None = None) -> dict[str, Any]:
    active_broker = broker or ExecutionBroker.from_environment(caller="library", workspace_root=workspace_root)
    status = _r_status_snapshot(active_broker)
    status["checked_at"] = datetime.now(timezone.utc).isoformat()
    if status["sandbox"]["mode"] != "oci":
        return status
    status.update({"available": False, "execution_target": "oci", "smoke_verified": False})
    try:
        paths = WorkspacePaths.create(workspace_root)
        run_dir = paths.run_directory("build/runtime-status", "r-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ"))
        script = run_dir / "r_status.r"
        write_text_bounded(script, "cat(R.version.string, '\\n')\n", boundary=paths.build)
        result = active_broker.execute(runtime="r", script=script, args=(), workspace=paths.workspace,
                                      run_dir=run_dir, timeout=20, cancel_event=cancel_event)
        available = result.returncode == 0 and not result.timed_out and not result.cancelled
        status.update({"available": available, "smoke_verified": available,
                       "provider": result.provider, "version": result.stdout.strip() if available else None,
                       "summary": "Rscript is available in the configured OCI sandbox." if available else "The configured sandbox Rscript probe failed.",
                       "probe_returncode": result.returncode, "probe_stderr": result.stderr[:4000]})
        receipt = run_dir / "status.json"
        status["manifest_path"] = receipt.relative_to(paths.workspace).as_posix()
        write_text_bounded(receipt, json.dumps(status, indent=2) + "\n", boundary=paths.build)
    except (SecurityBoundaryError, ExecutionDenied) as exc:
        status.update({"summary": str(exc), "diagnostics": [{"code": exc.code, "message": str(exc)}]})
    return status


def run_r_script(
    script_path: str | Path,
    script_args: list[str] | None = None,
    out_dir: str | Path = DEFAULT_R_OUT_DIR,
    timeout: int = 120,
    *,
    broker: ExecutionBroker | None = None,
    workspace_root: str | Path | None = None,
    cancel_event: threading.Event | None = None,
) -> tuple[dict[str, Any], int]:
    args = script_args or []
    active_broker = broker or ExecutionBroker.from_environment(caller="library", workspace_root=workspace_root)
    status = _r_status_snapshot(active_broker)
    host_rscript = shutil.which("Rscript")
    try:
        paths = WorkspacePaths.create(workspace_root)
        script = paths.workspace_file(script_path, extensions={".r"}, max_bytes=MAX_TEXT_FILE_BYTES)
        active_broker.require_available()
        run_id = _run_id(script)
        run_dir = paths.run_directory(out_dir, run_id)
        started_at = datetime.now(timezone.utc)
        result = active_broker.execute(
            runtime="r",
            script=script,
            args=args,
            workspace=paths.workspace,
            run_dir=run_dir,
            timeout=timeout,
            host_executable=host_rscript,
            cancel_event=cancel_event,
        )
        finished_at = datetime.now(timezone.utc)
        if result.returncode == 0 and not result.timed_out and not result.cancelled:
            status.update({"available": True, "execution_target": result.provider,
                           "summary": "Rscript completed in the configured execution environment.", "smoke_verified": True})
    except (SecurityBoundaryError, ExecutionDenied) as exc:
        return _failed_manifest(
            script_path,
            args,
            status,
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
        "schema_version": "proto-agent.r-run.v1",
        "ok": result.returncode == 0 and not result.timed_out and not result.cancelled,
        "runtime": status,
        "run_id": run_id,
        "script": script.relative_to(paths.workspace).as_posix(),
        "args": args,
        "provider": result.provider,
        "sandboxed": result.provider in {"docker", "podman", "docker-wsl"},
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
        "summary": "R script completed successfully." if result.returncode == 0 and not result.timed_out else "R script did not complete successfully.",
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


def _failed_manifest(
    script_path: str | Path,
    args: list[str],
    status: dict[str, Any],
    code: str,
    message: str,
) -> tuple[dict[str, Any], int]:
    return {
        "schema_version": "proto-agent.r-run.v1",
        "ok": False,
        "runtime": status,
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
