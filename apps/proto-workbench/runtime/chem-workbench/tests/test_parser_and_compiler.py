"""Parser, validation, determinism, and review-packet conformance tests."""

from __future__ import annotations

import copy
from dataclasses import replace
from pathlib import Path

import pytest

from chem_workbench.chemir import (
    artifact_sha256,
    canonical_bytes,
    pretty_bytes,
    semantic_hash,
    typed_digest,
)
from chem_workbench.chemir.canonical import CanonicalizationError
from chem_workbench.compiler import CompilationResult, compile_source
from chem_workbench.parser import parse_source

VALID_SOURCE = """chem 0.1

molecule water {
  structure smiles "O"
}
"""


def diagnostic_codes(result: CompilationResult) -> set[str]:
    return {diagnostic.code for diagnostic in result.diagnostics}


def test_parser_preserves_precise_declaration_and_field_spans() -> None:
    result = parse_source(VALID_SOURCE, "fixtures/water.chem")

    assert result.source is not None
    assert result.diagnostics == ()
    declaration = result.source.declarations[0]
    assert declaration.span.file == "fixtures/water.chem"
    assert (
        declaration.span.line,
        declaration.span.column,
        declaration.span.end_line,
        declaration.span.end_column,
    ) == (3, 1, 5, 2)
    structure_span = declaration.field_spans["structure"]
    assert structure_span.file == "fixtures/water.chem"
    assert (
        structure_span.line,
        structure_span.column,
        structure_span.end_line,
        structure_span.end_column,
    ) == (4, 3, 4, 12)


def test_parser_reports_error_location_and_recovers_at_next_declaration() -> None:
    source = """chem 0.1
molecule {
  structure smiles "discarded"
}
molecule recovered {
  structure smiles "O"
}
"""

    result = parse_source(source, "recovery.chem")

    assert result.source is not None
    assert [item.identifier for item in result.source.declarations] == ["recovered"]
    diagnostic = result.diagnostics[0]
    assert diagnostic.code == "CHM1003"
    assert diagnostic.location.file == "recovery.chem"
    assert (diagnostic.location.line, diagnostic.location.column) == (2, 10)


@pytest.mark.parametrize(
    ("source", "expected_code"),
    [
        (
            """chem 0.2
molecule water {
  structure smiles "O"
}
""",
            "CHM1002",
        ),
        (
            """chem 0.1
polymer sample {
  structure smiles "C"
}
""",
            "CHM2001",
        ),
        (
            """chem 0.1
molecule water {
  structure smiles "O"
  display_name "Water"
}
""",
            "CHM2004",
        ),
    ],
    ids=("unknown-version", "unknown-kind", "unknown-field"),
)
def test_unknown_language_constructs_fail_closed(source: str, expected_code: str) -> None:
    result = compile_source(source, "unknown.chem")

    assert expected_code in diagnostic_codes(result)
    assert not result.success
    assert result.document is None
    assert result.semantic_hash is None
    assert result.artifact_bytes is None


def test_duplicate_document_wide_identifiers_fail_closed() -> None:
    source = """chem 0.1
molecule duplicate {
  structure smiles "O"
}
molecule duplicate {
  structure smiles "N"
}
"""

    result = compile_source(source, "duplicate.chem")

    assert "CHM2003" in diagnostic_codes(result)
    assert not result.success
    assert result.artifact_bytes is None


def test_document_without_declarations_fails_closed() -> None:
    result = compile_source("chem 0.1\n", "empty.chem")

    assert "CHM2005" in diagnostic_codes(result)
    assert not result.success
    assert result.document is None
    assert result.artifact_bytes is None


