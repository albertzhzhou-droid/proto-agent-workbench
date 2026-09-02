from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from proto_agent.materials import MaterialsError, MaterialsStore
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
            "content_sha256": SEQUENCE_HASH,
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
            manifest = store._create_snapshot([protein_record()], "protein-fixture", sources=[{"provider": "fixture"}], label="protein")
            store.activate(manifest["snapshot_id"])
            materialized = store.materialize_proteins(["uniprot:fixture-GFP"], design_id="fixture-protein")
            selection = workspace / materialized["proteins_path"]
            payload = json.loads(selection.read_text(encoding="utf-8"))
            self.assertEqual(payload["schema_version"], PROTEIN_SELECTION_SCHEMA_VERSION)
            ir, diagnostics = compile_protein_selection(selection)
            self.assertIsNotNone(ir)
            self.assertFalse(any(item.severity == "error" for item in diagnostics))
            assert ir is not None
            self.assertEqual(ir["domain"], "protein")
            self.assertEqual(ir["proteins"][0]["sequence_sha256"], SEQUENCE_HASH)
            self.assertEqual(ir["constructs"], [])

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
            path = Path(temp) / "selection.json"
            path.write_text(json.dumps({"schema_version": PROTEIN_SELECTION_SCHEMA_VERSION, "snapshot_id": "fixture", "proteins": [protein_record()]}), encoding="utf-8")
            ir, diagnostics = compile_protein_selection(path)
            self.assertIsNotNone(ir)
            self.assertFalse(any(item.severity == "error" for item in diagnostics))
            assert ir is not None
            ir["design_id"] = "panel\nwith-newline"
            ir["proteins"][0]["name"] = "record\r\nwith-newline"
            fasta = export_ir(ir, "fasta")
            self.assertEqual(fasta.splitlines()[0], ">panel with-newline|uniprot:fixture-GFP|record with-newline|protein")


if __name__ == "__main__":
    unittest.main()
