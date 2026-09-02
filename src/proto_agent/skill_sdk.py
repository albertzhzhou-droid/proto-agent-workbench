from __future__ import annotations

import hashlib
import re
import stat as stat_module
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from .connectors import DEFAULT_CONNECTORS_PATH, connector_summary
from .json_validation import JsonValidationError, strict_json_loads
from .security import (
    MAX_JSON_FILE_BYTES,
    MAX_TEXT_FILE_BYTES,
    SecurityBoundaryError,
    WorkspacePaths,
    read_bytes_bounded,
)


DEFAULT_SKILLS_ROOT = Path(".codex") / "skills"
SKILL_MANIFEST_NAME = "proto-skill.json"
SKILL_DOCUMENT_NAME = "SKILL.md"
SKILL_SCHEMA_VERSION = "proto-agent.skill-adapter.v1"
MAX_SKILLS = 64
MAX_OPERATIONS = 32
MAX_INTERFACES = 8
MAX_UPSTREAM_SOURCES = 16
MAX_SKILL_CONTENT_FILES = 32
MAX_SKILL_CONTENT_BYTES = 4 * 1024 * 1024

_IDENTIFIER = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
_CONNECTOR_IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
_VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?")
_MCP_TOOL = re.compile(r"[a-z][a-z0-9_]{0,127}")
_HTTP_PATH = re.compile(r"/(?:[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,255})")
_SHA256 = re.compile(r"[0-9a-f]{64}")
_REVISION = re.compile(r"[0-9a-f]{40}")
_MARKDOWN_LINK = re.compile(r"!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+[\"'][^)]*[\"'])?\)")
_FORBIDDEN_VENDOR_PATTERNS = (
    ("host.model_endpoints", re.compile(r"\bhost\.model_endpoints\b", re.IGNORECASE)),
    ("host agent runtime", re.compile(r"\bhost\.(?:agents|skills|compute)\b", re.IGNORECASE)),
    ("host query runtime", re.compile(r"\bhost\.query\s*\(", re.IGNORECASE)),
    ("compute_provider", re.compile(r"\bcompute_provider\b", re.IGNORECASE)),
    ("list_compute", re.compile(r"\blist_compute\b", re.IGNORECASE)),
    ("INFER_API_KEY", re.compile(r"\bINFER_API_KEY\b", re.IGNORECASE)),
    ("ANTHROPIC_API_KEY", re.compile(r"\bANTHROPIC_API_KEY\b", re.IGNORECASE)),
    ("Anthropic Python SDK import", re.compile(r"\b(?:from\s+anthropic\s+import|import\s+anthropic\b)", re.IGNORECASE)),
    ("Anthropic Python SDK client", re.compile(r"\banthropic\.(?:asyncanthropic|anthropic)\b", re.IGNORECASE)),
    ("Anthropic JavaScript runtime", re.compile(r"@anthropic-ai/(?:sdk|claude-code)\b", re.IGNORECASE)),
    ("Claude SDK runtime", re.compile(r"\bclaude[_-](?:sdk|tool)\b", re.IGNORECASE)),
    ("Claude Science session runtime", re.compile(r"\bclaude-science\s+session\b", re.IGNORECASE)),
    (
        "Claude CLI runtime",
        re.compile(
            r"(?<![/\w-])claude(?:-code)?\s+(?:mcp|auth|config|doctor|install|login|logout|plugin|run|serve|update|--?[A-Za-z])\b",
            re.IGNORECASE,
        ),
    ),
)


