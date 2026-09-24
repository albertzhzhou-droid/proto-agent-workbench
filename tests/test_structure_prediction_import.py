"""Independent small format fixtures for the local ColabFold result importer."""
from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from proto_agent.compute_structure_prediction import (
    BF_PLDDT_TOLERANCE, HANDLERS, MAX_RESIDUES, SCHEMA_VERSION, TOOLS,
    StructurePredictionImportError, import_colabfold_result,
)
from proto_agent.compute_structures import _comparison_chain, _residue_identity
from proto_agent.security import SecurityBoundaryError, WorkspacePaths, read_bytes_bounded


ARGS = {"structure_path": "build/prediction.pdb", "scores_path": "build/scores.json"}


def atom(serial, number, residue="ALA", chain="A", bfactor=80.0, name="CA", xyz=(1.25, -2.5, 3.75), altloc="", insertion="", occupancy=1.0):
    x, y, z = xyz
    return (f"ATOM  {serial:5d} {name:^4s}{altloc or ' '}{residue:3s} {chain or ' '}{number:4d}{insertion or ' '}   "
            f"{x:8.3f}{y:8.3f}{z:8.3f}{occupancy:6.2f}{bfactor:6.2f}           C")


def pdb(rows=None, model=None):
    if rows is None:
        rows = [atom(1, 1, "ALA", bfactor=90), atom(2, 2, "CYS", bfactor=60), atom(3, 3, "GLY", bfactor=30)]
    lines = ([f"MODEL     {model:4d}"] if model is not None else []) + rows + (["ENDMDL"] if model is not None else []) + ["END"]
    return ("\n".join(lines) + "\n").encode("ascii")


def scores(**overrides):
    data = {"plddt": [90, 60, 30], "pae": [[0.1, 1.2, 2.3], [3.4, 0.2, 4.5], [6.7, 8.9, 0.3]], "max_pae": 8.904, "ptm": 0.62}
    data.update(overrides)
    return json.dumps(data, allow_nan=True).encode()


def run(pdb_raw=None, scores_raw=None, **arguments):
    return import_colabfold_result({**ARGS, **arguments}, {
        "structure_path": pdb() if pdb_raw is None else pdb_raw,
        "scores_path": scores() if scores_raw is None else scores_raw,
    })


