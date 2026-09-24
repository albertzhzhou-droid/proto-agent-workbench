"""Bind actual Windows LM Studio process images/modules to hashed on-disk bytes.

Observed loaded module paths and startup argv are evidence of a running runtime.
They do not establish resident tensor equality or loaded-memory byte integrity.
"""

from __future__ import annotations

import ctypes
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

from chem_workbench.visualization import content_hash

HERE = Path(__file__).resolve().parent
SECRET_ARGUMENT = re.compile(
    r'(?i)(--(?:api[-_]key|password|token|secret|authorization)(?:=|\s+))("[^"]*"|\S+)'
)


def redact_command_line(value):
    return SECRET_ARGUMENT.sub(r"\1<redacted>", value)


def windows_arguments(value):
    if os.name != "nt":
        raise ValueError("WINDOWS_PROCESS_ATTESTATION_REQUIRED")
    count = ctypes.c_int()
    shell = ctypes.WinDLL("shell32", use_last_error=True)
    shell.CommandLineToArgvW.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_int)]
    shell.CommandLineToArgvW.restype = ctypes.POINTER(ctypes.c_wchar_p)
    pointer = shell.CommandLineToArgvW(value, ctypes.byref(count))
    if not pointer:
        raise ValueError("INVALID_WINDOWS_PROCESS_ARGUMENTS")
    try:
        return [pointer[i] for i in range(count.value)]
    finally:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.LocalFree.argtypes = [ctypes.c_void_p]
        kernel.LocalFree.restype = ctypes.c_void_p
        kernel.LocalFree(pointer)


def option(arguments, name):
    values = []
    for index, value in enumerate(arguments):
        if value == name:
            if index + 1 >= len(arguments):
                raise ValueError("PROCESS_ARGUMENT_VALUE_REQUIRED")
            values.append(arguments[index + 1])
        elif value.startswith(name + "="):
            values.append(value[len(name) + 1 :])
    if len(values) > 1:
        raise ValueError("AMBIGUOUS_PROCESS_ARGUMENT")
    return values[0] if values else None


