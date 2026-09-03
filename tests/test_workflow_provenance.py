from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from proto_agent.materials import (
    MaterialsStore,
    PROMOTION_POLICY_VERSION,
    PROMOTION_ROUND_IDS,
    promotion_record_digest,
)
from proto_agent.provenance import ProvenanceError, create_provenance, verify_provenance
from proto_agent import review as review_module
from proto_agent.review import build_review_packet
from proto_agent import workflow as workflow_module
from proto_agent.workflow import run_design_review


ROOT = Path(__file__).resolve().parents[1]
TOY_LIBRARY_ACTION = "Replace toy fixture libraries with reviewed source libraries before real biological design."


def _governed_part_record(resource_id: str, part_type: str, sequence: str) -> dict[str, object]:
    sequence_sha256 = hashlib.sha256(sequence.encode("ascii")).hexdigest()
    record_id = resource_id.split(":", 1)[1]
    role_terms = {
        "promoter": ["Promoter"],
        "rbs": ["Ribosome Entry Site"],
        "cds": ["CDS"],
        "terminator": ["Terminator"],
    }[part_type]
    return {
        "resource_id": resource_id,
        "kind": "genetic_part",
        "name": f"Governed {part_type}",
        "description_en": f"Governed software-only {part_type} review record.",
        "chassis": ["ecoli_k12"],
        "role_terms": role_terms,
        "part_type": part_type,
        "sequence": sequence,
        "sequence_sha256": sequence_sha256,
        "sequence_kind": "DNA",
        "source": {
            "provider": "iGEM Registry",
            "record_id": record_id,
            "revision": "2026-09",
            "release": "2026-09",
            "url": f"https://api.registry.igem.org/v1/parts/{record_id}",
            "retrieved_at": "2026-09-03T00:00:00Z",
            "content_sha256": hashlib.sha256(f"source:{resource_id}".encode("utf-8")).hexdigest(),
            "sequence_sha256": sequence_sha256,
        },
        "license": {
            "id": "CC-BY-4.0",
            "url": "https://creativecommons.org/licenses/by/4.0/legalcode",
            "attribution": "iGEM Registry review fixture",
            "rights_notes": "Redistributable review-test record with retained source attribution.",
            "redistribution_status": "REDISTRIBUTABLE",
        },
        "evidence_refs": [
            f"https://api.registry.igem.org/v1/parts/{record_id}",
            "https://creativecommons.org/licenses/by/4.0/legalcode",
        ],
        "review_status": "DESIGN_ELIGIBLE",
        "safety_status": "NO_FLAG",
        "design_eligibility": True,
        "metadata": {"registry_status": "published"},
    }


def _promotion_attestations(records: list[dict[str, object]]) -> dict[str, dict[str, object]]:
    return {
        str(record["resource_id"]): {
            "policy_version": PROMOTION_POLICY_VERSION,
            "resource_id": record["resource_id"],
            "record_sha256": promotion_record_digest(record),
            "decision": "PASS",
            "rounds": [
                {"round_id": round_id, "status": "PASS", "reason_codes": ["TEST_FIXTURE_REVIEWED"]}
                for round_id in PROMOTION_ROUND_IDS
            ],
        }
        for record in records
    }


class WorkflowProvenanceTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory(prefix="proto-workflow-test-")
        self.workspace = Path(self._temporary.name).resolve()
        for name in ("designs", "parts", "workflows", "literature", "connectors", ".codex"):
            shutil.copytree(ROOT / name, self.workspace / name)

    def tearDown(self) -> None:
        self._temporary.cleanup()

    def test_workflow_creates_verifiable_provenance(self) -> None:
        manifest, code = run_design_review(
            "designs/toggle_switch.proto",
            workspace_root=self.workspace,
        )

        self.assertEqual(code, 0)
        self.assertIn("workflow", manifest["inputs"])
        self.assertEqual(manifest["skill_compatibility"]["status"], "resolved")
        self.assertRegex(manifest["connector_registry_sha256"], r"^[a-f0-9]{64}$")
        self.assertRegex(manifest["workflow_sha256"], r"^[a-f0-9]{64}$")
        self.assertNotIn(str(self.workspace), json.dumps(manifest))
        ir_path = self.workspace / next(
            artifact for artifact in manifest["artifacts"] if artifact.endswith(".ir.json")
        )
        ir = json.loads(ir_path.read_text(encoding="utf-8"))
        self.assertEqual(ir["provenance"]["source"], "designs/toggle_switch.proto")
        self.assertNotIn(str(self.workspace), json.dumps(ir))
        result = verify_provenance(
            self.workspace / manifest["provenance_path"],
            workspace_root=self.workspace,
            build_root="build",
        )
        self.assertTrue(result["ok"], result["mismatches"])
        self.assertEqual(
            result["subject"]["path"],
            Path(manifest["manifest_path"]).relative_to("build").as_posix(),
        )

    def test_workflow_rejects_steps_review_gate_or_skills_that_do_not_match_execution(self) -> None:
        source = json.loads((self.workspace / "workflows" / "design_review.json").read_text(encoding="utf-8"))
        mutations = (
            (lambda payload: payload.update({"steps": []}), "steps must exactly match"),
            (
                lambda payload: payload.update(
                    {"review_gate": {"status": "approved", "message": "not a valid human review gate"}}
                ),
                "human_review_required",
            ),
            (
                lambda payload: payload.update(
                    {
                        "skill_bindings": [
                            {
                                "skill_id": "evidence-first-literature-review",
                                "stage": "unrelated",
                                "required": True,
                                "operations": ["search-biomedical-literature"],
                            }
                        ]
                    }
                ),
                "exactly match the operations applied",
            ),
        )
        for mutation, message in mutations:
            with self.subTest(message=message):
                payload = json.loads(json.dumps(source))
                mutation(payload)
                candidate = self.workspace / "workflows" / "invalid_design_review.json"
                candidate.write_text(json.dumps(payload), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, message):
                    run_design_review(
                        "designs/toggle_switch.proto",
                        workflow_path="workflows/invalid_design_review.json",
                        workspace_root=self.workspace,
                    )

    def test_workflow_provenance_rejects_input_replaced_after_consumption(self) -> None:
        workflow_path = self.workspace / "workflows" / "design_review.json"
        replacement = json.loads(workflow_path.read_text(encoding="utf-8"))
        replacement["description"] = "A different but schema-valid workflow file."
        original_parse = workflow_module.parse_design

        def replace_after_workflow_read(*args: object, **kwargs: object):
            workflow_path.write_text(json.dumps(replacement), encoding="utf-8")
            return original_parse(*args, **kwargs)

        with (
            mock.patch.object(workflow_module, "parse_design", side_effect=replace_after_workflow_read),
            self.assertRaisesRegex(ProvenanceError, "changed after it was consumed"),
        ):
            run_design_review(
                "designs/toggle_switch.proto",
                workspace_root=self.workspace,
            )

    def test_workflow_provenance_rejects_design_replaced_after_compile(self) -> None:
        design_path = self.workspace / "designs" / "toggle_switch.proto"
        original_compile = workflow_module.compile_design

        def replace_after_compile(*args: object, **kwargs: object):
            result = original_compile(*args, **kwargs)
            source = design_path.read_text(encoding="utf-8")
            design_path.write_text(source.replace("toggle_switch_v1", "swapped_after_compile", 1), encoding="utf-8")
            return result

        with (
            mock.patch.object(workflow_module, "compile_design", side_effect=replace_after_compile),
            self.assertRaisesRegex(ProvenanceError, "design input changed after it was consumed"),
        ):
            run_design_review(
                "designs/toggle_switch.proto",
                workspace_root=self.workspace,
            )

    def test_legacy_workflow_without_skill_bindings_fails_closed_without_rewriting_source(self) -> None:
        legacy_relative = Path("workflows") / "legacy_design_review.json"
        legacy_path = self.workspace / legacy_relative
        workflow = json.loads((self.workspace / "workflows" / "design_review.json").read_text(encoding="utf-8"))
        workflow.pop("skill_bindings")
        legacy_path.write_text(json.dumps(workflow, indent=2) + "\n", encoding="utf-8")
        source_before = legacy_path.read_bytes()

        manifest, code = run_design_review(
            "designs/toggle_switch.proto",
            workflow_path=legacy_relative,
            workspace_root=self.workspace,
        )

        self.assertEqual(code, 1)
        self.assertFalse(manifest["ok"])
        self.assertEqual(
            manifest["skill_compatibility"],
            {
                "mode": "legacy_no_skill_bindings",
                "status": "needs_review",
                "reason_code": "LEGACY_WORKFLOW_SKILL_BINDINGS_MISSING",
                "message": manifest["skill_compatibility"]["message"],
            },
        )
        self.assertEqual(manifest["skill_catalog_sha256"], "")
        self.assertEqual(manifest["connector_registry_sha256"], "")
        self.assertEqual(manifest["skill_bindings"], [])
        self.assertEqual(legacy_path.read_bytes(), source_before)

        packet, review_code = build_review_packet(
            "designs/toggle_switch.proto",
            workflow_path=legacy_relative,
            manifest_path=Path(manifest["manifest_path"]),
            workspace_root=self.workspace,
        )

        self.assertEqual(review_code, 1)
        self.assertFalse(packet["ok"])
        self.assertEqual(packet["skill_compatibility"]["status"], "needs_review")
        self.assertEqual(packet["review_skill_bindings"], [])
        self.assertEqual(
            next(gate for gate in packet["review_gates"] if gate["id"] == "software_validation")["status"],
            "blocked",
        )
        evidence_path = self.workspace / next(
            artifact for artifact in packet["artifacts"] if artifact.endswith("evidence.cards.json")
        )
        evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
        compatibility_card = next(card for card in evidence["cards"] if card["evidence_type"] == "skill_compatibility")
        self.assertEqual(compatibility_card["status"], "needs_review")
        self.assertEqual(legacy_path.read_bytes(), source_before)

    def test_bound_workflow_review_requires_catalog_and_connector_digests(self) -> None:
        for field in ("skill_catalog_sha256", "connector_registry_sha256"):
            with self.subTest(field=field):
                manifest, code = run_design_review(
                    "designs/toggle_switch.proto",
                    workspace_root=self.workspace,
                )
                self.assertEqual(code, 0)
                manifest_path = self.workspace / manifest["manifest_path"]
                payload = json.loads(manifest_path.read_text(encoding="utf-8"))
                payload[field] = ""
                manifest_path.write_text(json.dumps(payload), encoding="utf-8")
                create_provenance(
                    manifest_path,
                    workspace_root=self.workspace,
                    build_root="build",
                    output_path=self.workspace / manifest["provenance_path"],
                )

                with self.assertRaisesRegex(ValueError, "digest"):
                    build_review_packet(
                        "designs/toggle_switch.proto",
                        manifest_path=Path(manifest["manifest_path"]),
                        workspace_root=self.workspace,
                    )

    def test_review_rejects_self_attested_fabricated_skill_binding(self) -> None:
        manifest, code = run_design_review(
            "designs/toggle_switch.proto",
            workspace_root=self.workspace,
        )
        self.assertEqual(code, 0)
        manifest_path = self.workspace / manifest["manifest_path"]
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        payload["skill_bindings"][0].update(
            {
                "skill_id": "fabricated-skill",
                "operations": ["fabricated-operation"],
                "adapter_version": "999",
                "manifest_sha256": "a" * 64,
                "document_sha256": "b" * 64,
            }
        )
        manifest_path.write_text(json.dumps(payload), encoding="utf-8")
        create_provenance(
            manifest_path,
            workspace_root=self.workspace,
            build_root="build",
            output_path=self.workspace / manifest["provenance_path"],
        )

        with self.assertRaisesRegex(ProvenanceError, "Skill bindings do not match"):
            build_review_packet(
                "designs/toggle_switch.proto",
                manifest_path=Path(manifest["manifest_path"]),
                workspace_root=self.workspace,
            )

    def test_review_rejects_synchronized_workflow_and_snapshot_skill_fabrication(self) -> None:
        manifest, code = run_design_review(
            "designs/toggle_switch.proto",
            workspace_root=self.workspace,
        )
        self.assertEqual(code, 0)
        manifest_path = self.workspace / manifest["manifest_path"]
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        fabricated_workflow = json.loads(
            (self.workspace / payload["inputs"]["workflow"]).read_text(encoding="utf-8")
        )
        fabricated_workflow["skill_bindings"] = [
            {
                "skill_id": "lm-studio-model-endpoint",
                "stage": "fabricated",
                "required": True,
                "operations": ["discover-models"],
            }
        ]
        workflow_bytes = (json.dumps(fabricated_workflow, indent=2) + "\n").encode("utf-8")
        (self.workspace / payload["inputs"]["workflow"]).write_bytes(workflow_bytes)
        (self.workspace / payload["inputs"]["consumed_workflow"]).write_bytes(workflow_bytes)
        payload["workflow"] = fabricated_workflow
        payload["workflow_sha256"] = hashlib.sha256(workflow_bytes).hexdigest()
        payload["input_digests"]["workflow"] = {
            "sha256": payload["workflow_sha256"],
            "size": len(workflow_bytes),
        }
        manifest_path.write_text(json.dumps(payload), encoding="utf-8")
        create_provenance(
            manifest_path,
            workspace_root=self.workspace,
            build_root="build",
            output_path=self.workspace / manifest["provenance_path"],
        )

        with self.assertRaisesRegex(ProvenanceError, "Skill bindings no longer resolve"):
            build_review_packet(
                "designs/toggle_switch.proto",
                manifest_path=Path(manifest["manifest_path"]),
                workspace_root=self.workspace,
            )

    def test_review_verifies_workflow_and_attests_review_outputs(self) -> None:
        manifest, code = run_design_review(
            "designs/toggle_switch.proto",
            workspace_root=self.workspace,
        )
        self.assertEqual(code, 0)
        manifest_relative = Path(manifest["manifest_path"])

        packet, review_code = build_review_packet(
            "designs/toggle_switch.proto",
            manifest_path=manifest_relative,
            workspace_root=self.workspace,
        )

        self.assertEqual(review_code, 0)
        self.assertEqual(packet["connector_registry_sha256"], manifest["connector_registry_sha256"])
        self.assertIn(packet["markdown_path"], packet["artifacts"])
        self.assertIn(TOY_LIBRARY_ACTION, packet["next_actions"])
        self.assertNotIn(str(self.workspace), json.dumps(packet))
        result = verify_provenance(
            self.workspace / packet["provenance_path"],
            workspace_root=self.workspace,
            build_root="build",
        )
        self.assertTrue(result["ok"], result["mismatches"])

    def test_review_does_not_label_governed_materialized_parts_as_toy(self) -> None:
        records = [
            _governed_part_record("igem:review-promoter", "promoter", "TTGACATATAAT"),
            _governed_part_record("igem:review-rbs", "rbs", "AAAGAGGAGAAA"),
            _governed_part_record("igem:review-cds", "cds", "ATGGCTGCTGCTTAA"),
            _governed_part_record("igem:review-terminator", "terminator", "CCGCTTAAAGCGG"),
        ]
        materials_root = tempfile.TemporaryDirectory(prefix="proto-governed-materials-")
        self.addCleanup(materials_root.cleanup)
        store = MaterialsStore(workspace=self.workspace, root=materials_root.name)
        snapshot = store._create_snapshot(
            records,
            "reviewed-fixture-snapshot",
            sources=[{"provider": "iGEM Registry", "release": "2026-09"}],
            label="review test",
            promotion_attestations=_promotion_attestations(records),
        )
        materialized = store.materialize_parts(
            [str(record["resource_id"]) for record in records],
            "ecoli_k12",
            snapshot_id=snapshot["snapshot_id"],
        )

        design_path = self.workspace / "designs" / "governed_review.proto"
        design_path.write_text(
            "\n".join(
                (
                    "design governed_review chassis ecoli_k12",
                    "",
                    "construct governed_module:",
                    "  promoter igem:review-promoter",
                    "  rbs igem:review-rbs",
                    "  cds igem:review-cds",
                    "  terminator igem:review-terminator",
                    "",
                )
            ),
            encoding="utf-8",
        )
        parts_path = Path(materialized["parts_path"])
        manifest, workflow_code = run_design_review(
            design_path.relative_to(self.workspace),
            parts_path=parts_path,
            workspace_root=self.workspace,
        )
        self.assertEqual(workflow_code, 0)

        with mock.patch.dict(os.environ, {"PROTO_AGENT_MATERIALS_ROOT": materials_root.name}):
            packet, review_code = build_review_packet(
                design_path.relative_to(self.workspace),
                parts_path=parts_path,
                manifest_path=Path(manifest["manifest_path"]),
                workspace_root=self.workspace,
            )

        self.assertEqual(review_code, 0)
        self.assertNotIn(TOY_LIBRARY_ACTION, packet["next_actions"])
        self.assertIn(
            "Review human-review evidence cards before using outputs in any scientific decision.",
            packet["next_actions"],
        )

        parts_source = self.workspace / parts_path
        library = json.loads(parts_source.read_text(encoding="utf-8"))
        tampered = json.loads(json.dumps(library))
        tampered["parts"][0]["source"]["content_sha256"] = "0" * 64
        tampered_bytes = json.dumps(tampered, sort_keys=True, separators=(",", ":")).encode("utf-8")
        forged_snapshot = json.loads(json.dumps(library))
        forged_snapshot["version"] = "attacker-selected-snapshot"
        selection_receipt = json.dumps(
            {
                "snapshot_id": forged_snapshot["version"],
                "chassis": forged_snapshot["chassis"],
                "ids": [part["resource_id"] for part in forged_snapshot["parts"]],
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        forged_snapshot["library_id"] = f"selection:{hashlib.sha256(selection_receipt).hexdigest()}"
        forged_snapshot_bytes = json.dumps(
            forged_snapshot,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        with mock.patch.dict(os.environ, {"PROTO_AGENT_MATERIALS_ROOT": materials_root.name}):
            self.assertFalse(
                review_module._is_governed_materialized_parts_library(
                    tampered_bytes,
                    workspace=self.workspace,
                )
            )
            self.assertFalse(
                review_module._is_governed_materialized_parts_library(
                    forged_snapshot_bytes,
                    workspace=self.workspace,
                )
            )
        with mock.patch.dict(
            os.environ,
            {"PROTO_AGENT_MATERIALS_ROOT": str(self.workspace / "missing-materials-root")},
        ):
            self.assertFalse(
                review_module._is_governed_materialized_parts_library(
                    parts_source.read_bytes(),
                    workspace=self.workspace,
                )
            )

    def test_review_rejects_connector_registry_changed_after_workflow(self) -> None:
        manifest, code = run_design_review(
            "designs/toggle_switch.proto",
            workspace_root=self.workspace,
        )
        self.assertEqual(code, 0)
        registry_path = self.workspace / "connectors" / "proto_workbench.json"
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
        registry["description"] = "changed after the workflow was attested"
        registry_path.write_text(json.dumps(registry), encoding="utf-8")

        with self.assertRaisesRegex(ProvenanceError, "connector registry changed"):
            build_review_packet(
                "designs/toggle_switch.proto",
                manifest_path=Path(manifest["manifest_path"]),
                workspace_root=self.workspace,
            )

    def test_review_rejects_manifest_changed_after_attestation(self) -> None:
        manifest, code = run_design_review(
            "designs/toggle_switch.proto",
            workspace_root=self.workspace,
        )
        self.assertEqual(code, 0)
        manifest_path = self.workspace / manifest["manifest_path"]
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        payload["summary"] = "tampered"
        manifest_path.write_text(json.dumps(payload), encoding="utf-8")

        with self.assertRaises(ProvenanceError):
            build_review_packet(
                "designs/toggle_switch.proto",
                manifest_path=manifest_path.relative_to(self.workspace),
                workspace_root=self.workspace,
            )

    def test_review_rechecks_workflow_after_assembling_evidence(self) -> None:
        manifest, code = run_design_review(
            "designs/toggle_switch.proto",
            workspace_root=self.workspace,
        )
        self.assertEqual(code, 0)
        manifest_path = self.workspace / manifest["manifest_path"]
        original_builder = review_module.build_evidence_cards

        def mutate_after_first_verification(*args: object, **kwargs: object) -> dict[str, object]:
            result = original_builder(*args, **kwargs)
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))
            payload["summary"] = "changed during review"
            manifest_path.write_text(json.dumps(payload), encoding="utf-8")
            return result

        with (
            mock.patch.object(
                review_module,
                "build_evidence_cards",
                side_effect=mutate_after_first_verification,
            ),
            self.assertRaises(ProvenanceError),
        ):
            build_review_packet(
                "designs/toggle_switch.proto",
                manifest_path=Path(manifest["manifest_path"]),
                workspace_root=self.workspace,
            )

    def test_review_rejects_manifest_for_a_different_design(self) -> None:
        manifest, code = run_design_review(
            "designs/toggle_switch.proto",
            workspace_root=self.workspace,
        )
        self.assertEqual(code, 0)
        different = self.workspace / "designs" / "different.proto"
        different.write_text(
            (self.workspace / "designs" / "toggle_switch.proto").read_text(encoding="utf-8"),
            encoding="utf-8",
        )

        with self.assertRaisesRegex(ValueError, "do not match the requested"):
            build_review_packet(
                "designs/different.proto",
                manifest_path=Path(manifest["manifest_path"]),
                workspace_root=self.workspace,
            )

    def test_review_rejects_self_attested_invalid_manifest_schema(self) -> None:
        manifest, code = run_design_review(
            "designs/toggle_switch.proto",
            workspace_root=self.workspace,
        )
        self.assertEqual(code, 0)
        manifest_path = self.workspace / manifest["manifest_path"]
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        payload["schema_version"] = "attacker.schema"
        payload["ok"] = "truthy"
        manifest_path.write_text(json.dumps(payload), encoding="utf-8")
        create_provenance(
            manifest_path,
            workspace_root=self.workspace,
            build_root="build",
            output_path=self.workspace / manifest["provenance_path"],
        )

        with self.assertRaisesRegex(ValueError, "schema_version"):
            build_review_packet(
                "designs/toggle_switch.proto",
                manifest_path=Path(manifest["manifest_path"]),
                workspace_root=self.workspace,
            )


if __name__ == "__main__":
    unittest.main()
