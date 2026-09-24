"""First structure import: admitted explicit-P1 CIF into typed ChemIR (ADR-0004).

The import reuses the probe's fail-closed admission analysis, then emits one
``PeriodicStructure`` object with an exact orthogonal lattice and fractional
sites. Every decimal is carried as a canonical decimal string; binary floats
never appear. Lattice construction from non-orthogonal angles requires a
reviewed algorithm and is rejected, not approximated. The capability claims
``SEMANTIC_EQUIVALENT_UNDER_PROFILE``: cell lengths, fractional sites, site
labels, and elements are preserved or normalized; any other CIF content stays
in the embedded original representation rather than the typed view.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from chem_workbench.adapters.cif_probe import (
    IMPORT_CAPABILITY_ID,
    Block,
    CifAnalysis,
    Loop,
    _Issue,
    analyze_cif_bytes,
    build_loss_report,
    bundled_capability,
)
from chem_workbench.chemir import pretty_bytes, semantic_hash
from chem_workbench.chemir.constraints import canonical_decimal, is_chemir_identifier
from chem_workbench.chemir.profile import (
    CANONICALIZATION_ALGORITHM,
    CHEMIR_SCHEMA_VERSION,
    CONFORMANCE_PROFILE,
    NORMALIZATION_PROFILE,
)
from chem_workbench.chemir.schema_validation import validate_chemir_schema
from chem_workbench.chemir.validation import validate_chemir_document

_CELL_LENGTH_TAGS = ("_cell_length_a", "_cell_length_b", "_cell_length_c")
_CELL_ANGLE_TAGS = ("_cell_angle_alpha", "_cell_angle_beta", "_cell_angle_gamma")
_FRACTIONAL_TAGS = ("_atom_site_fract_x", "_atom_site_fract_y", "_atom_site_fract_z")
_OBJECT_ID_SANITIZE = re.compile(r"[^A-Za-z0-9._:/-]+")
_ORTHOGONAL_ANGLE = "90"


@dataclass(frozen=True, slots=True)
class CifImportResult:
    summary: dict[str, Any]
    loss_report: dict[str, Any]
    document: dict[str, Any] | None
    artifact_bytes: bytes | None
    document_semantic_hash: str | None

    @property
    def admitted(self) -> bool:
        return self.document is not None


def _object_identifier(name: str) -> str:
    identifier = _OBJECT_ID_SANITIZE.sub("-", name.strip().lower()).strip("-.")
    if not identifier or not is_chemir_identifier(identifier):
        return "imported-cif-structure"
    return identifier


def _site_loop(block: Block) -> Loop:
    for candidate in block.loops:
        if all(tag in candidate.columns for tag in _FRACTIONAL_TAGS):
            return candidate
    raise AssertionError("admitted analysis must contain a fractional site loop")


def _fractional_coordinates(site_loop: Loop, row: list[str]) -> list[str]:
    coordinates: list[str] = []
    for tag in _FRACTIONAL_TAGS:
        value = canonical_decimal(row[site_loop.columns.index(tag)].split("(")[0])
        if value is None:
            raise AssertionError(f"admitted site value for {tag!r} is not a decimal")
        coordinates.append(value)
    return coordinates


def _cell_issue(code: str, message: str, suggestion: str, line: int, column: int) -> _Issue:
    return _Issue(
        code=code,
        severity="error",
        disposition="unsupported",
        feature="cif cell",
        message=message,
        suggestion=suggestion,
        line=line,
        column=column,
    )


def import_cif_bytes(source: bytes) -> CifImportResult:
    """Import an admitted explicit-P1 CIF into a deterministic ChemIR document."""
    analysis: CifAnalysis = analyze_cif_bytes(source)
    capability = bundled_capability(IMPORT_CAPABILITY_ID)
    if not analysis.summary["admitted"]:
        report = build_loss_report(
            capability=capability,
            classification="UNSUPPORTED",
            issues=analysis.issues,
            input_hash=analysis.input_hash,
            output_hash=None,
        )
        return CifImportResult(analysis.summary, report, None, None, None)

    block = analysis.blocks[0]
    issues: list[_Issue] = []
    lengths: list[str] = []
    for tag in _CELL_LENGTH_TAGS:
        value, line, column = block.items[tag]
        length = canonical_decimal(value.split("(")[0])
        if length is None or length.startswith("-") or length == "0":
            issues.append(
                _cell_issue(
                    "NON_POSITIVE_CELL_LENGTH",
                    f"Cell length {tag!r} is not a positive decimal.",
                    "Provide positive orthogonal cell lengths.",
                    line,
                    column,
                )
            )
            lengths.append("")
        else:
            lengths.append(length)
    for tag in _CELL_ANGLE_TAGS:
        value, line, column = block.items[tag]
        angle = canonical_decimal(value.split("(")[0])
        if angle != _ORTHOGONAL_ANGLE:
            issues.append(
                _cell_issue(
                    "NON_ORTHOGONAL_CELL",
                    f"Cell angle {tag!r}={value!r} is not exactly 90 degrees.",
                    "Only exact orthogonal cells import in this alpha; general "
                    "lattice construction needs a reviewed algorithm.",
                    line,
                    column,
                )
            )
    if issues:
        summary = dict(analysis.summary)
        summary["admitted"] = False
        summary["issue_codes"] = sorted({item.code for item in issues})
        report = build_loss_report(
            capability=capability,
            classification="UNSUPPORTED",
            issues=issues,
            input_hash=analysis.input_hash,
            output_hash=None,
        )
        return CifImportResult(summary, report, None, None, None)

    site_loop = _site_loop(block)
    label_column = (
        site_loop.columns.index("_atom_site_label")
        if "_atom_site_label" in site_loop.columns
        else None
    )
    element_column = site_loop.columns.index("_atom_site_type_symbol")
    sites: list[dict[str, Any]] = []
    labels: list[str] = []
    for index, row in enumerate(site_loop.rows, start=1):
        element = re.match(r"^[A-Za-z]{1,2}", row[element_column])
        if element is None:
            raise AssertionError("admitted site must have a parseable element")
        site: dict[str, Any] = {
            "id": f"site{index}",
            "element": element.group(0).capitalize(),
            "coordinates": _fractional_coordinates(site_loop, row),
            "occupancy": 1,
        }
        if label_column is not None:
            label = row[label_column]
            labels.append(label)
            site["label"] = label
        sites.append(site)

    document: dict[str, Any] = {
        "schema_version": CHEMIR_SCHEMA_VERSION,
        "profile": CONFORMANCE_PROFILE,
        "canonicalization": CANONICALIZATION_ALGORITHM,
        "normalization_profile": NORMALIZATION_PROFILE,
        "objects": [
            {
                "schema_version": CHEMIR_SCHEMA_VERSION,
                "id": _object_identifier(block.name),
                "kind": "PeriodicStructure",
                "payload": {
                    "semantics": "explicit_configuration",
                    "lattice": {
                        "vectors": [
                            [lengths[0], "0", "0"],
                            ["0", lengths[1], "0"],
                            ["0", "0", lengths[2]],
                        ],
                        "unit": "angstrom",
                        "periodic_boundary_conditions": [True, True, True],
                    },
                    "coordinate_system": "fractional",
                    "sites": sites,
                    "representations": [
                        {
                            "format": "cif",
                            "role": "original",
                            "value": source.decode("utf-8"),
                        }
                    ],
                },
                "source_references": [f"source:sha256:{analysis.input_hash['value']}"],
                "provenance_references": [],
                "review_requirement_references": [],
                "extensions": {},
            }
        ],
    }
    validate_chemir_schema(document)
    validate_chemir_document(document)
    document_hash = semantic_hash(document)
    artifact = pretty_bytes(document)

    loss_issues = _conversion_issues(analysis, site_loop, block, label_column is not None)
    report = build_loss_report(
        capability=capability,
        classification="SEMANTIC_EQUIVALENT_UNDER_PROFILE",
        issues=loss_issues,
        input_hash=analysis.input_hash,
        output_hash={
            "type": "semantic_hash",
            "algorithm": "sha256",
            "value": document_hash.split(":", 1)[1],
        },
    )
    summary = dict(analysis.summary)
    summary["object_id"] = document["objects"][0]["id"]
    return CifImportResult(summary, report, document, artifact, document_hash)


def _conversion_issues(
    analysis: CifAnalysis,
    site_loop: Loop,
    block: Block,
    has_labels: bool,
) -> list[_Issue]:
    """Describe what the typed import normalized and what stays in the source."""
    issues: list[_Issue] = []
    if analysis.summary["standard_uncertainty_count"]:
        issues.append(
            _Issue(
                code="STANDARD_UNCERTAINTY_STRIPPED",
                severity="info",
                disposition="normalized",
                feature="cif standard uncertainties",
                message=(
                    f"{analysis.summary['standard_uncertainty_count']} value(s) carried "
                    "a standard uncertainty; the typed structure keeps exact values only."
                ),
                suggestion="No action is required; uncertainties stay in the source bytes.",
                line=block.line,
                column=block.column,
            )
        )
    if "_atom_site_occupancy" not in site_loop.columns:
        issues.append(
            _Issue(
                code="CIF_OCCUPANCY_DEFAULTED",
                severity="info",
                disposition="normalized",
                feature="_atom_site_occupancy",
                message="No occupancy column was present; the CIF default of 1 was applied.",
                suggestion="Declare occupancy 1 explicitly to remove this notice.",
                line=site_loop.start_line,
                column=1,
            )
        )
    unmapped = list(analysis.summary["unmapped_tags"])
    if unmapped:
        preview = ", ".join(unmapped[:16])
        issues.append(
            _Issue(
                code="UNMAPPED_CIF_ITEMS_PRESERVED",
                severity="info",
                disposition="preserved",
                feature="cif items",
                message=(
                    f"{len(unmapped)} CIF item(s) are outside the import profile; they "
                    f"remain in the embedded original representation only: {preview}."
                ),
                suggestion="Extend the profile through a reviewed capability change.",
                line=block.line,
                column=block.column,
            )
        )
    if has_labels:
        issues.append(
            _Issue(
                code="ATOM_SITE_LABELS_PRESERVED",
                severity="info",
                disposition="preserved",
                feature="_atom_site_label",
                message="Site labels are carried into typed site records.",
                suggestion="No action is required.",
                line=site_loop.start_line,
                column=1,
            )
        )
    return issues
