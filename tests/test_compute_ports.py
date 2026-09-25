"""Contract, fail-closed, and scientific regression tests for the Biomni port batch.

Covers the five ported modules (sequence, simulation, assay, clinical, omics):
registry contracts, dependency hygiene, strict argument handling, and analytic
answers for the corrected upstream defects (Gompertz doubling-time units,
barcode lineage clustering, ITC isotherm, Golden Gate designer/assembler
composition, gene-circuit dilution ordering, hemodynamic DC restoration).
"""
from __future__ import annotations

import importlib
import importlib.util
import json
import math
import subprocess
import sys
import unittest

PORT_MODULES = ("compute_sequence", "compute_simulation", "compute_assay", "compute_clinical", "compute_omics")
MODULES = {name: importlib.import_module(f"proto_agent.{name}") for name in PORT_MODULES}
HAS_NUMERICS = all(importlib.util.find_spec(dependency) is not None for dependency in ("numpy", "scipy"))
EXPECTED_COUNTS = {"compute_sequence": 13, "compute_simulation": 12, "compute_assay": 17, "compute_clinical": 5, "compute_omics": 3}


class PortContractTests(unittest.TestCase):
    def test_registry_and_handler_parity_with_expected_counts(self):
        for name, module in MODULES.items():
            self.assertEqual(set(module.TOOLS), set(module.HANDLERS), name)
            self.assertEqual(len(module.TOOLS), EXPECTED_COUNTS[name], name)
            for identifier, metadata in module.TOOLS.items():
                self.assertIn(metadata["implementation"], {"biomni-adapted", "proto-native"}, identifier)
                self.assertNotEqual(metadata["upstream_functions"], [], identifier)
                for entry in metadata["upstream_functions"]:
                    self.assertIn("biomni/tool/", entry["path"], identifier)
                self.assertFalse(metadata["input_schema"]["additionalProperties"], identifier)
                json.dumps(metadata, allow_nan=False)

    def test_import_does_not_load_optional_scientific_dependencies(self):
        imports = "; ".join(f"import proto_agent.{name}" for name in PORT_MODULES)
        result = subprocess.run([sys.executable, "-c", f"import sys; {imports}; assert 'numpy' not in sys.modules; assert 'scipy' not in sys.modules"],
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_unknown_fields_and_missing_arguments_fail_closed(self):
        from proto_agent.compute import _validate
        for module in MODULES.values():
            for identifier, metadata in module.TOOLS.items():
                # Unknown fields are rejected by the pipeline schema validation.
                with self.subTest(tool=identifier), self.assertRaises(ValueError):
                    _validate({**json.loads(json.dumps(metadata["example"])), "execute": "untrusted"}, metadata["input_schema"])
                with self.subTest(tool=identifier), self.assertRaises(ValueError):
                    module.HANDLERS[identifier]({})

    def test_only_sgrna_designer_is_native(self):
        native = {identifier for module in MODULES.values() for identifier, metadata in module.TOOLS.items()
                  if metadata["implementation"] == "proto-native"}
        self.assertEqual(native, {"design_sgrna_spacers"})

    def test_every_port_example_validates_and_runs(self):
        from proto_agent.compute import HANDLERS as ALL_HANDLERS, TOOLS as ALL_TOOLS, _validate
        # This profile owns the five port modules, not the later heavy catalog.
        # Batch 3/4 validate the whole catalog and execute their own native tools.
        executed = set()
        for module in MODULES.values():
            for identifier in module.TOOLS:
                with self.subTest(tool=identifier):
                    metadata = ALL_TOOLS[identifier]
                    self.assertIs(ALL_HANDLERS[identifier], module.HANDLERS[identifier])
                    self.assertFalse(metadata.get("file_inputs"))
                    example = json.loads(json.dumps(metadata["example"]))
                    _validate(example, metadata["input_schema"])
                    json.dumps(ALL_HANDLERS[identifier](example), allow_nan=False)
                    executed.add(identifier)
        self.assertEqual(len(executed), sum(EXPECTED_COUNTS.values()))


class SequencePortTests(unittest.TestCase):
    def test_orf_annotation_frames_and_translation(self):
        result = MODULES["compute_sequence"].HANDLERS["annotate_open_reading_frames"]({"sequence": "ATGGCGAAATAA", "min_length_nt": 9})
        self.assertEqual(result["total_orfs"], 1)
        self.assertEqual(result["orfs"][0]["aa_sequence"], "MAK")
        reverse = MODULES["compute_sequence"].HANDLERS["annotate_open_reading_frames"]({"sequence": "TTATTTCGCCAT", "min_length_nt": 9, "search_reverse": True})
        self.assertEqual(reverse["reverse_orfs"], 1)

    def test_pcr_products_include_circular_wrap_around(self):
        sequence = "AGCGTTAAAGGGGTTTATGGCGAAAT"
        circular = MODULES["compute_sequence"].HANDLERS["pcr_simple"]({"sequence": sequence, "forward_primer": "ATGGCGAAAT", "reverse_primer": "TTTAACGCT", "circular": True})
        linear = MODULES["compute_sequence"].HANDLERS["pcr_simple"]({"sequence": sequence, "forward_primer": "ATGGCGAAAT", "reverse_primer": "TTTAACGCT"})
        self.assertTrue(circular["success"])
        self.assertEqual(circular["products"][0]["size"], 19)
        self.assertFalse(linear["success"])

    def test_digest_fragment_lengths_and_wrap(self):
        module = MODULES["compute_sequence"]
        linear = module.HANDLERS["digest_sequence"]({"sequence": "GAATTCATGGCGAAATAAGAATTCC", "enzymes": ["EcoRI"], "circular": False})
        self.assertEqual([fragment["length"] for fragment in linear["fragments"]], [18, 6, 1])
        circular = module.HANDLERS["digest_sequence"]({"sequence": "AAAGAATTCCCC", "enzymes": ["EcoRI"], "circular": True})
        self.assertEqual(len(circular["fragments"]), 1)
        self.assertTrue(circular["fragments"][0]["is_wrapped"])

    def test_enzyme_table_overhang_polarity(self):
        enzymes = MODULES["compute_sequence"]._ENZYMES
        self.assertGreater(enzymes["EcoRI"][2] - enzymes["EcoRI"][1], 0)   # 5' overhang
        self.assertEqual(enzymes["SmaI"][2] - enzymes["SmaI"][1], 0)        # blunt
        self.assertLess(enzymes["KpnI"][2] - enzymes["KpnI"][1], 0)         # 3' overhang
        self.assertEqual(enzymes["BsaI"], ("GGTCTC", 7, 11))                # upstream Type IIS table

    def test_unknown_enzyme_lists_supported_set(self):
        with self.assertRaisesRegex(ValueError, "Unsupported enzyme"):
            MODULES["compute_sequence"].HANDLERS["digest_sequence"]({"sequence": "GAATTC", "enzymes": ["EcoRII"]})

    def test_golden_gate_designer_output_assembles(self):
        module = MODULES["compute_sequence"]
        backbone = "GGTCTCAACCGGTGACGGTCTCG"
        designed = module.HANDLERS["design_golden_gate_oligos"]({"backbone_sequence": backbone, "insert_sequence": "ATGGCGAAATAA", "enzyme": "BsaI", "circular": True})
        self.assertTrue(designed["success"])
        assembled = module.HANDLERS["golden_gate_assembly"]({"backbone_sequence": backbone, "enzyme": "BsaI", "circular": True,
                                                            "fragments": [{"name": "insert", "fwd_oligo": designed["oligos"]["forward"], "rev_oligo": designed["oligos"]["reverse"]}]})
        self.assertTrue(assembled["success"], assembled["message"])
        double_stranded = module.HANDLERS["golden_gate_assembly"]({"backbone_sequence": backbone, "enzyme": "BsaI", "circular": True,
                                                                  "fragments": [{"name": "part", "sequence": "GGTCTC" + "A" + "ACCG" + "ATGGCGAAATAA" + "GGTC" + "A" + "GAGACC"}]})
        self.assertEqual(double_stranded["assembled_sequence"], assembled["assembled_sequence"])

    def test_codon_optimization_uses_highest_frequency_synonym(self):
        result = MODULES["compute_sequence"].HANDLERS["optimize_codons_for_heterologous_expression"](
            {"sequence": "ATGGGAAAATAA", "host_codon_usage": [{"codon": "ATG", "frequency": 0.9}, {"codon": "GGC", "frequency": 0.8},
                                                              {"codon": "GGA", "frequency": 0.1}, {"codon": "AAA", "frequency": 0.75}, {"codon": "AAG", "frequency": 0.25}]})
        self.assertEqual(result["optimized_sequence"], "ATGGGCAAATAA")
        self.assertEqual(result["amino_acid_sequence"], "MGK")
        self.assertEqual(result["codons_changed"], 1)

    def test_sgrna_spacers_flank_pam_on_both_strands(self):
        result = MODULES["compute_sequence"].HANDLERS["design_sgrna_spacers"]({"sequence": "CACCATGGCGAAATAAGCGTTAGGGTG", "pam": "NGG"})
        self.assertGreaterEqual(result["count"], 1)
        self.assertTrue(all(len(guide["spacer"]) == 20 for guide in result["guides"]))
        self.assertIn("+", {guide["strand"] for guide in result["guides"]})

    def test_mutation_labels_are_one_based(self):
        result = MODULES["compute_sequence"].HANDLERS["find_sequence_mutations"]({"query_sequence": "ACGTACGT", "reference_sequence": "ACGGACGT"})
        self.assertEqual([mutation["label"] for mutation in result["mutations"]], ["G4T"])


@unittest.skipUnless(HAS_NUMERICS, "numpy and scipy required")
class SimulationPortTests(unittest.TestCase):
    def test_logistic_clearance_equilibrium(self):
        result = MODULES["compute_simulation"].HANDLERS["model_bacterial_growth_dynamics"](
            {"initial_population": 1000, "growth_rate": 0.8, "clearance_rate": 0.1, "niche_size": 1e9, "duration": 60, "output_points": 60})
        self.assertLess(abs(result["final_population"] - 8.75e8) / 8.75e8, 1e-4)
        self.assertTrue(result["steady_state_reached"])

    def test_flux_balance_optimizes_bounded_objective(self):
        result = MODULES["compute_simulation"].HANDLERS["perform_flux_balance_analysis"](MODULES["compute_simulation"].TOOLS["perform_flux_balance_analysis"]["example"])
        self.assertTrue(result["success"])
        self.assertAlmostEqual(result["objective_value"], 10.0, places=9)

    def test_gene_circuit_growth_dilution_is_active(self):
        # Upstream read dM/dt before computing it, silently disabling dilution.
        arguments = {"circuit_topology": [[0.0, 2.0], [-1.5, 0.0]],
                     "kinetic_params": {"basal_rates": [0.5, 0.3], "degradation_rates": [0.1, 0.1],
                                        "hill_coefficients": [2.0, 2.0], "threshold_constants": [0.5, 0.5]},
                     "growth_params": {"max_growth_rate": 0.6, "growth_inhibition": 0.2, "gene_growth_weights": [0.1, 0.1]},
                     "duration": 60, "output_points": 60}
        result = MODULES["compute_simulation"].HANDLERS["simulate_gene_circuit_with_growth_feedback"](json.loads(json.dumps(arguments)))
        self.assertGreater(result["final_cell_mass"], 1.0)
        self.assertGreater(result["final_specific_growth_rate"], 0.0)

    def test_gillespie_is_seed_deterministic(self):
        arguments = MODULES["compute_simulation"].TOOLS["simulate_microbial_population_dynamics"]["example"]
        first = MODULES["compute_simulation"].HANDLERS["simulate_microbial_population_dynamics"](json.loads(json.dumps(arguments)))
        second = MODULES["compute_simulation"].HANDLERS["simulate_microbial_population_dynamics"](json.loads(json.dumps(arguments)))
        self.assertEqual(first["average_final_populations"], second["average_final_populations"])
        different = MODULES["compute_simulation"].HANDLERS["simulate_microbial_population_dynamics"]({**json.loads(json.dumps(arguments)), "seed": 99})
        self.assertNotEqual(first["average_final_populations"], different["average_final_populations"])

    def test_whole_cell_model_rejects_rate_omissions(self):
        with self.assertRaisesRegex(ValueError, "seven"):
            MODULES["compute_simulation"].HANDLERS["simulate_whole_cell_ode_model"]({"rates": {"k_transcription": 1.0}, "initial_conditions": {"mRNA": 0, "protein": 0, "metabolite": 0, "atp": 0}})


@unittest.skipUnless(HAS_NUMERICS, "numpy and scipy required")
class AssayPortTests(unittest.TestCase):
    def test_logistic_growth_recovers_capacity(self):
        result = MODULES["compute_assay"].HANDLERS["analyze_bacterial_growth_curve"](
            {"time_hours": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
             "od_values": [0.02, 0.03, 0.06, 0.12, 0.25, 0.45, 0.72, 0.95, 1.05, 1.1, 1.12, 1.12, 1.13]})
        self.assertLess(abs(result["carrying_capacity_od"] - 1.13), 0.05)
        self.assertGreater(result["r_squared"], 0.99)

    def test_gompertz_doubling_time_uses_specific_rate(self):
        # Upstream divided ln(2) by the OD/h tangent slope; the port converts via mu*e/A.
        result = MODULES["compute_assay"].HANDLERS["analyze_bacterial_growth_rate"](
            MODULES["compute_assay"].TOOLS["analyze_bacterial_growth_rate"]["example"])
        self.assertIsNotNone(result["doubling_time_hours"])
        self.assertAlmostEqual(result["doubling_time_hours"], math.log(2) / result["specific_growth_rate_per_hour"], places=9)

    def test_itc_recovers_known_binding_parameters(self):
        result = MODULES["compute_assay"].HANDLERS["analyze_itc_binding_thermodynamics"](
            MODULES["compute_assay"].TOOLS["analyze_itc_binding_thermodynamics"]["example"])
        self.assertLess(abs(result["kd_um"] - 5.0), 0.5)
        self.assertLess(abs(result["stoichiometry"] - 1.0), 0.05)
        self.assertGreater(result["r_squared"], 0.999)

    def test_barcode_lineage_clustering_uses_hamming_distances(self):
        # Upstream fed a distance matrix to pdist (distances of distances).
        result = MODULES["compute_assay"].HANDLERS["analyze_barcode_sequencing_data"](
            MODULES["compute_assay"].TOOLS["analyze_barcode_sequencing_data"]["example"])
        self.assertIn("lineage_clustering", result)
        self.assertGreaterEqual(result["lineage_clustering"]["lineage_count"], 1)

    def test_biofilm_ttests_require_replicates(self):
        with self.assertRaises(ValueError):
            MODULES["compute_assay"].HANDLERS["quantify_biofilm_biomass_crystal_violet"](
                {"samples": [{"name": "control", "replicate_ods": [0.1]}, {"name": "a", "replicate_ods": [0.4]}]})

    def test_hemodynamic_extraction_restores_dc_level(self):
        result = MODULES["compute_assay"].HANDLERS["analyze_hemodynamic_data"](MODULES["compute_assay"].TOOLS["analyze_hemodynamic_data"]["example"])
        self.assertGreater(result["systolic_mmhg"], 110)
        self.assertLess(result["diastolic_mmhg"], 100)
        self.assertGreater(result["heart_rate_bpm"], 60)

    def test_release_kinetics_selects_model_and_half_life(self):
        result = MODULES["compute_assay"].HANDLERS["analyze_in_vitro_drug_release_kinetics"](MODULES["compute_assay"].TOOLS["analyze_in_vitro_drug_release_kinetics"]["example"])
        self.assertIsNotNone(result["best_model"])
        self.assertIsNotNone(result["half_life_hours"])

    def test_cd_melt_reports_midpoint_temperature(self):
        result = MODULES["compute_assay"].HANDLERS["analyze_circular_dichroism_spectra"](MODULES["compute_assay"].TOOLS["analyze_circular_dichroism_spectra"]["example"])
        self.assertIn("thermal_stability", result)
        self.assertGreater(result["thermal_stability"]["melting_temperature_c"], 40)


@unittest.skipUnless(HAS_NUMERICS, "numpy and scipy required")
class ClinicalPortTests(unittest.TestCase):
    def test_vcog_grades_from_numeric_bands(self):
        result = MODULES["compute_clinical"].HANDLERS["grade_adverse_events_using_vcog_ctcae"](MODULES["compute_clinical"].TOOLS["grade_adverse_events_using_vcog_ctcae"]["example"])
        self.assertEqual([event["vcog_grade"] for event in result["graded_events"]], [3, 2, 1])

    def test_mwas_detects_true_association(self):
        result = MODULES["compute_clinical"].HANDLERS["perform_mwas_cyp2c19_metabolizer_status"](MODULES["compute_clinical"].TOOLS["perform_mwas_cyp2c19_metabolizer_status"]["example"])
        self.assertLess(result["all_results"][0]["p_value"], 1e-3)
        self.assertGreater(result["all_results"][1]["p_value"], 0.05)
        self.assertLessEqual(result["significant_cpg_count"], 1)

    def test_xenograft_tgi_matches_definition(self):
        result = MODULES["compute_clinical"].HANDLERS["analyze_xenograft_tumor_growth_inhibition"](MODULES["compute_clinical"].TOOLS["analyze_xenograft_tumor_growth_inhibition"]["example"])
        self.assertLess(abs(result["tumor_growth_inhibition_percent"]["treated"] - 56.897), 0.1)
        self.assertLess(result["two_way_anova"]["group"]["p_value"], 0.05)

    def test_dosimetry_scales_with_s_factors(self):
        result = MODULES["compute_clinical"].HANDLERS["estimate_alpha_particle_radiotherapy_dosimetry"](MODULES["compute_clinical"].TOOLS["estimate_alpha_particle_radiotherapy_dosimetry"]["example"])
        self.assertIn("tumor", result["absorbed_doses_gy_per_mbq"])
        self.assertGreater(result["absorbed_doses_gy_per_mbq"]["tumor"], 0)
        self.assertIn("liver", result["tumor_to_organ_dose_ratios"])


@unittest.skipUnless(HAS_NUMERICS, "numpy and scipy required")
class OmicsPortTests(unittest.TestCase):
    def test_region_overlap_uses_union_base_counts(self):
        result = MODULES["compute_omics"].HANDLERS["analyze_genomic_region_overlap"](MODULES["compute_omics"].TOOLS["analyze_genomic_region_overlap"]["example"])
        pair = result["pairwise"][0]
        self.assertEqual(pair["overlap_bp_union"], 250)  # chr1 200-300 + 500-600, chr2 100-150
        self.assertAlmostEqual(pair["percent_of_set_1"], 250 / 700 * 100, places=6)

    def test_region_overlap_rejects_inverted_intervals(self):
        with self.assertRaisesRegex(ValueError, "start < end"):
            MODULES["compute_omics"].HANDLERS["analyze_genomic_region_overlap"](
                {"region_sets": [{"name": "a", "regions": [{"chromosome": "chr1", "start": 100, "end": 50}]},
                                 {"name": "b", "regions": [{"chromosome": "chr1", "start": 0, "end": 10}]}]})

    def test_nmf_is_seed_deterministic(self):
        arguments = MODULES["compute_omics"].TOOLS["perform_gene_expression_nmf_analysis"]["example"]
        first = MODULES["compute_omics"].HANDLERS["perform_gene_expression_nmf_analysis"](json.loads(json.dumps(arguments)))
        second = MODULES["compute_omics"].HANDLERS["perform_gene_expression_nmf_analysis"](json.loads(json.dumps(arguments)))
        self.assertEqual(first["metagenes"], second["metagenes"])

    def test_genomic_prediction_reports_heritability_bounds(self):
        result = MODULES["compute_omics"].HANDLERS["fit_genomic_prediction_model"](MODULES["compute_omics"].TOOLS["fit_genomic_prediction_model"]["example"])
        self.assertTrue(0 < result["heritability"] < 1)
        self.assertEqual(len(result["breeding_values"]), 6)
        with self.assertRaisesRegex(ValueError, "0, 1, or 2"):
            MODULES["compute_omics"].HANDLERS["fit_genomic_prediction_model"]({"genotypes": [[0, 1.5], [1, 0], [2, 1]], "phenotypes": [1.0, 2.0, 3.0]})


if __name__ == "__main__":
    unittest.main()
