"""Scientific identity and correspondence regressions for structural calculations."""
from __future__ import annotations

import io
import re
import unittest

from proto_agent.compute_structures import TOOLS, analyze_protein_phylogeny, compare_protein_structures


def atom(serial, number, residue="ALA", xyz=(0, 0, 0), chain="A", insertion="", altloc="", occupancy=1.0):
    x, y, z = xyz
    return (f"ATOM  {serial:5d}  CA {altloc or ' '}{residue:3s} {chain or ' '}{number:4d}{insertion or ' '}   "
            f"{x:8.3f}{y:8.3f}{z:8.3f}{occupancy:6.2f}  0.00           C")


NAMES = ["ALA", "CYS", "ASP", "GLU", "PHE", "GLY"]
POINTS = [(0, 0, 0), (2, 0, 0), (2, 3, 0), (0, 3, 1), (1, 2, 4), (4, 3, 2)]


def pdb(names=NAMES, offset=0, chain="A", transform=False):
    rows = []
    for index, name in enumerate(names):
        x, y, z = POINTS[index]
        xyz = (-y + 11, x - 7, z + 4) if transform else (x, y, z)
        rows.append(atom(index + 1, index + 1 + offset, name, xyz, chain))
    return ("\n".join(rows) + "\n").encode()


def compare(a, b=None, **arguments):
    return compare_protein_structures(arguments, {"structure_a_path": a, "structure_b_path": a if b is None else b})


class ProteinComparisonTests(unittest.TestCase):
    def test_sequence_mapping_preserves_renumbered_rigid_transform(self):
        result = compare(pdb(), pdb(offset=100, chain="B", transform=True))
        self.assertLess(result["ca_rmsd_a"], 1e-6)
        self.assertEqual((result["chain_a"], result["chain_b"]), ("A", "B"))
        self.assertEqual(result["per_residue"][0]["residue_b"]["residue_number"], 101)
        self.assertEqual(result["mapping"]["sequence_identity"], 1)
        self.assertEqual(result["mapping"]["coverage_a"], 1)

    def test_multiple_chains_never_merge_without_selection(self):
        raw = pdb(names=NAMES[:2]) + pdb(names=NAMES[2:4], offset=2, chain="B")
        with self.assertRaisesRegex(ValueError, "multiple chains.*chain_a"):
            compare(raw)
        raw = pdb() + pdb(offset=100, chain="B")
        result = compare(raw, chain_a="B", chain_b="A")
        self.assertEqual((result["chain_a"], result["chain_b"], result["common_residues"]), ("B", "A", 6))

    def test_insertion_codes_preserved_in_both_correspondence_modes(self):
        raw = ("\n".join(atom(i + 1, number, NAMES[i], POINTS[i], insertion=icode)
                          for i, (number, icode) in enumerate([(1, ""), (2, ""), (2, "A"), (3, "")])) + "\n").encode()
        for mode in ("sequence", "residue_id"):
            with self.subTest(mode=mode):
                result = compare(raw, correspondence=mode)
                self.assertEqual(result["common_residues"], 4)
                self.assertEqual(result["per_residue"][2]["residue_a"]["insertion_code"], "A")

    def test_first_model_uses_declared_order_and_explicit_serial(self):
        raw = b"MODEL        7\n" + pdb(names=NAMES[:3]) + b"ENDMDL\nMODEL        2\n" + pdb() + b"ENDMDL\nEND\n"
        self.assertEqual((compare(raw)["model_a"], compare(raw)["common_residues"]), (7, 3))
        self.assertEqual(compare(raw, model_a=2, model_b=2)["common_residues"], 6)
        with self.assertRaisesRegex(ValueError, "available MODEL serials"):
            compare(raw, model_a=1)

    def test_empty_first_model_is_not_silently_replaced(self):
        raw = b"MODEL        7\nENDMDL\nMODEL        2\n" + pdb() + b"ENDMDL\n"
        with self.assertRaisesRegex(ValueError, "selected model 7 has no polymer CA"):
            compare(raw)
        self.assertEqual(compare(raw, model_a=2, model_b=2)["common_residues"], 6)

    def test_missing_coordinates_report_partial_observed_coverage(self):
        reference = pdb()
        # Remove one observed CA; residue IDs differ but sequence anchors are unique.
        mobile = b"\n".join(pdb(offset=100).splitlines()[i] for i in [0, 1, 3, 4, 5]) + b"\n"
        result = compare(reference, mobile)
        self.assertEqual(result["common_residues"], 5)
        self.assertAlmostEqual(result["mapping"]["coverage_a"], 5 / 6)
        self.assertEqual(result["mapping"]["coverage_b"], 1)
        self.assertLess(result["ca_rmsd_a"], 1e-6)

    def test_unknown_residues_do_not_inflate_identity_or_fit(self):
        raw = pdb(names=["ALA", "CYS", "UNK", "GLU", "PHE", "GLY"])
        result = compare(raw)
        self.assertEqual(result["common_residues"], 5)
        self.assertEqual(result["mapping"]["excluded_unknown_pairs"], 1)
        self.assertEqual(result["mapping"]["structure_a"]["unknown_residues"], 1)
        with self.assertRaisesRegex(ValueError, "Fewer than three mapped CA"):
            compare(pdb(names=["ALA", "CYS", "UNK"]))

    def test_repeat_alignment_ambiguity_is_refused(self):
        with self.assertRaisesRegex(ValueError, "multiple optimal global alignments"):
            compare(pdb(names=["ALA"] * 4), pdb(names=["ALA"] * 3))

    def test_blank_chain_and_missing_chain_are_distinct(self):
        raw = pdb(chain="") + pdb(chain="A")
        result = compare(raw, chain_a="", chain_b=" ")
        self.assertEqual(result["chain_a"], "")
        with self.assertRaisesRegex(ValueError, "absent from model"):
            compare(pdb(), chain_a="B")

    def test_altloc_occupancy_is_selected_and_recorded(self):
        raw = pdb(names=NAMES[:3]) + (atom(4, 4, "GLU", POINTS[3], altloc="B", occupancy=0.7) + "\n"
                                     + atom(5, 4, "GLU", (99, 99, 99), altloc="A", occupancy=0.3) + "\n").encode()
        result = compare(raw)
        self.assertEqual(result["per_residue"][3]["residue_a"]["alternate_location"], "B")

    def test_duplicate_identity_and_nonfinite_coordinates_refused(self):
        with self.assertRaisesRegex(ValueError, "duplicate CA identity"):
            compare(pdb() + pdb())
        raw = pdb().replace(b"   0.000", b"     nan", 1)
        with self.assertRaisesRegex(ValueError, "finite and bounded"):
            compare(raw)

    def test_identity_threshold_refuses_unrelated_numbering(self):
        with self.assertRaisesRegex(ValueError, "below minimum_sequence_identity"):
            compare(pdb(), pdb(names=["TYR"] * 6), correspondence="residue_id")

    def test_new_arguments_validate_catalog_schema(self):
        import jsonschema
        jsonschema.validate({"structure_a_path": "a.pdb", "structure_b_path": "b.pdb", "chain_a": "",
                             "model_b": 2, "correspondence": "residue_id", "minimum_sequence_identity": 0.8},
                            TOOLS["compare_protein_structures"]["input_schema"])


