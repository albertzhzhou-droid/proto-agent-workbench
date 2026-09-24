"""Chemical Data numerical identities, preservation, rejection and schema tests."""
from __future__ import annotations

import importlib.metadata
import importlib.util
import json
import math
from pathlib import Path
import sys
import unittest

APP = Path(__file__).resolve().parents[1]
ROOT = APP.parents[1]
WORKER = APP / "runtime/chem-integration/chem_data.py"
spec = importlib.util.spec_from_file_location("chem_data", WORKER)
data = importlib.util.module_from_spec(spec)
spec.loader.exec_module(data)
EVIDENCE = {"scope": "Actual RDKit/SymPy Chemical Data calculations and input contracts; no UI/model claims", "cases": []}


def records(*smiles):
    return [{"id": f"record_{i + 1}", "smiles": value} for i, value in enumerate(smiles)]


class ChemicalDataTests(unittest.TestCase):
    def error(self, code, function, value):
        with self.assertRaises(data.DataError) as context:
            function(value)
        self.assertEqual(context.exception.code, code)

    def test_all_examples_are_real_calculations_and_json_serializable(self):
        for identifier, _, category, _, schema, example, _, _ in data.operator_specs():
            with self.subTest(operator=identifier):
                self.assertEqual(category, "chemical-data")
                result = data.OPERATORS[identifier](example)
                self.assertTrue(result["tables"])
                json.dumps(result, allow_nan=False)
                EVIDENCE["cases"].append({"operator": identifier, "input": example, "result": result})

    def test_examples_satisfy_schema(self):
        import jsonschema
        for identifier, _, _, _, schema, example, _, _ in data.operator_specs():
            with self.subTest(operator=identifier):
                jsonschema.Draft202012Validator.check_schema(schema)
                jsonschema.validate(example, schema)

    def test_empty_records_and_repeated_ids_are_rejected(self):
        self.error("INVALID_INPUT", data.prepare_molecular_dataset, {"records": []})
        self.error("DUPLICATE_ID", data.prepare_molecular_dataset, {"records": [{"id": "same", "smiles": "C"}, {"id": "same", "smiles": "O"}]})

    def test_invalid_rows_and_identity_duplicates_are_retained(self):
        result = data.prepare_molecular_dataset({"records": records("CCO", "OCC", "invalid", "")})
        self.assertEqual(result["summary"], {"input_count": 4, "valid_count": 2, "invalid_count": 2, "unique_identity_count": 1, "duplicate_group_count": 1})
        self.assertEqual([row["id"] for row in result["records"]], [f"record_{i + 1}" for i in range(4)])
        self.assertEqual(result["records"][2]["input_smiles"], "invalid")
        self.assertAlmostEqual(result["records"][0]["molecular_weight_g_mol"], 46.069, places=3)

    def test_smiles_parser_does_not_accept_trailing_names(self):
        result = data.prepare_molecular_dataset({"records": records("CCO ethanol")})
        self.assertFalse(result["records"][0]["valid"])

    def test_salt_policy_changes_are_explicit_and_retain_charge(self):
        source = records("CC(=O)[O-].[Na+]")
        preserved = data.prepare_molecular_dataset({"records": source})["records"][0]
        parent = data.prepare_molecular_dataset({"records": source, "salt_policy": "largest_fragment"})["records"][0]
        rejected = data.prepare_molecular_dataset({"records": source, "salt_policy": "reject_multicomponent"})["records"][0]
        self.assertEqual(preserved["formal_charge"], 0)
        self.assertEqual(parent["formal_charge"], -1)
        self.assertEqual(parent["removed_fragments"], "[Na+]")
        self.assertFalse(rejected["valid"])
        self.assertGreater(preserved["molecular_weight_g_mol"], parent["molecular_weight_g_mol"])

    def test_stereo_isotopes_preserved_but_atom_maps_not_identity(self):
        result = data.prepare_molecular_dataset({"records": records("C[C@H](F)Cl", "C[C@@H](F)Cl", "[13CH3]O", "CO", "[CH3:1][OH:2]")})
        self.assertEqual(result["summary"]["unique_identity_count"], 4)
        self.assertIn("13C", result["records"][2]["canonical_smiles"])
        self.assertEqual(result["records"][3]["canonical_smiles"], result["records"][4]["canonical_smiles"])

    def test_smarts_returns_actual_canonical_atom_indices(self):
        result = data.search_substructures({"records": records("OCC", "c1ccccc1", "invalid"), "smarts": "[OX2H]"})
        self.assertEqual(result["summary"]["matched_count"], 1)
        self.assertEqual(result["matches"][0]["canonical_smiles"], "CCO")
        self.assertEqual(result["matches"][0]["atom_indices"], [[2]])
        self.assertIsNone(result["records"][2]["matched"])

    def test_smarts_match_limit_is_explicit(self):
        result = data.search_substructures({"records": records("CCCC"), "smarts": "C", "max_matches": 2})
        self.assertTrue(result["matches"][0]["truncated"])
        self.assertEqual(len(result["matches"][0]["atom_indices"]), 2)
        self.error("INVALID_SMARTS", data.search_substructures, {"records": records("C"), "smarts": "[broken"})

    def test_smarts_chirality_selection(self):
        request = {"records": records("C[C@H](F)Cl", "C[C@@H](F)Cl"), "smarts": "C[C@H](F)Cl"}
        self.assertEqual(data.search_substructures({**request, "use_chirality": False})["summary"]["matched_count"], 2)
        self.assertEqual(data.search_substructures({**request, "use_chirality": True})["summary"]["matched_count"], 1)

    def test_clusters_duplicate_graphs_at_identity_threshold(self):
        result = data.cluster_molecules({"records": records("CCO", "OCC", "c1ccccc1"), "similarity_threshold": 1})
        self.assertEqual(result["summary"]["cluster_count"], 2)
        self.assertEqual(result["records"][0]["cluster_id"], result["records"][1]["cluster_id"])
        self.assertNotEqual(result["records"][0]["cluster_id"], result["records"][2]["cluster_id"])
        self.assertTrue(all(row["similarity_to_representative"] == 1 for row in result["records"]))

    def test_clusters_cover_all_valid_molecules_and_centroids_are_real(self):
        result = data.cluster_molecules({"records": records("CCO", "CCCO", "CCCCO", "c1ccccc1", "invalid"), "similarity_threshold": .4})
        self.assertEqual(sum(cluster["size"] for cluster in result["clusters"]), 4)
        self.assertEqual(len(result["representative_ids"]), len(set(result["representative_ids"])))
        for row in result["records"]:
            if row["valid"]:
                self.assertGreaterEqual(row["similarity_to_representative"] + 1e-12, .4)
        self.error("NO_VALID_MOLECULES", data.cluster_molecules, {"records": records("bad")})

    def test_single_molecule_is_its_own_representative(self):
        result = data.cluster_molecules({"records": records("CCO")})
        self.assertEqual(result["representative_ids"], ["record_1"])
        self.assertEqual(result["clusters"][0]["size"], 1)

    def test_formula_nested_groups_and_hydrates(self):
        hydrated = data.formula_properties({"formula": "CuSO4·5H2O"})
        self.assertEqual(hydrated["composition"], {"Cu": 1, "S": 1, "O": 9, "H": 10})
        self.assertAlmostEqual(hydrated["molar_mass_g_mol"], 249.684, places=3)
        nested = data.formula_properties({"formula": "K4[Fe(CN)6]"})
        self.assertEqual(nested["composition"], {"K": 4, "Fe": 1, "C": 6, "N": 6})
        self.assertAlmostEqual(sum(row["mass_fraction"] for row in hydrated["tables"][1]["rows"]), 1)

    def test_formula_isotopes_and_ion_mass(self):
        natural = data.formula_properties({"formula": "CH4"})
        labelled = data.formula_properties({"formula": "[13C]H4"})
        ion = data.formula_properties({"formula": "[13C]H4", "charge": 1})
        self.assertAlmostEqual(labelled["exact_mass_da"] - natural["exact_mass_da"], 1.00335484, places=7)
        self.assertAlmostEqual(labelled["exact_mass_da"] - ion["exact_mass_da"], data.ELECTRON_MASS_DA, places=12)
        self.assertAlmostEqual(ion["mass_to_charge_da"], ion["exact_mass_da"])

    def test_formula_bad_elements_counts_brackets_and_resource_limits(self):
        for formula in ("Xx2", "C0H4", "C01H4", "H(OH", "H2O)", "CuSO4·", "Fe3+", "Fe-2", "C1000001", "H()", "Na Cl", "[999C]", "0H2O"):
            with self.subTest(formula=formula):
                with self.assertRaises(data.DataError):
                    data.formula_properties({"formula": formula})

    def test_equation_combustion_is_exact_primitive_integer_balance(self):
        result = data.balance_equation({"reactants": [{"formula": "C2H6"}, {"formula": "O2"}], "products": [{"formula": "CO2"}, {"formula": "H2O"}]})
        self.assertEqual([entry["coefficient"] for entry in result["species"]], [2, 7, 4, 6])
        self.assertTrue(all(row["residual"] == 0 for row in result["tables"][1]["rows"]))

    def test_equation_ionic_and_electron_charge_conservation(self):
        result = data.balance_equation({"reactants": [{"formula": "Fe", "charge": 2}, {"formula": "Ce", "charge": 4}], "products": [{"formula": "Fe", "charge": 3}, {"formula": "Ce", "charge": 3}]})
        self.assertEqual([entry["coefficient"] for entry in result["species"]], [1, 1, 1, 1])
        charge = result["tables"][1]["rows"][-1]
        self.assertEqual((charge["reactants"], charge["products"], charge["residual"]), (6, 6, 0))
        half = data.balance_equation({"reactants": [{"formula": "Fe", "charge": 3}, {"formula": "e", "charge": -1}], "products": [{"formula": "Fe", "charge": 2}]})
        self.assertEqual(half["tables"][1]["rows"][-1]["reactants"], 2)

    def test_equation_rejects_missing_charge_balance_and_isotope_change(self):
        self.error("UNBALANCEABLE_EQUATION", data.balance_equation, {"reactants": [{"formula": "Fe", "charge": 2}], "products": [{"formula": "Fe", "charge": 3}]})
        self.error("UNBALANCEABLE_EQUATION", data.balance_equation, {"reactants": [{"formula": "[13C]O2"}], "products": [{"formula": "CO2"}]})

    def test_equation_rejects_underdetermined_or_unused_species(self):
        self.error("AMBIGUOUS_EQUATION", data.balance_equation, {"reactants": [{"formula": "C"}, {"formula": "O2"}], "products": [{"formula": "CO"}, {"formula": "CO2"}]})
        self.error("UNBALANCEABLE_EQUATION", data.balance_equation, {"reactants": [{"formula": "H2"}, {"formula": "O2"}], "products": [{"formula": "H2O"}, {"formula": "NaCl"}]})

    def test_amount_mg_mL_and_inverse_concentration(self):
        result = data.solution_calculator({"formula": "NaCl", "mass": {"value": 584.43, "unit": "mg"}, "volume": {"value": 100, "unit": "mL"}})
        self.assertAlmostEqual(result["concentration_mol_L"], .1, places=12)
        inverse = data.solution_calculator({"formula": "NaCl", "concentration": {"value": 100, "unit": "mmol/L"}, "volume": {"value": 100, "unit": "mL"}})
        self.assertAlmostEqual(inverse["mass_g"], result["mass_g"], places=12)

    def test_amount_micromoles_without_volume(self):
        result = data.solution_calculator({"formula": "NaCl", "moles": {"value": 10, "unit": "umol"}})
        self.assertAlmostEqual(result["amount_mol"], 1e-5)
        self.assertIsNone(result["concentration_mol_L"])

    def test_dilution_conservation_and_units(self):
        request = {"mode": "dilution", "stock_concentration": {"value": 1, "unit": "mol/L"}, "target_concentration": {"value": 100, "unit": "mmol/L"}, "final_volume": {"value": 50, "unit": "mL"}}
        result = data.solution_calculator(request)
        self.assertAlmostEqual(result["stock_volume_L"], .005, places=14)
        self.assertAlmostEqual(result["conserved_amount_mol"], .005, places=14)
        self.assertEqual(result["dilution_factor"], 10)
        self.assertEqual(result["input_quantities"], request)
        self.assertNotIn("solvent_volume_L", result)

    def test_solution_rejects_ambiguous_quantities_and_unknown_units(self):
        base = {"formula": "NaCl", "mass": {"value": 1, "unit": "g"}}
        self.error("INVALID_INPUT", data.solution_calculator, {**base, "moles": {"value": 1, "unit": "mol"}})
        self.error("INVALID_UNIT", data.solution_calculator, {**base, "volume": {"value": 1, "unit": "pint"}})
        self.error("INVALID_INPUT", data.solution_calculator, {**base, "volume": {"value": 0, "unit": "L"}})
        self.error("INVALID_INPUT", data.solution_calculator, {**base, "mass": {"value": math.inf, "unit": "g"}})
        self.error("QUANTITY_LIMIT", data.solution_calculator, {**base, "volume": {"value": 1e-320, "unit": "mL"}})
        self.error("INVALID_DILUTION", data.solution_calculator, {"mode": "dilution", "stock_concentration": {"value": 1, "unit": "mol/L"}, "target_concentration": {"value": 2, "unit": "mol/L"}, "final_volume": {"value": 1, "unit": "L"}})

    def test_solution_schema_rejects_multiple_or_missing_inputs(self):
        import jsonschema
        schema = next(spec[4] for spec in data.operator_specs() if spec[0] == "solution_calculator")
        for request in ({}, {"formula": "NaCl"}, {"formula": "NaCl", "concentration": {"value": 1, "unit": "mol/L"}},
                        {"formula": "NaCl", "mass": {"value": 1, "unit": "g"}, "concentration": {"value": 1, "unit": "mol/L"}}):
            with self.subTest(request=request):
                with self.assertRaises(jsonschema.ValidationError):
                    jsonschema.validate(request, schema)

    def test_invalid_types_cannot_be_coerced_to_numbers(self):
        for value in (True, "1", None, float("nan")):
            with self.subTest(value=value):
                self.error("INVALID_INPUT", data.cluster_molecules, {"records": records("C"), "similarity_threshold": value})


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ChemicalDataTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    EVIDENCE.update(tests_run=result.testsRun, failures=len(result.failures), errors=len(result.errors), successful=result.wasSuccessful(),
                    versions={package: importlib.metadata.version(package) for package in ("rdkit", "sympy", "jsonschema")})
    output = ROOT / "build/chem-data-qa"
    output.mkdir(parents=True, exist_ok=True)
    (output / "acceptance.json").write_text(json.dumps(EVIDENCE, indent=2, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    sys.exit(0 if result.wasSuccessful() else 1)
