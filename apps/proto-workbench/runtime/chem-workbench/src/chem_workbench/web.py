"""Loopback-only workbench for design, review and governed execution."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from chem_workbench.adapters.registry import bundled_registry_document
from chem_workbench.design_studio import DesignRunError, DesignStudio
from chem_workbench.orchestrator import model_status, orchestrate
from chem_workbench.paths import resource_root
from chem_workbench.refinement_execution.workbench_preparation import prepare_selection
from chem_workbench.structure_lab import StructureLab
from chem_workbench.tool_gateway import invoke_tool
from chem_workbench.visualization import compile_snapshot, scene_for_compilation
from chem_workbench.workflows import ProjectStore, WorkflowService

ROOT = resource_root()
STATIC = Path(__file__).with_name("web_assets")
MAX_REQUEST = 512 * 1024
EXPORTS = ROOT / "build" / "ui-exports"
SERVICE_LOCK = threading.Lock()


def services(server: Any) -> tuple[WorkflowService, ProjectStore]:
    with SERVICE_LOCK:
        if not hasattr(server, "workflow_service"):
            server.workflow_service = WorkflowService(ROOT / "build" / "workspace")
            server.project_store = ProjectStore(ROOT / "build" / "workspace")
        return server.workflow_service, server.project_store


def save_viewport_png(data: object) -> str:
    """Save only a bounded PNG produced by the user's explicit export action."""
    if not isinstance(data, str) or not data.startswith("data:image/png;base64,"):
        raise ValueError("PNG_REQUIRED: expected a PNG data URL")
    try:
        content = base64.b64decode(data.split(",", 1)[1], validate=True)
    except ValueError as error:
        raise ValueError("PNG_REQUIRED: invalid base64") from error
    if not 33 <= len(content) <= 2_000_000 or content[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("PNG_REQUIRED: invalid PNG or image exceeds 2 MB")
    if content[12:16] != b"IHDR" or any(
        not 1 <= int.from_bytes(content[i : i + 4], "big") <= 4096 for i in (16, 20)
    ):
        raise ValueError("PNG_REQUIRED: image dimensions exceed the export profile")
    EXPORTS.mkdir(parents=True, exist_ok=True)
    if EXPORTS.is_symlink() or EXPORTS.resolve() != ROOT.resolve() / "build" / "ui-exports":
        raise ValueError("EXPORT_PATH_REJECTED")
    name = hashlib.sha256(content).hexdigest() + ".png"
    target = EXPORTS / name
    if target.is_symlink():
        raise ValueError("EXPORT_PATH_REJECTED")
    if not target.exists():
        with target.open("xb") as output:
            output.write(content)
    return "/exports/" + name


def compile_for_ui(source: str, attachments: object = None) -> dict[str, Any]:
    """Compile editor text without granting access to host files or execution."""
    result = compile_snapshot(source, attachments)
    return {
        "success": result.success,
        "diagnostics": [item.to_dict() for item in result.diagnostics],
        "document": result.document,
        "source_sha256": result.source_sha256,
        "semantic_hash": result.semantic_hash,
        "review": result.review_packet() if result.success else None,
        "scene": scene_for_compilation(result),
    }


class Handler(BaseHTTPRequestHandler):
    def reply(self, status: int, body: bytes, mime: str = "application/json") -> None:
        self.send_response(status)
        self.send_header("Content-Type", mime + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        )
        self.end_headers()
        self.wfile.write(body)

    def json_reply(self, status: int, value: object) -> None:
        self.reply(status, json.dumps(value, ensure_ascii=True).encode())

    def allowed(self) -> bool:
        expected = f"127.0.0.1:{self.server.server_port}"  # type: ignore[attr-defined]
        origin = self.headers.get("Origin")
        return self.headers.get("Host") == expected and origin in (None, f"http://{expected}")

    def do_GET(self) -> None:
        if not self.allowed():
            self.json_reply(403, {"error": "Local origin required"})
            return
        if self.path == "/api/workspace":
            examples = [
                {
                    "name": path.stem,
                    "path": path.relative_to(ROOT).as_posix(),
                    "source": path.read_text(encoding="utf-8"),
                    "attachments": {
                        "structures/" + cif.name: cif.read_text(encoding="utf-8")
                        for cif in (ROOT / "examples/crystals/structures").glob("*.cif")
                    }
                    if path.parent.name in {"crystals", "surfaces"}
                    else {},
                }
                for path in sorted((ROOT / "examples").rglob("*.chem"))
            ]
            self.json_reply(200, {"examples": examples, "registry": bundled_registry_document()})
            return
        if self.path in {"/api/workflows", "/api/projects", "/api/profiles"}:
            workflows, projects = services(self.server)
            if self.path == "/api/profiles":
                self.json_reply(
                    200,
                    {
                        "water_geometry": json.loads(
                            (ROOT / "examples/molecules/water-hf-sto3g-geometry.json").read_text(
                                encoding="utf-8"
                            )
                        ),
                        "compute": ["water", "copper", "molecular"],
                    },
                )
            else:
                try:
                    self.json_reply(
                        200, workflows.list() if self.path == "/api/workflows" else projects.list()
                    )
                except (ValueError, KeyError, OSError) as error:
                    self.json_reply(400, {"error": str(error)})
            return
        if self.path == "/api/model/status":
            self.json_reply(200, model_status())
            return
        if self.path == "/api/design/catalog":
            self.json_reply(200, DesignStudio(ROOT / "build/workspace").catalog())
            return
        if self.path == "/api/design/history":
            self.json_reply(200, DesignStudio(ROOT / "build/workspace").list_records())
            return
        if re.fullmatch(r"/exports/[0-9a-f]{64}\.png", self.path):
            exported = EXPORTS / self.path.rsplit("/", 1)[1]
            if exported.is_file() and not exported.is_symlink():
                self.reply(200, exported.read_bytes(), "image/png")
            else:
                self.json_reply(404, {"error": "Export not found"})
            return
        files = {
            "/": ("index.html", "text/html"),
            "/app.js": ("app.js", "text/javascript"),
            "/workflow.js": ("workflow.js", "text/javascript"),
            "/structure-lab.js": ("structure-lab.js", "text/javascript"),
            "/design-studio.js": ("design-studio.js", "text/javascript"),
            "/design-studio.css": ("design-studio.css", "text/css"),
            "/refinement-lab.js": ("refinement-lab.js", "text/javascript"),
            "/refinement-lab.css": ("refinement-lab.css", "text/css"),
            "/style.css": ("style.css", "text/css"),
            "/viewer.js": ("viewer.js", "text/javascript"),
            "/geometry-view-model.js": ("geometry-view-model.js", "text/javascript"),
            "/interface-workbench.js": ("interface-workbench.js", "text/javascript"),
            "/vendor/3Dmol-2.5.5.min.js": ("vendor/3Dmol-2.5.5.min.js", "text/javascript"),
        }
        if self.path not in files:
            self.json_reply(404, {"error": "Not found"})
            return
        name, mime = files[self.path]
        self.reply(200, (STATIC / name).read_bytes(), mime)

    def do_POST(self) -> None:
        if not self.allowed():
            self.json_reply(403, {"error": "Local origin required"})
            return
        if self.path not in {
            "/api/compile",
            "/api/orchestrate",
            "/api/tool",
            "/api/export/png",
            "/api/workflow/prepare",
            "/api/workflow/approve",
            "/api/workflow/submit",
            "/api/workflow/cancel",
            "/api/workflow/read",
            "/api/workflow/refinement/prepare",
            "/api/workflow/refinement/approve",
            "/api/project/save",
            "/api/structure/import",
            "/api/structure/edit",
            "/api/structure/build",
            "/api/structure/compare",
            "/api/design/run",
            "/api/design/read",
            "/api/design/import",
            "/api/design/export",
            "/api/design/export-interface",
        }:
            self.json_reply(404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            maximum = 3_000_000 if self.path == "/api/export/png" else MAX_REQUEST
            if self.path == "/api/design/import":
                maximum = 20 * 1024 * 1024
            if not 0 < length <= maximum:
                self.json_reply(413, {"error": f"Request limit is {maximum} bytes"})
                return
            if self.headers.get("Content-Type") != "application/json":
                self.json_reply(415, {"error": "JSON required"})
                return
            data = json.loads(self.rfile.read(length))
            if self.path in {
                "/api/design/run",
                "/api/design/read",
                "/api/design/import",
                "/api/design/export",
                "/api/design/export-interface",
            }:
                studio = DesignStudio(ROOT / "build/workspace")
                if self.path == "/api/design/run":
                    value = studio.run(data)
                elif self.path == "/api/design/export-interface":
                    value = studio.export_interface(data)
                elif self.path == "/api/design/import":
                    if not isinstance(data, dict):
                        raise ValueError("DESIGN_IMPORT_RECORD_REQUIRED")
                    if set(data) == {"document"} and isinstance(data["document"], str):
                        # Browser number serialization changes 1.0 to 1. Preserve the
                        # exported JSON text until Python parses the hashed record.
                        value = studio.import_record(json.loads(data["document"]))
                    elif set(data) == {"record"}:
                        value = studio.import_record(data["record"])
                    else:
                        raise ValueError("DESIGN_IMPORT_DOCUMENT_OR_RECORD_REQUIRED")
                else:
                    if not isinstance(data, dict) or set(data) != {"reference"}:
                        raise ValueError("DESIGN_READ_REFERENCE_REQUIRED")
                    value = (
                        studio.export_record(data["reference"])
                        if self.path == "/api/design/export"
                        else studio.read(data["reference"])
                    )
                self.json_reply(200, value)
                return
            if self.path.startswith("/api/structure/"):
                if not isinstance(data, dict):
                    raise ValueError("Expected an object")
                lab = StructureLab(ROOT / "build/workspace")
                action = self.path.rsplit("/", 1)[1]
                fields = {
                    "import": {"content", "format"},
                    "edit": {"reference", "positions"},
                    "build": {"source", "attachments", "object_id", "site"},
                    "compare": {"left", "right"},
                }[action]
                if set(data) != fields:
                    raise ValueError("INVALID_ARGUMENT: unexpected structure fields")
                if action == "import":
                    value = lab.import_molecule(data["content"], data["format"])
                elif action == "edit":
                    value = lab.edit(data["reference"], data["positions"])
                elif action == "build":
                    value = lab.construct_copper(
                        data["source"], data["attachments"], data["object_id"], data["site"]
                    )
                else:
                    value = lab.compare(data["left"], data["right"])
                self.json_reply(200, value)
                return
            if self.path.startswith("/api/workflow/") or self.path == "/api/project/save":
                if not isinstance(data, dict):
                    raise ValueError("Expected an object")
                workflows, projects = services(self.server)
                action = self.path.rsplit("/", 1)[1]
                if self.path == "/api/project/save":
                    value = projects.save(data)
                elif self.path == "/api/workflow/refinement/prepare":
                    value = prepare_selection(workflows, data)
                elif self.path == "/api/workflow/refinement/approve":
                    if set(data) != {"reference"} or not isinstance(data["reference"], str):
                        raise ValueError("INVALID_ARGUMENT: unexpected refinement approval fields")
                    value = workflows.approve_refinement(data["reference"])
                elif action == "prepare":
                    value = workflows.prepare(data)
                else:
                    expected = (
                        {"reference", "source", "attachments"}
                        if action == "approve"
                        else {"reference"}
                    )
                    if set(data) != expected or not isinstance(data.get("reference"), str):
                        raise ValueError("INVALID_ARGUMENT: unexpected workflow fields")
                    if action == "approve":
                        value = workflows.approve(
                            data["reference"], data["source"], data["attachments"]
                        )
                    else:
                        value = getattr(workflows, action)(data["reference"])
                self.json_reply(200, value)
                return
            if self.path == "/api/export/png":
                if not isinstance(data, dict) or set(data) != {"png"}:
                    raise ValueError("Expected PNG export data")
                self.json_reply(200, {"url": save_viewport_png(data["png"])})
                return
            if not isinstance(data, dict) or not isinstance(data.get("source"), str):
                raise ValueError("Expected source text")
            if self.path == "/api/compile":
                self.json_reply(200, compile_for_ui(data["source"], data.get("attachments")))
            else:
                snapshot = compile_snapshot(data["source"], data.get("attachments"))
                if self.path == "/api/orchestrate":
                    if not isinstance(data.get("objective"), str):
                        raise ValueError("Expected an objective")
                    record = orchestrate(data["objective"], snapshot)
                    workflows, _projects = services(self.server)
                    directory = workflows.store.root / "orchestrations"
                    directory.mkdir(exist_ok=True)
                    workflows.store._write(
                        directory / (record["record_hash"][7:] + ".json"), record
                    )
                    self.json_reply(200, record)
                else:
                    if not isinstance(data.get("tool"), str):
                        raise ValueError("Expected a tool name")
                    self.json_reply(200, invoke_tool(data["tool"], data.get("arguments"), snapshot))
        except DesignRunError as error:
            self.json_reply(400, {"error": str(error), "design_record": error.record})
        except (ValueError, UnicodeError, OSError, TypeError, KeyError) as error:
            self.json_reply(400, {"error": str(error)})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Chem Workbench: http://127.0.0.1:{server.server_port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
