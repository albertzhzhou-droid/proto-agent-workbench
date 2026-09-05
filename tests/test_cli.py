from __future__ import annotations

import hashlib
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
SKILL_ASSETS = tuple(
    str(path.relative_to(ROOT)).replace("\\", "/")
    for path in sorted((ROOT / ".codex" / "skills").rglob("*"))
    if path.is_file()
)
WORKFLOW_ASSETS = (
    *DESIGN_ASSETS,
    "workflows/design_review.json",
    "connectors/proto_workbench.json",
    "literature/seed_sources.json",
    *SKILL_ASSETS,
)
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
    "apps/proto-workbench/package.json",
    "src/proto_agent/materials_promotion.py",
    *SKILL_ASSETS,
)
SKILL_CATALOG_ASSETS = (
    "connectors/proto_workbench.json",
    "parts/ecoli_k12_library.json",
    "literature/seed_sources.json",
    *SKILL_ASSETS,
)
PUBMED_FIXTURE = ("tests/fixtures/pubmed_esummary.json",)
SOURCE_FIXTURES = (
    "tests/fixtures/europe_pmc_search.json",
    "tests/fixtures/crossref_search.json",
    "tests/fixtures/uniprot_search.json",
    "tests/fixtures/rhea_search.tsv",
)


def _promotion_cli_candidate(resource_id: str = "igem:cli-evidence") -> dict:
    sequence = "TTGACATATAAT"
    sequence_sha256 = hashlib.sha256(sequence.encode("ascii")).hexdigest()
    source_url = "https://api.registry.igem.org/v1/parts/cli-evidence"
    return {
        "resource_id": resource_id,
        "kind": "genetic_part",
        "name": "Governed CLI promoter candidate",
        "aliases": ["CLI promoter candidate"],
        "description_en": "A deterministic software-catalog candidate for CLI evidence tests.",
        "description_zh": "用于 CLI 来源证据测试的确定性软件目录候选记录。",
        "chassis": ["ecoli_k12"],
        "role_terms": ["Promoter"],
        "part_type": "promoter",
        "sequence": sequence,
        "sequence_sha256": sequence_sha256,
        "sequence_kind": "DNA",
        "source": {
            "provider": "iGEM Registry",
            "record_id": "cli-evidence",
            "revision": "2026-09",
            "release": "2026-09",
            "url": source_url,
            "retrieved_at": "2026-09-01T00:00:00Z",
            "content_sha256": "1" * 64,
            "sequence_sha256": sequence_sha256,
        },
        "license": {
            "id": "CC-BY-4.0",
            "url": "https://creativecommons.org/licenses/by/4.0/legalcode",
            "attribution": "iGEM Registry CLI evidence fixture",
            "rights_notes": "Explicit redistribution terms for the deterministic CLI evidence fixture.",
            "redistribution_status": "REDISTRIBUTABLE",
        },
        "evidence_refs": [
            source_url,
            "https://creativecommons.org/licenses/by/4.0/legalcode",
        ],
        "review_status": "DESIGN_ELIGIBLE",
        "safety_status": "NO_FLAG",
        "design_eligibility": True,
        "metadata": {
            "role_accession": "SO:0000167",
            "registry_status": "published",
            "chassis_basis": "human_review_software_annotation",
        },
    }


