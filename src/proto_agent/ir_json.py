"""Bounded JSON shape profile for typed compiler IR, not generic request JSON."""
from __future__ import annotations

from typing import Any

from .json_validation import JsonValidationError, decode_json_bounded

IR_JSON_MAX_NODES = 500_000
IR_JSON_MAX_DEPTH = 20
IR_JSON_MAX_ARRAY_ITEMS = 10_000
IR_JSON_MAX_SEQUENCE_CHARS = 10_000_000


def decode_ir_json(text: str, *, max_bytes: int) -> dict[str, Any]:
    """Decode within IR limits; load_ir subsequently validates domain and hashes.

    The separate byte cap remains 8 MiB at file boundaries. Collection and text
    limits cover the compiler's 10k occurrences and 10M total sequence bound;
    the typed validator applies the stricter per-field and domain constraints.
    """
    payload = decode_json_bounded(text, max_bytes=max_bytes)
    if not isinstance(payload, dict):
        raise JsonValidationError("Compiled IR must be a JSON object.")
    stack = [(payload, 0)]
    nodes = 0
    while stack:
        value, depth = stack.pop()
        nodes += 1
        if nodes > IR_JSON_MAX_NODES:
            raise JsonValidationError(f"Compiled IR exceeds the {IR_JSON_MAX_NODES}-node limit.")
        if depth > IR_JSON_MAX_DEPTH:
            raise JsonValidationError("Compiled IR exceeds the nesting depth limit.")
        if isinstance(value, dict):
            if len(value) > 128 or any(not isinstance(key, str) or len(key) > 128 for key in value):
                raise JsonValidationError("Compiled IR object fields exceed their bounds.")
            stack.extend((child, depth + 1) for child in value.values())
        elif isinstance(value, list):
            if len(value) > IR_JSON_MAX_ARRAY_ITEMS:
                raise JsonValidationError("Compiled IR array exceeds its item limit.")
            stack.extend((child, depth + 1) for child in value)
        elif isinstance(value, str) and len(value) > IR_JSON_MAX_SEQUENCE_CHARS:
            raise JsonValidationError("Compiled IR sequence field exceeds its character limit.")
    return payload
