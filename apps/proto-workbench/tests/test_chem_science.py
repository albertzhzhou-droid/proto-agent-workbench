"""Scientific and protocol regression for the new chemistry operator worker."""
from __future__ import annotations
import copy
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import sys
import unittest

APP = Path(__file__).resolve().parents[1]
ROOT = APP.parents[1]
WORKER = APP / "runtime/chem-integration/chem_science.py"
sys.path.insert(0, str(APP / "runtime/chem-workbench/src"))
spec = importlib.util.spec_from_file_location("chem_science", WORKER)
science = importlib.util.module_from_spec(spec)
spec.loader.exec_module(science)
EVIDENCE = {"scope": "Numerical, molecular, legacy adapter and stdin/stdout regression; no model or UI claims", "cases": []}


def execute(operator, data):
    result = science.execute({"operator": operator, "input": data})
    if not result["ok"]:
        raise AssertionError(result)
    return result["result"]


class ScienceTests(unittest.TestCase):
    def test_first_order_analytic_solution(self):
        network = science.example_network("reversible")
        network["reactions"] = [network["reactions"][0]]
        value = execute("simulate_reaction_network", {"network": network, "duration_s": 40, "points": 101})
        errors = [abs(actual - math.exp(-.15 * time)) for time, actual in zip(value["time_s"], value["series"][0]["concentration"])]
        self.assertLess(max(errors), 5e-8)
        self.assertTrue(value["conservation"]["chemically_balanced"])
        self.assertTrue(all(row["max_absolute_drift"] < 1e-10 for row in value["conservation"]["element_balance"]))
        EVIDENCE["cases"].append({"case": "first_order_analytic", "max_absolute_error": max(errors)})

    def test_reversible_analytic_and_equilibrium(self):
        result = execute("simulate_reaction_network", {"example": "reversible", "duration_s": 200, "points": 201})
        errors = [abs(actual - (.25 + .75 * math.exp(-.2 * time))) for time, actual in zip(result["time_s"], result["series"][0]["concentration"])]
        self.assertLess(max(errors), 5e-8)
        self.assertAlmostEqual(result["series"][0]["concentration"][-1], .25, places=8)
        self.assertAlmostEqual(result["reaction_rates"][0]["rate"][-1], result["reaction_rates"][1]["rate"][-1], places=9)
        self.assertTrue(all(v is None for v in result["series"][1]["conversion"]))
        EVIDENCE["cases"].append({"case": "reversible_analytic", "max_absolute_error": max(errors), "equilibrium_a": result["series"][0]["concentration"][-1]})

    def test_consecutive_analytic_intermediate(self):
        result = execute("simulate_reaction_network", {"example": "consecutive", "points": 121})
        errors = [abs(actual - .2 / (.08 - .2) * (math.exp(-.2*t) - math.exp(-.08*t))) for t, actual in zip(result["time_s"], result["series"][1]["concentration"])]
        self.assertLess(max(errors), 8e-8)

    def test_parallel_branch_ratio(self):
        result = execute("simulate_reaction_network", {"example": "parallel"})
        self.assertAlmostEqual(result["series"][1]["concentration"][-1] / result["series"][2]["concentration"][-1], 3, places=9)

    def test_catalytic_and_surface_conserve_sites(self):
        for example in ["catalytic", "interface"]:
            with self.subTest(example=example):
                result = execute("simulate_reaction_network", {"example": example, "duration_s": 100})
                total = next(row for row in result["conservation"]["element_balance"] if row["element"] == "site")
                self.assertAlmostEqual(total["values"][0], .25)
                self.assertLess(total["max_absolute_drift"], 1e-10)
                self.assertGreater(next(row for row in result["series"] if row["id"] == "B")["concentration"][-1], .5)
                self.assertEqual(result["scene"]["kind"], "population-based")

    def test_arrhenius_sweep_matches_formula(self):
        result = execute("scan_reaction_temperature", {"example": "parallel", "temperatures_k": [288.15, 298.15, 308.15], "points": 31})
        for row in result["runs"]:
            expected = .12 * math.exp(-25000 / science.GAS_CONSTANT * (1 / row["temperature_k"] - 1 / 298.15))
            self.assertAlmostEqual(row["rate_constants"]["A_to_B"], expected, places=12)
        self.assertGreater(result["runs"][2]["final_concentrations"]["C"], result["runs"][0]["final_concentrations"]["C"])

    def test_rate_fit_recovers_external_analytic_data(self):
        times = list(range(0, 51, 5))
        network = science.example_network("reversible")
        network["reactions"][0]["rate_constant"] = .08
        network["reactions"][1]["rate_constant"] = .08
        measured = [.04 / .26 + .22 / .26 * math.exp(-.26*t) for t in times]
        result = execute("fit_reaction_rates", {"network": network, "observations": {"time_s": times, "concentrations": {"A": measured}}})
        self.assertTrue(result["diagnostics"]["converged"])
        self.assertTrue(result["diagnostics"]["locally_identifiable"])
        self.assertAlmostEqual(result["fitted_rate_constants"]["forward"], .22, places=6)
        self.assertAlmostEqual(result["fitted_rate_constants"]["reverse"], .04, places=6)
        self.assertLess(result["diagnostics"]["rmse_mol_l"], 1e-7)
        EVIDENCE["cases"].append({"case": "fit_analytic_recovery", **result["diagnostics"], "rates": result["fitted_rate_constants"]})

    def test_molecule_formula_descriptors_geometry_reproducible(self):
        first = execute("analyze_molecule", {"smiles": "CCO"})
        second = execute("analyze_molecule", {"smiles": "CCO"})
        molecule = first["molecule"]
        self.assertEqual(molecule["formula"], "C2H6O")
        self.assertAlmostEqual(molecule["descriptors"]["molecular_weight_g_mol"], 46.069, places=3)
        self.assertEqual(len(molecule["atoms"]), 9)
        self.assertEqual(len(molecule["bonds"]), 8)
        self.assertEqual(molecule["atoms"], second["molecule"]["atoms"])
        self.assertEqual(first["screening"]["lipinski_violation_count"], 0)

    def test_rate_fit_detects_indistinguishable_parallel_channels(self):
        times = list(range(0, 51, 5))
        result = execute("fit_reaction_rates", {"example": "parallel", "fit_reaction_ids": ["A_to_B", "A_to_C"],
            "observations": {"time_s": times, "concentrations": {"A": [math.exp(-.3*t) for t in times]}}})
        self.assertTrue(result["diagnostics"]["converged"])
        self.assertLess(result["diagnostics"]["rmse_mol_l"], 1e-7)
        self.assertFalse(result["diagnostics"]["locally_identifiable"])
        self.assertEqual(result["diagnostics"]["jacobian_rank"], 1)
        EVIDENCE["cases"].append({"case": "parallel_channels_not_identifiable_from_A", **result["diagnostics"]})

    def test_molecule_similarity_identity_and_change(self):
        same = execute("compare_molecules", {"original_smiles": "c1ccccc1", "proposed_smiles": "c1ccccc1"})
        changed = execute("compare_molecules", {"original_smiles": "c1ccccc1", "proposed_smiles": "Oc1ccccc1"})
        self.assertEqual(same["morgan_tanimoto"], 1)
        self.assertLess(changed["morgan_tanimoto"], 1)
        self.assertTrue(changed["same_murcko_scaffold"])
        self.assertEqual(changed["maximum_common_substructure"]["atoms"], 6)

    def test_reaction_mapping_tracks_supplied_bonds(self):
        result = execute("inspect_reaction_smiles", {"reaction_smiles": "[CH2:1]=[CH2:2].[H:3][H:4]>>[CH2:1]([H:3])[CH2:2][H:4]"})
        self.assertTrue(result["balanced"])
        self.assertTrue(result["mapping"]["provided"])
        self.assertTrue(result["mapping"]["consistent"])
        self.assertEqual(result["mapping"]["missing_in_products"], [])
        self.assertTrue(any(row["before_order"] == 2 and row["after_order"] == 1 for row in result["mapping"]["bond_changes"]))
        imbalance = execute("inspect_reaction_smiles", {"reaction_smiles": "CCO>>CC=O"})
        self.assertFalse(imbalance["balanced"])
        self.assertEqual(imbalance["composition_residuals"]["H"], -2)

    def test_xyz_keeps_actual_coordinates_and_rejects_identity_change(self):
        source = "2\nframe 0\nH 0 0 0\nH 0.74 0 0\n2\nframe 1\nH 0.1 0 0\nH 0.84 0 0\n"
        value = execute("parse_xyz_trajectory", {"xyz": source, "frame_interval_fs": 2})
        self.assertEqual(value["frame_count"], 2)
        self.assertEqual(value["frames"][1]["atoms"][1]["x"], .84)
        self.assertEqual(value["frames"][1]["time_fs"], 2)
        bad = science.execute({"operator": "parse_xyz_trajectory", "input": {"xyz": source.replace("H 0.84", "He 0.84")}})
        self.assertEqual(bad["error"]["code"], "XYZ_ATOM_IDENTITY")

    def test_invalid_and_unbalanced_networks_rejected(self):
        cases = []
        initial = science.example_network("reversible")
        value = copy.deepcopy(initial); value["species"][0]["initial_concentration"] = -1; cases.append((value, "INVALID_INPUT"))
        value = copy.deepcopy(initial); value["reactions"][0]["products"] = {"missing": 1}; cases.append((value, "UNKNOWN_SPECIES"))
        value = copy.deepcopy(initial); value["species"][1]["smiles"] = "CC"; cases.append((value, "UNBALANCED_NETWORK"))
        value = copy.deepcopy(initial); value["species"][1]["smiles"] = "oops"; cases.append((value, "INVALID_SMILES"))
        value = copy.deepcopy(initial); value["species"][0]["composition"] = {"C": 99}; cases.append((value, "COMPOSITION_MISMATCH"))
        for network, code in cases:
            with self.subTest(code=code):
                response = science.execute({"operator": "simulate_reaction_network", "input": {"network": network}})
                self.assertFalse(response["ok"])
                self.assertEqual(response["error"]["code"], code)
        wrong = science.execute({"operator": "fit_reaction_rates", "input": {"observations": {"time_s": [0, 1, 1], "concentrations": {"A": [1, .8, .7]}}}})
        self.assertFalse(wrong["ok"])

    def test_catalog_examples_and_existing_operators(self):
        catalog = execute("catalog", {})
        self.assertEqual(len(catalog["operators"]), 56)
        self.assertEqual({item["workspace"] for item in catalog["operators"]}, {"analysis", "statistics", "chemical-data"})
        for operator in catalog["operators"]:
            with self.subTest(operator=operator["id"]):
                self.assertTrue(operator["available"])
                result = execute(operator["id"], operator["example_input"])
                self.assertIsInstance(result, dict)
                EVIDENCE["cases"].append({"case": "catalog_operator", "operator": operator["id"], "ok": True})

    def test_json_worker_stdout_protocol_and_invalid_json(self):
        for request, expected in [(json.dumps({"operator": "analyze_molecule", "input": {"smiles": "O"}}), True), ('{"operator":"bad","input":{}}', False), ('{"input":NaN}', False)]:
            process = subprocess.run([sys.executable, str(WORKER)], input=request, text=True, encoding="utf-8", capture_output=True, timeout=30)
            self.assertEqual(process.returncode, 0, process.stderr)
            response = json.loads(process.stdout)
            self.assertEqual(response["ok"], expected)
            self.assertEqual(len(response["provenance"]["source_sha256"]), 64)


if __name__ == "__main__":
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ScienceTests))
    destination = ROOT / "build/chem-analysis-qa/numerical-regression.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE.update({"tests_run": result.testsRun, "failures": len(result.failures), "errors": len(result.errors), "passed": result.wasSuccessful(),
        "runtime": science.dependencies(), "worker_sha256": science.hashlib.sha256(WORKER.read_bytes()).hexdigest()})
    destination.write_text(json.dumps(EVIDENCE, indent=2), encoding="utf-8")
    raise SystemExit(not result.wasSuccessful())
