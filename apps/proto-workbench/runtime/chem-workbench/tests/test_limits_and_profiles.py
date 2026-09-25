"""Bounded-input and schema-vocabulary tests for the implemented alpha subset."""

from __future__ import annotations

import pytest

import chem_workbench.cli as cli_module
import chem_workbench.compiler as compiler_module
import chem_workbench.validators.core as validator_module
from chem_workbench.compiler import CompilationResult, compile_source
from chem_workbench.parser import ParseResult, parse_source


def codes(result: CompilationResult | ParseResult) -> set[str]:
    return {diagnostic.code for diagnostic in result.diagnostics}


def test_source_byte_limit_rejects_before_parsing_without_a_large_allocation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert compiler_module.MAX_SOURCE_BYTES == 16 * 1024 * 1024
    monkeypatch.setattr(compiler_module, "MAX_SOURCE_BYTES", 8)

    result = compiler_module.compile_source(b"chem 0.1\n", "oversize.chem")

    assert codes(result) == {"CHM1009"}
    assert result.document is None
    assert result.artifact_bytes is None


def test_json_artifact_byte_limit_rejects_before_decoding_without_a_large_allocation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert cli_module.MAX_JSON_ARTIFACT_BYTES == 16 * 1024 * 1024
    monkeypatch.setattr(cli_module, "MAX_JSON_ARTIFACT_BYTES", 2)

    with pytest.raises(ValueError, match="Artifact exceeds the alpha limit of 2 bytes"):
        cli_module._load_json_bytes(b"{}\n")


def test_artifact_object_limit_without_constructing_one_hundred_thousand_objects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    result = compile_source(
        """chem 0.1
molecule one { structure smiles "O" }
molecule two { structure smiles "N" }
molecule three { structure smiles "F" }
"""
    )
    assert result.success
    assert result.document is not None
    monkeypatch.setattr(cli_module, "MAX_OBJECTS", 2)

    with pytest.raises(ValueError, match="objects exceed the alpha limit of 2"):
        cli_module._validate_chemir_document(result.document)


def test_artifact_representation_byte_limit_without_a_large_allocation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    result = compile_source('chem 0.1\nmolecule water { structure smiles "O" }\n')
    assert result.success
    assert result.document is not None
    representation = result.document["objects"][0]["payload"]["representations"][0]
    representation["value"] = "ééé"
    monkeypatch.setattr(cli_module, "MAX_REPRESENTATION_BYTES", 4)

    with pytest.raises(ValueError, match="invalid representation"):
        cli_module._validate_chemir_document(result.document)


def test_twenty_level_list_fails_at_bounded_depth_and_parser_recovers() -> None:
    nested_value = "[" * 20 + "energy" + "]" * 20
    source = f"""chem 0.1
molecule deep {{
  structure smiles "O"
  future_value {nested_value}
}}
molecule recovered {{
  structure smiles "N"
}}
"""

    parsed = parse_source(source, "deep-list.chem")
    compiled = compile_source(source, "deep-list.chem")

    assert parsed.source is not None
    assert [declaration.identifier for declaration in parsed.source.declarations] == [
        "deep",
        "recovered",
    ]
    assert "CHM1009" in codes(parsed)
    assert "CHM1009" in codes(compiled)
    assert compiled.artifact_bytes is None


def test_object_count_limit_without_constructing_one_hundred_thousand_objects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert validator_module.MAX_OBJECTS == 100_000
    monkeypatch.setattr(validator_module, "MAX_OBJECTS", 2)
    source = """chem 0.1
molecule one { structure smiles "O" }
molecule two { structure smiles "N" }
molecule three { structure smiles "F" }
"""

    result = compile_source(source, "too-many-objects.chem")

    assert "CHM2006" in codes(result)
    assert result.document is None
    assert result.artifact_bytes is None


def test_identifier_that_parser_accepts_but_chemir_forbids_fails_closed() -> None:
    result = compile_source(
        """chem 0.1
molecule _foo {
  structure smiles "O"
}
""",
        "bad-id.chem",
    )

    assert "CHM2007" in codes(result)
    assert result.document is None
    assert result.artifact_bytes is None


def test_parent_traversal_in_cif_path_fails_closed() -> None:
    result = compile_source(
        """chem 0.1
crystal escaped {
  structure cif "../outside.cif"
  semantics explicit_configuration
}
""",
        "bad-path.chem",
    )

    assert "CHM2305" in codes(result)
    assert result.document is None
    assert result.artifact_bytes is None


@pytest.mark.parametrize(
    ("task", "properties", "expected_code"),
    [
        ("future_task", "energy", "CHM2410"),
        ("single_point", "future_property", "CHM2409"),
    ],
    ids=("unknown-task", "unknown-property"),
)
def test_unknown_calculation_vocabulary_fails_closed(
    task: str,
    properties: str,
    expected_code: str,
) -> None:
    source = f"""chem 0.1
crystal silicon {{
  structure cif "structures/silicon.cif"
  semantics explicit_configuration
}}
calculation request {{
  target silicon
  task {task}
  properties [{properties}]
  method emt
}}
"""

    result = compile_source(source, "unknown-vocabulary.chem")

    assert expected_code in codes(result)
    assert result.document is None
    assert result.artifact_bytes is None


@pytest.mark.parametrize("field", ["method", "basis"])
def test_registry_identity_name_over_schema_limit_fails_closed(field: str) -> None:
    identity_fields = f'method emt\n  {field} "{"x" * 513}"'
    if field == "method":
        identity_fields = f'method "{"x" * 513}"'
    source = f"""chem 0.1
crystal silicon {{
  structure cif "structures/silicon.cif"
  semantics explicit_configuration
}}
calculation request {{
  target silicon
  task single_point
  properties [energy]
  {identity_fields}
}}
"""

    result = compile_source(source, "long-registry-name.chem")

    assert "CHM2411" in codes(result)
    assert result.document is None
    assert result.artifact_bytes is None


def test_non_nfc_registry_identity_fails_closed() -> None:
    source = """chem 0.1
crystal silicon {
  structure cif "structures/silicon.cif"
  semantics explicit_configuration
}
calculation request {
  target silicon
  task single_point
  properties [energy]
  method "e\u0301mt"
}
"""

    result = compile_source(source, "non-nfc-method.chem")

    assert "CHM2411" in codes(result)
    assert result.document is None
    assert result.artifact_bytes is None