def list_skill_adapters(
    skills_root: str | Path = DEFAULT_SKILLS_ROOT,
    connector_registry: str | Path = DEFAULT_CONNECTORS_PATH,
    *,
    workspace_root: str | Path | None = None,
) -> dict[str, Any]:
    """Load and resolve declarative skill adapters without executing skill content."""

    paths = WorkspacePaths.create(workspace_root)
    root = paths.workspace_entry(skills_root)
    if not root.is_dir():
        raise SecurityBoundaryError("SKILLS_ROOT_NOT_DIRECTORY", "The configured skills root is not a directory.")
    registry = paths.workspace_file(
        connector_registry,
        extensions={".json"},
        max_bytes=MAX_JSON_FILE_BYTES,
    )
    registry_before = read_bytes_bounded(registry, MAX_JSON_FILE_BYTES)
    try:
        connector_registry_summary = connector_summary(
            registry.relative_to(paths.workspace),
            workspace_root=paths.workspace,
        )
    except ValueError as exc:
        raise SecurityBoundaryError(
            "CONNECTOR_REGISTRY_INVALID",
            f"The connector registry failed strict schema validation: {exc}",
        ) from exc
    issues = connector_registry_summary.get("issues")
    if connector_registry_summary.get("ok") is not True or not isinstance(issues, list) or issues:
        raise SecurityBoundaryError(
            "CONNECTOR_REGISTRY_INVALID",
            "The connector registry reported unresolved integrity or availability issues.",
        )
    connector_ids = [item.get("id") for item in connector_registry_summary.get("connectors", [])]
    if (
        not all(isinstance(item, str) and _CONNECTOR_IDENTIFIER.fullmatch(item) for item in connector_ids)
        or len(set(connector_ids)) != len(connector_ids)
    ):
        raise SecurityBoundaryError(
            "CONNECTOR_REGISTRY_INVALID",
            "Connector IDs must be unique bounded identifiers before Skill capabilities can resolve.",
        )
    capabilities = _connector_capabilities(connector_registry_summary)
    registry_after = read_bytes_bounded(registry, MAX_JSON_FILE_BYTES)
    if registry_after != registry_before:
        raise SecurityBoundaryError(
            "CONNECTOR_REGISTRY_RACE_DETECTED",
            "The connector registry changed while Skill capabilities were being resolved.",
        )
    connector_registry_sha256 = hashlib.sha256(registry_before).hexdigest()

    directories = _skill_directories(root)
    directory_names = [directory.name for directory in directories]
    adapters: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    digest = hashlib.sha256()
    digest.update(b"proto-agent.skill-catalog.v1\0")
    digest.update(bytes.fromhex(connector_registry_sha256))
    for directory in directories:
        content_files, content_payloads = _skill_content_snapshot(paths, directory)
        manifest_bytes = content_payloads[SKILL_MANIFEST_NAME]
        document_bytes = content_payloads[SKILL_DOCUMENT_NAME]
        try:
            manifest_text = manifest_bytes.decode("utf-8")
            document = document_bytes.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError(f"Skill {directory.name} content must be UTF-8 text.") from exc
        try:
            manifest = strict_json_loads(manifest_text, max_bytes=MAX_JSON_FILE_BYTES)
        except JsonValidationError as exc:
            raise ValueError(f"Skill manifest for {directory.name} is not strict bounded JSON: {exc}") from exc
        validated = _validate_manifest(manifest, directory.name, document, set(content_payloads))
        if validated["id"] in seen_ids:
            raise SecurityBoundaryError("DUPLICATE_SKILL_ID", f"Duplicate skill adapter id: {validated['id']}")
        seen_ids.add(validated["id"])
        manifest_digest = hashlib.sha256(manifest_bytes).hexdigest()
        document_digest = hashlib.sha256(document_bytes).hexdigest()
        digest.update(validated["id"].encode("utf-8"))
        digest.update(b"\0")
        for item in content_files:
            digest.update(item["path"].encode("utf-8"))
            digest.update(b"\0")
            digest.update(bytes.fromhex(item["sha256"]))
        adapters.append(
            _resolve_adapter(
                validated,
                capabilities,
                manifest_path=(directory / SKILL_MANIFEST_NAME).relative_to(paths.workspace).as_posix(),
                document_path=(directory / SKILL_DOCUMENT_NAME).relative_to(paths.workspace).as_posix(),
                manifest_sha256=manifest_digest,
                document_sha256=document_digest,
                content_files=content_files,
            )
        )
    if [directory.name for directory in _skill_directories(root)] != directory_names:
        raise SecurityBoundaryError(
            "SKILL_CATALOG_RACE_DETECTED",
            "The Skill directory set changed while the catalog was being assembled.",
        )

    status_counts = {"available": 0, "partial": 0, "unavailable": 0}
    for adapter in adapters:
        status_counts[adapter["status"]] += 1
    return {
        "schema_version": "proto-agent.skill-catalog.v1",
        "ok": True,
        "execution_model": "declarative_resolution_only",
        "resolution_semantics": "available means declared and permitted by the connector registry; it is not execution evidence or a live probe",
        "skills_root": root.relative_to(paths.workspace).as_posix(),
        "connector_registry": registry.relative_to(paths.workspace).as_posix(),
        "connector_registry_sha256": connector_registry_sha256,
        "adapter_count": len(adapters),
        "status_counts": status_counts,
        "catalog_sha256": digest.hexdigest(),
        "adapters": adapters,
        "safety_boundary": (
            "Skill manifests are bounded data. Listing and resolution never execute shell commands, "
            "Python snippets, model calls, network requests, or lifecycle actions."
        ),
    }


