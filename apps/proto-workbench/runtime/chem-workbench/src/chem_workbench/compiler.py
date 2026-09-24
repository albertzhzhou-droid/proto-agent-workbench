"""Parse, validate, and deterministically lower ``.chem`` source into ChemIR."""

from __future__ import annotations

import copy
import hashlib
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from chem_workbench.adapters.cif_import import import_cif_bytes
from chem_workbench.chemir import (
    CANONICALIZATION_ALGORITHM,
    NORMALIZATION_PROFILE,
    artifact_sha256,
    pretty_bytes,
    semantic_hash,
    typed_digest,
)
from chem_workbench.chemir.profile import (
    CHEMIR_SCHEMA_VERSION as CHEMIR_SCHEMA_VERSION,
)
from chem_workbench.chemir.profile import (
    CONFORMANCE_PROFILE as CONFORMANCE_PROFILE,
)
from chem_workbench.chemir.schema_validation import (
    SchemaValidationError,
    validate_chemir_schema,
    validate_review_packet_schema,
)
from chem_workbench.chemir.validation import source_hashes
from chem_workbench.diagnostics import Diagnostic, Severity, SourceLocation
from chem_workbench.parser import Declaration, parse_source
from chem_workbench.validators import validate_declarations
from chem_workbench.version import COMPILER_ID as COMPILER_ID

MAX_SOURCE_BYTES = 16 * 1024 * 1024

ImportResolver = Callable[[str], "bytes | None"]
"""Reads one permitted source-relative CIF path; ``None`` means unreadable."""


@dataclass(frozen=True, slots=True)
class CompilationResult:
    document: dict[str, Any] | None
    diagnostics: tuple[Diagnostic, ...]
    source_sha256: str
    semantic_hash: str | None
    artifact_bytes: bytes | None
    conversion_loss_reports: tuple[dict[str, Any], ...] = ()

    @property
    def has_errors(self) -> bool:
        return any(item.severity is Severity.ERROR for item in self.diagnostics)

    @property
    def success(self) -> bool:
        return self.document is not None and not self.has_errors

    def review_packet(self) -> dict[str, Any]:
        if not self.success or self.document is None or self.artifact_bytes is None:
            raise ValueError("Cannot create a review packet for a failed compilation")
        if self.semantic_hash is None:
            raise ValueError("Cannot create a review packet without a semantic hash")
        current_artifact = pretty_bytes(self.document)
        if current_artifact != self.artifact_bytes:
            raise ValueError("Compilation result document no longer matches its artifact bytes")
        current_semantic_hash = semantic_hash(self.document)
        if current_semantic_hash != self.semantic_hash:
            raise ValueError("Compilation result document no longer matches its semantic hash")
        document_source_hashes = source_hashes(self.document)
        if self.source_sha256 not in document_source_hashes:
            raise ValueError("Compilation result document no longer matches its source hash")
        source_digests = [
            typed_digest("source_sha256", digest) for digest in document_source_hashes
        ]
        packet_document = copy.deepcopy(self.document)
        packet = {
            "packet_version": "review/v1alpha1",
            "operation": "review-compile",
            "verification_scope": "self_consistency",
            "signature_status": "unsigned",
            "compiler": COMPILER_ID,
            "canonicalization": CANONICALIZATION_ALGORITHM,
            "normalization_profile": NORMALIZATION_PROFILE,
            "source_hashes": source_digests,
            "chemir_semantic_hash": typed_digest("semantic_hash", current_semantic_hash),
            "chemir_artifact_hash": typed_digest(
                "artifact_sha256", artifact_sha256(current_artifact)
            ),
            "observations": [
                {
                    "observation_type": "SOURCE_PARSE_ACCEPTED",
                    "producer": COMPILER_ID,
                    "evidence_hashes": source_digests,
                }
            ],
            "not_claimed": [
                {
                    "claim": "PARSE_VALID",
                    "reason": (
                        "No signed RFC-0002 claim record or evidence ledger was issued; "
                        "the packet contains only a local parse observation."
                    ),
                },
                {
                    "claim": "STRUCTURE_MODEL_CONSISTENT",
                    "reason": "Versioned chemistry format adapters are not active in this alpha.",
                },
                {
                    "claim": "CHEMISTRY_CHECKED",
                    "reason": (
                        "No scientific rule bundle has evaluated the preserved representations."
                    ),
                },
            ],
            "diagnostics": [item.to_dict() for item in self.diagnostics],
            "chemir": packet_document,
        }
        validate_review_packet_schema(packet)
        return packet


def _source_sha256(source_bytes: bytes) -> str:
    return f"sha256:{hashlib.sha256(source_bytes).hexdigest()}"


def _source_reference(source_hash: str) -> str:
    algorithm, digest = source_hash.split(":", maxsplit=1)
    return f"source:{algorithm}:{digest}"


