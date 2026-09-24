"""Curated scientific scope metadata, independent of runtime availability.

This module performs no dependency discovery, computation, I/O or promotion.
Evidence entries identify source and test definitions; they are not run receipts.
"""
from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from typing import Any


SCHEMA_VERSION = "proto.compute-maturity.v1"
METHOD_STAGES = frozenset({"method-implementation", "numerical-reference-tested", "demonstration", "heuristic"})


def _evidence(kind: str, path: str, scope: str, *test_ids: str) -> dict[str, Any]:
    entry: dict[str, Any] = {"kind": kind, "path": path, "scope": scope,
                             "execution_status": "not-evaluated-here"}
    if test_ids:
        entry["test_ids"] = list(test_ids)
    return entry


_STATISTICS_TESTS = {
    "descriptive_statistics": ["ComputeStatsNumericalTests.test_sample_statistics_known_answer"],
    "compare_two_groups": ["ComputeStatsNumericalTests.test_welch_and_student_statistics_and_degrees_of_freedom",
                           "ComputeStatsNumericalTests.test_paired_t_test_matches_closed_form_t3_tail",
                           "ComputeStatsNumericalTests.test_mann_whitney_matches_normal_tail_and_continuity_correction"],
    "correlation": ["ComputeStatsNumericalTests.test_pearson_spearman_and_regression_known_answers"],
    "linear_regression": ["ComputeStatsNumericalTests.test_pearson_spearman_and_regression_known_answers"],
    "one_way_anova": ["ComputeStatsNumericalTests.test_anova_matches_closed_form_f_2_6_tail"],
    "adjust_pvalues": ["ComputeStatsNumericalTests.test_multiple_testing_known_answers_original_order_and_ties"],
    "principal_component_analysis": ["ComputeStatsNumericalTests.test_pca_covariance_and_sample_standardization_known_answers"],
    "contingency_test": ["ComputeStatsNumericalTests.test_chi_square_matches_erfc_tail",
                         "ComputeStatsNumericalTests.test_fisher_exact_matches_combinatorial_hypergeometric_tail"],
}

_INFERENCE_TESTS = {
    "compare_two_groups": ["InferenceNumericalTests.test_paired_two_observation_interval_uses_exact_cauchy_quantile",
                           "InferenceNumericalTests.test_student_interval_tabulated_t4_and_gamma_correction_closed_form",
                           "InferenceNumericalTests.test_welch_unequal_sizes_and_variances_matches_reference_result_interval",
                           "InferenceNumericalTests.test_mann_whitney_tie_effect_is_pairwise_probability_difference"],
    "correlation": ["InferenceNumericalTests.test_pearson_zero_correlation_interval_known_normal_quantile",
                    "InferenceNumericalTests.test_pearson_interval_matches_scipy_reference_at_nonsymmetric_correlation",
                    "InferenceNumericalTests.test_perfect_tiny_and_rank_correlations_do_not_report_zero_uncertainty"],
}