def resolve_skill_adapter(
    skill_id: str,
    skills_root: str | Path = DEFAULT_SKILLS_ROOT,
    connector_registry: str | Path = DEFAULT_CONNECTORS_PATH,
    *,
    workspace_root: str | Path | None = None,
) -> dict[str, Any]:
    if not isinstance(skill_id, str) or not _IDENTIFIER.fullmatch(skill_id):
        raise ValueError("Skill id must be a bounded lowercase kebab-case identifier.")
    catalog = list_skill_adapters(
        skills_root,
        connector_registry,
        workspace_root=workspace_root,
    )
    for adapter in catalog["adapters"]:
        if adapter["id"] == skill_id:
            return {
                "schema_version": "proto-agent.skill-resolution.v1",
                "ok": adapter["status"] == "available",
                "catalog_sha256": catalog["catalog_sha256"],
                "connector_registry_sha256": catalog["connector_registry_sha256"],
                "adapter": adapter,
                "safety_boundary": catalog["safety_boundary"],
            }
    raise ValueError(f"Unknown skill adapter: {skill_id}")


def audit_skill_adapters(
    skills_root: str | Path = DEFAULT_SKILLS_ROOT,
    connector_registry: str | Path = DEFAULT_CONNECTORS_PATH,
    *,
    workspace_root: str | Path | None = None,
) -> dict[str, Any]:
    """Perform three independent, read-only checks over the adapter catalog."""

    paths = WorkspacePaths.create(workspace_root)
    catalog = list_skill_adapters(
        skills_root,
        connector_registry,
        workspace_root=paths.workspace,
    )
    findings: list[dict[str, str]] = []
    passes = {
        "local_schema_and_integrity": {"ok": True, "checked": catalog["adapter_count"]},
        "vendor_neutrality": {"ok": True, "checked": 0},
        "capability_and_risk": {"ok": True, "checked": 0},
    }
    skills_root_path = paths.workspace_entry(catalog["skills_root"])
    for adapter in catalog["adapters"]:
        passes["vendor_neutrality"]["checked"] += 1
        directory = skills_root_path / adapter["id"]
        content_files, content_payloads = _skill_content_snapshot(paths, directory)
        if content_files != adapter["content_files"]:
            raise SecurityBoundaryError(
                "SKILL_CONTENT_RACE_DETECTED",
                f"Skill content changed between catalog resolution and audit: {adapter['id']}",
            )
        for relative_name, payload in content_payloads.items():
            try:
                content = payload.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise ValueError(f"Skill {adapter['id']} content must be UTF-8 text: {relative_name}") from exc
            for token, pattern in _FORBIDDEN_VENDOR_PATTERNS:
                if pattern.search(content):
                    findings.append(
                        {
                            "pass": "vendor_neutrality",
                            "skill_id": adapter["id"],
                            "code": "VENDOR_RUNTIME_COUPLING",
                            "message": f"Adapted content still references a vendor runtime token in {relative_name}: {token}",
                        }
                    )
        passes["capability_and_risk"]["checked"] += 1
        if adapter["policy"].get("execution") != "declarative":
            findings.append(
                {
                    "pass": "capability_and_risk",
                    "skill_id": adapter["id"],
                    "code": "NON_DECLARATIVE_EXECUTION",
                    "message": "Project adapters must remain declarative and resolve only to governed interfaces.",
                }
            )
        if adapter["missing_required_operations"]:
            findings.append(
                {
                    "pass": "capability_and_risk",
                    "skill_id": adapter["id"],
                    "code": "REQUIRED_CAPABILITY_UNAVAILABLE",
                    "message": "No declared interface resolves for one or more required operations.",
                }
            )

    for finding in findings:
        passes[finding["pass"]]["ok"] = False
    return {
        "schema_version": "proto-agent.skill-audit.v1",
        "ok": not findings,
        "catalog_sha256": catalog["catalog_sha256"],
        "connector_registry_sha256": catalog["connector_registry_sha256"],
        "pass_count": len(passes),
        "passes": passes,
        "findings": findings,
        "status_counts": catalog["status_counts"],
        "upstream_content_verification": {
            "status": "recorded_only",
            "live_fetch_performed": False,
            "message": (
                "Pinned upstream revisions and content_sha256 claims are retained, but this local audit does not "
                "download or independently attest upstream content."
            ),
        },
        "safety_boundary": catalog["safety_boundary"],
    }


