"""Real local candidate/mechanism/ODE/API integration; model responses are explicitly mocked."""

from __future__ import annotations

import copy
import hashlib
import json
import shutil
import subprocess
import threading
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from chem_workbench import design_studio, web
from chem_workbench.design_studio import DesignRunError, DesignStudio, default_study, empty_decision
from chem_workbench.execution_validation import digest_id, verify_hash
from chem_workbench.visualization import content_hash


def request(workflow: str = "interface_design") -> dict[str, Any]:
    study = default_study()
    study["organic"].update(fragment_ids=["methyl", "pyridyl"], source="Original organic source")
    study["inorganic"].update(
        a_elements=["Sr"], b_pairs=[["Sc", "Nb"]], source="Original oxide source"
    )
    decision = empty_decision(workflow)
    decision["max_candidates"] = 2
    return {
        "prompt": "Explicit direct integration fixture",
        "study": study,
        "mode": "direct",
        "decision": decision,
    }


def test_actual_full_design_persists_candidate_geometry_and_all_three_reaction_models(
    tmp_path: Path,
) -> None:
    studio = DesignStudio(tmp_path)
    supplied = request()
    original = copy.deepcopy(supplied)
    record = studio.run(supplied)
    assert supplied == original
    assert record["state"] == "completed"
    assert len(record["organic"]["candidates"]) == 2
    assert len(record["inorganic"]["candidates"]) == 1
    assert len(record["interfaces"]) == 3
    assert len(record["trace"]) == 5
    assert studio.read(record["record_hash"]) == record
    verify_hash(record, "record_hash")
    verify_hash(record["plan"], "logical_plan_hash")
    assert record["authorization"]["model_grants_authority"] is False
    assert record["authorization"]["origin"] == "explicit_user_run_request"
    candidates = {family: record[family]["candidates"][0] for family in ("organic", "inorganic")}
    for family, candidate in candidates.items():
        verify_hash(candidate, "candidate_hash")
        verify_hash(candidate["geometry"], "geometry_hash")
        assert candidate["request_hash"] == content_hash(record[family]["request"])
        assert candidate["geometry"]["source_hash"] == candidate["request_hash"]
        assert record[family]["request"]["source"] == supplied["study"][family]["source"]
    for simulation in record["interfaces"]:
        verify_hash(simulation, "result_hash")
        verify_hash(simulation["mechanism"], "mechanism_hash")
        assert simulation["candidate_hashes"] == {k: content_hash(v) for k, v in candidates.items()}
        assert simulation["balances"]["passed"] is True
        assert simulation["scientifically_calibrated"] is False
        assert simulation["parameter_status"] == "illustrative"
        assert all(p["passed"] for p in simulation["mechanism"]["conservation_proofs"])


