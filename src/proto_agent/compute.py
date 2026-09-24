"""Bounded, offline scientific computations and source-bound result artifacts.

The registry contains reviewed Biomni adaptations and separately labelled Proto
statistics. No upstream agent, generated code, network, or plugin import runs.
"""
from __future__ import annotations

from .evidence_standing import evidence_standing

import hashlib
import importlib.util
import json
import math
import platform
from datetime import datetime, timezone
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any
from uuid import uuid4

from . import (compute_assay, compute_bio, compute_chem, compute_clinical, compute_flowcyto, compute_histology,
               compute_imaging, compute_medical, compute_ml, compute_omics, compute_popgen, compute_sequence,
               compute_simulation, compute_stats)
from . import compute_structures as compute_structures_module
from . import compute_research, compute_protein_study, compute_structure_prediction, compute_rnaseq
from .compute_maturity import maturity_for
from .compute_quantities import QUANTITY_SUPPORTED, add_result_quantities, validate_bindings
from .compute_quantity_exemptions import QUANTITY_EXEMPT
from .provenance import create_provenance
from .scientific_contracts import QUANTITY_SCHEMA, ScientificContractError, validate_dataset_manifest, validate_quantity
from .security import WorkspacePaths, read_bytes_bounded, write_text_bounded

UPSTREAM_COMMIT = "400c1f366b96a35ca253e13c9b06c5076af41d65"
UPSTREAM_URL = "https://github.com/snap-stanford/Biomni"
SCHEMA = "proto-agent.compute.v1"
MAX_INPUT_BYTES = 2 * 1024 * 1024
MAX_RESULT_BYTES = 4 * 1024 * 1024
MAX_DATASET_MANIFESTS = 8
MAX_DATASET_MANIFEST_BYTES = 256 * 1024
MAX_DATASET_MANIFEST_TOTAL_BYTES = 2 * 1024 * 1024
MAX_DATASET_FILE_BYTES = 128 * 1024 * 1024
MAX_DATASET_TOTAL_BYTES = 512 * 1024 * 1024
MAX_RESULT_VALUE_INDEX_ENTRIES = 5_000
MAX_RESULT_VALUE_INDEX_BYTES = 1 * 1024 * 1024
MAX_RESULT_VALUE_POINTER_CHARS = 2048
TOOLS = {**compute_stats.TOOLS, **compute_bio.TOOLS, **compute_sequence.TOOLS,
         **compute_simulation.TOOLS, **compute_assay.TOOLS, **compute_clinical.TOOLS, **compute_omics.TOOLS,
         **compute_flowcyto.TOOLS, **compute_structures_module.TOOLS, **compute_ml.TOOLS,
         **compute_imaging.TOOLS, **compute_chem.TOOLS, **compute_popgen.TOOLS,
         **compute_medical.TOOLS, **compute_histology.TOOLS, **compute_research.TOOLS, **compute_protein_study.TOOLS, **compute_structure_prediction.TOOLS, **compute_rnaseq.TOOLS}
HANDLERS = {**compute_stats.HANDLERS, **compute_bio.HANDLERS, **compute_sequence.HANDLERS,
            **compute_simulation.HANDLERS, **compute_assay.HANDLERS, **compute_clinical.HANDLERS, **compute_omics.HANDLERS,
            **compute_flowcyto.HANDLERS, **compute_structures_module.HANDLERS, **compute_ml.HANDLERS,
            **compute_imaging.HANDLERS, **compute_chem.HANDLERS, **compute_popgen.HANDLERS,
            **compute_medical.HANDLERS, **compute_histology.HANDLERS, **compute_research.HANDLERS, **compute_protein_study.HANDLERS, **compute_structure_prediction.HANDLERS, **compute_rnaseq.HANDLERS}