@pytest.mark.parametrize(
    ("source", "expected_code"),
    [
        (
            """chem 0.1
electronic_state orphan_state {
  target missing_molecule
  finite charge 0 multiplicity 1
}
""",
            "CHM2201",
        ),
        (
            """chem 0.1
calculation orphan_calculation {
  target missing_crystal
  task single_point
  properties [energy]
  method emt
}
""",
            "CHM2401",
        ),
        (
            """chem 0.1
molecule water {
  structure smiles "O"
}
calculation bad_state_reference {
  target water
  state missing_state
  task single_point
  properties [energy]
  method hf
  basis sto-3g
}
""",
            "CHM2403",
        ),
    ],
    ids=("electronic-state-target", "calculation-target", "calculation-state"),
)
def test_broken_references_fail_closed(source: str, expected_code: str) -> None:
    result = compile_source(source, "broken-reference.chem")

    assert expected_code in diagnostic_codes(result)
    assert not result.success
    assert result.document is None
    assert result.artifact_bytes is None


def test_repeated_compilation_is_byte_and_semantic_hash_identical() -> None:
    results = [compile_source(VALID_SOURCE, "water.chem") for _ in range(3)]

    assert all(result.success for result in results)
    assert results[0].artifact_bytes is not None
    assert {result.artifact_bytes for result in results} == {results[0].artifact_bytes}
    assert {result.semantic_hash for result in results} == {results[0].semantic_hash}
    assert results[0].document is not None
    assert results[0].artifact_bytes == pretty_bytes(results[0].document)
    assert results[0].semantic_hash == semantic_hash(results[0].document)


def test_water_fixture_has_golden_source_semantic_and_artifact_digests() -> None:
    source_path = Path(__file__).resolve().parents[1] / "examples" / "molecules" / "water.chem"
    result = compile_source(source_path.read_bytes(), "examples/molecules/water.chem")

    assert result.success
    assert result.artifact_bytes is not None
    assert result.source_sha256 == (
        "sha256:c9cfca8e50fe7755f600b17166d781a3b8cd1086be08c3da3945b84efd407e5f"
    )
    assert result.semantic_hash == (
        "sha256:4f4b197889a4afe672937da1e777617b7abfe5d07d5536a1c87bef870b9de638"
    )
    assert artifact_sha256(result.artifact_bytes) == (
        "sha256:117f3869f41b37b1c97c98090453904e2b32e2de2a525a2e0b0cb90da1cf6ad5"
    )


def test_semantic_hash_includes_source_reference_arrays() -> None:
    result = compile_source(VALID_SOURCE, "water.chem")
    assert result.success
    assert result.document is not None

    relocated_document = copy.deepcopy(result.document)
    relocated_document["objects"][0]["source_references"] = [f"source:sha256:{'0' * 64}"]

    assert pretty_bytes(relocated_document) != result.artifact_bytes
    assert semantic_hash(relocated_document) != result.semantic_hash


@pytest.mark.parametrize(
    "mutation",
    [
        lambda document: document.__setitem__("schema_version", "chemir/v9"),
        lambda document: document["objects"][0]["payload"].__setitem__("future_open_field", True),
    ],
    ids=("unknown-schema", "open-payload"),
)
def test_public_semantic_hash_fails_closed_for_non_profile_documents(mutation: object) -> None:
    result = compile_source(VALID_SOURCE, "water.chem")
    assert result.success
    assert result.document is not None
    document = copy.deepcopy(result.document)

    assert callable(mutation)
    mutation(document)

    with pytest.raises(ValueError):
        semantic_hash(document)


def test_public_semantic_hash_rejects_binary_float_in_a_valid_extension() -> None:
    result = compile_source(VALID_SOURCE, "water.chem")
    assert result.document is not None
    document = copy.deepcopy(result.document)
    document["objects"][0]["extensions"]["test:confidence"] = 0.5

    with pytest.raises(CanonicalizationError, match="exact integers only"):
        semantic_hash(document)


