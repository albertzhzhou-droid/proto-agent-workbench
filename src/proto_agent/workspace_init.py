"""API-first workspace initialization.

``proto-agent init`` selects a model-provider path (API key or provider
subscription CLI), then emits declarative Python, R and Proto configuration
for the workspace.  The design goals mirror SECURITY.md:

* Secret *values* are never accepted, stored, logged or echoed.  Configuration
  records only environment-variable *names*; a subscription path records only
  that a provider CLI holds the login.  Provider credential stores are never
  read.
* Detection and planning are pure and offline.  Nothing is executed; CLIs are
  located with ``shutil.which`` only.
* The one network operation (``verify``) needs explicit approval, talks to a
  fixed provider host/route over verified TLS, refuses every redirect, bounds
  the response and reports only status counts.
* Generated files are content-addressed in ``workspace.json`` so later drift
  or tampering is detectable, and every generated file is scanned for
  secret-shaped strings before it is written.
* The earlier local-only (LM Studio) path stays available but ranks last.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import shutil
import ssl
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

from .artifact_readers import select_artifact_reader
from .json_validation import JsonValidationError, strict_json_loads
from .security import (
    MAX_JSON_FILE_BYTES,
    MAX_TEXT_FILE_BYTES,
    SecurityBoundaryError,
    WorkspacePaths,
    read_text_bounded,
    write_text_bounded,
)

WORKSPACE_SCHEMA_VERSION = "proto-agent.workspace.v1"
DEFAULT_INIT_DIR = Path(".proto") / "workspace"
MANIFEST_NAME = "workspace.json"
PYTHON_CONFIG_NAME = "python.json"
R_CONFIG_NAME = "r.json"
PROTO_CONFIG_NAME = "workspace.proto"
GENERATED_FILES = (PYTHON_CONFIG_NAME, R_CONFIG_NAME, PROTO_CONFIG_NAME)

MAX_VERIFY_RESPONSE_BYTES = 256 * 1024
VERIFY_TIMEOUT_SECONDS = 10
MAX_CREDENTIAL_CHARS = 512

_ENVIRONMENT_NAME = re.compile(r"[A-Z][A-Z0-9_]{0,127}")
_DESIGN_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}")
_CHASSIS_NAME = re.compile(r"[a-z][a-z0-9_]{0,63}")
_SHA256 = re.compile(r"[0-9a-f]{64}")

# Shapes of well-known credentials.  This is a tripwire for accidental paste,
# not a complete secret scanner.
_SECRET_SHAPES = (
    re.compile(r"sk-ant-[A-Za-z0-9_-]{16,}"),
    re.compile(r"sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}"),
    re.compile(r"gh[pousr]_[A-Za-z0-9]{30,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{30,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"AIza[0-9A-Za-z_-]{30,}"),
    re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
)

# Credential custody tiers, best first.  ``local_only`` is the earlier plan:
# data never leaves the machine but it offers no provider-side revocation,
# audit trail or current models, so it ranks last and is flagged as a fallback.
PROVIDERS: dict[str, dict[str, Any]] = {
    "anthropic-api": {
        "label": "Anthropic API (key from environment)",
        "kind": "api_key_env",
        "security_rank": 1,
        "host": "api.anthropic.com",
        "verify_route": "/v1/models",
        "credential_environment": "ANTHROPIC_API_KEY",
        "auth_header": "x-api-key",
        "auth_prefix": "",
        "extra_headers": {"anthropic-version": "2023-06-01"},
    },
    "openai-api": {
        "label": "OpenAI API (key from environment)",
        "kind": "api_key_env",
        "security_rank": 1,
        "host": "api.openai.com",
        "verify_route": "/v1/models",
        "credential_environment": "OPENAI_API_KEY",
        "auth_header": "Authorization",
        "auth_prefix": "Bearer ",
        "extra_headers": {},
    },
    "claude-subscription": {
        "label": "Claude subscription (delegated to the installed claude CLI login)",
        "kind": "subscription_cli",
        "security_rank": 2,
        "executable": "claude",
    },
    "codex-subscription": {
        "label": "Codex / ChatGPT subscription (delegated to the installed codex CLI login)",
        "kind": "subscription_cli",
        "security_rank": 2,
        "executable": "codex",
    },
    "local-lm-studio": {
        "label": "Local LM Studio on loopback (legacy local-only path)",
        "kind": "local_only",
        "security_rank": 3,
        "base_url": "http://127.0.0.1:1234",
    },
}

# Extras must exist in pyproject.toml; tests cross-check them.
PYTHON_PROFILES: dict[str, dict[str, Any]] = {
    "core": {"extras": [], "summary": "Compiler, checker, review and MCP only."},
    "analysis": {"extras": ["compute", "research-figures"], "summary": "Adds bounded statistics and figure export."},
    "sequence": {"extras": ["compute", "compute-research"], "summary": "Adds sequence and Biopython-backed computation."},
    "full-science": {
        "extras": ["compute", "compute-research", "compute-chem", "research-figures"],
        "summary": "Adds chemistry-capable computation to the analysis stack.",
    },
}

R_PROFILES: dict[str, dict[str, Any]] = {
    "none": {"enabled": False, "packages": [], "summary": "R is not used by this workspace."},
    "core": {"enabled": True, "packages": ["jsonlite"], "summary": "Base R for fixed analysis scripts."},
    "rnaseq": {"enabled": True, "packages": ["jsonlite", "DESeq2"], "summary": "Adds the DESeq2 adapter dependency."},
}

_SUBSCRIPTION_NOTES = (
    "Authentication is delegated to the provider CLI; Proto Agent does not read its credential store.",
    "Sign in with the provider CLI yourself; no token is requested, stored or logged here.",
)


class InitError(ValueError):
    """Raised for a rejected initialization request with a stable code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def looks_like_secret(text: str) -> bool:
    return any(shape.search(text) for shape in _SECRET_SHAPES)


