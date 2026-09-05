"""DNA edit/placement software checks. All small hand-written sequences are toy fixtures."""
import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from proto_agent.compiler import compile_design_text
from proto_agent.design_edits import prepare_design_edit
from proto_agent.dna_placement import reverse_complement
from proto_agent.exporters import export_ir, validate_ir_for_export
from proto_agent.parser import parse_design_text
from proto_agent.provenance import ProvenanceError
from proto_agent.review import _verify_dna_v2_artifact_binding
from proto_agent.security import WorkspacePaths

ROOT = Path(__file__).resolve().parents[1]
TOY_PARTS = ROOT / "parts/ecoli_k12_library.json"
SOURCE = (
    "# Toy development fixture; no biological validation.\n"
    "design placements_toy chassis ecoli_k12\n"
    "construct unit:\n"
    "  topology circular\n"
    "  # promoter occurrence comment\n"
    "  promoter pLac instance=p1 # local comment\n"
    "  rbs B0034 instance=r1\n"
    "  cds tetR instance=c1\n"
    "  terminator B0015 instance=t1\n"
)


def sha(value):
    return hashlib.sha256(value.encode("ascii")).hexdigest()


def note(instance="c1", start=1, end=5, direction=0):
    return {"id": "note_01", "name": "Review region", "type": "misc_feature", "anchors": [{"instance_id": instance, "start": start, "end": end, "direction": direction}], "origin": "user"}


class DnaPlacementTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="proto-dna-placement-")
        self.addCleanup(self.temporary.cleanup)
        self.workspace = Path(self.temporary.name)

    def compile(self, source=SOURCE, library=TOY_PARTS):
        ir, diagnostics = compile_design_text(source, library)
        self.assertIsNotNone(ir, [item.to_dict() for item in diagnostics])
        self.assertFalse(any(item.severity == "error" for item in diagnostics))
        return ir

    def edit(self, commands, source=SOURCE, library=TOY_PARTS, **kwargs):
        return prepare_design_edit(source, commands, parts_path=library, **kwargs)

    def test_legacy_ir_and_forward_grammar_are_unchanged(self):
        legacy = SOURCE.replace(" instance=p1", "").replace(" instance=r1", "").replace(" instance=c1", "").replace(" instance=t1", "")
        ir = self.compile(legacy)
        self.assertEqual(ir["schema_version"], "proto-agent.ir.v1")
        self.assertNotIn("placement", ir["constructs"][0]["parts"][0])
        invalid, diagnostics = compile_design_text(legacy.replace("promoter pLac", "terminator B0015"), TOY_PARTS)
        self.assertIsNone(invalid)
        self.assertIn("CONSTRUCT_MUST_START_WITH_PROMOTER", {item.code for item in diagnostics})

    def test_iupac_reverse_complement_is_involutive(self):
        self.assertEqual(reverse_complement("ACGTRYSWKMBDHVN"), "NBDHVKMWSRYACGT")
        self.assertEqual(reverse_complement(reverse_complement("ACGTRYSWKMBDHVN")), "ACGTRYSWKMBDHVN")
        for invalid in ("", "acgt", "AXT", "ACU"):
            with self.subTest(sequence=invalid), self.assertRaises(ValueError):
                reverse_complement(invalid)

    def test_legacy_renderer_annotation_metadata_keeps_legacy_export_behavior(self):
        legacy = SOURCE.replace(" instance=p1", "").replace(" instance=r1", "").replace(" instance=c1", "").replace(" instance=t1", "")
        ir = self.compile(legacy)
        before = {format: export_ir(ir, format) for format in ("fasta", "genbank", "sbol")}
        ir["constructs"][0]["annotations"] = [{"id": "display_note", "start": 1, "stop": 5, "type": "misc_feature"}]
        self.assertEqual({format: export_ir(ir, format) for format in before}, before)

    def test_reverse_is_placement_not_invented_biological_direction(self):
        ir = self.compile(SOURCE.replace("instance=c1", "instance=c1 orientation=reverse"))
        part = ir["constructs"][0]["parts"][2]
        self.assertEqual(part["sequence"], reverse_complement("ATGGCTGCTGCTTAA"))
        self.assertEqual(part["source_sequence_sha256"], sha("ATGGCTGCTGCTTAA"))
        self.assertEqual(part["direction"], 0)
        self.assertEqual(part["source_direction"], 0)
        self.assertEqual(part["placement"], {"orientation": "reverse", "transform": "reverse_complement", "algorithm": "iupac-dna.v1"})

    def test_occurrence_identity_is_distinct_from_repeated_part_id(self):
        source = SOURCE.replace("  terminator B0015", "  cds tetR instance=c2\n  terminator B0015")
        result = self.edit([{"type": "reorder_occurrences", "construct": "unit", "instance_ids": ["t1", "c2", "r1", "c1", "p1"]}], source=source)
        self.assertTrue(result["ok"], result)
        parts = self.compile(result["candidate_source"])["constructs"][0]["parts"]
        self.assertEqual([part["instance_id"] for part in parts], ["t1", "c2", "r1", "c1", "p1"])
        self.assertEqual(sum(part["id"] == "tetR" for part in parts), 2)
        self.assertIn("# promoter occurrence comment\n  promoter pLac instance=p1 # local comment", result["candidate_source"])

    def test_annotation_source_anchor_moves_and_reverse_transforms(self):
        annotation = note(direction=1)
        result = self.edit([
            {"type": "upsert_annotation", "construct": "unit", "annotation": annotation},
            {"type": "reorder_occurrences", "construct": "unit", "instance_ids": ["c1", "p1", "r1", "t1"]},
            {"type": "set_orientation", "construct": "unit", "instance_id": "c1", "orientation": "reverse"},
        ])
        self.assertTrue(result["ok"], result)
        construct = self.compile(result["candidate_source"])["constructs"][0]
        self.assertEqual(construct["annotations"][0]["anchors"], annotation["anchors"])
        self.assertEqual(construct["annotations"][0]["locations"], [{"instance_id": "c1", "start": 10, "end": 14, "direction": -1}])
        self.assertEqual(construct["parts"][0]["direction"], 0)
        self.assertIn("join", export_ir(self.compile(self._origin_annotation_source()), "genbank"))

    def _origin_annotation_source(self):
        annotation = note("t1", 1, 4, 0)
        annotation["anchors"].append({"instance_id": "p1", "start": 0, "end": 2, "direction": 0})
        identifier = annotation.pop("id")
        return SOURCE + f"  annotation {identifier} {json.dumps(annotation)}\n"

    def test_annotation_origin_span_keeps_declared_anchor_order(self):
        annotation = self.compile(self._origin_annotation_source())["constructs"][0]["annotations"][0]
        self.assertGreater(annotation["locations"][0]["start"], annotation["locations"][1]["start"])
        self.assertEqual([item["direction"] for item in annotation["locations"]], [0, 0])

    def test_annotation_overlapping_source_spans_are_rejected(self):
        annotation = note(start=1, end=8)
        annotation["anchors"].append({"instance_id": "c1", "start": 5, "end": 10, "direction": 0})
        result = self.edit([{"type": "upsert_annotation", "construct": "unit", "annotation": annotation}])
        self.assertFalse(result["ok"])
        self.assertTrue(any(item["severity"] == "error" for item in result["diagnostics"]))

    def test_provenance_hashes_exact_crlf_source_and_library_bytes(self):
        source = SOURCE.replace("\n", "\r\n")
        ir = self.compile(source)
        self.assertEqual(ir["provenance"]["source_sha256"], hashlib.sha256(source.encode("utf-8")).hexdigest())
        self.assertEqual(ir["provenance"]["parts_sha256"], hashlib.sha256(TOY_PARTS.read_bytes()).hexdigest())
        self.assertEqual(ir["provenance"]["parts_source"], str(TOY_PARTS))

    def test_invalid_annotations_and_placement_options_fail_closed(self):
        bad_sources = [
            SOURCE.replace("instance=c1", "instance=p1"),
            SOURCE.replace("instance=c1", "instance=c1 orientation=sideways"),
            SOURCE.replace("instance=c1", "instance=c1 instance=c2"),
        ]
        for annotation in (note("absent"), note(end=500), {**note(), "origin": "reviewed_source"}):
            identifier = annotation.pop("id")
            bad_sources.append(SOURCE + f"  annotation {identifier} {json.dumps(annotation)}\n")
        for source in bad_sources:
            with self.subTest(source=source[-100:]):
                ir, diagnostics = compile_design_text(source, TOY_PARTS)
                self.assertIsNone(ir)
                self.assertTrue(any(item.severity == "error" for item in diagnostics))

    def test_explicit_source_direction_transforms_but_unknown_does_not(self):
        library = json.loads(TOY_PARTS.read_text())
        next(part for part in library["parts"] if part["id"] == "tetR")["direction"] = 1
        path = self.workspace / "toy.json"
        path.write_text(json.dumps(library))
        part = self.compile(SOURCE.replace("instance=c1", "instance=c1 orientation=reverse"), path)["constructs"][0]["parts"][2]
        self.assertEqual((part["source_direction"], part["direction"]), (1, -1))

    def test_export_rejects_hash_transform_geometry_and_annotation_tampering(self):
        result = self.edit([{"type": "upsert_annotation", "construct": "unit", "annotation": note()}])
        original = self.compile(result["candidate_source"])
        mutations = [
            lambda value: value["constructs"][0]["parts"][2].update(source_sequence_sha256="0" * 64),
            lambda value: value["constructs"][0]["parts"][2]["placement"].update(orientation="reverse"),
            lambda value: value["constructs"][0]["parts"][2].update(start=1),
            lambda value: value["constructs"][0]["parts"][2].update(direction=-1),
            lambda value: value["constructs"][0]["annotations"][0]["locations"][0].update(end=100),
            lambda value: value.update(schema_version="proto-agent.ir.v1"),
        ]
        for mutate in mutations:
            ir = copy.deepcopy(original)
            mutate(ir)
            with self.assertRaises(ValueError):
                export_ir(ir, "fasta")

    def test_candidate_and_diff_do_not_write_and_stale_source_requires_rebase(self):
        command = {"type": "set_orientation", "construct": "unit", "instance_id": "c1", "orientation": "reverse"}
        stale = self.edit([command], expected_source_sha256="0" * 64)
        self.assertFalse(stale["ok"])
        self.assertEqual(stale["candidate_source"], SOURCE)
        self.assertEqual(stale["diagnostics"][0]["code"], "DNA_EDIT_REBASE_REQUIRED")
        result = self.edit([command], source=SOURCE.replace("\n", "\r\n"))
        self.assertTrue(result["ok"], result)
        self.assertIn("orientation=reverse", result["unified_diff"])
        self.assertEqual(result["candidate_source"].count("\r\n"), SOURCE.count("\n"))
        self.assertEqual(list(self.workspace.iterdir()), [])

    def test_stale_library_digest_requires_rebase(self):
        result = self.edit([{"type": "set_orientation", "construct": "unit", "instance_id": "c1", "orientation": "reverse"}], expected_parts_sha256="0" * 64)
        self.assertEqual(result["diagnostics"][0]["code"], "DNA_EDIT_REBASE_REQUIRED")

    def test_legacy_edit_persists_stable_occurrence_ids(self):
        legacy = SOURCE.replace(" instance=p1", "").replace(" instance=r1", "").replace(" instance=c1", "").replace(" instance=t1", "")
        result = self.edit([{"type": "reorder_occurrences", "construct": "unit", "instance_ids": ["occurrence_0003", "occurrence_0001", "occurrence_0002", "occurrence_0004"]}], source=legacy)
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.compile(result["candidate_source"])["constructs"][0]["parts"][0]["instance_id"], "occurrence_0003")
        self.assertIn("# local comment", result["candidate_source"])

    def test_wrong_resource_ids_missing_and_duplicate_occurrences_are_rejected(self):
        for ids in (["pLac", "B0034", "tetR", "B0015"], ["p1", "r1", "c1", "c1"], ["p1"]):
            result = self.edit([{"type": "reorder_occurrences", "construct": "unit", "instance_ids": ids}])
            self.assertFalse(result["ok"])

    def test_upsert_delete_annotation_preserves_other_source(self):
        result = self.edit([{"type": "upsert_annotation", "construct": "unit", "annotation": note()}, {"type": "delete_annotation", "construct": "unit", "annotation_id": "note_01"}])
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["candidate_source"], SOURCE)
        self.assertEqual(result["unified_diff"], "")

    def test_governed_existing_record_preserves_source_hash_on_reverse(self):
        # Retrieve a real ID from the checked-in reviewed catalog, never invent it.
        reviewed = json.loads((ROOT / "materials/reviewed/igem_design_eligible_2026-09.json").read_text(encoding="utf-8"))["records"]
        record = next(item for item in reviewed if item["part_type"] == "cds")
        part = {"id": record["resource_id"], "type": record["part_type"], "name": record["name"], **{field: record[field] for field in ("resource_id", "sequence", "sequence_sha256", "source", "license", "sequence_kind", "review_status", "safety_status", "design_eligibility", "evidence_refs")}, "safety_flags": []}
        library = self.workspace / "reviewed-selection.json"
        library.write_text(json.dumps({"chassis": "ecoli_k12", "notice": "Test projection of an existing reviewed record; not a catalog activation.", "parts": [part]}))
        source = f"design reviewed_reverse chassis ecoli_k12\nconstruct unit:\n  cds {part['id']} instance=slot_01 orientation=reverse\n"
        ir = self.compile(source, library)
        compiled = ir["constructs"][0]["parts"][0]
        self.assertEqual(compiled["source"], part["source"])
        self.assertEqual(compiled["source_sequence_sha256"], part["source"]["sequence_sha256"])
        self.assertEqual(validate_ir_for_export(ir), "dna")
        self.assertIn(reverse_complement(part["sequence"]), export_ir(ir, "fasta"))
        wrong, diagnostics = compile_design_text(source, TOY_PARTS)
        self.assertIsNone(wrong)
        self.assertIn("UNKNOWN_PART", {item.code for item in diagnostics})

    def test_sbol_export_retains_source_component_and_placement(self):
        ir = self.compile(SOURCE.replace("instance=c1", "instance=c1 orientation=reverse"))
        text = export_ir(ir, "sbol")
        self.assertIn('sbol:elements "ATGGCTGCTGCTTAA"', text)
        self.assertIn("sbol:orientation sbol:reverseComplement", text)
        self.assertIn("biological_direction=0", text)

    def test_review_recomputes_source_binding_beyond_self_consistent_hashes(self):
        library = self.workspace / "parts.json"
        library.write_bytes(TOY_PARTS.read_bytes())
        build = self.workspace / "build"
        build.mkdir()
        path = build / "design.ir.json"
        ir = self.compile()
        path.write_text(json.dumps(ir))
        manifest = {"steps": [{"id": "compile", "ok": True, "artifacts": ["build/design.ir.json"]}], "inputs": {"design": "design.proto"}}
        inputs = {"design": SOURCE.encode(), "parts": library.read_bytes()}
        paths = WorkspacePaths.create(self.workspace)
        _verify_dna_v2_artifact_binding(manifest, inputs, library, paths)
        part = ir["constructs"][0]["parts"][0]
        part["sequence"] = "A" * len(part["sequence"])
        part["sequence_sha256"] = part["source_sequence_sha256"] = sha(part["sequence"])
        construct = ir["constructs"][0]
        construct["sequence"] = "".join(item["sequence"] for item in construct["parts"])
        construct["sequence_sha256"] = sha(construct["sequence"])
        validate_ir_for_export(ir)  # internally consistent, but the wrong source
        path.write_text(json.dumps(ir))
        with self.assertRaises(ProvenanceError):
            _verify_dna_v2_artifact_binding(manifest, inputs, library, paths)


if __name__ == "__main__":
    unittest.main()
