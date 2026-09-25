"""Export retained original data without model or calculator execution.

The full fixture is the already exposed original 2935e00e study export. Its exact
bytes (SHA-256 febdbb98a5cd4fd10db8a351be1d118b55ae411cef87214ebcdfff92f91439af)
were copied after strict record verification; it is not a new model evaluation case.
"""

from __future__ import annotations

import csv
import hashlib
import json
import threading
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from chem_workbench import web
from chem_workbench.design_studio import DesignStudio
from chem_workbench.visualization import content_hash

FIXTURE = Path(__file__).parent / "fixtures/design-interface-export-retained.json"


def rehash(value: dict[str, Any], field: str) -> None:
    value[field] = content_hash({key: item for key, item in value.items() if key != field})


@pytest.fixture
def saved(tmp_path: Path) -> tuple[DesignStudio, dict[str, Any]]:
    studio = DesignStudio(tmp_path / "build/workspace")
    record = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert hashlib.sha256(FIXTURE.read_bytes()).hexdigest() == (
        "febdbb98a5cd4fd10db8a351be1d118b55ae411cef87214ebcdfff92f91439af"
    )
    studio.import_record(record)
    return studio, record


def export_request(record: dict[str, Any], profile_index: int = 0) -> dict[str, Any]:
    return {
        "reference": record["record_hash"],
        "result_hash": record["interfaces"][profile_index]["result_hash"],
        "format": "json",
        "sample_index": 100,
    }


def assert_exact_numbers(actual: object, expected: object) -> None:
    if isinstance(expected, dict):
        assert isinstance(actual, dict) and actual.keys() == expected.keys()
        for key, value in expected.items():
            assert_exact_numbers(actual[key], value)
    elif isinstance(expected, list):
        assert isinstance(actual, list) and len(actual) == len(expected)
        for left, right in zip(actual, expected, strict=True):
            assert_exact_numbers(left, right)
    elif type(expected) in (float, int):
        assert type(actual) in (float, int)
        assert float(actual).hex() == float(expected).hex()  # type: ignore[arg-type]
    else:
        assert actual == expected


@pytest.mark.parametrize("profile_index", [0, 1, 2])
@pytest.mark.parametrize("file_format", ["json", "csv"])
def test_all_original_samples_units_and_float_bits_export_from_saved_record(
    saved: tuple[DesignStudio, dict[str, Any]], profile_index: int, file_format: str
) -> None:
    studio, record = saved
    simulation = record["interfaces"][profile_index]
    request = export_request(record, profile_index) | {"format": file_format}
    receipt = studio.export_interface(request)
    path = Path(receipt["path"])
    payload = path.read_bytes()
    assert path.parent == studio.store.root.parent / "exports"
    assert receipt["reference"] == record["record_hash"]
    assert receipt["result_hash"] == simulation["result_hash"]
    assert receipt["sample_index"] == 100 and receipt["row_count"] == 101
    assert receipt["format"] == file_format
    assert receipt["file_sha256"] == "sha256:" + hashlib.sha256(payload).hexdigest()
    assert studio.export_interface(request) == receipt
    if file_format == "json":
        document = json.loads(payload)
        assert document["version"] == "interface-view-export/v1"
        assert document["study_record_hash"] == record["record_hash"]
        assert document["simulation_result_hash"] == simulation["result_hash"]
        assert document["selected_sample_index"] == 100
        assert "do not verify imported origin" in document["verification"]
        assert_exact_numbers(document["simulation"], simulation)
    else:
        rows = list(csv.reader(payload.decode().splitlines()))
        assert len(rows) == 102
        columns = [header.split(" [", 1)[0] for header in rows[0]]
        assert columns[0] == "time_s" and set(columns) == set(simulation["series"][0])
        assert rows[0] == [f"{key} [{simulation['units'][key]}]" for key in columns]
        for actual, expected in zip(rows[1:], simulation["series"], strict=True):
            assert len(actual) == len(columns)
            for key, value in zip(columns, actual, strict=True):
                assert float(value).hex() == float(expected[key]).hex()
    assert studio.read(record["record_hash"]) == record


@pytest.mark.parametrize(
    "replacement",
    [
        {"sample_index": True},
        {"sample_index": 1.0},
        {"sample_index": "100"},
        {"sample_index": -1},
        {"sample_index": 101},
        {"format": "../json"},
        {"format": "JSON"},
        {"format": []},
        {"reference": "../../outside"},
        {"result_hash": "../../outside"},
        {"result_hash": "sha256:" + "f" * 64},
        {"path": "outside.csv"},
        {"simulation": {"series": [{"time_s": 0}]}},
    ],
)
def test_only_bound_references_format_and_integer_index_are_accepted(
    saved: tuple[DesignStudio, dict[str, Any]], replacement: dict[str, Any]
) -> None:
    studio, record = saved
    with pytest.raises(ValueError):
        studio.export_interface(export_request(record) | replacement)
    assert not (studio.store.root.parent / "exports").exists()


def test_partial_failure_can_export_retained_success_without_changing_failed_state(
    saved: tuple[DesignStudio, dict[str, Any]],
) -> None:
    studio, record = saved
    record["state"] = "failed"
    record["error"] = {"message": "Second pair intentionally rejected"}
    record["interfaces"] = [record["interfaces"][2]]
    rehash(record, "record_hash")
    studio.import_record(record)
    receipt = studio.export_interface(export_request(record) | {"sample_index": 0})
    document = json.loads(Path(receipt["path"]).read_bytes())
    assert document["selected_sample_index"] == 0
    assert document["study_record_hash"] == record["record_hash"]
    assert studio.read(record["record_hash"])["state"] == "failed"


