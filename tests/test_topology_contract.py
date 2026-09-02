import json
import tempfile
import unittest
from pathlib import Path

from proto_agent.compiler import compile_design, validate_design
from proto_agent.parser import parse_design


ROOT = Path(__file__).resolve().parents[1]
PARTS_PATH = ROOT / "parts" / "ecoli_k12_library.json"
SCHEMA_PATH = ROOT / "schemas" / "proto_ir.schema.json"


class TopologyContractTests(unittest.TestCase):
    def _write_design(self, content: str) -> tuple[tempfile.TemporaryDirectory[str], Path]:
        temporary_directory = tempfile.TemporaryDirectory(prefix="proto-topology-test-")
        source = Path(temporary_directory.name) / "input.proto"
        source.write_text(content, encoding="utf-8")
        return temporary_directory, source

    @staticmethod
    def _construct(name: str, topology: str | None = None) -> str:
        topology_line = "" if topology is None else f"  topology {topology}\n"
        return (
            f"construct {name}:\n"
            f"{topology_line}"
            "  promoter pLac\n"
            "  rbs B0034\n"
            "  cds tetR\n"
            "  terminator B0015\n"
        )

    def test_omitted_topology_is_unknown_in_ast_and_ir(self) -> None:
        temporary_directory, source = self._write_design(
            "design topology_default chassis ecoli_k12\n\n"
            + self._construct("default_unit")
        )
        self.addCleanup(temporary_directory.cleanup)

        design, parse_diagnostics = parse_design(source)
        self.assertEqual(parse_diagnostics, [])
        self.assertIsNotNone(design)
        self.assertEqual(design.constructs[0].topology, "unknown")

        ir, diagnostics = compile_design(source, PARTS_PATH)
        self.assertIsNotNone(ir)
        self.assertFalse(any(item.severity == "error" for item in diagnostics))
        self.assertEqual(ir["constructs"][0]["topology"], "unknown")

    def test_explicit_linear_and_circular_topology_reach_ir(self) -> None:
        temporary_directory, source = self._write_design(
            "design topology_explicit chassis ecoli_k12\n\n"
            + self._construct("linear_unit", "linear")
            + "\n"
            + self._construct("circular_unit", "circular")
        )
        self.addCleanup(temporary_directory.cleanup)

        design, parse_diagnostics = parse_design(source)
        self.assertEqual(parse_diagnostics, [])
        self.assertIsNotNone(design)
        self.assertEqual(
            [construct.topology for construct in design.constructs],
            ["linear", "circular"],
        )

        ir, diagnostics = compile_design(source, PARTS_PATH)
        self.assertIsNotNone(ir)
        self.assertFalse(any(item.severity == "error" for item in diagnostics))
        self.assertEqual(
            [construct["topology"] for construct in ir["constructs"]],
            ["linear", "circular"],
        )

    def test_invalid_or_duplicate_topology_fails_closed(self) -> None:
        cases = {
            "unknown": ("unknown", "CONSTRUCT_TOPOLOGY_INVALID"),
            "unsupported": ("branched", "CONSTRUCT_TOPOLOGY_INVALID"),
            "extra_token": ("linear extra", "CONSTRUCT_TOPOLOGY_INVALID"),
            "duplicate": ("linear\n  topology circular", "CONSTRUCT_TOPOLOGY_DUPLICATE"),
        }

        for name, (topology, expected_code) in cases.items():
            with self.subTest(name=name):
                temporary_directory, source = self._write_design(
                    "design topology_invalid chassis ecoli_k12\n\n"
                    + self._construct("invalid_unit", topology)
                )
                try:
                    ir, diagnostics = compile_design(source, PARTS_PATH)
                    self.assertIsNone(ir)
                    self.assertIn(expected_code, {item.code for item in diagnostics})
                finally:
                    temporary_directory.cleanup()

    def test_topology_outside_construct_fails_closed(self) -> None:
        temporary_directory, source = self._write_design(
            "design topology_outside chassis ecoli_k12\n"
            "topology circular\n"
            + self._construct("unit")
        )
        self.addCleanup(temporary_directory.cleanup)

        ir, diagnostics = compile_design(source, PARTS_PATH)
        self.assertIsNone(ir)
        self.assertIn(
            "CONSTRUCT_TOPOLOGY_OUTSIDE_CONSTRUCT",
            {item.code for item in diagnostics},
        )

    def test_runtime_ast_topology_is_validated_fail_closed(self) -> None:
        temporary_directory, source = self._write_design(
            "design topology_ast chassis ecoli_k12\n\n"
            + self._construct("unit")
        )
        self.addCleanup(temporary_directory.cleanup)

        design, parse_diagnostics = parse_design(source)
        self.assertEqual(parse_diagnostics, [])
        self.assertIsNotNone(design)
        for invalid_topology in ("branched", None, ["circular"]):
            with self.subTest(topology=invalid_topology):
                design.constructs[0].topology = invalid_topology  # type: ignore[assignment]
                diagnostics = validate_design(design, parse_diagnostics, PARTS_PATH)
                self.assertIn("CONSTRUCT_TOPOLOGY_INVALID", {item.code for item in diagnostics})

    def test_ir_schema_requires_the_closed_topology_enum(self) -> None:
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        construct_schema = schema["properties"]["constructs"]["items"]

        self.assertIn("topology", construct_schema["required"])
        self.assertEqual(
            construct_schema["properties"]["topology"],
            {
                "type": "string",
                "enum": ["linear", "circular", "unknown"],
            },
        )


if __name__ == "__main__":
    unittest.main()
