"""The review UI must preserve the compiler's authority and failure boundaries."""

import json
import threading
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

from chem_workbench import web
from chem_workbench.web import Handler, compile_for_ui


def test_corrupt_project_returns_json_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(web, "ROOT", tmp_path)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    _, projects = web.services(server)
    projects.directory.joinpath("broken.json").write_text("{}")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    connection = HTTPConnection("127.0.0.1", server.server_port, timeout=5)
    try:
        connection.request("GET", "/api/projects")
        response = connection.getresponse()
        assert response.status == 400
        assert "error" in json.loads(response.read())
    finally:
        connection.close()
        server.shutdown()
        server.server_close()
        thread.join()


def test_ui_compilation_binds_review_to_current_document() -> None:
    result = compile_for_ui('chem 0.1\nmolecule water { structure smiles "O" }')
    assert result["success"]
    assert result["review"]["chemir"] == result["document"]
    assert result["review"]["signature_status"] == "unsigned"
    digest = result["review"]["chemir_semantic_hash"]
    assert f"{digest['algorithm']}:{digest['value']}" == result["semantic_hash"]


def test_ui_rejects_invalid_source_without_downloadable_artifacts() -> None:
    result = compile_for_ui("chem 0.1\nmolecule broken {}")
    assert not result["success"]
    assert result["document"] is None
    assert result["review"] is None
    assert result["diagnostics"]


def test_http_boundary_rejects_foreign_origins_and_host_paths() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    connection = HTTPConnection("127.0.0.1", server.server_port, timeout=5)
    try:
        connection.request("GET", "/api/workspace", headers={"Host": "foreign.example"})
        response = connection.getresponse()
        assert response.status == 403
        response.read()
        connection.request("GET", "/../../pyproject.toml")
        response = connection.getresponse()
        assert response.status == 404
        response.read()
        body = json.dumps({"source": 'chem 0.1\nmolecule water { structure smiles "O" }'})
        connection.request(
            "POST",
            "/api/compile",
            body,
            {"Content-Type": "application/json", "Origin": "https://foreign.example"},
        )
        response = connection.getresponse()
        assert response.status == 403
        response.read()
        connection.request("POST", "/api/compile", body, {"Content-Type": "application/json"})
        response = connection.getresponse()
        assert response.status == 200
        assert json.loads(response.read())["success"]
        connection.request("POST", "/api/compile", headers={"Content-Length": "999999"})
        response = connection.getresponse()
        assert response.status == 413
        response.read()
    finally:
        connection.close()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_png_export_is_content_addressed_and_confined(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import base64
    import hashlib

    monkeypatch.setattr(web, "ROOT", tmp_path)
    monkeypatch.setattr(web, "EXPORTS", tmp_path / "build" / "ui-exports")
    pixel = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a"
        "s1sAAAAASUVORK5CYII="
    )
    encoded = "data:image/png;base64," + base64.b64encode(pixel).decode()
    url = web.save_viewport_png(encoded)
    assert url == "/exports/" + hashlib.sha256(pixel).hexdigest() + ".png"
    assert (web.EXPORTS / url.rsplit("/", 1)[1]).read_bytes() == pixel
    assert web.save_viewport_png(encoded) == url


@pytest.mark.parametrize("value", ["data:text/html;base64,Zm9v", "data:image/png;base64,Zm9v"])
def test_png_export_rejects_non_images(value: str) -> None:
    with pytest.raises(ValueError, match="PNG_REQUIRED"):
        web.save_viewport_png(value)