def _promotion_cli_source_evidence() -> dict:
    return {
        "record_response": {
            "path": "evidence/igem/cli-evidence.json",
            "url": "https://api.registry.igem.org/v1/parts/cli-evidence",
            "retrieved_at": "2026-09-01T00:00:00Z",
            "sha256": "1" * 64,
            "byte_count": 512,
        },
        "license_response": {
            "path": "evidence/igem/cc-by-4.0.json",
            "url": "https://creativecommons.org/licenses/by/4.0/legalcode",
            "retrieved_at": "2026-09-01T00:00:00Z",
            "sha256": "2" * 64,
            "byte_count": 256,
            "declared_license_id": "CC-BY-4.0",
            "declared_license_url": "https://creativecommons.org/licenses/by/4.0/legalcode",
        },
    }


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
        # The expanded reviewed bundle can exceed 15 seconds on Windows during
        # verified import. Keep ordinary CLI calls on their existing short gate.
        timeout_seconds = 120 if any(
            first == "materials" and second == "bundle-install-public"
            for first, second in zip(args, args[1:])
        ) else CLI_TIMEOUT_SECONDS
        try:
            return subprocess.run(
                [sys.executable, "-m", "proto_agent.cli", *args],
                cwd=self.workspace,
                env=env,
                text=True,
                encoding="utf-8",
                errors="strict",
                capture_output=True,
                timeout=timeout_seconds,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            self.fail(f"CLI exceeded {timeout_seconds}s timeout: {exc.cmd}")

    def run_materials_cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        materials_root = self.workspace.parent / f"{self.workspace.name}-materials"
        self.addCleanup(shutil.rmtree, materials_root, True)
        return self.run_cli("--materials-root", str(materials_root), "materials", *args)

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

    def test_cli_and_mcp_export_reject_forged_dna_ir_before_writing(self) -> None:
        build = self.workspace / "build"
        build.mkdir()
        forged = build / "forged.ir.json"
        forged.write_text(
            json.dumps(
                {
                    "schema_version": "proto-agent.ir.v1",
                    "domain": "dna",
                    "design_id": "forged",
                    "chassis": "ecoli_k12",
                    "constructs": [
                        {
                            "name": "forged",
                            "topology": "linear",
                            "parts": [{"id": "fake", "type": "promoter", "sequence": "NOT-DNA-123"}],
                        }
                    ],
                    "constraints": [],
                    "provenance": {"source": "forged.proto"},
                }
            ),
            encoding="utf-8",
        )
        cli_result = self.run_cli("export", "build/forged.ir.json", "--format", "fasta", "--out", "build/forged.fasta")
        self.assertNotEqual(cli_result.returncode, 0)
        self.assertIn("unsupported DNA symbols", cli_result.stderr)
        self.assertFalse((build / "forged.fasta").exists())

        request = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 101,
                "method": "tools/call",
                "params": {
                    "name": "proto_export",
                    "arguments": {
                        "ir_path": "build/forged.ir.json",
                        "format": "fasta",
                        "out": "build/forged-mcp.fasta",
                    },
                },
            }
        )
        mcp_result = self.run_cli("mcp", "--once", request)
        self.assertEqual(mcp_result.returncode, 0, mcp_result.stderr)
        structured = json.loads(mcp_result.stdout)["result"]["structuredContent"]
        self.assertFalse(structured["ok"])
        self.assertIn("unsupported DNA symbols", structured["diagnostics"][0]["message"])
        self.assertFalse((build / "forged-mcp.fasta").exists())

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
        self.assertIn("proto_skills_list", mcp["tools"])
        self.assertIn("proto_skills_resolve", mcp["tools"])
        lm_studio = next(connector for connector in payload["connectors"] if connector["id"] == "lm-studio")
        self.assertEqual(lm_studio["base_url"], "http://127.0.0.1:1234")
        self.assertIn("POST /v1/chat/completions", lm_studio["http_routes"])
        skill_adapters = next(connector for connector in payload["connectors"] if connector["id"] == "skill-adapters")
        self.assertEqual(skill_adapters["status"], "available")
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

    def test_skill_catalog_audit_is_fully_resolved(self) -> None:
        self.stage_assets(*SKILL_CATALOG_ASSETS)
        result = self.run_cli("skills", "audit")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["pass_count"], 3)
        self.assertEqual(payload["status_counts"], {"available": 7, "partial": 0, "unavailable": 0})
        self.assertEqual(payload["findings"], [])

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
        self.assertRegex(manifest["skill_catalog_sha256"], r"^[a-f0-9]{64}$")
        self.assertRegex(manifest["connector_registry_sha256"], r"^[a-f0-9]{64}$")
        self.assertEqual(manifest["skill_compatibility"]["status"], "resolved")
        self.assertTrue(manifest["skill_bindings"])
        self.assertTrue(all(binding["resolution_status"] == "resolved" for binding in manifest["skill_bindings"]))

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
        self.assertRegex(packet["connector_registry_sha256"], r"^[a-f0-9]{64}$")
        self.assertEqual(packet["skill_compatibility"]["status"], "resolved")
        self.assertTrue(packet["workflow_skill_bindings"])
        self.assertEqual(
            {binding["skill_id"] for binding in packet["review_skill_bindings"]},
            {"research-provenance", "evidence-first-literature-review"},
        )
        self.assertTrue(all(binding["application_status"] == "applied_with_evidence" for binding in packet["review_skill_bindings"]))
        self.assertTrue(all(binding["evidence"] for binding in packet["review_skill_bindings"]))
        self.assertTrue(
            all(
                binding["connector_registry_sha256"] == packet["connector_registry_sha256"]
                for binding in packet["review_skill_bindings"]
            )
        )

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
        self.assertIn("proto_skills_list", tool_names)
        self.assertIn("proto_skills_resolve", tool_names)

    def test_mcp_skill_resolution_is_read_only_and_available(self) -> None:
        self.stage_assets(*SKILL_CATALOG_ASSETS)
        request = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "proto_skills_resolve",
                    "arguments": {"skill_id": "lm-studio-model-endpoint"},
                },
            }
        )
        result = self.run_cli("mcp", "--once", request)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        resolved = json.loads(payload["result"]["content"][0]["text"])
        self.assertTrue(resolved["ok"])
        self.assertEqual(resolved["adapter"]["status"], "available")
        self.assertEqual(
            {operation["id"] for operation in resolved["adapter"]["operations"]},
            {"discover-models", "load-model", "generate-chat", "unload-owned-model"},
        )

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

    def test_public_materials_cli_activation_requires_and_records_operator_evidence(self) -> None:
        installed = self.run_materials_cli("bundle-install-public")
        self.assertEqual(installed.returncode, 0, installed.stderr)
        snapshot_id = json.loads(installed.stdout)["snapshot_id"]

        missing = self.run_materials_cli("activate", snapshot_id)
        self.assertEqual(missing.returncode, 2)
        self.assertIn("requires both a self-declared operator label", missing.stderr)

        activated = self.run_materials_cli(
            "activate",
            snapshot_id,
            "--operator",
            "cli-test-operator-label",
            "--approval-reference",
            "review-ticket:CLI-1",
        )
        self.assertEqual(activated.returncode, 0, activated.stderr)
        payload = json.loads(activated.stdout)
        self.assertEqual(payload["action"], "activate")
        self.assertEqual(payload["operator"], "cli-test-operator-label")
        self.assertEqual(payload["approval_reference"], "review-ticket:CLI-1")
        self.assertEqual(payload["operator_identity_assurance"], "SELF_DECLARED_UNVERIFIED")

        materials_root = self.workspace.parent / f"{self.workspace.name}-materials"
        pointer = json.loads((materials_root / "active.json").read_text(encoding="utf-8"))
        self.assertEqual(pointer["action"], "activate")
        self.assertEqual(pointer["approval_reference"], "review-ticket:CLI-1")

    def test_materials_promotion_audit_non_fixture_without_source_evidence_fails_closed(self) -> None:
        candidate_path = self.workspace / "inputs" / "promotion-candidates.json"
        candidate_path.parent.mkdir(parents=True)
        candidate_path.write_text(
            json.dumps({"records": [_promotion_cli_candidate()]}),
            encoding="utf-8",
        )
        result = self.run_materials_cli(
            "promotion-audit",
            "inputs/promotion-candidates.json",
            "--generated-at",
            "2026-09-01T00:00:00Z",
            "--out",
            "build/materials/no-evidence-audit.json",
        )
        self.assertEqual(result.returncode, 1, result.stderr)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn(
            "SOURCE_EVIDENCE_MISSING",
            payload["candidates"][0]["rounds"][0]["reason_codes"],
        )

    def test_materials_promotion_audit_explicit_source_evidence_passes_and_writes_artifact(self) -> None:
        resource_id = "igem:cli-evidence"
        candidate_path = self.workspace / "inputs" / "promotion-candidates.json"
        evidence_path = self.workspace / "inputs" / "promotion-evidence.json"
        candidate_path.parent.mkdir(parents=True)
        candidate_path.write_text(
            json.dumps({"records": [_promotion_cli_candidate(resource_id)]}),
            encoding="utf-8",
        )
        evidence_path.write_text(
            json.dumps({"source_evidence": {resource_id: _promotion_cli_source_evidence()}}),
            encoding="utf-8",
        )
        result = self.run_materials_cli(
            "promotion-audit",
            "inputs/promotion-candidates.json",
            "--source-evidence",
            "inputs/promotion-evidence.json",
            "--generated-at",
            "2026-09-01T00:00:00Z",
            "--out",
            "build/materials/explicit-evidence-audit.json",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["pass_count"], 1)
        artifact = self.workspace_path(payload["artifact"])
        self.assertTrue(artifact.is_file())
        persisted = json.loads(artifact.read_text(encoding="utf-8"))
        self.assertEqual(persisted["candidates"][0]["source_evidence"], _promotion_cli_source_evidence())

    def test_materials_promotion_audit_accepts_locked_audit_evidence_schema(self) -> None:
        resource_id = "igem:cli-evidence"
        inputs = self.workspace / "inputs"
        inputs.mkdir(parents=True)
        (inputs / "promotion-candidates.json").write_text(
            json.dumps({"records": [_promotion_cli_candidate(resource_id)]}),
            encoding="utf-8",
        )
        (inputs / "locked-promotion-audit.json").write_text(
            json.dumps(
                {
                    "schema_version": "proto-agent.materials-promotion-audit.v1",
                    "policy_version": "proto-agent.materials-promotion-policy.2026-09",
                    "candidates": [
                        {
                            "resource_id": resource_id,
                            "source_evidence": _promotion_cli_source_evidence(),
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        result = self.run_materials_cli(
            "promotion-audit",
            "inputs/promotion-candidates.json",
            "--source-evidence",
            "inputs/locked-promotion-audit.json",
            "--generated-at",
            "2026-09-01T00:00:00Z",
            "--out",
            "build/materials/locked-evidence-audit.json",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["ok"])

    def test_materials_promotion_audit_rejects_malformed_or_duplicate_evidence_ids(self) -> None:
        resource_id = "igem:cli-evidence"
        inputs = self.workspace / "inputs"
        inputs.mkdir(parents=True)
        (inputs / "promotion-candidates.json").write_text(
            json.dumps({"records": [_promotion_cli_candidate(resource_id)]}),
            encoding="utf-8",
        )
        malformed_path = inputs / "malformed-evidence.json"
        malformed_path.write_text(
            json.dumps({"source_evidence": {resource_id: []}}),
            encoding="utf-8",
        )
        malformed = self.run_materials_cli(
            "promotion-audit",
            "inputs/promotion-candidates.json",
            "--source-evidence",
            "inputs/malformed-evidence.json",
        )
        self.assertEqual(malformed.returncode, 2)
        self.assertIn("source_evidence must be an object", malformed.stderr)

        duplicate_path = inputs / "duplicate-evidence.json"
        duplicate_path.write_text(
            json.dumps(
                {
                    "schema_version": "proto-agent.materials-promotion-audit.v1",
                    "policy_version": "proto-agent.materials-promotion-policy.2026-09",
                    "candidates": [
                        {"resource_id": resource_id, "source_evidence": _promotion_cli_source_evidence()},
                        {"resource_id": resource_id.upper(), "source_evidence": _promotion_cli_source_evidence()},
                    ],
                }
            ),
            encoding="utf-8",
        )
        duplicate = self.run_materials_cli(
            "promotion-audit",
            "inputs/promotion-candidates.json",
            "--source-evidence",
            "inputs/duplicate-evidence.json",
        )
        self.assertEqual(duplicate.returncode, 2)
        self.assertIn("Duplicate promotion source-evidence resource_id", duplicate.stderr)


if __name__ == "__main__":
    unittest.main()
