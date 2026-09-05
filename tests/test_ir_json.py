"""Supported-size IR regressions; catalog fixture projections never activate trust."""
import copy
import json
import tempfile
import unittest
from pathlib import Path

from proto_agent.compiler import compile_design_text
from proto_agent.exporters import load_ir
from proto_agent.ir_json import decode_ir_json
from proto_agent.json_validation import JsonValidationError, strict_json_loads
from proto_agent.provenance import ProvenanceError
from proto_agent.review import _verify_dna_v2_artifact_binding
from proto_agent.security import MAX_JSON_FILE_BYTES, WorkspacePaths

ROOT = Path(__file__).resolve().parents[1]


class ScientificIrJsonTests(unittest.TestCase):
    def test_supported_legacy_v1_ir_uses_the_same_typed_loader(self):
        source = "# Toy legacy software workload\ndesign legacy_size_fixture chassis ecoli_k12\nconstruct unit:\n"
        source += "  promoter pLac\n  rbs B0034\n  cds tetR\n  terminator B0015\n" * 100
        ir, diagnostics = compile_design_text(source, ROOT / "parts/ecoli_k12_library.json")
        self.assertIsNotNone(ir, diagnostics)
        self.assertEqual(ir["schema_version"], "proto-agent.ir.v1")
        self.assertEqual(len(ir["constructs"][0]["parts"]), 400)
        parent = ROOT / "build/upgrade-20260904/ir-json-tests"
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as directory:
            path = Path(directory) / "legacy.ir.json"
            path.write_text(json.dumps(ir), encoding="utf-8")
            self.assertEqual(load_ir(path), ir)

    def test_supported_large_reviewed_ir_round_trip_keeps_binding_checks(self):
        temporary_parent = ROOT / "build/upgrade-20260904/ir-json-tests"
        temporary_parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=temporary_parent) as directory:
            workspace = Path(directory)
            records = json.loads((ROOT / "materials/reviewed/igem_design_eligible_2026-09.json").read_text(encoding="utf-8"))["records"]
            record = next(item for item in records if item["part_type"] == "promoter")
            part = {"id": record["resource_id"], "type": record["part_type"], "name": record["name"],
                    **{field: record[field] for field in ("resource_id", "sequence", "sequence_sha256", "source", "license", "sequence_kind", "review_status", "safety_status", "design_eligibility", "evidence_refs")}, "safety_flags": []}
            library = workspace / "parts.json"
            library.write_text(json.dumps({"chassis": "ecoli_k12", "notice": "Existing reviewed fixture projection; no catalog activation", "parts": [part]}), encoding="utf-8")
            lines = ["# Artificial software workload, no biological performance claim", "design large_ir_fixture chassis ecoli_k12", "construct unit:"]
            for index in range(1000):
                lines.append(f"  promoter {part['id']} instance=slot_{index}")
                annotation = {"name": f"Software marker {index}", "type": "misc_feature", "origin": "user",
                              "anchors": [{"instance_id": f"slot_{index}", "start": 0, "end": 1, "direction": 0}]}
                lines.append(f"  annotation marker_{index} {json.dumps(annotation)}")
            source = "\n".join(lines) + "\n"
            ir, diagnostics = compile_design_text(source, library, source_path="design.proto")
            self.assertIsNotNone(ir, diagnostics)
            text = json.dumps(ir)
            with self.assertRaises(JsonValidationError):
                strict_json_loads(text, max_bytes=MAX_JSON_FILE_BYTES)
            build = workspace / "build"
            build.mkdir()
            path = build / "large.ir.json"
            path.write_text(text, encoding="utf-8")
            self.assertEqual(load_ir(path), ir)
            manifest = {"steps": [{"id": "compile", "ok": True, "artifacts": ["build/large.ir.json"]}], "inputs": {"design": "design.proto"}}
            inputs = {"design": source.encode(), "parts": library.read_bytes()}
            _verify_dna_v2_artifact_binding(manifest, inputs, library, WorkspacePaths.create(workspace))
            tampered = copy.deepcopy(ir)
            tampered["constructs"][0]["annotations"][0]["name"] = "Unbound altered marker"
            path.write_text(json.dumps(tampered), encoding="utf-8")
            # This is internally valid IR but not the compiler result of the
            # exact source/library retained in the workflow journal.
            load_ir(path)
            with self.assertRaises(ProvenanceError):
                _verify_dna_v2_artifact_binding(manifest, inputs, library, WorkspacePaths.create(workspace))

    def test_ir_profile_retains_strict_numbers_keys_and_finite_bounds(self):
        for text in ['{"a":1,"a":2}', '{"a":NaN}', '{"a":1e999}', '{"a":9223372036854775808}']:
            with self.subTest(text=text), self.assertRaises(JsonValidationError):
                decode_ir_json(text, max_bytes=MAX_JSON_FILE_BYTES)
        for value in [{"a": [0] * 10001}, {"a": [[0] * 10000 for _ in range(51)]}]:
            with self.assertRaises(JsonValidationError):
                decode_ir_json(json.dumps(value), max_bytes=MAX_JSON_FILE_BYTES)
        nested = 0
        for _ in range(22):
            nested = [nested]
        with self.assertRaises(JsonValidationError):
            decode_ir_json(json.dumps({"a": nested}), max_bytes=MAX_JSON_FILE_BYTES)
        with self.assertRaises(JsonValidationError):
            strict_json_loads(json.dumps({"a": [0] * 257}), max_bytes=MAX_JSON_FILE_BYTES)

    def test_long_scientific_sequence_does_not_relax_generic_text_limit(self):
        payload = json.dumps({"sequence": "A" * 100000})
        self.assertEqual(len(decode_ir_json(payload, max_bytes=MAX_JSON_FILE_BYTES)["sequence"]), 100000)
        with self.assertRaises(JsonValidationError):
            strict_json_loads(payload, max_bytes=MAX_JSON_FILE_BYTES)


if __name__ == "__main__":
    unittest.main()