def detect_environment(
    environ: Mapping[str, str] | None = None,
    which: Callable[[str], str | None] = shutil.which,
) -> dict[str, Any]:
    """Offline probe.  Reports presence booleans only, never values."""

    env = os.environ if environ is None else environ
    providers: dict[str, dict[str, Any]] = {}
    for provider_id, spec in PROVIDERS.items():
        entry: dict[str, Any] = {"kind": spec["kind"], "security_rank": spec["security_rank"]}
        if spec["kind"] == "api_key_env":
            entry["credential_environment"] = spec["credential_environment"]
            entry["credential_present"] = bool(env.get(spec["credential_environment"], "").strip())
        elif spec["kind"] == "subscription_cli":
            entry["executable"] = spec["executable"]
            entry["cli_found"] = which(spec["executable"]) is not None
        else:
            entry["note"] = "Reachability is not probed; use the existing LM Studio connector checks."
        providers[provider_id] = entry
    return {
        "python": {"version": platform.python_version(), "executable": Path(sys.executable).name},
        "rscript_found": which("Rscript") is not None,
        "providers": providers,
        "recommended_provider": recommend_provider(providers),
    }


def recommend_provider(providers: Mapping[str, Mapping[str, Any]]) -> str:
    """Best ready path by custody rank; the legacy local path is the last resort."""

    ready = [
        provider_id
        for provider_id, entry in providers.items()
        if entry.get("credential_present") or entry.get("cli_found")
    ]
    ready.sort(key=lambda provider_id: (PROVIDERS[provider_id]["security_rank"], provider_id))
    return ready[0] if ready else "local-lm-studio"


