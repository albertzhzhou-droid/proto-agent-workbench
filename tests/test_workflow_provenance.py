from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from proto_agent.provenance import ProvenanceError, create_provenance, verify_provenance
from proto_agent import review as review_module
from proto_agent.review import build_review_packet
from proto_agent import workflow as workflow_module
from proto_agent.workflow import run_design_review


ROOT = Path(__file__).resolve().parents[1]


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
        self.assertNotIn(str(self.workspace), json.dumps(packet))
        result = verify_provenance(
            self.workspace / packet["provenance_path"],
            workspace_root=self.workspace,
            build_root="build",
        )
        self.assertTrue(result["ok"], result["mismatches"])

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
