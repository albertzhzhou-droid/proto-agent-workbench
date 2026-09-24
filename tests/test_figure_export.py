"""Scientific export contracts: exact data, readable vectors, failure boundaries."""
from __future__ import annotations

import copy
import csv
import hashlib
import importlib.util
import io
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4
from xml.etree import ElementTree

from proto_agent.figure_export import (
    MAX_POINTS, FigureExportError, render_research_figure,
    render_research_figure_file, validate_figure_request, _wrap,
)
from proto_agent.security import SecurityBoundaryError


ROOT = Path(__file__).resolve().parents[1]


def request_fixture():
    return {
        "schema": "proto.research-figure-render.v1",
        "figure": {"id": "70a4f4e2-3556-4b5b-a84d-acdefdef0921", "revision": 1,
                   "title": "Exact research observations", "caption": "Synthetic fixture. No fitted model or inferred significance.", "columns": 1},
        "panels": [{"id": "60a4f4e2-3556-4b5b-a84d-acdefdef0921", "title": "Supplied series",
                    "kind": "line", "xLabel": "Elapsed time", "yLabel": "Signal", "xUnit": "s", "yUnit": "mV",
                    "points": [{"x": 2, "y": -1.25}, {"x": 1, "y": 4.125}, {"x": 3, "y": 0}],
                    "source": {"runId": "ab" * 16,
                               "binding": {"manifestSha256": "1" * 64, "provenanceSha256": "2" * 64,
                                           "inputSha256": "3" * 64, "resultSha256": "4" * 64,
                                           "tool": "synthetic-series-fixture", "createdAt": "2026-09-22T00:00:00Z"},
                               "selection": {"y": {"from": "input", "pointer": "/measurements", "field": "/signal"},
                                             "x": {"from": "input", "pointer": "/measurements", "field": "/time"}},
                               "sourceFreshness": "changed"}}],
        "methodsMarkdown": "# Methods\n\nSynthetic fixture, retained as supplied.\n",
        "methods": {"schema": "fixture.methods.v1", "parameters": {"measurements": [2, 1, 3], "missing": None, "flag": False}}
    }


class FigureValidationTests(unittest.TestCase):
    def assert_invalid(self, value, code="FIGURE_INVALID_REQUEST"):
        with self.assertRaises(FigureExportError) as caught:
            validate_figure_request(value)
        self.assertEqual(caught.exception.code, code)

    def test_request_is_detached_and_preserves_order_units_selectors_and_missing_values(self):
        request = request_fixture()
        validated = validate_figure_request(request)
        self.assertEqual(validated, request)
        self.assertIsNot(validated, request)
        validated["panels"][0]["points"][0]["y"] = 3
        self.assertEqual(request["panels"][0]["points"][0]["y"], -1.25)

    def test_arbitrary_code_styles_paths_and_additional_fields_rejected(self):
        for key in ["code", "style", "fontPath", "outputPath", "out", "script"]:
            request = request_fixture()
            request[key] = "untrusted"
            self.assert_invalid(request)
        for target in ["figure", "panel", "source", "binding", "selection"]:
            request = request_fixture()
            target_object = request["figure"] if target == "figure" else request["panels"][0]
            if target in {"source", "binding", "selection"}:
                target_object = target_object["source"]
            if target in {"binding", "selection"}:
                target_object = target_object[target]
            target_object["execute"] = "blocked"
            self.assert_invalid(request)

    def test_nonfinite_boolean_unsafe_integer_and_extreme_points_rejected(self):
        for value in [True, float("nan"), float("inf"), -float("inf"), 2**53, 1e101, None, "3"]:
            request = request_fixture()
            request["panels"][0]["points"][0]["y"] = value
            self.assert_invalid(request)

    def test_categorical_order_cannot_silently_merge_or_connect_categories(self):
        request = request_fixture()
        request["panels"][0]["points"] = [{"x": "First", "y": 4}, {"x": "Second", "y": 2}]
        self.assert_invalid(request)
        request["panels"][0]["kind"] = "bar"
        self.assertEqual(validate_figure_request(request), request)
        request["panels"][0]["points"][1]["x"] = "First"
        self.assertEqual(validate_figure_request(request), request)
        request["panels"][0]["points"][1]["x"] = 4
        self.assert_invalid(request)

    def test_limits_duplicate_panel_and_selector_escaping_rejected(self):
        request = request_fixture()
        request["panels"] *= 2
        self.assert_invalid(request)
        request = request_fixture()
        request["panels"][0]["points"] *= MAX_POINTS
        self.assert_invalid(request)
        for pointer in ["relative/path", "/bad~escape", "/trailing~"]:
            request = request_fixture()
            request["panels"][0]["source"]["selection"]["y"]["pointer"] = pointer
            self.assert_invalid(request)
        request = request_fixture()
        request["panels"][0]["source"]["binding"]["resultSha256"] = "x" * 64
        self.assert_invalid(request)

    def test_unbounded_methods_and_format_controls_are_rejected(self):
        request = request_fixture()
        request["figure"]["title"] = "Title\u202eabc"
        self.assert_invalid(request)
        request = request_fixture()
        nested = request["methods"]
        for _ in range(70):
            nested["child"] = {}
            nested = nested["child"]
        self.assert_invalid(request)

    def test_labels_wrap_at_word_boundaries_with_cjk_and_literal_punctuation(self):
        sentence = 'Supplied values without interpolation, $x^2$ or invented units.'
        wrapped = _wrap(sentence, 18)
        self.assertIn('without', wrapped.split())
        self.assertIn('interpolation,', wrapped.split())
        self.assertIn('$x^2$', wrapped.split())
        self.assertEqual(' '.join(wrapped.split()), sentence)
        mixed = '研究观测结果，保留（原始数值）。 Scientific values without changes.'
        result = _wrap(mixed, 18)
        self.assertEqual(''.join(result.split()), ''.join(mixed.split()))
        self.assertTrue(all(not line.startswith(('，', '。', '）')) for line in result.splitlines()))
        self.assertEqual(_wrap('abcdefghijklmnopqrstuvwxyz', 18), 'abcdefghijklmnopqr\nstuvwxyz')
        self.assertEqual(_wrap('abcdefghijklmnopqr.', 18), 'abcdefghijklmnopq\nr.')


