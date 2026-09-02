from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


_SPLIT_RE = re.compile(r"^(?P<prefix>.+)-(?P<part>\d{5})-of-(?P<total>\d{5})\.gguf$", re.IGNORECASE)
_QUANT_RE = re.compile(
    r"(?:^|[-_.])(?P<quant>(?:Q\d(?:_[A-Z0-9]+)+|IQ\d(?:_[A-Z0-9]+)+|MXFP\d+|BF16|F16|F32))(?:[-_.]|$)",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class CatalogEntry:
    id: str
    name: str
    path: str
    files: list[str]
    size_bytes: int
    architecture: str
    quantization: str
    context_length: int
    block_count: int | None
    embedding_length: int | None
    attention_head_count: int | None
    attention_head_count_kv: int | None
    attention_key_length: int | None
    attention_value_length: int | None
    vision: bool
    projector_path: str | None
    projector_size_bytes: int | None
    tool_capability: str
    fingerprint: str
    estimated_vram_bytes: int
    metadata_source: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "path": self.path,
            "files": self.files,
            "sizeBytes": self.size_bytes,
            "architecture": self.architecture,
            "quantization": self.quantization,
            "contextLength": self.context_length,
            "blockCount": self.block_count,
            "embeddingLength": self.embedding_length,
            "attentionHeadCount": self.attention_head_count,
            "attentionHeadCountKv": self.attention_head_count_kv,
            "attentionKeyLength": self.attention_key_length,
            "attentionValueLength": self.attention_value_length,
            "vision": self.vision,
            "projectorPath": self.projector_path,
            "projectorSizeBytes": self.projector_size_bytes,
            "toolCapability": self.tool_capability,
            "fingerprint": self.fingerprint,
            "estimatedVramBytes": self.estimated_vram_bytes,
            "loadState": "unloaded",
            "pinned": False,
            "metadataSource": self.metadata_source,
        }


_CACHE_VERSION = 3


def scan_model_root(root: str | Path, cache_path: str | Path | None = None) -> list[dict[str, Any]]:
    model_root = Path(root).expanduser()
    if not model_root.exists() or not model_root.is_dir():
        return []

    files = sorted(
        (path for path in model_root.rglob("*.gguf") if path.is_file()),
        key=lambda item: str(item).casefold(),
    )
    projectors = [path for path in files if _is_projector(path)]
    primaries = [path for path in files if not _is_projector(path)]
    cache = _load_cache(cache_path)
    cached_entries = cache.get("entries", {})
    entries: list[dict[str, Any]] = []
    misses: list[tuple[list[Path], Path | None, str, str]] = []
    consumed: set[Path] = set()

    for primary in primaries:
        if primary in consumed:
            continue
        parts = _split_parts(primary, primaries)
        consumed.update(parts)
        projector = _pair_projector(primary, projectors)
        fingerprint = _fingerprint(parts)
        cache_key = _cache_key(fingerprint, projector)
        cached = cached_entries.get(cache_key)
        if isinstance(cached, dict):
            entries.append(_normalize_cached_entry(cached))
        else:
            misses.append((parts, projector, fingerprint, cache_key))

    if misses:
        for parts, projector, fingerprint, cache_key in misses:
            metadata, source = _read_gguf_metadata(parts[0])
            entry = _build_entry(parts, projector, metadata, source, fingerprint).to_dict()
            entries.append(entry)
            cached_entries[cache_key] = entry

    _write_cache(cache_path, {"version": _CACHE_VERSION, "entries": cached_entries})
    return sorted(entries, key=lambda item: str(item.get("name", "")).casefold())


