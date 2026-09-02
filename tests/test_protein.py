from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from proto_agent.materials import (
    MaterialsError,
    MaterialsStore,
    PROMOTION_POLICY_VERSION,
    PROMOTION_ROUND_IDS,
    promotion_record_digest,
)
from proto_agent.protein import PROTEIN_SELECTION_SCHEMA_VERSION, compile_protein_selection, protein_metrics
from proto_agent.exporters import export_ir


SEQUENCE = "MSKGEELFTGVVPILVELDGDVNGHKFSVSGEGEGDATYGKL"
SEQUENCE_HASH = hashlib.sha256(SEQUENCE.encode("ascii")).hexdigest()


def protein_record(resource_id: str = "uniprot:fixture-GFP") -> dict:
    return {
        "resource_id": resource_id,
        "kind": "protein_sequence",
        "name": "Fixture fluorescent protein",
        "description_en": "A reviewed software protein fixture.",
        "description_zh": "已审查的软件蛋白测试记录。",
        "organism": {"tax_id": 6100, "name": "Aequorea victoria", "strain": ""},
        "role_terms": ["fluorescent protein", "reporter protein"],
        "sequence_kind": "PROTEIN",
        "sequence": SEQUENCE,
        "sequence_sha256": SEQUENCE_HASH,
        "source": {
            "provider": "UniProtKB/Swiss-Prot",
            "record_id": "FIXTURE",
            "revision": "entry",
            "release": "fixture",
            "url": "https://example.invalid/uniprot/FIXTURE",
            "retrieved_at": "2026-08-31T00:00:00Z",
            "content_sha256": "1" * 64,
            "sequence_sha256": SEQUENCE_HASH,
        },
        "license": {
            "id": "CC-BY-4.0",
            "url": "https://creativecommons.org/licenses/by/4.0/",
            "attribution": "Fixture",
            "rights_notes": "Fixture rights are explicit for tests.",
            "redistribution_status": "REDISTRIBUTABLE",
        },
        "review_status": "DESIGN_ELIGIBLE",
        "safety_status": "NO_FLAG",
        "design_eligibility": True,
        "evidence_refs": [
            "https://www.uniprot.org/uniprotkb/FIXTURE/entry",
            "https://creativecommons.org/licenses/by/4.0/",
        ],
        "metadata": {"reviewed_record": True},
    }


def promotion_attestations(record: dict) -> dict[str, dict]:
    return {
        record["resource_id"]: {
            "policy_version": PROMOTION_POLICY_VERSION,
            "resource_id": record["resource_id"],
            "record_sha256": promotion_record_digest(record),
            "decision": "PASS",
            "rounds": [
                {"round_id": round_id, "status": "PASS", "reason_codes": ["TEST_FIXTURE_REVIEWED"]}
                for round_id in PROMOTION_ROUND_IDS
            ],
        }
    }


