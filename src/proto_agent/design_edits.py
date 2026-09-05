"""Typed source-edit preparation for review; never writes a design or an IR.

Callers apply the returned source candidate through their existing patch review
transaction, binding both source and materialized-library digests at apply time.
"""
from __future__ import annotations

import difflib
import hashlib
import json
import re
from pathlib import Path
from typing import Any, Literal, TypedDict

from .compiler import compile_design_text
from .dna_placement import occurrence_ids, valid_local_id, validate_annotation_declaration
from .models import Construct
from .parser import parse_design_text
from .security import MAX_JSON_FILE_BYTES, MAX_TEXT_FILE_BYTES, read_bytes_bounded


class ReorderOccurrences(TypedDict):
    type: Literal["reorder_occurrences"]
    construct: str
    instance_ids: list[str]


class SetOrientation(TypedDict):
    type: Literal["set_orientation"]
    construct: str
    instance_id: str
    orientation: Literal["forward", "reverse"]


class UpsertAnnotation(TypedDict):
    type: Literal["upsert_annotation"]
    construct: str
    annotation: dict[str, Any]


class DeleteAnnotation(TypedDict):
    type: Literal["delete_annotation"]
    construct: str
    annotation_id: str


DesignEditCommand = ReorderOccurrences | SetOrientation | UpsertAnnotation | DeleteAnnotation


def prepare_design_edit(
    source_text: str,
    commands: list[DesignEditCommand],
    *,
    parts_path: str | Path,
    source_path: str = "design.proto",
    expected_source_sha256: str | None = None,
    expected_parts_sha256: str | None = None,
) -> dict[str, Any]:
    """Produce a checked source candidate and diff, preserving unrelated bytes.

    An obsolete source/library digest is a rebase failure, never an instruction
    to apply an edit to a newer design by guessed line number or resource ID.
    """
    result: dict[str, Any] = {
        "ok": False, "candidate_source": source_text, "unified_diff": "", "diagnostics": [],
        "source_sha256": "", "candidate_sha256": "", "parts_sha256": "",
        "affected_occurrences": [], "affected_annotations": [],
    }
    try:
        if not isinstance(source_text, str) or len(source_text.encode("utf-8")) > MAX_TEXT_FILE_BYTES:
            raise ValueError("Source must be bounded UTF-8 text.")
        source_digest = _digest(source_text.encode("utf-8"))
        result["source_sha256"] = result["candidate_sha256"] = source_digest
        if expected_source_sha256 is not None and source_digest != expected_source_sha256:
            return _failure(result, source_path, "DNA_EDIT_REBASE_REQUIRED", "Source bytes changed; refresh the source and explicitly rebase the edit.")
        library_digest = _digest(read_bytes_bounded(Path(parts_path), MAX_JSON_FILE_BYTES))
        result["parts_sha256"] = library_digest
        if expected_parts_sha256 is not None and library_digest != expected_parts_sha256:
            return _failure(result, source_path, "DNA_EDIT_REBASE_REQUIRED", "Materialized library bytes changed; refresh the selection and explicitly rebase the edit.")
        if not isinstance(commands, list) or not 1 <= len(commands) <= 100:
            raise ValueError("An edit transaction requires 1-100 commands.")
        newline = "\r\n" if "\r\n" in source_text else "\n"
        trailing_newline = source_text.endswith(("\n", "\r"))
        lines = source_text.splitlines()
        for command in commands:
            _validate_command(command)
            construct = _find_construct(lines, command["construct"], source_path)
            identifiers = occurrence_ids(construct.parts)
            # Persist local identities before moving a legacy occurrence. These
            # identifiers are local references, never biological resource IDs.
            for part, identifier in zip(construct.parts, identifiers):
                if part.instance_id is None:
                    lines[part.line - 1] = _set_option(lines[part.line - 1], "instance", identifier)
            construct = _find_construct(lines, command["construct"], source_path)
            operation = command["type"]
            if operation == "reorder_occurrences":
                requested = command["instance_ids"]
                if not isinstance(requested, list) or len(requested) != len(identifiers) or any(not valid_local_id(value) for value in requested) or set(requested) != set(identifiers):
                    raise ValueError("Reorder must contain each occurrence instance exactly once; resource IDs are not occurrence IDs.")
                _reorder(lines, construct, requested)
                result["affected_occurrences"].extend({"construct": construct.name, "instance_id": identifier} for identifier in requested)
            elif operation == "set_orientation":
                selected = [part for part in construct.parts if part.instance_id == command["instance_id"]]
                if len(selected) != 1 or command["orientation"] not in {"forward", "reverse"}:
                    raise ValueError("Set orientation requires one existing occurrence and forward or reverse.")
                part = selected[0]
                lines[part.line - 1] = _set_option(lines[part.line - 1], "orientation", command["orientation"])
                result["affected_occurrences"].append({"construct": construct.name, "instance_id": part.instance_id})
            elif operation == "upsert_annotation":
                annotation = command["annotation"]
                if not isinstance(annotation, dict) or set(annotation) != {"id", "name", "type", "anchors", "origin"} or not valid_local_id(annotation["id"]):
                    raise ValueError("Upsert annotation requires an id and a complete bounded source annotation.")
                payload = {key: annotation[key] for key in ("name", "type", "anchors", "origin")}
                validate_annotation_declaration(payload)
                existing = next((item for item in construct.annotations if item.id == annotation["id"]), None)
                indentation = re.match(r"\s*", lines[construct.parts[0].line - 1]).group() if construct.parts else "  "
                declaration = f"{indentation}annotation {annotation['id']} {json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}"
                if existing:
                    lines[existing.line - 1] = declaration
                else:
                    end = next((index for index in range(construct.line, len(lines)) if re.match(r"\s*(?:construct|constraint|design)\s", lines[index])), len(lines))
                    lines.insert(end, declaration)
                result["affected_annotations"].append({"construct": construct.name, "annotation_id": annotation["id"]})
            else:
                existing = next((item for item in construct.annotations if item.id == command["annotation_id"]), None)
                if existing is None:
                    raise ValueError("Delete annotation requires an existing annotation ID.")
                del lines[existing.line - 1]
                result["affected_annotations"].append({"construct": construct.name, "annotation_id": existing.id})
        candidate = newline.join(lines) + (newline if trailing_newline else "")
        if len(candidate.encode("utf-8")) > MAX_TEXT_FILE_BYTES:
            raise ValueError("Edited source exceeds the source byte limit.")
        ir, diagnostics = compile_design_text(candidate, parts_path, source_path=source_path)
        if library_digest != _digest(read_bytes_bounded(Path(parts_path), MAX_JSON_FILE_BYTES)):
            return _failure(result, source_path, "DNA_EDIT_REBASE_REQUIRED", "Materialized library changed while validating the edit; rebase is required.")
        result.update({
            "ok": ir is not None and not any(item.severity == "error" for item in diagnostics),
            "candidate_source": candidate, "candidate_sha256": _digest(candidate.encode("utf-8")),
            "unified_diff": "".join(difflib.unified_diff(source_text.splitlines(keepends=True), candidate.splitlines(keepends=True), fromfile=f"a/{source_path}", tofile=f"b/{source_path}")),
            "diagnostics": [item.to_dict() for item in diagnostics],
        })
        return result
    except (ValueError, OSError, KeyError, TypeError) as error:
        return _failure(result, source_path, "DNA_EDIT_INVALID", str(error))


