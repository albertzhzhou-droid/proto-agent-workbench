from __future__ import annotations

import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence
from uuid import uuid4

from .security import MAX_TEXT_FILE_BYTES, SecurityBoundaryError, WorkspacePaths


MAX_EXECUTION_ARGS = 64
MAX_EXECUTION_ARG_CHARS = 4096
MAX_EXECUTION_TIMEOUT_SECONDS = 600
MAX_CAPTURE_BYTES = 1024 * 1024
MAX_RUN_DIRECTORY_BYTES = 64 * 1024 * 1024
MAX_RUN_DIRECTORY_ENTRIES = 4096
OCI_PIDS_LIMIT = 64
OCI_MEMORY_LIMIT = "512m"
OCI_CPU_LIMIT = "1.0"

_DIGEST_IMAGE = re.compile(
    r"^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?@sha256:[0-9a-f]{64}$",
)


class ExecutionDenied(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class SandboxConfig:
    provider: str | None = None
    image: str | None = None
    unsafe_host: bool = False
    caller: str = "library"


@dataclass(frozen=True)
class ExecutionResult:
    provider: str
    command: tuple[str, ...]
    returncode: int
    stdout: str
    stderr: str
    timed_out: bool
    output_truncated: bool
    resource_limit_exceeded: bool
    cancelled: bool = False


class ExecutionBroker:
    """Fail-closed broker for untrusted workspace code.

    Container execution is available only when an OCI provider and a digest-pinned
    image are explicitly configured. Host execution is intentionally reachable
    only through the CLI-only constructor.
    """

    def __init__(self, config: SandboxConfig) -> None:
        if config.unsafe_host and config.caller != "cli":
            raise ExecutionDenied(
                "HOST_EXECUTION_CALLER_DENIED",
                "Unsafe host execution may only be enabled by the interactive CLI.",
            )
        self.config = config

    @classmethod
    def from_environment(
        cls,
        *,
        provider: str | None = None,
        image: str | None = None,
        caller: str = "library",
    ) -> "ExecutionBroker":
        return cls(
            SandboxConfig(
                provider=provider or os.environ.get("PROTO_AGENT_SANDBOX_PROVIDER"),
                image=image or os.environ.get("PROTO_AGENT_SANDBOX_IMAGE"),
                caller=caller,
            )
        )

    @classmethod
    def unsafe_host_for_cli(cls) -> "ExecutionBroker":
        return cls(SandboxConfig(unsafe_host=True, caller="cli"))

    def status(self) -> dict[str, object]:
        provider = (self.config.provider or "").lower()
        image = self.config.image or ""
        provider_valid = provider in {"docker", "podman"}
        image_pinned = is_digest_pinned_image(image)
        executable = shutil.which(provider) if provider_valid else None
        configured = bool(provider and image)
        provider_visible = executable is not None
        if self.config.unsafe_host:
            mode = "unsafe-host"
            available = True
            reason = "Host execution was explicitly enabled for this CLI invocation only."
        elif provider_valid and image_pinned and executable:
            mode = "oci"
            available = True
            reason = "Digest-pinned OCI sandbox is configured and the provider executable is visible; no sandbox smoke test has run."
        else:
            mode = "disabled"
            available = False
            if not provider and not image:
                reason = "Execution is disabled by default; no OCI sandbox is configured."
            elif not provider_valid:
                reason = "Sandbox provider must be docker or podman."
            elif not image_pinned:
                reason = "Sandbox image must be pinned as name@sha256:<64 lowercase hex characters>."
            else:
                reason = f"Configured OCI provider is not available on PATH: {provider}"
        return {
            "ok": True,
            "mode": mode,
            "available": available,
            "configured": configured,
            "provider_visible": provider_visible,
            "smoke_verified": False,
            "provider": provider or None,
            "provider_executable": Path(executable).name if executable else None,
            "image": image or None,
            "image_digest_pinned": image_pinned,
            "caller": self.config.caller,
            "network": "none" if mode == "oci" else None,
            "workspace_mount": "read-only" if mode == "oci" else None,
            "run_directory_mount": "read-write" if mode == "oci" else None,
            "pids_limit": OCI_PIDS_LIMIT if mode in {"oci", "unsafe-host"} else None,
            "memory_limit": OCI_MEMORY_LIMIT if mode in {"oci", "unsafe-host"} else None,
            "cpu_limit": OCI_CPU_LIMIT if mode in {"oci", "unsafe-host"} else None,
            "pull_policy": "never" if mode == "oci" else None,
            "process_tree_control": (
                "windows-job-kill-on-close"
                if mode == "unsafe-host" and os.name == "nt"
                else "posix-session-and-rlimits"
                if mode == "unsafe-host"
                else "provider-plus-container-name"
                if mode == "oci"
                else None
            ),
            "reason": reason,
        }

    def require_available(self) -> None:
        status = self.status()
        if not status["available"]:
            raise ExecutionDenied("EXECUTION_DISABLED", str(status["reason"]))

    def execute(
        self,
        *,
        runtime: str,
        script: Path,
        args: Sequence[str],
        workspace: Path,
        run_dir: Path,
        timeout: int,
        host_executable: str | None = None,
        cancel_event: threading.Event | None = None,
    ) -> ExecutionResult:
        normalized_args = validate_execution_args(args)
        if not 1 <= timeout <= MAX_EXECUTION_TIMEOUT_SECONDS:
            raise ExecutionDenied(
                "INVALID_TIMEOUT",
                f"Execution timeout must be between 1 and {MAX_EXECUTION_TIMEOUT_SECONDS} seconds.",
            )
        try:
            paths = WorkspacePaths.create(workspace)
            workspace = paths.workspace
            run_relative = run_dir.resolve(strict=True).relative_to(workspace)
            run_dir = paths.build_directory(run_relative)
            script_relative = script.resolve(strict=True).relative_to(workspace)
            script = paths.workspace_file(
                script_relative,
                extensions={".py"} if runtime == "python" else {".r"} if runtime == "r" else set(),
                max_bytes=MAX_TEXT_FILE_BYTES,
            )
        except (SecurityBoundaryError, OSError, ValueError) as exc:
            raise ExecutionDenied("EXECUTION_PATH_DENIED", f"Execution paths are outside the secured workspace/build boundary: {exc}") from exc

        if self.config.unsafe_host:
            command = build_host_argv(runtime, script, normalized_args, host_executable)
            return _run_bounded(
                command,
                cwd=workspace,
                env=minimal_execution_environment(workspace, run_dir, executable=command[0]),
                timeout=timeout,
                provider="unsafe-host",
                output_dir=run_dir,
                cancel_event=cancel_event,
            )

        status = self.status()
        if status["mode"] != "oci" or not status["available"]:
            raise ExecutionDenied("EXECUTION_DISABLED", str(status["reason"]))
        provider = str(status["provider"])
        executable_path = shutil.which(provider)
        if executable_path is None:
            raise ExecutionDenied("EXECUTION_DISABLED", f"Configured OCI provider is not available: {provider}")
        executable = executable_path
        image = str(status["image"])
        container_name = f"proto-agent-{uuid4().hex}"
        container_user = oci_non_root_user()
        _prepare_oci_run_directory(run_dir, container_user)
        command = build_oci_argv(
            executable=executable,
            provider=provider,
            image=image,
            runtime=runtime,
            script=script,
            args=normalized_args,
            workspace=workspace,
            run_dir=run_dir,
            container_name=container_name,
            container_user=container_user,
        )
        return _run_bounded(
            command,
            cwd=workspace,
            env=minimal_provider_environment(),
            timeout=timeout,
            provider=provider,
            cleanup=(executable, container_name),
            output_dir=run_dir,
            cancel_event=cancel_event,
        )


def is_digest_pinned_image(image: str | None) -> bool:
    return bool(image and _DIGEST_IMAGE.fullmatch(image))


def oci_non_root_user() -> str:
    if os.name != "nt" and hasattr(os, "getuid") and hasattr(os, "getgid"):
        uid = os.getuid()
        gid = os.getgid()
        if uid > 0 and gid > 0:
            return f"{uid}:{gid}"
    return "65532:65532"


def validate_execution_args(args: Sequence[str]) -> tuple[str, ...]:
    if len(args) > MAX_EXECUTION_ARGS:
        raise ExecutionDenied("TOO_MANY_ARGUMENTS", f"At most {MAX_EXECUTION_ARGS} execution arguments are allowed.")
    normalized: list[str] = []
    for value in args:
        if not isinstance(value, str):
            raise ExecutionDenied("INVALID_ARGUMENT", "Execution arguments must be strings.")
        if "\x00" in value or len(value) > MAX_EXECUTION_ARG_CHARS:
            raise ExecutionDenied(
                "INVALID_ARGUMENT",
                f"Execution arguments must not contain NUL and may contain at most {MAX_EXECUTION_ARG_CHARS} characters.",
            )
        normalized.append(value)
    return tuple(normalized)


def public_execution_command(
    command: Sequence[str],
    *,
    workspace: Path,
    run_dir: Path,
) -> list[str]:
    """Return an auditable argv shape without publishing host-absolute roots."""

    replacements = (
        (str(run_dir), "<run>"),
        (str(run_dir).replace("\\", "/"), "<run>"),
        (str(workspace), "<workspace>"),
        (str(workspace).replace("\\", "/"), "<workspace>"),
    )
    public: list[str] = []
    for index, raw in enumerate(command):
        value = str(raw)
        for private, marker in replacements:
            value = value.replace(private, marker)
        if index == 0 and Path(value).is_absolute():
            value = Path(value).name
        public.append(value)
    return public


def build_host_argv(
    runtime: str,
    script: Path,
    args: Sequence[str],
    host_executable: str | None = None,
) -> list[str]:
    if runtime == "python":
        return [host_executable or sys.executable, "-I", "-B", str(script), *args]
    if runtime == "r":
        if not host_executable:
            raise ExecutionDenied("RSCRIPT_NOT_FOUND", "Rscript is not available on PATH.")
        return [host_executable, "--vanilla", str(script), *args]
    raise ExecutionDenied("UNSUPPORTED_RUNTIME", f"Unsupported execution runtime: {runtime}")


def build_oci_argv(
    *,
    executable: str,
    provider: str,
    image: str,
    runtime: str,
    script: Path,
    args: Sequence[str],
    workspace: Path,
    run_dir: Path,
    container_name: str,
    container_user: str | None = None,
) -> list[str]:
    if provider not in {"docker", "podman"}:
        raise ExecutionDenied("INVALID_PROVIDER", "OCI provider must be docker or podman.")
    if not is_digest_pinned_image(image):
        raise ExecutionDenied("UNPINNED_IMAGE", "OCI image must be pinned by sha256 digest.")
    if not re.fullmatch(r"proto-agent-[0-9a-f]{8,64}", container_name):
        raise ExecutionDenied("INVALID_CONTAINER_NAME", "Invalid generated container name.")
    container_user = container_user or oci_non_root_user()
    if not re.fullmatch(r"[1-9][0-9]*:[1-9][0-9]*", container_user):
        raise ExecutionDenied("INVALID_CONTAINER_USER", "OCI execution requires an explicit non-root numeric uid:gid.")
    workspace = workspace.resolve(strict=True)
    run_dir = run_dir.resolve(strict=True)
    script = script.resolve(strict=True)
    if "," in str(workspace) or "," in str(run_dir):
        raise ExecutionDenied("UNSAFE_MOUNT_PATH", "OCI mount source paths may not contain commas.")
    try:
        script_in_workspace = script.relative_to(workspace)
        container_script = Path("/workspace") / script_in_workspace
    except ValueError:
        try:
            script_in_run = script.relative_to(run_dir)
            container_script = Path("/run") / script_in_run
        except ValueError as exc:
            raise ExecutionDenied("SCRIPT_OUTSIDE_MOUNTS", "Script must be inside the workspace or isolated run directory.") from exc

    runtime_argv = (
        ["python", "-I", "-B", container_script.as_posix(), *args]
        if runtime == "python"
        else ["Rscript", "--vanilla", container_script.as_posix(), *args]
        if runtime == "r"
        else None
    )
    if runtime_argv is None:
        raise ExecutionDenied("UNSUPPORTED_RUNTIME", f"Unsupported execution runtime: {runtime}")

    return [
        executable,
        "run",
        "--rm",
        "--name",
        container_name,
        "--user",
        container_user,
        "--pull",
        "never",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges=true",
        "--pids-limit",
        str(OCI_PIDS_LIMIT),
        "--memory",
        OCI_MEMORY_LIMIT,
        "--cpus",
        OCI_CPU_LIMIT,
        "--mount",
        f"type=bind,src={workspace},dst=/workspace,readonly",
        "--mount",
        f"type=bind,src={run_dir},dst=/run",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",
        "--workdir",
        "/workspace",
        "--env",
        "PROTO_AGENT_WORKSPACE=/workspace",
        "--env",
        "PROTO_AGENT_RUN_DIR=/run",
        image,
        *runtime_argv,
    ]


def minimal_execution_environment(
    workspace: Path,
    run_dir: Path,
    *,
    executable: str | Path | None = None,
) -> dict[str, str]:
    environment = _base_environment(include_path=True, executable=executable)
    environment.update(
        {
            "PROTO_AGENT_WORKSPACE": str(workspace),
            "PROTO_AGENT_RUN_DIR": str(run_dir),
            "PYTHONNOUSERSITE": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONHASHSEED": "0",
            "TMP": str(run_dir),
            "TEMP": str(run_dir),
        }
    )
    return environment


def minimal_provider_environment() -> dict[str, str]:
    return _base_environment(include_path=False)


def _base_environment(*, include_path: bool, executable: str | Path | None = None) -> dict[str, str]:
    environment: dict[str, str] = {}
    language = os.environ.get("LANG")
    if language and len(language) <= 128 and "\x00" not in language:
        environment["LANG"] = language
    if os.name == "nt":
        windows_directory = str(_windows_directory())
        environment["SystemRoot"] = windows_directory
        environment["WINDIR"] = windows_directory
    if include_path:
        executable_directory = str(Path(executable or sys.executable).resolve().parent)
        if os.name == "nt":
            system_root = _windows_directory()
            environment["PATH"] = os.pathsep.join((executable_directory, str(system_root / "System32")))
            environment["PATHEXT"] = ".COM;.EXE;.BAT;.CMD"
        else:
            environment["PATH"] = executable_directory
    return environment


def _windows_directory() -> Path:
    if os.name != "nt":
        raise ExecutionDenied("WINDOWS_DIRECTORY_UNAVAILABLE", "Windows directory lookup is available only on Windows.")
    import ctypes

    buffer = ctypes.create_unicode_buffer(32_768)
    length = ctypes.windll.kernel32.GetWindowsDirectoryW(buffer, len(buffer))
    if not length or length >= len(buffer):
        raise ExecutionDenied("WINDOWS_DIRECTORY_LOOKUP_FAILED", "Unable to resolve the trusted Windows system directory.")
    return Path(buffer.value).resolve(strict=True)


def _run_bounded(
    command: Sequence[str],
    *,
    cwd: Path,
    env: Mapping[str, str],
    timeout: int,
    provider: str,
    cleanup: tuple[str, str] | None = None,
    output_dir: Path,
    cancel_event: threading.Event | None = None,
) -> ExecutionResult:
    popen_options: dict[str, object] = {
        "cwd": cwd,
        "env": dict(env),
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "shell": False,
    }
    if os.name == "nt":
        popen_options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | getattr(subprocess, "CREATE_SUSPENDED", 0x00000004)
    else:
        popen_options["start_new_session"] = True
        if provider == "unsafe-host":
            popen_options["preexec_fn"] = lambda: _apply_posix_host_limits(timeout)
    try:
        process = subprocess.Popen(list(command), **popen_options)  # type: ignore[arg-type]
    except (OSError, subprocess.SubprocessError) as exc:
        raise ExecutionDenied("EXECUTION_START_FAILED", f"Unable to start execution provider: {exc}") from exc
    windows_job: _WindowsJob | None = None
    if os.name == "nt":
        try:
            windows_job = _WindowsJob.attach(process)
            _resume_windows_process(process)
        except ExecutionDenied:
            if windows_job is not None:
                windows_job.close()
            _terminate_process_tree(process)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            raise

    stdout_chunks: list[bytes] = []
    stderr_chunks: list[bytes] = []
    stdout_state = {"size": 0, "truncated": False}
    stderr_state = {"size": 0, "truncated": False}
    capture_limit_event = threading.Event()
    readers = [
        threading.Thread(
            target=_drain_stream,
            args=(process.stdout, stdout_chunks, stdout_state, capture_limit_event),
            daemon=True,
        ),
        threading.Thread(
            target=_drain_stream,
            args=(process.stderr, stderr_chunks, stderr_state, capture_limit_event),
            daemon=True,
        ),
    ]
    for reader in readers:
        reader.start()

    timed_out = False
    resource_limit_exceeded = False
    cancelled = False
    deadline = time.monotonic() + timeout
    while True:
        if cancel_event is not None and cancel_event.is_set():
            cancelled = True
            break
        if capture_limit_event.is_set():
            resource_limit_exceeded = True
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            timed_out = True
            break
        try:
            returncode = process.wait(timeout=min(0.2, remaining))
            break
        except subprocess.TimeoutExpired:
            if _run_directory_exceeds_limit(output_dir):
                resource_limit_exceeded = True
                break
    if not timed_out and not resource_limit_exceeded and capture_limit_event.is_set():
        resource_limit_exceeded = True
    if not timed_out and not resource_limit_exceeded and _run_directory_exceeds_limit(output_dir):
        resource_limit_exceeded = True
    if timed_out or resource_limit_exceeded or cancelled:
        _terminate_process_tree(process)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        returncode = 124 if timed_out else 125 if resource_limit_exceeded else 130
    if cleanup and (timed_out or resource_limit_exceeded or cancelled or returncode != 0):
        _cleanup_container(*cleanup, env=env)
    if windows_job is not None:
        windows_job.close()
    elif os.name != "nt":
        _terminate_process_tree(process)
    for reader in readers:
        reader.join(timeout=5)
    if capture_limit_event.is_set() and not resource_limit_exceeded:
        resource_limit_exceeded = True
        returncode = 125

    stdout = b"".join(stdout_chunks).decode("utf-8", errors="replace")
    stderr = b"".join(stderr_chunks).decode("utf-8", errors="replace")
    if stdout_state["truncated"]:
        stdout += "\n[proto-agent output truncated]\n"
    if stderr_state["truncated"]:
        stderr += "\n[proto-agent output truncated]\n"
    if resource_limit_exceeded:
        stderr += f"\n[proto-agent run directory exceeded {MAX_RUN_DIRECTORY_BYTES} bytes or {MAX_RUN_DIRECTORY_ENTRIES} entries]\n"
    if cancelled:
        stderr += "\n[proto-agent execution cancelled]\n"
    return ExecutionResult(
        provider=provider,
        command=tuple(command),
        returncode=returncode,
        stdout=stdout,
        stderr=stderr,
        timed_out=timed_out,
        output_truncated=bool(stdout_state["truncated"] or stderr_state["truncated"]),
        resource_limit_exceeded=resource_limit_exceeded,
        cancelled=cancelled,
    )


def _prepare_oci_run_directory(run_dir: Path, container_user: str) -> None:
    if os.name == "nt":
        return
    uid_text, gid_text = container_user.split(":", 1)
    uid = int(uid_text)
    gid = int(gid_text)
    current_uid = os.getuid() if hasattr(os, "getuid") else -1
    current_gid = os.getgid() if hasattr(os, "getgid") else -1
    if (uid, gid) == (current_uid, current_gid):
        return
    if current_uid != 0:
        raise ExecutionDenied(
            "OCI_RUN_DIRECTORY_NOT_WRITABLE",
            "The selected non-root container identity cannot own the isolated run directory.",
        )
    try:
        for path in [run_dir, *run_dir.iterdir()]:
            os.chown(path, uid, gid, follow_symlinks=False)
        os.chmod(run_dir, 0o700)
    except OSError as exc:
        raise ExecutionDenied(
            "OCI_RUN_DIRECTORY_NOT_WRITABLE",
            "Unable to grant the non-root container identity access to the isolated run directory.",
        ) from exc


def _drain_stream(
    stream: object,
    chunks: list[bytes],
    state: dict[str, int | bool],
    limit_event: threading.Event | None = None,
) -> None:
    if stream is None:
        return
    while True:
        data = stream.read(8192)  # type: ignore[attr-defined]
        if not data:
            return
        remaining = MAX_CAPTURE_BYTES - int(state["size"])
        if remaining > 0:
            accepted = data[:remaining]
            chunks.append(accepted)
            state["size"] = int(state["size"]) + len(accepted)
        if len(data) > max(remaining, 0):
            state["truncated"] = True
            if limit_event is not None:
                limit_event.set()


def _terminate_process_tree(process: subprocess.Popen[bytes]) -> None:
    if os.name == "nt":
        system_root = _windows_directory()
        taskkill = system_root / "System32" / "taskkill.exe"
        if taskkill.is_file() and process.pid:
            try:
                subprocess.run(
                    [str(taskkill), "/PID", str(process.pid), "/T", "/F"],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=10,
                    check=False,
                    shell=False,
                    env=_base_environment(include_path=False),
                )
                return
            except (OSError, subprocess.TimeoutExpired):
                pass
        process.kill()
        return
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (OSError, ProcessLookupError):
        if process.poll() is None:
            process.kill()


class _WindowsJob:
    """Kill-on-close Windows Job Object for the owned subprocess tree."""

    def __init__(self, handle: int) -> None:
        self.handle = handle

    @classmethod
    def attach(cls, process: subprocess.Popen[bytes]) -> "_WindowsJob":
        if os.name != "nt":
            raise ExecutionDenied("WINDOWS_JOB_UNAVAILABLE", "Windows Job Objects are available only on Windows.")
        import ctypes
        from ctypes import wintypes

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_ulonglong),
                ("WriteOperationCount", ctypes.c_ulonglong),
                ("OtherOperationCount", ctypes.c_ulonglong),
                ("ReadTransferCount", ctypes.c_ulonglong),
                ("WriteTransferCount", ctypes.c_ulonglong),
                ("OtherTransferCount", ctypes.c_ulonglong),
            ]

        class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
                ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        class JOBOBJECT_CPU_RATE_CONTROL_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("ControlFlags", wintypes.DWORD),
                ("CpuRate", wintypes.DWORD),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL

        handle = kernel32.CreateJobObjectW(None, None)
        if not handle:
            raise ExecutionDenied("WINDOWS_JOB_CREATE_FAILED", "Unable to create a kill-on-close Windows Job Object.")
        information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        information.BasicLimitInformation.LimitFlags = 0x2000 | 0x0008 | 0x0200
        information.BasicLimitInformation.ActiveProcessLimit = OCI_PIDS_LIMIT
        information.JobMemoryLimit = 512 * 1024 * 1024
        if not kernel32.SetInformationJobObject(handle, 9, ctypes.byref(information), ctypes.sizeof(information)):
            kernel32.CloseHandle(handle)
            raise ExecutionDenied("WINDOWS_JOB_CONFIG_FAILED", "Unable to configure Windows process-tree limits.")
        cpu_information = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION()
        cpu_information.ControlFlags = 0x0001 | 0x0004
        cpu_information.CpuRate = max(1, 10_000 // max(os.cpu_count() or 1, 1))
        if not kernel32.SetInformationJobObject(handle, 15, ctypes.byref(cpu_information), ctypes.sizeof(cpu_information)):
            kernel32.CloseHandle(handle)
            raise ExecutionDenied("WINDOWS_JOB_CPU_LIMIT_FAILED", "Unable to configure the Windows job CPU limit.")
        process_handle = wintypes.HANDLE(int(process._handle))  # type: ignore[attr-defined]
        if not kernel32.AssignProcessToJobObject(handle, process_handle):
            kernel32.CloseHandle(handle)
            raise ExecutionDenied("WINDOWS_JOB_ASSIGN_FAILED", "Unable to assign the subprocess to a kill-on-close Windows Job Object.")
        return cls(int(handle))

    def close(self) -> None:
        if not self.handle:
            return
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        kernel32.CloseHandle(wintypes.HANDLE(self.handle))
        self.handle = 0


def _resume_windows_process(process: subprocess.Popen[bytes]) -> None:
    import ctypes
    from ctypes import wintypes

    ntdll = ctypes.WinDLL("ntdll", use_last_error=True)
    resume = ntdll.NtResumeProcess
    resume.argtypes = [wintypes.HANDLE]
    resume.restype = ctypes.c_long
    status = resume(wintypes.HANDLE(int(process._handle)))  # type: ignore[attr-defined]
    if status != 0:
        raise ExecutionDenied("WINDOWS_PROCESS_RESUME_FAILED", "Unable to resume the secured Windows subprocess.")


def _apply_posix_host_limits(timeout: int) -> None:
    import resource

    limits = [
        (resource.RLIMIT_AS, 512 * 1024 * 1024),
        (resource.RLIMIT_FSIZE, MAX_RUN_DIRECTORY_BYTES),
        (resource.RLIMIT_NOFILE, 128),
        (resource.RLIMIT_CORE, 0),
        (resource.RLIMIT_CPU, max(1, timeout + 1)),
    ]
    if hasattr(resource, "RLIMIT_NPROC"):
        limits.append((resource.RLIMIT_NPROC, OCI_PIDS_LIMIT))
    for name, desired in limits:
        current_soft, current_hard = resource.getrlimit(name)
        effective = desired if current_hard == resource.RLIM_INFINITY else min(desired, current_hard)
        resource.setrlimit(name, (effective, effective))


def _cleanup_container(executable: str, container_name: str, *, env: Mapping[str, str]) -> None:
    try:
        subprocess.run(
            [executable, "rm", "-f", container_name],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
            check=False,
            shell=False,
            env=dict(env),
        )
    except (OSError, subprocess.TimeoutExpired):
        return


def _run_directory_exceeds_limit(directory: Path) -> bool:
    total = 0
    entries = 0
    queue = [directory]
    while queue:
        current = queue.pop()
        try:
            with os.scandir(current) as children:
                for child in children:
                    entries += 1
                    if entries > MAX_RUN_DIRECTORY_ENTRIES:
                        return True
                    try:
                        info = child.stat(follow_symlinks=False)
                    except OSError:
                        return True
                    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
                        return True
                    if stat.S_ISDIR(info.st_mode):
                        queue.append(Path(child.path))
                    elif stat.S_ISREG(info.st_mode):
                        total += info.st_size
                        if total > MAX_RUN_DIRECTORY_BYTES:
                            return True
                    else:
                        return True
        except OSError:
            return True
    return False