# Product navigation metadata travels with the authoritative runtime catalog.
# New methods inherit their module's group without a second renderer ID list.
TOOL_GROUPS = (
    (compute_rnaseq, "rnaseq_studies", "RNA-seq studies", "biology"),
    (compute_protein_study, "protein_studies", "Protein comparative studies", "biology"),
    (compute_structure_prediction, "structure_predictions", "Structure prediction results", "biology"),
    (compute_research, "research_biology", "Expression, diversity & molecular profiles", "biology"),
    (compute_stats, "statistics", "Statistical methods", "statistics"),
    (compute_ml, "machine_learning", "Machine learning", "statistics"),
    (compute_bio, "molecular_biology", "Molecular biology", "biology"),
    (compute_sequence, "sequence", "Sequence analysis", "biology"),
    (compute_assay, "assays", "Assays & instrument data", "biology"),
    (compute_clinical, "clinical", "Clinical & pharmacometric data", "biology"),
    (compute_omics, "omics", "Genomics & expression", "biology"),
    (compute_popgen, "population_genetics", "Population genetics & networks", "biology"),
    (compute_flowcyto, "flow_cytometry", "Flow cytometry", "biology"),
    (compute_structures_module, "structures", "Structures & coordinates", "biology"),
    (compute_simulation, "simulation", "Systems & simulations", "simulation"),
    (compute_imaging, "image_analysis", "Image measurements", "imaging"),
    (compute_histology, "microscopy", "Microscopy & histology", "imaging"),
    (compute_medical, "medical_imaging", "Medical imaging", "imaging"),
    (compute_chem, "chemistry", "Cheminformatics & RNA folding", "chemistry"),
)
TOOL_CATEGORIES = {name: {"id": identifier, "title": title, "section": section}
                   for module, identifier, title, section in TOOL_GROUPS for name in module.TOOLS}