def _normalize_cached_entry(entry: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(entry)
    normalized["loadState"] = "unloaded"
    normalized["pinned"] = False
    return normalized


def _is_projector(path: Path) -> bool:
    name = path.name.casefold()
    return "mmproj" in name or "projector" in name


def _split_parts(primary: Path, candidates: Iterable[Path]) -> list[Path]:
    match = _SPLIT_RE.match(primary.name)
    if not match:
        return [primary]
    prefix = match.group("prefix").casefold()
    total = int(match.group("total"))
    siblings = []
    for candidate in candidates:
        if candidate.parent != primary.parent:
            continue
        candidate_match = _SPLIT_RE.match(candidate.name)
        if not candidate_match:
            continue
        if candidate_match.group("prefix").casefold() != prefix:
            continue
        if int(candidate_match.group("total")) != total:
            continue
        siblings.append(candidate)
    return sorted(siblings, key=lambda item: item.name.casefold()) or [primary]


def _pair_projector(primary: Path, projectors: Iterable[Path]) -> Path | None:
    local = [path for path in projectors if path.parent == primary.parent]
    if not local:
        return None
    primary_quant = _filename_quantization(primary)
    same_quant = [path for path in local if _filename_quantization(path) == primary_quant]
    return sorted(same_quant or local, key=lambda item: item.name.casefold())[0]


def _build_entry(
    parts: list[Path],
    projector: Path | None,
    metadata: dict[str, Any],
    metadata_source: str,
    fingerprint: str | None = None,
) -> CatalogEntry:
    primary = parts[0]
    size_bytes = sum(path.stat().st_size for path in parts)
    architecture = str(metadata.get("general.architecture") or _architecture_from_path(primary))
    name = str(metadata.get("general.name") or _display_name(primary))
    context_length = _context_length(metadata, architecture)
    quantization = _filename_quantization(primary) or str(metadata.get("general.file_type") or "unknown")
    template = str(metadata.get("tokenizer.chat_template") or "")
    tool_ready = "tool" in template.casefold() and ("call" in template.casefold() or "function" in template.casefold())
    fingerprint = fingerprint or _fingerprint(parts)
    estimated_vram = int(size_bytes * 1.08 + min(context_length, 131_072) * 16_384)
    prefix = f"{architecture}."
    return CatalogEntry(
        id=fingerprint[:20],
        name=name,
        path=str(primary.resolve()),
        files=[str(path.resolve()) for path in parts],
        size_bytes=size_bytes,
        architecture=architecture,
        quantization=quantization,
        context_length=context_length,
        block_count=_metadata_int(metadata, prefix + "block_count", "llama.block_count"),
        embedding_length=_metadata_int(metadata, prefix + "embedding_length", "llama.embedding_length"),
        attention_head_count=_metadata_int(metadata, prefix + "attention.head_count", "llama.attention.head_count"),
        attention_head_count_kv=_metadata_int(
            metadata,
            prefix + "attention.head_count_kv",
            "llama.attention.head_count_kv",
        ),
        attention_key_length=_metadata_int(
            metadata,
            prefix + "attention.key_length",
            "llama.attention.key_length",
        ),
        attention_value_length=_metadata_int(
            metadata,
            prefix + "attention.value_length",
            "llama.attention.value_length",
        ),
        vision=projector is not None,
        projector_path=str(projector.resolve()) if projector else None,
        projector_size_bytes=projector.stat().st_size if projector else None,
        tool_capability="agent-ready" if tool_ready else "unknown",
        fingerprint=fingerprint,
        estimated_vram_bytes=estimated_vram,
        metadata_source=metadata_source,
    )


def _metadata_int(metadata: dict[str, Any], *keys: str) -> int | None:
    for key in keys:
        value = metadata.get(key)
        if isinstance(value, (int, float)) and value > 0:
            return int(value)
    return None


def _read_gguf_metadata(path: Path) -> tuple[dict[str, Any], str]:
    try:
        from gguf import GGUFReader  # type: ignore[import-not-found]
    except ImportError:
        return {}, "filename"

    try:
        reader = GGUFReader(str(path), mode="r")
        metadata: dict[str, Any] = {}
        for key, field in reader.fields.items():
            if key.startswith("tokenizer.ggml.tokens") or key.startswith("tokenizer.ggml.scores"):
                continue
            value = _reader_field_value(field)
            if value is not None:
                metadata[key] = value
        return metadata, "gguf"
    except Exception:
        return {}, "filename"


def _reader_field_value(field: Any) -> Any:
    try:
        data = getattr(field, "data", None)
        parts = getattr(field, "parts", None)
        if data is None or parts is None or len(data) == 0:
            return None
        value = parts[data[-1]]
        if getattr(value, "size", None) == 1 and hasattr(value, "item"):
            return value.item()
        if hasattr(value, "tobytes"):
            raw = value.tobytes()
            try:
                return raw.decode("utf-8")
            except UnicodeDecodeError:
                pass
        if hasattr(value, "item"):
            return value.item()
        if hasattr(value, "tolist"):
            return value.tolist()
        return value
    except (IndexError, TypeError, ValueError):
        return None


def _context_length(metadata: dict[str, Any], architecture: str) -> int:
    keys = [f"{architecture}.context_length", "llama.context_length", "context_length"]
    for key in keys:
        value = metadata.get(key)
        if isinstance(value, (int, float)) and value > 0:
            return int(value)
    return 32_768


def _fingerprint(parts: list[Path]) -> str:
    digest = hashlib.sha256()
    for path in parts:
        stat = path.stat()
        digest.update(str(path.resolve()).casefold().encode("utf-8"))
        digest.update(str(stat.st_size).encode("ascii"))
        digest.update(str(stat.st_mtime_ns).encode("ascii"))
        with path.open("rb") as handle:
            digest.update(handle.read(65_536))
    return digest.hexdigest()


def _cache_key(fingerprint: str, projector: Path | None) -> str:
    digest = hashlib.sha256(fingerprint.encode("ascii"))
    if projector:
        stat = projector.stat()
        digest.update(str(projector.resolve()).casefold().encode("utf-8"))
        digest.update(str(stat.st_size).encode("ascii"))
        digest.update(str(stat.st_mtime_ns).encode("ascii"))
        with projector.open("rb") as handle:
            digest.update(handle.read(65_536))
    return digest.hexdigest()


def _load_cache(cache_path: str | Path | None) -> dict[str, Any]:
    if cache_path is None:
        return {"version": _CACHE_VERSION, "entries": {}}
    path = Path(cache_path).expanduser()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if payload.get("version") == _CACHE_VERSION and isinstance(payload.get("entries"), dict):
            return payload
    except (FileNotFoundError, json.JSONDecodeError, OSError, AttributeError):
        pass
    return {"version": _CACHE_VERSION, "entries": {}}


def _write_cache(cache_path: str | Path | None, payload: dict[str, Any]) -> None:
    if cache_path is None:
        return
    path = Path(cache_path).expanduser()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(json.dumps(payload, ensure_ascii=True, separators=(",", ":")), encoding="utf-8")
        temporary.replace(path)
    except OSError:
        return


def _filename_quantization(path: Path) -> str:
    match = _QUANT_RE.search(path.name.upper())
    return match.group("quant").upper() if match else "unknown"


def _architecture_from_path(path: Path) -> str:
    text = str(path).casefold()
    for needle, architecture in (
        ("gpt-oss", "gpt-oss"),
        ("qwen3.6", "qwen35moe"),
        ("qwen-agentworld", "qwen35moe"),
        ("qwythos", "qwen35"),
        ("gemma-4", "gemma4"),
    ):
        if needle in text:
            return architecture
    return "unknown"


def _display_name(path: Path) -> str:
    match = _SPLIT_RE.match(path.name)
    stem = match.group("prefix") if match else path.stem
    return stem.replace("_", " ").strip()
