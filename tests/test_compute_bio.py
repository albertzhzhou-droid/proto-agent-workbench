"""Scientific regression cases for bounded Biomni adaptations.

Glycosylation golden cases were checked against unmodified Biomni commit
400c1f366b96a35ca253e13c9b06c5076af41d65. Corrected algorithms have independent
analytic answers; their results do not claim upstream parity.
"""

import importlib.util
import json
import math
import unittest

from proto_agent.compute_bio import (
    HANDLERS, TOOLS, analyze_protein_conservation,
    analyze_rna_secondary_structure_features, find_n_glycosylation_motifs,
    fit_michaelis_menten, gene_set_enrichment_analysis,
    perform_cosinor_analysis, predict_o_glycosylation_hotspots,
)


HAS_SCIENCE = importlib.util.find_spec("numpy") is not None and importlib.util.find_spec("scipy") is not None


class RnaTopologyTests(unittest.TestCase):
    def test_hairpin_loop_is_counted_and_energy_is_not_inferred(self):
        result = analyze_rna_secondary_structure_features({"dot_bracket_structure": "(((...)))", "sequence": "GGGAAACCC"})
        self.assertEqual(result["base_pair_count"], 3)
        self.assertEqual(result["stem_count"], 1)
        self.assertEqual(result["loop_counts"]["hairpin"], 1)
        self.assertEqual(result["loops"], [{"type": "hairpin", "closing_pair": [3, 7], "unpaired_bases": 3}])
        self.assertEqual(result["pair_types"], {"canonical": 3, "wobble": 0, "other": 0})
        self.assertFalse(any("energy" in key for key in result))

    def test_internal_bulge_and_multibranch_loops(self):
        for structure, kind in (("((..((...))..))", "internal"), ("((..((...))))", "bulge"), ("((..((...))..((...))..))", "multibranch")):
            with self.subTest(kind=kind):
                result = analyze_rna_secondary_structure_features({"dot_bracket_structure": structure})
                self.assertEqual(result["loop_counts"][kind], 1)
                self.assertEqual(result["unpaired_bases"], sum(loop["unpaired_bases"] for loop in result["loops"]))

    def test_external_dots_are_not_hairpin_loops(self):
        result = analyze_rna_secondary_structure_features({"dot_bracket_structure": "..((...))....((..)).."})
        self.assertEqual(result["loop_counts"]["hairpin"], 2)
        self.assertEqual(result["external_unpaired_bases"], 8)
        result = analyze_rna_secondary_structure_features({"dot_bracket_structure": "...."})
        self.assertEqual(result["loops"], [])
        self.assertEqual(result["stem_count"], 0)
        self.assertEqual(result["external_unpaired_bases"], 4)

    def test_bracket_types_accept_nested_and_reject_crossing(self):
        self.assertEqual(analyze_rna_secondary_structure_features({"dot_bracket_structure": "([{...}])"})["base_pair_count"], 3)
        for structure in ("([)]", "((.)", "())", "abc", "", "." * 10001):
            with self.subTest(structure=structure[:20]):
                with self.assertRaises(ValueError):
                    analyze_rna_secondary_structure_features({"dot_bracket_structure": structure})

    def test_rna_sequence_length_and_alphabet(self):
        for sequence in ("GGT", "AC", "NAA", "aıu", True):
            with self.subTest(sequence=sequence):
                with self.assertRaises(ValueError):
                    analyze_rna_secondary_structure_features({"dot_bracket_structure": "(.)", "sequence": sequence})


