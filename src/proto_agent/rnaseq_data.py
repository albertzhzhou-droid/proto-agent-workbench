"""Strict, bounded raw-count and sample-metadata inputs for RNA-seq studies.

This module validates supplied data; it performs no normalization, gene filtering,
sample exclusion, statistical fitting, filesystem access, or network access.
"""
from __future__ import annotations

from collections import Counter
import csv
import io
import re
from typing import Iterator


MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_GENES = 100_000
MAX_SAMPLES = 100
MAX_CELLS = 2_000_000
MAX_LABEL_CHARS = 100
MAX_COUNT = 2_147_483_647
_COUNT_TOKEN = re.compile(r"[0-9]+\Z")
_DESIGNS = {
    "condition": ("~condition", None),
    "batch_condition": ("~batch+condition", "batch"),
    "subject_condition": ("~subject+condition", "subject"),
}


def _label(value: object, context: str) -> str:
    if (not isinstance(value, str) or not 1 <= len(value) <= MAX_LABEL_CHARS
            or value != value.strip() or not value.isprintable()):
        raise ValueError(
            f"{context} must contain 1 to {MAX_LABEL_CHARS} printable characters "
            "without outer whitespace or control characters."
        )
    return value


def _rows(raw: bytes, context: str) -> Iterator[list[str]]:
    if not isinstance(raw, bytes):
        raise ValueError(f"{context} must be supplied as bytes.")
    if not raw or len(raw) > MAX_FILE_BYTES:
        raise ValueError(f"{context} must contain 1 to {MAX_FILE_BYTES} bytes.")
    try:
        decoded = raw.decode("utf-8-sig", errors="strict")
    except UnicodeDecodeError as exc:
        raise ValueError(f"{context} must be valid UTF-8 CSV (an initial BOM is allowed).") from exc
    reader = csv.reader(io.StringIO(decoded, newline=""), strict=True)
    try:
        for row in reader:
            if not row:
                raise ValueError(f"{context} contains an empty row near line {reader.line_num}.")
            yield row
    except csv.Error as exc:
        raise ValueError(f"{context} is malformed CSV near line {reader.line_num}: {exc}") from exc


def _header(rows: Iterator[list[str]], context: str) -> list[str]:
    header = next(rows, None)
    if header is None:
        raise ValueError(f"{context} needs a header and data rows.")
    for entry in header:
        _label(entry, f"{context} header")
    if len(header) != len(set(header)):
        raise ValueError(f"{context} contains duplicate header names.")
    return header


def _count(token: str, gene: str, sample: str) -> int:
    if not _COUNT_TOKEN.fullmatch(token):
        raise ValueError(
            f"Count for gene {gene!r}, sample {sample!r} must be an ASCII decimal "
            f"integer between 0 and {MAX_COUNT}; no coercion is performed."
        )
    # Compare significant digits before conversion, including for very long tokens
    # with leading zeros; this avoids Python's configurable integer-string limit.
    significant = token.lstrip("0") or "0"
    if len(significant) > 10 or (len(significant) == 10 and significant > str(MAX_COUNT)):
        raise ValueError(f"Count for gene {gene!r}, sample {sample!r} exceeds {MAX_COUNT}.")
    return int(significant)