def build_plan(
    *,
    provider: str,
    python_profile: str = "analysis",
    r_profile: str = "none",
    design_name: str = "workspace_starter",
    chassis: str = "ecoli_k12",
    key_env: str | None = None,
    environ: Mapping[str, str] | None = None,
    which: Callable[[str], str | None] = shutil.which,
) -> dict[str, Any]:
    """Validate a request and render every file in memory.  Writes nothing."""

    if provider not in PROVIDERS:
        raise InitError("UNKNOWN_PROVIDER", f"Provider must be one of: {', '.join(sorted(PROVIDERS))}.")
    if python_profile not in PYTHON_PROFILES:
        raise InitError("UNKNOWN_PYTHON_PROFILE", f"Python profile must be one of: {', '.join(sorted(PYTHON_PROFILES))}.")
    if r_profile not in R_PROFILES:
        raise InitError("UNKNOWN_R_PROFILE", f"R profile must be one of: {', '.join(sorted(R_PROFILES))}.")
    if not _DESIGN_NAME.fullmatch(design_name):
        raise InitError("INVALID_DESIGN_NAME", "Design name must be 1-64 letters, digits or underscores, starting with a letter.")
    if not _CHASSIS_NAME.fullmatch(chassis):
        raise InitError("INVALID_CHASSIS", "Chassis must be 1-64 lowercase letters, digits or underscores.")

    spec = PROVIDERS[provider]
    detected = detect_environment(environ, which)
    warnings: list[str] = []
    notes: list[str] = []
    next_steps: list[str] = []
    provider_config: dict[str, Any] = {
        "id": provider,
        "kind": spec["kind"],
        "security_rank": spec["security_rank"],
    }

    if spec["kind"] == "api_key_env":
        variable = _credential_variable(spec, key_env)
        provider_config.update(
            {
                "host": spec["host"],
                "verify_route": spec["verify_route"],
                "credential_environment": variable,
                "credential_storage": "environment_only",
            }
        )
        notes.append("The key is read from the environment at call time and is never written to disk by Proto Agent.")
        if not detected["providers"][provider]["credential_present"] and variable == spec["credential_environment"]:
            warnings.append(f"{variable} is not set in this shell; set it before running model-backed work.")
        next_steps.append(f"Export {variable} in your shell or secret manager (do not commit it).")
        next_steps.append(f"proto-agent init verify --provider {provider} --approve-network")
    elif spec["kind"] == "subscription_cli":
        executable = spec["executable"]
        provider_config.update({"executable": executable, "credential_storage": "delegated_to_provider_cli"})
        notes.extend(_SUBSCRIPTION_NOTES)
        if key_env:
            raise InitError("KEY_ENV_NOT_APPLICABLE", "--key-env applies only to API-key providers.")
        if not detected["providers"][provider]["cli_found"]:
            warnings.append(f"The {executable} CLI was not found on PATH; install it and sign in before use.")
        next_steps.append(f"Sign in with the {executable} CLI if you have not already.")
    else:
        if key_env:
            raise InitError("KEY_ENV_NOT_APPLICABLE", "--key-env applies only to API-key providers.")
        provider_config.update({"base_url": spec["base_url"], "credential_storage": "none", "fallback": True})
        warnings.append(
            "Legacy local-only path: lowest priority. It has no provider-side key revocation or audit trail; "
            "prefer an API or subscription provider when available."
        )
        next_steps.append("Use the existing LM Studio connector checks: proto-agent connectors check.")

    python_config = {
        "schema_version": WORKSPACE_SCHEMA_VERSION,
        "profile": python_profile,
        "summary": PYTHON_PROFILES[python_profile]["summary"],
        "requires_python": ">=3.10",
        "extras": list(PYTHON_PROFILES[python_profile]["extras"]),
        "interpreter_flags": ["-I", "-B"],
        "inherit_environment": False,
        "install_hint": _install_hint(PYTHON_PROFILES[python_profile]["extras"]),
    }
    r_spec = R_PROFILES[r_profile]
    r_config = {
        "schema_version": WORKSPACE_SCHEMA_VERSION,
        "profile": r_profile,
        "summary": r_spec["summary"],
        "enabled": r_spec["enabled"],
        "packages": list(r_spec["packages"]),
        "execution": "oci_sandbox_or_explicit_cli_unsafe_host",
        "inherit_environment": False,
        "rscript_found": detected["rscript_found"],
    }
    if r_spec["enabled"] and not detected["rscript_found"]:
        warnings.append("Rscript was not found on PATH; a configured OCI sandbox image may still provide R.")

    files = {
        PYTHON_CONFIG_NAME: _dump(python_config),
        R_CONFIG_NAME: _dump(r_config),
        PROTO_CONFIG_NAME: _render_proto(design_name, chassis),
    }
    for name, text in files.items():
        if looks_like_secret(text):
            raise InitError("SECRET_SHAPED_CONTENT", f"Generated {name} contains a secret-shaped string; nothing was written.")
    manifest = {
        "schema_version": WORKSPACE_SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "provider": provider_config,
        "python": {"profile": python_profile, "config": PYTHON_CONFIG_NAME},
        "r": {"profile": r_profile, "config": R_CONFIG_NAME},
        "proto": {"design": design_name, "chassis": chassis, "config": PROTO_CONFIG_NAME},
        "files": {name: _sha256(text) for name, text in files.items()},
        "network_policy": "denied_unless_connector_call_approved",
    }
    if looks_like_secret(_dump(manifest)):
        raise InitError("SECRET_SHAPED_CONTENT", "Manifest contains a secret-shaped string; nothing was written.")
    files[MANIFEST_NAME] = _dump(manifest)
    return {
        "ok": True,
        "provider": provider,
        "provider_label": spec["label"],
        "security_rank": spec["security_rank"],
        "detected": detected,
        "files": files,
        "manifest": manifest,
        "warnings": warnings,
        "notes": notes,
        "next_steps": next_steps,
    }