@unittest.skipUnless(importlib.util.find_spec("matplotlib"), "optional matplotlib runtime unavailable")
class FigureRenderingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.workspace = Path(self.temporary.name)

    def test_real_vectors_exact_table_source_bindings_methods_and_hashes_reopen(self):
        request = request_fixture()
        receipt = render_research_figure(request, workspace_root=self.workspace)
        self.assertEqual(len(receipt["files"]), 6)
        manifest_raw = (self.workspace / receipt["manifestPath"]).read_bytes()
        self.assertEqual(hashlib.sha256(manifest_raw).hexdigest(), receipt["manifestSha256"])
        manifest = json.loads(manifest_raw)
        self.assertTrue(manifest["ok"])
        self.assertEqual(manifest["pointCount"], 3)
        self.assertNotIn("manifestSha256", manifest)
        artifacts = {}
        for artifact in receipt["files"]:
            raw = (self.workspace / artifact["path"]).read_bytes()
            self.assertEqual(len(raw), artifact["bytes"])
            self.assertEqual(hashlib.sha256(raw).hexdigest(), artifact["sha256"])
            artifacts[Path(artifact["path"]).name] = raw
        svg = ElementTree.fromstring(artifacts["figure.svg"])
        self.assertTrue(svg.findall(".//{http://www.w3.org/2000/svg}path"))
        self.assertFalse(svg.findall(".//{http://www.w3.org/2000/svg}image"))
        self.assertFalse(svg.findall(".//{http://www.w3.org/2000/svg}script"))
        self.assertEqual(json.loads(artifacts["figure-data.json"])["request"], request)
        self.assertEqual(json.loads(artifacts["methods.json"]), request["methods"])
        self.assertEqual(artifacts["methods.md"].decode(), request["methodsMarkdown"])
        table = list(csv.DictReader(io.StringIO(artifacts["plotted-values.csv"].decode())))
        self.assertEqual([{axis: json.loads(row[f"{axis}_json"]) for axis in ("x", "y")} for row in table], request["panels"][0]["points"])
        self.assertTrue(all(json.loads(row["y_unit_json"]) == "mV" for row in table))
        self.assertEqual(manifest["authority"], "unsigned-local-rendering-of-host-supplied-data")
        self.assertIn("host-supplied", manifest["scope"])
        self.assertIn("changed", artifacts["figure-data.json"].decode())

    def test_repeated_rendering_is_byte_deterministic_with_unique_manifests(self):
        first = render_research_figure(request_fixture(), workspace_root=self.workspace)
        second = render_research_figure(request_fixture(), workspace_root=self.workspace)
        self.assertNotEqual(first["exportId"], second["exportId"])
        self.assertNotEqual(first["manifestSha256"], second["manifestSha256"])
        self.assertEqual({entry["format"]: entry["sha256"] for entry in first["files"]},
                         {entry["format"]: entry["sha256"] for entry in second["files"]})

    def test_pdf_reopens_in_independent_pdfjs_with_selectable_units_and_title(self):
        pdfjs = ROOT / "apps/proto-workbench/node_modules/pdfjs-dist/legacy/build/pdf.mjs"
        node = shutil.which("node")
        if not node or not pdfjs.is_file():
            self.skipTest("independent local pdfjs parser unavailable")
        receipt = render_research_figure(request_fixture(), workspace_root=self.workspace)
        pdf = self.workspace / next(item["path"] for item in receipt["files"] if item["format"] == "pdf")
        script = """import fs from 'node:fs';
const pdfjs = await import(process.argv[1]);
const task = pdfjs.getDocument({data:new Uint8Array(fs.readFileSync(process.argv[2])),disableFontFace:true,useSystemFonts:false}); const doc = await task.promise;
const page = await doc.getPage(1); const text = await page.getTextContent();
console.log(JSON.stringify({pages:doc.numPages,text:text.items.map(x=>x.str).join(' ')}));
await task.destroy();"""
        completed = subprocess.run([node, "--input-type=module", "-e", script, pdfjs.as_uri(), str(pdf)], capture_output=True, text=True, timeout=30)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        parsed = json.loads(completed.stdout.strip().splitlines()[-1])
        self.assertEqual(parsed["pages"], 1)
        self.assertIn("Exact research observations", parsed["text"])
        self.assertIn("mV", parsed["text"])
        self.assertIn("Syntheticfixture", re.sub(r"\s+", "", parsed["text"]))
        self.assertIn("Source status: A changed", parsed["text"])

    def test_chinese_labels_are_covered_or_rejected_before_publication(self):
        request = request_fixture()
        request["figure"]["title"] = "研究图板：精确观测"
        request["panels"][0]["yLabel"] = "荧光强度"
        try:
            receipt = render_research_figure(request, workspace_root=self.workspace)
        except FigureExportError as exc:
            self.assertEqual(exc.code, "FIGURE_FONT_UNSUPPORTED")
            self.assertFalse((self.workspace / "build/research-figures/exports").exists())
        else:
            manifest = json.loads((self.workspace / receipt["manifestPath"]).read_bytes())
            self.assertIn(manifest["rendering"]["font"]["family"], ["Noto Sans SC", "Microsoft YaHei", "SimHei", "SimSun"])
            self.assertEqual(manifest["rendering"]["font"]["coverage"], "all-rendered-label-codepoints")

    def test_unavailable_glyph_explicit_error_without_export(self):
        request = request_fixture()
        request["figure"]["title"] += " \U00013000"
        with self.assertRaises(FigureExportError) as caught:
            render_research_figure(request, workspace_root=self.workspace)
        self.assertEqual(caught.exception.code, "FIGURE_FONT_UNSUPPORTED")
        self.assertFalse((self.workspace / "build/research-figures/exports").exists())

    def test_math_or_xml_like_labels_remain_literal_and_csv_string_values_recover_exactly(self):
        request = request_fixture()
        request["figure"]["title"] = '$x^2$ <script>alert("x")</script>'
        panel = request["panels"][0]
        panel["kind"] = "bar"
        panel["points"] = [{"x": '=HYPERLINK("bad")', "y": 1}, {"x": "@SUM(1)", "y": 2}]
        receipt = render_research_figure(request, workspace_root=self.workspace)
        svg = (self.workspace / next(item["path"] for item in receipt["files"] if item["format"] == "svg")).read_bytes()
        self.assertFalse(ElementTree.fromstring(svg).findall(".//{http://www.w3.org/2000/svg}script"))
        raw = (self.workspace / next(item["path"] for item in receipt["files"] if item["format"] == "csv")).read_text()
        rows = list(csv.DictReader(io.StringIO(raw)))
        self.assertEqual(json.loads(rows[0]["x_json"]), panel["points"][0]["x"])
        self.assertTrue(rows[0]["x_json"].startswith('"'))

    def test_duplicate_numeric_bar_x_values_have_separate_vector_geometry(self):
        request = request_fixture()
        panel = request["panels"][0]
        panel["kind"] = "bar"
        panel["points"] = [{"x": 5, "y": 1}, {"x": 5, "y": 2}, {"x": 10, "y": 3}]
        receipt = render_research_figure(request, workspace_root=self.workspace)
        svg = ElementTree.fromstring((self.workspace / next(item["path"] for item in receipt["files"] if item["format"] == "svg")).read_bytes())
        bars = [element for element in svg.findall(".//{http://www.w3.org/2000/svg}path") if "fill: #23645f" in element.attrib.get("style", "")]
        self.assertEqual(len(bars), 3)
        horizontal_positions = [float(re.search(r"M\s+([-\d.]+)", element.attrib["d"]).group(1)) for element in bars]
        self.assertEqual(len(set(horizontal_positions)), 3)
        self.assertEqual(horizontal_positions, sorted(horizontal_positions))
        data = json.loads((self.workspace / next(item["path"] for item in receipt["files"] if item["format"] == "data")).read_bytes())
        self.assertEqual(data["request"]["panels"][0]["points"], panel["points"])
        self.assertIn("repeated numeric", data["rendering"]["barCoordinates"])

    def test_missing_renderer_reports_unavailable_and_writes_no_export(self):
        with patch("proto_agent.figure_export._load_renderer", side_effect=FigureExportError("FIGURE_RENDERER_UNAVAILABLE", "optional runtime missing")):
            with self.assertRaises(FigureExportError) as caught:
                render_research_figure(request_fixture(), workspace_root=self.workspace)
        self.assertEqual(caught.exception.code, "FIGURE_RENDERER_UNAVAILABLE")
        self.assertFalse((self.workspace / "build/research-figures/exports").exists())

    def test_failure_during_artifact_write_never_publishes_success_manifest(self):
        from proto_agent import figure_export
        original = figure_export._write_new_file
        def fail_pdf(paths, relative, raw):
            if relative.endswith("figure.pdf"):
                raise OSError("synthetic storage failure")
            return original(paths, relative, raw)
        with patch.object(figure_export, "_write_new_file", side_effect=fail_pdf):
            with self.assertRaises(OSError):
                render_research_figure(request_fixture(), workspace_root=self.workspace)
        self.assertEqual(len(list(self.workspace.glob("build/research-figures/exports/*/figure.svg"))), 1)
        self.assertFalse(list(self.workspace.glob("build/research-figures/exports/*/manifest.json")))

    def test_file_entrypoint_rejects_duplicate_keys_and_outside_paths(self):
        (self.workspace / "request.json").write_text('{"schema":"a","schema":"b"}')
        with self.assertRaises(FigureExportError) as caught:
            render_research_figure_file("request.json", workspace_root=self.workspace)
        self.assertEqual(caught.exception.code, "FIGURE_INVALID_JSON")
        with self.assertRaises(SecurityBoundaryError):
            render_research_figure_file("../request.json", workspace_root=self.workspace)

    def test_real_cli_and_mcp_bind_the_original_request_bytes(self):
        from proto_agent.mcp_server import McpServer
        raw = json.dumps(request_fixture(), ensure_ascii=False, separators=(",", ": ")).encode() + b"\n\n"
        (self.workspace / "request.json").write_bytes(raw)
        env = {**os.environ, "PYTHONPATH": str(ROOT / "src")}
        cli = subprocess.run([sys.executable, "-m", "proto_agent.cli", "figure", "render", "request.json"],
                             cwd=self.workspace, env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(cli.returncode, 0, cli.stderr)
        cli_receipt = json.loads(cli.stdout)
        server = McpServer(workspace_root=self.workspace)
        response = server.handle_message({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                          "params": {"name": "proto_research_figure_render", "arguments": {"path": "request.json"}}})
        self.assertFalse(response["result"]["isError"])
        mcp_receipt = response["result"]["structuredContent"]
        for receipt in [cli_receipt, mcp_receipt]:
            self.assertEqual(set(receipt), {"exportId", "figureId", "figureRevision", "createdAt", "files", "manifestPath", "manifestSha256"})
            manifest = json.loads((self.workspace / receipt["manifestPath"]).read_bytes())
            self.assertEqual(manifest["requestSha256"], hashlib.sha256(raw).hexdigest())
            self.assertEqual(manifest["files"], receipt["files"])
        self.assertEqual({item["format"]: item["sha256"] for item in cli_receipt["files"]},
                         {item["format"]: item["sha256"] for item in mcp_receipt["files"]})

    def test_existing_output_symlink_is_rejected_without_writing_target(self):
        with tempfile.TemporaryDirectory() as outside:
            build = self.workspace / "build"
            build.mkdir()
            try:
                (build / "research-figures").symlink_to(outside, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest("symlink creation unavailable")
            with self.assertRaises(SecurityBoundaryError):
                render_research_figure(request_fixture(), workspace_root=self.workspace)
            self.assertEqual(list(Path(outside).iterdir()), [])

    def test_cold_persistent_stdio_mcp_renders_before_stdin_is_closed_or_woken(self):
        raw = json.dumps(request_fixture()).encode()
        (self.workspace / "request.json").write_bytes(raw)
        stderr = (self.workspace / "mcp-stderr.log").open("wb")
        child = subprocess.Popen([sys.executable, "-u", "-m", "proto_agent.mcp_server"], cwd=self.workspace,
                                 env={**os.environ, "PYTHONPATH": str(ROOT / "src")}, stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=stderr, text=True, encoding="utf-8")
        messages = queue.Queue()
        def read_stdout():
            for line in child.stdout:
                messages.put(json.loads(line))
        reader = threading.Thread(target=read_stdout, daemon=True)
        reader.start()
        def call(request_id, method, params):
            child.stdin.write(json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}) + "\n")
            child.stdin.flush()
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                try:
                    message = messages.get(timeout=max(.01, deadline - time.monotonic()))
                except queue.Empty:
                    self.fail("Persistent MCP did not respond while stdin remained open and idle.")
                if message.get("id") == request_id:
                    return message
            self.fail("Persistent MCP response exceeded the bounded deadline.")
        try:
            call(1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "figure-test", "version": "1"}})
            receipts = []
            for request_id in [2, 3]:
                response = call(request_id, "tools/call", {"name": "proto_research_figure_render", "arguments": {"path": "request.json"}})
                self.assertFalse(response["result"]["isError"], response)
                receipts.append(response["result"]["structuredContent"])
            self.assertIsNone(child.poll())
            self.assertNotEqual(receipts[0]["exportId"], receipts[1]["exportId"])
            for receipt in receipts:
                manifest = json.loads((self.workspace / receipt["manifestPath"]).read_bytes())
                self.assertEqual(manifest["requestSha256"], hashlib.sha256(raw).hexdigest())
        finally:
            child.stdin.close()
            try:
                child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
            reader.join(timeout=1)
            child.stdout.close()
            stderr.close()


