"""Pure, bounded DNA placement and source-anchored annotation semantics.

Placement is a sequence transform. It never establishes biological direction.
All geometry uses zero-based, half-open coordinates on the displayed construct.
"""
from __future__ import annotations

import hashlib
import re
from typing import Any

DNA_IR_V2 = "proto-agent.ir.v2"
DNA_ALPHABET = frozenset("ACGTRYSWKMBDHVN")
PLACEMENT_ALGORITHM = "iupac-dna.v1"
_COMPLEMENT = str.maketrans("ACGTRYSWKMBDHVN", "TGCAYRSWMKVHDBN")
_LOCAL_ID = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,63}\Z")


def valid_local_id(value: Any) -> bool:
    return isinstance(value, str) and _LOCAL_ID.fullmatch(value) is not None


def dna_sha256(sequence: str) -> str:
    return hashlib.sha256(sequence.encode("ascii")).hexdigest()


def reverse_complement(sequence: str) -> str:
    if not isinstance(sequence, str) or not sequence or not set(sequence) <= DNA_ALPHABET:
        raise ValueError("DNA placement requires non-empty uppercase IUPAC DNA.")
    return sequence.translate(_COMPLEMENT)[::-1]


def placement_record(orientation: str) -> dict[str, str]:
    if not isinstance(orientation, str) or orientation not in {"forward", "reverse"}:
        raise ValueError("Placement orientation must be forward or reverse.")
    return {"orientation": orientation, "transform": "identity" if orientation == "forward" else "reverse_complement", "algorithm": PLACEMENT_ALGORITHM}


def occurrence_ids(parts: list[Any]) -> list[str]:
    explicit = [part.instance_id for part in parts if part.instance_id is not None]
    if any(not valid_local_id(identifier) for identifier in explicit) or len(set(explicit)) != len(explicit):
        raise ValueError("Occurrence instance IDs must be valid and unique within each construct.")
    reserved = set(explicit)
    identifiers: list[str] = []
    for index, part in enumerate(parts, start=1):
        identifier = part.instance_id
        if identifier is None:
            base = f"occurrence_{index:04d}"
            identifier = base
            suffix = 1
            while identifier in reserved:
                identifier = f"{base}_{suffix}"
                suffix += 1
        reserved.add(identifier)
        identifiers.append(identifier)
    return identifiers


def validate_annotation_declaration(payload: Any) -> None:
    if not isinstance(payload, dict) or set(payload) != {"name", "type", "anchors", "origin"}:
        raise ValueError("Annotation requires exactly name, type, anchors, and origin.")
    for field, limit in (("name", 256), ("type", 64)):
        value = payload[field]
        if not isinstance(value, str) or not value.strip() or len(value) > limit or any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError(f"Annotation {field} must be bounded text without controls.")
    if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", payload["type"]) is None:
        raise ValueError("Annotation type must be a bounded feature identifier.")
    if payload["origin"] != "user":
        raise ValueError("Source annotations require origin=user; they are not reviewed source evidence.")
    anchors = payload["anchors"]
    if not isinstance(anchors, list) or not 1 <= len(anchors) <= 64:
        raise ValueError("Annotation requires 1-64 source anchors.")
    seen: set[tuple[Any, ...]] = set()
    for anchor in anchors:
        if not isinstance(anchor, dict) or set(anchor) != {"instance_id", "start", "end", "direction"}:
            raise ValueError("Annotation anchor requires exactly instance_id, start, end, and direction.")
        if not valid_local_id(anchor["instance_id"]):
            raise ValueError("Annotation anchor instance_id is invalid.")
        if any(isinstance(anchor[key], bool) or not isinstance(anchor[key], int) for key in ("start", "end", "direction")):
            raise ValueError("Anchor coordinates and direction must be integers.")
        if not 0 <= anchor["start"] < anchor["end"] <= 10_000_000 or anchor["direction"] not in {-1, 0, 1}:
            raise ValueError("Anchor requires 0 <= start < end and direction=-1,0,1.")
        identity = tuple(anchor[key] for key in ("instance_id", "start", "end", "direction"))
        if identity in seen:
            raise ValueError("Duplicate annotation anchors are not allowed.")
        seen.add(identity)