def test_mocked_sampled_decision_matches_direct_logical_plan_and_real_results(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    studio = DesignStudio(tmp_path)
    direct_request = request()
    direct = studio.run(direct_request)
    sampled = copy.deepcopy(direct_request["decision"])
    monkeypatch.setattr(
        design_studio,
        "route_design",
        lambda prompt, study: {
            "model_action": sampled,
            "test_evidence": "synthetic model response; no inference",
        },
    )
    model_request = copy.deepcopy(direct_request)
    model_request.update(mode="model", decision=None)
    model = studio.run(model_request)
    assert model["plan"] == direct["plan"]
    assert model["organic"] == direct["organic"]
    assert model["inorganic"] == direct["inorganic"]
    assert model["interfaces"] == direct["interfaces"]
    assert model["sampled_decision"] == sampled
    assert model["authorization"]["model_grants_authority"] is False


def test_source_revision_invalidates_binding_without_substituting_geometry(tmp_path: Path) -> None:
    studio = DesignStudio(tmp_path)
    initial = request("organic_design")
    first = studio.run(initial)
    changed = copy.deepcopy(initial)
    changed["study"]["organic"]["source"] = "Edited source revision"
    second = studio.run(changed)
    left, right = first["organic"]["candidates"][0], second["organic"]["candidates"][0]
    assert first["plan"]["logical_plan_hash"] != second["plan"]["logical_plan_hash"]
    assert left["identity_hash"] == right["identity_hash"]
    assert left["candidate_hash"] != right["candidate_hash"]
    assert left["geometry"]["atoms"] == right["geometry"]["atoms"]
    assert left["geometry"]["geometry_hash"] != right["geometry"]["geometry_hash"]
    assert (
        studio.read(first["record_hash"])["organic"]["request"]["source"]
        == "Original organic source"
    )


def test_existing_pair_is_reused_exactly_and_stale_selection_is_persisted_as_failure(
    tmp_path: Path,
) -> None:
    studio = DesignStudio(tmp_path)
    first = studio.run(request())
    selected = request("interface_simulation")
    organic = first["organic"]["candidates"][1]
    inorganic = first["inorganic"]["candidates"][0]
    selected["study"]["selected_candidates"] = {
        "run_ref": first["record_hash"],
        "organic_hash": organic["candidate_hash"],
        "inorganic_hash": inorganic["candidate_hash"],
    }
    result = studio.run(selected)
    assert result["organic"]["candidates"] == [organic]
    assert result["inorganic"]["candidates"] == [inorganic]
    assert result["selected_pair"]["organic"] == organic["candidate_hash"]
    assert all(
        item["candidate_hashes"]["organic"] == content_hash(organic)
        for item in result["interfaces"]
    )
    selected["study"]["selected_candidates"]["organic_hash"] = "sha256:" + "f" * 64
    with pytest.raises(DesignRunError) as failure:
        studio.run(selected)
    assert "BINDING_MISMATCH" in str(failure.value)
    assert failure.value.record["state"] == "failed"
    assert failure.value.record["interfaces"] == []
    assert studio.read(failure.value.record["record_hash"]) == failure.value.record


def test_supplied_parameters_bound_to_old_candidate_cannot_run_for_a_changed_pair(
    tmp_path: Path,
) -> None:
    studio = DesignStudio(tmp_path)
    baseline = studio.run(request())
    candidate = baseline["organic"]["candidates"][1]
    selected = request("interface_simulation")
    selected["decision"]["interfaces"] = ["solid_liquid"]
    selected["study"]["selected_candidates"] = {
        "run_ref": baseline["record_hash"],
        "organic_hash": candidate["candidate_hash"],
        "inorganic_hash": baseline["inorganic"]["candidates"][0]["candidate_hash"],
    }
    old_spec = next(x for x in baseline["interfaces"] if x["profile"] == "solid_liquid")["inputs"][
        "spec"
    ]
    selected["study"]["interface_parameters"] = {"mode": "supplied", "specifications": [old_spec]}
    with pytest.raises(DesignRunError, match="CANDIDATE_BINDING_MISMATCH") as failure:
        studio.run(selected)
    assert failure.value.record["interfaces"] == []


def test_saved_record_integrity_rejects_changed_coordinate_bytes(tmp_path: Path) -> None:
    studio = DesignStudio(tmp_path)
    record = studio.run(request("organic_design"))
    path = studio.directory / (digest_id(record["record_hash"]) + ".json")
    altered = copy.deepcopy(record)
    altered["organic"]["candidates"][0]["geometry"]["atoms"][0]["position"][0] += 0.25
    path.write_text(json.dumps(altered), encoding="utf-8")
    with pytest.raises(ValueError):
        studio.read(record["record_hash"])


def test_export_reopens_in_an_empty_workspace_without_running_any_modules(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    origin = DesignStudio(tmp_path / "origin")
    original = origin.run(request())
    destination = DesignStudio(tmp_path / "destination")

    def unexpected_execution(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("Opening an exported record must not execute a workflow")

    monkeypatch.setattr(DesignStudio, "run", unexpected_execution)
    monkeypatch.setattr(design_studio, "route_design", unexpected_execution)
    receipt = origin.export_record(original["record_hash"])
    exported_path = Path(receipt["path"])
    assert exported_path.is_absolute()
    assert exported_path.parent == tmp_path / "exports"
    assert exported_path.name == "chem-design-" + digest_id(original["record_hash"]) + ".json"
    assert receipt["reference"] == original["record_hash"]
    payload = exported_path.read_bytes()
    assert receipt["file_sha256"] == "sha256:" + hashlib.sha256(payload).hexdigest()
    assert receipt["size_bytes"] == len(payload)
    exported = json.loads(payload)
    assert exported == original
    imported = destination.import_record(exported)
    assert imported == original
    assert destination.read(original["record_hash"]) == original
    exported["request"]["study"]["name"] = "Edited import object"
    assert destination.read(original["record_hash"])["request"]["study"]["name"] != (
        "Edited import object"
    )


def test_local_export_reuses_identical_bytes_and_never_overwrites_a_different_file(
    tmp_path: Path,
) -> None:
    studio = DesignStudio(tmp_path / "workspace")
    record = studio.run(request("organic_design"))
    first = studio.export_record(record["record_hash"])
    exported = Path(first["path"])
    original_mtime = exported.stat().st_mtime_ns
    assert studio.export_record(record["record_hash"]) == first
    assert exported.stat().st_mtime_ns == original_mtime
    changed = b'{"different": "preexisting artifact"}\n'
    exported.write_bytes(changed)
    with pytest.raises(ValueError, match="DESIGN_EXPORT_EXISTS_WITH_DIFFERENT_CONTENT"):
        studio.export_record(record["record_hash"])
    assert exported.read_bytes() == changed
    assert studio.read(record["record_hash"]) == record


def test_rehashed_export_still_rejects_an_unbound_nested_geometry(tmp_path: Path) -> None:
    studio = DesignStudio(tmp_path)
    altered = copy.deepcopy(studio.run(request("organic_design")))
    candidate = altered["organic"]["candidates"][0]
    candidate["geometry"]["atoms"][0]["position"][0] += 0.5
    for item, field in (
        (candidate, "candidate_hash"),
        (altered["organic"], "result_hash"),
        (altered, "record_hash"),
    ):
        item.pop(field)
        item[field] = content_hash(item)
    with pytest.raises(ValueError):
        studio.import_record(altered)
    assert not (studio.directory / (digest_id(altered["record_hash"]) + ".json")).exists()


def test_browser_number_normalization_is_rejected_but_raw_export_text_reopens_over_http(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is required to verify the real browser number serialization boundary")
    studio = DesignStudio(tmp_path / "build" / "workspace")
    record = studio.run(request())
    receipt = studio.export_record(record["record_hash"])
    encoded = subprocess.run(
        [
            node,
            "-e",
            "const text=require('node:fs').readFileSync(process.argv[1],'utf8');"
            "process.stdout.write(JSON.stringify({"
            "normalized:JSON.stringify({record:JSON.parse(text)}),"
            "raw:JSON.stringify({document:text})}));",
            receipt["path"],
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=15,
        check=True,
    )
    bodies = json.loads(encoded.stdout)
    normalized = json.loads(bodies["normalized"])["record"]
    with pytest.raises(ValueError):
        verify_hash(normalized, "record_hash")
    assert json.loads(bodies["raw"])["document"] == Path(receipt["path"]).read_text(
        encoding="utf-8"
    )
    monkeypatch.setattr(web, "ROOT", tmp_path)
    server = ThreadingHTTPServer(("127.0.0.1", 0), web.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    connection = HTTPConnection("127.0.0.1", server.server_port, timeout=10)
    try:
        for kind, status in (("normalized", 400), ("raw", 200)):
            connection.request(
                "POST",
                "/api/design/import",
                bodies[kind].encode("utf-8"),
                {"Content-Type": "application/json"},
            )
            response = connection.getresponse()
            assert response.status == status
            reopened = json.loads(response.read())
            if status == 200:
                assert reopened == record
                verify_hash(reopened, "record_hash")
                verify_hash(reopened["interfaces"][0], "result_hash")
            else:
                assert "error" in reopened
        for invalid in ({"document": 42}, {"document": "{", "record": record}):
            connection.request(
                "POST",
                "/api/design/import",
                json.dumps(invalid).encode("utf-8"),
                {"Content-Type": "application/json"},
            )
            response = connection.getresponse()
            assert response.status == 400
            response.read()
    finally:
        connection.close()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_http_design_run_read_and_error_evidence_are_real_and_loopback_confined(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(web, "ROOT", tmp_path)
    server = ThreadingHTTPServer(("127.0.0.1", 0), web.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    connection = HTTPConnection("127.0.0.1", server.server_port, timeout=10)
    try:
        connection.request("GET", "/api/design/catalog")
        response = connection.getresponse()
        assert response.status == 200
        assert json.loads(response.read())["version"] == "design-catalog/v1"
        body = request("organic_design")
        connection.request(
            "POST", "/api/design/run", json.dumps(body), {"Content-Type": "application/json"}
        )
        response = connection.getresponse()
        assert response.status == 200
        result = json.loads(response.read())
        assert result["state"] == "completed"
        connection.request(
            "POST",
            "/api/design/read",
            json.dumps({"reference": result["record_hash"]}),
            {"Content-Type": "application/json"},
        )
        response = connection.getresponse()
        assert response.status == 200
        assert json.loads(response.read()) == result
        connection.request(
            "POST",
            "/api/design/export",
            json.dumps({"reference": result["record_hash"]}),
            {"Content-Type": "application/json"},
        )
        response = connection.getresponse()
        assert response.status == 200
        receipt = json.loads(response.read())
        exported_path = Path(receipt["path"])
        assert exported_path.parent == tmp_path / "build" / "exports"
        exported_bytes = exported_path.read_bytes()
        assert json.loads(exported_bytes) == result
        assert receipt["file_sha256"] == "sha256:" + hashlib.sha256(exported_bytes).hexdigest()
        connection.request(
            "POST",
            "/api/design/export",
            json.dumps({"reference": result["record_hash"], "path": "unexpected.json"}),
            {"Content-Type": "application/json"},
        )
        response = connection.getresponse()
        assert response.status == 400
        response.read()
        connection.request(
            "POST",
            "/api/design/export",
            json.dumps({"reference": result["record_hash"]}),
            {"Content-Type": "application/json", "Origin": "https://foreign.example"},
        )
        response = connection.getresponse()
        assert response.status == 403
        response.read()
        connection.request(
            "POST",
            "/api/design/import",
            json.dumps({"record": result}),
            {"Content-Type": "application/json"},
        )
        response = connection.getresponse()
        assert response.status == 200
        assert json.loads(response.read()) == result
        tampered = copy.deepcopy(result)
        tampered["organic"]["candidates"][0]["geometry"]["atoms"][0]["position"][0] += 1
        connection.request(
            "POST",
            "/api/design/import",
            json.dumps({"record": tampered}),
            {"Content-Type": "application/json"},
        )
        response = connection.getresponse()
        assert response.status == 400
        assert "error" in json.loads(response.read())
        body["decision"]["workflow"] = "unregistered_template"
        connection.request(
            "POST", "/api/design/run", json.dumps(body), {"Content-Type": "application/json"}
        )
        response = connection.getresponse()
        assert response.status == 400
        failed = json.loads(response.read())
        assert failed["design_record"]["state"] == "rejected"
        verify_hash(failed["design_record"], "record_hash")
        connection.request(
            "POST",
            "/api/design/run",
            json.dumps(request()),
            {"Content-Type": "application/json", "Origin": "https://foreign.example"},
        )
        response = connection.getresponse()
        assert response.status == 403
        response.read()
    finally:
        connection.close()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
