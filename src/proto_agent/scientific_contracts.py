"""Small, strict scientific identity and quantity contracts.

This module deliberately supports a finite set of units and coordinate frames.
Unknown semantics are rejected rather than guessed. It is not a replacement for
a domain ontology or a general-purpose unit package.
"""
from __future__ import annotations

import math
import re
from decimal import Decimal, InvalidOperation
from typing import Any


MANIFEST_SCHEMA = "proto-agent.dataset-manifest.v1"
QUANTITY_SCHEMA = "proto-agent.quantity.v1"
COORDINATE_SCHEMA = "proto-agent.coordinate-system.v1"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$")

# dimension, semantic kind, scale to canonical unit, offset to canonical unit
UNITS: dict[str, tuple[str, str, Decimal, Decimal]] = {
    "1": ("dimensionless", "value", Decimal("1"), Decimal("0")),
    "count": ("count", "value", Decimal("1"), Decimal("0")),
    "residue": ("residue-index", "value", Decimal("1"), Decimal("0")),
    "base_pair": ("base-pair-index", "value", Decimal("1"), Decimal("0")),
    "index": ("array-index", "value", Decimal("1"), Decimal("0")),
    "angstrom": ("length", "value", Decimal("1"), Decimal("0")),
    "nanometer": ("length", "value", Decimal("10"), Decimal("0")),
    "micrometer": ("length", "value", Decimal("10000"), Decimal("0")),
    "meter": ("length", "value", Decimal("10000000000"), Decimal("0")),
    "pixel": ("pixel", "value", Decimal("1"), Decimal("0")),
    "second": ("time", "value", Decimal("1"), Decimal("0")),
    "millisecond": ("time", "value", Decimal("0.001"), Decimal("0")),
    "kelvin": ("temperature", "absolute", Decimal("1"), Decimal("0")),
    "degree_Celsius": ("temperature", "absolute", Decimal("1"), Decimal("273.15")),
    "delta_kelvin": ("temperature", "interval", Decimal("1"), Decimal("0")),
    "delta_degree_Celsius": ("temperature", "interval", Decimal("1"), Decimal("0")),
    "mol/L": ("concentration", "value", Decimal("1"), Decimal("0")),
    "mmol/L": ("concentration", "value", Decimal("0.001"), Decimal("0")),
    "gram_per_mole": ("molar-mass", "value", Decimal("1"), Decimal("0")),
    "dalton": ("particle-mass", "value", Decimal("1"), Decimal("0")),
}

COORDINATE_FRAMES: dict[str, tuple[str, int]] = {
    "pdb-auth-residue": ("residue", 1),
    "pdb-label-residue": ("residue", 1),
    "array-axis": ("index", 0),
    "image-pixel": ("pixel", 0),
    "cartesian": ("angstrom", 0),
}


class ScientificContractError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _identifier(value: Any, label: str) -> str:
    if not isinstance(value, str) or not IDENTIFIER_RE.fullmatch(value):
        raise ScientificContractError("SCIENTIFIC_ID_INVALID", f"{label} must be a bounded stable identifier.")
    return value


def _nonnegative_int(value: Any, label: str) -> int:
    if type(value) is not int or value < 0 or value > (1 << 63) - 1:
        raise ScientificContractError("SCIENTIFIC_INTEGER_INVALID", f"{label} must be a non-negative 64-bit integer.")
    return value


def _decimal(value: Any, label: str) -> Decimal:
    if type(value) not in (int, float) or (type(value) is float and not math.isfinite(value)):
        raise ScientificContractError("SCIENTIFIC_NUMBER_INVALID", f"{label} must be a finite number or null.")
    try:
        result = Decimal(str(value))
    except InvalidOperation:
        raise ScientificContractError("SCIENTIFIC_NUMBER_INVALID", f"{label} is not a valid finite number.") from None
    if not result.is_finite() or abs(result) > Decimal("1e100"):
        raise ScientificContractError("SCIENTIFIC_NUMBER_INVALID", f"{label} is outside the supported finite range.")
    return result


