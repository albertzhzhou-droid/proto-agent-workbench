import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from proto_agent.compute import compute_catalog, run_compute, _plain
from proto_agent.compute_protein_study import analyze_protein_comparison, TOOLS


class ProteinStudyTests(unittest.TestCase):
    def example(self):
        return copy.deepcopy(TOOLS["analyze_protein_comparison"]["example"])

    def test_source_coordinates_and_conservation(self):
        study = analyze_protein_comparison(self.example())
        self.assertEqual(study["alignment"][1]["alignment_to_sequence"][:5], [0, 1, None, 2, 3])
        self.assertEqual(study["alignment"][1]["ungapped_sequence"], "ACEFGHIKLMN")
        self.assertAlmostEqual(study["conservation"]["columns"][2]["conservation_fraction"], 2/3)
        self.assertEqual(study["alignment"][1]["sequence_sha256"], hashlib.sha256(b"ACEFGHIKLMN").hexdigest())
        self.assertCountEqual([node["name"] for node in study["phylogeny"]["tree_graph"]["nodes"] if node["name"]], ["example-a", "example-b", "example-c"])

    def test_two_sequences_explicitly_have_no_tree(self):
        request = self.example()
        request["aligned_sequences"].pop()
        self.assertIsNone(analyze_protein_comparison(request)["phylogeny"])

    def test_control_character_names_rejected_with_or_without_tree(self):
        for count in (2, 3):
            for control in ("\x00", "\x1f", "\x7f"):
                with self.subTest(sequence_count=count, control=repr(control)):
                    request = self.example()
                    request["aligned_sequences"] = request["aligned_sequences"][:count]
                    request["aligned_sequences"][0]["name"] = "example" + control + "name"
                    with self.assertRaisesRegex(ValueError, "printable"):
                        analyze_protein_comparison(request)

    def test_invalid_inputs_never_pad_or_infer_identities(self):
        for edit in (lambda rows: rows[1].update(name=rows[0]["name"]),
                     lambda rows: rows[1].update(sequence="ACDEFGHIKLM"),
                     lambda rows: rows[1].update(sequence="ACDEFGHIKLMX"),
                     lambda rows: rows[1].update(sequence="------------")):
            request = self.example()
            edit(request["aligned_sequences"])
            with self.assertRaises(ValueError):
                analyze_protein_comparison(request)

    def test_complete_registry_run_reopens_exact_result(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source = root / "request.json"
            source.write_text(json.dumps({"tool":"analyze_protein_comparison", "arguments":self.example()}), encoding="utf-8")
            receipt = run_compute("request.json", workspace_root=root)
            result_path = root / "build" / "compute" / receipt["run_id"] / "result.json"
            self.assertEqual(hashlib.sha256(result_path.read_bytes()).hexdigest(), receipt["result_sha256"])
            self.assertEqual(json.loads(result_path.read_text(encoding="utf-8"))["sequence_count"], 3)
            self.assertTrue((root / receipt["manifest_path"]).is_file())
            self.assertEqual(compute_catalog("analyze_protein_comparison")["tools"][0]["implementation"], "proto-native")

    def test_plain_basic_values_do_not_need_numpy_import(self):
        from unittest.mock import patch
        original = __import__
        def guard(name, *args, **kwargs):
            if name == "numpy":
                raise AssertionError("A pure JSON value must not import NumPy")
            return original(name, *args, **kwargs)
        with patch("builtins.__import__", side_effect=guard):
            self.assertEqual(_plain({"note":"text", "value":None, "items":[True,3,2.5]}), {"note":"text", "value":None, "items":[True,3,2.5]})


if __name__ == "__main__":
    unittest.main()
