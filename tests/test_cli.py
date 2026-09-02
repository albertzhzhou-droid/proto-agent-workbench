from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "src"
CLI_TIMEOUT_SECONDS = 15

DESIGN_ASSETS = (
    "designs/toggle_switch.proto",
    "parts/ecoli_k12_library.json",
)
WORKFLOW_ASSETS = (*DESIGN_ASSETS, "workflows/design_review.json")
REVIEW_ASSETS = (*WORKFLOW_ASSETS, "literature/seed_sources.json")
ANALYSIS_ASSETS = (
    "analyses/summarize_design.py",
    "designs/toggle_switch.proto",
)
NOTEBOOK_ASSETS = ("notebooks/design_summary.ipynb",)
CONNECTOR_ASSETS = (
    "connectors/proto_workbench.json",
    "parts/ecoli_k12_library.json",
    "literature/seed_sources.json",
)
PUBMED_FIXTURE = ("tests/fixtures/pubmed_esummary.json",)
SOURCE_FIXTURES = (
    "tests/fixtures/europe_pmc_search.json",
    "tests/fixtures/crossref_search.json",
    "tests/fixtures/uniprot_search.json",
    "tests/fixtures/rhea_search.tsv",
)


class CliTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary_directory = tempfile.TemporaryDirectory(prefix="proto-cli-test-")
        self.addCleanup(self._temporary_directory.cleanup)
        self.workspace = Path(self._temporary_directory.name).resolve()
        self.temp_dir = self.workspace / ".tmp"
        self.temp_dir.mkdir()
        self._staged_assets: set[str] = set()

    def stage_assets(self, *relative_paths: str) -> None:
        for relative_path in relative_paths:
            if relative_path in self._staged_assets:
                continue
            source = ROOT / relative_path
            self.assertTrue(source.is_file(), f"Missing CLI test asset: {relative_path}")
            destination = self.workspace / relative_path
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            self._staged_assets.add(relative_path)

    def run_cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        env = {
            "PYTHONPATH": str(SOURCE_ROOT),
            "PYTHONNOUSERSITE": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "utf-8",
        }
        python_directory = str(Path(sys.executable).resolve().parent)
        if os.name == "nt":
            windows_directory = os.environ.get("SystemRoot") or os.environ.get("WINDIR") or r"C:\Windows"
            env.update(
                {
                    "SystemRoot": windows_directory,
                    "WINDIR": windows_directory,
                    "PATH": os.pathsep.join((python_directory, str(Path(windows_directory) / "System32"))),
                    "PATHEXT": ".COM;.EXE;.BAT;.CMD",
                    "TEMP": str(self.temp_dir),
                    "TMP": str(self.temp_dir),
                }
            )
            system_drive = os.environ.get("SystemDrive")
            if system_drive:
                env["SystemDrive"] = system_drive
        else:
            env.update(
                {
                    "PATH": python_directory,
                    "LANG": "C.UTF-8",
                    "LC_ALL": "C.UTF-8",
                    "TMPDIR": str(self.temp_dir),
                }
            )
        try:
            return subprocess.run(
                [sys.executable, "-m", "proto_agent.cli", *args],
                cwd=self.workspace,
                env=env,
                text=True,
                encoding="utf-8",
                errors="strict",
                capture_output=True,
                timeout=CLI_TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            self.fail(f"CLI exceeded {CLI_TIMEOUT_SECONDS}s timeout: {exc.cmd}")

    def workspace_path(self, value: str) -> Path:
        candidate = Path(value)
        if not candidate.is_absolute():
            candidate = self.workspace / candidate
        resolved = candidate.resolve(strict=False)
        try:
            resolved.relative_to(self.workspace)
        except ValueError:
            self.fail(f"CLI artifact escaped the temporary workspace: {value}")
        return resolved

    def test_check_sample_design_passes(self) -> None:
        self.stage_assets(*DESIGN_ASSETS)
        result = self.run_cli("check", "designs/toggle_switch.proto", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])

    def test_compile_writes_ir(self) -> None:
        self.stage_assets(*DESIGN_ASSETS)
        out = self.workspace / "build" / "test-toggle.ir.json"
        result = self.run_cli("compile", "designs/toggle_switch.proto", "--out", "build/test-toggle.ir.json")
        self.assertEqual(result.returncode, 0, result.stderr)
        ir = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(ir["schema_version"], "proto-agent.ir.v1")
        self.assertEqual(ir["design_id"], "toggle_switch_v1")

    def test_sbol_export_and_validate(self) -> None:
        self.stage_assets(*DESIGN_ASSETS)
        sbol_out = self.workspace / "build" / "test-toggle.sbol.ttl"
        compile_result = self.run_cli("compile", "designs/toggle_switch.proto", "--out", "build/test-toggle.ir.json")
        self.assertEqual(compile_result.returncode, 0, compile_result.stderr)
        export_result = self.run_cli("export", "build/test-toggle.ir.json", "--format", "sbol", "--out", "build/test-toggle.sbol.ttl")
        self.assertEqual(export_result.returncode, 0, export_result.stderr)
        text = sbol_out.read_text(encoding="utf-8")
        self.assertIn("@prefix sbol:", text)
        self.assertIn("a sbol:Component", text)
        validate_result = self.run_cli("sbol", "validate", "build/test-toggle.sbol.ttl")
        self.assertEqual(validate_result.returncode, 0, validate_result.stderr)
        payload = json.loads(validate_result.stdout)
        self.assertTrue(payload["ok"])
        self.assertGreaterEqual(payload["component_count"], 1)

    def test_parts_search(self) -> None:
        self.stage_assets("parts/ecoli_k12_library.json")
        result = self.run_cli("parts", "search", "promoter", "--chassis", "ecoli_k12")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["matches"])

    def test_literature_search(self) -> None:
        self.stage_assets("literature/seed_sources.json")
        result = self.run_cli("literature", "search", "MCP")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertGreaterEqual(payload["match_count"], 1)

    def test_pubmed_fixture_search(self) -> None:
        self.stage_assets(*PUBMED_FIXTURE)
        result = self.run_cli(
            "literature",
            "pubmed",
            "synthetic biology design automation",
            "--retmax",
            "1",
            "--offline",
            "--fixture",
            "tests/fixtures/pubmed_esummary.json",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["mode"], "fixture")
        self.assertEqual(payload["matches"][0]["pmid"], "12345678")

    def test_sequence_validate_passes(self) -> None:
        self.stage_assets(*DESIGN_ASSETS)
        result = self.run_cli("sequence", "validate", "designs/toggle_switch.proto", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["constructs"])

    def test_sequence_validate_fails_gc_constraint(self) -> None:
        self.stage_assets("parts/ecoli_k12_library.json")
        bad_design = self.workspace / "build" / "test-gc-fail.proto"
        bad_design.parent.mkdir(parents=True, exist_ok=True)
        bad_design.write_text(
            "\n".join(
                [
                    "design gc_fail chassis ecoli_k12",
                    "",
                    "construct bad_unit:",
                    "  promoter pLac",
                    "  rbs B0034",
                    "  cds tetR",
                    "  terminator B0015",
                    "",
                    "constraint gc_content min=0.90 max=1.00",
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        result = self.run_cli("sequence", "validate", "build/test-gc-fail.proto", "--json")
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        codes = {item["code"] for item in payload["diagnostics"]}
        self.assertIn("GC_CONTENT_OUT_OF_RANGE", codes)

    def test_sequence_optimize_passes_with_no_suggestions_needed(self) -> None:
        self.stage_assets(*DESIGN_ASSETS)
        result = self.run_cli("sequence", "optimize", "designs/toggle_switch.proto")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["mode"], "suggestions")
        self.assertEqual(payload["suggestions"], [])

    def test_sequence_optimize_suggests_gc_repair(self) -> None:
        self.stage_assets("parts/ecoli_k12_library.json")
        bad_design = self.workspace / "build" / "test-gc-optimize.proto"
        bad_design.parent.mkdir(parents=True, exist_ok=True)
        bad_design.write_text(
            "\n".join(
                [
                    "design gc_optimize chassis ecoli_k12",
                    "",
                    "construct bad_unit:",
                    "  promoter pLac",
                    "  rbs B0034",
                    "  cds tetR",
                    "  terminator B0015",
                    "",
                    "constraint gc_content min=0.90 max=1.00",
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        result = self.run_cli("sequence", "optimize", "build/test-gc-optimize.proto", "--backend", "local")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertTrue(payload["suggestions"])
        self.assertEqual(payload["suggestions"][0]["type"], "gc_content")

    def test_connectors_check(self) -> None:
        self.stage_assets(*CONNECTOR_ASSETS)
        result = self.run_cli("connectors", "check")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertGreaterEqual(payload["connector_count"], 2)
        mcp = next(connector for connector in payload["connectors"] if connector["id"] == "mcp_server")
        self.assertIn("proto_literature_search", mcp["tools"])
        self.assertIn("proto_pubmed_search", mcp["tools"])
        self.assertIn("proto_europe_pmc_search", mcp["tools"])
        self.assertIn("proto_crossref_search", mcp["tools"])
        self.assertIn("proto_uniprot_search", mcp["tools"])
        self.assertIn("proto_rhea_search", mcp["tools"])
        self.assertIn("proto_validate_sequences", mcp["tools"])
        self.assertIn("proto_optimize_sequences", mcp["tools"])
        self.assertIn("proto_run_analysis", mcp["tools"])
        self.assertIn("proto_run_notebook", mcp["tools"])
        self.assertIn("proto_r_status", mcp["tools"])
        self.assertIn("proto_run_r", mcp["tools"])
        self.assertIn("proto_validate_sbol", mcp["tools"])
        self.assertIn("proto_review_packet", mcp["tools"])
        validator = next(connector for connector in payload["connectors"] if connector["id"] == "sequence_validator")
        self.assertEqual(validator["status"], "available")
        analysis = next(connector for connector in payload["connectors"] if connector["id"] == "python_analysis")
        self.assertEqual(analysis["status"], "sandbox_required")
        notebook = next(connector for connector in payload["connectors"] if connector["id"] == "jupyter")
        self.assertEqual(notebook["status"], "sandbox_required")
        r_runtime = next(connector for connector in payload["connectors"] if connector["id"] == "r_runtime")
        self.assertEqual(r_runtime["status"], "sandbox_required")
        pubmed = next(connector for connector in payload["connectors"] if connector["id"] == "pubmed")
        self.assertEqual(pubmed["status"], "available")
        sbol = next(connector for connector in payload["connectors"] if connector["id"] == "sbol_stack")
        self.assertEqual(sbol["status"], "available")
        optimizer = next(connector for connector in payload["connectors"] if connector["id"] == "dna_chisel")
        self.assertEqual(optimizer["status"], "available")
        review_packet = next(connector for connector in payload["connectors"] if connector["id"] == "review_packet")
        self.assertEqual(review_packet["status"], "available")

    def test_analysis_run_is_denied_without_explicit_execution_mode(self) -> None:
        self.stage_assets(*ANALYSIS_ASSETS)
        result = self.run_cli("analysis", "run", "analyses/summarize_design.py", "designs/toggle_switch.proto")
        self.assertEqual(result.returncode, 1, result.stderr)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["diagnostics"][0]["code"], "EXECUTION_DISABLED")

    def test_notebook_run_is_denied_without_explicit_execution_mode(self) -> None:
        self.stage_assets(*NOTEBOOK_ASSETS)
        result = self.run_cli("notebook", "run", "notebooks/design_summary.ipynb")
        self.assertEqual(result.returncode, 1, result.stderr)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["diagnostics"][0]["code"], "EXECUTION_DISABLED")

    def test_r_status_reports_runtime_availability(self) -> None:
        result = self.run_cli("r", "status")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertIn("available", payload)

    def test_workflow_run_writes_manifest(self) -> None:
        self.stage_assets(*WORKFLOW_ASSETS)
        result = self.run_cli("workflow", "run", "designs/toggle_switch.proto")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["review_status"], "human_review_required")
        manifest_path = self.workspace_path(payload["manifest_path"])
        self.assertTrue(manifest_path.exists())
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(manifest["schema_version"], "proto-agent.run.v1")
        self.assertTrue(manifest["artifacts"])
        step_ids = {step["id"] for step in manifest["steps"]}
        self.assertIn("sequence_validate", step_ids)
        self.assertIn("sbol_validate", step_ids)
        self.assertTrue(manifest["sequence_validation"]["ok"])
        self.assertTrue(manifest["sbol_validation"]["ok"])

    def test_review_run_writes_packet_and_evidence_cards(self) -> None:
        self.stage_assets(*REVIEW_ASSETS)
        result = self.run_cli(
            "review",
            "run",
            "designs/toggle_switch.proto",
            "--literature-query",
            "synthetic biology design automation",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["review_status"], "human_review_required")
        packet_path = self.workspace_path(payload["packet_path"])
        markdown_path = self.workspace_path(payload["markdown_path"])
        evidence_path = packet_path.parent / "evidence.cards.json"
        checklist_path = packet_path.parent / "human_review_checklist.md"
        self.assertTrue(packet_path.exists())
        self.assertTrue(markdown_path.exists())
        self.assertTrue(evidence_path.exists())
        self.assertTrue(checklist_path.exists())
        packet = json.loads(packet_path.read_text(encoding="utf-8"))
        evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
        self.assertEqual(packet["schema_version"], "proto-agent.review_packet.v1")
        self.assertEqual(evidence["schema_version"], "proto-agent.evidence.v1")
        self.assertGreaterEqual(evidence["summary"]["card_count"], 8)
        self.assertIn("evidence.cards.json", "\n".join(packet["artifacts"]))

    def test_mcp_tools_list(self) -> None:
        request = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/list",
                "params": {},
            }
        )
        result = self.run_cli("mcp", "--once", request)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        tool_names = {tool["name"] for tool in payload["result"]["tools"]}
        self.assertIn("proto_check", tool_names)
        self.assertIn("proto_workflow_run", tool_names)
        self.assertIn("proto_literature_search", tool_names)
        self.assertIn("proto_pubmed_search", tool_names)
        self.assertIn("proto_europe_pmc_search", tool_names)
        self.assertIn("proto_crossref_search", tool_names)
        self.assertIn("proto_uniprot_search", tool_names)
        self.assertIn("proto_rhea_search", tool_names)
        self.assertIn("proto_validate_sequences", tool_names)
        self.assertIn("proto_optimize_sequences", tool_names)
        self.assertIn("proto_run_analysis", tool_names)
        self.assertIn("proto_run_notebook", tool_names)
        self.assertIn("proto_r_status", tool_names)
        self.assertIn("proto_run_r", tool_names)
        self.assertIn("proto_validate_sbol", tool_names)
        self.assertIn("proto_review_packet", tool_names)

    def test_mcp_proto_check_tool_call(self) -> None:
        self.stage_assets(*DESIGN_ASSETS)
        request = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "proto_check",
                    "arguments": {"path": "designs/toggle_switch.proto"},
                },
            }
        )
        result = self.run_cli("mcp", "--once", request)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        structured = payload["result"]["structuredContent"]
        self.assertTrue(structured["ok"])
        self.assertFalse(payload["result"]["isError"])

    def test_mcp_review_packet_tool_call(self) -> None:
        self.stage_assets(*REVIEW_ASSETS)
        request = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 12,
                "method": "tools/call",
                "params": {
                    "name": "proto_review_packet",
                    "arguments": {
                        "path": "designs/toggle_switch.proto",
                        "literature_query": "synthetic biology design automation",
                    },
                },
            }
        )
        result = self.run_cli("mcp", "--once", request)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        structured = payload["result"]["structuredContent"]
        self.assertTrue(structured["ok"])
        self.assertTrue(self.workspace_path(structured["packet_path"]).exists())
        self.assertEqual(structured["review_status"], "human_review_required")
        self.assertFalse(payload["result"]["isError"])

    def test_mcp_literature_search_tool_call(self) -> None:
        self.stage_assets("literature/seed_sources.json")
        request = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {
                    "name": "proto_literature_search",
                    "arguments": {"query": "workbench"},
                },
            }
        )
        result = self.run_cli("mcp", "--once", request)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        structured = payload["result"]["structuredContent"]
        self.assertTrue(structured["ok"])
        self.assertGreaterEqual(structured["match_count"], 1)

    def test_mcp_pubmed_search_tool_call(self) -> None:
        self.stage_assets(*PUBMED_FIXTURE)
        request = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": {
                    "name": "proto_pubmed_search",
                    "arguments": {
                        "query": "synthetic biology design automation",
                        "retmax": 1,
                        "offline": True,
                        "fixture": "tests/fixtures/pubmed_esummary.json",
                    },
                },
            }
        )
        result = self.run_cli("mcp", "--once", request)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        structured = payload["result"]["structuredContent"]
        self.assertTrue(structured["ok"])
        self.assertEqual(structured["matches"][0]["doi"], "10.0000/fixture.12345678")

    def test_mcp_multi_source_search_tool_calls(self) -> None:
        self.stage_assets(*SOURCE_FIXTURES)
        cases = [
            ("proto_europe_pmc_search", "tests/fixtures/europe_pmc_search.json", "PMID:34181032"),
            ("proto_crossref_search", "tests/fixtures/crossref_search.json", "DOI:10.1000/example-crossref"),
            ("proto_uniprot_search", "tests/fixtures/uniprot_search.json", "UniProt:P00001"),
            ("proto_rhea_search", "tests/fixtures/rhea_search.tsv", "RHEA:12345"),
        ]
        for index, (tool, fixture, expected_id) in enumerate(cases, start=20):
            with self.subTest(tool=tool):
                request = json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": index,
                        "method": "tools/call",
                        "params": {
                            "name": tool,
                            "arguments": {
                                "query": "levodopa",
                                "limit": 1,
                                "offline": True,
                                "fixture": fixture,
                            },
                        },
                    }
                )
                result = self.run_cli("mcp", "--once", request)
                self.assertEqual(result.returncode, 0, result.stderr)
                structured = json.loads(result.stdout)["result"]["structuredContent"]
                self.assertTrue(structured["ok"])
                self.assertEqual(structured["matches"][0]["source_id"], expected_id)

    def test_mcp_sequence_validate_tool_call(self) -> None:
        self.stage_assets(*DESIGN_ASSETS)
        request = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 6,
                "method": "tools/call",
                "params": {
                    "name": "proto_validate_sequences",
                    "arguments": {"path": "designs/toggle_switch.proto"},
                },
            }
        )
        result = self.run_cli("mcp", "--once", request)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        structured = payload["result"]["structuredContent"]
        self.assertTrue(structured["ok"])
        self.assertFalse(payload["result"]["isError"])

    def test_mcp_sequence_optimize_tool_call(self) -> None:
        self.stage_assets(*DESIGN_ASSETS)
        request = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 9,
                "method": "tools/call",
                "params": {
                    "name": "proto_optimize_sequences",
                    "arguments": {
                        "path": "designs/toggle_switch.proto",
                        "backend": "auto",
                    },
                },
            }
        )
        result = self.run_cli("mcp", "--once", request)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        structured = payload["result"]["structuredContent"]
        self.assertTrue(structured["ok"])
        self.assertEqual(structured["suggestions"], [])

    def test_mcp_run_analysis_tool_call_fails_closed(self) -> None:
        self.stage_assets(*ANALYSIS_ASSETS)
        request = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 7,
                "method": "tools/call",
                "params": {
                    "name": "proto_run_analysis",
                    "arguments": {
                        "script": "analyses/summarize_design.py",
                        "args": ["designs/toggle_switch.proto"],
                        "timeout": 30,
                    },
                },
            }
        )
        result = self.run_cli("mcp", "--once", request)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        structured = payload["result"]["structuredContent"]
        self.assertFalse(structured["ok"])
        self.assertEqual(structured["diagnostics"][0]["code"], "EXECUTION_DISABLED")

    def test_mcp_run_notebook_tool_call_fails_closed(self) -> None:
        self.stage_assets(*NOTEBOOK_ASSETS)
        request = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 10,
                "method": "tools/call",
                "params": {
                    "name": "proto_run_notebook",
                    "arguments": {
                        "path": "notebooks/design_summary.ipynb",
                        "timeout": 60,
                    },
                },
            }
        )
        result = self.run_cli("mcp", "--once", request)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        structured = payload["result"]["structuredContent"]
        self.assertFalse(structured["ok"])
        self.assertEqual(structured["diagnostics"][0]["code"], "EXECUTION_DISABLED")

    def test_mcp_r_status_tool_call(self) -> None:
        request = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 11,
                "method": "tools/call",
                "params": {
                    "name": "proto_r_status",
                    "arguments": {},
                },
            }
        )
        result = self.run_cli("mcp", "--once", request)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        structured = payload["result"]["structuredContent"]
        self.assertTrue(structured["ok"])
        self.assertIn("available", structured)

    def test_mcp_sbol_validate_tool_call(self) -> None:
        self.stage_assets(*DESIGN_ASSETS)
        compile_result = self.run_cli("compile", "designs/toggle_switch.proto", "--out", "build/test-toggle.ir.json")
        self.assertEqual(compile_result.returncode, 0, compile_result.stderr)
        export_result = self.run_cli("export", "build/test-toggle.ir.json", "--format", "sbol", "--out", "build/test-toggle.sbol.ttl")
        self.assertEqual(export_result.returncode, 0, export_result.stderr)
        request = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 8,
                "method": "tools/call",
                "params": {
                    "name": "proto_validate_sbol",
                    "arguments": {"path": "build/test-toggle.sbol.ttl"},
                },
            }
        )
        result = self.run_cli("mcp", "--once", request)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        structured = payload["result"]["structuredContent"]
        self.assertTrue(structured["ok"])
        self.assertFalse(payload["result"]["isError"])


if __name__ == "__main__":
    unittest.main()
