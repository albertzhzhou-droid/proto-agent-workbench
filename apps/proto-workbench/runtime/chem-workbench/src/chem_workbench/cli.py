"""Command-line interface for the non-executing Chem Workbench alpha."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any, NoReturn

from chem_workbench import __version__
from chem_workbench.adapters import (
    ADAPTER_MANIFEST_VERSION,
    ADAPTER_REGISTRY_VERSION,
    FORMAT_CAPABILITY_VERSION,
    LOSS_REPORT_VERSION,
    AdapterContractError,
    AdapterRegistry,
    canonical_format_capability_hash,
    canonical_manifest_hash,
    canonical_registry_hash,
    load_bundled_registry,
    validate_adapter_manifest,
    validate_format_capability,
    validate_loss_report,
)
from chem_workbench.adapters.cif_import import import_cif_bytes
from chem_workbench.adapters.cif_probe import probe_cif_bytes
from chem_workbench.chemir import (
    CANONICALIZATION_ALGORITHM,
    NORMALIZATION_PROFILE,
    artifact_sha256,
    pretty_bytes,
    semantic_hash,
    typed_digest,
    validate_typed_digest,
)
from chem_workbench.chemir.constraints import (
    MAX_OBJECTS,
    MAX_PROPERTIES,
    MAX_REFERENCE_ITEMS,
    MAX_REPRESENTATION_BYTES,
    MAX_SHORT_STRING_LENGTH,
    is_portable_relative_path,
)
from chem_workbench.chemir.schema_validation import (
    SchemaValidationError,
    validate_review_packet_schema,
)
from chem_workbench.chemir.validation import (
    source_hashes as validate_source_hashes,
)
from chem_workbench.chemir.validation import (
    validate_chemir_document,
)
from chem_workbench.compiler import (
    CHEMIR_SCHEMA_VERSION,
    COMPILER_ID,
    MAX_SOURCE_BYTES,
    CompilationResult,
    compile_source,
)
from chem_workbench.diagnostics import Diagnostic, Severity
from chem_workbench.version import SUPPORTED_REVIEW_COMPILER_IDS

MAX_JSON_ARTIFACT_BYTES = 16 * 1024 * 1024
MAX_JSON_NESTING = 64
REVIEW_PACKET_VERSION = "review/v1alpha1"
_REVIEW_PACKET_FIELDS = {
    "packet_version",
    "operation",
    "verification_scope",
    "signature_status",
    "compiler",
    "canonicalization",
    "normalization_profile",
    "source_hashes",
    "chemir_semantic_hash",
    "chemir_artifact_hash",
    "observations",
    "not_claimed",
    "diagnostics",
    "chemir",
}
_NOT_CLAIMED_TYPES = {
    "PARSE_VALID",
    "STRUCTURE_MODEL_CONSISTENT",
    "CHEMISTRY_CHECKED",
}


class DuplicateKeyError(ValueError):
    pass


class ReviewPacketBindingError(ValueError):
    pass


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateKeyError(f"Duplicate JSON key {key!r}")
        result[key] = value
    return result


def _reject_constant(value: str) -> NoReturn:
    raise ValueError(f"Non-finite JSON number {value!r} is not allowed")


def _reject_float_lexeme(value: str) -> NoReturn:
    raise ValueError(f"JSON decimal {value!r} is outside the exact-integer alpha artifact subset")


def _enforce_json_nesting_limit(content: bytes) -> None:
    depth = 0
    in_string = False
    escaped = False
    for byte in content:
        if in_string:
            if escaped:
                escaped = False
            elif byte == 0x5C:  # backslash
                escaped = True
            elif byte == 0x22:  # double quote
                in_string = False
            continue
        if byte == 0x22:
            in_string = True
        elif byte in (0x5B, 0x7B):  # [ or {
            depth += 1
            if depth > MAX_JSON_NESTING:
                raise ValueError(f"Artifact nesting exceeds the alpha limit of {MAX_JSON_NESTING}")
        elif byte in (0x5D, 0x7D):  # ] or }
            depth = max(depth - 1, 0)


def _load_json_bytes(content: bytes) -> Any:
    if len(content) > MAX_JSON_ARTIFACT_BYTES:
        raise ValueError(f"Artifact exceeds the alpha limit of {MAX_JSON_ARTIFACT_BYTES} bytes")
    _enforce_json_nesting_limit(content)
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError(f"Artifact is not valid UTF-8 at byte {error.start}") from error
    return json.loads(
        text,
        object_pairs_hook=_reject_duplicate_keys,
        parse_constant=_reject_constant,
        parse_float=_reject_float_lexeme,
    )


def _format_diagnostic(diagnostic: Diagnostic) -> str:
    location = diagnostic.location
    return (
        f"{location.file}:{location.line}:{location.column}: "
        f"{diagnostic.severity.value} {diagnostic.code}: {diagnostic.message}\n"
        f"  help: {diagnostic.suggestion}"
    )


def _emit_diagnostics(diagnostics: Iterable[Diagnostic]) -> None:
    for diagnostic in diagnostics:
        print(_format_diagnostic(diagnostic), file=sys.stderr)


def _diagnostic_counts(diagnostics: Iterable[Diagnostic]) -> dict[str, int]:
    counts = {severity.value: 0 for severity in Severity}
    for diagnostic in diagnostics:
        counts[diagnostic.severity.value] += 1
    return counts


def _read_bytes(path_text: str, max_bytes: int = MAX_SOURCE_BYTES) -> bytes:
    path = Path(path_text)
    try:
        size = path.stat().st_size
        if size > max_bytes:
            raise ValueError(f"Input exceeds the alpha limit of {max_bytes} bytes: {path}")
        with path.open("rb") as stream:
            content = stream.read(max_bytes + 1)
        if len(content) > max_bytes:
            raise ValueError(f"Input exceeds the alpha limit of {max_bytes} bytes: {path}")
        return content
    except OSError as error:
        raise ValueError(f"Cannot read {path}: {error.strerror or error}") from error


def _write_artifact(path_text: str | None, content: bytes, force: bool) -> None:
    if path_text is None or path_text == "-":
        sys.stdout.buffer.write(content)
        sys.stdout.buffer.flush()
        return
    destination = Path(path_text)
    if destination.is_symlink():
        raise ValueError(f"Refusing to replace symbolic-link output: {destination}")
    if destination.exists() and not force:
        raise ValueError(f"Output already exists: {destination}. Use --force to replace it.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.",
        suffix=".tmp",
        dir=destination.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        if force:
            os.replace(temporary, destination)
        else:
            try:
                os.link(temporary, destination)
            except FileExistsError as error:
                raise ValueError(
                    f"Output already exists: {destination}. Use --force to replace it."
                ) from error
    finally:
        temporary.unlink(missing_ok=True)


def _cif_import_resolver(source_path: Path) -> Callable[[str], bytes | None]:
    """Read permitted source-relative CIF paths for opt-in import resolution."""
    base = source_path.resolve().parent

    def resolve(relative_path: str) -> bytes | None:
        if not is_portable_relative_path(relative_path):
            return None
        target = (base / Path(relative_path.replace("\\", "/"))).resolve()
        if target.parent != base and base not in target.parents:
            return None
        try:
            return _read_bytes(str(target))
        except ValueError:
            return None

    return resolve


def _compile_path(
    path_text: str,
    resolve_imports: bool = False,
) -> CompilationResult:
    content = _read_bytes(path_text)
    resolver = _cif_import_resolver(Path(path_text)) if resolve_imports else None
    return compile_source(content, path_text, import_resolver=resolver)


def _write_conversion_loss_reports(
    output: str | None,
    reports: tuple[dict[str, Any], ...],
    force: bool,
) -> int:
    if output in (None, "-") or not reports:
        return 0
    for index, report in enumerate(reports):
        _write_artifact(f"{output}.import-{index}.loss.json", pretty_bytes(report), force)
    return len(reports)


def _check_command(args: argparse.Namespace) -> int:
    try:
        result = _compile_path(args.source, args.resolve_imports)
    except ValueError as error:
        print(f"error CHM9002: {error}", file=sys.stderr)
        return 2
    counts = _diagnostic_counts(result.diagnostics)
    if args.format == "json":
        output = {
            "valid": result.success,
            "source_sha256": result.source_sha256,
            "semantic_hash": result.semantic_hash,
            "diagnostic_counts": counts,
            "diagnostics": [item.to_dict() for item in result.diagnostics],
        }
        sys.stdout.buffer.write(pretty_bytes(output))
    else:
        _emit_diagnostics(result.diagnostics)
        state = "OK" if result.success else "FAILED"
        print(
            f"{state}: {args.source} "
            f"({counts['error']} errors, {counts['warning']} warnings, "
            f"{counts['review_required']} review required)"
        )
        if result.success:
            print(f"source_sha256={result.source_sha256}")
            print(f"semantic_hash={result.semantic_hash}")
    return 0 if result.success else 1


def _compile_command(args: argparse.Namespace) -> int:
    try:
        result = _compile_path(args.source, args.resolve_imports)
    except ValueError as error:
        print(f"error CHM9002: {error}", file=sys.stderr)
        return 2
    _emit_diagnostics(result.diagnostics)
    if not result.success or result.artifact_bytes is None:
        print("Compilation failed; no ChemIR artifact was written.", file=sys.stderr)
        return 1
    try:
        _write_artifact(args.output, result.artifact_bytes, args.force)
        written = _write_conversion_loss_reports(
            args.output, result.conversion_loss_reports, args.force
        )
    except (OSError, ValueError) as error:
        print(f"error CHM9003: {error}", file=sys.stderr)
        return 2
    if args.output not in (None, "-"):
        print(
            f"Wrote ChemIR to {args.output}\n"
            f"source_sha256={result.source_sha256}\n"
            f"semantic_hash={result.semantic_hash}\n"
            f"artifact_sha256={artifact_sha256(result.artifact_bytes)}"
        )
        if written:
            print(f"conversion_loss_reports={written}", file=sys.stderr)
    return 0


def _validate_chemir_document(value: Any) -> dict[str, Any]:
    # Keep the private CLI hook stable while sharing the fail-closed library validator.
    return validate_chemir_document(
        value,
        max_objects=MAX_OBJECTS,
        max_reference_items=MAX_REFERENCE_ITEMS,
        max_representation_bytes=MAX_REPRESENTATION_BYTES,
        max_short_string_length=MAX_SHORT_STRING_LENGTH,
        max_properties=MAX_PROPERTIES,
    )


def _source_hashes(document: dict[str, Any]) -> list[str]:
    return validate_source_hashes(document)


def _review_packet_from_document(
    document: dict[str, Any],
    reviewed_artifact: bytes,
) -> dict[str, Any]:
    hashes = _source_hashes(document)
    if not hashes:
        raise ValueError("ChemIR has no source_sha256 evidence and cannot be review-compiled")
    canonical_artifact = pretty_bytes(document)
    if reviewed_artifact != canonical_artifact:
        raise ValueError(
            "ChemIR input is not the canonical pretty-JSON artifact; re-run chem compile first"
        )
    return {
        "packet_version": REVIEW_PACKET_VERSION,
        "operation": "review-compile",
        "verification_scope": "self_consistency",
        "signature_status": "unsigned",
        "compiler": COMPILER_ID,
        "canonicalization": CANONICALIZATION_ALGORITHM,
        "normalization_profile": NORMALIZATION_PROFILE,
        "source_hashes": [typed_digest("source_sha256", digest) for digest in hashes],
        "chemir_semantic_hash": typed_digest("semantic_hash", semantic_hash(document)),
        "chemir_artifact_hash": typed_digest(
            "artifact_sha256", artifact_sha256(canonical_artifact)
        ),
        "observations": [],
        "not_claimed": [
            {
                "claim": "PARSE_VALID",
                "reason": (
                    "The original .chem parser evidence was not re-executed from this artifact."
                ),
            },
            {
                "claim": "STRUCTURE_MODEL_CONSISTENT",
                "reason": "Versioned chemistry format adapters are not active in this alpha.",
            },
            {
                "claim": "CHEMISTRY_CHECKED",
                "reason": "No scientific rule bundle has evaluated the preserved representations.",
            },
        ],
        "diagnostics": [],
        "chemir": document,
    }


def _validate_review_packet(value: dict[str, Any]) -> dict[str, Any]:
    try:
        validate_review_packet_schema(value)
    except SchemaValidationError as error:
        raise ValueError(str(error)) from error
    missing = _REVIEW_PACKET_FIELDS - set(value)
    extra = set(value) - _REVIEW_PACKET_FIELDS
    if missing:
        raise ValueError(f"Review packet is missing fields: {', '.join(sorted(missing))}")
    if extra:
        raise ValueError(f"Unknown review packet fields: {', '.join(sorted(extra))}")
    expected_constants = {
        "packet_version": REVIEW_PACKET_VERSION,
        "operation": "review-compile",
        "verification_scope": "self_consistency",
        "signature_status": "unsigned",
        "canonicalization": CANONICALIZATION_ALGORITHM,
        "normalization_profile": NORMALIZATION_PROFILE,
    }
    for field, expected in expected_constants.items():
        if value.get(field) != expected:
            raise ValueError(f"Unsupported review packet {field} {value.get(field)!r}")
    compiler_id = value.get("compiler")
    if compiler_id not in SUPPORTED_REVIEW_COMPILER_IDS:
        raise ValueError(f"Unsupported review packet compiler {compiler_id!r}")

    document = _validate_chemir_document(value["chemir"])
    source_hash_records = value["source_hashes"]
    if not isinstance(source_hash_records, list) or not source_hash_records:
        raise ValueError("Review packet source_hashes must be a non-empty array")
    recorded_source_hashes = [
        validate_typed_digest(record, "source_sha256") for record in source_hash_records
    ]
    if len(set(recorded_source_hashes)) != len(recorded_source_hashes):
        raise ValueError("Review packet contains duplicate source hashes")
    actual_source_hashes = _source_hashes(document)
    if recorded_source_hashes != actual_source_hashes:
        raise ReviewPacketBindingError("Review packet source hash binding mismatch")

    recorded_semantic_hash = validate_typed_digest(value["chemir_semantic_hash"], "semantic_hash")
    actual_semantic_hash = semantic_hash(document)
    if recorded_semantic_hash != actual_semantic_hash:
        raise ReviewPacketBindingError("Review packet semantic hash binding mismatch")

    recorded_artifact_hash = validate_typed_digest(value["chemir_artifact_hash"], "artifact_sha256")
    actual_artifact_hash = artifact_sha256(pretty_bytes(document))
    if recorded_artifact_hash != actual_artifact_hash:
        raise ReviewPacketBindingError("Review packet artifact hash binding mismatch")

    observations = value["observations"]
    if not isinstance(observations, list) or len(observations) > 1:
        raise ValueError("Review packet must contain at most one alpha observation")
    for observation in observations:
        if not isinstance(observation, dict) or set(observation) != {
            "observation_type",
            "producer",
            "evidence_hashes",
        }:
            raise ValueError("Review packet contains a malformed observation")
        if observation.get("observation_type") != "SOURCE_PARSE_ACCEPTED":
            raise ValueError(
                f"Unknown or forbidden review observation {observation.get('observation_type')!r}"
            )
        if observation.get("producer") != compiler_id:
            raise ReviewPacketBindingError(
                "SOURCE_PARSE_ACCEPTED producer does not match the packet compiler"
            )
        evidence = observation.get("evidence_hashes")
        if not isinstance(evidence, list):
            raise ValueError("SOURCE_PARSE_ACCEPTED evidence_hashes must be an array")
        claim_source_hashes = [
            validate_typed_digest(record, "source_sha256") for record in evidence
        ]
        if claim_source_hashes != recorded_source_hashes:
            raise ReviewPacketBindingError("SOURCE_PARSE_ACCEPTED source evidence binding mismatch")

    not_claimed = value["not_claimed"]
    if not isinstance(not_claimed, list):
        raise ValueError("Review packet not_claimed must be an array")
    not_claimed_names: list[str] = []
    for entry in not_claimed:
        if not isinstance(entry, dict) or set(entry) != {"claim", "reason"}:
            raise ValueError("Review packet contains a malformed not_claimed entry")
        claim_name = entry.get("claim")
        reason = entry.get("reason")
        if claim_name not in _NOT_CLAIMED_TYPES:
            raise ValueError(f"Unknown not_claimed type {claim_name!r}")
        if not isinstance(reason, str) or not reason or len(reason) > 4096:
            raise ValueError(f"Invalid reason for not_claimed type {claim_name!r}")
        assert isinstance(claim_name, str)
        not_claimed_names.append(claim_name)
    if len(set(not_claimed_names)) != len(not_claimed_names):
        raise ValueError("Review packet contains duplicate not_claimed types")
    expected_not_claimed = _NOT_CLAIMED_TYPES
    if set(not_claimed_names) != expected_not_claimed:
        raise ValueError("Review packet does not state every unsupported alpha claim")

    if not isinstance(value["diagnostics"], list):
        raise ValueError("Review packet diagnostics must be an array")
    return value


def _review_compile_command(args: argparse.Namespace) -> int:
    try:
        content = _read_bytes(args.source_or_chemir)
        if content.lstrip().startswith(b"{"):
            value = _load_json_bytes(content)
            document = _validate_chemir_document(value)
            packet = _review_packet_from_document(document, content)
        else:
            result = compile_source(content, args.source_or_chemir)
            _emit_diagnostics(result.diagnostics)
            if not result.success:
                print("Review compilation failed; no packet was written.", file=sys.stderr)
                return 1
            packet = result.review_packet()
        packet = _validate_review_packet(packet)
        packet_bytes = pretty_bytes(packet)
        _write_artifact(args.output, packet_bytes, args.force)
    except (DuplicateKeyError, json.JSONDecodeError, OSError, ValueError) as error:
        print(f"error CHM9004: {error}", file=sys.stderr)
        return 2
    if args.output not in (None, "-"):
        print(
            f"Wrote review packet to {args.output}\n"
            f"packet_artifact_sha256={artifact_sha256(packet_bytes)}"
        )
    return 0


def _inspect_command(args: argparse.Namespace) -> int:
    try:
        content = _read_bytes(args.artifact)
        value = _load_json_bytes(content)
        if not isinstance(value, dict):
            raise ValueError("Top-level JSON value must be an object")
        if value.get("schema_version") == CHEMIR_SCHEMA_VERSION:
            document = _validate_chemir_document(value)
            summary = {
                "artifact_type": "ChemIR",
                "schema_version": document["schema_version"],
                "profile": document["profile"],
                "object_count": len(document["objects"]),
                "kinds": sorted({item["kind"] for item in document["objects"]}),
                "semantic_hash": semantic_hash(document),
                "artifact_sha256": artifact_sha256(content),
                "validity_levels": {
                    "format": True,
                    "within_model": "not_evaluated",
                    "experimental": "not_claimed",
                },
            }
        elif value.get("packet_version") == REVIEW_PACKET_VERSION:
            packet = _validate_review_packet(value)
            document = packet["chemir"]
            actual_semantic_hash = semantic_hash(document)
            summary = {
                "artifact_type": "ReviewPacket",
                "packet_version": packet["packet_version"],
                "compiler": packet["compiler"],
                "observation_count": len(packet["observations"]),
                "bindings_valid": True,
                "verification_scope": "self_consistency",
                "signature_status": "unsigned",
                "semantic_hash": actual_semantic_hash,
                "artifact_sha256": artifact_sha256(content),
            }
        elif value.get("manifest_version") == ADAPTER_MANIFEST_VERSION:
            manifest = validate_adapter_manifest(value)
            manifest_resolution = load_bundled_registry().resolve_manifest(manifest)
            summary = {
                "artifact_type": "AdapterCapability",
                "manifest_version": manifest["manifest_version"],
                "adapter_id": manifest["adapter_id"],
                "adapter_version": manifest["adapter_version"],
                "adapter_type": manifest["adapter_type"],
                "permission_class": manifest["permission_class"],
                "manifest_hash": canonical_manifest_hash(manifest),
                **manifest_resolution.to_dict(),
                "artifact_sha256": artifact_sha256(content),
            }
        elif value.get("capability_version") == FORMAT_CAPABILITY_VERSION:
            capability = validate_format_capability(value)
            capability_resolution = load_bundled_registry().resolve_format_capability(capability)
            summary = {
                "artifact_type": "FormatCapability",
                "capability_version": capability["capability_version"],
                "capability_id": capability["capability_id"],
                "adapter_id": capability["adapter"]["id"],
                "direction": capability["direction"],
                "classification": capability["classification"],
                "capability_hash": canonical_format_capability_hash(capability),
                **capability_resolution.to_dict(),
                "artifact_sha256": artifact_sha256(content),
            }
        elif value.get("registry_version") == ADAPTER_REGISTRY_VERSION:
            candidate = AdapterRegistry(value)
            bundled = load_bundled_registry()
            candidate_hash = canonical_registry_hash(candidate.document)
            matches_bundled = candidate_hash == bundled.digest
            summary = {
                "artifact_type": "AdapterRegistry",
                "registry_version": candidate.document["registry_version"],
                "product": candidate.document["product"],
                "schema_valid": True,
                "bindings_valid": True,
                "matches_bundled_registry": matches_bundled,
                "trusted": matches_bundled,
                "registered_adapter_count": (bundled.adapter_count if matches_bundled else 0),
                "active_adapter_count": (bundled.active_adapter_count if matches_bundled else 0),
                "declared_adapter_count": candidate.adapter_count,
                "registry_hash": candidate_hash,
                "artifact_sha256": artifact_sha256(content),
            }
        elif value.get("loss_report_version") == LOSS_REPORT_VERSION:
            report = validate_loss_report(value)
            loss_resolution = load_bundled_registry().resolve_loss_report(report)
            summary = {
                "artifact_type": "LossReport",
                "loss_report_version": report["loss_report_version"],
                "adapter_id": report["adapter"]["id"],
                "direction": report["direction"],
                "classification": report["classification"],
                "issue_count": len(report["issues"]),
                **loss_resolution.to_dict(),
                "artifact_sha256": artifact_sha256(content),
            }
        else:
            raise ValueError("Unsupported artifact type or schema version")
    except ReviewPacketBindingError as error:
        print(f"error CHM9005: {error}.", file=sys.stderr)
        return 1
    except (
        AdapterContractError,
        DuplicateKeyError,
        json.JSONDecodeError,
        OSError,
        ValueError,
    ) as error:
        print(f"error CHM9004: {error}", file=sys.stderr)
        return 2
    sys.stdout.buffer.write(pretty_bytes(summary))
    return 0


def _capabilities_command(args: argparse.Namespace) -> int:
    try:
        registry = load_bundled_registry()
        if args.format == "text":
            if args.output is not None or args.force:
                raise ValueError("--output and --force require JSON capability output")
            digest = registry.digest
            discovery = registry.document["discovery"]
            print(f"Chem Workbench {__version__} static adapter registry")
            print(f"registry_version={registry.document['registry_version']}")
            print(f"registry_hash=sha256:{digest['value']}")
            print(f"registered_adapters={registry.adapter_count}")
            print(f"active_adapters={registry.active_adapter_count}")
            print(f"discovery_mode={discovery['mode']}")
            print("dynamic_discovery=false")
            print("process_execution=false")
            print("network_probe=false")
            print("laboratory_control=false")
            return 0
        content = pretty_bytes(registry.document)
        _write_artifact(args.output, content, args.force)
        if args.output not in (None, "-"):
            print(
                f"Wrote adapter registry to {args.output}\n"
                f"registry_hash=sha256:{registry.digest['value']}"
            )
        return 0
    except (AdapterContractError, OSError, ValueError) as error:
        print(f"error CHM9006: {error}", file=sys.stderr)
        return 2


def _probe_command(args: argparse.Namespace) -> int:
    try:
        content = _read_bytes(args.source)
        result = probe_cif_bytes(content)
    except (AdapterContractError, ValueError) as error:
        print(f"error CHM9002: {error}", file=sys.stderr)
        return 2
    summary = result.summary
    print(
        f"cif-probe {args.source}: classification={result.loss_report['classification']} "
        f"admitted={str(summary['admitted']).lower()} "
        f"sites={summary['site_count']} elements={','.join(summary['elements']) or '-'} "
        f"issues={len(result.loss_report['issues'])}",
        file=sys.stderr,
    )
    try:
        _write_artifact(args.output, pretty_bytes(result.loss_report), args.force)
    except (OSError, ValueError) as error:
        print(f"error CHM9003: {error}", file=sys.stderr)
        return 2
    return 0 if result.admitted else 1


def _convert_command(args: argparse.Namespace) -> int:
    if args.format != "cif":
        print(
            f"error CHM9001: conversion from format {args.format!r} has no registered "
            "capability; no backend was invoked.",
            file=sys.stderr,
        )
        return 3
    try:
        content = _read_bytes(args.source)
        result = import_cif_bytes(content)
    except (AdapterContractError, ValueError) as error:
        print(f"error CHM9002: {error}", file=sys.stderr)
        return 2
    chemir_output = args.output
    if chemir_output in (None, "-"):
        print(
            "error CHM9001: convert requires --output for the ChemIR artifact.",
            file=sys.stderr,
        )
        return 3
    loss_output = args.loss_output or f"{chemir_output}.loss.json"
    try:
        if result.admitted and result.artifact_bytes is not None:
            _write_artifact(chemir_output, result.artifact_bytes, args.force)
        _write_artifact(loss_output, pretty_bytes(result.loss_report), args.force)
    except (OSError, ValueError) as error:
        print(f"error CHM9003: {error}", file=sys.stderr)
        return 2
    state = "imported" if result.admitted else "rejected"
    print(
        f"cif-convert {args.source}: {state} "
        f"classification={result.loss_report['classification']} "
        f"sites={result.summary['site_count']} "
        f"elements={','.join(result.summary['elements']) or '-'} "
        f"loss_report={loss_output}",
        file=sys.stderr,
    )
    if result.admitted and result.document_semantic_hash is not None:
        print(f"semantic_hash={result.document_semantic_hash}", file=sys.stderr)
        print(f"chemir={chemir_output}", file=sys.stderr)
        return 0
    return 1


def _propose_cu_command(args: argparse.Namespace) -> int:
    try:
        content = _read_bytes(args.cif)
        result = import_cif_bytes(content)
        if not result.admitted:
            print(
                "error CHM9001: the CIF is outside the import profile; see the loss report.",
                file=sys.stderr,
            )
            return 1
        from chem_workbench.tool_gateway import copper_plan

        scales = args.scales
        if (
            not 2 <= len(scales) <= 9
            or len(set(scales)) != len(scales)
            or any(scale < 0.95 or scale > 1.05 for scale in scales)
        ):
            print(
                "error CHM9001: scales must be 2-9 unique factors in [0.95, 1.05].",
                file=sys.stderr,
            )
            return 3
        document = result.document
        assert document is not None
        obj = document["objects"][0]
        draft = copper_plan(obj, scales, result.document_semantic_hash)
    except ValueError as error:
        print(f"error CHM9002: {error}", file=sys.stderr)
        return 2
    try:
        _write_artifact(args.output, pretty_bytes(draft), args.force)
    except (OSError, ValueError) as error:
        print(f"error CHM9003: {error}", file=sys.stderr)
        return 2
    return 0


def _propose_water_command(args: argparse.Namespace) -> int:
    try:
        content = _read_bytes(args.geometry)
        geometry = json.loads(content.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        print(f"error CHM9002: {error}", file=sys.stderr)
        return 2
    from chem_workbench.execution import build_water_resolved_plan

    try:
        plan = build_water_resolved_plan(geometry, deadline_seconds=args.deadline)
    except (OSError, ValueError, TypeError, AttributeError, KeyError) as error:
        print(f"error CHM9001: {error}", file=sys.stderr)
        return 3
    try:
        _write_artifact(args.output, pretty_bytes(plan), args.force)
    except (OSError, ValueError) as error:
        print(f"error CHM9003: {error}", file=sys.stderr)
        return 2
    return 0


def _resolve_command(args: argparse.Namespace) -> int:
    from chem_workbench.execution import (
        ExecutionStore,
        build_cu_resolved_plan,
    )

    try:
        store = ExecutionStore(Path(args.store))
        draft = json.loads(_read_bytes(args.draft).decode("utf-8"))
        if draft.get("version") == "cu-scan-proposal/v1":
            plan = build_cu_resolved_plan(draft, deadline_seconds=args.deadline)
        elif draft.get("version") == "resolved-plan/v1" and draft.get("kind") == "water_hf_sto3g":
            plan = draft
        else:
            raise ValueError("UNSUPPORTED_PROFILE: unknown draft version")
        store.save_plan(plan)
    except (OSError, ValueError, TypeError, AttributeError, KeyError) as error:
        print(f"error CHM9001: {error}", file=sys.stderr)
        return 3
    try:
        _write_artifact(args.output, pretty_bytes(plan), args.force)
    except (OSError, ValueError) as error:
        print(f"error CHM9003: {error}", file=sys.stderr)
        return 2
    return 0


def _approve_command(args: argparse.Namespace) -> int:
    from chem_workbench.execution import ExecutionStore, issue_approval
    from chem_workbench.execution_validation import validate_plan
    from chem_workbench.workflows import WorkflowService

    try:
        store = ExecutionStore(Path(args.store))
        document = json.loads(_read_bytes(args.plan).decode("utf-8"))
        workflow = (
            document
            if isinstance(document, dict) and document.get("version") == "workflow/v1"
            else None
        )
        plan = workflow["plan"] if workflow is not None else document
        validate_plan(plan)
        if plan != store.load_plan(plan["resolved_plan_hash"]):
            raise ValueError("APPROVAL_STALE: reviewed plan differs from stored plan")
        if workflow is not None:
            service = WorkflowService(Path(args.store))
            stored = service.store._read(service._path(workflow["reference"]))
            if (
                stored["resolved_plan_hash"] != plan["resolved_plan_hash"]
                or stored["source"] != workflow["source"]
                or stored["attachments"] != workflow["attachments"]
            ):
                raise ValueError(
                    "APPROVAL_STALE: reviewed workflow differs from the stored context"
                )
        approval = issue_approval(
            store,
            plan["resolved_plan_hash"],
            actor=args.actor,
            ttl_seconds=args.ttl,
            max_launches=args.launches,
        )
        if workflow is not None:
            stored.update(approval_token=approval["token"], state="approved")
            service.store._write(service._path(workflow["reference"]), stored)
    except (OSError, KeyError, ValueError, TypeError, AttributeError) as error:
        print(f"error CHM9001: {error}", file=sys.stderr)
        return 3
    print(f"approval_token={approval['token']}")
    print(f"resolved_plan_hash={approval['resolved_plan_hash']}")
    print(f"expires_at={approval['expires_at']}")
    return 0


def _run_command(args: argparse.Namespace) -> int:
    from chem_workbench.execution import ExecutionStore, submit_run

    try:
        store = ExecutionStore(Path(args.store))
        job = submit_run(store, args.approval, launch_intent=args.intent)
    except (OSError, ValueError, TypeError, AttributeError, KeyError) as error:
        print(f"error CHM9001: {error}", file=sys.stderr)
        return 3
    print(f"job_id={job['job_id']}")
    print(f"status={job['status']}")
    if job.get("failure"):
        print(f"failure={job['failure']}", file=sys.stderr)
        return 1
    return 0 if job["status"] == "succeeded" else 1


def _prepare_workflow_command(args: argparse.Namespace) -> int:
    from chem_workbench.workflows import WorkflowService

    try:
        request = {
            "source": _read_bytes(args.source).decode("utf-8"),
            "profile": args.profile,
            "object_id": args.object_id,
            "attachments": json.loads(_read_bytes(args.attachments).decode("utf-8"))
            if args.attachments
            else {},
        }
        if args.profile == "water":
            if not args.geometry:
                raise ValueError("NEEDS_INPUT: --geometry is required for water")
            request["geometry"] = json.loads(_read_bytes(args.geometry).decode("utf-8"))
        else:
            request["scales"] = args.scales
        record = WorkflowService(Path(args.store)).prepare(request)
        _write_artifact(
            args.output, (json.dumps(record, indent=2) + "\n").encode("utf-8"), args.force
        )
        return 0
    except (OSError, ValueError, TypeError, KeyError) as error:
        print(f"error CHM9001: {error}", file=sys.stderr)
        return 3


def _job_control_command(args: argparse.Namespace) -> int:
    from chem_workbench.execution import ExecutionStore, cancel_job, recover_interrupted_jobs

    try:
        store = ExecutionStore(Path(args.store))
        if args.command == "cancel":
            result = cancel_job(store, args.job)
        elif args.command == "recover":
            result = {"interrupted": recover_interrupted_jobs(store)}
        else:
            loaded_job = store.load_job(args.job)
            if loaded_job is None:
                raise ValueError("JOB_NOT_FOUND")
            result = loaded_job
            result.pop("approval_token", None)
        print(json.dumps(result, indent=2))
        return 0
    except (OSError, ValueError) as error:
        print(f"error CHM9001: {error}", file=sys.stderr)
        return 3


def _unavailable_command(args: argparse.Namespace) -> int:
    print(
        f"error CHM9001: '{args.command}' is planned but unavailable in Chem Workbench alpha. "
        "No backend, network service, approval ledger, or laboratory path was invoked.",
        file=sys.stderr,
    )
    return 3


def _add_artifact_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--output", "-o", help="Explicit artifact path; default is stdout.")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Replace an existing regular output file.",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="chem",
        description="Deterministic, software-only Chem Workbench alpha.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    commands = parser.add_subparsers(dest="command", required=True)

    check_parser = commands.add_parser("check", help="Parse and validate .chem source.")
    check_parser.add_argument("source")
    check_parser.add_argument("--format", choices=("text", "json"), default="text")
    check_parser.add_argument(
        "--resolve-imports",
        action="store_true",
        help="Also import referenced CIF sources through the registered capability.",
    )
    check_parser.set_defaults(handler=_check_command)

    compile_parser = commands.add_parser(
        "compile", help="Compile .chem source without executing scientific software."
    )
    compile_parser.add_argument("source")
    compile_parser.add_argument("--emit", choices=("chemir",), default="chemir")
    compile_parser.add_argument(
        "--resolve-imports",
        action="store_true",
        help="Attach typed lattice and site data from referenced CIF sources.",
    )
    _add_artifact_options(compile_parser)
    compile_parser.set_defaults(handler=_compile_command)

    review_parser = commands.add_parser(
        "review-compile", help="Build a deterministic, non-approving review packet."
    )
    review_parser.add_argument("source_or_chemir")
    _add_artifact_options(review_parser)
    review_parser.set_defaults(handler=_review_compile_command)

    capabilities_parser = commands.add_parser(
        "capabilities",
        help="Report the immutable static adapter registry without discovery.",
    )
    capability_format = capabilities_parser.add_mutually_exclusive_group()
    capability_format.add_argument(
        "--format",
        choices=("json", "text"),
        default="json",
        help="Output format; JSON is the deterministic artifact form.",
    )
    capability_format.add_argument(
        "--json",
        action="store_const",
        const="json",
        dest="format",
        help="Alias for --format json.",
    )
    _add_artifact_options(capabilities_parser)
    capabilities_parser.set_defaults(handler=_capabilities_command)

    inspect_parser = commands.add_parser(
        "inspect",
        help="Inspect a supported local ChemIR, review, or adapter artifact.",
    )
    inspect_parser.add_argument("artifact")
    inspect_parser.set_defaults(handler=_inspect_command)

    probe_parser = commands.add_parser(
        "probe",
        help="Read-only CIF profile probe; emits a schema-valid loss report.",
    )
    probe_parser.add_argument("source")
    _add_artifact_options(probe_parser)
    probe_parser.set_defaults(handler=_probe_command)

    convert_parser = commands.add_parser(
        "convert",
        help="Import an admitted explicit-P1 CIF into typed ChemIR.",
    )
    convert_parser.add_argument("source")
    convert_parser.add_argument("--format", choices=("cif",), default="cif")
    convert_parser.add_argument("--loss-output", default=None)
    _add_artifact_options(convert_parser)
    convert_parser.set_defaults(handler=_convert_command)

    propose_cu_parser = commands.add_parser(
        "propose-cu",
        help="Propose a bounded copper cell-scale draft (no execution).",
    )
    propose_cu_parser.add_argument("cif")
    propose_cu_parser.add_argument(
        "--scales", nargs="+", type=float, required=True, help="2-9 factors in [0.95, 1.05]."
    )
    _add_artifact_options(propose_cu_parser)
    propose_cu_parser.set_defaults(handler=_propose_cu_command)

    propose_water_parser = commands.add_parser(
        "propose-water",
        help="Resolve the pinned water HF/STO-3G plan (no execution).",
    )
    propose_water_parser.add_argument("geometry")
    propose_water_parser.add_argument("--deadline", type=int, default=300)
    _add_artifact_options(propose_water_parser)
    propose_water_parser.set_defaults(handler=_propose_water_command)

    resolve_parser = commands.add_parser(
        "resolve",
        help="Store a draft as a resolved, executable plan.",
    )
    resolve_parser.add_argument("draft")
    resolve_parser.add_argument("--store", required=True)
    resolve_parser.add_argument("--deadline", type=int, default=300)
    _add_artifact_options(resolve_parser)
    resolve_parser.set_defaults(handler=_resolve_command)

    approve_parser = commands.add_parser(
        "approve",
        help="Bind an execution approval to one exact resolved plan.",
    )
    approve_parser.add_argument("plan")
    approve_parser.add_argument("--store", required=True)
    approve_parser.add_argument("--actor", default="local-user")
    approve_parser.add_argument("--ttl", type=int, default=3600)
    approve_parser.add_argument("--launches", type=int, default=1)
    approve_parser.set_defaults(handler=_approve_command)

    run_parser = commands.add_parser(
        "run",
        help="Execute an approved plan through the supervised runner.",
    )
    run_parser.add_argument("approval")
    run_parser.add_argument("--store", required=True)
    run_parser.add_argument(
        "--intent",
        default="default",
        help="Launch intent: the same intent is idempotent; a new one spends a launch.",
    )
    run_parser.set_defaults(handler=_run_command)

    preparation = commands.add_parser(
        "prepare", help="Prepare the same source-bound workflow as the desktop client."
    )
    preparation.add_argument("source")
    preparation.add_argument("--profile", choices=("water", "copper"), required=True)
    preparation.add_argument("--object-id", required=True)
    preparation.add_argument("--attachments", help="Explicit attachment-name to text JSON map")
    preparation.add_argument("--geometry", help="Explicit water geometry JSON")
    preparation.add_argument("--scales", nargs="+", type=float, default=[0.98, 1.0, 1.02])
    preparation.add_argument("--store", required=True)
    _add_artifact_options(preparation)
    preparation.set_defaults(handler=_prepare_workflow_command)

    for command in ("job", "cancel", "recover"):
        control = commands.add_parser(command, help="Inspect, cancel or recover owned local jobs.")
        control.add_argument("--store", required=True)
        if command != "recover":
            control.add_argument("job")
        control.set_defaults(handler=_job_control_command)

    compute_parser = commands.add_parser("compute", help="Planned; unavailable in alpha.")
    compute_parser.add_argument("arguments", nargs=argparse.REMAINDER)
    compute_parser.set_defaults(handler=_unavailable_command)

    fetch_parser = commands.add_parser("fetch", help="Planned; unavailable in alpha.")
    fetch_parser.add_argument("arguments", nargs=argparse.REMAINDER)
    fetch_parser.set_defaults(handler=_unavailable_command)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    handler = args.handler
    return int(handler(args))


if __name__ == "__main__":
    raise SystemExit(main())