def _plain(value):
    """Coerce NumPy scalars to builtins so every result is plain JSON."""
    if isinstance(value, dict):
        return {key: _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    import numpy

    if isinstance(value, numpy.integer):
        return int(value)
    if isinstance(value, numpy.floating):
        return float(value)
    return value


def _input_claims(snapshot_path, provenance):
    """Provenance-ready input claims: one per single file, one per list entry."""
    claims = {"request_snapshot": snapshot_path}
    for field, entries in provenance.items():
        if isinstance(entries, list):
            for index, (bound_path, data) in enumerate(entries):
                claims[f"file:{field}[{index}]"] = {"path": bound_path, "sha256": hashlib.sha256(data).hexdigest()}
        else:
            claims[f"file:{field}"] = {"path": entries[0], "sha256": hashlib.sha256(entries[1]).hexdigest()}
    return claims


class ComputeError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _missing(metadata: dict) -> list[str]:
    return [name for name in metadata.get("dependency", []) if importlib.util.find_spec(name) is None]


def prepare_compute_runtime() -> None:
    """Initialize installed numerical extensions on the MCP reader thread.

    On Windows, NumPy's initial extension import can deadlock in a worker while
    the reader blocks on stdin. Call only when the first compute run arrives;
    catalog discovery and dependency-free installations remain lightweight.
    """
    if importlib.util.find_spec("numpy") is None:
        return
    try:
        import numpy  # noqa: F401
        if importlib.util.find_spec("scipy") is not None:
            from scipy import optimize, stats  # noqa: F401
    except (ImportError, OSError, RuntimeError) as exc:
        raise ComputeError("COMPUTE_RUNTIME_UNAVAILABLE", "The installed numerical runtime could not initialize; repair the compute optional extra.") from exc


def compute_catalog(tool: str | None = None) -> dict[str, Any]:
    if tool is not None and tool not in TOOLS:
        raise ComputeError("COMPUTE_UNKNOWN_TOOL", "Unknown computation; use compute catalog.")
    entries = []
    for name, metadata in TOOLS.items():
        if tool is not None and tool != name:
            continue
        item = {"id": name, **metadata, "category": TOOL_CATEGORIES[name], "maturity": maturity_for(name, metadata),
                "quantity_profile": {"status": "requires-dataset-binding" if name in QUANTITY_SUPPORTED else "exempt",
                                     "reason": QUANTITY_EXEMPT.get(name, "Only explicitly bound output fields carry quantity contracts; other values remain unquantified.")},
                "available": not _missing(metadata), "missing_dependencies": _missing(metadata)}
        if tool is None:
            item.pop("input_schema", None)
            item.pop("example", None)
        entries.append(item)
    return {"ok": True, "schema_version": SCHEMA, "upstream": {"url": UPSTREAM_URL, "commit": UPSTREAM_COMMIT, "license": "Apache-2.0"},
            "tools": entries, "count": len(entries), "scope": "Offline data analysis; scientific interpretation requires human review.",
            "usage": "Get a tool's catalog entry for its schema and example. Save {tool, arguments} as workspace JSON; optionally add dataset_manifests: [workspace-relative JSON paths] to bind checked dataset, reference, and index identities. The descriptive_statistics and normalize_gene_expression_counts methods accept explicit quantity_bindings; see examples/compute/quantity-statistics.json and quantity-counts.json. Run compute run PATH.",
            "dependency_install": "python -m pip install -e .[compute]"}


def _validate(value: Any, schema: dict, path: str = "arguments") -> None:
    """Validate the deliberately small schema vocabulary used by this registry."""
    kind = schema.get("type")
    valid = {"object": isinstance(value, dict), "array": isinstance(value, list),
             "string": isinstance(value, str), "boolean": type(value) is bool,
             "integer": type(value) is int,
             "number": type(value) in (int, float)}.get(kind, False)
    if not valid:
        raise ValueError(f"{path} must be {kind}.")
    if kind in ("number", "integer"):
        if abs(value) > 1e100 or not math.isfinite(value):
            raise ValueError(f"{path} must be finite and within +/-1e100.")
        if "minimum" in schema and value < schema["minimum"] or "maximum" in schema and value > schema["maximum"]:
            raise ValueError(f"{path} is outside its allowed range.")
        if "exclusiveMinimum" in schema and value <= schema["exclusiveMinimum"]:
            raise ValueError(f"{path} must exceed {schema['exclusiveMinimum']}.")
        if "exclusiveMaximum" in schema and value >= schema["exclusiveMaximum"]:
            raise ValueError(f"{path} must be below {schema['exclusiveMaximum']}.")
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError(f"{path} is not an allowed choice.")
    if kind == "object":
        properties = schema.get("properties", {})
        unknown = value.keys() - properties.keys()
        if unknown:
            raise ValueError(f"{path} contains unknown fields: {', '.join(sorted(unknown))}.")
        if set(schema.get("required", [])) - value.keys():
            raise ValueError(f"{path} is missing required fields.")
        for key, item in value.items():
            _validate(item, properties[key], f"{path}.{key}")
    if kind == "array":
        if not schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", 5000):
            raise ValueError(f"{path} has an invalid item count.")
        for index, item in enumerate(value):
            _validate(item, schema["items"], f"{path}[{index}]")
    if kind == "string" and not schema.get("minLength", 0) <= len(value) <= schema.get("maxLength", 10000):
        raise ValueError(f"{path} has an invalid length.")


def _pairs(items: list[tuple[str, Any]]) -> dict:
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("Duplicate JSON field names are not allowed.")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise ValueError(f"Nonfinite JSON number {value} is not allowed.")


def _decode(raw: bytes, *, compute_request: bool = True, max_nodes: int = 100_000) -> dict:
    try:
        value = json.loads(raw.decode("utf-8-sig"), object_pairs_hook=_pairs, parse_constant=_reject_constant)
    except (UnicodeError, RecursionError, ValueError) as exc:
        raise ComputeError("COMPUTE_INVALID_JSON", str(exc)) from exc
    # Independent limits: generic MCP JSON limits deliberately remain unchanged.
    nodes = 0
    def walk(item: Any, depth: int = 0) -> None:
        nonlocal nodes
        nodes += 1
        if nodes > max_nodes or depth > 12:
            raise ValueError("Computation input exceeds structural limits.")
        if isinstance(item, dict):
            if len(item) > 100:
                raise ValueError("Too many JSON properties.")
            for child in item.values():
                walk(child, depth + 1)
        elif isinstance(item, list):
            if len(item) > 10000:
                raise ValueError("Too many JSON array items.")
            for child in item:
                walk(child, depth + 1)
        elif isinstance(item, str) and len(item) > 20000:
            raise ValueError("JSON string exceeds limits.")
    walk(value)
    if not isinstance(value, dict):
        raise ValueError("A computation document must contain a JSON object.")
    if compute_request and (not {"tool", "arguments"} <= set(value)
            or set(value) - {"tool", "arguments", "dataset_manifests", "quantity_bindings"} or not isinstance(value["tool"], str)):
        raise ValueError("A computation request must contain tool and arguments, with only optional dataset_manifests and quantity_bindings fields.")
    return value


def _load_compute_request(path: str, *, workspace_root: str | Path = ".", require_dependencies: bool = False):
    if require_dependencies:
        paths = WorkspacePaths.create(workspace_root)
    else:
        # Fingerprint preflight must not create build/cache directories. Keep
        # the same component/reparse and contained-file boundary as Compute.
        from .security import SecurityBoundaryError, _assert_absolute_components_no_reparse
        requested = Path(workspace_root).absolute()
        _assert_absolute_components_no_reparse(requested)
        try:
            workspace = requested.resolve(strict=True)
        except OSError as exc:
            raise SecurityBoundaryError("WORKSPACE_UNREADABLE", "Workspace cannot be resolved safely.") from exc
        if not workspace.is_dir():
            raise SecurityBoundaryError("WORKSPACE_NOT_DIRECTORY", "Workspace must be a directory.")
        paths = WorkspacePaths(workspace, workspace / "build", workspace / "build/cache")
    source = paths.workspace_file(path, extensions={".json"}, max_bytes=MAX_INPUT_BYTES)
    raw = read_bytes_bounded(source, MAX_INPUT_BYTES)
    request = _decode(raw)
    tool = request["tool"]
    if tool not in TOOLS:
        raise ComputeError("COMPUTE_UNKNOWN_TOOL", "Unknown computation; use compute catalog.")
    metadata = TOOLS[tool]
    _validate(request["arguments"], metadata["input_schema"])
    missing = _missing(metadata) if require_dependencies else []
    if missing:
        raise ComputeError("COMPUTE_DEPENDENCY_MISSING", f"Missing {', '.join(missing)}; install the compute optional extra.")
    relative = lambda file: file.relative_to(paths.workspace).as_posix()
    file_inputs = metadata.get("file_inputs")
    input_files, _file_provenance = {}, {}
    if file_inputs:
        for field, declaration in file_inputs.items():
            supplied = request["arguments"].get(field)
            if supplied is None:
                if declaration.get("required") is False:
                    continue
                raise ValueError(f"{field} is required as a workspace-relative file path.")
            maximum = declaration.get("max_files", 200)
            if declaration.get("list"):
                if (not isinstance(supplied, list) or not 1 <= len(supplied) <= maximum
                        or any(not isinstance(item, str) for item in supplied)):
                    raise ValueError(f"{field} must be a list of 1 to {maximum} workspace-relative file paths.")
                bundle, provenance = [], []
                for item in supplied:
                    bound = paths.workspace_file(item, extensions=set(declaration["extensions"]), max_bytes=declaration["max_bytes"])
                    data = read_bytes_bounded(bound, declaration["max_bytes"])
                    bundle.append(data)
                    provenance.append((relative(bound), data))
                input_files[field] = bundle
                _file_provenance[field] = provenance
                continue
            bound = paths.workspace_file(supplied, extensions=set(declaration["extensions"]), max_bytes=declaration["max_bytes"])
            data = read_bytes_bounded(bound, declaration["max_bytes"])
            input_files[field] = data
            _file_provenance[field] = (relative(bound), data)
    dataset_context = _load_dataset_manifests(request.get("dataset_manifests", []), paths, relative, _file_provenance)
    try:
        validate_bindings(tool, request["arguments"], request.get("quantity_bindings"), dataset_context)
    except ScientificContractError as exc:
        raise ComputeError(exc.code, str(exc)) from exc
    return paths, source, raw, request, metadata, input_files, _file_provenance, dataset_context


def _load_dataset_manifests(value: Any, paths: WorkspacePaths, relative, provenance: dict) -> list[dict[str, Any]]:
    """Validate and hash-bind optional dataset/reference manifests for a run."""
    if not isinstance(value, list) or len(value) > MAX_DATASET_MANIFESTS or any(not isinstance(item, str) for item in value):
        raise ComputeError("COMPUTE_DATASET_MANIFESTS_INVALID", f"dataset_manifests must be an array of at most {MAX_DATASET_MANIFESTS} workspace-relative JSON paths.")
    if len(set(value)) != len(value):
        raise ComputeError("COMPUTE_DATASET_MANIFESTS_DUPLICATE", "A dataset manifest path may appear only once in a compute request.")
    context: list[dict[str, Any]] = []
    total_bytes = 0
    manifests_bytes = 0
    dataset_ids: set[str] = set()
    for index, manifest_path in enumerate(value):
        manifest_file = paths.workspace_file(manifest_path, extensions={".json"}, max_bytes=MAX_DATASET_MANIFEST_BYTES)
        manifest_bytes = read_bytes_bounded(manifest_file, MAX_DATASET_MANIFEST_BYTES)
        manifests_bytes += len(manifest_bytes)
        if manifests_bytes > MAX_DATASET_MANIFEST_TOTAL_BYTES:
            raise ComputeError("COMPUTE_DATASET_MANIFESTS_TOO_LARGE", "Dataset manifests exceed the combined manifest-byte budget.")
        manifest_value = _decode(manifest_bytes, compute_request=False)
        try:
            manifest = validate_dataset_manifest(manifest_value)
        except ScientificContractError as exc:
            raise ComputeError(exc.code, str(exc)) from exc
        if manifest["dataset_id"] in dataset_ids:
            raise ComputeError("COMPUTE_DATASET_MANIFESTS_DUPLICATE", "Dataset IDs must be unique in one compute request.")
        dataset_ids.add(manifest["dataset_id"])
        provenance[f"dataset-manifest[{index}]"] = (relative(manifest_file), manifest_bytes)
        total_bytes += len(manifest_bytes)
        for file_index, item in enumerate(manifest["files"]):
            bound = paths.workspace_file(item["path"], max_bytes=MAX_DATASET_FILE_BYTES)
            data = read_bytes_bounded(bound, MAX_DATASET_FILE_BYTES)
            total_bytes += len(data)
            if total_bytes > MAX_DATASET_TOTAL_BYTES:
                raise ComputeError("COMPUTE_DATASET_TOTAL_TOO_LARGE", "Bound dataset manifests exceed the total identity-check budget.")
            if len(data) != item["bytes"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
                raise ComputeError("COMPUTE_DATASET_IDENTITY_CHANGED", f"Dataset file {item['id']} no longer matches its declared byte count and SHA-256.")
            provenance[f"dataset[{index}].file[{file_index}]"] = (relative(bound), data)
        context.append({"path": relative(manifest_file), "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(), "manifest": manifest})
    return context


def _result_value_index(result: Any, *, entity_sources: dict[str, str], ambiguous_entity_ids: set[str]) -> dict[str, Any]:
    """Bind numeric result values to exact JSON Pointers without assigning meaning."""
    entries: list[dict[str, Any]] = []
    value_count = 0
    index_bytes = 0

    def add(pointer: str, value: Any, *, quantity: dict[str, Any] | None = None) -> None:
        nonlocal value_count, index_bytes
        value_count += 1
        if (
            len(pointer) > MAX_RESULT_VALUE_POINTER_CHARS
            or len(entries) >= MAX_RESULT_VALUE_INDEX_ENTRIES
            or index_bytes >= MAX_RESULT_VALUE_INDEX_BYTES
        ):
            return
        scalar_type = "null" if value is None else ("integer" if type(value) is int else "number")
        canonical = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        entry: dict[str, Any] = {
            "pointer": pointer,
            "json_type": scalar_type,
            "value": value,
            "value_sha256": hashlib.sha256(canonical).hexdigest(),
        }
        if quantity is not None:
            entry["quantity"] = {
                "schema_version": QUANTITY_SCHEMA,
                "unit": quantity["unit"],
                "quantity_kind": quantity["quantity_kind"],
                "entity_id": quantity["entity_id"],
                "dataset_id": entity_sources[quantity["entity_id"]],
                "contract_validated": True,
            }
            if value is None:
                entry["quantity"]["missing_reason"] = quantity["missing_reason"]
        else:
            entry["quantity"] = None
        entry_bytes = len(json.dumps(entry, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))
        if index_bytes + entry_bytes > MAX_RESULT_VALUE_INDEX_BYTES:
            return
        entries.append(entry)
        index_bytes += entry_bytes

    def escape(token: str) -> str:
        return token.replace("~", "~0").replace("/", "~1")

    def visit(value: Any, pointer: str, depth: int = 0) -> None:
        if depth > 64:
            raise ComputeError("COMPUTE_RESULT_DEPTH_EXCEEDED", "The result is too deeply nested to build a safe value index.")
        if isinstance(value, dict):
            if value.get("schema_version") == QUANTITY_SCHEMA:
                if value.get("entity_id") in ambiguous_entity_ids:
                    raise ComputeError("COMPUTE_RESULT_ENTITY_AMBIGUOUS", f"Result quantity at {pointer or '/'} refers to an entity ID shared by multiple datasets.")
                try:
                    normalized = validate_quantity(value, entity_ids=set(entity_sources))
                except ScientificContractError as exc:
                    raise ComputeError(exc.code, f"Result quantity at {pointer or '/'} failed its unit or entity contract: {exc}") from exc
                add(f"{pointer}/value", normalized["value"], quantity=normalized)
                for key, child in value.items():
                    if key != "value":
                        visit(child, f"{pointer}/{escape(key)}", depth + 1)
                return
            for key, child in value.items():
                visit(child, f"{pointer}/{escape(str(key))}", depth + 1)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                visit(child, f"{pointer}/{index}", depth + 1)
        elif type(value) in (int, float):
            add(pointer, value)

    visit(result, "")
    indexed_count = len(entries)
    return {
        "schema_version": "proto.compute-value-index.v1",
        "status": "complete" if indexed_count == value_count else "partial",
        "value_count": value_count,
        "indexed_count": indexed_count,
        "omitted_count": value_count - indexed_count,
        "index_bytes": index_bytes,
        "entries": entries,
    }


def read_compute_value(
    path: str,
    pointer: str,
    expected_result_sha256: str,
    expected_manifest_sha256: str,
    *,
    workspace_root: str | Path = ".",
) -> dict[str, Any]:
    """Return one indexed scalar after verifying the saved run artifact hash."""
    import re

    paths = WorkspacePaths.create(workspace_root)
    if not isinstance(pointer, str) or len(pointer) > MAX_RESULT_VALUE_POINTER_CHARS or (pointer and not pointer.startswith("/")):
        raise ComputeError("COMPUTE_RESULT_POINTER_INVALID", "pointer must be the empty root pointer or a bounded RFC 6901 JSON Pointer.")
    if not isinstance(expected_result_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_result_sha256):
        raise ComputeError("COMPUTE_RESULT_HASH_INVALID", "expected_result_sha256 must be a lowercase SHA-256 value.")
    if not isinstance(expected_manifest_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_manifest_sha256):
        raise ComputeError("COMPUTE_MANIFEST_HASH_INVALID", "expected_manifest_sha256 must be a lowercase SHA-256 value.")
    try:
        result_file = paths.workspace_file(path, extensions={".json"}, max_bytes=compute_rnaseq.MAX_RESULT)
        WorkspacePaths._assert_contained(paths.build / "compute", result_file, "PATH_OUTSIDE_COMPUTE")
    except Exception as exc:
        raise ComputeError(getattr(exc, "code", "COMPUTE_RESULT_UNAVAILABLE"), "The result must be a bounded compute artifact inside build/compute/.") from exc
    if result_file.name != "result.json" or not re.fullmatch(r"[0-9a-f]{32}", result_file.parent.name):
        raise ComputeError("COMPUTE_RESULT_PATH_INVALID", "Expected build/compute/<run-id>/result.json.")
    relative_result = result_file.relative_to(paths.workspace).as_posix()
    manifest_relative = f"build/compute/{result_file.parent.name}/manifest.json"
    manifest_file = paths.workspace_file(manifest_relative, extensions={".json"}, max_bytes=4 * 1024 * 1024)
    manifest_raw = read_bytes_bounded(manifest_file, 4 * 1024 * 1024)
    manifest_sha256 = hashlib.sha256(manifest_raw).hexdigest()
    if manifest_sha256 != expected_manifest_sha256:
        raise ComputeError("COMPUTE_MANIFEST_HASH_MISMATCH", "The run manifest changed after its source-locatable result index was issued.")
    manifest = _decode(manifest_raw, compute_request=False, max_nodes=500_000)
    if manifest.get("schema_version") != SCHEMA or relative_result not in manifest.get("artifacts", []):
        raise ComputeError("COMPUTE_RESULT_MANIFEST_MISMATCH", "The run manifest does not name this result artifact.")

    result_raw = read_bytes_bounded(result_file, compute_rnaseq.MAX_RESULT)
    result_sha256 = hashlib.sha256(result_raw).hexdigest()
    if result_sha256 != expected_result_sha256 or result_sha256 != manifest.get("result_sha256"):
        raise ComputeError("COMPUTE_RESULT_HASH_MISMATCH", "The result artifact no longer matches the expected and recorded SHA-256 values.")
    value_index = manifest.get("result_value_index")
    if not isinstance(value_index, dict) or value_index.get("schema_version") != "proto.compute-value-index.v1":
        raise ComputeError("COMPUTE_RESULT_INDEX_UNAVAILABLE", "This run predates the source-locatable result index.")
    entry = next((item for item in value_index.get("entries", []) if isinstance(item, dict) and item.get("pointer") == pointer), None)
    if entry is None:
        raise ComputeError("COMPUTE_RESULT_POINTER_NOT_INDEXED", f"The requested value is not indexed; index status is {value_index.get('status', 'unknown')}.")
    value = entry.get("value")
    canonical = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if hashlib.sha256(canonical).hexdigest() != entry.get("value_sha256"):
        raise ComputeError("COMPUTE_RESULT_INDEX_CORRUPT", "The indexed value does not match its recorded value hash.")
    json_type = entry.get("json_type")
    if type(value) not in (int, float) and value is not None:
        raise ComputeError("COMPUTE_RESULT_INDEX_CORRUPT", "The indexed value is not a numeric scalar or an explicit null.")
    exact_text = None if value is None else (str(value) if type(value) is int else repr(value))
    transport_value = str(value) if type(value) is int and abs(value) > 9_007_199_254_740_991 else value
    value_encoding = "json-null" if value is None else ("decimal-string" if transport_value is not value else "json-number")
    return {
        "ok": True,
        "schema_version": "proto.compute-value-evidence.v1",
        "result_path": relative_result,
        "result_sha256": result_sha256,
        "manifest_sha256": manifest_sha256,
        "pointer": pointer,
        "json_type": json_type,
        "value": transport_value,
        "value_text": exact_text,
        "value_encoding": value_encoding,
        "value_sha256": entry["value_sha256"],
        "quantity": entry.get("quantity"),
        "result_index_status": value_index.get("status"),
        "method_maturity": manifest.get("maturity"),
        "scientific_validation": manifest.get("maturity", {}).get("scientific_validation", "not-established"),
        "review_status": manifest.get("review_status", "unknown"),
        "source_role": "saved-computation-output; integrity-bound, not an independent scientific validation",
    }


def run_compute(path: str, *, workspace_root: str | Path = ".", cancel_event: Any = None) -> dict[str, Any]:
    from .compute_identity import bind_execution_fingerprint, fingerprint_prepared
    prepared = _load_compute_request(path, workspace_root=workspace_root, require_dependencies=True)
    paths, source, raw, request, metadata, input_files, _file_provenance, dataset_context = prepared
    tool = request["tool"]
    file_inputs = metadata.get("file_inputs")
    relative = lambda file: file.relative_to(paths.workspace).as_posix()
    if cancel_event is not None and cancel_event.is_set():
        raise ComputeError("COMPUTE_CANCELLED", "Computation was cancelled before execution.")
    execution_identity = fingerprint_prepared(prepared)
    if cancel_event is not None and cancel_event.is_set():
        raise ComputeError("COMPUTE_CANCELLED", "Computation was cancelled during execution preflight.")
    if tool == "analyze_rnaseq_study":
        result = compute_rnaseq.analyze_rnaseq_study(request["arguments"], input_files,
            workspace_root=paths.workspace, cancel_event=cancel_event)
    else:
        result = HANDLERS[tool](request["arguments"], input_files) if file_inputs else HANDLERS[tool](request["arguments"])
    result = _plain(result)  # NumPy scalars cannot serialize; coerce before encoding.
    try:
        result = add_result_quantities(tool, request["arguments"], result, request.get("quantity_bindings"), dataset_context)
    except ScientificContractError as exc:
        raise ComputeError(exc.code, str(exc)) from exc
    entity_sources: dict[str, str] = {}
    ambiguous_entity_ids: set[str] = set()
    for dataset_item in dataset_context:
        dataset_id = dataset_item["manifest"]["dataset_id"]
        for entity in dataset_item["manifest"]["entities"]:
            entity_id = entity["id"]
            if entity_id in entity_sources and entity_sources[entity_id] != dataset_id:
                ambiguous_entity_ids.add(entity_id)
            else:
                entity_sources[entity_id] = dataset_id
    result_value_index = _result_value_index(result, entity_sources=entity_sources, ambiguous_entity_ids=ambiguous_entity_ids)
    # Full transcriptome tables have a reviewed larger artifact bound. Other
    # tools keep their existing limit; no result rows are truncated to fit it.
    result_limit = compute_rnaseq.MAX_RESULT if tool == "analyze_rnaseq_study" else MAX_RESULT_BYTES
    encoded = json.dumps(result, ensure_ascii=False, indent=None if tool == "analyze_rnaseq_study" else 2, allow_nan=False) + "\n"
    if len(encoded.encode("utf-8")) > result_limit:
        raise ComputeError("COMPUTE_RESULT_TOO_LARGE", "Computation result exceeds artifact limits.")
    if cancel_event is not None and cancel_event.is_set():
        raise ComputeError("COMPUTE_CANCELLED", "Computation was cancelled before artifact publication.")
    execution_fingerprint = bind_execution_fingerprint(execution_identity, path, paths.workspace)
    if cancel_event is not None and cancel_event.is_set():
        raise ComputeError("COMPUTE_CANCELLED", "Computation was cancelled during identity recheck.")
    run_id = uuid4().hex
    root = paths.build_directory(f"build/compute/{run_id}")
    input_path = paths.build_file(relative(root / "input.json"))
    result_path = paths.build_file(relative(root / "result.json"))
    manifest_path = paths.build_file(relative(root / "manifest.json"))
    # Save the exact text used for this run, independently of subsequent source edits.
    write_text_bounded(input_path, raw.decode("utf-8"), max_bytes=MAX_INPUT_BYTES, boundary=paths.build)
    write_text_bounded(result_path, encoded, max_bytes=result_limit, boundary=paths.build)
    runtime = {"python": platform.python_version()}
    for dependency in metadata.get("dependency", []):
        try:
            runtime[dependency] = version({"Bio":"biopython"}.get(dependency, dependency))
        except PackageNotFoundError:
            runtime[dependency] = "bundled-version-unavailable"
    if tool == "analyze_rnaseq_study" and result["analysis"]["status"] == "complete":
        engine_metadata = result["analysis"]["engine_metadata"]
        runtime.update({"R": engine_metadata["R_version"], "DESeq2": engine_metadata["DESeq2_version"],
                        "deseq2_engine_run_id": result["analysis"]["engine_run_id"]})
    maturity = maturity_for(tool, metadata)
    origin = "fixture" if source.is_relative_to(paths.workspace / "examples") else ("imported" if dataset_context or file_inputs else "synthetic")
    manifest = {"schema_version": SCHEMA, "ok": True, "run_id": run_id, "tool": tool,
                "created_at": datetime.now(timezone.utc).isoformat(), "implementation": metadata["implementation"],
                "implementation_version": 1, "upstream_commit": UPSTREAM_COMMIT if metadata["implementation"] == "biomni-adapted" else None,
                "method_references": metadata.get("method_references", []), "maturity": maturity,
                "result_value_index": result_value_index,
                "upstream_functions": metadata.get("upstream_functions", []), "runtime": runtime,
                "source": {"path": relative(source), "sha256": hashlib.sha256(raw).hexdigest()},
                "inputs": _input_claims(relative(input_path), _file_provenance), "artifacts": [relative(result_path)],
                "result_sha256": hashlib.sha256(encoded.encode("utf-8")).hexdigest(),
                "execution_fingerprint": execution_fingerprint,
                "review_status": "human_review_required", "evidence_standing": evidence_standing(method_maturity=maturity["method_stage"], data_origin=origin, execution_status="completed"),
                "scope": "Software-only analysis of user-supplied data; no biological design eligibility or clinical validity is conferred."}
    if dataset_context:
        manifest["dataset_manifests"] = dataset_context
    write_text_bounded(manifest_path, json.dumps(manifest, indent=2, allow_nan=False) + "\n", boundary=paths.build)
    provenance = create_provenance(relative(manifest_path), workspace_root=paths.workspace)
    artifacts = [relative(result_path), relative(input_path), relative(manifest_path), relative(root / "provenance.json")]
    return {**{key: value for key, value in manifest.items() if key != "result_value_index"},
            "result_value_index": {key: value for key, value in result_value_index.items() if key != "entries"},
            "manifest_path": relative(manifest_path), "manifest_sha256": provenance["subject"]["sha256"], "artifacts": artifacts,
            "result": result if len(encoded) <= 24000 else {"stored_in": relative(result_path), "preview_omitted": True}}


# Capture application/environment identity before the first scientific import.
# Importing this helper never loads numerical libraries or probes external R.
from .compute_identity import register_loaded_compute as _register_loaded_compute
_register_loaded_compute()
