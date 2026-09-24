"""Fixed, data-only research figure rendering with retained, unsigned evidence.

The host resolves JSON selectors against saved computation artifacts before
calling this module. This renderer does not claim to authenticate those sources
or derive scientific conclusions. It plots exactly the supplied points in order.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import os
import platform
import re
import threading
import unicodedata
import warnings
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4
from xml.etree import ElementTree

from .json_validation import JsonValidationError, decode_json_bounded
from .security import SecurityBoundaryError, WorkspacePaths, read_bytes_bounded


REQUEST_SCHEMA = "proto.research-figure-render.v1"
EXPORT_SCHEMA = "proto.research-figure-export.v1"
MAX_REQUEST_BYTES = 16 * 1024 * 1024
MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
MAX_TOTAL_BYTES = 48 * 1024 * 1024
MAX_PANELS = 6
MAX_POINTS = 5000
MAX_TOTAL_POINTS = 20000
_RENDER_LOCK = threading.RLock()  # Matplotlib rc settings and fonts are global.
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_RUN_ID = re.compile(r"[0-9a-f]{32}\Z")
_FONT_FAMILIES = ("DejaVu Sans", "Noto Sans SC", "Microsoft YaHei", "SimHei", "SimSun")


class FigureExportError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


def _fail(message: str, code: str = "FIGURE_INVALID_REQUEST") -> None:
    raise FigureExportError(code, message)


def _object(value: Any, required: set[str], optional: set[str] | None = None, *, name: str) -> dict:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        _fail(f"{name} must be an object.")
    if set(value) - required - (optional or set()) or not required <= set(value):
        _fail(f"{name} has missing or unsupported fields.")
    return value


def _text(value: Any, maximum: int, *, name: str, nonempty: bool = False, multiline: bool = False) -> str:
    if not isinstance(value, str) or len(value) > maximum or (nonempty and not value.strip()):
        _fail(f"{name} must be {'nonempty ' if nonempty else ''}text of at most {maximum} characters.")
    if any((unicodedata.category(char).startswith("C") and not (multiline and char in "\n\t\r"))
           for char in value):
        _fail(f"{name} contains unsupported control or formatting characters.")
    return value


def _uuid(value: Any, name: str) -> None:
    try:
        if not isinstance(value, str) or str(UUID(value)) != value:
            _fail(f"{name} must be a canonical UUID.")
    except (ValueError, TypeError, AttributeError):
        _fail(f"{name} must be a canonical UUID.")


def _number(value: Any, name: str) -> None:
    if isinstance(value, int) and abs(value) > 2**53 - 1:
        _fail(f"{name} exceeds the exact integer range shared by the host and renderer.")
    if type(value) not in {int, float} or not math.isfinite(value) or abs(value) > 1e100:
        _fail(f"{name} must be a finite number with magnitude at most 1e100.")


def _pointer_selector(value: Any, name: str) -> None:
    _object(value, {"from", "pointer"}, {"field"}, name=name)
    if not isinstance(value["from"], str) or value["from"] not in {"input", "result"}:
        _fail(f"{name}.from must be input or result.")
    pointer = _text(value["pointer"], 512, name=f"{name}.pointer")
    if (pointer and not pointer.startswith("/")) or re.search(r"~(?![01])", pointer):
        _fail(f"{name}.pointer must be a JSON pointer.")
    if "field" in value:
        field = _text(value["field"], 512, name=f"{name}.field")
        if (field and not field.startswith("/")) or re.search(r"~(?![01])", field):
            _fail(f"{name}.field must be a JSON pointer.")


def _bounded_methods(value: Any) -> None:
    if not isinstance(value, dict):
        _fail("methods must be a structured object.")
    remaining = [600000]

    def walk(item: Any, depth: int) -> None:
        remaining[0] -= 1
        if depth > 64 or remaining[0] < 0:
            _fail("methods exceeds the bounded structured-data budget.")
        if isinstance(item, dict):
            if len(item) > 1024:
                _fail("methods has too many object fields.")
            for key, nested in item.items():
                _text(key, 256, name="methods key")
                walk(nested, depth + 1)
        elif isinstance(item, list):
            if len(item) > 200000:
                _fail("methods has too many array entries.")
            for nested in item:
                walk(nested, depth + 1)
        elif isinstance(item, str):
            _text(item, 4 * 1024 * 1024, name="methods text", multiline=True)
        elif item is None or isinstance(item, bool):
            pass
        elif type(item) in {int, float}:
            if (type(item) is int and abs(item) > 2**53 - 1) or not math.isfinite(item):
                _fail("methods number must be finite and use the exact shared integer range.")
        else:
            _fail("methods must contain JSON data only.")

    walk(value, 0)


def validate_figure_request(request: Any) -> dict[str, Any]:
    """Validate and detach a bounded fixed-schema payload, without any rendering."""
    _object(request, {"schema", "figure", "panels", "methodsMarkdown", "methods"}, name="request")
    if request["schema"] != REQUEST_SCHEMA:
        _fail(f"schema must be {REQUEST_SCHEMA}.")
    figure = _object(request["figure"], {"id", "revision", "title", "caption", "columns"}, name="figure")
    _uuid(figure["id"], "figure.id")
    if type(figure["revision"]) is not int or not 1 <= figure["revision"] <= 2**31 - 1:
        _fail("figure.revision must be a positive bounded integer.")
    if type(figure["columns"]) is not int or figure["columns"] not in {1, 2}:
        _fail("figure.columns must be 1 or 2.")
    _text(figure["title"], 160, name="figure.title", nonempty=True)
    _text(figure["caption"], 4000, name="figure.caption", multiline=True)
    panels = request["panels"]
    if not isinstance(panels, list) or not 1 <= len(panels) <= MAX_PANELS:
        _fail(f"panels must contain 1 to {MAX_PANELS} entries.")
    ids, total = set(), 0
    for index, panel in enumerate(panels):
        name = f"panels[{index}]"
        _object(panel, {"id", "title", "kind", "xLabel", "yLabel", "xUnit", "yUnit", "points", "source"}, name=name)
        _uuid(panel["id"], f"{name}.id")
        if panel["id"] in ids:
            _fail("Panel IDs must be unique.")
        ids.add(panel["id"])
        _text(panel["title"], 160, name=f"{name}.title", nonempty=True)
        if not isinstance(panel["kind"], str) or panel["kind"] not in {"line", "scatter", "bar"}:
            _fail(f"{name}.kind must be line, scatter, or bar.")
        for label in ("xLabel", "yLabel"):
            _text(panel[label], 120, name=f"{name}.{label}")
        for unit in ("xUnit", "yUnit"):
            _text(panel[unit], 64, name=f"{name}.{unit}")
        points = panel["points"]
        if not isinstance(points, list) or not 1 <= len(points) <= MAX_POINTS:
            _fail(f"{name}.points must contain 1 to {MAX_POINTS} entries.")
        total += len(points)
        categories, numeric = [], []
        for point in points:
            _object(point, {"x", "y"}, name=f"{name}.point")
            _number(point["y"], f"{name}.y")
            if isinstance(point["x"], str):
                categories.append(_text(point["x"], 120, name=f"{name}.x", nonempty=True))
            else:
                _number(point["x"], f"{name}.x")
                numeric.append(point["x"])
        if categories and numeric:
            _fail(f"{name}.x cannot mix categorical and numeric coordinates.")
        if categories and panel["kind"] != "bar":
            _fail(f"{name}: line and scatter plots require numeric x coordinates.")
        source = _object(panel["source"], {"runId", "binding", "selection", "sourceFreshness"}, name=f"{name}.source")
        if not isinstance(source["runId"], str) or not _RUN_ID.fullmatch(source["runId"]):
            _fail(f"{name}.source.runId must be a lowercase hexadecimal run identity.")
        binding = _object(source["binding"], {"manifestSha256", "provenanceSha256", "inputSha256", "resultSha256", "tool", "createdAt"}, name=f"{name}.binding")
        for key in ("manifestSha256", "provenanceSha256", "inputSha256", "resultSha256"):
            if not isinstance(binding[key], str) or not _SHA256.fullmatch(binding[key]):
                _fail(f"{name}.binding.{key} must be a lowercase SHA-256 digest.")
        _text(binding["tool"], 200, name=f"{name}.binding.tool", nonempty=True)
        _text(binding["createdAt"], 128, name=f"{name}.binding.createdAt", nonempty=True)
        selection = _object(source["selection"], {"y"}, {"x"}, name=f"{name}.selection")
        for key, selector in selection.items():
            _pointer_selector(selector, f"{name}.selection.{key}")
        if not isinstance(source["sourceFreshness"], str) or source["sourceFreshness"] not in {"current", "changed", "unavailable", "not-checked"}:
            _fail(f"{name}.sourceFreshness has an unsupported status.")
    if total > MAX_TOTAL_POINTS:
        _fail(f"The figure exceeds {MAX_TOTAL_POINTS} total points.")
    _text(request["methodsMarkdown"], 256 * 1024, name="methodsMarkdown", multiline=True)
    _bounded_methods(request["methods"])
    try:
        encoded = _json_bytes(request)
    except (ValueError, TypeError, RecursionError, UnicodeError) as exc:
        raise FigureExportError("FIGURE_INVALID_REQUEST", "The request is not bounded UTF-8 JSON data.") from exc
    if len(encoded) > MAX_REQUEST_BYTES:
        _fail("The figure request exceeds its 16 MiB limit.", "FIGURE_REQUEST_TOO_LARGE")
    return json.loads(encoded)


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n").encode("utf-8")


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _wrap(text: str, width: int) -> str:
    """Wrap whole Latin words and CJK display cells without truncating labels."""
    def cells(value: str) -> int:
        return sum(2 if unicodedata.east_asian_width(char) in {"W", "F"} else 1 for char in value)

    closing = set(",.;:!?%)]}，。；：！？、％）］｝》」』】〉’”")
    opening = set("（［｛《「『【〈‘“")
    lines = []
    for original in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        # CJK permits character boundaries; Latin words (including punctuation)
        # remain intact unless that individual token exceeds the available width.
        tokens, token = [], ""
        for char in original.replace("\t", "    "):
            if char.isspace() or unicodedata.east_asian_width(char) in {"W", "F"}:
                if token:
                    tokens.append(token)
                    token = ""
                tokens.append(char)
            else:
                token += char
        if token:
            tokens.append(token)
        grouped = []
        for token in tokens:
            if grouped and not token.isspace() and not grouped[-1].isspace() and (token[0] in closing or grouped[-1][-1] in opening):
                grouped[-1] += token
            else:
                grouped.append(token)
        row, whitespace = "", ""
        for token in grouped:
            if token.isspace():
                whitespace += token
                continue
            if row and cells(row + whitespace + token) > width:
                lines.append(row)
                row, whitespace = "", ""
            if not row and cells(token) > width:
                fragment = ""
                for char in token:
                    if fragment and cells(fragment + char) > width:
                        if char in closing and len(fragment) > 1 and cells(fragment[-1] + char) <= width:
                            lines.append(fragment[:-1])
                            fragment = fragment[-1]
                        else:
                            lines.append(fragment)
                            fragment = ""
                    fragment += char
                row = fragment
            else:
                row += whitespace + token
            whitespace = ""
        lines.append(row)
    return "\n".join(lines)


def prepare_figure_runtime() -> None:
    """Initialize optional native plotting imports on the MCP reader thread.

    On Windows a first NumPy extension import from a worker can stall while the
    reader blocks on stdin. Preparation is demand-driven, before dispatching the
    first figure request; listing tools and base installations remain lightweight.
    """
    _load_renderer()


def _load_renderer():
    try:
        import matplotlib
        from matplotlib import font_manager, ft2font
        from matplotlib.backends.backend_agg import FigureCanvasAgg
        from matplotlib.figure import Figure
        from matplotlib.text import Text
    except (ImportError, OSError, RuntimeError) as exc:
        raise FigureExportError("FIGURE_RENDERER_UNAVAILABLE", "Scientific figure export requires the optional research-figures runtime (matplotlib). No dependency was installed.") from exc
    return matplotlib, font_manager, ft2font, FigureCanvasAgg, Figure, Text


def _font_for(request: dict, font_manager: Any, ft2font: Any):
    strings = [request["figure"]["title"], request["figure"]["caption"]]
    for panel in request["panels"]:
        strings.extend(panel[key] for key in ("title", "xLabel", "yLabel", "xUnit", "yUnit"))
        strings.extend(point["x"] for point in panel["points"] if isinstance(point["x"], str))
    required = {ord(char) for text in strings for char in text if not char.isspace()}
    required.update(map(ord, "0123456789ABCDEF .,-+eE()[]/:\u2212"))
    best_missing = required
    for family in _FONT_FAMILIES:
        candidates = sorted((item for item in font_manager.fontManager.ttflist if item.name == family and item.style == "normal"),
                            key=lambda item: (abs(font_manager.weight_dict.get(item.weight, item.weight if isinstance(item.weight, (int, float)) else 400) - 400), item.fname.lower()))
        for candidate in candidates:
            try:
                filename = Path(candidate.fname)
                if not filename.is_file() or filename.stat().st_size > 32 * 1024 * 1024:
                    continue
                missing = required - set(ft2font.FT2Font(str(filename)).get_charmap())
                if len(missing) < len(best_missing):
                    best_missing = missing
                if missing:
                    continue
                font = font_manager.FontProperties(fname=str(filename), weight=candidate.weight)
                return font, {"family": family, "fileName": filename.name, "sha256": _sha(filename.read_bytes()), "weight": candidate.weight,
                              "coverage": "all-rendered-label-codepoints", "svg": "outlined-glyphs", "pdf": "embedded-subset"}
            except (ValueError, OSError, RuntimeError):
                continue
    codes = ", ".join(f"U+{code:04X}" for code in sorted(best_missing)[:24])
    _fail(f"No supported installed font covers all labels; missing glyphs include {codes}. Supported families: {', '.join(_FONT_FAMILIES)}.", "FIGURE_FONT_UNSUPPORTED")


def _render_vectors(request: dict) -> tuple[dict[str, bytes], dict]:
    with _RENDER_LOCK:
        matplotlib, font_manager, ft2font, FigureCanvasAgg, Figure, Text = _load_renderer()
        font, font_record = _font_for(request, font_manager, ft2font)
        columns = request["figure"]["columns"]
        rows = math.ceil(len(request["panels"]) / columns)
        title = _wrap(request["figure"]["title"], 76 if columns == 2 else 48)
        caption_text = request["figure"]["caption"]
        changed = [f"{chr(65 + index)} {panel['source']['sourceFreshness']}" for index, panel in enumerate(request["panels"]) if panel["source"]["sourceFreshness"] != "current"]
        if changed:
            caption_text += ("\n" if caption_text else "") + "Source status: " + "; ".join(changed) + ". Saved values are retained snapshots."
        caption = _wrap(caption_text, 124 if columns == 2 else 76)
        title_height = 0.25 + len(title.splitlines()) * 0.22
        caption_height = 0.18 + len(caption.splitlines()) * 0.145 if caption else 0.12
        height = rows * 4.2 + title_height + caption_height + 0.65
        width = 12.0 if columns == 2 else 7.4
        rc = {"svg.hashsalt": _sha(_json_bytes(request)), "svg.fonttype": "path", "pdf.fonttype": 42,
              "text.usetex": False, "text.parse_math": False, "font.family": [font_record["family"]],
              "font.size": 9, "font.weight": font_record["weight"], "axes.unicode_minus": True, "axes.formatter.use_mathtext": False,
              "figure.facecolor": "white", "axes.facecolor": "white", "savefig.facecolor": "white",
              "path.simplify": False, "agg.path.chunksize": 0}
        with matplotlib.rc_context(rc), warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            figure = Figure(figsize=(width, height), dpi=100)
            FigureCanvasAgg(figure)
            axes = figure.subplots(rows, columns, squeeze=False)
            figure.subplots_adjust(left=0.15 if columns == 1 else 0.09, right=0.965,
                                   top=1 - (title_height + 0.3) / height,
                                   bottom=(caption_height + 0.55) / height, hspace=0.78, wspace=0.4)
            figure.text(0.05, 1 - 0.14 / height, title, fontproperties=font, fontsize=13, va="top")
            if caption:
                figure.text(0.05, 0.12 / height, caption, fontproperties=font, fontsize=8, va="bottom")
            for index, axis in enumerate(axes.flat):
                if index >= len(request["panels"]):
                    axis.set_visible(False)
                    continue
                panel = request["panels"][index]
                xs, ys = [point["x"] for point in panel["points"]], [point["y"] for point in panel["points"]]
                if panel["kind"] == "line":
                    axis.plot(xs, ys, color="#23645f", linewidth=1.25, marker="o" if len(xs) <= 80 else None, markersize=3)
                elif panel["kind"] == "scatter":
                    axis.scatter(xs, ys, color="#23645f", s=15, linewidths=0)
                else:
                    axis.bar(range(len(xs)), ys, color="#23645f", width=0.72)
                    step = max(1, math.ceil(len(xs) / 20))
                    ticks = list(range(0, len(xs), step))
                    axis.set_xticks(ticks, [_wrap(str(xs[tick]), 18) for tick in ticks], rotation=35, ha="right")
                axis.set_title(_wrap(f"{chr(65 + index)}. {panel['title']}", 52 if columns == 1 else 40), fontproperties=font, fontsize=10, loc="left", pad=10)
                for coordinate in ("x", "y"):
                    label, unit = panel[f"{coordinate}Label"], panel[f"{coordinate}Unit"]
                    text = f"{label} ({unit})" if unit and label else (unit or label)
                    getattr(axis, f"set_{coordinate}label")(_wrap(text, 58 if coordinate == "x" else 48), fontproperties=font, fontsize=9)
                axis.spines[["top", "right"]].set_visible(False)
                axis.grid(axis="y", color="#dddddd", linewidth=0.45)
                axis.set_axisbelow(True)
                axis.tick_params(labelsize=8)
            for item in figure.findobj(match=Text):
                size = item.get_fontsize()
                item.set_fontproperties(font)
                item.set_fontsize(size)
                item.set_parse_math(False)
            figure.tight_layout(rect=(0, caption_height / height, 1, 1 - title_height / height), pad=1.8, h_pad=3, w_pad=3)
            figure.canvas.draw()
            output = {}
            for extension, metadata in (("svg", {"Date": None, "Creator": "Proto research figure renderer"}),
                                        ("pdf", {"CreationDate": None, "ModDate": None, "Creator": "Proto research figure renderer", "Producer": f"Matplotlib {matplotlib.__version__}"})):
                buffer = io.BytesIO()
                figure.savefig(buffer, format=extension, metadata=metadata)
                output[f"figure.{extension}"] = buffer.getvalue()
            figure.clear()
            if any("Glyph" in str(item.message) and "missing" in str(item.message) for item in caught):
                _fail("The selected font could not render all figure glyphs; no export was published.", "FIGURE_FONT_UNSUPPORTED")
        return output, {"engine": "matplotlib", "version": matplotlib.__version__, "python": platform.python_version(),
                        "font": font_record, "vectorDeterminism": "same request, renderer, and font bytes",
                        "pointOrder": "supplied order; no sorting, filtering, aggregation, fitting, or extrapolation",
                        "barCoordinates": "one positional bar per supplied record in original order, labelled with its original x value; repeated numeric or categorical x values remain separate",
                        "barTickLabels": "at most 20 evenly spaced labels; every supplied point retained",
                        "labelsAndUnits": "user-authored annotations, not inferred or validated measured units"}


def _values_csv(request: dict) -> bytes:
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\n", quoting=csv.QUOTE_ALL)
    # JSON string cells retain exact values without spreadsheet formula execution.
    writer.writerow(["panel_id", "point_index", "x_json", "y_json", "x_unit_json", "y_unit_json", "source_run_id", "input_sha256", "result_sha256"])
    for panel in request["panels"]:
        for index, point in enumerate(panel["points"]):
            writer.writerow([panel["id"], index, json.dumps(point["x"], ensure_ascii=False), json.dumps(point["y"]),
                             json.dumps(panel["xUnit"], ensure_ascii=False), json.dumps(panel["yUnit"], ensure_ascii=False),
                             panel["source"]["runId"], panel["source"]["binding"]["inputSha256"], panel["source"]["binding"]["resultSha256"]])
    return buffer.getvalue().encode("utf-8")


def _write_new_file(paths: WorkspacePaths, relative: str, data: bytes) -> Path:
    """Exclusive fixed-name write, bounded and rechecked before manifest publication.

    Windows stdlib cannot eliminate a malicious same-user directory rename race;
    this follows the repository's path/reparse checks and verifies bytes afterward.
    No successful manifest is emitted when any file check fails.
    """
    if len(data) > MAX_ARTIFACT_BYTES:
        _fail("A figure artifact exceeds the 16 MiB output limit.", "FIGURE_OUTPUT_TOO_LARGE")
    target = paths.build_file(relative)
    parent_before = target.parent.stat()
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    with os.fdopen(os.open(target, flags, 0o600), "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    checked = paths.build_file(relative, must_exist=True)
    parent_after = checked.parent.stat()
    if (parent_before.st_dev, parent_before.st_ino) != (parent_after.st_dev, parent_after.st_ino):
        raise SecurityBoundaryError("WRITE_RACE_DETECTED", "Figure export directory changed during publication.")
    if read_bytes_bounded(checked, MAX_ARTIFACT_BYTES) != data:
        raise SecurityBoundaryError("WRITE_RACE_DETECTED", "Figure export bytes changed during publication.")
    return checked


def render_research_figure(request: dict[str, Any], *, workspace_root: str | Path | None = None) -> dict[str, Any]:
    request = validate_figure_request(request)
    return _render_validated(request, workspace_root=workspace_root, request_sha256=_sha(_json_bytes(request)))


def _render_validated(request: dict, *, workspace_root: str | Path | None, request_sha256: str) -> dict:
    artifacts, rendering = _render_vectors(request)
    artifacts["figure-data.json"] = _json_bytes({"schema": "proto.research-figure-data.v1", "request": request, "rendering": rendering})
    artifacts["plotted-values.csv"] = _values_csv(request)
    artifacts["methods.md"] = request["methodsMarkdown"].encode("utf-8")
    artifacts["methods.json"] = _json_bytes(request["methods"])
    if any(len(value) > MAX_ARTIFACT_BYTES for value in artifacts.values()) or sum(map(len, artifacts.values())) > MAX_TOTAL_BYTES:
        _fail("The export exceeds its bounded output budget.", "FIGURE_OUTPUT_TOO_LARGE")
    # Reopen the actual in-memory formats, before any publication.
    root = ElementTree.fromstring(artifacts["figure.svg"])
    if root.tag != "{http://www.w3.org/2000/svg}svg" or root.findall(".//{http://www.w3.org/2000/svg}image"):
        _fail("SVG validation failed or raster content was produced.", "FIGURE_VECTOR_INVALID")
    if not artifacts["figure.pdf"].startswith(b"%PDF-") or not artifacts["figure.pdf"].rstrip().endswith(b"%%EOF"):
        _fail("PDF framing validation failed.", "FIGURE_VECTOR_INVALID")
    paths = WorkspacePaths.create(workspace_root)
    export_id = uuid4().hex
    base = paths.build_directory("build/research-figures/exports")
    directory = base / export_id
    directory.mkdir(exist_ok=False)
    relative_root = f"build/research-figures/exports/{export_id}"
    entries = []
    formats = {"figure.svg": ("svg", "image/svg+xml"), "figure.pdf": ("pdf", "application/pdf"),
               "plotted-values.csv": ("csv", "text/csv"), "figure-data.json": ("data", "application/json"),
               "methods.md": ("methods", "text/markdown"), "methods.json": ("methods-json", "application/json")}
    for name, data in artifacts.items():
        relative = f"{relative_root}/{name}"
        _write_new_file(paths, relative, data)
        format_name, mime = formats[name]
        entries.append({"format": format_name, "path": relative, "sha256": _sha(data), "bytes": len(data), "mimeType": mime})
    # Hash the reopened files again immediately before the sole completion marker.
    for entry in entries:
        reopened = paths.build_file(entry["path"], must_exist=True)
        if _sha(read_bytes_bounded(reopened, MAX_ARTIFACT_BYTES)) != entry["sha256"]:
            _fail("An export artifact changed before manifest publication.", "FIGURE_ARTIFACT_CHANGED")
    manifest = {"schema": EXPORT_SCHEMA, "ok": True, "exportId": export_id,
                "createdAt": datetime.now(timezone.utc).isoformat(), "figureId": request["figure"]["id"],
                "figureRevision": request["figure"]["revision"], "requestSha256": request_sha256,
                "canonicalRequestSha256": _sha(_json_bytes(request)),
                "rendering": rendering, "files": entries, "panelCount": len(request["panels"]),
                "pointCount": sum(len(panel["points"]) for panel in request["panels"]),
                "authority": "unsigned-local-rendering-of-host-supplied-data",
                "reviewStatus": "human-review-required",
                "scope": "Exact supplied points and annotations only. Source bindings are host-supplied claims; this renderer does not authenticate compute runs or establish scientific validity."}
    manifest_raw = _json_bytes(manifest)
    manifest_path = f"{relative_root}/manifest.json"
    _write_new_file(paths, manifest_path, manifest_raw)
    return {"exportId": export_id, "figureId": manifest["figureId"], "figureRevision": manifest["figureRevision"],
            "createdAt": manifest["createdAt"], "files": entries, "manifestPath": manifest_path, "manifestSha256": _sha(manifest_raw)}


def render_research_figure_file(path: str, *, workspace_root: str | Path | None = None) -> dict[str, Any]:
    paths = WorkspacePaths.create(workspace_root)
    source = paths.workspace_file(path, extensions={".json"}, max_bytes=MAX_REQUEST_BYTES)
    raw = read_bytes_bounded(source, MAX_REQUEST_BYTES)
    try:
        request = decode_json_bounded(raw.decode("utf-8"), max_bytes=MAX_REQUEST_BYTES)
    except (UnicodeError, JsonValidationError) as exc:
        raise FigureExportError("FIGURE_INVALID_JSON", str(exc)) from exc
    return _render_validated(validate_figure_request(request), workspace_root=paths.workspace, request_sha256=_sha(raw))
