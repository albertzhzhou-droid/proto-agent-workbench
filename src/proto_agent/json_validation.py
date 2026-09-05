from __future__ import annotations

import json
import math
from dataclasses import dataclass
from typing import Any


MAX_JSON_DEPTH = 16
MAX_JSON_NODES = 2048


class JsonValidationError(ValueError):
    pass


@dataclass
class _Budget:
    nodes: int = 0

    def consume(self) -> None:
        self.nodes += 1
        if self.nodes > MAX_JSON_NODES:
            raise JsonValidationError(f"JSON value exceeds the {MAX_JSON_NODES}-node limit.")


def strict_json_loads(text: str, *, max_bytes: int) -> Any:
    value = decode_json_bounded(text, max_bytes=max_bytes)
    _validate_shape(value, 0, _Budget())
    return value


def decode_json_bounded(text: str, *, max_bytes: int) -> Any:
    """Strict syntax/byte decoding; callers must apply their typed shape limits.

    Generic requests must continue to use strict_json_loads. This separated
    decoder lets scientific IR use its own documented collection/sequence bounds
    without relaxing any request, material, annotation or manifest limits.
    """
    if not isinstance(text, str):
        raise JsonValidationError("JSON input must be text.")
    if len(text) > max_bytes:
        raise JsonValidationError(f"JSON input exceeds the {max_bytes}-byte limit.")
    try:
        encoded_length = len(text.encode("utf-8"))
    except UnicodeEncodeError as exc:
        raise JsonValidationError("JSON input contains invalid Unicode.") from exc
    if encoded_length > max_bytes:
        raise JsonValidationError(f"JSON input exceeds the {max_bytes}-byte limit.")
    try:
        value = json.loads(
            text,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_non_finite_constant,
            parse_float=_parse_finite_float,
            parse_int=_parse_bounded_int,
        )
    except JsonValidationError:
        raise
    except json.JSONDecodeError as exc:
        raise JsonValidationError(f"Invalid JSON: {exc.msg}") from exc
    except (ValueError, OverflowError, RecursionError) as exc:
        raise JsonValidationError("Invalid or excessively complex JSON input.") from exc
    return value


def validate_json_schema(value: Any, schema: dict[str, Any], *, path: str = "$") -> None:
    _validate_schema_value(value, schema, path, 0, _Budget())


def validate_json_shape(value: Any) -> None:
    """Apply the generic JSON depth, node, field, and numeric limits."""

    _validate_shape(value, 0, _Budget())


