"""Pin the local provider, selected GGUF, tokenizer/template bytes and runtime configuration.

Read-only toward LM Studio and model storage. This does not load or change a model.
The caller must supply the exact indexed model identifier, not a guessed filename.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import runpy
import struct
from datetime import UTC, datetime
from pathlib import Path

from chem_workbench import orchestrator
from chem_workbench.visualization import content_hash


def file_identity(path):
    before = path.stat()
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(8 * 1024 * 1024):
            digest.update(chunk)
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError("MODEL_FILE_CHANGED_DURING_HASH")
    return {
        "path": str(path.resolve()),
        "bytes": after.st_size,
        "mtime_ns": after.st_mtime_ns,
        "sha256": digest.hexdigest(),
    }


def gguf_identity(path):
    """Hash encoded tokenizer metadata, including arrays, without parsing tensor weights."""
    with path.open("rb") as stream:

        def read(size):
            if size < 0 or stream.tell() + size > 128 * 1024 * 1024:
                raise ValueError("GGUF_METADATA_LIMIT")
            value = stream.read(size)
            if len(value) != size:
                raise ValueError("TRUNCATED_GGUF_METADATA")
            return value

        def integer(fmt):
            return struct.unpack("<" + fmt, read(struct.calcsize("<" + fmt)))[0]

        def string():
            return read(integer("Q")).decode("utf-8")

        def value(kind, depth=0):
            if depth > 2:
                raise ValueError("GGUF_ARRAY_DEPTH")
            formats = {
                0: "B",
                1: "b",
                2: "H",
                3: "h",
                4: "I",
                5: "i",
                6: "f",
                7: "?",
                10: "Q",
                11: "q",
                12: "d",
            }
            if kind in formats:
                return integer(formats[kind])
            if kind == 8:
                return string()
            if kind == 9:
                subtype, count = integer("I"), integer("Q")
                if count > 2_000_000:
                    raise ValueError("GGUF_ARRAY_LIMIT")
                for _ in range(count):
                    value(subtype, depth + 1)
                return {"array_type": subtype, "count": count}
            raise ValueError("UNKNOWN_GGUF_METADATA_TYPE")

        if read(4) != b"GGUF":
            raise ValueError("GGUF_MAGIC")
        version, tensors, count = integer("I"), integer("Q"), integer("Q")
        if version not in {2, 3} or count > 100_000:
            raise ValueError("GGUF_HEADER")
        tokenizer = hashlib.sha256()
        fields, general, template = {}, {}, None
        for _ in range(count):
            start = stream.tell()
            name = string()
            item = value(integer("I"))
            end = stream.tell()
            if name.startswith("tokenizer."):
                stream.seek(start)
                encoded = read(end - start)
                tokenizer.update(encoded)
                fields[name] = {
                    "encoded_bytes": len(encoded),
                    "sha256": hashlib.sha256(encoded).hexdigest(),
                }
            if name in {
                "general.name",
                "general.architecture",
                "general.file_type",
                "general.quantization_version",
            }:
                general[name] = item
            if name == "tokenizer.chat_template":
                template = item
        if not fields or not isinstance(template, str) or not template:
            raise ValueError("GGUF_TOKENIZER_TEMPLATE_REQUIRED")
        return {
            "version": version,
            "tensor_count": tensors,
            "metadata_count": count,
            "general": general,
            "tokenizer_encoded_metadata_sha256": tokenizer.hexdigest(),
            "tokenizer_fields": fields,
            "chat_template": template,
            "chat_template_sha256": hashlib.sha256(template.encode()).hexdigest(),
            "tokenizer_binding": (
                "Exact encoded tokenizer.* GGUF metadata in file order; "
                "full weights hash also binds tokenizer bytes"
            ),
        }


def capture(model, identifier, output, studio_root):
    os.environ["CHEM_MODEL_KEY"] = model
    before = orchestrator.model_status()
    if not before.get("available"):
        raise ValueError("SELECTED_MODEL_NOT_LOADED")
    index_path = studio_root / ".internal/model-index-cache.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    entries = [entry for entry in index["models"] if entry["indexedModelIdentifier"] == identifier]
    if len(entries) != 1:
        raise ValueError("EXACT_MODEL_INDEX_ENTRY_REQUIRED")
    entry = entries[0]
    aliases = {
        entry.get("defaultIdentifier"),
        entry.get("indexedModelIdentifier"),
        *entry.get("autoIdentifiers", []),
    }
    if model not in aliases and not identifier.startswith(model + "@"):
        raise ValueError("MODEL_INDEX_KEY_MISMATCH")
    if entry["quant"]["name"] != before["quantization"]["name"]:
        raise ValueError("PROVIDER_INDEX_QUANTIZATION_MISMATCH")
    files = [
        {"role": role, **file_identity(Path(entry[role]["absPath"]))}
        for role in ("entryPoint", "visionAdapter")
        if entry.get(role)
    ]
    metadata = gguf_identity(Path(entry["entryPoint"]["absPath"]))
    expected_file_types = {"Q4_K_M": 15, "Q8_0": 7}
    if metadata["general"].get("general.file_type") != expected_file_types.get(
        entry["quant"]["name"]
    ):
        raise ValueError("GGUF_QUANTIZATION_MISMATCH")
    cached_template = entry["metadata"]["gguf"]["chatTemplate"]
    if cached_template != metadata["chat_template"]:
        raise ValueError("MODEL_INDEX_TEMPLATE_MISMATCH")
    process_capture = runpy.run_path(str(Path(__file__).with_name("model_process_identity.py")))[
        "capture_process_identity"
    ]
    process_attestation = process_capture(Path(entry["entryPoint"]["absPath"]), studio_root)
    after = orchestrator.model_status()
    if before != after:
        raise ValueError("PROVIDER_CHANGED_DURING_IDENTITY_CAPTURE")
    config = json.loads(
        (studio_root / ".internal/backend-preferences-v1.json").read_text(encoding="utf-8")
    )
    for item in files:
        current = Path(item["path"]).stat()
        if (current.st_size, current.st_mtime_ns) != (item["bytes"], item["mtime_ns"]):
            raise ValueError("MODEL_FILE_CHANGED_DURING_METADATA_CAPTURE")
    document = {
        "version": "model-runtime-identity/v1",
        "captured_at": datetime.now(UTC).isoformat(),
        "provider": before,
        "provider_stable": True,
        "index_identifier": identifier,
        "files": files,
        "gguf": metadata,
        "configured_runtime": config,
        "process_attestation": process_attestation,
        "active_process_template_matches_gguf": process_attestation["active_chat_template"][
            "utf8_sha256"
        ]
        == metadata["chat_template_sha256"],
        "decoding": {
            "temperature": 0,
            "max_tokens": 2400,
            "reasoning_effort": "none",
            "chat_template_kwargs": {"enable_thinking": False},
        },
        "controller": file_identity(Path(orchestrator.__file__)),
        "loaded_quantization_matches_file": True,
        "index_template_matches_file": True,
        "scope": (
            "Local read-only identity capture; configuration is observed, "
            "not a scientific or model promotion claim"
        ),
    }
    document["identity_hash"] = content_hash(document)
    with output.open("x", encoding="utf-8") as stream:
        json.dump(document, stream, indent=2)
        stream.write("\n")
    print(
        json.dumps(
            {
                "output": str(output),
                "model": model,
                "identity_hash": document["identity_hash"],
                "weights_sha256": files[0]["sha256"],
                "quantization": before["quantization"],
                "tokenizer_sha256": metadata["tokenizer_encoded_metadata_sha256"],
                "actual_runtime": process_attestation["active_runtime"],
            }
        )
    )
    return document


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=sorted(orchestrator.ALLOWED_MODEL_KEYS), required=True)
    parser.add_argument("--indexed-identifier", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--studio-root", type=Path, default=Path.home() / ".lmstudio")
    args = parser.parse_args()
    capture(args.model, args.indexed_identifier, args.output, args.studio_root)
