"""Subprocess tests for the user-visible offline CLI contract."""

from __future__ import annotations

import copy
import json
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

import chem_workbench.cli as cli_module
from chem_workbench.chemir import pretty_bytes
from chem_workbench.compiler import compile_source

RunChem = Callable[..., subprocess.CompletedProcess[bytes]]

VALID_SOURCE = """chem 0.1
molecule water {
  structure smiles "O"
}
"""

CRYSTAL_SOURCE = """chem 0.1
crystal silicon {
  structure cif "structures/silicon.cif"
  semantics explicit_configuration
}
"""

WORKFLOW_SOURCE = """chem 0.1
molecule water {
  structure smiles "O"
}
conditions water_conditions {
  target water
  phase gas
  temperature 0
  temperature_unit kelvin
}
electronic_state water_state {
  target water
  finite charge 0 multiplicity 1
}
calculation water_energy {
  target water
  state water_state
  conditions water_conditions
  task single_point
  properties [energy]
  method hf
  basis sto-3g
}
"""


def compiled_document(source: str = WORKFLOW_SOURCE) -> dict[str, object]:
    result = compile_source(source, "fixture.chem")
    assert result.success
    assert result.document is not None
    return copy.deepcopy(result.document)


def object_of_kind(document: dict[str, object], kind: str) -> dict[str, object]:
    objects = document["objects"]
    assert isinstance(objects, list)
    return next(item for item in objects if isinstance(item, dict) and item.get("kind") == kind)


def test_compile_failure_writes_no_output_artifact(
    tmp_path: Path,
    run_chem: RunChem,
) -> None:
    source = tmp_path / "invalid.chem"
    output = tmp_path / "must-not-exist.json"
    source.write_text(
        """chem 0.1
molecule water {
  structure smiles "O"
  unknown_field true
}
""",
        encoding="utf-8",
    )

    completed = run_chem("compile", source, "--output", output)

    assert completed.returncode == 1
    assert completed.stdout == b""
    assert b"CHM2004" in completed.stderr
    assert b"no ChemIR artifact was written" in completed.stderr
    assert not output.exists()


def test_existing_output_requires_force_and_is_never_partially_replaced(
    tmp_path: Path,
    run_chem: RunChem,
) -> None:
    source = tmp_path / "water.chem"
    output = tmp_path / "water.chemir.json"
    source.write_text(VALID_SOURCE, encoding="utf-8")
    output.write_bytes(b"sentinel: preserve me")

    refused = run_chem("compile", source, "--output", output)

    assert refused.returncode == 2
    assert refused.stdout == b""
    assert b"Output already exists" in refused.stderr
    assert b"--force" in refused.stderr
    assert output.read_bytes() == b"sentinel: preserve me"

    replaced = run_chem("compile", source, "--output", output, "--force")

    assert replaced.returncode == 0
    assert replaced.stderr.count(b"CHM2103") == 1
    document = json.loads(output.read_text(encoding="utf-8"))
    assert document["schema_version"] == "chemir/v1alpha1"
    assert document["objects"][0]["id"] == "water"


def test_atomic_output_failure_preserves_destination_and_removes_temporary_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    output = tmp_path / "artifact.json"
    output.write_bytes(b"sentinel: preserve me")

    def fail_replace(_source: object, _destination: object) -> None:
        raise OSError("injected replace failure")

    monkeypatch.setattr(cli_module.os, "replace", fail_replace)

    with pytest.raises(OSError, match="injected replace failure"):
        cli_module._write_artifact(str(output), b"new artifact", force=True)

    assert output.read_bytes() == b"sentinel: preserve me"
    assert list(tmp_path.glob(".artifact.json.*.tmp")) == []