def _skill_directories(root: Path) -> list[Path]:
    directories: list[Path] = []
    for entry in sorted(root.iterdir(), key=lambda item: item.name):
        try:
            info = entry.stat(follow_symlinks=False)
        except OSError as exc:
            raise SecurityBoundaryError("SKILL_PATH_UNREADABLE", f"Unable to inspect skill path: {entry.name}") from exc
        if not stat_module.S_ISDIR(info.st_mode):
            raise SecurityBoundaryError("SKILL_ENTRY_NOT_DIRECTORY", f"Unexpected entry in skills root: {entry.name}")
        if not _IDENTIFIER.fullmatch(entry.name):
            raise SecurityBoundaryError("INVALID_SKILL_DIRECTORY", f"Invalid skill directory name: {entry.name}")
        directories.append(entry)
    if not directories:
        raise ValueError("No project skill adapters are installed.")
    if len(directories) > MAX_SKILLS:
        raise SecurityBoundaryError("TOO_MANY_SKILLS", f"Skill count exceeds the {MAX_SKILLS}-adapter limit.")
    return directories


def _stat_signature(info: Any) -> tuple[int, int, int, int, int]:
    return (info.st_mode, info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def _enumerate_skill_content(directory: Path) -> list[tuple[str, Path, tuple[int, int, int, int, int]]]:
    entries: list[tuple[str, Path, tuple[int, int, int, int, int]]] = []
    try:
        top_level = sorted(directory.iterdir(), key=lambda item: item.name)
    except OSError as exc:
        raise SecurityBoundaryError("SKILL_PATH_UNREADABLE", f"Unable to enumerate Skill content: {directory.name}") from exc
    for entry in top_level:
        try:
            info = entry.stat(follow_symlinks=False)
        except OSError as exc:
            raise SecurityBoundaryError("SKILL_PATH_UNREADABLE", f"Unable to inspect Skill content: {entry.name}") from exc
        if stat_module.S_ISDIR(info.st_mode):
            if entry.name != "references":
                raise SecurityBoundaryError("SKILL_CONTENT_LAYOUT_INVALID", f"Only a references directory is permitted: {entry.name}")
            try:
                references = sorted(entry.iterdir(), key=lambda item: item.name)
            except OSError as exc:
                raise SecurityBoundaryError("SKILL_PATH_UNREADABLE", "Unable to enumerate Skill references.") from exc
            for reference in references:
                relative_name = f"references/{reference.name}"
                try:
                    reference_info = reference.stat(follow_symlinks=False)
                except OSError as exc:
                    raise SecurityBoundaryError("SKILL_PATH_UNREADABLE", f"Unable to inspect Skill content: {relative_name}") from exc
                if not stat_module.S_ISREG(reference_info.st_mode):
                    raise SecurityBoundaryError("SKILL_CONTENT_LAYOUT_INVALID", f"Nested or non-regular Skill reference is not permitted: {relative_name}")
                if reference_info.st_mode & (stat_module.S_IXUSR | stat_module.S_IXGRP | stat_module.S_IXOTH):
                    raise SecurityBoundaryError("SKILL_CONTENT_EXECUTABLE", f"Executable Skill content is not permitted: {relative_name}")
                if reference.suffix.lower() not in {".md", ".txt", ".json"}:
                    raise SecurityBoundaryError("SKILL_CONTENT_TYPE_NOT_ALLOWED", f"Executable or unsupported Skill content is not permitted: {relative_name}")
                entries.append((relative_name, reference, _stat_signature(reference_info)))
            continue
        if not stat_module.S_ISREG(info.st_mode):
            raise SecurityBoundaryError("SKILL_CONTENT_NOT_REGULAR", f"Skill content must be a regular file: {entry.name}")
        if info.st_mode & (stat_module.S_IXUSR | stat_module.S_IXGRP | stat_module.S_IXOTH):
            raise SecurityBoundaryError("SKILL_CONTENT_EXECUTABLE", f"Executable Skill content is not permitted: {entry.name}")
        if entry.name not in {SKILL_DOCUMENT_NAME, SKILL_MANIFEST_NAME}:
            raise SecurityBoundaryError("SKILL_CONTENT_LAYOUT_INVALID", f"Unexpected top-level Skill content is not permitted: {entry.name}")
        entries.append((entry.name, entry, _stat_signature(info)))
    entries.sort(key=lambda item: item[0])
    if len(entries) > MAX_SKILL_CONTENT_FILES:
        raise SecurityBoundaryError("SKILL_CONTENT_LIMIT_EXCEEDED", "Skill content exceeds the bounded file-count limit.")
    names = {name for name, _path, _signature in entries}
    if names.intersection({SKILL_DOCUMENT_NAME, SKILL_MANIFEST_NAME}) != {SKILL_DOCUMENT_NAME, SKILL_MANIFEST_NAME}:
        raise ValueError(f"Skill {directory.name} is missing its document or manifest.")
    return entries


def _skill_content_snapshot(paths: WorkspacePaths, directory: Path) -> tuple[list[dict[str, Any]], dict[str, bytes]]:
    before = _enumerate_skill_content(directory)
    payloads: dict[str, bytes] = {}
    total_bytes = 0
    for relative_name, path, signature in before:
        maximum = MAX_JSON_FILE_BYTES if path.suffix.lower() == ".json" else MAX_TEXT_FILE_BYTES
        source = paths.workspace_file(
            path.relative_to(paths.workspace),
            extensions={path.suffix.lower()},
            max_bytes=maximum,
        )
        payload = read_bytes_bounded(source, maximum)
        try:
            after_read = path.stat(follow_symlinks=False)
        except OSError as exc:
            raise SecurityBoundaryError("SKILL_CONTENT_RACE_DETECTED", f"Skill content disappeared while reading: {relative_name}") from exc
        if _stat_signature(after_read) != signature:
            raise SecurityBoundaryError("SKILL_CONTENT_RACE_DETECTED", f"Skill content changed while reading: {relative_name}")
        total_bytes += len(payload)
        if total_bytes > MAX_SKILL_CONTENT_BYTES:
            raise SecurityBoundaryError("SKILL_CONTENT_LIMIT_EXCEEDED", "Skill content exceeds the bounded byte limit.")
        payloads[relative_name] = payload
    after = _enumerate_skill_content(directory)
    if [(name, signature) for name, _path, signature in before] != [
        (name, signature) for name, _path, signature in after
    ]:
        raise SecurityBoundaryError("SKILL_CONTENT_RACE_DETECTED", f"Skill directory changed while reading: {directory.name}")
    content_files = [
        {
            "path": (directory / relative_name).relative_to(paths.workspace).as_posix(),
            "sha256": hashlib.sha256(payloads[relative_name]).hexdigest(),
            "size": len(payloads[relative_name]),
        }
        for relative_name, _path, _signature in before
    ]
    return content_files, payloads


def _validate_manifest(payload: Any, directory_name: str, document: str, content_names: set[str]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError(f"Skill manifest for {directory_name} must be a JSON object.")
    required = {"schema_version", "id", "name", "version", "description", "source", "policy", "operations"}
    _reject_unknown_fields(payload, required, f"Skill manifest for {directory_name}")
    missing = sorted(required - payload.keys())
    if missing:
        raise ValueError(f"Skill manifest for {directory_name} is missing: {', '.join(missing)}")
    if payload["schema_version"] != SKILL_SCHEMA_VERSION:
        raise ValueError(f"Unsupported skill adapter schema for {directory_name}.")
    skill_id = _bounded_string(payload["id"], "id", 64)
    if skill_id != directory_name or not _IDENTIFIER.fullmatch(skill_id):
        raise ValueError(f"Skill id must match its directory: {directory_name}")
    name = _bounded_string(payload["name"], "name", 128)
    version = _bounded_string(payload["version"], "version", 64)
    if not _VERSION.fullmatch(version):
        raise ValueError(f"Skill adapter {skill_id} has an invalid semantic version.")
    description = _bounded_string(payload["description"], "description", 1024)
    source = _validate_source(payload["source"], skill_id)
    policy = _validate_policy(payload["policy"], skill_id)
    operations = _validate_operations(payload["operations"], skill_id)
    frontmatter = _skill_frontmatter(document)
    if frontmatter["name"] != skill_id:
        raise ValueError(f"SKILL.md name must match adapter id {skill_id}.")
    _validate_document_links(document, content_names, skill_id)
    return {
        "schema_version": SKILL_SCHEMA_VERSION,
        "id": skill_id,
        "name": name,
        "version": version,
        "description": description,
        "source": source,
        "policy": policy,
        "operations": operations,
    }


def _validate_source(value: Any, skill_id: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"Skill adapter {skill_id} source must be an object.")
    _reject_unknown_fields(value, {"catalog", "adaptation", "upstream"}, f"Skill adapter {skill_id} source")
    catalog = _bounded_string(value.get("catalog"), "source.catalog", 128)
    adaptation = _bounded_string(value.get("adaptation"), "source.adaptation", 256)
    upstream = value.get("upstream", [])
    if not isinstance(upstream, list) or not 1 <= len(upstream) <= MAX_UPSTREAM_SOURCES:
        raise ValueError(f"Skill adapter {skill_id} must declare bounded upstream sources.")
    normalized: list[dict[str, str]] = []
    for item in upstream:
        if not isinstance(item, dict):
            raise ValueError(f"Skill adapter {skill_id} upstream sources must be objects.")
        _reject_unknown_fields(
            item,
            {"id", "url", "license", "revision", "content_sha256"},
            f"Skill adapter {skill_id} upstream source",
        )
        source_id = _bounded_string(item.get("id"), "source.upstream.id", 128)
        url = _bounded_string(item.get("url"), "source.upstream.url", 512)
        license_name = _bounded_string(item.get("license"), "source.upstream.license", 64)
        revision = _bounded_string(item.get("revision"), "source.upstream.revision", 40)
        content_sha256 = _bounded_string(item.get("content_sha256"), "source.upstream.content_sha256", 64)
        if not url.startswith("https://"):
            raise ValueError(f"Skill adapter {skill_id} upstream URLs must use HTTPS.")
        if not _REVISION.fullmatch(revision) or revision not in url:
            raise ValueError(f"Skill adapter {skill_id} upstream revisions must be fixed lowercase commit hashes embedded in their URL.")
        if not _SHA256.fullmatch(content_sha256):
            raise ValueError(f"Skill adapter {skill_id} upstream content digests must be lowercase SHA-256 values.")
        normalized.append(
            {
                "id": source_id,
                "url": url,
                "license": license_name,
                "revision": revision,
                "content_sha256": content_sha256,
            }
        )
    return {"catalog": catalog, "adaptation": adaptation, "upstream": normalized}


def _validate_policy(value: Any, skill_id: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"Skill adapter {skill_id} policy must be an object.")
    _reject_unknown_fields(
        value,
        {"risk", "execution", "network", "human_review"},
        f"Skill adapter {skill_id} policy",
    )
    risk = _bounded_string(value.get("risk"), "policy.risk", 32)
    if risk not in {"low", "moderate", "high"}:
        raise ValueError(f"Skill adapter {skill_id} has an unsupported risk level.")
    execution = _bounded_string(value.get("execution"), "policy.execution", 32)
    if execution != "declarative":
        raise ValueError(f"Skill adapter {skill_id} may only declare interfaces, not executable code.")
    network = _bounded_string(value.get("network"), "policy.network", 64)
    if network not in {"offline", "loopback-only", "explicit-capability", "mixed-explicit"}:
        raise ValueError(f"Skill adapter {skill_id} has an unsupported network policy.")
    human_review = value.get("human_review", False)
    if type(human_review) is not bool:
        raise ValueError(f"Skill adapter {skill_id} policy.human_review must be a boolean.")
    return {
        "risk": risk,
        "execution": execution,
        "network": network,
        "human_review": human_review,
    }


def _validate_operations(value: Any, skill_id: str) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_OPERATIONS:
        raise ValueError(f"Skill adapter {skill_id} operations are missing or exceed the limit.")
    operations: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, dict):
            raise ValueError(f"Skill adapter {skill_id} operations must be objects.")
        _reject_unknown_fields(
            item,
            {"id", "purpose", "required", "interfaces"},
            f"Skill adapter {skill_id} operation",
        )
        operation_id = _bounded_string(item.get("id"), "operation.id", 64)
        if not _IDENTIFIER.fullmatch(operation_id) or operation_id in seen:
            raise ValueError(f"Skill adapter {skill_id} has an invalid or duplicate operation id: {operation_id}")
        seen.add(operation_id)
        purpose = _bounded_string(item.get("purpose"), "operation.purpose", 512)
        required = item.get("required", True)
        if type(required) is not bool:
            raise ValueError(f"Skill operation {skill_id}/{operation_id} required must be a boolean.")
        interfaces = item.get("interfaces")
        if not isinstance(interfaces, list) or not 1 <= len(interfaces) <= MAX_INTERFACES:
            raise ValueError(f"Skill operation {skill_id}/{operation_id} must declare bounded interfaces.")
        operations.append(
            {
                "id": operation_id,
                "purpose": purpose,
                "required": required,
                "interfaces": [_validate_interface(interface, skill_id, operation_id) for interface in interfaces],
            }
        )
    return operations


def _validate_interface(value: Any, skill_id: str, operation_id: str) -> dict[str, str]:
    if not isinstance(value, dict):
        raise ValueError(f"Skill interface {skill_id}/{operation_id} must be an object.")
    kind = _bounded_string(value.get("kind"), "interface.kind", 16)
    if kind == "cli":
        _reject_unknown_fields(value, {"kind", "command"}, f"Skill interface {skill_id}/{operation_id}")
        command = _bounded_string(value.get("command"), "interface.command", 256)
        if any(token in command for token in (";", "&&", "||", "|", ">", "<", "`", "$(`")):
            raise ValueError(f"Skill interface {skill_id}/{operation_id} contains shell control syntax.")
        return {"kind": kind, "command": command}
    if kind == "mcp":
        _reject_unknown_fields(value, {"kind", "tool"}, f"Skill interface {skill_id}/{operation_id}")
        tool = _bounded_string(value.get("tool"), "interface.tool", 128)
        if not _MCP_TOOL.fullmatch(tool):
            raise ValueError(f"Skill interface {skill_id}/{operation_id} has an invalid MCP tool name.")
        return {"kind": kind, "tool": tool}
    if kind == "http":
        _reject_unknown_fields(
            value,
            {"kind", "connector", "method", "path"},
            f"Skill interface {skill_id}/{operation_id}",
        )
        connector = _bounded_string(value.get("connector"), "interface.connector", 64)
        method = _bounded_string(value.get("method"), "interface.method", 8).upper()
        path = _bounded_string(value.get("path"), "interface.path", 256)
        if not _IDENTIFIER.fullmatch(connector) or method not in {"GET", "POST"}:
            raise ValueError(f"Skill interface {skill_id}/{operation_id} has an invalid HTTP connector or method.")
        if not _HTTP_PATH.fullmatch(path) or ".." in path or "?" in path or "#" in path:
            raise ValueError(f"Skill interface {skill_id}/{operation_id} has an invalid HTTP path.")
        return {"kind": kind, "connector": connector, "method": method, "path": path}
    if kind == "governed":
        _reject_unknown_fields(
            value,
            {"kind", "connector", "operation"},
            f"Skill interface {skill_id}/{operation_id}",
        )
        connector = _bounded_string(value.get("connector"), "interface.connector", 64)
        governed_operation = _bounded_string(value.get("operation"), "interface.operation", 64)
        if not _IDENTIFIER.fullmatch(connector) or not _IDENTIFIER.fullmatch(governed_operation):
            raise ValueError(f"Skill interface {skill_id}/{operation_id} has an invalid governed connector or operation.")
        return {"kind": kind, "connector": connector, "operation": governed_operation}
    raise ValueError(f"Skill interface {skill_id}/{operation_id} has unsupported kind: {kind}")


def _skill_frontmatter(document: str) -> dict[str, str]:
    normalized = document.replace("\r\n", "\n").replace("\r", "\n")
    if not normalized.startswith("---\n"):
        raise ValueError("SKILL.md must start with YAML frontmatter.")
    frontmatter_end = normalized.find("\n---\n", 4, 4096)
    if frontmatter_end < 0 or len(normalized[: frontmatter_end + 5].encode("utf-8")) > 4096:
        raise ValueError("SKILL.md frontmatter must close within the first 4096 characters.")
    frontmatter_text = normalized[4:frontmatter_end]
    fields: dict[str, str] = {}
    for line in frontmatter_text.split("\n"):
        if not line or line.isspace():
            continue
        if line != line.strip() or "\t" in line or any(ord(character) < 32 for character in line):
            raise ValueError("SKILL.md frontmatter must use flat, unindented UTF-8 scalar fields.")
        match = re.fullmatch(r"([a-z][a-z0-9_-]{0,31}):[ ]+(.+)", line)
        if not match:
            raise ValueError("SKILL.md frontmatter contains invalid YAML field syntax.")
        key, value = match.groups()
        value = value.strip()
        if key in fields:
            raise ValueError(f"SKILL.md frontmatter contains duplicate field: {key}")
        if key not in {"name", "description"}:
            raise ValueError(f"SKILL.md frontmatter contains unsupported field: {key}")
        if (
            not value
            or value[0] in "[{'\"&*!|>"
            or ": " in value
            or " #" in value
            or value in {"null", "Null", "NULL", "~", "true", "True", "TRUE", "false", "False", "FALSE"}
        ):
            raise ValueError(f"SKILL.md frontmatter {key} must be a plain scalar.")
        fields[key] = value
    missing = sorted({"name", "description"} - fields.keys())
    if missing:
        raise ValueError(f"SKILL.md frontmatter must include: {', '.join(missing)}")
    if not _IDENTIFIER.fullmatch(fields["name"]):
        raise ValueError("SKILL.md frontmatter must include a bounded name.")
    if len(fields["description"]) > 2_048:
        raise ValueError("SKILL.md frontmatter description exceeds the 2048-character limit.")
    return fields


def _validate_document_links(document: str, content_names: set[str], skill_id: str) -> None:
    for match in _MARKDOWN_LINK.finditer(document):
        raw_target = match.group(1)
        if raw_target.startswith("<") and raw_target.endswith(">"):
            raw_target = raw_target[1:-1]
        target = unquote(raw_target)
        if target.startswith("#"):
            continue
        if any(character in target for character in ("\x00", "\r", "\n")) or "\\" in target:
            raise ValueError(f"Skill adapter {skill_id} contains an unsafe local link: {raw_target}")
        parsed = urlsplit(target)
        if parsed.scheme:
            if (
                parsed.scheme.lower() not in {"http", "https"}
                or not parsed.hostname
                or parsed.username is not None
                or parsed.password is not None
            ):
                raise ValueError(f"Skill adapter {skill_id} contains an unsafe URI scheme: {raw_target}")
            continue
        if target.startswith(("/", "//")) or re.match(r"^[A-Za-z]:[/\\]", target) or "?" in target:
            raise ValueError(f"Skill adapter {skill_id} contains an unsafe local link: {raw_target}")
        target = target.split("#", 1)[0]
        parts = Path(target).parts
        if not target or Path(target).is_absolute() or any(part in {".", ".."} for part in parts):
            raise ValueError(f"Skill adapter {skill_id} contains an unsafe local link: {raw_target}")
        normalized = Path(target).as_posix()
        if normalized not in content_names:
            raise ValueError(f"Skill adapter {skill_id} links to missing local content: {normalized}")


def _bounded_string(value: Any, field: str, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"{field} must be a non-empty string of at most {maximum} characters.")
    return value.strip()


def _reject_unknown_fields(value: dict[str, Any], allowed: set[str], context: str) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ValueError(f"{context} contains unsupported fields: {', '.join(unknown)}")


def _connector_capabilities(summary: dict[str, Any]) -> dict[str, Any]:
    commands: dict[str, list[dict[str, str]]] = {}
    tools: dict[str, list[dict[str, str]]] = {}
    connectors: dict[str, dict[str, Any]] = {}
    for connector in summary.get("connectors", []):
        connector_id = connector.get("id")
        if not isinstance(connector_id, str):
            continue
        connectors[connector_id] = connector
        status = connector.get("status") if isinstance(connector.get("status"), str) else "unknown"
        for command in connector.get("commands", []):
            if isinstance(command, str):
                commands.setdefault(command, []).append({"connector": connector_id, "status": status})
        for tool in connector.get("tools", []):
            if isinstance(tool, str):
                tools.setdefault(tool, []).append({"connector": connector_id, "status": status})
    return {"commands": commands, "tools": tools, "connectors": connectors}


def _resolve_adapter(
    manifest: dict[str, Any],
    capabilities: dict[str, Any],
    **paths_and_digests: Any,
) -> dict[str, Any]:
    resolved_operations: list[dict[str, Any]] = []
    missing_required: list[str] = []
    for operation in manifest["operations"]:
        interfaces = [_resolve_interface(interface, capabilities) for interface in operation["interfaces"]]
        available = any(interface["available"] for interface in interfaces)
        if operation["required"] and not available:
            missing_required.append(operation["id"])
        resolved_operations.append({**operation, "available": available, "interfaces": interfaces})
    available_count = sum(1 for operation in resolved_operations if operation["available"])
    if missing_required:
        status = "partial" if available_count else "unavailable"
    else:
        status = "available"
    return {
        **manifest,
        **paths_and_digests,
        "status": status,
        "available_operation_count": available_count,
        "required_operation_count": sum(1 for operation in resolved_operations if operation["required"]),
        "missing_required_operations": missing_required,
        "operations": resolved_operations,
    }


def _resolve_interface(interface: dict[str, str], capabilities: dict[str, Any]) -> dict[str, Any]:
    kind = interface["kind"]
    if kind == "cli":
        declarations = capabilities["commands"].get(interface["command"], [])
        available = any(item["status"] == "available" for item in declarations)
        reason = "declared_available_by_connector_registry" if available else ("connector_not_available" if declarations else "command_not_declared")
    elif kind == "mcp":
        declarations = capabilities["tools"].get(interface["tool"], [])
        available = any(item["status"] == "available" for item in declarations)
        reason = "declared_available_by_connector_registry" if available else ("connector_not_available" if declarations else "tool_not_declared")
    elif kind == "http":
        connector = capabilities["connectors"].get(interface["connector"])
        route = f"{interface['method']} {interface['path']}"
        declared_routes = set(connector.get("http_routes", [])) if isinstance(connector, dict) else set()
        available = bool(connector and connector.get("status") == "available" and route in declared_routes)
        if available:
            reason = "declared_available_by_connector_registry"
        elif connector and connector.get("status") != "available":
            reason = "connector_not_available"
        else:
            reason = "http_route_not_declared"
    else:
        connector = capabilities["connectors"].get(interface["connector"])
        declared_operations = set(connector.get("governed_operations", [])) if isinstance(connector, dict) else set()
        available = bool(
            connector
            and connector.get("status") == "available"
            and interface["operation"] in declared_operations
        )
        if available:
            reason = "declared_available_by_connector_registry"
        elif connector and connector.get("status") != "available":
            reason = "connector_not_available"
        else:
            reason = "governed_operation_not_declared"
    return {**interface, "available": available, "reason": reason}
