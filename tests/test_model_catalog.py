from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from proto_agent.model_catalog import _reader_field_value, scan_model_root


class _ScalarArray:
    size = 1

    def __init__(self, value: int) -> None:
        self.value = value

    def item(self) -> int:
        return self.value

    def tobytes(self) -> bytes:
        return self.value.to_bytes(4, "little")


class _ReaderField:
    data = [0]

    def __init__(self, value: int) -> None:
        self.parts = [_ScalarArray(value)]


class ModelCatalogTests(unittest.TestCase):
    def test_numeric_gguf_scalar_is_not_decoded_as_text(self) -> None:
        self.assertEqual(_reader_field_value(_ReaderField(1_048_576)), 1_048_576)

    def test_scanner_excludes_and_pairs_mmproj_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model = root / "Qwen3.6-35B-A3B-Q4_K_M.gguf"
            projector = root / "mmproj-Qwen3.6-35B-A3B-BF16.gguf"
            model.write_bytes(b"GGUF" + b"model" * 100)
            projector.write_bytes(b"GGUF" + b"projector" * 100)

            entries = scan_model_root(root)

            self.assertEqual(len(entries), 1)
            self.assertEqual(entries[0]["path"], str(model.resolve()))
            self.assertEqual(entries[0]["projectorPath"], str(projector.resolve()))
            self.assertTrue(entries[0]["vision"])
            self.assertEqual(entries[0]["quantization"], "Q4_K_M")

    def test_scanner_groups_split_gguf_weights(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "model-Q4_K_M-00001-of-00002.gguf"
            second = root / "model-Q4_K_M-00002-of-00002.gguf"
            first.write_bytes(b"GGUF" + b"a" * 50)
            second.write_bytes(b"GGUF" + b"b" * 70)

            entries = scan_model_root(root)

            self.assertEqual(len(entries), 1)
            self.assertEqual(len(entries[0]["files"]), 2)
            self.assertEqual(entries[0]["sizeBytes"], first.stat().st_size + second.stat().st_size)

    def test_scanner_reuses_cached_gguf_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model = root / "cached-Q4_K_M.gguf"
            cache = root / "catalog-cache.json"
            model.write_bytes(b"GGUF" + b"model" * 100)

            with patch(
                "proto_agent.model_catalog._read_gguf_metadata",
                return_value=(
                    {
                        "general.name": "Cached Model",
                        "general.architecture": "llama",
                        "llama.block_count": 32,
                        "llama.embedding_length": 4096,
                        "llama.attention.head_count": 32,
                        "llama.attention.head_count_kv": 8,
                    },
                    "gguf",
                ),
            ) as reader:
                first = scan_model_root(root, cache)
                second = scan_model_root(root, cache)

            self.assertEqual(reader.call_count, 1)
            self.assertEqual(first, second)
            self.assertEqual(second[0]["name"], "Cached Model")
            self.assertEqual(second[0]["blockCount"], 32)
            self.assertEqual(second[0]["embeddingLength"], 4096)
            self.assertEqual(second[0]["attentionHeadCountKv"], 8)


if __name__ == "__main__":
    unittest.main()
