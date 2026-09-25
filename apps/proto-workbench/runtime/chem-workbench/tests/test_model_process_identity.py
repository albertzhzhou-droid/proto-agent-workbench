"""Runtime attestation fixtures test identity failures without inspecting a live provider."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

from chem_workbench.visualization import content_hash

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/model_process_identity.py"
SPEC = importlib.util.spec_from_file_location("model_process_identity_tests", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
RUNTIME = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNTIME)


@pytest.fixture
def observed(tmp_path):
    studio = tmp_path / ".lmstudio"
    backend = studio / "extensions/backends/llama.cpp-fixture-2.36.0"
    backend.mkdir(parents=True)
    manifest = {
        "engine": "llama.cpp",
        "name": "llama.cpp-fixture",
        "version": "2.36.0",
        "gpu": {"framework": "CUDA"},
        "engine_protocol_server": {"executable_relative_path": "llama-server.exe"},
    }
    (backend / "backend-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    main = tmp_path / "LM Studio.exe"
    main.write_bytes(b"Fixture application binary")
    engine = backend / "llama-server.exe"
    engine.write_bytes(b"Fixture backend binary")
    weights = tmp_path / "complex model.gguf"
    weights.write_bytes(b"Fixture weight identity only")
    template = tmp_path / "chat-template.jinja"
    template.write_bytes(b"{{ messages }}\r\n")
    modules = []
    for name in [
        "llama.dll",
        "llama-server-impl.dll",
        "ggml-base.dll",
        "ggml-cpu.dll",
        "ggml-cuda.dll",
    ]:
        module = backend / name
        module.write_bytes(("Fixture " + name).encode())
        modules.append(
            {
                "path": str(module),
                "module_name": name,
                "file_version": None,
                "product_version": None,
            }
        )
    common = {
        "created_at_utc": "2026-09-11T12:00:00Z",
        "command_line_sha256": "1" * 64,
        "module_enumeration_error": None,
        "executable_file_version": "0.4.19+2",
        "executable_product_version": "0.4.19.0",
    }
    process = {
        **common,
        "pid": 22,
        "parent_pid": 11,
        "name": "llama-server.exe",
        "executable_path": str(engine),
        "loaded_modules": modules,
        "command_line_redacted": f'"{engine}" --model "{weights}" --api-key <redacted> '
        f'--chat-template-file "{template}" --ctx-size 16384 --parallel 1',
    }
    parent = {
        **common,
        "pid": 11,
        "parent_pid": 1,
        "name": "LM Studio.exe",
        "executable_path": str(main),
        "loaded_modules": [],
        "command_line_redacted": f'"{main}" --run-as-service',
    }
    snapshot = {
        "version": "lmstudio-native-process-observation/v1",
        "observed_at_utc": "2026-09-11T12:01:00Z",
        "processes": [parent, process],
    }
    return studio, weights, snapshot


def test_actual_image_module_and_template_bindings_preserve_exact_bytes(observed):
    studio, weights, snapshot = observed
    result = RUNTIME.capture_process_identity(
        weights, studio, observer=lambda: copy.deepcopy(snapshot)
    )
    assert result["process_identity_stable"]
    assert result["active_runtime"]["version"] == "2.36.0"
    assert result["lmstudio_process"]["executable_product_version"] == "0.4.19.0"
    assert result["active_chat_template"]["text"].endswith("\r\n")
    assert (
        result["active_chat_template"]["utf8_sha256"]
        == hashlib.sha256(b"{{ messages }}\r\n").hexdigest()
    )
    assert RUNTIME.option(result["startup_arguments_redacted"], "--model") == str(weights)
    for binding in result["binary_bindings"]:
        assert (
            binding["file"]["sha256"]
            == hashlib.sha256(Path(binding["file"]["path"]).read_bytes()).hexdigest()
        )
    assert result["attestation_hash"] == content_hash(
        {key: value for key, value in result.items() if key != "attestation_hash"}
    )
    assert "does not prove resident tensor equality" in result["scope"]


@pytest.mark.parametrize(
    "mutation,expected",
    [
        (lambda s: s["processes"].pop(), "PROCESS_CHANGED"),
        (lambda s: s["processes"][1].update(created_at_utc="changed"), "PROCESS_CHANGED"),
        (lambda s: s["processes"][1].update(command_line_sha256="changed"), "PROCESS_CHANGED"),
        (lambda s: s["processes"][1]["loaded_modules"].pop(), "MODULES_CHANGED"),
    ],
)
def test_pid_reuse_restarts_command_changes_and_module_drift_fail(observed, mutation, expected):
    studio, weights, snapshot = observed
    altered = copy.deepcopy(snapshot)
    mutation(altered)
    responses = iter([snapshot, altered])
    with pytest.raises(ValueError, match=expected):
        RUNTIME.capture_process_identity(weights, studio, observer=lambda: next(responses))


def test_loaded_parser_library_is_required_and_foreign_model_is_not_matched(observed):
    studio, weights, snapshot = observed
    snapshot["processes"][1]["loaded_modules"] = snapshot["processes"][1]["loaded_modules"][:1]
    with pytest.raises(ValueError, match="PARSER_AND_COMPUTE_MODULES_REQUIRED"):
        RUNTIME.capture_process_identity(weights, studio, observer=lambda: snapshot)
    with pytest.raises(ValueError, match="EXACT_RUNNING_MODEL_PROCESS_REQUIRED"):
        RUNTIME.capture_process_identity(
            weights.with_name("other.gguf"), studio, observer=lambda: snapshot
        )


def test_binary_mutation_during_observation_is_rejected(observed):
    studio, weights, snapshot = observed
    count = 0

    def observe():
        nonlocal count
        count += 1
        if count == 2:
            Path(snapshot["processes"][1]["executable_path"]).write_bytes(b"Changed binary bytes")
        return copy.deepcopy(snapshot)

    with pytest.raises(ValueError, match="BINARY_CHANGED_DURING_ATTESTATION"):
        RUNTIME.capture_process_identity(weights, studio, observer=observe)


def test_ambiguous_model_process_and_missing_parent_fail_closed(observed):
    studio, weights, snapshot = observed
    duplicate = copy.deepcopy(snapshot)
    duplicate["processes"].append(copy.deepcopy(snapshot["processes"][1]))
    with pytest.raises(ValueError, match="EXACT_RUNNING_MODEL_PROCESS_REQUIRED"):
        RUNTIME.capture_process_identity(weights, studio, observer=lambda: duplicate)
    snapshot["processes"][1]["parent_pid"] = 999
    with pytest.raises(ValueError, match="LMSTUDIO_PARENT_REQUIRED"):
        RUNTIME.capture_process_identity(weights, studio, observer=lambda: snapshot)


@pytest.mark.parametrize(
    "argument",
    [
        "--api-key private",
        '--api-key="private token"',
        '--API_KEY "private token"',
        "--authorization private",
        "--password=private",
        "--token private",
    ],
)
def test_private_control_secrets_are_redacted_before_retaining_argv(argument):
    result = RUNTIME.redact_command_line('engine.exe --model "C:\\model file.gguf" ' + argument)
    assert "private" not in result
    assert "<redacted>" in result
    assert '"C:\\model file.gguf"' in result


def test_duplicate_or_missing_startup_option_is_rejected():
    with pytest.raises(ValueError, match="AMBIGUOUS_PROCESS_ARGUMENT"):
        RUNTIME.option(["engine", "--model", "a", "--model=b"], "--model")
    with pytest.raises(ValueError, match="PROCESS_ARGUMENT_VALUE_REQUIRED"):
        RUNTIME.option(["engine", "--model"], "--model")