def observe_processes():
    if os.name != "nt":
        raise ValueError("WINDOWS_PROCESS_ATTESTATION_REQUIRED")
    powershell = Path(os.environ["SYSTEMROOT"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    result = subprocess.run(
        [
            str(powershell),
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(HERE / "observe_lmstudio_processes.ps1"),
        ],
        capture_output=True,
        timeout=30,
        check=False,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    if result.returncode or len(result.stdout) > 2_000_000:
        raise ValueError("NATIVE_PROVIDER_PROCESS_OBSERVATION_FAILED")
    observation = json.loads(result.stdout.decode("utf-8-sig"))
    if observation.get("version") != "lmstudio-native-process-observation/v1":
        raise ValueError("NATIVE_PROVIDER_PROCESS_OBSERVATION_VERSION")
    for process in observation["processes"]:
        process["command_line_redacted"] = redact_command_line(process["command_line_redacted"])
    return observation


def file_identity(path):
    path = Path(path).resolve()
    before = path.stat()
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(8 * 1024 * 1024):
            digest.update(block)
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError("RUNTIME_BINARY_CHANGED_DURING_HASH")
    return {
        "path": str(path),
        "bytes": after.st_size,
        "mtime_ns": after.st_mtime_ns,
        "sha256": digest.hexdigest(),
    }


def _same_path(left, right):
    return os.path.normcase(str(Path(left).resolve())) == os.path.normcase(
        str(Path(right).resolve())
    )


def _process_key(process):
    return {
        key: process[key]
        for key in (
            "pid",
            "parent_pid",
            "name",
            "executable_path",
            "created_at_utc",
            "command_line_sha256",
        )
    }


def capture_process_identity(weights_path, studio_root, *, observer=observe_processes):
    before = observer()
    engines = []
    for process in before["processes"]:
        if process["name"].lower() != "llama-server.exe":
            continue
        arguments = windows_arguments(process["command_line_redacted"])
        path = option(arguments, "--model")
        if path and Path(path).is_absolute() and _same_path(path, weights_path):
            engines.append((process, arguments))
    if len(engines) != 1:
        raise ValueError("EXACT_RUNNING_MODEL_PROCESS_REQUIRED")
    engine, arguments = engines[0]
    if engine["module_enumeration_error"] or not engine["loaded_modules"]:
        raise ValueError("LOADED_BACKEND_MODULE_OBSERVATION_REQUIRED")
    backend = Path(engine["executable_path"]).resolve().parent
    if not backend.is_relative_to((studio_root / "extensions/backends").resolve()):
        raise ValueError("RUNNING_BACKEND_OUTSIDE_LMSTUDIO_ROOT")
    manifest_path = backend / "backend-manifest.json"
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    if (
        manifest.get("engine") != "llama.cpp"
        or manifest.get("engine_protocol_server", {}).get("executable_relative_path")
        != Path(engine["executable_path"]).name
    ):
        raise ValueError("RUNNING_BACKEND_MANIFEST_MISMATCH")
    if backend.name != f"{manifest.get('name')}-{manifest.get('version')}":
        raise ValueError("RUNNING_BACKEND_DIRECTORY_VERSION_MISMATCH")
    observed_names = {module["module_name"].lower() for module in engine["loaded_modules"]}
    required_names = {"llama.dll", "llama-server-impl.dll", "ggml-base.dll", "ggml-cpu.dll"}
    if manifest.get("gpu", {}).get("framework") == "CUDA":
        required_names.add("ggml-cuda.dll")
    if not required_names <= observed_names:
        raise ValueError("LOADED_PARSER_AND_COMPUTE_MODULES_REQUIRED")
    mains = [p for p in before["processes"] if p["name"].lower() == "lm studio.exe"]
    ancestors = {p["pid"]: p for p in before["processes"]}
    ancestor = ancestors.get(engine["parent_pid"])
    if ancestor is not None and ancestor["name"].lower() == "llmster.exe":
        ancestor = ancestors.get(ancestor["parent_pid"])
    if ancestor is None or ancestor not in mains:
        raise ValueError("RUNNING_BACKEND_LMSTUDIO_PARENT_REQUIRED")
    bindings, identities = [], {}

    def bind(path, role, **metadata):
        resolved = str(Path(path).resolve())
        if resolved not in identities:
            identities[resolved] = file_identity(Path(resolved))
        bindings.append({"role": role, "file": identities[resolved], **metadata})

    bind(
        ancestor["executable_path"],
        "running_lmstudio_executable",
        file_version=ancestor["executable_file_version"],
        product_version=ancestor["executable_product_version"],
    )
    bind(engine["executable_path"], "running_backend_executable")
    for module in engine["loaded_modules"]:
        bind(
            module["path"],
            "observed_loaded_backend_module",
            module_name=module["module_name"],
            file_version=module["file_version"],
            product_version=module["product_version"],
        )
    bind(manifest_path, "on_disk_backend_manifest")
    if hashlib.sha256(manifest_bytes).hexdigest() != identities[str(manifest_path)]["sha256"]:
        raise ValueError("BACKEND_MANIFEST_CHANGED_DURING_READ")
    template_path = option(arguments, "--chat-template-file")
    if template_path is None or not Path(template_path).is_absolute():
        raise ValueError("ACTIVE_CHAT_TEMPLATE_FILE_REQUIRED")
    bind(template_path, "startup_argument_chat_template")
    if Path(template_path).stat().st_size > 512_000:
        raise ValueError("ACTIVE_CHAT_TEMPLATE_LIMIT")
    template_bytes = Path(template_path).read_bytes()
    if (
        hashlib.sha256(template_bytes).hexdigest()
        != identities[str(Path(template_path).resolve())]["sha256"]
    ):
        raise ValueError("ACTIVE_CHAT_TEMPLATE_CHANGED_DURING_READ")
    template = template_bytes.decode("utf-8")
    after = observer()
    current = {p["pid"]: p for p in after["processes"]}
    for process in (ancestor, engine):
        fresh = current.get(process["pid"])
        if fresh is None or _process_key(process) != _process_key(fresh):
            raise ValueError("PROVIDER_PROCESS_CHANGED_DURING_ATTESTATION")
    old_modules = sorted(module["path"].lower() for module in engine["loaded_modules"])
    new_modules = sorted(
        module["path"].lower() for module in current[engine["pid"]]["loaded_modules"]
    )
    if old_modules != new_modules or current[engine["pid"]]["module_enumeration_error"]:
        raise ValueError("LOADED_BACKEND_MODULES_CHANGED_DURING_ATTESTATION")
    for identity in identities.values():
        stat = Path(identity["path"]).stat()
        if (stat.st_size, stat.st_mtime_ns) != (identity["bytes"], identity["mtime_ns"]):
            raise ValueError("RUNTIME_BINARY_CHANGED_DURING_ATTESTATION")
    document = {
        "version": "model-process-attestation/v1",
        "process_identity_stable": True,
        "observed_at_utc": before["observed_at_utc"],
        "verified_at_utc": after["observed_at_utc"],
        "lmstudio_process": ancestor,
        "engine_process": engine,
        "model_file_argument": str(Path(weights_path).resolve()),
        "active_runtime": {
            "engine": manifest["engine"],
            "name": manifest["name"],
            "version": manifest["version"],
            "backend_directory": str(backend),
        },
        "backend_manifest": manifest,
        "binary_bindings": bindings,
        "startup_arguments_redacted": arguments,
        "active_chat_template": {
            "text": template,
            "utf8_sha256": hashlib.sha256(template.encode()).hexdigest(),
        },
        "observer": {
            "powershell_helper": file_identity(HERE / "observe_lmstudio_processes.ps1"),
            "python_helper": file_identity(Path(__file__)),
        },
        "scope": "Native running-process image and loaded-module paths plus stable on-disk "
        "binary hashes and startup argv. This does not prove resident tensor equality, "
        "loaded-memory byte integrity or that files were not replaced before observation. "
        "An LM Studio backend package version is not an upstream llama.cpp git revision.",
    }
    document["attestation_hash"] = content_hash(document)
    return document