class GlycosylationTests(unittest.TestCase):
    def test_n_sequon_upstream_overlap_and_proline_golden_case(self):
        # Unchanged upstream algorithm: nonoverlapping starts 2,10; overlapping 2,3,10.
        sequence = "MNNSTANPTNAT"
        result = find_n_glycosylation_motifs({"sequence": sequence.lower()})
        self.assertEqual(result["matches"], [{"position": 2, "motif": "NNS"}, {"position": 10, "motif": "NAT"}])
        self.assertEqual([row["position"] for row in find_n_glycosylation_motifs({"sequence": sequence, "allow_overlap": True})["matches"]], [2, 3, 10])
        self.assertEqual(find_n_glycosylation_motifs({"sequence": "NPSNPT"})["count"], 0)

    def test_o_hotspot_upstream_golden_case(self):
        result = predict_o_glycosylation_hotspots({"sequence": "MASSTTAPSTSA", "window": 7, "min_st_fraction": 0.4})
        self.assertEqual([(row["position"], row["st_fraction"], row["window_start"], row["window_end"]) for row in result["candidates"]],
                         [(3, 0.667, 1, 6), (4, 0.571, 1, 7), (5, 0.571, 2, 8), (6, 0.714, 3, 9), (9, 0.571, 6, 12), (10, 0.5, 7, 12), (11, 0.6, 8, 12)])
        self.assertIn("Unvalidated", result["method"])

    def test_o_edge_windows_and_proline_switch(self):
        data = {"sequence": "STSP", "window": 3, "min_st_fraction": 0}
        self.assertEqual([row["position"] for row in predict_o_glycosylation_hotspots(data)["candidates"]], [1, 2])
        self.assertEqual([row["position"] for row in predict_o_glycosylation_hotspots({**data, "disallow_proline_next": False})["candidates"]], [1, 2, 3])

    def test_invalid_inputs_do_not_silently_reset(self):
        for arguments in ({"sequence": "SST", "window": 4}, {"sequence": "SST", "window": True}, {"sequence": "SST", "min_st_fraction": math.nan}, {"sequence": "SST", "min_st_fraction": 1.1}, {"sequence": "SST", "disallow_proline_next": 1}):
            with self.subTest(arguments=arguments), self.assertRaises(ValueError):
                predict_o_glycosylation_hotspots(arguments)
        for sequence in ("", "NA?", "NXS", "N S", "ß", "ﬀ", "ſ", "A" * 10001):
            with self.subTest(sequence=sequence[:20]), self.assertRaises(ValueError):
                find_n_glycosylation_motifs({"sequence": sequence})
        with self.assertRaises(ValueError):
            find_n_glycosylation_motifs({"sequence": "NAT", "allow_overlap": 1})


class ProteinConservationTests(unittest.TestCase):
    def test_ungapped_columns_match_upstream_frequency_definition(self):
        result = analyze_protein_conservation({"aligned_sequences": ["ACD", "ACE", "ACD"]})
        self.assertEqual(result["consensus"], "ACD")
        self.assertEqual([row["conservation_fraction"] for row in result["columns"]], [1, 1, 2 / 3])
        self.assertEqual(result["conserved_positions"], [1, 2])

    def test_gaps_are_not_conserved_residues(self):
        result = analyze_protein_conservation({"aligned_sequences": ["A-C", "A--", "A--"]})
        self.assertEqual(result["consensus"], "A-C")
        all_gap, sparse = result["columns"][1:]
        self.assertEqual(all_gap["conservation_fraction"], 0)
        self.assertIsNone(all_gap["consensus"])
        self.assertIsNone(all_gap["entropy_bits"])
        self.assertEqual(sparse["conservation_fraction"], 1 / 3)
        self.assertEqual(sparse["residue_identity_fraction"], 1)
        self.assertEqual(result["conserved_positions"], [1])

    def test_ties_are_stable_and_entropy_uses_observed_residues(self):
        result = analyze_protein_conservation({"aligned_sequences": ["C", "A"]})
        self.assertEqual(result["consensus"], "A")
        self.assertEqual(result["columns"][0]["entropy_bits"], 1.0)

    def test_reject_unaligned_and_degenerate_inputs(self):
        for sequences in (["AC", "ACD"], ["AC"], ["--", "AC"], ["AX", "AC"], ["ß", "ﬀ"], ["A" * 5001] * 2):
            with self.subTest(lengths=[len(value) for value in sequences]), self.assertRaises(ValueError):
                analyze_protein_conservation({"aligned_sequences": sequences})


