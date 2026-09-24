import copy
import unittest
from proto_agent.artifact_readers import require_current_artifact, select_artifact_reader
from proto_agent.review import _validate_manifest


class ArtifactReaderTests(unittest.TestCase):
    def test_versions_retain_active_ir_and_legacy_protein_distinction(self):
        self.assertEqual(select_artifact_reader("ir", {"schema_version": "proto-agent.ir.v1"})["status"], "current")
        self.assertEqual(select_artifact_reader("protein-selection", {"schema_version": "proto-agent.protein-selection.v1"})["status"], "legacy-readonly")
        with self.assertRaisesRegex(ValueError, "LEGACY_READ_ONLY"):
            require_current_artifact("protein-selection", {"schema_version": "proto-agent.protein-selection.v1"})

    def test_future_workflow_manifest_is_rejected_without_mutation(self):
        manifest = {"schema_version": "proto-agent.run.v2", "ok": True, "run_id": "fixture-future-version"}
        original = copy.deepcopy(manifest)
        with self.assertRaisesRegex(ValueError, "UNSUPPORTED_VERSION"):
            _validate_manifest(manifest)
        self.assertEqual(manifest, original)
