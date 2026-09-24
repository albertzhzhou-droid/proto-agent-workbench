"""Contract checks for the MCP tool table (architecture review CS1, Python half)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

from proto_agent import mcp_server
from proto_agent.tool_contracts import (
    CONTRACT_SCHEMA_VERSION,
    DATABASE_NETWORK_TOOLS,
    TOOL_CONTRACTS,
    UnknownCapabilityError,
    contract_for,
    export_contracts,
    tool_effect,
    verify_tool_contracts,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
HOST_TABLE = REPO_ROOT / "apps/proto-workbench/src/shared/tool-contracts.ts"


class ToolContractTableTest(unittest.TestCase):
    def test_every_advertised_and_dispatchable_tool_has_a_contract(self) -> None:
        server = mcp_server.McpServer()
        advertised = [tool["name"] for tool in mcp_server.TOOLS]
        handlers = list(server._tool_handlers)
        self.assertEqual(len(advertised), 43)
        self.assertEqual(set(advertised), set(TOOL_CONTRACTS))
        self.assertEqual(set(handlers), set(TOOL_CONTRACTS))

    def test_an_uncontracted_tool_stops_the_sidecar_instead_of_guessing(self) -> None:
        names = list(TOOL_CONTRACTS)
        with self.assertRaises(UnknownCapabilityError) as unregistered:
            verify_tool_contracts([*names, "proto_not_a_tool"], [*names, "proto_not_a_tool"])
        self.assertIn("proto_not_a_tool", str(unregistered.exception))

        with self.assertRaises(UnknownCapabilityError) as dropped:
            verify_tool_contracts(names[:-1], names[:-1])
        self.assertIn(names[-1], str(dropped.exception))

        with self.assertRaises(UnknownCapabilityError):
            contract_for("proto_not_a_tool")

    def test_network_gate_is_derived_from_the_contract_table(self) -> None:
        self.assertIs(mcp_server.NETWORK_TOOLS, DATABASE_NETWORK_TOOLS)
        self.assertEqual(
            set(mcp_server.NETWORK_TOOLS),
            {
                "proto_pubmed_search",
                "proto_europe_pmc_search",
                "proto_crossref_search",
                "proto_uniprot_search",
                "proto_rhea_search",
            },
        )
        for name in mcp_server.NETWORK_TOOLS:
            contract = contract_for(name)
            self.assertTrue(contract.network)
            self.assertEqual(contract.access, "grant-network")
            self.assertEqual(contract.effect, "read")
        # The remote executor is network-bearing but is gated by the host connector
        # policy, not by the per-call database capability.
        self.assertTrue(contract_for("proto_remote_run").network)
        self.assertNotIn("proto_remote_run", mcp_server.NETWORK_TOOLS)

    def test_read_only_lookups_are_not_classified_as_writes(self) -> None:
        for name in (
            "proto_pubmed_search", "proto_literature_search", "proto_connectors_check",
            "proto_language_reference", "proto_protein_validate", "proto_r_status",
            "proto_remote_catalog", "proto_skills_list", "proto_skills_resolve",
            "proto_check", "proto_validate_sbol", "proto_score",
            "proto_validate_sequences", "proto_provenance_verify",
        ):
            with self.subTest(tool=name):
                self.assertEqual(tool_effect(name), "read", "a read must not be replayed as a write on recovery")

    def test_effects_match_the_tools_that_produce_artifacts(self) -> None:
        for name in (
            "proto_compile", "proto_protein_compile", "proto_export", "proto_workflow_run",
            "proto_review_packet", "proto_compute_run", "proto_run_analysis", "proto_run_r",
            "proto_run_notebook", "proto_bioinformatics_run", "proto_remote_run",
            "proto_materials_materialize", "proto_research_figure_render",
        ):
            with self.subTest(tool=name):
                self.assertEqual(tool_effect(name), "write")

    def test_capability_ids_are_unique_and_rows_are_self_consistent(self) -> None:
        capability_ids = [contract.capability_id for contract in TOOL_CONTRACTS.values()]
        self.assertEqual(len(set(capability_ids)), len(capability_ids))
        for contract in TOOL_CONTRACTS.values():
            with self.subTest(tool=contract.name):
                self.assertTrue(contract.name.startswith("proto_"))
                if contract.network:
                    self.assertNotEqual(contract.access, "auto", "a network tool must need a grant")

    def test_contract_export_is_stable_json_for_the_host_check(self) -> None:
        exported = export_contracts()
        self.assertEqual(exported["schema_version"], CONTRACT_SCHEMA_VERSION)
        self.assertEqual(len(exported["tools"]), len(TOOL_CONTRACTS))
        self.assertEqual(json.loads(json.dumps(exported)), exported)

        completed = subprocess.run(
            [sys.executable, "-m", "proto_agent.mcp_server", "--print-tool-contracts"],
            cwd=REPO_ROOT,
            env={**os.environ, "PYTHONPATH": str(REPO_ROOT / "src")},
            capture_output=True,
            text=True,
            timeout=120,
            check=True,
        )
        self.assertEqual(json.loads(completed.stdout), exported)

    def test_host_execution_requirements_are_preserved_in_the_generated_view(self) -> None:
        compute = contract_for("proto_compute_run")
        self.assertEqual(compute.preconditions, ("schema-validated", "within-run-budget"))
        self.assertEqual(compute.produces, ("scientific-compute",))
        self.assertFalse(compute.idempotent)
        self.assertEqual(compute.cost_class, "metered")
        self.assertEqual(compute.max_calls_per_run, 24)
        self.assertIn("material-binding", contract_for("proto_compile").preconditions)
        self.assertEqual(contract_for("proto_materials_materialize_proteins").produces,
                         ("governed-materials", "protein-materialization"))
        self.assertTrue(contract_for("proto_pubmed_search").idempotent)
        self.assertEqual(contract_for("proto_pubmed_search").cost_class, "external")
        self.assertEqual(contract_for("proto_pubmed_search").max_calls_per_run, 12)

    @unittest.skipUnless(HOST_TABLE.is_file(), "the Electron host table is not present in this checkout")
    def test_host_table_declares_the_same_effect_network_and_capability(self) -> None:
        """The Electron table is the other half of this contract; both must agree."""
        rows = {}
        for line in HOST_TABLE.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped.startswith('["proto_'):
                continue
            fields = stripped.split('"')
            rows[fields[1]] = {"surface": fields[3], "effect": fields[5], "access": fields[7],
                               "capability_id": fields[9], "network": ", true," in stripped}
        for contract in TOOL_CONTRACTS.values():
            with self.subTest(tool=contract.name):
                host = rows.get(contract.name)
                self.assertIsNotNone(host, "the tool has no host contract row")
                self.assertEqual(host["surface"], "mcp")
                self.assertEqual(host["effect"], contract.effect)
                self.assertEqual(host["access"], contract.access)
                self.assertEqual(host["capability_id"], contract.capability_id)
                self.assertEqual(host["network"], contract.network)


if __name__ == "__main__":
    unittest.main()