def _envelope(
    declaration: Declaration,
    payload: dict[str, Any],
    source_hash: str,
) -> dict[str, Any]:
    return {
        "schema_version": CHEMIR_SCHEMA_VERSION,
        "id": declaration.identifier,
        "kind": {
            "molecule": "Molecule",
            "electronic_state": "ElectronicState",
            "crystal": "PeriodicStructure",
            "surface_slab": "SurfaceSlab",
            "adsorption_complex": "AdsorptionComplex",
            "interface_reaction_step": "InterfaceReactionStep",
            "conditions": "ConditionSet",
            "comparison": "ComparisonSpec",
            "calculation": "CalculationSpec",
        }[declaration.kind],
        "payload": payload,
        "source_references": [_source_reference(source_hash)],
        "provenance_references": [],
        "review_requirement_references": [],
        "extensions": {},
    }


def _lower(declaration: Declaration, source_hash: str) -> dict[str, Any]:
    fields = declaration.fields
    if declaration.kind == "molecule":
        structure = fields["structure"]
        assert isinstance(structure, dict)
        payload = {
            "representations": [
                {
                    "format": structure["format"],
                    "role": "original",
                    "value": structure["value"],
                }
            ],
            "normalization_policy": {
                "name": "source-preserving",
                "version": "v1alpha1",
            },
            "ambiguities": [],
        }
    elif declaration.kind == "electronic_state":
        payload = {
            "target_reference": fields["target"],
            "model": "finite",
            "charge": fields["charge"],
            "multiplicity": fields["multiplicity"],
        }
    elif declaration.kind == "crystal":
        structure = fields["structure"]
        assert isinstance(structure, dict)
        payload = {
            "representations": [
                {
                    "format": structure["format"],
                    "role": "original",
                    "path": structure["value"],
                }
            ],
            "semantics": fields["semantics"],
        }
    elif declaration.kind == "surface_slab":
        payload = {
            "parent_structure_reference": fields["parent"],
            "construction": {
                "algorithm": fields["construction"],
                "algorithm_version": "v1alpha1",
                "miller": fields["miller"],
                "termination": fields["termination"],
                "layers": fields["layers"],
                "vacuum": {"value": fields["vacuum"], "unit": fields["vacuum_unit"]},
            },
        }
    elif declaration.kind == "adsorption_complex":
        payload = {
            "slab_reference": fields["slab"],
            "adsorbate_elements": fields["adsorbate"],
            "site": fields["site"],
            "height": {"value": fields["height"], "unit": fields["height_unit"]},
        }
    elif declaration.kind == "interface_reaction_step":
        payload = {
            "reactant_references": fields["reactants"],
            "product_references": fields["products"],
            "claim_scope": "computed_energy_difference_only",
        }
    elif declaration.kind == "conditions":
        payload = {"phase": fields["phase"]}
        if "target" in fields:
            payload["target_reference"] = fields["target"]
        if "temperature" in fields:
            payload["temperature"] = {
                "value": fields["temperature"],
                "unit": fields["temperature_unit"],
            }
        if "pressure" in fields:
            payload["pressure"] = {"value": fields["pressure"], "unit": fields["pressure_unit"]}
        for optional in ("solvent", "total_charge", "spin_multiplicity", "spin_polarized"):
            if optional in fields:
                payload[optional] = fields[optional]
    elif declaration.kind == "comparison":
        payload = {
            "kind": fields["kind"],
            "stability_kind": fields["stability_kind"],
            "subject_references": fields["subjects"],
            "conditions_reference": fields["conditions"],
            "reference_state": fields["reference_state"],
            "method": {"name": fields["method"]},
        }
    elif declaration.kind == "calculation":
        properties = fields["properties"]
        assert isinstance(properties, list)
        payload = {
            "target_reference": fields["target"],
            "task": fields["task"],
            "properties": properties,
            "method": {"name": fields["method"]},
        }
        if "state" in fields:
            payload["electronic_state_reference"] = fields["state"]
        if "conditions" in fields:
            payload["conditions_reference"] = fields["conditions"]
        if "basis" in fields:
            payload["basis"] = {"name": fields["basis"]}
    else:
        raise AssertionError(f"Unsupported declaration reached lowering: {declaration.kind}")
    return _envelope(declaration, payload, source_hash)