_OVERRIDES = {
    "analyze_rnaseq_study": {
        "method_stage": "method-implementation",
        "applicability": ["Raw integer counts with explicitly identified samples and a full-rank condition, batch-plus-condition or subject-plus-condition design. Fit mode invokes the configured local DESeq2 adapter."],
        "known_limitations": ["Replication and rank checks do not prove sample independence or absence of confounding.", "PCA uses transformed values without batch-effect removal. Unavailable p-values remain missing; no LFC shrinkage is performed.", "Enrichment uses only supplied gene sets and an explicit finite-adjusted-p-value universe. Local software checks do not establish scientific validity."],
        "evidence": [_evidence("implementation-source", "src/proto_agent/compute_rnaseq.py", "Source-bound orchestration of raw-count validation, the existing fixed DESeq2 engine and offline ORA."),
                     _evidence("behavioral-test-definition", "tests/test_rnaseq_data.py", "Raw count/sample identity and fixed design validation; not a biological benchmark.")],
    },
    "import_colabfold_result": {
        "method_stage": "method-implementation",
        "applicability": ["Import of existing local ColabFold single-model PDB and per-model scores JSON, bounded to 384 residues and a 4 MiB result artifact."],
        "known_limitations": [
            "Imports existing output files; no prediction engine, MSA search or GPU job is executed.",
            "Matching residue counts and pLDDT values establish content consistency, not shared prediction-run provenance or experimental accuracy.",
            "Requires the explicit importer profile; unsupported structures are rejected rather than silently remapped.",
        ],
        "evidence": [
            _evidence("implementation-source", "src/proto_agent/compute_structure_prediction.py", "Source hashes, explicit residue mapping and confidence shape/range checks."),
            _evidence("behavioral-test-definition", "tests/test_structure_prediction_import.py", "Local import format and rejection contracts; not prediction accuracy validation."),
        ],
    },
    "fit_genomic_prediction_model": {
        "method_stage": "demonstration",
        "applicability": ["Exploration of additive or additive-plus-dominance genomic relationship models on supplied complete 0/1/2 allele-count matrices."],
        "known_limitations": [
            "The variance-component loop runs five fixed REML-style iterations; it does not establish convergence to a REML estimate.",
            "Reported prediction accuracy is in-sample correlation, without cross-validation or held-out generalization evidence.",
            "Fixed-effect covariates are not accepted; missing genotypes require preprocessing outside this method.",
        ],
        "evidence": [
            _evidence("implementation-source", "src/proto_agent/compute_omics.py", "fit_genomic_prediction_model: fixed iteration loop and declared output limitations."),
            _evidence("behavioral-test-definition", "tests/test_compute_ports.py", "Bounds, output length and genotype rejection only; not prediction accuracy or convergence.",
                      "OmicsPortTests.test_genomic_prediction_reports_heritability_bounds"),
        ],
    },
    "bayesian_finemapping_with_deep_vi": {
        "method_stage": "demonstration",
        "applicability": ["Inspection of the adapted seeded variational encoder on supplied z-scores and LD matrices."],
        "known_limitations": [
            "The likelihood and inclusion scores are uncalibrated; reported PIPs are not established Bayesian posterior probabilities.",
            "PIPs can collapse toward zero. A trivial credible set is not evidence that no causal variant exists.",
            "The set uses cumulative raw PIPs without guaranteed normalization or coverage; LD harmonization and calibration remain unestablished.",
        ],
        "evidence": [
            _evidence("implementation-source", "src/proto_agent/compute_ml.py", "bayesian_finemapping_with_deep_vi: ELBO transcription, raw cumulative scores and declared collapse limitation."),
            _evidence("behavioral-test-definition", "tests/test_compute_batch3.py", "Seed repeatability only; no posterior calibration or credible-set coverage check.",
                      "HeavyDependencyTests.test_fine_mapping_is_seeded"),
        ],
    },
    "grade_adverse_events_using_vcog_ctcae": {
        "method_stage": "heuristic",
        "applicability": ["Review of veterinary adverse-event records using the bundled subset of VCOG-CTCAE v1.1 numeric bands and caller-reported severity."],
        "known_limitations": [
            "This is a veterinary table adaptation, not human CTCAE grading or clinical validation.",
            "Missing or unmatched numeric criteria and unrecognized symptoms can fall back to reported severity; the fallback is not an independently established grade.",
            "The bundled subset does not establish complete scale coverage. A reported grade does not establish clinical appropriateness.",
        ],
        "evidence": [
            _evidence("implementation-source", "src/proto_agent/compute_clinical.py", "grade_adverse_events_using_vcog_ctcae: subset tables and severity fallbacks."),
            _evidence("behavioral-test-definition", "tests/test_compute_ports.py", "Three example numeric-band outputs; not clinical sensitivity, specificity or complete table validation.",
                      "ClinicalPortTests.test_vcog_grades_from_numeric_bands"),
        ],
    },
    "analyze_accelerated_stability_of_pharmaceutical_formulations": {
        "method_stage": "heuristic",
        "applicability": ["Illustrative formulation-screening scenarios using fixed temperature, humidity and dosage-form rules."],
        "known_limitations": [
            "Uses an illustrative decay constant of 0.001/day and temperature doubling per 10 C, rather than fitting measured stability data.",
            "Physical scores and stable/unstable labels use fixed surrogate thresholds; results do not establish shelf life or formulation safety.",
        ],
        "evidence": [_evidence("implementation-source", "src/proto_agent/compute_assay.py", "analyze_accelerated_stability_of_pharmaceutical_formulations: fixed constants and threshold scoring.")],
    },
    "predict_o_glycosylation_hotspots": {
        "method_stage": "heuristic",
        "applicability": ["Candidate S/T-rich sequence windows for human review."],
        "known_limitations": [
            "Local S/T density and optional adjacent-proline suppression are unvalidated heuristics.",
            "Candidate sites are not calibrated probabilities or confirmed post-translational modifications.",
        ],
        "evidence": [_evidence("implementation-source", "src/proto_agent/compute_bio.py", "predict_o_glycosylation_hotspots: local sequence-density rule and declared scope.")],
    },
    "analyze_abr_waveform_p1_metrics": {
        "method_stage": "heuristic",
        "applicability": ["P1 amplitude and latency extraction from a supplied waveform using a fixed search window."],
        "known_limitations": [
            "The fixed-window P1 heuristic does not assess waveform quality, electrode placement or diagnostic validity.",
            "Successful extraction does not establish that the selected peak is physiologically appropriate for the sample.",
        ],
        "evidence": [_evidence("implementation-source", "src/proto_agent/compute_assay.py", "analyze_abr_waveform_p1_metrics: fixed-latency-window search and declared limits.")],
    },
}