class FigureEntryPointTests(unittest.TestCase):
    def test_cli_dispatches_fixed_render_command(self):
        from proto_agent.cli import main
        with patch("proto_agent.cli.render_research_figure_file", return_value={"ok": True}) as render, patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(main(["figure", "render", "build/figure-request.json"]), 0)
        render.assert_called_once_with("build/figure-request.json")

    def test_mcp_schema_is_path_only_and_handler_uses_workspace(self):
        from proto_agent.mcp_server import TOOLS, McpServer
        tool = next(item for item in TOOLS if item["name"] == "proto_research_figure_render")
        self.assertEqual(set(tool["inputSchema"]["properties"]), {"path"})
        self.assertFalse(tool["inputSchema"]["additionalProperties"])
        with tempfile.TemporaryDirectory() as workspace:
            server = McpServer(workspace_root=workspace)
            with patch("proto_agent.mcp_server.render_research_figure_file", return_value={"ok": True}) as render:
                self.assertEqual(server._tool_research_figure_render({"path": "build/request.json"}), {"ok": True})
            render.assert_called_once_with("build/request.json", workspace_root=Path(workspace).resolve())

    def test_missing_optional_runtime_is_structured_before_worker_dispatch(self):
        from proto_agent.mcp_server import McpServer
        request = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "proto_research_figure_render", "arguments": {"path": "request.json"}}}
        incoming = io.TextIOWrapper(io.BytesIO((json.dumps(request) + "\n").encode()))
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as workspace:
            server = McpServer(workspace_root=workspace)
            with patch("sys.stdin", incoming), patch("sys.stdout", output), patch("proto_agent.mcp_server.prepare_figure_runtime", side_effect=FigureExportError("FIGURE_RENDERER_UNAVAILABLE", "optional runtime unavailable")), patch.object(server, "_start_tool_request") as dispatch:
                self.assertEqual(server.serve(), 0)
                dispatch.assert_not_called()
        messages = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertTrue(messages[0]["result"]["isError"])
        self.assertEqual(messages[0]["result"]["structuredContent"]["diagnostics"][0]["code"], "FIGURE_RENDERER_UNAVAILABLE")
        self.assertEqual(messages[1]["method"], "notifications/proto-request-finished")


if __name__ == "__main__":
    unittest.main()
