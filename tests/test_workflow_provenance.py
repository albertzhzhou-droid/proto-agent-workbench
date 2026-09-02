from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from proto_agent.provenance import ProvenanceError, create_provenance, verify_provenance
from proto_agent import review as review_module
from proto_agent.review import build_review_packet
from proto_agent.workflow import run_design_review


ROOT = Path(__file__).resolve().parents[1]


class WorkflowProvenanceTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory(prefix="proto-workflow-test-")
        self.workspace = Path(self._temporary.name).resolve()
        for name in ("designs", "parts", "workflows", "literature"):
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
        self.assertIn(packet["markdown_path"], packet["artifacts"])
        self.assertNotIn(str(self.workspace), json.dumps(packet))
        result = verify_provenance(
            self.workspace / packet["provenance_path"],
            workspace_root=self.workspace,
            build_root="build",
        )
        self.assertTrue(result["ok"], result["mismatches"])

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
