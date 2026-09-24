"""Deterministic JSON serialization and typed SHA-256 helpers."""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from collections.abc import Mapping, Sequence
from typing import Any, TypedDict

from chem_workbench.chemir.profile import (
    CANONICALIZATION_ALGORITHM as CANONICALIZATION_ALGORITHM,
)
from chem_workbench.chemir.profile import (
    NORMALIZATION_PROFILE as NORMALIZATION_PROFILE,
)
from chem_workbench.chemir.validation import validate_chemir_document

_SEMANTIC_HASH_DOMAIN = b"chem-workbench:semantic:v1alpha1\x00"
_SHA256_VALUE = re.compile(r"^[0-9a-f]{64}$")


class TypedDigest(TypedDict):
    """Portable typed SHA-256 record used at evidence boundaries."""

    type: str
    algorithm: str
    value: str


class CanonicalizationError(ValueError):
    """Raised when a value cannot be represented by the alpha canonical form."""


def _validate_json_value(value: Any, path: str = "$") -> None:
    if value is None or isinstance(value, (str, bool, int)):
        return
    if isinstance(value, float):
        raise CanonicalizationError(
            f"Binary floating-point value at {path}; the alpha subset accepts exact integers only"
        )
    if isinstance(value, Mapping):
        for key, child in value.items():
            if not isinstance(key, str):
                raise CanonicalizationError(f"Non-string map key at {path}")
            if unicodedata.normalize("NFC", key) != key:
                raise CanonicalizationError(f"Non-NFC map key at {path}")
            _validate_json_value(child, f"{path}.{key}")
        return
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for index, child in enumerate(value):
            _validate_json_value(child, f"{path}[{index}]")
        return
    raise CanonicalizationError(f"Unsupported value {type(value).__name__} at {path}")


def canonical_bytes(value: Any) -> bytes:
    """Return the versioned alpha canonical JSON representation."""
    _validate_json_value(value)
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def pretty_bytes(value: Any) -> bytes:
    """Return deterministic human-readable JSON artifact bytes."""
    _validate_json_value(value)
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            indent=2,
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")


def semantic_projection(document: Mapping[str, Any]) -> dict[str, Any]:
    """Return the current schema-declared semantic projection.

    The compiler-emitted alpha subset has no review records or timestamps inside
    ChemIR.  Every emitted field, including all three reference arrays, is
    therefore semantic.  Representation values remain semantic until a future
    adapter has imported an independently typed structure.
    """
    return dict(document)


def semantic_hash(document: Mapping[str, Any]) -> str:
    """Hash a validated document in the current inspectable ChemIR subset.

    This public entry point deliberately validates before projecting or hashing;
    it is not a generic JSON hashing utility. Unknown profiles, open payloads,
    dangling references, malformed source references, and non-exact numeric
    values therefore fail closed rather than receiving a ChemIR semantic hash.
    """
    validated = validate_chemir_document(document)
    material = (
        _SEMANTIC_HASH_DOMAIN
        + CANONICALIZATION_ALGORITHM.encode("ascii")
        + b"\x00"
        + NORMALIZATION_PROFILE.encode("ascii")
        + b"\x00"
        + canonical_bytes(semantic_projection(validated))
    )
    return f"sha256:{hashlib.sha256(material).hexdigest()}"


def artifact_sha256(content: bytes) -> str:
    return f"sha256:{hashlib.sha256(content).hexdigest()}"


def typed_digest(digest_type: str, digest: str) -> TypedDigest:
    """Convert the internal ``sha256:<hex>`` form to a typed evidence record."""
    algorithm, separator, value = digest.partition(":")
    if separator != ":" or algorithm != "sha256" or _SHA256_VALUE.fullmatch(value) is None:
        raise ValueError(f"Invalid SHA-256 digest {digest!r}")
    return {"type": digest_type, "algorithm": algorithm, "value": value}


def validate_typed_digest(value: object, expected_type: str) -> str:
    """Validate a typed evidence record and return the internal digest form."""
    if not isinstance(value, dict) or set(value) != {"type", "algorithm", "value"}:
        raise ValueError(f"{expected_type} must be a typed digest record")
    if value.get("type") != expected_type or value.get("algorithm") != "sha256":
        raise ValueError(f"Unsupported typed digest for {expected_type}")
    digest_value = value.get("value")
    if not isinstance(digest_value, str) or _SHA256_VALUE.fullmatch(digest_value) is None:
        raise ValueError(f"Invalid SHA-256 value for {expected_type}")
    return f"sha256:{digest_value}"