def _validate_schema_value(
    value: Any,
    schema: dict[str, Any],
    path: str,
    depth: int,
    budget: _Budget,
) -> None:
    if depth > MAX_JSON_DEPTH:
        raise JsonValidationError(f"{path} exceeds the maximum nesting depth.")
    budget.consume()
    expected = schema.get("type")
    if expected == "object":
        if not isinstance(value, dict):
            raise JsonValidationError(f"{path} must be an object.")
        properties = schema.get("properties", {})
        required = schema.get("required", [])
        if not isinstance(properties, dict) or not isinstance(required, list):
            raise JsonValidationError(f"Invalid server schema at {path}.")
        for key in required:
            if key not in value:
                raise JsonValidationError(f"{path}.{key} is required.")
        unknown = set(value) - set(properties)
        additional = schema.get("additionalProperties", False)
        if unknown and additional is not True:
            raise JsonValidationError(f"{path} contains unknown fields: {', '.join(sorted(unknown))}.")
        max_properties = int(schema.get("maxProperties", len(properties) or 64))
        if len(value) > max_properties:
            raise JsonValidationError(f"{path} contains too many fields.")
        for key, child in value.items():
            child_schema = properties.get(key)
            if child_schema is not None:
                _validate_schema_value(child, child_schema, f"{path}.{key}", depth + 1, budget)
            elif additional is True:
                _validate_shape(child, depth + 1, budget)
        return
    if expected == "array":
        if not isinstance(value, list):
            raise JsonValidationError(f"{path} must be an array.")
        if len(value) > int(schema.get("maxItems", 64)):
            raise JsonValidationError(f"{path} exceeds its array length limit.")
        if len(value) < int(schema.get("minItems", 0)):
            raise JsonValidationError(f"{path} has too few items.")
        item_schema = schema.get("items", {})
        for index, child in enumerate(value):
            _validate_schema_value(child, item_schema, f"{path}[{index}]", depth + 1, budget)
        return
    if expected == "string":
        if not isinstance(value, str):
            raise JsonValidationError(f"{path} must be a string.")
        if "\x00" in value:
            raise JsonValidationError(f"{path} must not contain NUL.")
        if len(value) < int(schema.get("minLength", 0)):
            raise JsonValidationError(f"{path} is too short.")
        if len(value) > int(schema.get("maxLength", 65_536)):
            raise JsonValidationError(f"{path} is too long.")
        if "enum" in schema and value not in schema["enum"]:
            raise JsonValidationError(f"{path} is not one of the allowed values.")
        return
    if expected == "integer":
        if isinstance(value, bool) or not isinstance(value, int):
            raise JsonValidationError(f"{path} must be an integer.")
        if value < int(schema.get("minimum", -(2**63))) or value > int(schema.get("maximum", 2**63 - 1)):
            raise JsonValidationError(f"{path} is outside the allowed range.")
        return
    if expected == "boolean":
        if not isinstance(value, bool):
            raise JsonValidationError(f"{path} must be a boolean.")
        return
    if expected in {None, "null"}:
        if expected == "null" and value is not None:
            raise JsonValidationError(f"{path} must be null.")
        _validate_shape(value, depth, budget)
        return
    raise JsonValidationError(f"Unsupported server schema type at {path}: {expected}")


def _validate_shape(value: Any, depth: int, budget: _Budget) -> None:
    if depth > MAX_JSON_DEPTH:
        raise JsonValidationError("JSON value exceeds the maximum nesting depth.")
    budget.consume()
    if isinstance(value, dict):
        if len(value) > 128:
            raise JsonValidationError("JSON object contains too many fields.")
        for key, child in value.items():
            if not isinstance(key, str) or len(key) > 128:
                raise JsonValidationError("JSON object key is invalid or too long.")
            _validate_shape(child, depth + 1, budget)
    elif isinstance(value, list):
        if len(value) > 256:
            raise JsonValidationError("JSON array contains too many items.")
        for child in value:
            _validate_shape(child, depth + 1, budget)
    elif isinstance(value, str) and len(value) > 65_536:
        raise JsonValidationError("JSON string exceeds the field length limit.")
    elif isinstance(value, int) and not isinstance(value, bool):
        if not -(2**63) <= value <= 2**63 - 1:
            raise JsonValidationError("JSON integer exceeds the 64-bit range.")
    elif isinstance(value, float):
        if not math.isfinite(value):
            raise JsonValidationError("JSON numbers must be finite.")
    elif not isinstance(value, (str, int, float, bool, type(None))):
        raise JsonValidationError("JSON contains an unsupported value type.")


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise JsonValidationError(f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def _reject_non_finite_constant(token: str) -> Any:
    raise JsonValidationError(f"Non-finite JSON number is not allowed: {token}")


def _parse_bounded_int(token: str) -> int:
    if len(token) > 20:
        raise JsonValidationError("JSON integer token is too long.")
    value = int(token, 10)
    if not -(2**63) <= value <= 2**63 - 1:
        raise JsonValidationError("JSON integer exceeds the 64-bit range.")
    return value


def _parse_finite_float(token: str) -> float:
    if len(token) > 128:
        raise JsonValidationError("JSON number token is too long.")
    value = float(token)
    if not math.isfinite(value):
        raise JsonValidationError("JSON numbers must be finite.")
    return value