def test_non_force_publish_does_not_overwrite_a_concurrently_created_destination(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    output = tmp_path / "artifact.json"
    original_link = cli_module.os.link

    def race_link(source: object, destination: object) -> None:
        Path(destination).write_bytes(b"concurrent writer")
        original_link(source, destination)

    monkeypatch.setattr(cli_module.os, "link", race_link)

    with pytest.raises(ValueError, match="Output already exists"):
        cli_module._write_artifact(str(output), b"our artifact", force=False)

    assert output.read_bytes() == b"concurrent writer"
    assert list(tmp_path.glob(".artifact.json.*.tmp")) == []


def test_review_compile_emits_deterministic_packet(
    tmp_path: Path,
    run_chem: RunChem,
) -> None:
    source = tmp_path / "water.chem"
    source.write_text(VALID_SOURCE, encoding="utf-8")

    first = run_chem("review-compile", source)
    second = run_chem("review-compile", source)

    assert first.returncode == second.returncode == 0
    assert first.stdout == second.stdout
    packet = json.loads(first.stdout)
    assert packet["packet_version"] == "review/v1alpha1"
    assert packet["source_hashes"][0]["type"] == "source_sha256"
    assert packet["chemir_semantic_hash"]["type"] == "semantic_hash"
    assert packet["chemir_artifact_hash"]["type"] == "artifact_sha256"
    assert packet["verification_scope"] == "self_consistency"
    assert packet["signature_status"] == "unsigned"
    assert "claims" not in packet
    assert packet["observations"][0]["observation_type"] == "SOURCE_PARSE_ACCEPTED"
    assert {entry["claim"] for entry in packet["not_claimed"]} == {
        "PARSE_VALID",
        "STRUCTURE_MODEL_CONSISTENT",
        "CHEMISTRY_CHECKED",
    }


def test_inspect_detects_tampered_review_packet(
    tmp_path: Path,
    run_chem: RunChem,
) -> None:
    compilation = compile_source(VALID_SOURCE, "water.chem")
    assert compilation.success
    packet = compilation.review_packet()
    representation = packet["chemir"]["objects"][0]["payload"]["representations"][0]
    representation["value"] = "N"
    tampered_packet = tmp_path / "tampered.review.json"
    tampered_packet.write_bytes(pretty_bytes(packet))

    completed = run_chem("inspect", tampered_packet)

    assert completed.returncode == 1
    assert completed.stdout == b""
    assert b"CHM9005" in completed.stderr
    assert b"semantic hash binding mismatch" in completed.stderr


def test_inspect_accepts_valid_review_packet_and_reports_verified_bindings(
    tmp_path: Path,
    run_chem: RunChem,
) -> None:
    compilation = compile_source(VALID_SOURCE, "water.chem")
    assert compilation.success
    packet_path = tmp_path / "valid.review.json"
    packet_path.write_bytes(pretty_bytes(compilation.review_packet()))

    completed = run_chem("inspect", packet_path)

    assert completed.returncode == 0
    assert completed.stderr == b""
    summary = json.loads(completed.stdout)
    assert summary["artifact_type"] == "ReviewPacket"
    assert summary["bindings_valid"] is True
    assert summary["observation_count"] == 1
    assert summary["verification_scope"] == "self_consistency"
    assert summary["signature_status"] == "unsigned"
    assert "claim_count" not in summary


def test_inspect_preserves_read_only_support_for_a1_review_packets(
    tmp_path: Path,
    run_chem: RunChem,
) -> None:
    compilation = compile_source(VALID_SOURCE, "water.chem")
    assert compilation.success
    packet = compilation.review_packet()
    packet["compiler"] = "chem-workbench/0.1.0a1"
    packet["observations"][0]["producer"] = "chem-workbench/0.1.0a1"
    packet_path = tmp_path / "legacy-a1.review.json"
    packet_path.write_bytes(pretty_bytes(packet))

    completed = run_chem("inspect", packet_path)

    assert completed.returncode == 0
    assert completed.stderr == b""
    summary = json.loads(completed.stdout)
    assert summary["artifact_type"] == "ReviewPacket"
    assert summary["bindings_valid"] is True


@pytest.mark.parametrize(
    ("tamper", "expected_return_code", "expected_error_code"),
    [
        ("source-hashes", 1, b"CHM9005"),
        ("chemir-artifact-hash", 1, b"CHM9005"),
        ("compiler", 2, b"CHM9004"),
        ("canonicalization", 2, b"CHM9004"),
        ("normalization-profile", 2, b"CHM9004"),
        ("verification-scope", 2, b"CHM9004"),
        ("signature-status", 2, b"CHM9004"),
        ("lab-approval-observation", 2, b"CHM9004"),
        ("unknown-observation", 2, b"CHM9004"),
        ("parse-evidence", 1, b"CHM9005"),
        ("unknown-top-level-field", 2, b"CHM9004"),
    ],
)
def test_inspect_rejects_tampered_or_authority_expanding_review_packet(
    tamper: str,
    expected_return_code: int,
    expected_error_code: bytes,
    tmp_path: Path,
    run_chem: RunChem,
) -> None:
    compilation = compile_source(VALID_SOURCE, "water.chem")
    assert compilation.success
    packet = compilation.review_packet()

    if tamper == "source-hashes":
        record = packet["source_hashes"][0]
        record["value"] = ("0" if record["value"][0] != "0" else "1") + record["value"][1:]
    elif tamper == "chemir-artifact-hash":
        record = packet["chemir_artifact_hash"]
        record["value"] = ("0" if record["value"][0] != "0" else "1") + record["value"][1:]
    elif tamper == "compiler":
        packet["compiler"] = "unknown-compiler/9"
    elif tamper == "canonicalization":
        packet["canonicalization"] = "unknown-canonicalization"
    elif tamper == "normalization-profile":
        packet["normalization_profile"] = "unknown-normalization"
    elif tamper == "verification-scope":
        packet["verification_scope"] = "authority_verification"
    elif tamper == "signature-status":
        packet["signature_status"] = "verified"
    elif tamper in {"lab-approval-observation", "unknown-observation"}:
        forbidden_observation = copy.deepcopy(packet["observations"][0])
        forbidden_observation["observation_type"] = (
            "LAB_EXECUTION_APPROVED"
            if tamper == "lab-approval-observation"
            else "FUTURE_OBSERVATION"
        )
        if tamper == "lab-approval-observation":
            packet["observations"].append(forbidden_observation)
        else:
            packet["observations"] = [forbidden_observation]
    elif tamper == "parse-evidence":
        record = packet["observations"][0]["evidence_hashes"][0]
        record["value"] = ("0" if record["value"][0] != "0" else "1") + record["value"][1:]
    else:
        packet["unexpected"] = "must fail closed"

    packet_path = tmp_path / f"tampered-{tamper}.review.json"
    packet_path.write_bytes(pretty_bytes(packet))

    completed = run_chem("inspect", packet_path)

    assert completed.returncode == expected_return_code
    assert completed.stdout == b""
    assert expected_error_code in completed.stderr
    assert b"Traceback" not in completed.stderr


def test_review_compile_rejects_noncanonical_chemir_without_writing_output(
    tmp_path: Path,
    run_chem: RunChem,
) -> None:
    compilation = compile_source(VALID_SOURCE, "water.chem")
    assert compilation.success
    assert compilation.document is not None
    noncanonical = tmp_path / "noncanonical.chemir.json"
    noncanonical.write_text(
        json.dumps(compilation.document, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    output = tmp_path / "must-not-exist.review.json"

    completed = run_chem("review-compile", noncanonical, "--output", output)

    assert completed.returncode == 2
    assert completed.stdout == b""
    assert b"CHM9004" in completed.stderr
    assert b"not the canonical pretty-JSON artifact" in completed.stderr
    assert not output.exists()


def test_inspect_rejects_excessive_json_nesting_without_traceback(
    tmp_path: Path,
    run_chem: RunChem,
) -> None:
    nested = b"[" * 128 + b"0" + b"]" * 128
    artifact = tmp_path / "deeply-nested.json"
    artifact.write_bytes(b'{"nested":' + nested + b"}\n")

    completed = run_chem("inspect", artifact)

    assert completed.returncode == 2
    assert completed.stdout == b""
    assert b"CHM9004" in completed.stderr
    assert b"nesting" in completed.stderr.lower()
    assert b"Traceback" not in completed.stderr


@pytest.mark.parametrize(
    "invalidity",
    ["schema-version", "object-kind", "payload-field"],
)
def test_inspect_rejects_unknown_version_kind_and_payload_field(
    invalidity: str,
    tmp_path: Path,
    run_chem: RunChem,
) -> None:
    document = compiled_document(VALID_SOURCE)
    molecule = object_of_kind(document, "Molecule")
    if invalidity == "schema-version":
        document["schema_version"] = "chemir/v999"
    elif invalidity == "object-kind":
        molecule["kind"] = "FutureObject"
    else:
        payload = molecule["payload"]
        assert isinstance(payload, dict)
        payload["unknown_field"] = "must fail closed"
    artifact = tmp_path / f"unknown-{invalidity}.json"
    artifact.write_bytes(pretty_bytes(document))

    completed = run_chem("inspect", artifact)

    assert completed.returncode == 2
    assert completed.stdout == b""
    assert b"CHM9004" in completed.stderr


def test_inspect_rejects_duplicate_object_identifiers(
    tmp_path: Path,
    run_chem: RunChem,
) -> None:
    document = compiled_document(VALID_SOURCE)
    objects = document["objects"]
    assert isinstance(objects, list)
    objects.append(copy.deepcopy(objects[0]))
    artifact = tmp_path / "duplicate-id.json"
    artifact.write_bytes(pretty_bytes(document))

    completed = run_chem("inspect", artifact)

    assert completed.returncode == 2
    assert completed.stdout == b""
    assert b"CHM9004" in completed.stderr
    assert b"duplicate" in completed.stderr.lower()


@pytest.mark.parametrize(
    ("kind", "field"),
    [
        ("ElectronicState", "target_reference"),
        ("CalculationSpec", "target_reference"),
        ("CalculationSpec", "electronic_state_reference"),
    ],
    ids=("electronic-state-target", "calculation-target", "calculation-state"),
)
def test_inspect_rejects_dangling_object_references(
    kind: str,
    field: str,
    tmp_path: Path,
    run_chem: RunChem,
) -> None:
    document = compiled_document()
    target_object = object_of_kind(document, kind)
    payload = target_object["payload"]
    assert isinstance(payload, dict)
    payload[field] = "missing-object"
    artifact = tmp_path / f"dangling-{kind}-{field}.json"
    artifact.write_bytes(pretty_bytes(document))

    completed = run_chem("inspect", artifact)

    assert completed.returncode == 2
    assert completed.stdout == b""
    assert b"CHM9004" in completed.stderr
    assert b"dangling" in completed.stderr


def test_review_compile_rejects_invalid_chemir_before_writing_packet(
    tmp_path: Path,
    run_chem: RunChem,
) -> None:
    document = compiled_document(VALID_SOURCE)
    molecule = object_of_kind(document, "Molecule")
    molecule["kind"] = "FutureObject"
    artifact = tmp_path / "unknown-kind.chemir.json"
    output = tmp_path / "must-not-exist.review.json"
    artifact.write_bytes(pretty_bytes(document))

    completed = run_chem("review-compile", artifact, "--output", output)

    assert completed.returncode == 2
    assert completed.stdout == b""
    assert b"CHM9004" in completed.stderr
    assert not output.exists()


@pytest.mark.parametrize(
    "invalidity",
    [
        "identifier",
        "identifier-length",
        "cif-path",
        "cif-path-length",
        "calculation-task",
        "calculation-property",
        "duplicate-properties",
        "method-name",
        "basis-name",
        "empty-representation",
    ],
)
def test_inspect_enforces_source_and_schema_bounds_on_handwritten_artifacts(
    invalidity: str,
    tmp_path: Path,
    run_chem: RunChem,
) -> None:
    if invalidity in {"cif-path", "cif-path-length"}:
        document = compiled_document(CRYSTAL_SOURCE)
        periodic = object_of_kind(document, "PeriodicStructure")
        payload = periodic["payload"]
        assert isinstance(payload, dict)
        representations = payload["representations"]
        assert isinstance(representations, list)
        if invalidity == "cif-path":
            representations[0]["path"] = "../outside.cif"
        else:
            representations[0]["path"] = "x" * 4097
    elif invalidity in {
        "calculation-task",
        "calculation-property",
        "duplicate-properties",
        "method-name",
        "basis-name",
    }:
        document = compiled_document()
        calculation = object_of_kind(document, "CalculationSpec")
        payload = calculation["payload"]
        assert isinstance(payload, dict)
        if invalidity == "calculation-task":
            payload["task"] = "future_task"
        elif invalidity == "calculation-property":
            payload["properties"] = ["future_property"]
        elif invalidity == "duplicate-properties":
            payload["properties"] = ["energy", "energy"]
        elif invalidity == "method-name":
            payload["method"] = {"name": "x" * 513}
        else:
            payload["basis"] = {"name": "x" * 513}
    else:
        document = compiled_document(VALID_SOURCE)
        molecule = object_of_kind(document, "Molecule")
        if invalidity == "identifier":
            molecule["id"] = "_foo"
        elif invalidity == "identifier-length":
            molecule["id"] = "x" * 257
        else:
            payload = molecule["payload"]
            assert isinstance(payload, dict)
            representations = payload["representations"]
            assert isinstance(representations, list)
            representations[0]["value"] = ""
    artifact = tmp_path / f"bounded-{invalidity}.json"
    artifact.write_bytes(pretty_bytes(document))

    completed = run_chem("inspect", artifact)

    assert completed.returncode == 2
    assert completed.stdout == b""
    assert b"CHM9004" in completed.stderr


@pytest.mark.parametrize("command", ["compute", "fetch"])
def test_planned_commands_exit_three_without_invoking_a_backend(
    command: str,
    run_chem: RunChem,
    tmp_path: Path,
) -> None:
    forbidden_output = tmp_path / f"{command}.json"
    completed = run_chem(command, forbidden_output)

    assert completed.returncode == 3
    assert completed.stdout == b""
    assert b"planned but unavailable" in completed.stderr
    assert b"No backend, network service, approval ledger, or laboratory path was invoked" in (
        completed.stderr
    )
    assert not forbidden_output.exists()
