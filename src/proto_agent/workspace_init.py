"""API-first workspace initialization.

``proto-agent init`` selects a model-provider path (API key, custom gateway, or
provider subscription CLI), then emits declarative Python, R and Proto
configuration for the workspace.  The design goals mirror SECURITY.md:

* Secret *values* are never accepted, stored, logged or echoed.  Configuration
  records only environment-variable *names*; a subscription path records only
  that a provider CLI holds the login, by default in a workspace-isolated
  credential home.  Provider credential stores are never read.
* Detection and planning are pure and offline.  Nothing is executed; CLIs are
  located with ``shutil.which`` only.
* The one network operation (``verify``) needs explicit approval, probes the
  exact configured model with one request, talks to a host that official
  providers pin in code (never from the manifest), refuses every redirect,
  bounds the response and reports a typed failure category plus counts only.
* Generated files are content-addressed in ``workspace.json`` so later drift
  or tampering is detectable, every generated file is scanned for
  secret-shaped strings before it is written, and re-applying an identical
  configuration is a no-op.
* The earlier local-only (LM Studio) path stays available but ranks last.

The staged setup, typed validation categories, isolated subscription login and
gateway URL rules follow public product-level patterns of other scientific
workbenches; this module is an independent implementation.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import platform
import re
import shutil
import socket
import ssl
import stat as stat_module
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping
from uuid import uuid4

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
CREDENTIALS_DIR = "credentials"
VERIFICATION_NAME = "verification.json"
VERIFICATION_SCHEMA_VERSION = "proto-agent.workspace-verification.v1"

MAX_VERIFY_RESPONSE_BYTES = 256 * 1024
VERIFY_TIMEOUT_SECONDS = 10
MAX_CREDENTIAL_CHARS = 512
MAX_BASE_URL_CHARS = 256

_ENVIRONMENT_NAME = re.compile(r"[A-Z][A-Z0-9_]{0,127}")
_DESIGN_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}")
_CHASSIS_NAME = re.compile(r"[a-z][a-z0-9_]{0,63}")
_MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}")
_URL_PATH = re.compile(r"(?:/[A-Za-z0-9._~-]+)*")
_HOSTNAME = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*")
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

# Typed outcome of a live check, so callers can act on the reason.
VALIDATION_CATEGORIES = (
    "ok",
    "network",
    "auth",
    "model-not-found",
    "bad-url",
    "timeout",
    "incompatible",
    "server-error",
    "unknown",
)

GATEWAY_PROTOCOLS = ("messages", "chat-completions", "responses")
CREDENTIAL_MODES = ("isolated", "shared")

# Credential custody tiers, best first.  ``local_only`` is the earlier plan:
# data never leaves the machine but it offers no provider-side revocation,
# audit trail or current models, so it ranks last and is flagged as a fallback.
PROVIDERS: dict[str, dict[str, Any]] = {
    "anthropic-api": {
        "label": "Anthropic API (key from environment)",
        "kind": "api_key_env",
        "security_rank": 1,
        "host": "api.anthropic.com",
        "models_route": "/v1/models",
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
        "models_route": "/v1/models",
        "credential_environment": "OPENAI_API_KEY",
        "auth_header": "Authorization",
        "auth_prefix": "Bearer ",
        "extra_headers": {},
    },
    "custom-gateway": {
        "label": "Custom gateway (user-pinned host; HTTPS and a key unless loopback)",
        "kind": "api_gateway",
        "security_rank": 2,
        "credential_environment": "PROTO_GATEWAY_API_KEY",
    },
    "claude-subscription": {
        "label": "Claude subscription (delegated to the installed claude CLI login)",
        "kind": "subscription_cli",
        "security_rank": 2,
        "executable": "claude",
        "home_environment": "CLAUDE_CONFIG_DIR",
        "login_hint": "claude setup-token",
    },
    "codex-subscription": {
        "label": "Codex / ChatGPT subscription (delegated to the installed codex CLI login)",
        "kind": "subscription_cli",
        "security_rank": 2,
        "executable": "codex",
        "home_environment": "CODEX_HOME",
        "login_hint": "codex login",
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


class InitError(ValueError):
    """Raised for a rejected initialization request with a stable code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def looks_like_secret(text: str) -> bool:
    return any(shape.search(text) for shape in _SECRET_SHAPES)


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------


def detect_environment(
    environ: Mapping[str, str] | None = None,
    which: Callable[[str], str | None] = shutil.which,
    workspace_root: str | Path | None = None,
) -> dict[str, Any]:
    """Offline probe.  Reports presence booleans only, never values."""

    env = os.environ if environ is None else environ
    providers: dict[str, dict[str, Any]] = {}
    for provider_id, spec in PROVIDERS.items():
        entry: dict[str, Any] = {"kind": spec["kind"], "security_rank": spec["security_rank"]}
        if spec["kind"] in {"api_key_env", "api_gateway"}:
            entry["credential_environment"] = spec["credential_environment"]
            entry["credential_present"] = bool(env.get(spec["credential_environment"], "").strip())
        elif spec["kind"] == "subscription_cli":
            entry["executable"] = spec["executable"]
            entry["cli_found"] = which(spec["executable"]) is not None
        else:
            entry["note"] = "Reachability is not probed; use the existing LM Studio connector checks."
        providers[provider_id] = entry
    report: dict[str, Any] = {
        "python": {
            "version": platform.python_version(),
            "executable": Path(sys.executable).name,
            "supported": sys.version_info >= (3, 10),
        },
        "rscript_found": which("Rscript") is not None,
        "providers": providers,
        "recommended_provider": recommend_provider(providers),
    }
    if workspace_root is not None:
        report["workspace_writable"] = _workspace_writable(workspace_root)
    return report


def recommend_provider(providers: Mapping[str, Mapping[str, Any]]) -> str:
    """Best ready path by custody rank; the legacy local path is the last resort.

    A custom gateway is never recommended automatically: its host must be
    pinned explicitly by the user.
    """

    ready = [
        provider_id
        for provider_id, entry in providers.items()
        if provider_id != "custom-gateway" and (entry.get("credential_present") or entry.get("cli_found"))
    ]
    ready.sort(key=lambda provider_id: (PROVIDERS[provider_id]["security_rank"], provider_id))
    return ready[0] if ready else "local-lm-studio"


