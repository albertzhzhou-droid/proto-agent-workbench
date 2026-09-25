"""HTTP and host-policy boundaries; no native scientific process or model calls."""

from __future__ import annotations

import json
import threading
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from chem_workbench import web
from chem_workbench.design_studio import DesignStudio
from chem_workbench.refinement_execution import workbench_preparation as preparation
from chem_workbench.visualization import content_hash

SELECTION = {"run_ref": "sha256:" + "1" * 64, "candidate_hash": "sha256:" + "2" * 64}


@pytest.fixture
def endpoint(monkeypatch):
    calls = []
    workflow = SimpleNamespace(
        approve_refinement=lambda reference: calls.append(("approve", reference)) or {"ok": True},
        submit=lambda reference: calls.append(("submit", reference)) or {"ok": True},
        read=lambda reference: calls.append(("read", reference)) or {"refinement_view": None},
    )
    monkeypatch.setattr(web, "services", lambda server: (workflow, None))

    def prepare(service, data):
        assert service is workflow
        calls.append(("prepare", data))
        return {"reference": "sha256:" + "3" * 64, "refinement_view": None}

    monkeypatch.setattr(web, "prepare_selection", prepare)
    server = ThreadingHTTPServer(("127.0.0.1", 0), web.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    connection = HTTPConnection("127.0.0.1", server.server_port, timeout=5)

    def request(path, data=None, **headers):
        method = "GET" if data is None else "POST"
        content = None if data is None else json.dumps(data)
        connection.request(method, path, content, {"Content-Type": "application/json", **headers})
        response = connection.getresponse()
        return response.status, response.read(), dict(response.getheaders())

    try:
        yield request, calls
    finally:
        connection.close()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_refinement_endpoints_use_dedicated_service_and_common_status(endpoint):
    request, calls = endpoint
    data = {"selection": SELECTION, "mode": "gradient"}
    status, body, _ = request("/api/workflow/refinement/prepare", data)
    assert status == 200
    reference = json.loads(body)["reference"]
    assert calls == [("prepare", data)]
    for path in ("refinement/approve", "submit", "read"):
        status, _, _ = request("/api/workflow/" + path, {"reference": reference})
        assert status == 200
    assert calls[1:] == [("approve", reference), ("submit", reference), ("read", reference)]


def test_refinement_approval_rejects_editor_authority_and_foreign_origin(endpoint):
    request, calls = endpoint
    reference = "sha256:" + "3" * 64
    status, _, _ = request(
        "/api/workflow/refinement/approve",
        {"reference": reference, "source": "unrelated editor", "attachments": {}},
    )
    assert status == 400
    status, _, _ = request(
        "/api/workflow/refinement/prepare",
        {"selection": SELECTION, "mode": "gradient"},
        Origin="https://foreign.example",
    )
    assert status == 403
    assert calls == []


def test_formal_page_serves_refinement_assets_in_dependency_order(endpoint):
    request, _ = endpoint
    status, page, _ = request("/")
    assert status == 200
    assert page.index(b"/viewer.js") < page.index(b"/refinement-lab.js")
    assert page.index(b"/refinement-lab.js") < page.index(b"/design-studio.js")
    assert b"/refinement-lab.css" in page
    for path, mime in (
        ("/refinement-lab.js", "text/javascript"),
        ("/refinement-lab.css", "text/css"),
    ):
        status, body, headers = request(path)
        assert status == 200 and body
        assert headers["Content-Type"].startswith(mime)
        assert "script-src 'self'" in headers["Content-Security-Policy"]


def test_saved_design_history_is_read_only_and_retains_corrupt_entry_diagnostics(tmp_path):
    studio = DesignStudio(tmp_path / "workspace")
    body = {"request": {"study": {"name": "Retained original tokens"}}, "state": "completed"}
    reference = content_hash(body)
    record = {**body, "record_hash": reference}
    original = studio.directory / (reference[7:] + ".json")
    raw = json.dumps(record, separators=(", ", ": ")).encode()
    original.write_bytes(raw)
    (studio.directory / ("4" * 64 + ".json")).write_bytes(b'{"broken": true}')
    result = studio.list_records()
    assert result["records"] == [
        {"record_hash": reference, "name": "Retained original tokens", "state": "completed"}
    ]
    assert len(result["errors"]) == 1
    assert result["errors"][0]["filename"] == "4" * 64 + ".json"
    assert original.read_bytes() == raw


def test_saved_design_history_http_uses_original_store(endpoint, tmp_path, monkeypatch):
    monkeypatch.setattr(web, "ROOT", tmp_path)
    request, _ = endpoint
    status, body, _ = request("/api/design/history")
    assert status == 200
    assert json.loads(body) == {"records": [], "errors": []}


@pytest.mark.parametrize(
    "extra", ["spec_ref", "source", "resources", "observations", "disk_budget"]
)
def test_browser_cannot_supply_host_paths_or_policies(extra):
    with pytest.raises(ValueError, match="fields"):
        preparation.prepare_selection(
            None,
            {"selection": SELECTION, "mode": "gradient", extra: {}},
        )


def test_optimizer_without_observation_fails_before_reading_candidate_or_writing_files():
    with pytest.raises(ValueError, match="OPTIMIZER_NOT_PREPARED"):
        preparation.prepare_selection(
            None,
            {"selection": SELECTION, "mode": "optimization"},
            policy=preparation.WorkbenchPreparationPolicy(observation_directory="host/observed"),
        )


def test_host_prepares_original_store_record_with_explicit_separate_budgets(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    designs = workspace / "designs"
    designs.mkdir(parents=True)
    original = designs / ("1" * 64 + ".json")
    raw = b'{"test_only": true, "original_number_token": 1.000}'
    original.write_bytes(raw)
    observed = SimpleNamespace(source_optimizer_settings={"declared": "test only"})
    calls = []

    def load(**kwargs):
        calls.append(("load", kwargs))
        return observed

    monkeypatch.setattr(preparation, "load_trusted_preparation_observations", load)

    def build(**kwargs):
        calls.append(("build", kwargs))
        assert preparation.ContainedReader(tmp_path)(kwargs["record_ref"]) == raw
        assert kwargs["observations"] is observed
        assert kwargs["resources"].wall_seconds == 21600
        assert kwargs["resources"].threads == 8
        assert kwargs["disk_budget"].max_run_bytes == 32 * 1024**3
        assert kwargs["electronic_state"] == {"charge": 0, "multiplicity": 1}
        assert kwargs["preparation_directory"].startswith("workspace/refinement-preparations/")
        return {
            "spec_ref": {"test": "spec"},
            "subject_ref": {"test": "subject"},
            "execution_contract_ref": {"test": "contract"},
            "mode": kwargs["mode"],
            "selection": kwargs["selection"],
            "disk_budget": {"test": "budget"},
            "preparation_ref": {"test": "retained receipt"},
        }

    monkeypatch.setattr(preparation, "prepare_design_refinement", build)
    service = SimpleNamespace(
        store=SimpleNamespace(root=workspace, artifact_root=tmp_path),
        prepare_refinement=lambda request: calls.append(("resolve", request)) or {"ready": True},
    )
    result = preparation.prepare_selection(
        service,
        {"selection": SELECTION, "mode": "gradient"},
        policy=preparation.WorkbenchPreparationPolicy(observation_directory="host/observed"),
    )
    assert result == {"ready": True}
    assert [item[0] for item in calls] == ["load", "build", "resolve"]
    assert calls[0][1]["observation_directory"] == "host/observed"
    assert set(calls[-1][1]) == {
        "spec_ref",
        "subject_ref",
        "execution_contract_ref",
        "mode",
        "selection",
        "disk_budget",
    }
    assert original.read_bytes() == raw