def validate_quantity(value: Any, *, entity_ids: set[str] | None = None) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ScientificContractError("QUANTITY_INVALID", "A quantity must be an object.")
    allowed = {"schema_version", "value", "unit", "quantity_kind", "entity_id", "missing_reason"}
    if set(value) - allowed or not {"schema_version", "value", "unit", "quantity_kind"} <= set(value):
        raise ScientificContractError("QUANTITY_INVALID", "Quantity fields do not match the supported contract.")
    if value["schema_version"] != QUANTITY_SCHEMA:
        raise ScientificContractError("QUANTITY_SCHEMA_UNSUPPORTED", "Quantity schema version is unsupported.")
    unit = value["unit"]
    if not isinstance(unit, str) or unit not in UNITS:
        raise ScientificContractError("QUANTITY_UNIT_UNSUPPORTED", "Quantity unit is not in the reviewed unit table.")
    expected_kind = UNITS[unit][1]
    if value["quantity_kind"] != expected_kind:
        raise ScientificContractError("QUANTITY_KIND_MISMATCH", f"Unit {unit} requires quantity_kind={expected_kind}.")
    result = dict(value)
    entity_id = value.get("entity_id")
    entity_id = _identifier(entity_id, "quantity.entity_id")
    if entity_ids is not None and entity_id not in entity_ids:
        raise ScientificContractError("QUANTITY_ENTITY_UNKNOWN", "Quantity references an entity absent from its dataset manifest.")
    result["entity_id"] = entity_id
    missing_reason = value.get("missing_reason")
    if value["value"] is None:
        if not isinstance(missing_reason, str) or not missing_reason.strip() or len(missing_reason) > 500:
            raise ScientificContractError("QUANTITY_MISSING_REASON_REQUIRED", "A null quantity requires an explicit missing_reason; null is never treated as zero.")
    else:
        number = _decimal(value["value"], "quantity.value")
        dimension, _kind, scale, offset = UNITS[unit]
        if dimension in {"count", "residue-index", "base-pair-index", "array-index"} and number != number.to_integral_value():
            raise ScientificContractError("QUANTITY_INTEGER_REQUIRED", f"Unit {unit} requires an integer value.")
        if dimension == "temperature" and expected_kind == "absolute" and number * scale + offset < 0:
            raise ScientificContractError("QUANTITY_BELOW_ABSOLUTE_ZERO", "Absolute temperature cannot be below zero kelvin.")
        if missing_reason is not None:
            raise ScientificContractError("QUANTITY_MISSING_REASON_CONFLICT", "A present quantity cannot also carry a missing_reason.")
    return result


def convert_quantity(value: Any, source_unit: str, target_unit: str, quantity_kind: str) -> dict[str, str]:
    if source_unit not in UNITS or target_unit not in UNITS:
        raise ScientificContractError("QUANTITY_UNIT_UNSUPPORTED", "Unit conversion requires reviewed source and target units.")
    source_dimension, source_kind, source_scale, source_offset = UNITS[source_unit]
    target_dimension, target_kind, target_scale, target_offset = UNITS[target_unit]
    if source_dimension != target_dimension or source_kind != target_kind or quantity_kind != source_kind:
        raise ScientificContractError("QUANTITY_INCOMPATIBLE", "Units have incompatible dimensions or absolute/interval semantics.")
    number = _decimal(value, "quantity.value")
    canonical = number * source_scale + source_offset
    converted = (canonical - target_offset) / target_scale
    return {"value": format(converted.normalize(), "f"), "source_unit": source_unit, "target_unit": target_unit,
            "quantity_kind": quantity_kind, "source_value": format(number.normalize(), "f")}


def validate_coordinate_system(value: Any, *, file_ids: set[str] | None = None) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ScientificContractError("COORDINATE_SYSTEM_INVALID", "A coordinate system must be an object.")
    allowed = {"schema_version", "id", "frame", "origin", "unit", "reference_file_id"}
    if set(value) != allowed:
        raise ScientificContractError("COORDINATE_SYSTEM_INVALID", "Coordinate-system fields do not match the supported contract.")
    if value["schema_version"] != COORDINATE_SCHEMA:
        raise ScientificContractError("COORDINATE_SCHEMA_UNSUPPORTED", "Coordinate-system schema version is unsupported.")
    identifier = _identifier(value["id"], "coordinate_system.id")
    frame = value["frame"]
    if frame not in COORDINATE_FRAMES:
        raise ScientificContractError("COORDINATE_FRAME_UNSUPPORTED", "Coordinate frame is not explicitly supported.")
    expected_unit, expected_origin = COORDINATE_FRAMES[frame]
    if value["unit"] != expected_unit or value["origin"] != expected_origin or type(value["origin"]) is not int:
        raise ScientificContractError("COORDINATE_FRAME_MISMATCH", "Coordinate unit and origin must match the declared frame.")
    reference_file_id = _identifier(value["reference_file_id"], "coordinate_system.reference_file_id")
    if file_ids is not None and reference_file_id not in file_ids:
        raise ScientificContractError("COORDINATE_REFERENCE_UNKNOWN", "Coordinate system references a file absent from its dataset manifest.")
    return {"schema_version": COORDINATE_SCHEMA, "id": identifier, "frame": frame,
            "origin": expected_origin, "unit": expected_unit, "reference_file_id": reference_file_id}