class ProteinPhylogenyTests(unittest.TestCase):
    def test_all_named_tips_survive_six_sequence_tree(self):
        sequences = ["AAAAAAAAAA", "CAAAAAAAAA", "AACCCCCAAA", "AACCCCCCCA", "DDCCCCCCCA", "DDDCCCCCCA"]
        names = ["plain", "with space", "quote'quoted", "semi;colon", "parens(x)", "comma,label"]
        result = analyze_protein_phylogeny({"aligned_sequences": [dict(name=name, sequence=seq) for name, seq in zip(names, sequences)]})
        labels = re.findall(r"'((?:[^']|'')*)'", result["newick_tree"])
        self.assertCountEqual([label.replace("''", "'") for label in labels], names)
        self.assertEqual(len(labels), len(names))
        self.assertEqual(result["negative_branch_length_policy"], "clamp_to_zero_and_report")
        graph = result["tree_graph"]
        self.assertEqual(len(graph["nodes"]), 2 * len(names) - 2)
        self.assertEqual(len(graph["edges"]), len(graph["nodes"]) - 1)
        degrees = {node["id"]: 0 for node in graph["nodes"]}
        for edge in graph["edges"]:
            self.assertGreaterEqual(edge["length"], 0)
            degrees[edge["source"]] += 1
            degrees[edge["target"]] += 1
        for node in graph["nodes"]:
            self.assertEqual(degrees[node["id"]], 1 if node["name"] is not None else 3)
        for correction in result["negative_branch_lengths"]:
            self.assertLess(correction["raw_length"], 0)
            edge = next(edge for edge in graph["edges"] if edge["source"] == correction["source_node"] and edge["target"] == correction["target_node"])
            self.assertEqual(edge["length"], 0)

    def test_distances_match_biopython_neighbor_joining(self):
        from Bio import Phylo
        from Bio.Phylo.TreeConstruction import DistanceMatrix, DistanceTreeConstructor
        names = ["a", "b", "c", "d", "e"]
        seqs = ["AAAAAAAAAA", "CAAAAAAAAA", "AACCCCCAAA", "AACCCCCCCA", "DDCCCCCCCA"]
        matrix = [[sum(a != b for a, b in zip(seqs[i], seqs[j])) / 10 if i != j else 0
                   for j in range(i + 1)] for i in range(len(names))]
        expected = DistanceTreeConstructor().nj(DistanceMatrix(names, matrix))
        for clade in expected.find_clades():
            if clade.branch_length is not None:
                clade.branch_length = max(0, clade.branch_length)
        result = analyze_protein_phylogeny({"aligned_sequences": [dict(name=name, sequence=seq) for name, seq in zip(names, seqs)]})
        actual = Phylo.read(io.StringIO(result["newick_tree"]), "newick")
        self.assertCountEqual([tip.name for tip in actual.get_terminals()], names)
        for i, a in enumerate(names):
            for b in names[i + 1:]:
                self.assertAlmostEqual(actual.distance(a, b), expected.distance(a, b), places=8)

    def test_labels_and_alignment_characters_are_validated(self):
        base = [{"name": name, "sequence": "ACDEFGHIKL"} for name in ["a", "b", "c"]]
        for bad in ([base[0], base[0], base[2]], [base[0], base[1], {"name": "c", "sequence": "ACDE!GHIKL"}]):
            with self.assertRaises(ValueError):
                analyze_protein_phylogeny({"aligned_sequences": bad})

    def test_unknown_matches_are_not_sequence_identity_evidence(self):
        result = analyze_protein_phylogeny({"aligned_sequences": [{"name": name, "sequence": "ACDEXXXXX-"} for name in ["a", "b", "c"]]})
        self.assertEqual(result["most_similar_pairs"][0]["identity"], 0.4)


if __name__ == "__main__":
    unittest.main()