@unittest.skipUnless(HAS_SCIENCE, "Install proto-agent[compute] for numeric tests")
class EnrichmentTests(unittest.TestCase):
    def setUp(self):
        self.arguments = {"genes": ["a", "b"], "background": list("abcdefghij"),
                          "gene_sets": [{"name": "pair", "genes": ["a", "b"]}, {"name": "universe", "genes": list("abcdefghij")}, {"name": "none", "genes": ["z"]}]}

    def test_hypergeometric_known_answer_and_bh_before_top_k(self):
        result = gene_set_enrichment_analysis({**self.arguments, "top_k": 1})
        row = result["results"][0]
        self.assertEqual(row["name"], "pair")
        self.assertAlmostEqual(row["p_value"], 1 / math.comb(10, 2))
        self.assertAlmostEqual(row["adjusted_p_value"], 3 / math.comb(10, 2))
        self.assertAlmostEqual(row["fold_enrichment"], 5)
        self.assertEqual(result["tested_gene_sets"], 3)
        self.assertIn("not Enrichr", result["limitations"][0])

    def test_outside_members_and_zero_overlap_remain_in_bh_family(self):
        result = gene_set_enrichment_analysis(self.arguments)
        row = next(row for row in result["results"] if row["name"] == "none")
        self.assertEqual(row["excluded_members_outside_background"], 1)
        self.assertEqual(row["p_value"], 1)
        self.assertIsNone(row["fold_enrichment"])

    def test_duplicate_genes_are_set_members_not_extra_observations(self):
        result = gene_set_enrichment_analysis({**self.arguments, "genes": ["a", "a", "b"], "background": list("abcdefghij") + ["a"]})
        self.assertEqual(result["query_size"], 2)
        self.assertEqual(result["query_duplicates_removed"], 1)
        self.assertEqual(result["background_duplicates_removed"], 1)

    def test_invalid_universe_sets_and_top_k(self):
        for overrides in ({"genes": ["z"]}, {"genes": list("abcdefghij")}, {"background": []}, {"top_k": True}, {"gene_sets": [{"name": "same", "genes": ["a"]}] * 2}, {"gene_sets": [{"name": "x", "genes": ["a b"]}]}):
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                gene_set_enrichment_analysis({**self.arguments, **overrides})


@unittest.skipUnless(HAS_SCIENCE, "Install proto-agent[compute] for numeric tests")
class CosinorTests(unittest.TestCase):
    def test_analytic_positive_amplitude_and_peak(self):
        times = list(range(0, 48, 2))
        values = [10 + 3 * math.cos(2 * math.pi * (time - 18) / 24) for time in times]
        result = perform_cosinor_analysis({"time_data": times, "physiological_data": values, "period": 24})
        self.assertAlmostEqual(result["mesor"], 10)
        self.assertAlmostEqual(result["amplitude"], 3)
        self.assertAlmostEqual(result["peak_time"], 18)
        self.assertAlmostEqual(result["acrophase_radians"], 3 * math.pi / 2)
        self.assertAlmostEqual(result["r_squared"], 1)
        self.assertTrue(all(abs(residual) < 1e-12 for residual in result["residuals"]))

    def test_negative_cosine_means_positive_amplitude_peak_at_half_period(self):
        result = perform_cosinor_analysis({"time_data": [0, 6, 12, 18, 24], "physiological_data": [8, 10, 12, 10, 8], "period": 24})
        self.assertAlmostEqual(result["amplitude"], 2)
        self.assertAlmostEqual(result["peak_time"], 12)

    def test_no_harmonic_signal_has_null_phase(self):
        result = perform_cosinor_analysis({"time_data": list(range(8)), "physiological_data": [1, 2, 1, 2, 1, 2, 1, 2], "period": 8})
        self.assertIsNone(result["peak_time"])
        self.assertIsNone(result["acrophase_radians"])

    def test_clustered_phases_keep_stable_uncertainty(self):
        # A narrow time window is ill-conditioned but remains within the allowed
        # bound. Inverting X.T @ X used to understate the first two errors by 30x.
        import numpy as np
        from scipy.linalg import qr, solve_triangular
        times = [0, 0.0001, 0.0002, 0.0003]
        result = perform_cosinor_analysis({"time_data": times, "physiological_data": [1, 2, 3, 4], "period": 24})
        angles = np.asarray(times) * (2 * np.pi / 24)
        design = np.column_stack((np.ones(4), np.cos(angles), np.sin(angles)))
        _, triangular = qr(design, mode="economic")
        triangular_inverse = solve_triangular(triangular, np.eye(3))
        variance = sum(value ** 2 for value in result["residuals"])
        expected = np.sqrt(np.diag(triangular_inverse @ triangular_inverse.T) * variance)
        np.testing.assert_allclose(result["coefficient_standard_errors"], expected, rtol=1e-6)
        self.assertGreater(result["coefficient_standard_errors"][0], 0.1)

    def test_rank_deficient_constant_boolean_nonfinite_and_bad_period(self):
        base = {"time_data": [0, 6, 12, 18], "physiological_data": [1, 2, 3, 2], "period": 24}
        for overrides in ({"time_data": [0, 24, 48, 72]}, {"physiological_data": [1] * 4}, {"physiological_data": [True, 2, 3, 4]}, {"physiological_data": [1, 2, math.inf, 4]}, {"period": 0}, {"period": True}, {"time_data": [0, 6, 12]}):
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                perform_cosinor_analysis({**base, **overrides})