def _workspace_writable(workspace_root: str | Path) -> bool:
    """Write and remove a unique sentinel in the build tree, as the real writers would."""

    try:
        paths = WorkspacePaths.create(workspace_root)
        sentinel = paths.build / f".init-check-{uuid4().hex}.tmp"
        write_text_bounded(sentinel, "ok", 16, boundary=paths.workspace)
        sentinel.unlink(missing_ok=True)
        return True
    except (SecurityBoundaryError, OSError):
        return False


# ---------------------------------------------------------------------------
# Planning
# ---------------------------------------------------------------------------


def build_plan(
    *,
    provider: str,
    python_profile: str = "analysis",
    r_profile: str = "none",
    design_name: str = "workspace_starter",
    chassis: str = "ecoli_k12",
    key_env: str | None = None,
    model: str | None = None,
    base_url: str | None = None,
    protocol: str | None = None,
    credential_mode: str = "isolated",
    out_dir: str | Path = DEFAULT_INIT_DIR,
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
    if credential_mode not in CREDENTIAL_MODES:
        raise InitError("INVALID_CREDENTIAL_MODE", f"Credential mode must be one of: {', '.join(CREDENTIAL_MODES)}.")
    if model is not None and (not _MODEL_ID.fullmatch(model) or ".." in model):
        raise InitError("INVALID_MODEL", "Model must be a provider model ID of at most 128 safe characters.")

    spec = PROVIDERS[provider]
    kind = spec["kind"]
    if kind != "api_gateway" and (base_url is not None or protocol is not None):
        raise InitError("GATEWAY_OPTION_NOT_APPLICABLE", "--base-url and --protocol apply only to the custom-gateway provider.")
    if kind not in {"api_key_env", "api_gateway"} and key_env is not None:
        raise InitError("KEY_ENV_NOT_APPLICABLE", "--key-env applies only to API-key and gateway providers.")

    env = os.environ if environ is None else environ
    detected = detect_environment(env, which)
    relative_out = _relative_out_parts(out_dir)
    warnings: list[str] = []
    notes: list[str] = []
    next_steps: list[str] = []
    credential_homes: list[str] = []
    rank = spec["security_rank"]
    provider_config: dict[str, Any] = {"id": provider, "kind": kind}
    if model is not None:
        provider_config["model"] = model

    if kind == "api_key_env":
        variable = _credential_variable(spec, key_env)
        provider_config.update(
            {
                "host": spec["host"],
                "credential_environment": variable,
                "credential_storage": "environment_only",
            }
        )
        notes.append("The key is read from the environment at call time and is never written to disk by Proto Agent.")
        notes.append("The provider host is pinned in code; editing the manifest cannot redirect a credentialed request.")
        if not detected["providers"][provider]["credential_present"] and variable == spec["credential_environment"]:
            warnings.append(f"{variable} is not set in this shell; set it before running model-backed work.")
        next_steps.append(f"Export {variable} in your shell or secret manager (do not commit it).")
        next_steps.append("proto-agent init verify --approve-network")
    elif kind == "api_gateway":
        if base_url is None:
            raise InitError("GATEWAY_BASE_URL_REQUIRED", "--base-url is required for the custom-gateway provider.")
        if model is None:
            raise InitError("GATEWAY_MODEL_REQUIRED", "--model is required for the custom-gateway provider.")
        if protocol is None or protocol not in GATEWAY_PROTOCOLS:
            raise InitError("INVALID_PROTOCOL", f"--protocol must be one of: {', '.join(GATEWAY_PROTOCOLS)}.")
        gateway = parse_gateway_url(base_url)
        variable = _credential_variable(spec, key_env) if (key_env is not None or not gateway["loopback"]) else None
        provider_config.update(
            {
                "base_url": gateway["base_url"],
                "host": gateway["host"],
                "protocol": protocol,
                "loopback": gateway["loopback"],
                "credential_storage": "environment_only" if variable else "none",
            }
        )
        if variable:
            provider_config["credential_environment"] = variable
            if not str(env.get(variable, "")).strip():
                warnings.append(f"{variable} is not set in this shell; set it before running model-backed work.")
            next_steps.append(f"Export {variable} in your shell or secret manager (do not commit it).")
        if gateway["loopback"]:
            rank = 3
            provider_config["fallback"] = True
            warnings.append("Loopback gateway: traffic stays on this machine, so it ranks with the local-only fallback.")
        else:
            notes.append(f"Only {gateway['host']} will receive the key, and only after --approve-host {gateway['host']}.")
        notes.append("Gateways differ: a models route that is absent is reported as 'incompatible', not as a missing model.")
        next_steps.append(
            "proto-agent init verify --approve-network" + ("" if gateway["loopback"] else f" --approve-host {gateway['host']}")
        )
    elif kind == "subscription_cli":
        executable = spec["executable"]
        provider_config.update({"executable": executable, "credential_mode": credential_mode})
        if not detected["providers"][provider]["cli_found"]:
            warnings.append(f"The {executable} CLI was not found on PATH; install it and sign in before use.")
        if credential_mode == "isolated":
            home = "/".join([*relative_out, CREDENTIALS_DIR, provider])
            provider_config.update(
                {
                    "credential_storage": "delegated_isolated_home",
                    "credential_home_environment": spec["home_environment"],
                    "credential_home": home,
                }
            )
            credential_homes.append(home)
            notes.append("The login lives in a workspace-isolated directory, separate from the CLI's default profile.")
            next_steps.append(
                f"Set {spec['home_environment']} to the absolute path of {home}, then sign in with the {executable} "
                f"CLI (for example `{spec['login_hint']}`). No token is requested, stored or logged by Proto Agent."
            )
        else:
            provider_config["credential_storage"] = "delegated_shared_profile"
            warnings.append(
                f"Shared mode: the login lives in the {executable} CLI's default profile and is shared with every other "
                "project on this machine. Prefer --credential-mode isolated."
            )
            next_steps.append(f"Sign in with the {executable} CLI if you have not already.")
        notes.append("Authentication is delegated to the provider CLI; Proto Agent never reads its credential store.")
    else:
        provider_config.update({"base_url": spec["base_url"], "credential_storage": "none", "fallback": True})
        warnings.append(
            "Legacy local-only path: lowest priority. It has no provider-side key revocation or audit trail; "
            "prefer an API or subscription provider when available."
        )
        next_steps.append("Use the existing LM Studio connector checks: proto-agent connectors check.")
    provider_config["security_rank"] = rank

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
    manifest_text = _dump(manifest)
    if looks_like_secret(manifest_text):
        raise InitError("SECRET_SHAPED_CONTENT", "Manifest contains a secret-shaped string; nothing was written.")
    files[MANIFEST_NAME] = manifest_text
    return {
        "ok": True,
        "provider": provider,
        "provider_label": spec["label"],
        "security_rank": rank,
        "detected": detected,
        "files": files,
        "manifest": manifest,
        "credential_homes": credential_homes,
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


def parse_gateway_url(value: str) -> dict[str, Any]:
    """Validate a user-pinned gateway root.

    Remote hosts must be HTTPS DNS names (an IP literal could target metadata or
    internal services); only loopback may use plain HTTP.  Credentials, query
    strings and fragments in the URL are rejected.
    """

    if not isinstance(value, str) or not value.strip() or len(value) > MAX_BASE_URL_CHARS or looks_like_secret(value):
        raise InitError("INVALID_BASE_URL", "--base-url must be an http(s) URL of at most 256 characters without credentials.")
    try:
        parts = urllib.parse.urlsplit(value.strip())
        port = parts.port
    except ValueError as exc:
        raise InitError("INVALID_BASE_URL", "--base-url is not a valid URL.") from exc
    host = (parts.hostname or "").lower()
    path = parts.path.rstrip("/")
    if parts.scheme not in {"http", "https"} or not host:
        raise InitError("INVALID_BASE_URL", "--base-url must start with http:// or https:// and name a host.")
    if parts.username is not None or parts.password is not None or parts.query or parts.fragment or "@" in parts.netloc:
        raise InitError("INVALID_BASE_URL", "--base-url must not contain credentials, a query string or a fragment.")
    if not _URL_PATH.fullmatch(path) or any(segment in {".", ".."} for segment in path.split("/")):
        raise InitError("INVALID_BASE_URL", "--base-url path contains unsupported characters.")
    loopback = _is_loopback(host)
    if not loopback:
        if parts.scheme != "https":
            raise InitError("GATEWAY_REQUIRES_HTTPS", "Remote gateways must use https://; plain http:// is allowed only for loopback.")
        if _is_ip_literal(host):
            raise InitError("GATEWAY_IP_LITERAL", "Remote gateways must be addressed by DNS name, not an IP address.")
        if not _HOSTNAME.fullmatch(host):
            raise InitError("INVALID_BASE_URL", "--base-url host is not a valid DNS name.")
    authority = f"[{host}]" if ":" in host else host
    if port is not None:
        authority = f"{authority}:{port}"
    return {
        "scheme": parts.scheme,
        "host": host,
        "port": port,
        "loopback": loopback,
        "base_url": f"{parts.scheme}://{authority}{path}",
    }


def gateway_origin(base_url: str) -> str:
    """Scheme, host and port with default ports dropped, so two spellings of one origin compare equal."""

    endpoint = parse_gateway_url(base_url)
    port = endpoint["port"]
    default = 443 if endpoint["scheme"] == "https" else 80
    host = f"[{endpoint['host']}]" if ":" in endpoint["host"] else endpoint["host"]
    return f"{endpoint['scheme']}://{host}" + (f":{port}" if port is not None and port != default else "")


def _is_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


def _is_loopback(host: str) -> bool:
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


# ---------------------------------------------------------------------------
# Apply
# ---------------------------------------------------------------------------


def apply_plan(
    plan: Mapping[str, Any],
    *,
    workspace_root: str | Path | None = None,
    out_dir: str | Path = DEFAULT_INIT_DIR,
    force: bool = False,
) -> dict[str, Any]:
    """Write the plan.  Re-applying an identical configuration changes nothing."""

    started = time.perf_counter()
    paths = WorkspacePaths.create(workspace_root)
    out_parts = _relative_out_parts(out_dir)
    for home in plan["credential_homes"]:
        if home.split("/")[: len(out_parts)] != out_parts:
            raise InitError("PLAN_OUT_DIR_MISMATCH", "Plan and apply must use the same --out-dir.")
    target = paths.ensure_directory(_relative_out_dir(paths, out_dir), boundary=paths.workspace)
    manifest_path = target / MANIFEST_NAME
    files: Mapping[str, str] = plan["files"]
    if manifest_path.exists():
        differing = _differing_sections(manifest_path, plan["manifest"])
        if not differing and _generated_files_match(target, files):
            return {
                "ok": True,
                "changed": False,
                "provider": plan["provider"],
                "written": [],
                "unchanged": [(target / name).relative_to(paths.workspace).as_posix() for name in (*GENERATED_FILES, MANIFEST_NAME)],
                "warnings": plan["warnings"],
                "next_steps": plan["next_steps"],
                "metrics": _metrics(started, files_written=0),
            }
        if not force:
            raise InitError(
                "WORKSPACE_ALREADY_INITIALIZED",
                "A different workspace configuration already exists"
                + (f" (differs in: {', '.join(differing)})" if differing else "")
                + "; pass --force to replace it.",
            )
    written: list[str] = []
    for home in plan["credential_homes"]:
        written.extend(_prepare_credential_home(paths, home))
    # The manifest goes last so it exists only when every file it digests was written.
    for name in (*GENERATED_FILES, MANIFEST_NAME):
        write_text_bounded(target / name, files[name], MAX_TEXT_FILE_BYTES, boundary=paths.workspace)
        written.append((target / name).relative_to(paths.workspace).as_posix())
    return {
        "ok": True,
        "changed": True,
        "provider": plan["provider"],
        "written": written,
        "unchanged": [],
        "warnings": plan["warnings"],
        "next_steps": plan["next_steps"],
        "metrics": _metrics(started, files_written=len(written)),
    }


def _prepare_credential_home(paths: WorkspacePaths, home: str) -> list[str]:
    """Create an owner-only credential directory that Git can never pick up."""

    directory = paths.ensure_directory(paths.workspace.joinpath(*home.split("/")), boundary=paths.workspace)
    if os.name != "nt":
        os.chmod(directory, stat_module.S_IRWXU)
    guard = directory / ".gitignore"
    if not guard.exists():
        write_text_bounded(guard, "*\n", 16, boundary=paths.workspace)
    return [guard.relative_to(paths.workspace).as_posix()]


def _differing_sections(manifest_path: Path, planned: Mapping[str, Any]) -> list[str]:
    try:
        existing = strict_json_loads(read_text_bounded(manifest_path, MAX_JSON_FILE_BYTES), max_bytes=MAX_JSON_FILE_BYTES)
    except (SecurityBoundaryError, JsonValidationError):
        return ["manifest"]
    if not isinstance(existing, dict):
        return ["manifest"]
    keys = (set(existing) | set(planned)) - {"generated_at"}
    return sorted(key for key in keys if existing.get(key) != planned.get(key))


def _generated_files_match(target: Path, files: Mapping[str, str]) -> bool:
    for name in GENERATED_FILES:
        try:
            if read_text_bounded(target / name, MAX_TEXT_FILE_BYTES) != files[name]:
                return False
        except (SecurityBoundaryError, OSError):
            return False
    return True


def _metrics(started: float, *, files_written: int, network_requests: int = 0) -> dict[str, Any]:
    return {
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
        "files_written": files_written,
        "network_requests": network_requests,
    }


# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------


def workspace_status(
    *,
    workspace_root: str | Path | None = None,
    out_dir: str | Path = DEFAULT_INIT_DIR,
    environ: Mapping[str, str] | None = None,
    which: Callable[[str], str | None] = shutil.which,
) -> dict[str, Any]:
    """Re-check a written configuration: schema, digests, secrets, and readiness.

    ``ok`` means the configuration is intact; ``ready`` additionally requires the
    runtimes and credentials it names to be present.  Readiness is presence
    only: it is not a live authorization result (use ``verify``).
    """

    started = time.perf_counter()
    env = os.environ if environ is None else environ
    paths = WorkspacePaths.create(workspace_root)
    relative_dir = _relative_out_dir(paths, out_dir).relative_to(paths.workspace).as_posix()
    issues: list[dict[str, str]] = []
    try:
        manifest_file = paths.workspace_file(f"{relative_dir}/{MANIFEST_NAME}", extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
        manifest_text = read_text_bounded(manifest_file, MAX_JSON_FILE_BYTES)
        manifest = strict_json_loads(manifest_text, max_bytes=MAX_JSON_FILE_BYTES)
    except (SecurityBoundaryError, JsonValidationError) as exc:
        return {
            "ok": False,
            "ready": False,
            "initialized": False,
            "issues": [{"code": getattr(exc, "code", "INVALID_JSON"), "message": str(exc)}],
            "next": [{"code": "initialize", "argv": ["init", "apply"]}],
            "metrics": _metrics(started, files_written=0),
        }

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
    provider = provider if isinstance(provider, dict) else {}
    checks: dict[str, dict[str, str]] = {}
    next_actions: list[dict[str, Any]] = []
    verification: dict[str, Any] = {"state": "never"}
    if not problems:
        verification = _verification_state(paths, relative_dir, manifest)
        checks, next_actions = _readiness(paths, manifest, provider, env, which, verification)
    if issues:
        next_actions.insert(0, {"code": "repair_configuration", "argv": ["init", "apply", "--force"]})
    credential: dict[str, Any] = {}
    variable = provider.get("credential_environment")
    if isinstance(variable, str):
        credential = {"credential_environment": variable, "credential_present": bool(env.get(variable, "").strip())}
    ready = not issues and all(check["status"] in {"ready", "disabled", "unverified"} for check in checks.values())
    return {
        "ok": not issues,
        "ready": ready,
        "initialized": True,
        "directory": relative_dir,
        "provider": provider.get("id"),
        **credential,
        "verification": verification,
        **({"configuration": _configuration_summary(manifest, provider)} if not problems else {}),
        "checks": checks,
        "next": next_actions,
        "issues": issues,
        "metrics": _metrics(started, files_written=0),
    }


def _configuration_summary(manifest: Mapping[str, Any], provider: Mapping[str, Any]) -> dict[str, Any]:
    """The saved, non-secret choices, so an interface can show and edit them faithfully."""

    python_section = manifest.get("python")
    r_section = manifest.get("r")
    return {
        "provider": dict(provider),
        "python_profile": python_section.get("profile") if isinstance(python_section, dict) else None,
        "r_profile": r_section.get("profile") if isinstance(r_section, dict) else None,
    }


def _readiness(
    paths: WorkspacePaths,
    manifest: Mapping[str, Any],
    provider: Mapping[str, Any],
    env: Mapping[str, str],
    which: Callable[[str], str | None],
    verification: Mapping[str, Any],
) -> tuple[dict[str, dict[str, str]], list[dict[str, Any]]]:
    checks: dict[str, dict[str, str]] = {}
    next_actions: list[dict[str, Any]] = []
    kind = provider.get("kind")
    variable = provider.get("credential_environment")
    if kind in {"api_key_env", "api_gateway"} and isinstance(variable, str):
        if str(env.get(variable, "")).strip():
            argv = ["init", "verify", "--approve-network"]
            if kind == "api_gateway" and not provider.get("loopback"):
                argv += ["--approve-host", str(provider.get("host"))]
            state = verification.get("state")
            if state == "verified":
                checks["provider"] = {"status": "ready", "reason": "verified"}
            elif state == "failed":
                category = str(verification.get("category"))
                checks["provider"] = {"status": "not_ready", "reason": f"verify_failed_{category}"}
                action = dict(_CATEGORY_ACTIONS.get(category, _CATEGORY_ACTIONS["unknown"]))
                if action["code"] == "check_credential":
                    action["variable"] = variable
                if action["code"] == "retry_verify":
                    action["argv"] = argv
                next_actions.append(action)
            else:
                reason = "verification_stale" if state == "stale" else "credential_present_not_verified"
                checks["provider"] = {"status": "unverified", "reason": reason}
                next_actions.append({"code": "verify_provider", "argv": argv})
        else:
            checks["provider"] = {"status": "not_ready", "reason": "credential_missing"}
            next_actions.append({"code": "set_environment", "variable": variable})
    elif kind == "api_gateway":
        checks["provider"] = {"status": "unverified", "reason": "keyless_loopback"}
    elif kind == "subscription_cli":
        executable = provider.get("executable")
        if not isinstance(executable, str) or which(executable) is None:
            checks["provider"] = {"status": "not_ready", "reason": "cli_missing"}
            next_actions.append({"code": "install_cli", "executable": executable})
        else:
            checks["provider"] = {"status": "unverified", "reason": "login_not_probed"}
        home = provider.get("credential_home")
        if isinstance(home, str):
            try:
                paths.workspace_entry(home)
            except (SecurityBoundaryError, OSError):
                checks["credential_home"] = {"status": "not_ready", "reason": "isolated_home_missing"}
                next_actions.append({"code": "repair_configuration", "argv": ["init", "apply", "--force"]})
            else:
                checks["credential_home"] = {"status": "ready", "reason": "isolated_home_present"}
    else:
        checks["provider"] = {"status": "unverified", "reason": "local_only_not_probed"}
    checks["python"] = (
        {"status": "ready", "reason": "supported_version"}
        if sys.version_info >= (3, 10)
        else {"status": "not_ready", "reason": "python_too_old"}
    )
    r_section = manifest.get("r")
    r_profile = r_section.get("profile") if isinstance(r_section, dict) else None
    if r_profile in R_PROFILES and R_PROFILES[r_profile]["enabled"]:
        if which("Rscript") is None:
            checks["r"] = {"status": "not_ready", "reason": "rscript_missing"}
            next_actions.append({"code": "configure_r_runtime", "argv": ["sandbox", "status"]})
        else:
            checks["r"] = {"status": "ready", "reason": "rscript_found"}
    else:
        checks["r"] = {"status": "disabled", "reason": "r_profile_none"}
    return checks, next_actions


# ---------------------------------------------------------------------------
# Catalog (data for UIs) and one-shot start
# ---------------------------------------------------------------------------


def provider_catalog() -> dict[str, Any]:
    """Everything a UI needs to render the setup choices, so none of it is hardcoded there."""

    providers = []
    for provider_id, spec in PROVIDERS.items():
        entry: dict[str, Any] = {
            "id": provider_id,
            "label": spec["label"],
            "kind": spec["kind"],
            "security_rank": spec["security_rank"],
            "fallback": spec["kind"] == "local_only",
            "requires": ["base_url", "model", "protocol"] if spec["kind"] == "api_gateway" else [],
        }
        if spec["kind"] == "api_key_env":
            entry["pinned_host"] = spec["host"]
        if spec["kind"] in {"api_key_env", "api_gateway"}:
            entry["credential_environment"] = spec["credential_environment"]
        if spec["kind"] == "subscription_cli":
            entry["executable"] = spec["executable"]
            entry["home_environment"] = spec["home_environment"]
        providers.append(entry)
    return {
        "providers": providers,
        "python_profiles": [{"id": key, "summary": value["summary"], "extras": value["extras"]} for key, value in PYTHON_PROFILES.items()],
        "r_profiles": [
            {"id": key, "summary": value["summary"], "enabled": value["enabled"], "packages": value["packages"]}
            for key, value in R_PROFILES.items()
        ],
        "gateway_protocols": list(GATEWAY_PROTOCOLS),
        "credential_modes": list(CREDENTIAL_MODES),
        "validation_categories": list(VALIDATION_CATEGORIES),
        "default_out_dir": DEFAULT_INIT_DIR.as_posix(),
    }


def start_workspace(
    *,
    workspace_root: str | Path | None = None,
    out_dir: str | Path = DEFAULT_INIT_DIR,
    force: bool = False,
    verify: bool = False,
    approve_network: bool = False,
    approve_host: str | None = None,
    environ: Mapping[str, str] | None = None,
    opener: urllib.request.OpenerDirector | None = None,
    **plan_options: Any,
) -> dict[str, Any]:
    """Plan, apply, optionally verify and re-read status in one process (one spawn for a UI)."""

    started = time.perf_counter()
    plan = build_plan(out_dir=out_dir, environ=environ, **plan_options)
    applied = apply_plan(plan, workspace_root=workspace_root, out_dir=out_dir, force=force)
    verification: dict[str, Any] | None = None
    if verify:
        verification = verify_provider(
            plan["provider"],
            approve_network=approve_network,
            environ=environ,
            model=plan["manifest"]["provider"].get("model"),
            config=plan["manifest"]["provider"],
            approve_host=approve_host,
            opener=opener,
        )
        record_verification(verification, workspace_root=workspace_root, out_dir=out_dir)
    status = workspace_status(workspace_root=workspace_root, out_dir=out_dir, environ=environ)
    return {
        "ok": bool(applied["ok"] and (verification is None or verification["ok"])),
        "apply": applied,
        "verify": verification,
        "status": status,
        "metrics": _metrics(
            started,
            files_written=applied["metrics"]["files_written"],
            network_requests=verification["metrics"]["network_requests"] if verification else 0,
        ),
    }


# Failure categories name the repair; a UI or agent can act on them without parsing prose.
_CATEGORY_ACTIONS: dict[str, dict[str, Any]] = {
    "auth": {"code": "check_credential"},
    "model-not-found": {"code": "choose_model"},
    "bad-url": {"code": "check_base_url"},
    "incompatible": {"code": "check_gateway_protocol"},
    "network": {"code": "retry_verify"},
    "timeout": {"code": "retry_verify"},
    "server-error": {"code": "retry_verify"},
    "unknown": {"code": "retry_verify"},
}


def config_digest(manifest: Mapping[str, Any]) -> str:
    """Digest of the configuration that matters, ignoring only the generation time."""

    return _sha256(_dump({key: value for key, value in manifest.items() if key != "generated_at"}))


def record_verification(
    result: Mapping[str, Any],
    *,
    workspace_root: str | Path | None = None,
    out_dir: str | Path = DEFAULT_INIT_DIR,
) -> bool:
    """Persist the outcome of a verify that reached the network.  Holds no credential.

    Requests refused before sending (no approval, missing key, ...) are not recorded:
    they say nothing about the provider.
    """

    metrics = result.get("metrics")
    if not isinstance(metrics, Mapping) or metrics.get("network_requests") != 1:
        return False
    paths = WorkspacePaths.create(workspace_root)
    relative_dir = _relative_out_dir(paths, out_dir).relative_to(paths.workspace).as_posix()
    try:
        manifest_file = paths.workspace_file(f"{relative_dir}/{MANIFEST_NAME}", extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
        manifest = strict_json_loads(read_text_bounded(manifest_file, MAX_JSON_FILE_BYTES), max_bytes=MAX_JSON_FILE_BYTES)
    except (SecurityBoundaryError, JsonValidationError):
        return False
    if _manifest_problems(manifest) or result.get("provider") != manifest["provider"].get("id"):
        return False
    record = {
        "schema_version": VERIFICATION_SCHEMA_VERSION,
        "verified_at": datetime.now(timezone.utc).isoformat(),
        "provider": result["provider"],
        "host": result.get("host"),
        "model": result.get("model"),
        "model_probe": bool(result.get("model_probe")),
        "ok": bool(result.get("ok")),
        "category": result.get("category") if result.get("category") in VALIDATION_CATEGORIES else "unknown",
        "http_status": result.get("http_status"),
        "config_digest": config_digest(manifest),
    }
    text = _dump(record)
    if looks_like_secret(text):
        return False
    target = paths.ensure_directory(_relative_out_dir(paths, out_dir), boundary=paths.workspace)
    write_text_bounded(target / VERIFICATION_NAME, text, MAX_TEXT_FILE_BYTES, boundary=paths.workspace)
    return True


def _verification_state(paths: WorkspacePaths, relative_dir: str, manifest: Mapping[str, Any]) -> dict[str, Any]:
    """Last recorded verify: never, verified, failed, stale (configuration changed) or unknown."""

    try:
        path = paths.workspace_file(f"{relative_dir}/{VERIFICATION_NAME}", extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
    except SecurityBoundaryError:
        return {"state": "never"}
    try:
        record = strict_json_loads(read_text_bounded(path, MAX_JSON_FILE_BYTES), max_bytes=MAX_JSON_FILE_BYTES)
    except (SecurityBoundaryError, JsonValidationError):
        return {"state": "unknown"}
    if not isinstance(record, dict) or select_artifact_reader("proto-agent.workspace-verification", record)["readOnly"]:
        return {"state": "unknown"}
    summary = {
        "verified_at": record.get("verified_at"),
        "category": record.get("category"),
        "http_status": record.get("http_status"),
        "host": record.get("host"),
        "model": record.get("model"),
    }
    if record.get("config_digest") != config_digest(manifest) or record.get("provider") != (manifest.get("provider") or {}).get("id"):
        return {"state": "stale", **summary, "reason": "configuration_changed"}
    return {"state": "verified" if record.get("ok") is True else "failed", **summary}


# ---------------------------------------------------------------------------
# Live verification
# ---------------------------------------------------------------------------


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect could forward the credential to another host; refuse all of them."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        raise urllib.error.HTTPError(req.full_url, code, "Redirects are not permitted for credentialed requests.", headers, fp)


def classify_http_status(status: int, *, model_probe: bool, gateway: bool) -> str:
    """Map an HTTP status to a typed validation category."""

    if 200 <= status < 300:
        return "ok"
    if status in {401, 403}:
        return "auth"
    if status in {404, 405, 501}:
        if gateway:
            return "incompatible"
        if status == 404:
            return "model-not-found" if model_probe else "bad-url"
        return "unknown"
    if status == 408:
        return "timeout"
    if status == 429 or status >= 500:
        return "server-error"
    return "unknown"


def verify_provider(
    provider: str,
    *,
    approve_network: bool,
    environ: Mapping[str, str] | None = None,
    key_env: str | None = None,
    model: str | None = None,
    config: Mapping[str, Any] | None = None,
    approve_host: str | None = None,
    bind_origin: str | None = None,
    opener: urllib.request.OpenerDirector | None = None,
) -> dict[str, Any]:
    """One approved, credentialed ``GET`` that probes the exact configured model.

    Official providers use the host pinned in ``PROVIDERS``.  A custom gateway
    uses the host from ``config`` (the workspace manifest) and additionally
    needs ``approve_host`` to equal it, so a tampered manifest cannot silently
    redirect the key.
    """

    started = time.perf_counter()
    spec = PROVIDERS.get(provider)
    if spec is None:
        raise InitError("UNKNOWN_PROVIDER", f"Provider must be one of: {', '.join(sorted(PROVIDERS))}.")
    base: dict[str, Any] = {"provider": provider}

    def refuse(category: str, code: str, message: str) -> dict[str, Any]:
        return {**base, "ok": False, "category": category, "code": code, "message": message, "metrics": _metrics(started, files_written=0)}

    if spec["kind"] not in {"api_key_env", "api_gateway"}:
        return refuse("incompatible", "VERIFY_NOT_APPLICABLE", "Only API-key and gateway providers support a live handshake.")
    if not approve_network:
        return refuse("unknown", "NETWORK_NOT_APPROVED", "Pass --approve-network to allow this one request.")

    gateway = spec["kind"] == "api_gateway"
    config = config or {}
    model = model or config.get("model")
    if model is not None and (not _MODEL_ID.fullmatch(str(model)) or ".." in str(model)):
        raise InitError("INVALID_MODEL", "Model must be a provider model ID of at most 128 safe characters.")
    keyless = False
    variable: str | None
    if gateway:
        stored_url = config.get("base_url")
        if not isinstance(stored_url, str) or not isinstance(model, str):
            return refuse("bad-url", "CONFIG_REQUIRED", "Gateway verification needs the stored workspace configuration (run init apply first).")
        pinned = parse_gateway_url(stored_url)
        if bind_origin is not None and gateway_origin(stored_url) != bind_origin:
            # The caller holds the trusted binding for the key; the saved address no longer matches it.
            return refuse("bad-url", "BINDING_MISMATCH", "The saved gateway address differs from the address this key was stored for.")
        if not pinned["loopback"] and approve_host != pinned["host"]:
            return refuse("unknown", "HOST_NOT_APPROVED", f"Pass --approve-host {pinned['host']} to send the key to this gateway.")
        protocol = config.get("protocol")
        if protocol not in GATEWAY_PROTOCOLS:
            return refuse("incompatible", "INVALID_PROTOCOL", "Stored gateway protocol is not supported.")
        keyless = pinned["loopback"] and not config.get("credential_environment") and key_env is None
        variable = None if keyless else _credential_variable(spec, key_env or config.get("credential_environment"))
        url = f"{pinned['base_url']}/models/{urllib.parse.quote(str(model), safe='')}"
        host = pinned["host"]
        auth_header, auth_prefix, extra_headers = (
            ("x-api-key", "", {"anthropic-version": "2023-06-01"}) if protocol == "messages" else ("Authorization", "Bearer ", {})
        )
    else:
        variable = _credential_variable(spec, key_env or config.get("credential_environment"))
        host = spec["host"]
        route = f"{spec['models_route']}/{urllib.parse.quote(model, safe='')}" if model else spec["models_route"]
        url = f"https://{host}{route}"
        auth_header, auth_prefix, extra_headers = spec["auth_header"], spec["auth_prefix"], spec["extra_headers"]

    env = os.environ if environ is None else environ
    credential = ""
    if not keyless:
        credential = str(env.get(variable or "", "")).strip()
        if not credential:
            return refuse("auth", "CREDENTIAL_MISSING", f"{variable} is not set.")
        if len(credential) > MAX_CREDENTIAL_CHARS or not credential.isprintable() or any(character.isspace() for character in credential):
            return refuse("auth", "CREDENTIAL_MALFORMED", f"{variable} does not look like an API key.")
    headers = {"Accept": "application/json", "User-Agent": "proto-agent-init/1.0", **extra_headers}
    if credential:
        headers[auth_header] = f"{auth_prefix}{credential}"
    request = urllib.request.Request(url, headers=headers, method="GET")
    handlers: list[Any] = [_NoRedirect()]
    if url.startswith("https://"):
        handlers.append(urllib.request.HTTPSHandler(context=_ssl_context()))
    active = opener or urllib.request.build_opener(*handlers)
    result: dict[str, Any] = {**base, "host": host, "model": model, "model_probe": bool(model)}
    try:
        with active.open(request, timeout=VERIFY_TIMEOUT_SECONDS) as response:
            raw = response.read(MAX_VERIFY_RESPONSE_BYTES + 1)
            status = getattr(response, "status", 200)
    except urllib.error.HTTPError as error:
        return {
            **result,
            "ok": False,
            "category": classify_http_status(error.code, model_probe=bool(model), gateway=gateway),
            "code": "HTTP_ERROR",
            "http_status": error.code,
            "message": _redact(f"Provider returned HTTP {error.code}.", credential),
            "metrics": _metrics(started, files_written=0, network_requests=1),
        }
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        reason = getattr(error, "reason", error)
        timed_out = isinstance(error, TimeoutError) or isinstance(reason, (TimeoutError, socket.timeout))
        return {
            **result,
            "ok": False,
            "category": "timeout" if timed_out else "network",
            "code": "NETWORK_ERROR",
            "message": _redact(f"Request failed: {type(reason).__name__}.", credential),
            "metrics": _metrics(started, files_written=0, network_requests=1),
        }
    if len(raw) > MAX_VERIFY_RESPONSE_BYTES:
        return {
            **result,
            "ok": False,
            "category": "incompatible",
            "code": "RESPONSE_TOO_LARGE",
            "http_status": status,
            "message": "Response exceeded the byte limit.",
            "metrics": _metrics(started, files_written=0, network_requests=1),
        }
    category = classify_http_status(status, model_probe=bool(model), gateway=gateway)
    model_count: int | None = None
    try:
        body = strict_json_loads(raw.decode("utf-8"), max_bytes=MAX_VERIFY_RESPONSE_BYTES)
        if isinstance(body, dict) and isinstance(body.get("data"), list):
            model_count = len(body["data"])
    except (UnicodeDecodeError, JsonValidationError):
        pass
    result.update({"ok": category == "ok", "category": category, "http_status": status, "model_count": model_count})
    if variable:
        result["credential_environment"] = variable
    result["metrics"] = _metrics(started, files_written=0, network_requests=1)
    return result


def load_manifest_provider(
    *,
    workspace_root: str | Path | None = None,
    out_dir: str | Path = DEFAULT_INIT_DIR,
) -> dict[str, Any] | None:
    """The stored provider section, or None when the workspace is not initialized."""

    paths = WorkspacePaths.create(workspace_root)
    relative_dir = _relative_out_dir(paths, out_dir).relative_to(paths.workspace).as_posix()
    try:
        path = paths.workspace_file(f"{relative_dir}/{MANIFEST_NAME}", extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
        manifest = strict_json_loads(read_text_bounded(path, MAX_JSON_FILE_BYTES), max_bytes=MAX_JSON_FILE_BYTES)
    except (SecurityBoundaryError, JsonValidationError):
        return None
    if _manifest_problems(manifest):
        return None
    return manifest["provider"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _credential_variable(spec: Mapping[str, Any], key_env: str | None) -> str:
    if key_env is None:
        return str(spec["credential_environment"])
    if looks_like_secret(key_env) or not _ENVIRONMENT_NAME.fullmatch(key_env):
        # Never echo the argument: it may be a pasted key.
        raise InitError("INVALID_KEY_ENV", "--key-env must be an environment-variable NAME such as MY_API_KEY, not a key value.")
    return key_env


def _relative_out_parts(out_dir: str | Path) -> list[str]:
    raw = str(out_dir).replace("\\", "/")
    segments = [part for part in raw.split("/") if part and part != "."]
    if raw.startswith("/") or ".." in segments or not segments or re.match(r"^[A-Za-z]:", raw):
        raise InitError("INVALID_OUT_DIR", "Output directory must be a relative workspace path.")
    return segments


def _relative_out_dir(paths: WorkspacePaths, out_dir: str | Path) -> Path:
    return paths.workspace.joinpath(*_relative_out_parts(out_dir))


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
    return message.replace(credential, "[redacted]") if credential else message


def _ssl_context() -> ssl.SSLContext:
    try:
        import certifi  # type: ignore[import-not-found]

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


# ---------------------------------------------------------------------------
# Command line (shared by `proto-agent init` and `python -m proto_agent.workspace_init`)
# ---------------------------------------------------------------------------


def register_init_commands(subparsers: Any) -> None:
    """Add the ``init`` command group to a parent parser's subparsers."""

    init_parser = subparsers.add_parser(
        "init",
        help="API-first workspace setup: provider, Python, R and Proto configuration without storing secrets.",
    )
    _add_init_subcommands(init_parser)


def _add_init_subcommands(init_parser: argparse.ArgumentParser) -> None:
    sub = init_parser.add_subparsers(dest="init_command", required=True)
    sub.add_parser("detect", help="Offline probe of credential presence, provider CLIs, runtimes and workspace write access (booleans only).")
    sub.add_parser("catalog", help="Machine-readable provider and profile choices for user interfaces.")
    overview = sub.add_parser("overview", help="Catalog, offline detection and current status in one call (for user interfaces).")
    overview.add_argument("--out-dir", default=str(DEFAULT_INIT_DIR))
    for name, help_text in (
        ("plan", "Render the workspace configuration without writing files."),
        ("apply", "Write the workspace configuration under .proto/workspace/ (a repeat of the same configuration is a no-op)."),
        ("start", "Apply, optionally verify, and re-read status in one process (for user interfaces)."),
    ):
        command = sub.add_parser(name, help=help_text)
        command.add_argument("--provider", choices=sorted(PROVIDERS), help="Defaults to the best detected path.")
        command.add_argument("--key-env", help="Environment-variable NAME holding the API key (never the key itself).")
        command.add_argument("--model", help="Provider model ID to validate (required for custom-gateway).")
        command.add_argument("--base-url", help="custom-gateway only: https:// root (http:// only for loopback).")
        command.add_argument("--protocol", choices=sorted(GATEWAY_PROTOCOLS), help="custom-gateway only: API protocol.")
        command.add_argument(
            "--credential-mode",
            choices=list(CREDENTIAL_MODES),
            default="isolated",
            help="Subscription providers: keep the login in a workspace-isolated directory (default) or the CLI's shared profile.",
        )
        command.add_argument("--python-profile", choices=sorted(PYTHON_PROFILES), default="analysis")
        command.add_argument("--r-profile", choices=sorted(R_PROFILES), default="none")
        command.add_argument("--design-name", default="workspace_starter")
        command.add_argument("--chassis", default="ecoli_k12")
        command.add_argument("--out-dir", default=str(DEFAULT_INIT_DIR))
        if name in {"apply", "start"}:
            command.add_argument("--force", action="store_true", help="Replace a different existing workspace configuration.")
        if name == "start":
            command.add_argument("--verify", action="store_true", help="After writing, run the live handshake in the same process.")
            command.add_argument("--approve-network", action="store_true", help="With --verify: authorize the single request.")
            command.add_argument("--approve-host", help="With --verify on a custom gateway: the exact host that may receive the key.")
    status = sub.add_parser("status", help="Re-check digests, secret-shaped content, readiness and the last verification, with next actions.")
    status.add_argument("--out-dir", default=str(DEFAULT_INIT_DIR))
    verify = sub.add_parser("verify", help="One approved handshake that probes the exact configured model.")
    verify.add_argument("--provider", choices=sorted(PROVIDERS), help="Defaults to the initialized workspace's provider.")
    verify.add_argument("--key-env")
    verify.add_argument("--model")
    verify.add_argument("--out-dir", default=str(DEFAULT_INIT_DIR))
    verify.add_argument("--approve-network", action="store_true", help="Authorize this single request.")
    verify.add_argument("--approve-host", help="custom-gateway only: the exact gateway host that may receive the key.")
    verify.add_argument("--bind-origin", help="custom-gateway only: refuse unless the saved gateway origin equals this trusted value.")


def _emit(payload: Mapping[str, Any], *, stderr: bool = False) -> None:
    print(json.dumps(payload, indent=2, allow_nan=False), file=sys.stderr if stderr else sys.stdout)


def run_init_command(args: argparse.Namespace) -> int:
    """Execute a parsed ``init`` command against the current working directory."""

    command = args.init_command
    root = Path.cwd()
    if command == "detect":
        _emit({"ok": True, **detect_environment(workspace_root=root)})
        return 0
    if command == "catalog":
        _emit({"ok": True, **provider_catalog()})
        return 0
    if command == "overview":
        _emit({
            "ok": True,
            "catalog": provider_catalog(),
            "detection": detect_environment(workspace_root=root),
            "status": workspace_status(workspace_root=root, out_dir=args.out_dir),
        })
        return 0
    if command in {"plan", "apply", "start"}:
        options = {
            "provider": args.provider or detect_environment()["recommended_provider"],
            "python_profile": args.python_profile,
            "r_profile": args.r_profile,
            "design_name": args.design_name,
            "chassis": args.chassis,
            "key_env": args.key_env,
            "model": args.model,
            "base_url": args.base_url,
            "protocol": args.protocol,
            "credential_mode": args.credential_mode,
        }
        if command == "plan":
            _emit(public_plan(build_plan(out_dir=args.out_dir, **options)))
            return 0
        if command == "start":
            result = start_workspace(
                workspace_root=root,
                out_dir=args.out_dir,
                force=args.force,
                verify=args.verify,
                approve_network=args.approve_network,
                approve_host=args.approve_host,
                **options,
            )
            _emit(result)
            return 0 if result["ok"] else 1
        plan = build_plan(out_dir=args.out_dir, **options)
        _emit(apply_plan(plan, workspace_root=root, out_dir=args.out_dir, force=args.force))
        return 0
    if command == "status":
        status = workspace_status(workspace_root=root, out_dir=args.out_dir)
        _emit(status)
        return 0 if status["ok"] else 1
    if command == "verify":
        stored = load_manifest_provider(workspace_root=root, out_dir=args.out_dir)
        provider = args.provider or (stored or {}).get("id")
        if provider is None:
            raise InitError("PROVIDER_REQUIRED", "No initialized workspace found; pass --provider or run `proto-agent init apply` first.")
        config = stored if stored and stored.get("id") == provider else None
        if config is None and PROVIDERS[provider]["kind"] == "api_gateway":
            raise InitError("CONFIG_REQUIRED", "Gateway verification needs an initialized workspace for that gateway.")
        verdict = verify_provider(
            provider,
            approve_network=args.approve_network,
            key_env=args.key_env,
            model=args.model,
            config=config,
            approve_host=args.approve_host,
            bind_origin=args.bind_origin,
        )
        if config is not None and not args.model and not args.key_env:
            record_verification(verdict, workspace_root=root, out_dir=args.out_dir)
        if stored is not None:
            verdict = {**verdict, "status": workspace_status(workspace_root=root, out_dir=args.out_dir)}
        _emit(verdict)
        return 0 if verdict["ok"] else 1
    return 2


def main(argv: list[str] | None = None) -> int:
    """Standalone entry: starts in a fraction of the full CLI's import time."""

    parser = argparse.ArgumentParser(prog="proto-agent-init")
    _add_init_subcommands(parser)
    args = parser.parse_args(argv)
    try:
        return run_init_command(args)
    except (InitError, SecurityBoundaryError, ValueError, KeyError, OSError) as exc:
        _emit(
            {
                "ok": False,
                "diagnostics": [{"severity": "error", "file": "", "line": 0, "code": getattr(exc, "code", "INVALID_INPUT"), "message": str(exc)}],
                "artifacts": [],
            },
            stderr=True,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
