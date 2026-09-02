import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path

from proto_agent.materials import (
    MaterialsError,
    MaterialsStore,
    PROMOTION_POLICY_VERSION,
    PROMOTION_ROUND_IDS,
    builtin_records,
    normalize_record,
    promotion_record_digest,
)
from proto_agent.mcp_server import McpServer


def material_record(resource_id="fixture:promoter/pLac", **overrides):
    sequence = "ATGCGTATGCGT"
    sequence_sha256 = hashlib.sha256(sequence.encode("ascii")).hexdigest()
    record = {
        "resource_id": resource_id,
        "kind": "genetic_part",
        "name": "pLac fixture",
        "description_en": "A software development fixture promoter.",
        "chassis": ["ecoli_k12"],
        "part_type": "promoter",
        "sequence": sequence,
        "sequence_sha256": sequence_sha256,
        "sequence_kind": "DNA",
        "source": {
            "provider": "fixture",
            "record_id": resource_id,
            "revision": "1",
            "release": "fixture",
            "url": "https://example.invalid/fixture",
            "retrieved_at": "2026-08-31T00:00:00Z",
            "content_sha256": "1" * 64,
            "sequence_sha256": sequence_sha256,
        },
        "license": {
            "id": "CC0-1.0",
            "url": "https://creativecommons.org/publicdomain/zero/1.0/",
            "attribution": "fixture",
            "rights_notes": "software fixture",
            "redistribution_status": "REDISTRIBUTABLE",
        },
        "review_status": "DESIGN_ELIGIBLE",
        "safety_status": "NO_FLAG",
        "design_eligibility": True,
        "evidence_refs": ["https://example.invalid/fixture", "https://creativecommons.org/publicdomain/zero/1.0/"],
    }
    record.update(overrides)
    return record


