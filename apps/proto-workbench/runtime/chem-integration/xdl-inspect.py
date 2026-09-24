"""Inspect XDL with the existing, separately installed Chem XDL environment.

The JSON stdin/stdout adapter only calls the upstream PlaceholderPlatform parser
and serializers. It never prepares, compiles, or executes a procedure. XDL itself
is intentionally not vendored with this adapter.
"""

from __future__ import annotations

import contextlib
import hashlib
import importlib.metadata
import io
import json
from pathlib import Path
import sys
import tempfile

MAX_INPUT_BYTES = 200 * 1024
MAX_OUTPUT_BYTES = 2 * 1024 * 1024
BOUNDARY = {"platform": "PlaceholderPlatform", "compiled": False, "executed": False}


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def semantic_document(value: object) -> object:
    """Ignore only upstream-generated step identities when comparing exports."""
    if isinstance(value, dict):
        return {key: semantic_document(item) for key, item in value.items() if key != "uuid"}
    if isinstance(value, list):
        return [semantic_document(item) for item in value]
    return value


def inspect_request(request: object) -> dict:
    if not isinstance(request, dict):
        raise ValueError("Expected a JSON object.")
    if request == {"action": "status"}:
        from xdl import XDL  # noqa: F401
        from xdl.platforms import PlaceholderPlatform  # noqa: F401

        return {"ok": True, "available": True, "version": importlib.metadata.version("xdl"), **BOUNDARY}
    if set(request) != {"source", "format"}:
        raise ValueError("Inspection accepts only source and format.")
    source, file_format = request["source"], request["format"]
    if not isinstance(source, str) or not source.strip():
        raise ValueError("Supply a non-empty XDL document.")
    if len(source.encode("utf-8")) > MAX_INPUT_BYTES:
        raise ValueError("XDL source exceeds the 200 KiB import limit.")
    if file_format not in ("xml", "json"):
        raise ValueError("The document format must be xml or json.")
    if file_format == "xml" and any(marker in source.upper() for marker in ("<!DOCTYPE", "<!ENTITY")):
        raise ValueError("XDL inspection does not accept XML document types or entity declarations.")

    from xdl import XDL
    from xdl.platforms import PlaceholderPlatform

    # Keep upstream blueprint discovery inside this request's temporary folder.
    # The only supplied file is the user's document; no working-tree file paths
    # or platform/controller objects can be supplied through the request.
    with tempfile.TemporaryDirectory(prefix="chem-xdl-inspect-") as temporary:
        directory = Path(temporary)
        original = directory / ("source.xdl" if file_format == "xml" else "source.json")
        original.write_text(source, encoding="utf-8")
        document = XDL(str(original), platform=PlaceholderPlatform, working_directory=str(directory))
        if document.compiled:
            raise ValueError("This inspection interface accepts uncompiled XDL source only.")

        serialized = document.as_json()
        exports, roundtrip = {}, {}
        for target_format, suffix in (("xml", "xdl"), ("json", "json")):
            destination = directory / f"roundtrip.{suffix}"
            document.save(str(destination), file_format=target_format)
            exported = destination.read_text(encoding="utf-8")
            reopened = XDL(str(destination), platform=PlaceholderPlatform, working_directory=str(directory))
            if reopened.compiled:
                raise ValueError("Round-trip output unexpectedly contained compiled state.")
            exports[target_format] = exported
            roundtrip[target_format] = {
                "ok": True,
                "stepCount": len(reopened.steps),
                "sha256": digest(exported),
                "compiled": False,
                "equivalent": semantic_document(reopened.as_json()) == semantic_document(serialized),
            }

        synthesis = serialized.get("Synthesis", serialized)
        return {
            "ok": True,
            "version": importlib.metadata.version("xdl"),
            **BOUNDARY,
            "source": {"format": file_format, "sha256": digest(source), "bytes": len(source.encode("utf-8"))},
            "counts": {
                "steps": len(document.steps),
                "reagents": len(document.reagents),
                "hardware": len(document.hardware),
                "parameters": len(document.parameters),
            },
            "steps": synthesis.get("steps", []),
            "metadata": synthesis.get("metadata", {}),
            "roundtrip": roundtrip,
            "exports": exports,
        }


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            raise ValueError("XDL request exceeds the 200 KiB input limit.")
        request = json.loads(raw.decode("utf-8"))
        # Preserve the transport even if the upstream package prints diagnostics.
        with contextlib.redirect_stdout(io.StringIO()):
            response = inspect_request(request)
        encoded = json.dumps(response, ensure_ascii=False)
        if len(encoded.encode("utf-8")) > MAX_OUTPUT_BYTES:
            raise ValueError("XDL inspection output exceeds the 2 MiB response limit.")
    except Exception as error:
        encoded = json.dumps({
            "ok": False,
            **BOUNDARY,
            "error": {"type": type(error).__name__, "message": str(error)[:8192]},
        }, ensure_ascii=False)
    sys.stdout.buffer.write(encoded.encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