def maturity_for(tool_name: str, metadata: Mapping[str, Any]) -> dict[str, Any]:
    """Return fresh JSON-native scope metadata for one exact registry ID.

    Metadata keys such as availability, validation or implementation provenance
    are deliberately not accepted as evidence of scientific maturity. No caller
    value can promote a method; only explicit reviewed mappings below specialize
    the conservative default. Test status must come from a separate run receipt.
    """
    if not isinstance(tool_name, str) or not tool_name or tool_name.strip() != tool_name:
        raise ValueError("tool_name must be a nonempty trimmed registry identifier.")
    if not isinstance(metadata, Mapping):
        raise ValueError("metadata must be a registry metadata mapping.")
    result: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "method_stage": "method-implementation",
        "scientific_validation": "not-established",
        "domain_validation": "not-established",
        "applicability": ["Use within the method's declared input contract and assumptions; review suitability for the target dataset separately."],
        "known_limitations": ["No method-specific validation assessment is recorded in this maturity inventory; runtime success does not establish scientific validity."],
        "evidence": [],
        "assessment_basis": "Curated implementation and test-definition inventory; not a live verification or acceptance receipt.",
        "availability_is_separate": True,
        "automatic_promotion": False,
    }
    if tool_name in _STATISTICS_TESTS:
        result.update({
            "method_stage": "numerical-reference-tested",
            "applicability": ["Standard statistical calculations on supplied observations satisfying the selected method's sampling and distributional assumptions."],
            "known_limitations": ["Analytic and reference checks cover specified numerical cases, not validity for a particular biological, clinical or experimental dataset.",
                                  "The evidence paths identify test definitions; execution success for this source/runtime requires a separate test receipt."],
            "evidence": [_evidence("numerical-reference-test-definition", "tests/test_compute_stats.py", "Independent known answers and numeric boundary cases for this statistical method.", *_STATISTICS_TESTS[tool_name])],
        })
        if tool_name in _INFERENCE_TESTS:
            result["evidence"].append(_evidence("numerical-reference-test-definition", "tests/test_compute_inference.py",
                                               "Confidence interval and effect-size reference cases, including explicit unsupported intervals.", *_INFERENCE_TESTS[tool_name]))
    if tool_name in _OVERRIDES:
        result.update(_OVERRIDES[tool_name])
    return deepcopy(result)