def coordinate_systems_compatible(left: dict[str, Any], right: dict[str, Any]) -> bool:
    """Return true only when both coordinate records name the same frame and source."""
    try:
        a = validate_coordinate_system(left)
        b = validate_coordinate_system(right)
    except ScientificContractError:
        return False
    return (a["frame"], a["origin"], a["unit"], a["reference_file_id"]) == (
        b["frame"], b["origin"], b["unit"], b["reference_file_id"])


def validate_dataset_manifest(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ScientificContractError("DATASET_MANIFEST_INVALID", "Dataset manifest must be an object.")
    allowed = {"schema_version", "dataset_id", "display_name", "files", "entities", "references", "quantities", "coordinate_systems"}
    required = {"schema_version", "dataset_id", "files", "entities", "references", "quantities", "coordinate_systems"}
    if set(value) - allowed or not required <= set(value):
        raise ScientificContractError("DATASET_MANIFEST_INVALID", "Dataset manifest fields do not match the supported contract.")
    if value["schema_version"] != MANIFEST_SCHEMA:
        raise ScientificContractError("DATASET_MANIFEST_SCHEMA_UNSUPPORTED", "Dataset manifest schema version is unsupported.")
    dataset_id = _identifier(value["dataset_id"], "dataset_id")
    display_name = value.get("display_name", "")
    if not isinstance(display_name, str) or len(display_name) > 200:
        raise ScientificContractError("DATASET_MANIFEST_INVALID", "display_name must be text no longer than 200 characters.")

    files = value["files"]
    if not isinstance(files, list) or not 1 <= len(files) <= 128:
        raise ScientificContractError("DATASET_FILES_INVALID", "Dataset manifests must bind 1 to 128 files.")
    file_ids: set[str] = set()
    file_roles: dict[str, str] = {}
    file_records = []
    for index, item in enumerate(files):
        if not isinstance(item, dict):
            raise ScientificContractError("DATASET_FILE_INVALID", f"files[{index}] must be an object.")
        required_file = {"id", "path", "role", "sha256", "bytes"}
        if set(item) - (required_file | {"indexed_file_id"}) or not required_file <= set(item):
            raise ScientificContractError("DATASET_FILE_INVALID", f"files[{index}] fields do not match the supported contract.")
        file_id = _identifier(item["id"], f"files[{index}].id")
        if file_id in file_ids:
            raise ScientificContractError("DATASET_FILE_DUPLICATE", "Dataset file IDs must be unique.")
        file_ids.add(file_id)
        path = item["path"]
        if not isinstance(path, str) or not path or len(path) > 400 or path.startswith(("/", "\\")) or ":" in path or any(part in {"", ".", ".."} for part in path.replace("\\", "/").split("/")):
            raise ScientificContractError("DATASET_PATH_INVALID", "Dataset file paths must be normalized workspace-relative paths without traversal.")
        role = item["role"]
        if role not in {"measurement", "metadata", "reference", "index", "annotation", "structure", "image", "other"}:
            raise ScientificContractError("DATASET_FILE_ROLE_UNSUPPORTED", "Dataset file role is not supported.")
        file_roles[file_id] = role
        digest = item["sha256"]
        if not isinstance(digest, str) or not SHA256_RE.fullmatch(digest):
            raise ScientificContractError("DATASET_FILE_HASH_INVALID", "Dataset file sha256 must be lowercase hexadecimal SHA-256.")
        record = {"id": file_id, "path": path.replace("\\", "/"), "role": role,
                  "sha256": digest, "bytes": _nonnegative_int(item["bytes"], f"files[{index}].bytes")}
        if role == "index":
            record["indexed_file_id"] = _identifier(item.get("indexed_file_id"), f"files[{index}].indexed_file_id")
        elif "indexed_file_id" in item:
            raise ScientificContractError("DATASET_FILE_INVALID", "Only an index file can declare indexed_file_id.")
        file_records.append(record)
    for record in file_records:
        indexed = record.get("indexed_file_id")
        if indexed is not None and (indexed not in file_ids or indexed == record["id"] or file_roles.get(indexed) == "index"):
            raise ScientificContractError("DATASET_INDEX_BINDING_INVALID", "Index files must bind to another file in the same manifest.")

    entities = value["entities"]
    if not isinstance(entities, list) or len(entities) > 4096:
        raise ScientificContractError("DATASET_ENTITIES_INVALID", "entities must be a bounded array.")
    entity_ids: set[str] = set()
    entity_records = []
    for index, item in enumerate(entities):
        if not isinstance(item, dict) or set(item) - {"id", "type", "namespace", "identifier"} or not {"id", "type"} <= set(item):
            raise ScientificContractError("DATASET_ENTITY_INVALID", f"entities[{index}] fields do not match the supported contract.")
        entity_id = _identifier(item["id"], f"entities[{index}].id")
        entity_type = _identifier(item["type"], f"entities[{index}].type")
        if entity_id in entity_ids:
            raise ScientificContractError("DATASET_ENTITY_DUPLICATE", "Dataset entity IDs must be unique.")
        entity_ids.add(entity_id)
        record = {"id": entity_id, "type": entity_type}
        for field in ("namespace", "identifier"):
            if field in item:
                record[field] = _identifier(item[field], f"entities[{index}].{field}")
        entity_records.append(record)

    references = value["references"]
    if not isinstance(references, list) or len(references) > 1024:
        raise ScientificContractError("DATASET_REFERENCES_INVALID", "references must be a bounded array.")
    reference_ids: set[str] = set()
    reference_records = []
    for index, item in enumerate(references):
        if not isinstance(item, dict) or set(item) - {"id", "type", "file_id", "identifier", "version"} or not {"id", "type", "file_id"} <= set(item):
            raise ScientificContractError("DATASET_REFERENCE_INVALID", f"references[{index}] fields do not match the supported contract.")
        reference_id = _identifier(item["id"], f"references[{index}].id")
        if reference_id in reference_ids:
            raise ScientificContractError("DATASET_REFERENCE_DUPLICATE", "Dataset reference IDs must be unique.")
        reference_ids.add(reference_id)
        file_id = _identifier(item["file_id"], f"references[{index}].file_id")
        if file_id not in file_ids:
            raise ScientificContractError("DATASET_REFERENCE_FILE_UNKNOWN", "Reference records must bind to a dataset file.")
        if file_roles[file_id] not in {"reference", "annotation", "other"}:
            raise ScientificContractError("DATASET_REFERENCE_ROLE_INVALID", "A named reference must bind to a reference, annotation, or explicitly generic file.")
        record = {"id": reference_id, "type": _identifier(item["type"], f"references[{index}].type"), "file_id": file_id}
        for field in ("identifier", "version"):
            if field in item:
                record[field] = _identifier(item[field], f"references[{index}].{field}")
        reference_records.append(record)

    quantities = value["quantities"]
    if not isinstance(quantities, list) or len(quantities) > 20000:
        raise ScientificContractError("DATASET_QUANTITIES_INVALID", "quantities must be a bounded array.")
    quantity_records = [validate_quantity(item, entity_ids=entity_ids) for item in quantities]
    coordinate_systems = value["coordinate_systems"]
    if not isinstance(coordinate_systems, list) or len(coordinate_systems) > 256:
        raise ScientificContractError("DATASET_COORDINATES_INVALID", "coordinate_systems must be a bounded array.")
    coordinate_records = [validate_coordinate_system(item, file_ids=file_ids) for item in coordinate_systems]
    if len({item["id"] for item in coordinate_records}) != len(coordinate_records):
        raise ScientificContractError("COORDINATE_SYSTEM_DUPLICATE", "Coordinate-system IDs must be unique.")
    coordinate_roles = {"pdb-auth-residue": {"structure"}, "pdb-label-residue": {"structure"},
                        "cartesian": {"structure"}, "image-pixel": {"image"}, "array-axis": {"measurement", "metadata", "other"}}
    if any(file_roles[item["reference_file_id"]] not in coordinate_roles[item["frame"]] for item in coordinate_records):
        raise ScientificContractError("COORDINATE_REFERENCE_ROLE_INVALID", "Coordinate frames must bind to a compatible source-file role.")

    result: dict[str, Any] = {"schema_version": MANIFEST_SCHEMA, "dataset_id": dataset_id, "display_name": display_name,
        "files": file_records, "entities": entity_records, "references": reference_records,
        "quantities": quantity_records, "coordinate_systems": coordinate_records}
    return result


__all__ = ["COORDINATE_SCHEMA", "MANIFEST_SCHEMA", "QUANTITY_SCHEMA", "ScientificContractError",
           "convert_quantity", "coordinate_systems_compatible", "validate_coordinate_system",
           "validate_dataset_manifest", "validate_quantity"]