def public_plan(plan: Mapping[str, Any]) -> dict[str, Any]:
    """JSON-safe view of a plan: file names and digests instead of bodies."""

    return {
        **{key: value for key, value in plan.items() if key != "files"},
        "files": {name: {"sha256": _sha256(text), "bytes": len(text.encode("utf-8"))} for name, text in plan["files"].items()},
    }


def apply_plan(
    plan: Mapping[str, Any],
    *,
    workspace_root: str | Path | None = None,
    out_dir: str | Path = DEFAULT_INIT_DIR,
    force: bool = False,
) -> dict[str, Any]:
    paths = WorkspacePaths.create(workspace_root)
    target = paths.ensure_directory(_relative_out_dir(paths, out_dir), boundary=paths.workspace)
    manifest_path = target / MANIFEST_NAME
    if manifest_path.exists() and not force:
        raise InitError("WORKSPACE_ALREADY_INITIALIZED", "A workspace configuration already exists; pass --force to replace it.")
    files: Mapping[str, str] = plan["files"]
    # The manifest goes last so it exists only when every file it digests was written.
    order = (*GENERATED_FILES, MANIFEST_NAME)
    for name in order:
        write_text_bounded(target / name, files[name], MAX_TEXT_FILE_BYTES, boundary=paths.workspace)
    written = [(target / name).relative_to(paths.workspace).as_posix() for name in order]
    return {"ok": True, "provider": plan["provider"], "written": written, "warnings": plan["warnings"], "next_steps": plan["next_steps"]}