def resolve_annotation(identifier: str, payload: dict[str, Any], parts: list[dict[str, Any]]) -> dict[str, Any]:
    if not valid_local_id(identifier):
        raise ValueError("Annotation ID is invalid.")
    validate_annotation_declaration(payload)
    by_instance = {part["instance_id"]: part for part in parts}
    locations = []
    for anchor in payload["anchors"]:
        part = by_instance.get(anchor["instance_id"])
        if part is None:
            raise ValueError(f"Annotation anchor references missing occurrence: {anchor['instance_id']}.")
        length = len(part["sequence"])
        if anchor["end"] > length:
            raise ValueError(f"Annotation anchor exceeds source occurrence {anchor['instance_id']}.")
        start, end, direction = anchor["start"], anchor["end"], anchor["direction"]
        if part["placement"]["orientation"] == "reverse":
            start, end, direction = length - end, length - start, -direction
        locations.append({"instance_id": anchor["instance_id"], "start": part["start"] + start, "end": part["start"] + end, "direction": direction})
    # Anchor order is intentional (including origin-spanning declarations).
    ordered = sorted(locations, key=lambda location: (location["start"], location["end"]))
    if any(right["start"] < left["end"] for left, right in zip(ordered, ordered[1:])):
        raise ValueError("Source spans within one annotation must not overlap after placement.")
    return {"id": identifier, **payload, "locations": locations}


def validate_v2_construct(construct: dict[str, Any]) -> None:
    parts = construct["parts"]
    seen: set[str] = set()
    position = 0
    for part in parts:
        identifier = part.get("instance_id")
        if not valid_local_id(identifier) or identifier in seen:
            raise ValueError("DNA v2 requires unique occurrence instance IDs.")
        seen.add(identifier)
        sequence = part["sequence"]
        placement = part.get("placement")
        if not isinstance(placement, dict) or placement != placement_record(placement.get("orientation")):
            raise ValueError("DNA v2 placement transform or algorithm is inconsistent.")
        source_sequence = reverse_complement(sequence) if placement["orientation"] == "reverse" else sequence
        if part.get("source_sequence_sha256") != dna_sha256(source_sequence) or part.get("sequence_sha256") != dna_sha256(sequence):
            raise ValueError("DNA v2 source/transformed sequence digest mismatch.")
        if any(type(part.get(field)) is not int for field in ("start", "end")) or part.get("start") != position or part.get("end") != position + len(sequence):
            raise ValueError("DNA v2 occurrence geometry is inconsistent.")
        source_direction = part.get("source_direction")
        if type(source_direction) is not int or source_direction not in {-1, 0, 1}:
            raise ValueError("DNA v2 source direction must be explicitly -1, 0, or 1.")
        direction = source_direction * (-1 if placement["orientation"] == "reverse" else 1)
        if type(part.get("direction")) is not int or part.get("direction") != direction:
            raise ValueError("DNA v2 biological direction disagrees with declared source direction.")
        position += len(sequence)
    sequence = "".join(part["sequence"] for part in parts)
    if type(construct.get("length")) is not int or construct.get("sequence") != sequence or construct.get("length") != position or construct.get("sequence_sha256") != dna_sha256(sequence):
        raise ValueError("DNA v2 assembled sequence or digest is inconsistent.")
    annotations = construct.get("annotations")
    if not isinstance(annotations, list) or len(annotations) > 1000:
        raise ValueError("DNA v2 annotations must be a bounded array.")
    annotation_ids: set[str] = set()
    for annotation in annotations:
        if not isinstance(annotation, dict) or set(annotation) != {"id", "name", "type", "anchors", "origin", "locations"}:
            raise ValueError("DNA v2 annotation shape is invalid.")
        identifier = annotation["id"]
        if not valid_local_id(identifier) or identifier in annotation_ids:
            raise ValueError("DNA v2 annotation IDs must be unique.")
        annotation_ids.add(identifier)
        payload = {key: annotation[key] for key in ("name", "type", "anchors", "origin")}
        validate_annotation_declaration({**payload, "anchors": annotation["locations"]})
        if annotation != resolve_annotation(identifier, payload, parts):
            raise ValueError("DNA v2 annotation locations do not match their source anchors.")