def _validate_command(command: Any) -> None:
    fields = {
        "reorder_occurrences": {"type", "construct", "instance_ids"},
        "set_orientation": {"type", "construct", "instance_id", "orientation"},
        "upsert_annotation": {"type", "construct", "annotation"},
        "delete_annotation": {"type", "construct", "annotation_id"},
    }
    if not isinstance(command, dict) or not isinstance(command.get("type"), str) or command["type"] not in fields or set(command) != fields[command["type"]]:
        raise ValueError("Unsupported edit command or missing/unknown command fields.")
    if not isinstance(command["construct"], str) or not 1 <= len(command["construct"]) <= 256:
        raise ValueError("An edit command requires a bounded construct name.")


def _find_construct(lines: list[str], name: str, source_path: str) -> Construct:
    design, diagnostics = parse_design_text("\n".join(lines), source_path=source_path)
    if design is None or any(item.severity == "error" for item in diagnostics):
        raise ValueError("Source syntax must be valid before preparing a structural edit.")
    matches = [construct for construct in design.constructs if construct.name == name]
    if len(matches) != 1:
        raise ValueError("An edit requires one unambiguous existing construct.")
    return matches[0]


def _set_option(line: str, key: str, value: str) -> str:
    body, marker, comment = line.partition("#")
    if re.search(rf"\b{key}=\S+", body):
        body = re.sub(rf"\b{key}=\S+", f"{key}={value}", body)
    else:
        body = body.rstrip() + f" {key}={value}" + (" " if marker else "")
    return body + marker + comment


def _reorder(lines: list[str], construct: Construct, requested: list[str]) -> None:
    slots = []
    chunks = {}
    previous_end = construct.line
    for part in construct.parts:
        end = part.line
        start = end - 1
        while start > previous_end and lines[start - 1].lstrip().startswith("#"):
            start -= 1
        slots.append((start, end))
        chunks[part.instance_id] = lines[start:end]
        previous_end = end
    output = []
    cursor = 0
    for (start, end), identifier in zip(slots, requested):
        output.extend(lines[cursor:start])
        output.extend(chunks[identifier])
        cursor = end
    output.extend(lines[cursor:])
    lines[:] = output


def _digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _failure(result: dict[str, Any], source: str, code: str, message: str) -> dict[str, Any]:
    result["diagnostics"] = [{"severity": "error", "file": source, "line": 0, "code": code, "message": message}]
    return result