def parse_rnaseq_inputs(
    counts_bytes: bytes,
    samples_bytes: bytes,
    *,
    reference_level: str,
    comparison_level: str,
    design: str = "condition",
) -> dict:
    """Return validated raw integers, aligned metadata, design and descriptive QC.

    The count CSV begins with ``gene_id`` and 4..100 unique sample columns.
    Metadata begins with ``sample,condition`` and may additionally contain only
    ``batch`` and/or ``subject``. Its sample set must exactly equal the count
    columns. Identity strings are preserved, and any metadata permutation is
    explicit. Design-column order is intercept, optional covariate dummies,
    then condition dummies. These names describe the actual matrix used for
    rank validation; they are not executable formula fragments.

    Errors raise ``ValueError``. NumPy is required for design-rank validation.
    """
    reference_level = _label(reference_level, "Reference condition")
    comparison_level = _label(comparison_level, "Comparison condition")
    if reference_level == comparison_level:
        raise ValueError("Reference and comparison conditions must be different.")
    if not isinstance(design, str) or design not in _DESIGNS:
        raise ValueError("Design must be condition, batch_condition, or subject_condition.")
    formula, covariate = _DESIGNS[design]

    count_rows = _rows(counts_bytes, "Counts CSV")
    count_header = _header(count_rows, "Counts CSV")
    if count_header[0] != "gene_id":
        raise ValueError("The first Counts CSV header must be exactly gene_id.")
    sample_ids = count_header[1:]
    sample_count = len(sample_ids)
    if not 4 <= sample_count <= MAX_SAMPLES:
        raise ValueError(f"Counts CSV must contain 4 to {MAX_SAMPLES} sample columns.")

    metadata_rows = _rows(samples_bytes, "Samples CSV")
    metadata_header = _header(metadata_rows, "Samples CSV")
    if (metadata_header[:2] != ["sample", "condition"]
            or set(metadata_header[2:]) - {"batch", "subject"}):
        raise ValueError(
            "Samples CSV headers must begin with exactly sample,condition and "
            "may additionally contain only batch and/or subject."
        )
    if covariate and covariate not in metadata_header:
        raise ValueError(f"Design {design} requires the {covariate} metadata column.")

    metadata_by_id: dict[str, dict[str, str]] = {}
    supplied_order = []
    for row in metadata_rows:
        if len(row) != len(metadata_header):
            raise ValueError("Each Samples CSV row must have exactly the header's number of fields.")
        if len(metadata_by_id) >= MAX_SAMPLES:
            raise ValueError(f"Samples CSV exceeds the limit of {MAX_SAMPLES} rows.")
        record = {key: _label(value, f"Samples CSV {key}") for key, value in zip(metadata_header, row)}
        identity = record["sample"]
        if identity in metadata_by_id:
            raise ValueError(f"Samples CSV contains duplicate sample ID {identity!r}.")
        metadata_by_id[identity] = record
        supplied_order.append(identity)
    missing = [identity for identity in sample_ids if identity not in metadata_by_id]
    unexpected = [identity for identity in supplied_order if identity not in set(sample_ids)]
    if missing or unexpected:
        raise ValueError(
            "Samples CSV must match count sample IDs exactly; "
            f"missing={missing!r}, unexpected={unexpected!r}. No samples are excluded."
        )
    samples = [metadata_by_id[identity] for identity in sample_ids]
    reordered = supplied_order != sample_ids
    condition_counts = dict(Counter(sample["condition"] for sample in samples))
    for level, role in ((reference_level, "Reference"), (comparison_level, "Comparison")):
        if condition_counts.get(level, 0) < 2:
            raise ValueError(f"{role} condition {level!r} must have at least two supplied samples.")

    gene_ids: list[str] = []
    seen_genes: set[str] = set()
    counts: list[list[int]] = []
    library_sizes = [0] * sample_count
    detected_genes = [0] * sample_count
    all_zero_genes: list[str] = []
    for row in count_rows:
        if len(row) != len(count_header):
            raise ValueError("Each Counts CSV row must have exactly the header's number of fields.")
        if len(gene_ids) >= MAX_GENES:
            raise ValueError(f"Counts CSV exceeds the limit of {MAX_GENES} gene rows.")
        if (len(gene_ids) + 1) * sample_count > MAX_CELLS:
            raise ValueError(f"Counts CSV exceeds the limit of {MAX_CELLS} count cells.")
        gene = _label(row[0], "Gene ID")
        if gene in seen_genes:
            raise ValueError(f"Counts CSV contains duplicate gene ID {gene!r}.")
        values = [_count(token, gene, sample) for token, sample in zip(row[1:], sample_ids)]
        gene_ids.append(gene)
        seen_genes.add(gene)
        counts.append(values)
        if not any(values):
            all_zero_genes.append(gene)
        for index, value in enumerate(values):
            library_sizes[index] += value
            detected_genes[index] += value > 0
    if len(gene_ids) < 2:
        raise ValueError("Counts CSV must contain at least two gene rows.")
    empty_libraries = [identity for identity, size in zip(sample_ids, library_sizes) if size == 0]
    if empty_libraries:
        raise ValueError(f"Samples have zero library size: {empty_libraries!r}; no samples are excluded.")

    # Preserve samples in count-column order, with an explicit reference baseline.
    condition_levels = [reference_level] + sorted(set(condition_counts) - {reference_level})
    factor_levels = {"condition": condition_levels}
    columns = ["(Intercept)"]
    matrix = [[1.0] for _ in samples]
    if covariate:
        levels = list(dict.fromkeys(sample[covariate] for sample in samples))
        if len(levels) < 2:
            raise ValueError(f"Design {design} requires at least two {covariate} levels.")
        factor_levels[covariate] = levels
        for level in levels[1:]:
            columns.append(f"{covariate}[T.{level}]")
            for values, sample in zip(matrix, samples):
                values.append(float(sample[covariate] == level))
    for level in condition_levels[1:]:
        columns.append(f"condition[T.{level}]")
        for values, sample in zip(matrix, samples):
            values.append(float(sample["condition"] == level))

    import numpy as np

    rank = int(np.linalg.matrix_rank(np.asarray(matrix, dtype=np.float64)))
    if rank != len(columns):
        raise ValueError(
            f"Design {formula} is rank deficient (rank {rank}, {len(columns)} columns); "
            "condition and covariate effects may be confounded."
        )
    residual_df = sample_count - rank
    if residual_df <= 0:
        raise ValueError(f"Design {formula} has no positive residual degrees of freedom ({residual_df}).")

    warnings: list[str] = []
    if reordered:
        warnings.append("Sample metadata was explicitly reordered to match the count-column sample IDs.")
    if all_zero_genes:
        warnings.append(f"All-zero gene rows are retained in the parsed input: {len(all_zero_genes)}; the study prefilter determines whether they enter the model.")
    other_conditions = [level for level in condition_levels if level not in {reference_level, comparison_level}]
    if other_conditions:
        warnings.append(
            "Conditions outside the requested contrast remain in the design: "
            + ", ".join(f"{level!r} ({condition_counts[level]} samples)" for level in other_conditions)
            + ". No samples are excluded."
        )
    for unused in ("batch", "subject"):
        if unused in metadata_header and unused != covariate:
            warnings.append(f"Metadata column {unused!r} is preserved but is not included in design {formula}.")

    sample_qc = []
    for index, sample in enumerate(samples):
        sample_qc.append({
            **sample,
            "library_size": library_sizes[index],
            "detected_genes": detected_genes[index],
            "zero_fraction": (len(gene_ids) - detected_genes[index]) / len(gene_ids),
        })
    return {
        "gene_ids": gene_ids,
        "sample_ids": sample_ids,
        "counts": counts,
        "samples": samples,
        "design": {
            "id": design,
            "formula": formula,
            "columns": columns,
            "factor_levels": factor_levels,
            "rank": rank,
            "residual_df": residual_df,
            "contrast": {"factor": "condition", "numerator": comparison_level, "denominator": reference_level},
        },
        "qc": {
            "samples": sample_qc,
            "gene_count": len(gene_ids),
            "sample_count": sample_count,
            "condition_counts": condition_counts,
            "all_zero_genes": all_zero_genes,
            "metadata_reordered": reordered,
        },
        "warnings": warnings,
    }