def promotion_attestations(*records):
    result = {}
    for record in records:
        resource_id = record["resource_id"]
        result[resource_id] = {
            "policy_version": PROMOTION_POLICY_VERSION,
            "resource_id": resource_id,
            "record_sha256": promotion_record_digest(record),
            "decision": "PASS",
            "rounds": [
                {"round_id": round_id, "status": "PASS", "reason_codes": ["TEST_FIXTURE_REVIEWED"]}
                for round_id in PROMOTION_ROUND_IDS
            ],
        }
    return result


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
        pointer = json.loads((self.root / "active.json").read_text(encoding="utf-8"))
        self.assertEqual(pointer["action"], "activate")
        self.assertEqual(pointer["operator"], "")
        self.assertEqual(pointer["approval_reference"], "")
        self.assertEqual(pointer["operator_identity_assurance"], "NOT_REQUIRED_BY_SNAPSHOT_POLICY")

    def test_hard_flag_is_quarantined_and_not_model_visible(self):
        record = material_record(description_en="toxin-associated fixture")
        manifest = self.store._create_snapshot([record], "hard-flag", sources=[{"provider": "fixture"}], label="test", promotion_attestations=promotion_attestations(record))
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
        record = material_record()
        manifest = self.store._create_snapshot([record, *builtin_records()], "eligible", sources=[{"provider": "fixture"}], label="test", promotion_attestations=promotion_attestations(record))
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

    def test_untrusted_self_reported_design_eligibility_is_downgraded(self):
        normalized = normalize_record(material_record())
        self.assertEqual(normalized["review_status"], "REVIEW_REQUIRED")
        self.assertFalse(normalized["design_eligibility"])

        source = self.workspace / "self-reported.json"
        source.write_text(json.dumps({"records": [material_record()]}), encoding="utf-8")
        manifest = self.store.import_file(source)
        self.assertEqual(manifest["status_counts"]["DESIGN_ELIGIBLE"], 0)
        self.assertEqual(manifest["status_counts"]["REVIEW_REQUIRED"], 1)

    def test_explicit_no_flag_cannot_override_derived_hard_flag(self):
        record = material_record(description_en="Explicit toxin fixture", safety_status="NO_FLAG")
        normalized = normalize_record(record, promotion_attestation=promotion_attestations(record)[record["resource_id"]])
        self.assertEqual(normalized["safety_status"], "HARD_FLAG")
        self.assertEqual(normalized["review_status"], "QUARANTINED")
        self.assertFalse(normalized["design_eligibility"])

    def test_unknown_provider_license_policy_cannot_be_promoted(self):
        record = material_record()
        record["source"]["provider"] = "unknown-provider"
        normalized = normalize_record(record, promotion_attestation=promotion_attestations(record)[record["resource_id"]])
        self.assertEqual(normalized["review_status"], "REVIEW_REQUIRED")
        self.assertFalse(normalized["design_eligibility"])

    def test_missing_rights_fields_cannot_be_promoted(self):
        record = material_record()
        record["license"]["rights_notes"] = ""
        normalized = normalize_record(record, promotion_attestation=promotion_attestations(record)[record["resource_id"]])
        self.assertEqual(normalized["review_status"], "REVIEW_REQUIRED")
        self.assertFalse(normalized["design_eligibility"])

    def test_attestation_is_bound_to_audited_metadata(self):
        record = material_record()
        attestation = promotion_attestations(record)[record["resource_id"]]
        record["metadata"] = {"registry_status": "draft"}
        normalized = normalize_record(record, promotion_attestation=attestation)
        self.assertEqual(normalized["review_status"], "REVIEW_REQUIRED")
        self.assertFalse(normalized["design_eligibility"])

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
        record = material_record()
        manifest = self.store._create_snapshot([record], "corruptible", sources=[{"provider": "fixture"}], label="test", promotion_attestations=promotion_attestations(record))
        blob = next((self.root / "snapshots" / manifest["snapshot_id"] / "blobs").rglob("*.txt.gz"))
        blob.write_bytes(b"not-a-gzip")
        with self.assertRaises(MaterialsError) as ctx:
            self.store.activate(manifest["snapshot_id"])
        self.assertEqual(ctx.exception.code, "SNAPSHOT_INTEGRITY_FAILED")

    def test_review_overlay_is_append_only(self):
        record = material_record()
        manifest = self.store._create_snapshot([record], "overlay", sources=[{"provider": "fixture"}], label="test", promotion_attestations=promotion_attestations(record))
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

    def test_mcp_materials_rejects_inactive_snapshot_overrides(self):
        with tempfile.TemporaryDirectory(prefix="proto-materials-mcp-active-only-") as temp:
            workspace = Path(temp) / "workspace"
            workspace.mkdir()
            root = Path(temp) / "Proto CLI Materials"
            store = MaterialsStore(workspace=workspace, root=root)
            active_record = material_record("fixture:promoter/active")
            inactive_record = material_record("fixture:promoter/inactive")
            active_manifest = store._create_snapshot(
                [active_record],
                "active-reviewed",
                sources=[{"provider": "fixture"}],
                label="active",
                promotion_attestations=promotion_attestations(active_record),
            )
            inactive_manifest = store._create_snapshot(
                [inactive_record],
                "inactive-reviewed",
                sources=[{"provider": "fixture"}],
                label="inactive",
                manifest_annotations={"activation_policy": "EXPLICIT_HUMAN_ONLY"},
                promotion_attestations=promotion_attestations(inactive_record),
            )
            store.activate(active_manifest["snapshot_id"])

            previous = os.environ.get("PROTO_AGENT_MATERIALS_ROOT")
            os.environ["PROTO_AGENT_MATERIALS_ROOT"] = str(root)
            try:
                server = McpServer(workspace_root=workspace)

                active = server.handle_message({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {
                        "name": "proto_materials_search",
                        "arguments": {"snapshot": active_manifest["snapshot_id"]},
                    },
                })
                active_payload = active["result"]["structuredContent"]
                self.assertTrue(active_payload["ok"])
                self.assertEqual(active_payload["snapshot_id"], active_manifest["snapshot_id"])

                calls = [
                    ("proto_materials_search", {"snapshot": inactive_manifest["snapshot_id"]}),
                    ("proto_materials_get", {"resource_id": inactive_record["resource_id"], "snapshot": inactive_manifest["snapshot_id"]}),
                    ("proto_materials_facets", {"snapshot": inactive_manifest["snapshot_id"]}),
                    ("proto_materials_materialize", {"resource_ids": [inactive_record["resource_id"]], "chassis": "ecoli_k12", "snapshot": inactive_manifest["snapshot_id"]}),
                    ("proto_materials_materialize_proteins", {"resource_ids": [inactive_record["resource_id"]], "snapshot": inactive_manifest["snapshot_id"]}),
                ]
                for index, (name, arguments) in enumerate(calls, start=2):
                    with self.subTest(name=name):
                        response = server.handle_message({
                            "jsonrpc": "2.0",
                            "id": index,
                            "method": "tools/call",
                            "params": {"name": name, "arguments": arguments},
                        })
                        payload = response["result"]["structuredContent"]
                        self.assertFalse(payload["ok"])
                        self.assertEqual(payload["diagnostics"][0]["code"], "MATERIALS_SNAPSHOT_NOT_ACTIVE")
                self.assertEqual(store.status()["active_snapshot"], active_manifest["snapshot_id"])
            finally:
                if previous is None:
                    os.environ.pop("PROTO_AGENT_MATERIALS_ROOT", None)
                else:
                    os.environ["PROTO_AGENT_MATERIALS_ROOT"] = previous

    def test_mcp_materials_reverify_active_snapshot_contents_before_every_operation(self):
        with tempfile.TemporaryDirectory(prefix="proto-materials-mcp-drift-") as temp:
            workspace = Path(temp) / "workspace"
            workspace.mkdir()
            root = Path(temp) / "Proto CLI Materials"
            store = MaterialsStore(workspace=workspace, root=root)
            record = material_record("fixture:promoter/active-drift")
            manifest = store._create_snapshot(
                [record],
                "active-drift",
                sources=[{"provider": "fixture"}],
                label="active drift",
                promotion_attestations=promotion_attestations(record),
            )
            store.activate(manifest["snapshot_id"])
            catalog_path = root / "snapshots" / manifest["snapshot_id"] / "catalog.sqlite"
            with catalog_path.open("ab") as handle:
                handle.write(b"post-activation-drift")

            previous = os.environ.get("PROTO_AGENT_MATERIALS_ROOT")
            os.environ["PROTO_AGENT_MATERIALS_ROOT"] = str(root)
            try:
                server = McpServer(workspace_root=workspace)
                calls = [
                    ("proto_materials_search", {}),
                    ("proto_materials_get", {"resource_id": record["resource_id"]}),
                    ("proto_materials_facets", {}),
                    ("proto_materials_materialize", {"resource_ids": [record["resource_id"]], "chassis": "ecoli_k12"}),
                    ("proto_materials_materialize_proteins", {"resource_ids": [record["resource_id"]]}),
                ]
                for index, (name, arguments) in enumerate(calls, start=1):
                    with self.subTest(name=name):
                        response = server.handle_message({
                            "jsonrpc": "2.0",
                            "id": index,
                            "method": "tools/call",
                            "params": {"name": name, "arguments": arguments},
                        })
                        payload = response["result"]["structuredContent"]
                        self.assertFalse(payload["ok"])
                        self.assertEqual(payload["diagnostics"][0]["code"], "SNAPSHOT_INTEGRITY_FAILED")
            finally:
                if previous is None:
                    os.environ.pop("PROTO_AGENT_MATERIALS_ROOT", None)
                else:
                    os.environ["PROTO_AGENT_MATERIALS_ROOT"] = previous


if __name__ == "__main__":
    unittest.main()
