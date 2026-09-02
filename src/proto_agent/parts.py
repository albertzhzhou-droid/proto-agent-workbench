from __future__ import annotations

from pathlib import Path
from typing import Any

from .security import MAX_JSON_FILE_BYTES, read_json_bounded

DEFAULT_PARTS_PATH = Path("parts") / "ecoli_k12_library.json"


def load_parts(path: str | Path = DEFAULT_PARTS_PATH) -> dict[str, Any]:
    payload = read_json_bounded(path, MAX_JSON_FILE_BYTES)
    if not isinstance(payload, dict):
        raise ValueError("Parts library must be a JSON object.")
    return payload


def part_index(library: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {part["id"]: part for part in library.get("parts", [])}


def search_parts(query: str, chassis: str | None = None, parts_path: str | Path = DEFAULT_PARTS_PATH) -> list[dict[str, Any]]:
    library = load_parts(parts_path)
    if chassis and library.get("chassis") != chassis:
        return []
    needle = query.lower()
    matches = []
    for part in library.get("parts", []):
        haystack = " ".join(
            str(part.get(field, "")) for field in ("id", "type", "name")
        ).lower()
        if needle in haystack:
            matches.append(part)
    return matches