def test_source_byte_change_updates_reference_and_therefore_semantic_hash() -> None:
    reformatted_source = """# The comment changes source bytes and line locators.

chem 0.1

molecule water {

    structure smiles "O"
}
"""

    original = compile_source(VALID_SOURCE, "water.chem")
    reformatted = compile_source(reformatted_source, "water-reformatted.chem")

    assert original.success and reformatted.success
    assert original.source_sha256 != reformatted.source_sha256
    assert original.artifact_bytes != reformatted.artifact_bytes
    assert original.semantic_hash != reformatted.semantic_hash


def test_review_packet_binds_source_chemir_and_artifact_without_approval_claims() -> None:
    result = compile_source(VALID_SOURCE, "water.chem")
    assert result.success
    assert result.artifact_bytes is not None

    packet = result.review_packet()

    assert packet == result.review_packet()
    assert packet["packet_version"] == "review/v1alpha1"
    assert packet["operation"] == "review-compile"
    assert packet["verification_scope"] == "self_consistency"
    assert packet["signature_status"] == "unsigned"
    assert "claims" not in packet
    assert packet["source_hashes"] == [typed_digest("source_sha256", result.source_sha256)]
    assert packet["chemir_semantic_hash"] == typed_digest("semantic_hash", result.semantic_hash)
    assert packet["chemir_artifact_hash"] == typed_digest(
        "artifact_sha256", artifact_sha256(result.artifact_bytes)
    )
    assert [item["observation_type"] for item in packet["observations"]] == [
        "SOURCE_PARSE_ACCEPTED"
    ]
    assert {claim["claim"] for claim in packet["not_claimed"]} == {
        "PARSE_VALID",
        "CHEMISTRY_CHECKED",
        "STRUCTURE_MODEL_CONSISTENT",
    }
    assert {item["code"] for item in packet["diagnostics"]} == {"CHM2103"}
    assert packet["chemir"] == result.document


def test_review_packet_rejects_mutated_result_and_isolates_embedded_document() -> None:
    mutated = compile_source(VALID_SOURCE, "water.chem")
    assert mutated.document is not None
    mutated.document["objects"][0]["payload"]["representations"][0]["value"] = "N"

    with pytest.raises(ValueError, match="artifact bytes"):
        mutated.review_packet()

    stable = compile_source(VALID_SOURCE, "water.chem")
    assert stable.document is not None
    packet = stable.review_packet()
    stable.document["objects"][0]["payload"]["representations"][0]["value"] = "F"

    assert packet["chemir"]["objects"][0]["payload"]["representations"][0]["value"] == "O"
    packet["chemir"]["objects"][0]["payload"]["representations"][0]["value"] = "N"

    assert stable.document["objects"][0]["payload"]["representations"][0]["value"] == "F"


def test_review_packet_recomputes_each_compilation_binding() -> None:
    result = compile_source(VALID_SOURCE, "water.chem")
    assert result.document is not None

    semantic_document = copy.deepcopy(result.document)
    semantic_document["objects"][0]["payload"]["representations"][0]["value"] = "N"
    stale_semantic = replace(
        result,
        document=semantic_document,
        artifact_bytes=pretty_bytes(semantic_document),
    )
    with pytest.raises(ValueError, match="semantic hash"):
        stale_semantic.review_packet()

    source_document = copy.deepcopy(result.document)
    source_document["objects"][0]["source_references"] = [f"source:sha256:{'0' * 64}"]
    stale_source = replace(
        result,
        document=source_document,
        artifact_bytes=pretty_bytes(source_document),
        semantic_hash=semantic_hash(source_document),
    )
    with pytest.raises(ValueError, match="source hash"):
        stale_source.review_packet()


def test_failed_compilation_cannot_create_review_packet() -> None:
    failed = compile_source("chem 9\n", "unsupported.chem")

    with pytest.raises(ValueError, match="failed compilation"):
        failed.review_packet()


def test_alpha_canonicalizer_rejects_binary_floating_point() -> None:
    with pytest.raises(CanonicalizationError, match="exact integers only"):
        canonical_bytes({"unsupported_number": 0.1})