@unittest.skipUnless(HAS_SCIENCE, "Install proto-agent[compute] for numeric tests")
class MichaelisMentenTests(unittest.TestCase):
    def setUp(self):
        substrates = [0, 1, 2, 4, 8, 16, 32]
        self.arguments = {"substrate_concentrations": substrates, "velocities": [12 * value / (4 + value) for value in substrates], "substrate_unit": "relative concentration", "velocity_unit": "relative rate"}

    def test_known_vmax_km_units_and_no_fabricated_measurements(self):
        result = fit_michaelis_menten(self.arguments)
        self.assertAlmostEqual(result["vmax"], 12, places=5)
        self.assertAlmostEqual(result["km"], 4, places=5)
        self.assertAlmostEqual(result["r_squared"], 1)
        self.assertEqual(result["substrate_unit"], self.arguments["substrate_unit"])
        self.assertEqual(result["velocity_unit"], self.arguments["velocity_unit"])
        self.assertNotIn("kcat", result)
        self.assertEqual(result["n"], len(self.arguments["velocities"]))
        self.assertTrue(all(abs(residual) < 1e-6 for residual in result["residuals"]))

    def test_input_scale_changes_units_consistently(self):
        result = fit_michaelis_menten({**self.arguments, "substrate_concentrations": [value * 1000 for value in self.arguments["substrate_concentrations"]], "velocities": [value * 0.1 for value in self.arguments["velocities"]]})
        self.assertAlmostEqual(result["vmax"], 1.2, places=5)
        self.assertAlmostEqual(result["km"], 4000, places=2)

    def test_missing_measured_velocities_and_invalid_data_rejected(self):
        for overrides in ({"velocities": None}, {"velocities": [1] * 7}, {"velocities": [-1, 2, 3, 4, 5, 6, 7]}, {"velocities": [True, 2, 3, 4, 5, 6, 7]}, {"substrate_concentrations": [1] * 7}, {"substrate_concentrations": [1, 2, 3, 4]}, {"substrate_unit": ""}):
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                fit_michaelis_menten({**self.arguments, **overrides})

    def test_extreme_dynamic_range_rejected_without_runtime_warning(self):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("error", RuntimeWarning)
            with self.assertRaises(ValueError):
                fit_michaelis_menten({"substrate_concentrations": [1e-320, 2e-320, 3e-320, 1e100], "velocities": [1, 2, 3, 4]})


class RegistryTests(unittest.TestCase):
    def test_metadata_and_examples_are_json_native(self):
        self.assertEqual(set(TOOLS), set(HANDLERS))
        for name, tool in TOOLS.items():
            with self.subTest(name=name):
                self.assertFalse(tool["input_schema"]["additionalProperties"])
                self.assertTrue(tool["upstream_functions"])
                if tool["dependency"] and not HAS_SCIENCE:
                    continue
                json.dumps(HANDLERS[name](tool["example"]), allow_nan=False)
        self.assertEqual(TOOLS["fit_michaelis_menten"]["implementation"], "proto-native")


if __name__ == "__main__":
    unittest.main()