def workspace_status(
    *,
    workspace_root: str | Path | None = None,
    out_dir: str | Path = DEFAULT_INIT_DIR,
    environ: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Re-check a written configuration: schema, digests, secrets and credential presence."""

    env = os.environ if environ is None else environ
    paths = WorkspacePaths.create(workspace_root)
    relative_dir = _relative_out_dir(paths, out_dir).relative_to(paths.workspace).as_posix()
    issues: list[dict[str, str]] = []
    try:
        manifest_file = paths.workspace_file(f"{relative_dir}/{MANIFEST_NAME}", extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
        manifest_text = read_text_bounded(manifest_file, MAX_JSON_FILE_BYTES)
        manifest = strict_json_loads(manifest_text, max_bytes=MAX_JSON_FILE_BYTES)
    except (SecurityBoundaryError, JsonValidationError) as exc:
        return {"ok": False, "initialized": False, "issues": [{"code": getattr(exc, "code", "INVALID_JSON"), "message": str(exc)}]}

    problems = _manifest_problems(manifest)
    issues.extend({"code": "MANIFEST_INVALID", "message": problem} for problem in problems)
    if looks_like_secret(manifest_text):
        issues.append({"code": "SECRET_SHAPED_CONTENT", "message": f"{MANIFEST_NAME} contains a secret-shaped string."})
    digests = manifest.get("files") if isinstance(manifest, dict) else None
    if isinstance(digests, dict) and not problems:
        for name in GENERATED_FILES:
            try:
                path = paths.workspace_file(f"{relative_dir}/{name}", max_bytes=MAX_TEXT_FILE_BYTES)
                text = read_text_bounded(path, MAX_TEXT_FILE_BYTES)
            except SecurityBoundaryError as exc:
                issues.append({"code": exc.code, "message": f"{name}: {exc}"})
                continue
            if _sha256(text) != digests.get(name):
                issues.append({"code": "DIGEST_MISMATCH", "message": f"{name} changed since it was generated."})
            if looks_like_secret(text):
                issues.append({"code": "SECRET_SHAPED_CONTENT", "message": f"{name} contains a secret-shaped string."})
    provider = manifest.get("provider", {}) if isinstance(manifest, dict) else {}
    credential: dict[str, Any] = {}
    variable = provider.get("credential_environment") if isinstance(provider, dict) else None
    if isinstance(variable, str):
        credential = {"credential_environment": variable, "credential_present": bool(env.get(variable, "").strip())}
    return {
        "ok": not issues,
        "initialized": True,
        "directory": relative_dir,
        "provider": provider.get("id") if isinstance(provider, dict) else None,
        **credential,
        "issues": issues,
    }


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect could forward the credential to another host; refuse all of them."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        raise urllib.error.HTTPError(req.full_url, code, "Redirects are not permitted for credentialed requests.", headers, fp)


def verify_provider(
    provider: str,
    *,
    approve_network: bool,
    environ: Mapping[str, str] | None = None,
    key_env: str | None = None,
    opener: urllib.request.OpenerDirector | None = None,
) -> dict[str, Any]:
    """One approved, credentialed ``GET <models route>`` against the fixed provider host."""

    spec = PROVIDERS.get(provider)
    if spec is None:
        raise InitError("UNKNOWN_PROVIDER", f"Provider must be one of: {', '.join(sorted(PROVIDERS))}.")
    if spec["kind"] != "api_key_env":
        return {"ok": False, "provider": provider, "code": "VERIFY_NOT_APPLICABLE", "message": "Only API-key providers support a live handshake."}
    if not approve_network:
        return {"ok": False, "provider": provider, "code": "NETWORK_NOT_APPROVED", "message": "Pass --approve-network to allow this one request."}
    env = os.environ if environ is None else environ
    variable = _credential_variable(spec, key_env)
    credential = env.get(variable, "").strip()
    if not credential:
        return {"ok": False, "provider": provider, "code": "CREDENTIAL_MISSING", "message": f"{variable} is not set."}
    if len(credential) > MAX_CREDENTIAL_CHARS or not credential.isprintable() or any(character.isspace() for character in credential):
        return {"ok": False, "provider": provider, "code": "CREDENTIAL_MALFORMED", "message": f"{variable} does not look like an API key."}

    url = f"https://{spec['host']}{spec['verify_route']}"
    headers = {
        spec["auth_header"]: f"{spec['auth_prefix']}{credential}",
        "Accept": "application/json",
        "User-Agent": "proto-agent-init/1.0",
        **spec["extra_headers"],
    }
    request = urllib.request.Request(url, headers=headers, method="GET")
    active = opener or urllib.request.build_opener(urllib.request.HTTPSHandler(context=_ssl_context()), _NoRedirect())
    result: dict[str, Any] = {"provider": provider, "host": spec["host"], "route": spec["verify_route"]}
    try:
        with active.open(request, timeout=VERIFY_TIMEOUT_SECONDS) as response:
            raw = response.read(MAX_VERIFY_RESPONSE_BYTES + 1)
            status = getattr(response, "status", 200)
    except urllib.error.HTTPError as error:
        return {**result, "ok": False, "code": "HTTP_ERROR", "http_status": error.code, "message": _redact(f"Provider returned HTTP {error.code}.", credential)}
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        return {**result, "ok": False, "code": "NETWORK_ERROR", "message": _redact(f"Request failed: {type(error).__name__}.", credential)}
    if len(raw) > MAX_VERIFY_RESPONSE_BYTES:
        return {**result, "ok": False, "code": "RESPONSE_TOO_LARGE", "http_status": status, "message": "Response exceeded the byte limit."}
    model_count: int | None = None
    try:
        body = strict_json_loads(raw.decode("utf-8"), max_bytes=MAX_VERIFY_RESPONSE_BYTES)
        if isinstance(body, dict) and isinstance(body.get("data"), list):
            model_count = len(body["data"])
    except (UnicodeDecodeError, JsonValidationError):
        pass
    return {**result, "ok": 200 <= status < 300, "http_status": status, "model_count": model_count, "credential_environment": variable}


def _credential_variable(spec: Mapping[str, Any], key_env: str | None) -> str:
    if key_env is None:
        return str(spec["credential_environment"])
    if looks_like_secret(key_env) or not _ENVIRONMENT_NAME.fullmatch(key_env):
        # Never echo the argument: it may be a pasted key.
        raise InitError("INVALID_KEY_ENV", "--key-env must be an environment-variable NAME such as MY_API_KEY, not a key value.")
    return key_env


def _relative_out_dir(paths: WorkspacePaths, out_dir: str | Path) -> Path:
    raw = str(out_dir).replace("\\", "/")
    if raw.startswith("/") or ".." in raw.split("/") or not raw.strip("/"):
        raise InitError("INVALID_OUT_DIR", "Output directory must be a relative workspace path.")
    return paths.workspace.joinpath(*[part for part in raw.split("/") if part and part != "."])


def _manifest_problems(manifest: Any) -> list[str]:
    if not isinstance(manifest, dict):
        return ["Manifest must be a JSON object."]
    problems: list[str] = []
    reader = select_artifact_reader("proto-agent.workspace", manifest)
    if reader["readOnly"]:
        problems.append(f"{reader['code']}: schema_version {reader['schemaVersion']!r} is not a current workspace manifest.")
    provider = manifest.get("provider")
    if not isinstance(provider, dict) or provider.get("id") not in PROVIDERS:
        problems.append("provider.id is missing or unknown.")
    elif isinstance(provider.get("credential_environment"), str) and not _ENVIRONMENT_NAME.fullmatch(provider["credential_environment"]):
        problems.append("provider.credential_environment is not a valid variable name.")
    files = manifest.get("files")
    if not isinstance(files, dict) or set(files) != set(GENERATED_FILES) or not all(
        isinstance(value, str) and _SHA256.fullmatch(value) for value in files.values()
    ):
        problems.append("files must map each generated config to a SHA-256 digest.")
    return problems


def _install_hint(extras: list[str]) -> str:
    return 'pip install -e "."' if not extras else f'pip install -e ".[{",".join(extras)}]"'


def _render_proto(design_name: str, chassis: str) -> str:
    return (
        "# Starter Proto design generated by `proto-agent init`.\n"
        "# Parts are toy development fixtures, not reviewed biological parts.\n"
        "# Validate with: proto-agent check <this file> --json\n"
        f"design {design_name} chassis {chassis}\n"
        "\n"
        "construct starter_unit:\n"
        "  promoter pLac\n"
        "  rbs B0034\n"
        "  cds gfp_mock\n"
        "  terminator B0015\n"
        "\n"
        "constraint avoid_restriction_site enzyme=BsaI\n"
        "constraint gc_content min=0.35 max=0.65\n"
    )


def _dump(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _redact(message: str, credential: str) -> str:
    return message.replace(credential, "[redacted]")


def _ssl_context() -> ssl.SSLContext:
    try:
        import certifi  # type: ignore[import-not-found]

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()
