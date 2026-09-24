"""Independent identities, design estimability, and raw CSV boundary tests."""
from __future__ import annotations

import csv
import io
import json
import unittest
from unittest.mock import patch

from proto_agent import rnaseq_data
from proto_agent.rnaseq_data import parse_rnaseq_inputs


def csv_bytes(rows):
    stream = io.StringIO(newline="")
    csv.writer(stream, lineterminator="\n").writerows(rows)
    return stream.getvalue().encode("utf-8")


COUNT_ROWS = [
    ["gene_id", "sample-1", "sample-2", "sample-3", "sample-4"],
    ["gene-z", 0, 3, 1, 2],
    ["gene-a", 5, 0, 9, 0],
    ["gene-zero", 0, 0, 0, 0],
]
SAMPLE_ROWS = [
    ["sample", "condition"],
    ["sample-1", "control"], ["sample-2", "control"],
    ["sample-3", "treated"], ["sample-4", "treated"],
]


class RnaseqDataTests(unittest.TestCase):
    def parse(self, counts=None, samples=None, **kwargs):
        return parse_rnaseq_inputs(
            csv_bytes(COUNT_ROWS) if counts is None else counts,
            csv_bytes(SAMPLE_ROWS) if samples is None else samples,
            **{"reference_level": "control", "comparison_level": "treated", **kwargs},
        )

    def test_known_raw_counts_and_qc_remain_in_original_order(self):
        result = self.parse()
        self.assertEqual(result["gene_ids"], ["gene-z", "gene-a", "gene-zero"])
        self.assertEqual(result["sample_ids"], COUNT_ROWS[0][1:])
        self.assertEqual(result["counts"], [[0, 3, 1, 2], [5, 0, 9, 0], [0, 0, 0, 0]])
        self.assertEqual([item["library_size"] for item in result["qc"]["samples"]], [5, 3, 10, 2])
        self.assertEqual([item["detected_genes"] for item in result["qc"]["samples"]], [1, 1, 2, 1])
        self.assertEqual([item["zero_fraction"] for item in result["qc"]["samples"]], [2/3, 2/3, 1/3, 2/3])
        self.assertEqual(result["qc"]["all_zero_genes"], ["gene-zero"])
        self.assertEqual(result["qc"]["condition_counts"], {"control": 2, "treated": 2})
        self.assertFalse(result["qc"]["metadata_reordered"])
        self.assertEqual(result["design"]["columns"], ["(Intercept)", "condition[T.treated]"])
        self.assertEqual(result["design"]["rank"], 2)
        self.assertEqual(result["design"]["residual_df"], 2)
        self.assertEqual(result["design"]["contrast"], {"factor": "condition", "numerator": "treated", "denominator": "control"})
        self.assertTrue(any("All-zero" in warning for warning in result["warnings"]))
        self.assertEqual(json.loads(json.dumps(result)), result)

    def test_metadata_permutation_is_explicit_and_does_not_reorder_counts(self):
        permutation = [SAMPLE_ROWS[0], SAMPLE_ROWS[4], SAMPLE_ROWS[2], SAMPLE_ROWS[1], SAMPLE_ROWS[3]]
        result = self.parse(samples=csv_bytes(permutation))
        self.assertTrue(result["qc"]["metadata_reordered"])
        self.assertEqual([item["sample"] for item in result["samples"]], COUNT_ROWS[0][1:])
        self.assertEqual(result["counts"][0], [0, 3, 1, 2])
        self.assertTrue(any("explicitly reordered" in warning for warning in result["warnings"]))

    def test_bom_unicode_and_quoted_identity_preservation(self):
        samples = [["sample", "condition"], ["α,1", "对照"], ["β\"2", "对照"], ["γ3", "处理"], ["δ4", "处理"]]
        counts = [["gene_id", "α,1", "β\"2", "γ3", "δ4"], ["基因,甲", 1, 2, 3, 4], ["基因\"乙", 2, 3, 4, 5]]
        result = self.parse(counts=b"\xef\xbb\xbf" + csv_bytes(counts), samples=b"\xef\xbb\xbf" + csv_bytes(samples),
                            reference_level="对照", comparison_level="处理")
        self.assertEqual(result["gene_ids"], ["基因,甲", "基因\"乙"])
        self.assertEqual(result["sample_ids"], ["α,1", "β\"2", "γ3", "δ4"])
        self.assertEqual(result["design"]["factor_levels"], {"condition": ["对照", "处理"]})

    def test_valid_batch_design_uses_count_order_for_covariate_levels(self):
        samples = [SAMPLE_ROWS[0] + ["batch", "subject"]] + [
            SAMPLE_ROWS[1] + ["z", "p1"], SAMPLE_ROWS[2] + ["a", "p2"],
            SAMPLE_ROWS[3] + ["z", "p1"], SAMPLE_ROWS[4] + ["a", "p2"],
        ]
        samples = [samples[0], samples[2], samples[1], samples[4], samples[3]]
        result = self.parse(samples=csv_bytes(samples), design="batch_condition")
        self.assertEqual(result["design"]["formula"], "~batch+condition")
        self.assertEqual(result["design"]["factor_levels"]["batch"], ["z", "a"])
        self.assertEqual(result["design"]["columns"], ["(Intercept)", "batch[T.a]", "condition[T.treated]"])
        self.assertEqual(result["design"]["rank"], 3)
        self.assertEqual(result["design"]["residual_df"], 1)
        self.assertEqual(result["qc"]["samples"][0]["batch"], "z")
        self.assertEqual(result["qc"]["samples"][0]["subject"], "p1")
        self.assertTrue(any("'subject'" in warning and "not included" in warning for warning in result["warnings"]))

    def test_valid_paired_design(self):
        samples = [SAMPLE_ROWS[0] + ["subject"]] + [
            row + [subject] for row, subject in zip(SAMPLE_ROWS[1:], ["p2", "p1", "p2", "p1"])
        ]
        result = self.parse(samples=csv_bytes(samples), design="subject_condition")
        self.assertEqual(result["design"]["formula"], "~subject+condition")
        self.assertEqual(result["design"]["columns"], ["(Intercept)", "subject[T.p1]", "condition[T.treated]"])
        self.assertEqual(result["design"]["rank"], 3)
        self.assertEqual(result["design"]["residual_df"], 1)

    def test_reference_and_additional_conditions_have_deterministic_levels(self):
        counts = [["gene_id", "r1", "r2", "t1", "t2", "other"], ["a", 1, 2, 3, 4, 5], ["b", 1, 2, 3, 4, 5]]
        samples = [["sample", "condition"], ["r1", "z-reference"], ["r2", "z-reference"],
                   ["t1", "m-comparison"], ["t2", "m-comparison"], ["other", "a-other"]]
        result = self.parse(counts=csv_bytes(counts), samples=csv_bytes(samples),
                            reference_level="z-reference", comparison_level="m-comparison")
        self.assertEqual(result["design"]["factor_levels"]["condition"], ["z-reference", "a-other", "m-comparison"])
        self.assertEqual(result["design"]["columns"], ["(Intercept)", "condition[T.a-other]", "condition[T.m-comparison]"])
        self.assertEqual(result["qc"]["condition_counts"], {"z-reference": 2, "m-comparison": 2, "a-other": 1})
        self.assertEqual(result["qc"]["sample_count"], 5)
        self.assertEqual(result["design"]["residual_df"], 2)
        self.assertTrue(any("'a-other' (1 samples)" in warning for warning in result["warnings"]))

    def test_confounded_batch_and_subject_are_rejected(self):
        for covariate in ("batch", "subject"):
            with self.subTest(covariate=covariate):
                samples = [SAMPLE_ROWS[0] + [covariate]] + [
                    row + [level] for row, level in zip(SAMPLE_ROWS[1:], ["a", "a", "b", "b"])
                ]
                with self.assertRaisesRegex(ValueError, "rank deficient.*confounded"):
                    self.parse(samples=csv_bytes(samples), design=covariate + "_condition")

    def test_full_rank_without_residual_degrees_of_freedom_is_rejected(self):
        samples = [SAMPLE_ROWS[0] + ["subject"]] + [
            row + [subject] for row, subject in zip(SAMPLE_ROWS[1:], ["p1", "p2", "p1", "p3"])
        ]
        with self.assertRaisesRegex(ValueError, "no positive residual degrees of freedom"):
            self.parse(samples=csv_bytes(samples), design="subject_condition")

    def test_requested_covariate_requires_column_and_multiple_levels(self):
        for covariate in ("batch", "subject"):
            with self.subTest(covariate=covariate):
                with self.assertRaisesRegex(ValueError, "requires the"):
                    self.parse(design=covariate + "_condition")
                samples = [SAMPLE_ROWS[0] + [covariate]] + [row + ["same"] for row in SAMPLE_ROWS[1:]]
                with self.assertRaisesRegex(ValueError, "at least two .* levels"):
                    self.parse(samples=csv_bytes(samples), design=covariate + "_condition")

    def test_contrast_levels_must_be_distinct_present_and_replicated(self):
        for options in ({"reference_level": "treated"}, {"comparison_level": "missing"}, {"reference_level": "missing"}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.parse(**options)
        samples = [SAMPLE_ROWS[0], SAMPLE_ROWS[1], ["sample-2", "other"], SAMPLE_ROWS[3], SAMPLE_ROWS[4]]
        with self.assertRaisesRegex(ValueError, "Reference.*at least two"):
            self.parse(samples=csv_bytes(samples))
        samples = [SAMPLE_ROWS[0], SAMPLE_ROWS[1], SAMPLE_ROWS[2], SAMPLE_ROWS[3], ["sample-4", "other"]]
        with self.assertRaisesRegex(ValueError, "Comparison.*at least two"):
            self.parse(samples=csv_bytes(samples))

    def test_raw_integer_tokens_reject_fractional_nonfinite_boolean_and_coercion(self):
        for token in ("1.0", "-1", "+1", "1e2", "NaN", "nan", "Inf", "True", "false", "", " ", " 1", "1 ", "１", "١", "1_000", "0x10", "1\x00"):
            with self.subTest(token=token):
                counts = [row.copy() for row in COUNT_ROWS]
                counts[1][1] = token
                with self.assertRaisesRegex(ValueError, "ASCII decimal integer"):
                    self.parse(counts=csv_bytes(counts))

    def test_integer_upper_bound_and_leading_zero_tokens(self):
        counts = [row.copy() for row in COUNT_ROWS]
        counts[1][1] = "0002147483647"
        counts[1][2] = "0" * 5_000 + "3"
        result = self.parse(counts=csv_bytes(counts))
        self.assertEqual(result["counts"][0][:2], [2_147_483_647, 3])
        counts[1][1] = "2147483648"
        with self.assertRaisesRegex(ValueError, "exceeds 2147483647"):
            self.parse(counts=csv_bytes(counts))
        counts[1][1] = "9" * 5_000
        with self.assertRaisesRegex(ValueError, "exceeds 2147483647"):
            self.parse(counts=csv_bytes(counts))

    def test_duplicate_headers_genes_and_samples_are_rejected(self):
        bad_counts = [row.copy() for row in COUNT_ROWS]
        bad_counts[0][2] = bad_counts[0][1]
        with self.assertRaisesRegex(ValueError, "duplicate header"):
            self.parse(counts=csv_bytes(bad_counts))
        bad_counts = [row.copy() for row in COUNT_ROWS]
        bad_counts[2][0] = bad_counts[1][0]
        with self.assertRaisesRegex(ValueError, "duplicate gene"):
            self.parse(counts=csv_bytes(bad_counts))
        bad_samples = [row.copy() for row in SAMPLE_ROWS]
        bad_samples[2][0] = bad_samples[1][0]
        with self.assertRaisesRegex(ValueError, "duplicate sample"):
            self.parse(samples=csv_bytes(bad_samples))
        with self.assertRaisesRegex(ValueError, "duplicate header"):
            self.parse(samples=csv_bytes([["sample", "condition", "condition"]]))

    def test_strict_header_contract(self):
        for header in (["Gene_id"] + COUNT_ROWS[0][1:], ["gene"] + COUNT_ROWS[0][1:]):
            with self.subTest(header=header), self.assertRaisesRegex(ValueError, "exactly gene_id"):
                self.parse(counts=csv_bytes([header] + COUNT_ROWS[1:]))
        for header in (["condition", "sample"], ["sample", "group"], ["sample", "condition", "unknown"], ["sample"]):
            with self.subTest(header=header), self.assertRaisesRegex(ValueError, "headers must begin"):
                self.parse(samples=csv_bytes([header] + SAMPLE_ROWS[1:]))

    def test_labels_reject_empty_whitespace_controls_and_oversize(self):
        for label in ("", " leading", "trailing ", "tab\tx", "line\nx", "null\x00x", "del\x7fx", "bidi\u202ex", "zero\u200bx", "x" * 101):
            with self.subTest(label=repr(label)):
                counts = [row.copy() for row in COUNT_ROWS]
                counts[1][0] = label
                with self.assertRaisesRegex(ValueError, "printable characters"):
                    self.parse(counts=csv_bytes(counts))
                samples = [row.copy() for row in SAMPLE_ROWS]
                samples[1][1] = label
                with self.assertRaisesRegex(ValueError, "printable characters"):
                    self.parse(samples=csv_bytes(samples))
                with self.assertRaisesRegex(ValueError, "printable characters"):
                    self.parse(reference_level=label)

    def test_labels_at_limit_and_reserved_looking_ids_are_preserved(self):
        counts = [row.copy() for row in COUNT_ROWS]
        counts[1][0] = "x" * 100
        counts[2][0] = "__proto__"
        counts[3][0] = "constructor"
        result = self.parse(counts=csv_bytes(counts))
        self.assertEqual(result["gene_ids"], ["x" * 100, "__proto__", "constructor"])

    def test_metadata_missing_or_extra_sample_is_not_dropped(self):
        for rows in (SAMPLE_ROWS[:-1], SAMPLE_ROWS + [["extra", "treated"]],
                     SAMPLE_ROWS[:-1] + [["extra", "treated"]]):
            with self.subTest(rows=rows), self.assertRaisesRegex(ValueError, "match count sample IDs exactly"):
                self.parse(samples=csv_bytes(rows))

    def test_row_lengths_empty_rows_and_malformed_csv_are_rejected(self):
        for rows in ([COUNT_ROWS[0], COUNT_ROWS[1][:-1], *COUNT_ROWS[2:]],
                     [COUNT_ROWS[0], COUNT_ROWS[1] + [3], *COUNT_ROWS[2:]],
                     [COUNT_ROWS[0], [], *COUNT_ROWS[1:]]):
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                self.parse(counts=csv_bytes(rows))
        for rows in ([SAMPLE_ROWS[0], SAMPLE_ROWS[1][:-1], *SAMPLE_ROWS[2:]],
                     [SAMPLE_ROWS[0], SAMPLE_ROWS[1] + ["extra"], *SAMPLE_ROWS[2:]],
                     [SAMPLE_ROWS[0], [], *SAMPLE_ROWS[1:]]):
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                self.parse(samples=csv_bytes(rows))
        with self.assertRaisesRegex(ValueError, "malformed CSV"):
            self.parse(counts=csv_bytes([COUNT_ROWS[0]]) + b'"unterminated,1,2,3,4\n')

    def test_zero_library_is_rejected_but_zero_gene_rows_are_retained(self):
        counts = [row.copy() for row in COUNT_ROWS]
        for row in counts[1:]:
            row[1] = 0
        with self.assertRaisesRegex(ValueError, "zero library size.*sample-1"):
            self.parse(counts=csv_bytes(counts))
        result = self.parse()
        self.assertEqual(len(result["counts"]), 3)
        self.assertEqual(result["counts"][2], [0, 0, 0, 0])

    def test_minimum_gene_and_sample_counts(self):
        with self.assertRaisesRegex(ValueError, "at least two gene"):
            self.parse(counts=csv_bytes(COUNT_ROWS[:2]))
        with self.assertRaisesRegex(ValueError, "4 to 100 sample"):
            self.parse(counts=csv_bytes([row[:-1] for row in COUNT_ROWS]))
        with self.assertRaisesRegex(ValueError, "at least two gene"):
            self.parse(counts=csv_bytes(COUNT_ROWS[:1]))

    def test_maximum_sample_count_and_metadata_rows(self):
        ids = [f"s{index}" for index in range(101)]
        counts = [["gene_id", *ids], ["a", *([1] * 101)], ["b", *([1] * 101)]]
        samples = [["sample", "condition"], *[[identity, "control" if index < 50 else "treated"] for index, identity in enumerate(ids)]]
        with self.assertRaisesRegex(ValueError, "4 to 100 sample"):
            self.parse(counts=csv_bytes(counts), samples=csv_bytes(samples))
        counts = [row[:-1] for row in counts]
        with self.assertRaisesRegex(ValueError, "limit of 100 rows"):
            self.parse(counts=csv_bytes(counts), samples=csv_bytes(samples))
        result = self.parse(counts=csv_bytes(counts), samples=csv_bytes(samples[:-1]))
        self.assertEqual(result["qc"]["sample_count"], 100)
        self.assertEqual(result["design"]["residual_df"], 98)

    def test_gene_and_cell_limits_are_inclusive_and_checked_before_accepting_extra_row(self):
        self.assertEqual(rnaseq_data.MAX_GENES, 100_000)
        self.assertEqual(rnaseq_data.MAX_CELLS, 2_000_000)
        with patch.object(rnaseq_data, "MAX_GENES", 2):
            self.assertEqual(self.parse(counts=csv_bytes(COUNT_ROWS[:3]))["qc"]["gene_count"], 2)
            with self.assertRaisesRegex(ValueError, "limit of 2 gene rows"):
                self.parse()
        with patch.object(rnaseq_data, "MAX_CELLS", 8):
            self.assertEqual(self.parse(counts=csv_bytes(COUNT_ROWS[:3]))["qc"]["gene_count"], 2)
            with self.assertRaisesRegex(ValueError, "limit of 8 count cells"):
                self.parse()

    def test_file_bytes_utf8_and_empty_input_are_rejected(self):
        for raw in (b"", b"\xff", b"\xef\xbb\xbf", b"\n", "text", True):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                self.parse(counts=raw)
            with self.subTest(samples=raw), self.assertRaises(ValueError):
                self.parse(samples=raw)
        oversized = b"x" * (32 * 1024 * 1024 + 1)
        with self.assertRaisesRegex(ValueError, "1 to 33554432 bytes"):
            self.parse(counts=oversized)
        with self.assertRaisesRegex(ValueError, "1 to 33554432 bytes"):
            self.parse(samples=oversized)

    def test_design_is_an_allowlisted_id_and_cannot_be_an_expression(self):
        for design in ("~condition", "batch", "subject", "condition + batch", "condition;system('x')", [], None, True):
            with self.subTest(design=design), self.assertRaisesRegex(ValueError, "Design must be"):
                self.parse(design=design)


if __name__ == "__main__":
    unittest.main()