def test_rejects_stale_mechanism_even_with_valid_outer_result_and_study_hashes(
    saved: tuple[DesignStudio, dict[str, Any]],
) -> None:
    studio, record = saved
    simulation = record["interfaces"][0]
    bond = simulation["mechanism"]["species"][1]["graph"]["bonds"][0]
    assert type(bond["order"]) is float
    bond["order"] = int(bond["order"])
    rehash(simulation, "result_hash")
    rehash(record, "record_hash")
    studio.store._write(studio.directory / (record["record_hash"][7:] + ".json"), record)
    with pytest.raises(ValueError, match="mechanism_hash content mismatch"):
        studio.export_interface(export_request(record))


@pytest.mark.parametrize("invalid_result", ["duplicate", "unsuccessful"])
def test_result_selection_requires_one_successful_retained_result(
    saved: tuple[DesignStudio, dict[str, Any]], invalid_result: str
) -> None:
    studio, record = saved
    if invalid_result == "duplicate":
        record["interfaces"].append(record["interfaces"][0])
    else:
        record["interfaces"][0]["success"] = False
        rehash(record["interfaces"][0], "result_hash")
    rehash(record, "record_hash")
    studio.import_record(record)
    with pytest.raises(ValueError, match="RESULT_BINDING"):
        studio.export_interface(export_request(record))


@pytest.mark.parametrize("units", [None, [], "s", 0, False, {}])
def test_csv_rejects_invalid_imported_units_before_writing_but_json_preserves_them(
    saved: tuple[DesignStudio, dict[str, Any]], units: object
) -> None:
    studio, record = saved
    simulation = record["interfaces"][0]
    simulation["units"] = units
    rehash(simulation, "result_hash")
    rehash(record, "record_hash")
    studio.import_record(record)
    with pytest.raises(ValueError, match="DESIGN_INTERFACE_EXPORT_UNITS"):
        studio.export_interface(export_request(record) | {"format": "csv"})
    assert not (studio.store.root.parent / "exports").exists()
    receipt = studio.export_interface(export_request(record))
    exported = json.loads(Path(receipt["path"]).read_bytes())
    assert exported["simulation"]["units"] == units
    assert_exact_numbers(exported["simulation"], simulation)


def test_csv_quotes_and_escapes_imported_formula_headers(
    saved: tuple[DesignStudio, dict[str, Any]],
) -> None:
    studio, record = saved
    simulation = record["interfaces"][0]
    field = '=HYPERLINK("https://example.invalid","formula")'
    simulation["units"][field] = "1"
    for row in simulation["series"]:
        row[field] = row["time_s"]
    rehash(simulation, "result_hash")
    rehash(record, "record_hash")
    studio.import_record(record)
    receipt = studio.export_interface(export_request(record) | {"format": "csv"})
    with Path(receipt["path"]).open(newline="", encoding="utf-8") as stream:
        rows = list(csv.reader(stream))
    assert "'" + field + " [1]" in rows[0]
    assert len(rows) == 102


def test_changed_existing_export_is_not_overwritten(
    saved: tuple[DesignStudio, dict[str, Any]],
) -> None:
    studio, record = saved
    receipt = studio.export_interface(export_request(record))
    path = Path(receipt["path"])
    path.write_bytes(b"different retained bytes")
    with pytest.raises(ValueError, match="EXISTS_WITH_DIFFERENT_CONTENT"):
        studio.export_interface(export_request(record))
    assert path.read_bytes() == b"different retained bytes"


def test_shared_writer_preserves_existing_full_study_export_contract(
    saved: tuple[DesignStudio, dict[str, Any]],
) -> None:
    studio, record = saved
    receipt = studio.export_record(record["record_hash"])
    assert receipt["version"] == "design-export/v1"
    assert receipt["filename"] == "chem-design-" + record["record_hash"][7:] + ".json"
    assert_exact_numbers(json.loads(Path(receipt["path"]).read_bytes()), record)
    assert studio.export_record(record["record_hash"]) == receipt


@pytest.mark.parametrize("link_kind", ["directory", "file"])
def test_linked_export_targets_are_rejected_before_writing(
    saved: tuple[DesignStudio, dict[str, Any]], monkeypatch: pytest.MonkeyPatch, link_kind: str
) -> None:
    studio, record = saved
    directory = studio.store.root.parent / "exports"
    original = Path.is_symlink
    monkeypatch.setattr(
        Path,
        "is_symlink",
        lambda path: (
            (path == directory if link_kind == "directory" else path.parent == directory)
            or original(path)
        ),
    )
    with pytest.raises(ValueError, match=r"EXPORT_.*_BINDING"):
        studio.export_interface(export_request(record))
    assert not list(directory.glob("*.json"))


def test_local_http_route_saves_host_data_and_rejects_foreign_origin_or_extra_fields(
    saved: tuple[DesignStudio, dict[str, Any]], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _studio, record = saved
    monkeypatch.setattr(web, "ROOT", tmp_path)
    server = ThreadingHTTPServer(("127.0.0.1", 0), web.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    connection = HTTPConnection("127.0.0.1", server.server_port, timeout=10)
    try:
        for data, origin, expected in [
            (export_request(record), None, 200),
            (export_request(record) | {"path": "outside.json"}, None, 400),
            (export_request(record), "https://foreign.example", 403),
        ]:
            headers = {"Content-Type": "application/json"}
            if origin:
                headers["Origin"] = origin
            connection.request("POST", "/api/design/export-interface", json.dumps(data), headers)
            response = connection.getresponse()
            assert response.status == expected
            document = json.loads(response.read())
            if expected == 200:
                assert Path(document["path"]).is_file()
                assert document["row_count"] == 101
    finally:
        connection.close()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
