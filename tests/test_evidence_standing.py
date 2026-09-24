from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from proto_agent.evidence_standing import TOY_LIBRARY_NOTICE, evidence_standing, library_data_origin, standing_from_manifest
from proto_agent.provenance import verify_provenance
from proto_agent.review import build_review_packet
from proto_agent.workflow import run_design_review

ROOT = Path(__file__).resolve().parents[1]


class EvidenceStandingTests(unittest.TestCase):
    def test_origin_requires_explicit_fixture_metadata_and_axes_stay_independent(self) -> None:
        self.assertEqual(library_data_origin({"notice": TOY_LIBRARY_NOTICE}), "fixture")
        self.assertEqual(library_data_origin({"path": "parts/ecoli_k12_library.json"}), "unknown")
        self.assertEqual(library_data_origin({"review_status": "DESIGN_ELIGIBLE"}), "unknown")
        for origin in ("fixture", "synthetic", "imported", "governed-snapshot", "unknown"):
            standing = evidence_standing(method_maturity="not-established", data_origin=origin, execution_status="completed")
            self.assertEqual(standing["methodMaturity"], "not-established")
            self.assertEqual(standing["humanReview"], "required")
            self.assertNotIn("eligibility", standing)

    def test_legacy_success_does_not_invent_origin_or_human_review(self) -> None:
        standing = standing_from_manifest({"ok": True})
        self.assertEqual(standing["dataOrigin"], "unknown")
        self.assertEqual(standing["humanReview"], "required")

    def test_fixture_workflow_packet_cards_and_markdown_retain_standing_and_provenance(self) -> None:
        output_root = ROOT / "build" / "test-evidence-standing"
        output_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=output_root) as temporary:
            workspace = Path(temporary).resolve()
            for name in ("designs", "parts", "workflows", "literature", "connectors", ".codex"):
                shutil.copytree(ROOT / name, workspace / name)
            manifest, code = run_design_review("designs/toggle_switch.proto", workspace_root=workspace)
            self.assertEqual(code, 0)
            expected = evidence_standing(method_maturity="not-established", data_origin="fixture", execution_status="completed")
            self.assertEqual(manifest["evidence_standing"], expected)
            packet, code = build_review_packet("designs/toggle_switch.proto", manifest_path=manifest["manifest_path"], workspace_root=workspace)
            self.assertEqual(code, 0)
            self.assertEqual(packet["evidence_standing"], expected)
            saved = json.loads((workspace / packet["packet_path"]).read_text(encoding="utf-8"))
            self.assertEqual(saved["evidence_standing"], expected)
            evidence_path = next(path for path in packet["artifacts"] if path.endswith("evidence.cards.json"))
            evidence = json.loads((workspace / evidence_path).read_text(encoding="utf-8"))
            self.assertEqual(evidence["evidence_standing"], expected)
            for path in (packet["markdown_path"], next(path for path in packet["artifacts"] if path.endswith("human_review_checklist.md"))):
                text = (workspace / path).read_text(encoding="utf-8")
                self.assertIn("dataOrigin: `fixture`", text)
                self.assertIn("humanReview: `required`", text)
            verified = verify_provenance(workspace / packet["provenance_path"], workspace_root=workspace, build_root="build")
            self.assertTrue(verified["ok"], verified["mismatches"])


if __name__ == "__main__":
    unittest.main()