class StructurePredictionImportTests(unittest.TestCase):
    def assert_code(self, code, callback):
        with self.assertRaises(StructurePredictionImportError) as caught:
            callback()
        self.assertEqual(caught.exception.code, code, str(caught.exception))

    def test_complete_small_result_preserves_units_confidence_and_exact_raw_hashes(self):
        raw, confidence = pdb(model=7), scores()
        result = run(raw, confidence, expected_chains=[{"chain": "A", "sequence": "acg"}])
        self.assertEqual(result["schema_version"], SCHEMA_VERSION)
        self.assertEqual(result["operation"], "result-import")
        self.assertEqual(result["prediction_execution"], "not-performed")
        self.assertEqual(result["structure"]["coordinate_unit"], "angstrom")
        self.assertEqual(result["structure"]["model"], 7)
        self.assertEqual(result["structure"]["residues"][0]["coordinates_angstrom"], [1.25, -2.5, 3.75])
        self.assertEqual(result["confidence"]["plddt"]["mean"], 60)
        self.assertEqual(result["confidence"]["pae"]["values"][0][2], 2.3)
        self.assertEqual(result["confidence"]["pae"]["values"][2][0], 6.7)  # Not symmetrized.
        for key, data in (("structure_path", raw), ("scores_path", confidence)):
            self.assertEqual(result["sources"][key]["sha256"], hashlib.sha256(data).hexdigest())
            self.assertEqual(result["sources"][key]["size_bytes"], len(data))
        self.assertEqual(result["mapping"]["same_prediction_provenance"], "unestablished")
        self.assertEqual(result["mapping"]["expected_sequence_status"], "exact-match-uppercase-normalized")

    def test_identity_reuses_existing_parser_with_multichain_score_order(self):
        raw = pdb([atom(1, 10, "CYS", chain="B", bfactor=10), atom(2, 11, "GLY", chain="B", bfactor=20),
                   atom(3, 1, "ALA", chain="A", bfactor=30)], model=3)
        result = run(raw, scores(plddt=[10, 20, 30]), expected_chains=[{"chain": "B", "sequence": "CG"}, {"chain": "A", "sequence": "A"}])
        self.assertEqual([row["chain"] for row in result["structure"]["chains"]], ["B", "A"])
        self.assertEqual([(row["start_index"], row["stop_index"]) for row in result["structure"]["chains"]], [(0, 2), (2, 3)])
        expected = _comparison_chain(raw, None, "B", "reference")[0] + _comparison_chain(raw, None, "A", "reference")[0]
        self.assertEqual([row["identity"] for row in result["structure"]["residues"]], [_residue_identity(row) for row in expected])
        self.assertEqual([(row["identity"]["chain"], row["identity"]["residue_number"], row["plddt"]) for row in result["structure"]["residues"]], [("B", 10, 10), ("B", 11, 20), ("A", 1, 30)])

    def test_missing_optional_metrics_stay_unavailable_without_zero_fallback(self):
        result = run(scores_raw=b'{"plddt":[90,60,30]}')
        for key in ("pae", "ptm", "iptm"):
            metric = result["confidence"][key]
            self.assertEqual(metric["status"], "unavailable")
            self.assertIsNone(metric["values" if key == "pae" else "value"])
        self.assertIn("PAE_UNAVAILABLE", {item["code"] for item in result["diagnostics"]})
        self.assert_code("MISSING_PLDDT", lambda: run(scores_raw=b'{"pae":[[0]]}'))
        self.assert_code("PAE_MISSING", lambda: run(scores_raw=b'{"plddt":[90,60,30],"max_pae":30}'))

    def test_plddt_length_and_nonfinite_range_boolean_are_rejected(self):
        for values in ([90, 60], [90, 60, 30, 40], [[90], 60, 30]):
            with self.subTest(values=values):
                self.assert_code("PLDDT_LENGTH_MISMATCH" if len(values) != 3 else "INVALID_CONFIDENCE_VALUE", lambda: run(scores_raw=scores(plddt=values)))
        for value in (-0.1, 100.01, True, "90", 10 ** 400):
            self.assert_code("INVALID_CONFIDENCE_VALUE", lambda: run(scores_raw=scores(plddt=[value, 60, 30])))
        for value in (float("nan"), float("inf")):
            self.assert_code("INVALID_SCORES_JSON", lambda: run(scores_raw=scores(plddt=[value, 60, 30])))

    def test_pae_shape_nonnegative_finite_and_operational_range(self):
        for matrix in ([[0]], [[1, 2, 3], [1, 2], [1, 2, 3]], [1, 2, 3]):
            self.assert_code("PAE_SHAPE_MISMATCH", lambda: run(scores_raw=scores(pae=matrix)))
        for value in (-1, 1001, True, "2"):
            matrix = [[value, 0, 0], [0, 0, 0], [0, 0, 0]]
            self.assert_code("INVALID_CONFIDENCE_VALUE", lambda: run(scores_raw=scores(pae=matrix)))
        self.assert_code("INVALID_SCORES_JSON", lambda: run(scores_raw=b'{"plddt":[90,60,30],"pae":[[1e999,0,0],[0,0,0],[0,0,0]]}'))

    def test_producer_max_pae_rounding_is_checked_not_interpreted_as_theoretical_ceiling(self):
        self.assertEqual(run()["confidence"]["pae"]["reported_max_pae"], 8.904)
        self.assert_code("MAX_PAE_MISMATCH", lambda: run(scores_raw=scores(max_pae=31.75)))
        self.assert_code("MAX_PAE_MISMATCH", lambda: run(scores_raw=scores(max_pae=8.91)))
        data = json.loads(scores()); del data["max_pae"]
        result = run(scores_raw=json.dumps(data).encode())
        self.assertIsNone(result["confidence"]["pae"]["reported_max_pae"])
        self.assertIn("MAX_PAE_UNAVAILABLE", {item["code"] for item in result["diagnostics"]})

    def test_bfactor_agreement_respects_decimal_rounding_and_reports_mismatches(self):
        result = run(scores_raw=scores(plddt=[89.99, 60, 30]))
        self.assertEqual(result["mapping"]["bfactor_plddt_tolerance"], BF_PLDDT_TOLERANCE)
        self.assert_code("PLDDT_BFACTOR_MISMATCH", lambda: run(scores_raw=scores(plddt=[89.98, 60, 30])))
        self.assert_code("PDB_PLDDT_RANGE", lambda: run(pdb([atom(1, 1, bfactor=101)]), b'{"plddt":[100]}'))
        self.assert_code("PDB_PLDDT_RANGE", lambda: run(pdb([atom(1, 1, bfactor=float("nan"))]), b'{"plddt":[80]}'))

    def test_every_atom_is_checked_and_missing_ca_cannot_shift_confidence(self):
        self.assert_code("MISSING_CA", lambda: run(pdb([atom(1, 1, name="N")]), b'{"plddt":[80]}'))
        self.assert_code("INVALID_PDB", lambda: run(pdb([atom(1, 1), atom(2, 1, name="N", xyz=(float("nan"), 0, 0))]), b'{"plddt":[80]}'))
        self.assert_code("PDB_PLDDT_INCONSISTENT", lambda: run(pdb([atom(1, 1), atom(2, 1, name="N", bfactor=20)]), b'{"plddt":[80]}'))

    def test_strict_profile_rejects_insertions_altlocs_unknown_and_nonpolymer_components(self):
        for kwargs in ({"insertion": "A"}, {"altloc": "B"}):
            self.assert_code("UNSUPPORTED_PDB_IDENTITY", lambda: run(pdb([atom(1, 1, **kwargs)]), b'{"plddt":[80]}'))
        self.assert_code("UNSUPPORTED_PDB_IDENTITY", lambda: run(pdb([atom(1, 1, residue="UNK")]), b'{"plddt":[80]}'))
        self.assert_code("UNSUPPORTED_PDB_COMPONENT", lambda: run(pdb([atom(1, 1).replace("ATOM  ", "HETATM")]), b'{"plddt":[80]}'))

    def test_duplicate_gapped_reordered_and_multimodel_inputs_fail(self):
        self.assert_code("DUPLICATE_PDB_IDENTITY", lambda: run(pdb([atom(1, 1), atom(2, 1)]), b'{"plddt":[80]}'))
        self.assert_code("PDB_RESIDUE_GAP", lambda: run(pdb([atom(1, 1), atom(2, 3)]), b'{"plddt":[80,80]}'))
        self.assert_code("PDB_ORDER_MISMATCH", lambda: run(pdb([atom(1, 1, chain="A"), atom(2, 1, chain="B"), atom(3, 2, chain="A")]), b'{"plddt":[80,80,80]}'))
        self.assert_code("UNSUPPORTED_PDB_MODEL", lambda: run(pdb(model=1).replace(b"END\n", b"") + pdb(model=2)))
        self.assert_code("INVALID_PDB", lambda: run(pdb() + atom(4, 4).encode()))
        self.assert_code("INCOMPLETE_PDB", lambda: run(pdb().replace(b"END\n", b"")))

    def test_expected_chains_bind_order_identity_sequence_and_length(self):
        for expected in ([{"chain": "B", "sequence": "ACG"}], [{"chain": "A", "sequence": "AGC"}],
                         [{"chain": "A", "sequence": "AC"}], [], [{"chain": "A", "sequence": "ACG", "extra": True}]):
            self.assert_code("EXPECTED_CHAIN_MISMATCH", lambda: run(expected_chains=expected))

    def test_ter_preserves_multichain_confidence_order(self):
        raw = pdb([atom(1, 10, "CYS", chain="B", bfactor=90), "TER       2      CYS B  10",
                   atom(3, 1, "ALA", chain="A", bfactor=60), atom(4, 2, "GLY", chain="A", bfactor=30),
                   "TER       5      GLY A   2"], model=1)
        result = run(raw, expected_chains=[{"chain": "B", "sequence": "C"}, {"chain": "A", "sequence": "AG"}])
        self.assertEqual(result["structure"]["chain_count"], 2)
        self.assertEqual([(chain["chain"], chain["start_index"], chain["stop_index"])
                          for chain in result["structure"]["chains"]], [("B", 0, 1), ("A", 1, 3)])
        self.assertEqual([row["plddt"] for row in result["structure"]["residues"]], [90, 60, 30])
        self.assertEqual(result["confidence"]["pae"]["values"][0][2], 2.3)
        self.assertEqual(result["confidence"]["pae"]["values"][2][0], 6.7)

    def test_ter_rejects_resuming_chain_or_residue_even_with_consecutive_numbering(self):
        for terminator in ("TER       2      ALA A   1", "TER"):
            for resumed in (atom(3, 2, "CYS"), atom(3, 1, "ALA", name="N")):
                with self.subTest(terminator=terminator, resumed=resumed):
                    self.assert_code("PDB_ORDER_MISMATCH", lambda: run(
                        pdb([atom(1, 1), terminator, resumed]), b'{"plddt":[80,80]}'))

    def test_ter_requires_an_open_observed_chain(self):
        for raw in (pdb(["TER", atom(1, 1)]), pdb([atom(1, 1), "TER", "TER"]),
                    pdb([atom(1, 1)], model=1).replace(b"ENDMDL\n", b"ENDMDL\nTER\n")):
            with self.subTest(raw=raw):
                self.assert_code("INVALID_PDB", lambda: run(raw, b'{"plddt":[80]}'))

    def test_scalar_scores_are_bounded_and_unknown_fields_are_not_promoted(self):
        for field in ("ptm", "iptm"):
            for value in (-0.1, 1.1, True, None):
                self.assert_code("INVALID_CONFIDENCE_VALUE", lambda: run(scores_raw=scores(**{field: value})))
        result = run(scores_raw=scores(iptm=0.3, producer_extra={"note": "not imported"}))
        self.assertEqual(result["confidence"]["iptm"]["value"], 0.3)
        self.assertEqual(result["unimported_score_fields"], ["producer_extra"])
        self.assertIn("IPTM_WITH_SINGLE_CHAIN", {item["code"] for item in result["diagnostics"]})
        self.assertNotIn("not imported", json.dumps(result))

    def test_json_ambiguities_wrong_format_and_invalid_bytes_are_rejected(self):
        for raw in (b'{"plddt":[90,60,30],"plddt":[90,60,30]}', b'[{"predicted_aligned_error":[[0]]}]', b'not json', b'\xff'):
            self.assert_code("INVALID_SCORES_JSON", lambda: run(scores_raw=raw))
        self.assert_code("INVALID_PDB", lambda: run(pdb_raw=b"\xff"))
        first = run(scores_raw=scores())
        second = run(scores_raw=b"\xef\xbb\xbf" + scores() + b"\n")
        self.assertEqual(first["confidence"], second["confidence"])
        self.assertNotEqual(first["sources"]["scores_path"]["sha256"], second["sources"]["scores_path"]["sha256"])

    def test_input_bounds_no_truncation_and_pure_handler_never_opens_paths(self):
        self.assert_code("IMPORT_INPUT_MISSING_OR_LARGE", lambda: import_colabfold_result(ARGS, {}))
        rows = [atom(i + 1, i + 1) for i in range(MAX_RESIDUES + 1)]
        self.assert_code("STRUCTURE_LIMIT", lambda: run(pdb(rows), b'{"plddt":[]}'))
        with patch("builtins.open", side_effect=AssertionError("importer must only use supplied bytes")), patch.object(Path, "open", side_effect=AssertionError("no path reads")):
            result = run()
        self.assertEqual(result["structure"]["residue_count"], 3)

    def test_declared_residue_bound_fits_typical_full_pae_and_oversized_precision_is_rejected(self):
        count = MAX_RESIDUES
        raw = pdb([atom(index + 1, index + 1) for index in range(count)])
        values = {"plddt": [80] * count, "pae": [[31.75] * count for _ in range(count)], "max_pae": 31.75}
        result = run(raw, json.dumps(values).encode())
        self.assertEqual(result["confidence"]["pae"]["shape"], [count, count])
        self.assertEqual(len(result["structure"]["residues"]), count)
        self.assertLess(len((json.dumps(result, ensure_ascii=False, indent=2) + "\n").encode()), 4 * 1024 * 1024)
        value = 0.12345678901234567
        values.update(pae=[[value] * count for _ in range(count)], max_pae=value)
        self.assert_code("IMPORT_RESULT_TOO_LARGE", lambda: run(raw, json.dumps(values).encode()))

    def test_existing_workspace_guard_rejects_traversal_absolute_and_symlink_before_dispatch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = WorkspacePaths.create(root)
            (root / "build/prediction.pdb").write_bytes(pdb())
            (root / "build/scores.json").write_bytes(scores())
            metadata = TOOLS["import_colabfold_result"]
            files = {field: read_bytes_bounded(paths.workspace_file(ARGS[field], extensions=declaration["extensions"], max_bytes=declaration["max_bytes"]), declaration["max_bytes"])
                     for field, declaration in metadata["file_inputs"].items()}
            self.assertEqual(import_colabfold_result(ARGS, files)["structure"]["residue_count"], 3)
            for unsafe in ("../outside.pdb", "/outside.pdb", "C:\\outside.pdb", "build/../outside.pdb"):
                with self.assertRaises(SecurityBoundaryError):
                    paths.workspace_file(unsafe, extensions={".pdb"})
                with self.assertRaises(SecurityBoundaryError):
                    run(structure_path=unsafe)
            # Simulate an inspected reparse point without requiring Windows symlink privileges.
            from proto_agent import security
            original = security._is_reparse_or_symlink
            with patch.object(security, "_is_reparse_or_symlink", side_effect=lambda path: path.name == "prediction.pdb" or original(path)):
                with self.assertRaises(SecurityBoundaryError) as caught:
                    paths.workspace_file(ARGS["structure_path"], extensions={".pdb"})
                self.assertEqual(caught.exception.code, "REPARSE_POINT_NOT_ALLOWED")

    def test_module_metadata_declares_one_dependency_free_import_handler(self):
        self.assertEqual(set(TOOLS), {"import_colabfold_result"})
        self.assertEqual(set(HANDLERS), set(TOOLS))
        self.assertEqual(TOOLS["import_colabfold_result"]["dependency"], [])
        self.assertEqual(set(TOOLS["import_colabfold_result"]["file_inputs"]), {"structure_path", "scores_path"})


if __name__ == "__main__":
    unittest.main()