class ProteinCompilationTests(unittest.TestCase):
    def test_metrics_are_bounded_and_deterministic(self) -> None:
        metrics = protein_metrics(SEQUENCE)
        self.assertEqual(metrics["length_aa"], len(SEQUENCE))
        self.assertGreater(metrics["molecular_weight_da_approx"], 0)
        self.assertAlmostEqual(sum(metrics["composition"].values()), len(SEQUENCE))

    def test_materialize_and_compile_design_eligible_protein(self) -> None:
        with tempfile.TemporaryDirectory(prefix="proto-protein-") as temp:
            root = Path(temp) / "Proto CLI Materials"
            workspace = Path(temp) / "workspace"
            workspace.mkdir()
            store = MaterialsStore(workspace=workspace, root=root)
            record = protein_record()
            manifest = store._create_snapshot(
                [record],
                "protein-fixture",
                sources=[{"provider": "fixture"}],
                label="protein",
                promotion_attestations=promotion_attestations(record),
            )
            store.activate(manifest["snapshot_id"])
            materialized = store.materialize_proteins(["uniprot:fixture-GFP"], design_id="fixture-protein")
            selection = workspace / materialized["proteins_path"]
            payload = json.loads(selection.read_text(encoding="utf-8"))
            self.assertEqual(payload["schema_version"], PROTEIN_SELECTION_SCHEMA_VERSION)
            self.assertEqual(payload["selection_digest"], materialized["selection_digest"])
            self.assertEqual(payload["catalog_attestation"]["signature_status"], "UNSIGNED")
            self.assertEqual(payload["catalog_attestation"]["authenticity"], "NOT_ESTABLISHED")
            # Compilation is intentionally self-contained after materializing;
            # no active or reachable external catalogue is consulted.
            root.rename(root.with_name("catalog-offline"))
            ir, diagnostics = compile_protein_selection(selection)
            self.assertIsNotNone(ir)
            self.assertFalse(any(item.severity == "error" for item in diagnostics))
            assert ir is not None
            self.assertEqual(ir["domain"], "protein")
            self.assertEqual(ir["proteins"][0]["sequence_sha256"], SEQUENCE_HASH)
            self.assertEqual(ir["constructs"], [])
            self.assertEqual(ir["provenance"]["catalog_signature_status"], "UNSIGNED")

    def test_compile_rejects_non_eligible_selection(self) -> None:
        with tempfile.TemporaryDirectory(prefix="proto-protein-invalid-") as temp:
            path = Path(temp) / "selection.json"
            record = protein_record()
            record["design_eligibility"] = False
            path.write_text(json.dumps({"schema_version": PROTEIN_SELECTION_SCHEMA_VERSION, "snapshot_id": "fixture", "proteins": [record]}), encoding="utf-8")
            ir, diagnostics = compile_protein_selection(path)
            self.assertIsNone(ir)
            self.assertTrue(any(item.severity == "error" for item in diagnostics))

    def test_materialize_rejects_generic_reference_record(self) -> None:
        with tempfile.TemporaryDirectory(prefix="proto-protein-reference-") as temp:
            root = Path(temp) / "Proto CLI Materials"
            workspace = Path(temp) / "workspace"
            workspace.mkdir()
            store = MaterialsStore(workspace=workspace, root=root)
            record = protein_record()
            record["review_status"] = "REFERENCE_ONLY"
            record["design_eligibility"] = False
            manifest = store._create_snapshot([record], "protein-reference", sources=[{"provider": "fixture"}], label="protein")
            store.activate(manifest["snapshot_id"])
            with self.assertRaises(MaterialsError):
                store.materialize_proteins(["uniprot:fixture-GFP"])

    def test_fasta_headers_keep_untrusted_labels_on_one_line(self) -> None:
        with tempfile.TemporaryDirectory(prefix="proto-protein-fasta-") as temp:
            root = Path(temp) / "Proto CLI Materials"
            workspace = Path(temp) / "workspace"
            workspace.mkdir()
            store = MaterialsStore(workspace=workspace, root=root)
            record = protein_record()
            manifest = store._create_snapshot(
                [record],
                "protein-fasta-fixture",
                sources=[{"provider": "fixture"}],
                label="protein",
                promotion_attestations=promotion_attestations(record),
            )
            materialized = store.materialize_proteins(
                ["uniprot:fixture-GFP"],
                design_id="fixture-protein",
                snapshot_id=manifest["snapshot_id"],
            )
            ir, diagnostics = compile_protein_selection(workspace / materialized["proteins_path"])
            self.assertIsNotNone(ir)
            self.assertFalse(any(item.severity == "error" for item in diagnostics))
            assert ir is not None
            fasta = export_ir(ir, "fasta")
            header = fasta.splitlines()[0]
            self.assertTrue(header.startswith(">fixture-protein|uniprot:fixture-GFP|Fixture fluorescent protein|domain=protein"))
            self.assertNotIn("\r", header)
            self.assertIn(f"|sha256={SEQUENCE_HASH}|", header)
            self.assertIn("|license=CC-BY-4.0|", header)
            self.assertIn("|review=human_review_required|catalog_signature=UNSIGNED", header)

    def test_compile_rejects_self_asserted_eligibility_and_post_materialization_tampering(self) -> None:
        with tempfile.TemporaryDirectory(prefix="proto-protein-attestation-poc-") as temp:
            workspace = Path(temp) / "workspace"
            workspace.mkdir()
            self_asserted = workspace / "self-asserted.json"
            self_asserted.write_text(
                json.dumps(
                    {
                        "schema_version": PROTEIN_SELECTION_SCHEMA_VERSION,
                        "snapshot_id": "forged",
                        "design_id": "forged",
                        "chassis": "protein_sequence",
                        "proteins": [protein_record()],
                    }
                ),
                encoding="utf-8",
            )
            ir, diagnostics = compile_protein_selection(self_asserted)
            self.assertIsNone(ir)
            self.assertTrue(any(item.code == "PROTEIN_SELECTION_ATTESTATION_INVALID" for item in diagnostics))

            root = Path(temp) / "Proto CLI Materials"
            store = MaterialsStore(workspace=workspace, root=root)
            record = protein_record()
            manifest = store._create_snapshot(
                [record],
                "protein-tamper-fixture",
                sources=[{"provider": "fixture"}],
                label="protein",
                promotion_attestations=promotion_attestations(record),
            )
            result = store.materialize_proteins([record["resource_id"]], snapshot_id=manifest["snapshot_id"])
            selection_path = workspace / result["proteins_path"]
            selection = json.loads(selection_path.read_text(encoding="utf-8"))
            selection["proteins"][0]["name"] = "post-materialization mutation"
            selection_path.write_text(json.dumps(selection), encoding="utf-8")
            ir, diagnostics = compile_protein_selection(selection_path)
            self.assertIsNone(ir)
            self.assertTrue(any("digest" in item.message.lower() for item in diagnostics))

    def test_export_fails_closed_for_forged_protein_and_dna_sequences(self) -> None:
        dna_ir = {
            "schema_version": "proto-agent.ir.v1",
            "domain": "dna",
            "design_id": "dna-fixture",
            "chassis": "ecoli_k12",
            "constructs": [
                {
                    "name": "valid",
                    "topology": "linear",
                    "parts": [{"id": "fixture", "type": "promoter", "sequence": "ACGTN"}],
                }
            ],
            "constraints": [],
            "provenance": {"source": "fixture.proto"},
        }
        self.assertIn(">dna-fixture|valid|domain=dna", export_ir(dna_ir, "fasta"))
        dna_ir["constructs"][0]["parts"][0]["sequence"] = "NOT-DNA-123"
        with self.assertRaisesRegex(ValueError, "unsupported DNA symbols"):
            export_ir(dna_ir, "fasta")

        with tempfile.TemporaryDirectory(prefix="proto-protein-export-poc-") as temp:
            root = Path(temp) / "Proto CLI Materials"
            workspace = Path(temp) / "workspace"
            workspace.mkdir()
            store = MaterialsStore(workspace=workspace, root=root)
            record = protein_record()
            manifest = store._create_snapshot(
                [record],
                "protein-export-fixture",
                sources=[{"provider": "fixture"}],
                label="protein",
                promotion_attestations=promotion_attestations(record),
            )
            result = store.materialize_proteins([record["resource_id"]], snapshot_id=manifest["snapshot_id"])
            ir, _ = compile_protein_selection(workspace / result["proteins_path"])
            assert ir is not None
            ir["proteins"][0]["sequence"] = "NOT_A_PROTEIN_123"
            with self.assertRaisesRegex(ValueError, "unsupported amino-acid symbols"):
                export_ir(ir, "fasta")


if __name__ == "__main__":
    unittest.main()