def compile_source(
    source: str | bytes,
    source_name: str = "<memory>",
    import_resolver: ImportResolver | None = None,
) -> CompilationResult:
    source_bytes = source.encode("utf-8") if isinstance(source, str) else source
    source_hash = _source_sha256(source_bytes)
    if len(source_bytes) > MAX_SOURCE_BYTES:
        diagnostic = Diagnostic(
            Severity.ERROR,
            "CHM1009",
            f"Source exceeds the alpha limit of {MAX_SOURCE_BYTES} bytes.",
            SourceLocation(source_name, 1, 1),
            "Split the input or use a source smaller than 16 MiB.",
        )
        return CompilationResult(None, (diagnostic,), source_hash, None, None)
    try:
        source_text = source_bytes.decode("utf-8")
    except UnicodeDecodeError as error:
        diagnostic = Diagnostic(
            Severity.ERROR,
            "CHM1008",
            f"Source is not valid UTF-8 at byte {error.start}.",
            SourceLocation(source_name, 1, 1),
            "Save .chem source as UTF-8 without lossy transcoding.",
        )
        return CompilationResult(None, (diagnostic,), source_hash, None, None)

    parse_result = parse_source(source_text, source_name)
    diagnostics = list(parse_result.diagnostics)
    if parse_result.source is None:
        return CompilationResult(None, tuple(diagnostics), source_hash, None, None)

    resolution = _resolve_crystal_imports(
        parse_result.source.declarations, import_resolver, source_name
    )
    diagnostics.extend(resolution.diagnostics)
    validation = validate_declarations(
        parse_result.source.declarations,
        resolved_crystals=frozenset(resolution.imported_payloads),
    )
    diagnostics.extend(validation.diagnostics)
    if any(item.severity is Severity.ERROR for item in diagnostics):
        return CompilationResult(None, tuple(diagnostics), source_hash, None, None)

    document: dict[str, Any] = {
        "schema_version": CHEMIR_SCHEMA_VERSION,
        "profile": CONFORMANCE_PROFILE,
        "canonicalization": CANONICALIZATION_ALGORITHM,
        "normalization_profile": NORMALIZATION_PROFILE,
        "objects": [
            _lower(declaration, source_hash) for declaration in parse_result.source.declarations
        ],
    }
    for object_model in document["objects"]:
        imported = resolution.imported_payloads.get(object_model["id"])
        if imported is None:
            continue
        lattice, coordinate_system, sites, content_hash = imported
        object_model["payload"]["lattice"] = lattice
        object_model["payload"]["coordinate_system"] = coordinate_system
        object_model["payload"]["sites"] = sites
        object_model["source_references"].append(f"source:sha256:{content_hash}")
    try:
        validate_chemir_schema(document)
    except SchemaValidationError as error:
        diagnostic = Diagnostic(
            Severity.ERROR,
            "CHM2999",
            f"Internal ChemIR schema validation failed: {error}",
            SourceLocation(source_name, 1, 1),
            "Report this compiler defect; no artifact was emitted.",
        )
        diagnostics.append(diagnostic)
        return CompilationResult(None, tuple(diagnostics), source_hash, None, None)
    artifact = pretty_bytes(document)
    return CompilationResult(
        document,
        tuple(diagnostics),
        source_hash,
        semantic_hash(document),
        artifact,
        tuple(resolution.loss_reports),
    )


@dataclass(frozen=True, slots=True)
class _ImportResolution:
    imported_payloads: dict[str, tuple[dict[str, Any], str, list[dict[str, Any]], str]]
    loss_reports: list[dict[str, Any]]
    diagnostics: list[Diagnostic]


def _resolve_crystal_imports(
    declarations: tuple[Declaration, ...],
    import_resolver: ImportResolver | None,
    source_name: str,
) -> _ImportResolution:
    """Resolve crystal CIF references through the registered import capability."""
    resolution = _ImportResolution({}, [], [])
    if import_resolver is None:
        return resolution
    for declaration in declarations:
        if declaration.kind != "crystal":
            continue
        structure = declaration.fields.get("structure")
        if not isinstance(structure, dict):
            continue
        path = structure.get("value")
        span = declaration.field_spans.get("structure") or declaration.span
        location = SourceLocation(span.file, span.line, span.column, span.end_line, span.end_column)
        content = import_resolver(path) if isinstance(path, str) else None
        if content is None:
            resolution.diagnostics.append(
                Diagnostic(
                    Severity.ERROR,
                    "CHM2311",
                    f"Referenced CIF {path!r} could not be read during import resolution.",
                    location,
                    "Provide the file next to the .chem source or compile without "
                    "--resolve-imports.",
                )
            )
            continue
        imported = import_cif_bytes(content)
        resolution.loss_reports.append(imported.loss_report)
        if not imported.admitted or imported.document is None:
            codes = ", ".join(sorted({issue["code"] for issue in imported.loss_report["issues"]}))
            resolution.diagnostics.append(
                Diagnostic(
                    Severity.REVIEW_REQUIRED,
                    "CHM2310",
                    f"Referenced CIF {path!r} was rejected by the import profile: {codes}.",
                    location,
                    "The crystal keeps its preserved source representation only.",
                )
            )
            continue
        payload = imported.document["objects"][0]["payload"]
        content_hash = hashlib.sha256(content).hexdigest()
        resolution.imported_payloads[declaration.identifier] = (
            payload["lattice"],
            payload["coordinate_system"],
            payload["sites"],
            content_hash,
        )
        resolution.diagnostics.append(
            Diagnostic(
                Severity.INFO,
                "CHM2309",
                f"Referenced CIF {path!r} was imported into typed lattice and site data.",
                location,
                "The typed fields and the CIF content hash are bound into the artifact.",
            )
        )
    return resolution
