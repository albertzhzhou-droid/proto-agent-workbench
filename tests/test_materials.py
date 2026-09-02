import json
import os
import tempfile
import unittest
from pathlib import Path

from proto_agent.materials import MaterialsError, MaterialsStore, builtin_records, normalize_record
from proto_agent.mcp_server import McpServer


def material_record(resource_id="fixture:promoter/pLac", **overrides):
    record = {
        "resource_id": resource_id,
        "kind": "genetic_part",
        "name": "pLac fixture",
        "description_en": "A software development fixture promoter.",
        "chassis": ["ecoli_k12"],
        "part_type": "promoter",
        "sequence": "ATGCGTATGCGT",
        "sequence_kind": "DNA",
        "source": {
            "provider": "fixture",
            "record_id": resource_id,
            "revision": "1",
            "release": "fixture",
            "url": "https://example.invalid/fixture",
            "retrieved_at": "2026-08-31T00:00:00Z",
            "content_sha256": "1" * 64,
        },
        "license": {
            "id": "CC0-1.0",
            "url": "https://creativecommons.org/publicdomain/zero/1.0/",
            "attribution": "fixture",
            "rights_notes": "software fixture",
            "redistribution_status": "REDISTRIBUTABLE",
        },
        "review_status": "DESIGN_ELIGIBLE",
        "design_eligibility": True,
    }
    record.update(overrides)
    return record


class MaterialsStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="proto-materials-")
        self.workspace = Path(self.temp.name) / "workspace"
        self.workspace.mkdir()
        self.root = Path(self.temp.name) / "Proto CLI Materials"
        self.store = MaterialsStore(workspace=self.workspace, root=self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_seed_is_external_and_physically_separated(self):
        manifest = self.store.initialize_seed()
        self.assertEqual(manifest["record_count"], 3)
        self.assertTrue((self.root / "snapshots" / manifest["snapshot_id"] / "quarantine.sqlite").is_file())
        self.assertEqual(self.store.status()["active_snapshot"], manifest["snapshot_id"])

    def test_hard_flag_is_quarantined_and_not_model_visible(self):
        record = material_record(description_en="toxin-associated fixture")
        manifest = self.store._create_snapshot([record], "hard-flag", sources=[{"provider": "fixture"}], label="test")
        self.store.activate(manifest["snapshot_id"])
        self.assertEqual(manifest["quarantine_record_count"], 1)
        self.assertEqual(self.store.search("toxin")["returned_count"], 0)
        with self.assertRaises(MaterialsError) as ctx:
            self.store.get(record["resource_id"])
        self.assertEqual(ctx.exception.code, "RESOURCE_NOT_FOUND")
        admin = self.store.get(record["resource_id"], include_quarantine=True, include_sequence=True)
        self.assertEqual(admin["resource"]["review_status"], "QUARANTINED")
        self.assertEqual(admin["resource"]["sequence"], record["sequence"])

    def test_materialize_and_template_render_are_bounded(self):
        manifest = self.store._create_snapshot([material_record(), *builtin_records()], "eligible", sources=[{"provider": "fixture"}], label="test")
        self.store.activate(manifest["snapshot_id"])
        materialized = self.store.materialize_parts(["fixture:promoter/pLac"], "ecoli_k12")
        payload = json.loads((self.workspace / materialized["parts_path"]).read_text(encoding="utf-8"))
        self.assertEqual(payload["parts"][0]["id"], "fixture:promoter/pLac")
        rendered = self.store.render_template(
            "proto:template/expression-cassette",
            {"slot1": "fixture:promoter/pLac", "slot2": "fixture:rbs", "slot3": "fixture:cds", "slot4": "fixture:terminator"},
            chassis="ecoli_k12",
        )
        draft = (self.workspace / rendered["output"]).read_text(encoding="utf-8")
        self.assertTrue(draft.startswith("design materialized_template chassis ecoli_k12"))

    def test_schema_and_sequence_boundaries_fail_closed(self):
        with self.assertRaises(MaterialsError):
            normalize_record(material_record(resource_id="not-namespaced"))
        with self.assertRaises(MaterialsError):
            normalize_record(material_record(sequence="ATG!", sequence_kind="DNA"))
        with self.assertRaises(MaterialsError):
            normalize_record(material_record(source={"provider": "x", "record_id": "x", "url": "https://example.invalid"}))

    def test_normalization_collision_is_rejected(self):
        with self.assertRaises(MaterialsError) as ctx:
            self.store._create_snapshot(
                [material_record("fixture:Part"), material_record("fixture:part")],
                "collision",
                sources=[{"provider": "fixture"}],
                label="test",
            )
        self.assertEqual(ctx.exception.code, "DUPLICATE_RESOURCE_ID")

    def test_activation_rejects_corrupt_sequence_object(self):
        manifest = self.store._create_snapshot([material_record()], "corruptible", sources=[{"provider": "fixture"}], label="test")
        blob = next((self.root / "snapshots" / manifest["snapshot_id"] / "blobs").rglob("*.txt.gz"))
        blob.write_bytes(b"not-a-gzip")
        with self.assertRaises(MaterialsError) as ctx:
            self.store.activate(manifest["snapshot_id"])
        self.assertEqual(ctx.exception.code, "SNAPSHOT_INTEGRITY_FAILED")

    def test_review_overlay_is_append_only(self):
        manifest = self.store._create_snapshot([material_record()], "overlay", sources=[{"provider": "fixture"}], label="test")
        self.store.activate(manifest["snapshot_id"])
        result = self.store.review_overlay(
            "fixture:promoter/pLac",
            decision="accept",
            description_en="Reviewed description.",
            reviewer="tester",
        )
        self.assertTrue(Path(result["overlay_path"]).is_file())
        self.assertEqual(result["base_review_status"], "DESIGN_ELIGIBLE")
        self.assertEqual(self.store.get("fixture:promoter/pLac")["resource"]["description_en"], "A software development fixture promoter.")

    def test_active_pointer_digest_is_verified(self):
        manifest = self.store.initialize_seed()
        pointer = self.root / "active.json"
        payload = json.loads(pointer.read_text(encoding="utf-8"))
        payload["manifest_sha256"] = "0" * 64
        pointer.write_text(json.dumps(payload), encoding="utf-8")
        with self.assertRaises(MaterialsError) as ctx:
            self.store.search()
        self.assertEqual(ctx.exception.code, "ACTIVE_POINTER_INVALID")

    def test_mcp_materials_never_initializes_or_activates(self):
        with tempfile.TemporaryDirectory(prefix="proto-materials-mcp-") as temp:
            workspace = Path(temp) / "workspace"
            workspace.mkdir()
            root = Path(temp) / "Proto CLI Materials"
            previous = os.environ.get("PROTO_AGENT_MATERIALS_ROOT")
            os.environ["PROTO_AGENT_MATERIALS_ROOT"] = str(root)
            try:
                server = McpServer(workspace_root=workspace)
                response = server.handle_message({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "proto_materials_search", "arguments": {}}})
                payload = response["result"]["structuredContent"]
                self.assertEqual(payload["diagnostics"][0]["code"], "NO_ACTIVE_SNAPSHOT")
                self.assertFalse((root / "active.json").exists())
            finally:
                if previous is None:
                    os.environ.pop("PROTO_AGENT_MATERIALS_ROOT", None)
                else:
                    os.environ["PROTO_AGENT_MATERIALS_ROOT"] = previous


if __name__ == "__main__":
    unittest.main()
