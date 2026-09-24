import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from proto_agent import compute, compute_identity
from proto_agent.scientific_contracts import (
    COORDINATE_SCHEMA,
    MANIFEST_SCHEMA,
    QUANTITY_SCHEMA,
    ScientificContractError,
    convert_quantity,
    coordinate_systems_compatible,
    validate_coordinate_system,
    validate_dataset_manifest,
    validate_quantity,
)


class ScientificContractTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.workspace = Path(self.temporary.name)
        self.data = self.workspace / "data"
        self.data.mkdir()
        self.reference = self.data / "reference.fa"
        self.index = self.data / "reference.fa.fai"
        self.reference.write_bytes(b">chr1\nACGT\n")
        self.index.write_bytes(b"chr1\t4\t6\t4\t5\n")

    def manifest(self):
        reference = self.reference.read_bytes()
        index = self.index.read_bytes()
        return {
            "schema_version": MANIFEST_SCHEMA,
            "dataset_id": "dataset:reference-v1",
            "display_name": "Reference data",
            "files": [
                {"id": "reference", "path": "data/reference.fa", "role": "reference",
                 "sha256": hashlib.sha256(reference).hexdigest(), "bytes": len(reference)},
                {"id": "index", "path": "data/reference.fa.fai", "role": "index", "indexed_file_id": "reference",
                 "sha256": hashlib.sha256(index).hexdigest(), "bytes": len(index)},
            ],
            "entities": [{"id": "sample:S01", "type": "sample", "namespace": "local-study", "identifier": "S01"}],
            "references": [{"id": "assembly:1", "type": "genome-assembly", "file_id": "reference", "identifier": "assembly-1", "version": "1"}],
            "quantities": [
                {"schema_version": QUANTITY_SCHEMA, "value": 0, "unit": "count", "quantity_kind": "value", "entity_id": "sample:S01"},
                {"schema_version": QUANTITY_SCHEMA, "value": None, "unit": "mol/L", "quantity_kind": "value",
                 "entity_id": "sample:S01", "missing_reason": "not-measured"},
            ],
            "coordinate_systems": [],
        }

    def write_request_and_manifest(self, manifest=None):
        path = self.data / "dataset.json"
        path.write_text(json.dumps(manifest or self.manifest()), encoding="utf-8")
        request = {"tool": "find_n_glycosylation_motifs", "arguments": {"sequence": "MNATNPTNVS"},
                   "dataset_manifests": ["data/dataset.json"]}
        (self.workspace / "request.json").write_text(json.dumps(request), encoding="utf-8")
        return path

    def test_null_is_not_zero_and_missing_values_require_reason(self):
        observed_zero = validate_quantity({"schema_version": QUANTITY_SCHEMA, "value": 0, "unit": "count", "quantity_kind": "value", "entity_id": "sample:S01"})
        missing = validate_quantity({"schema_version": QUANTITY_SCHEMA, "value": None, "unit": "count", "quantity_kind": "value", "entity_id": "sample:S01", "missing_reason": "not-recorded"})
        self.assertEqual(observed_zero["value"], 0)
        self.assertIsNone(missing["value"])
        with self.assertRaises(ScientificContractError) as caught:
            validate_quantity({"schema_version": QUANTITY_SCHEMA, "value": None, "unit": "count", "quantity_kind": "value", "entity_id": "sample:S01"})
        self.assertEqual(caught.exception.code, "QUANTITY_MISSING_REASON_REQUIRED")

    def test_absolute_temperature_and_temperature_interval_are_distinct(self):
        absolute = convert_quantity(25, "degree_Celsius", "kelvin", "absolute")
        interval = convert_quantity(25, "delta_degree_Celsius", "delta_kelvin", "interval")
        self.assertEqual(absolute["value"], "298.15")
        self.assertEqual(interval["value"], "25")
        with self.assertRaises(ScientificContractError) as caught:
            convert_quantity(25, "degree_Celsius", "delta_kelvin", "absolute")
        self.assertEqual(caught.exception.code, "QUANTITY_INCOMPATIBLE")

    def test_coordinate_frame_and_reference_identity_must_match(self):
        first = {"schema_version": COORDINATE_SCHEMA, "id": "coord-a", "frame": "pdb-auth-residue",
                 "origin": 1, "unit": "residue", "reference_file_id": "structure-a"}
        same = {**first, "id": "coord-b"}
        label = {**first, "id": "coord-c", "frame": "pdb-label-residue"}
        other_reference = {**first, "id": "coord-d", "reference_file_id": "structure-b"}
        self.assertTrue(coordinate_systems_compatible(first, same))
        self.assertFalse(coordinate_systems_compatible(first, label))
        self.assertFalse(coordinate_systems_compatible(first, other_reference))
        with self.assertRaises(ScientificContractError):
            validate_coordinate_system({**first, "origin": 0})

    def test_dataset_contract_checks_entity_and_index_bindings(self):
        manifest = validate_dataset_manifest(self.manifest())
        self.assertEqual(manifest["dataset_id"], "dataset:reference-v1")
        self.assertEqual(manifest["files"][1]["indexed_file_id"], "reference")
        broken = self.manifest()
        broken["files"][1]["indexed_file_id"] = "missing"
        with self.assertRaises(ScientificContractError) as caught:
            validate_dataset_manifest(broken)
        self.assertEqual(caught.exception.code, "DATASET_INDEX_BINDING_INVALID")
        broken = self.manifest()
        broken["quantities"][0]["entity_id"] = "sample:absent"
        with self.assertRaises(ScientificContractError) as caught:
            validate_dataset_manifest(broken)
        self.assertEqual(caught.exception.code, "QUANTITY_ENTITY_UNKNOWN")

    def test_reference_and_index_bytes_are_bound_to_compute_identity(self):
        self.write_request_and_manifest()
        first = compute_identity.compute_fingerprint("request.json", workspace_root=self.workspace)
        self.assertIn("dataset[0].file[0]", {item["field"] for item in first["materials"]["files"]})
        self.assertIn("dataset[0].file[1]", {item["field"] for item in first["materials"]["files"]})

        self.index.write_bytes(b"changed index\n")
        with self.assertRaises(compute.ComputeError) as caught:
            compute_identity.compute_fingerprint("request.json", workspace_root=self.workspace)
        self.assertEqual(caught.exception.code, "COMPUTE_DATASET_IDENTITY_CHANGED")

        second_manifest = self.manifest()
        self.write_request_and_manifest(second_manifest)
        second = compute_identity.compute_fingerprint("request.json", workspace_root=self.workspace)
        self.assertNotEqual(first["fingerprint_sha256"], second["fingerprint_sha256"])

    def test_compute_receipt_carries_dataset_identity(self):
        self.write_request_and_manifest()
        receipt = compute.run_compute("request.json", workspace_root=self.workspace)
        self.assertEqual(receipt["dataset_manifests"][0]["manifest"]["dataset_id"], "dataset:reference-v1")
        stored = json.loads((self.workspace / receipt["manifest_path"]).read_text(encoding="utf-8"))
        self.assertEqual(stored["dataset_manifests"], receipt["dataset_manifests"])
        self.assertTrue(stored["execution_fingerprint"]["verified_unchanged"])


if __name__ == "__main__":
    unittest.main()
