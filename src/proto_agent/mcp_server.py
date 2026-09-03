from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable

from .analysis import DEFAULT_ANALYSIS_OUT_DIR, run_python_analysis
from .compiler import compile_design, validate_design
from .connectors import connector_summary
from .exporters import export_ir, load_ir
from .literature import DEFAULT_LITERATURE_PATH, DEFAULT_PUBMED_CACHE_DIR, search_literature, search_pubmed
from .models import Diagnostic
from .notebook import DEFAULT_NOTEBOOK_OUT_DIR, run_notebook
from .optimization import optimize_design
from .parser import parse_design
from .parts import DEFAULT_PARTS_PATH, search_parts
from .materials import MaterialsError, MaterialsStore, MAX_MATERIALIZED_PARTS, MAX_MCP_RESULT_LIMIT
from .protein import compile_protein_selection
from .provenance import verify_provenance
from .r_runtime import DEFAULT_R_OUT_DIR, r_status, run_r_script
from .review import DEFAULT_REVIEW_OUT_DIR, build_review_packet
from .scoring import score_design
from .sequence import validate_sequences
from .sbol import validate_sbol_turtle
from .source_search import (
    DEFAULT_EVIDENCE_CACHE_DIR,
    search_crossref,
    search_europe_pmc,
    search_rhea,
    search_uniprot,
)
from .skill_sdk import DEFAULT_SKILLS_ROOT, list_skill_adapters, resolve_skill_adapter
from .workflow import DEFAULT_WORKFLOW_PATH, run_design_review
from .execution import ExecutionBroker, ExecutionDenied, MAX_EXECUTION_ARG_CHARS, MAX_EXECUTION_ARGS, MAX_EXECUTION_TIMEOUT_SECONDS
from .json_validation import JsonValidationError, strict_json_loads, validate_json_schema, validate_json_shape
from .security import (
    MAX_JSON_FILE_BYTES,
    MAX_PATH_CHARS,
    MAX_TEXT_FILE_BYTES,
    SecurityBoundaryError,
    WorkspacePaths,
    public_workspace_payload,
    read_text_bounded,
    write_text_bounded,
)

PROTOCOL_VERSION = "2025-06-18"
MAX_REQUEST_BYTES = 256 * 1024
MAX_TOOL_RESPONSE_BYTES = 512 * 1024
MAX_RESPONSE_BYTES = 1024 * 1024
MAX_QUERY_CHARS = 512
MAX_ERROR_MESSAGE_CHARS = 1024
MAX_ACTIVE_REQUESTS = 4
NETWORK_CAPABILITY_VERSION = "proto-workbench.network-capability.v1"
NETWORK_CAPABILITY_MAX_TTL_MS = 60_000
NETWORK_CAPABILITY_CLOCK_SKEW_MS = 5_000
MAX_CONSUMED_NETWORK_NONCES = 4_096
NETWORK_TOOLS = frozenset(
    {
        "proto_pubmed_search",
        "proto_europe_pmc_search",
        "proto_crossref_search",
        "proto_uniprot_search",
        "proto_rhea_search",
    }
)


class NetworkCapabilityError(ValueError):
    code = "NETWORK_CAPABILITY_REQUIRED"


def _secure_tool_schema(schema: dict[str, Any]) -> None:
    schema["additionalProperties"] = False
    schema["maxProperties"] = max(len(schema.get("properties", {})), 1)
    required = set(schema.get("required", []))
    for name, field in schema.get("properties", {}).items():
        field_type = field.get("type")
        if field_type == "string":
            if name in required:
                field.setdefault("minLength", 1)
            if name in {"path", "script", "ir_path", "parts_path", "out", "out_dir", "workflow_path", "manifest_path", "registry", "root", "cache_dir", "fixture", "cafile"}:
                field.setdefault("maxLength", MAX_PATH_CHARS)
            elif name in {"query", "literature_query"}:
                field.setdefault("maxLength", MAX_QUERY_CHARS)
            else:
                field.setdefault("maxLength", 1024)
        elif field_type == "integer":
            if name in {"limit", "retmax"}:
                field.setdefault("minimum", 1)
                field.setdefault("maximum", 20)
            elif name == "timeout":
                field.setdefault("minimum", 1)
                field.setdefault("maximum", MAX_EXECUTION_TIMEOUT_SECONDS)
            elif name == "organism_id":
                field.setdefault("minimum", 1)
                field.setdefault("maximum", 2**31 - 1)
        elif field_type == "array":
            field.setdefault("maxItems", MAX_EXECUTION_ARGS)
            if isinstance(field.get("items"), dict) and field["items"].get("type") == "string":
                field["items"].setdefault("maxLength", MAX_EXECUTION_ARG_CHARS)


TOOLS: list[dict[str, Any]] = [
    {
        "name": "proto_check",
        "description": "Validate a Proto-like design file and return structured diagnostics.",
        "inputSchema": {
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": {"type": "string"},
                "parts_path": {"type": "string", "default": str(DEFAULT_PARTS_PATH)},
            },
        },
    },
    {
        "name": "proto_compile",
        "description": "Compile a Proto-like design file to typed JSON IR.",
        "inputSchema": {
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": {"type": "string"},
                "out": {"type": "string"},
                "parts_path": {"type": "string", "default": str(DEFAULT_PARTS_PATH)},
            },
        },
    },
    {
        "name": "proto_protein_compile",
        "description": "Compile a materialized, explicitly design-eligible protein selection to a bounded protein-domain IR artifact. Full sequences are kept in the workspace artifact, not returned in the MCP response.",
        "inputSchema": {
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": {"type": "string"},
                "out": {"type": "string"},
            },
        },
    },
    {
        "name": "proto_export",
        "description": "Export compiled JSON IR to SBOL-like Turtle, GenBank-like, or FASTA artifacts.",
        "inputSchema": {
            "type": "object",
            "required": ["ir_path", "format", "out"],
            "properties": {
                "ir_path": {"type": "string"},
                "format": {"type": "string", "enum": ["sbol", "genbank", "fasta"]},
                "out": {"type": "string"},
            },
        },
    },
    {
        "name": "proto_validate_sbol",
        "description": "Validate a local minimal SBOL Turtle export for required SBOL3/RDF structure.",
        "inputSchema": {
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": {"type": "string"},
            },
        },
    },
    {
        "name": "proto_score",
        "description": "Score a Proto-like design with local software checks and toy sequence summaries.",
        "inputSchema": {
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": {"type": "string"},
                "parts_path": {"type": "string", "default": str(DEFAULT_PARTS_PATH)},
            },
        },
    },
    {
        "name": "proto_validate_sequences",
        "description": "Validate assembled construct sequences against GC and restriction-site constraints.",
        "inputSchema": {
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": {"type": "string"},
                "parts_path": {"type": "string", "default": str(DEFAULT_PARTS_PATH)},
            },
        },
    },
    {
        "name": "proto_optimize_sequences",
        "description": "Generate reviewable sequence optimization suggestions, using DNA Chisel when available or a local suggestion backend.",
        "inputSchema": {
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": {"type": "string"},
                "parts_path": {"type": "string", "default": str(DEFAULT_PARTS_PATH)},
                "backend": {"type": "string", "enum": ["auto", "local", "dnachisel"], "default": "auto"},
            },
        },
    },
    {
        "name": "proto_search_parts",
        "description": "Search the local parts library. Use this before adding part IDs to a design.",
        "inputSchema": {
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": {"type": "string"},
                "chassis": {"type": "string"},
                "parts_path": {"type": "string", "default": str(DEFAULT_PARTS_PATH)},
            },
        },
    },
    {
        "name": "proto_materials_search",
        "description": "Search the active external biological materials snapshot. Results are bounded summaries only; quarantine records and full sequences are never exposed.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "default": ""},
                "kind": {"type": "string"},
                "organism": {"type": "string"},
                "role": {"type": "string"},
                "source": {"type": "string"},
                "license_id": {"type": "string"},
                "status": {"type": "string", "enum": ["DESIGN_ELIGIBLE"], "default": "DESIGN_ELIGIBLE"},
                "limit": {"type": "integer", "minimum": 1, "maximum": MAX_MCP_RESULT_LIMIT, "default": 20},
                "cursor": {"type": "string"},
                "snapshot": {"type": "string", "description": "Optional reproducibility assertion; it must equal the currently active snapshot."},
            },
        },
    },
    {
        "name": "proto_materials_get",
        "description": "Get one design-eligible materials record with bilingual description, source, license, evidence, safety metadata, and optional bounded sequence.",
        "inputSchema": {
            "type": "object",
            "required": ["resource_id"],
            "properties": {
                "resource_id": {"type": "string"},
                "include_sequence": {"type": "boolean", "default": False},
                "snapshot": {"type": "string", "description": "Optional reproducibility assertion; it must equal the currently active snapshot."},
            },
        },
    },
    {
        "name": "proto_materials_facets",
        "description": "Return bounded facet counts for design-eligible materials in the active snapshot. Quarantine is excluded.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "snapshot": {"type": "string", "description": "Optional reproducibility assertion; it must equal the currently active snapshot."},
            },
        },
    },
    {
        "name": "proto_materials_materialize",
        "description": "Materialize selected design-eligible genetic parts into build/materials/selections as a provenance-carrying parts snapshot for Proto check/compile.",
        "inputSchema": {
            "type": "object",
            "required": ["resource_ids", "chassis"],
            "properties": {
                "resource_ids": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": MAX_MATERIALIZED_PARTS},
                "chassis": {"type": "string"},
                "out": {"type": "string"},
                "snapshot": {"type": "string", "description": "Optional reproducibility assertion; it must equal the currently active snapshot."},
            },
        },
    },
    {
        "name": "proto_materials_materialize_proteins",
        "description": "Materialize selected DESIGN_ELIGIBLE protein sequences into a provenance-carrying protein selection for proto_protein_compile.",
        "inputSchema": {
            "type": "object",
            "required": ["resource_ids"],
            "properties": {
                "resource_ids": {"type": "array", "items": {"type": "string"}, "maxItems": 50},
                "design_id": {"type": "string"},
                "out": {"type": "string"},
                "snapshot": {"type": "string", "description": "Optional reproducibility assertion; it must equal the currently active snapshot."},
            },
        },
    },
    {
        "name": "proto_workflow_run",
        "description": "Run the local design review workflow and write an auditable manifest.",
        "inputSchema": {
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": {"type": "string"},
                "parts_path": {"type": "string", "default": str(DEFAULT_PARTS_PATH)},
                "workflow_path": {"type": "string", "default": str(DEFAULT_WORKFLOW_PATH)},
                "out_dir": {"type": "string", "default": "build/runs"},
            },
        },
    },
    {
        "name": "proto_review_packet",
        "description": "Build evidence cards, a human-review checklist, and a communication-ready review packet.",
        "inputSchema": {
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": {"type": "string"},
                "parts_path": {"type": "string", "default": str(DEFAULT_PARTS_PATH)},
                "workflow_path": {"type": "string"},
                "manifest_path": {"type": "string"},
                "out_dir": {"type": "string", "default": str(DEFAULT_REVIEW_OUT_DIR)},
                "literature_query": {"type": "string"},
            },
        },
    },
    {
        "name": "proto_provenance_verify",
        "description": "Verify the manifest, material, and artifact digests in a workspace build provenance statement.",
        "inputSchema": {
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": {"type": "string"},
            },
        },
    },
    {
        "name": "proto_literature_search",
        "description": "Search local source notes that support workbench design rationale and future literature workflows.",
        "inputSchema": {
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": {"type": "string"},
                "registry": {"type": "string", "default": str(DEFAULT_LITERATURE_PATH)},
                "limit": {"type": "integer", "default": 10},
            },
        },
    },
    {
        "name": "proto_pubmed_search",
        "description": "Search PubMed through NCBI E-utilities with local cache and structured metadata output.",
        "inputSchema": {
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": {"type": "string"},
                "retmax": {"type": "integer", "default": 5},
                "offline": {"type": "boolean", "default": True},
                "fixture": {"type": "string"},
            },
        },
    },
    {
        "name": "proto_europe_pmc_search",
        "description": "Search Europe PMC for life-science articles, preprints, patents, and linked metadata with stable source identifiers.",
        "inputSchema": {
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer", "default": 5, "minimum": 1, "maximum": 20},
                "offline": {"type": "boolean", "default": True},
                "fixture": {"type": "string"},
            },
        },
    },
    {
        "name": "proto_crossref_search",
        "description": "Search Crossref DOI metadata to corroborate publication identity and bibliographic records.",
        "inputSchema": {
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer", "default": 5, "minimum": 1, "maximum": 20},
                "offline": {"type": "boolean", "default": True},
                "fixture": {"type": "string"},
            },
        },
    },
    {
        "name": "proto_uniprot_search",
        "description": "Search reviewed UniProtKB protein-function metadata without returning biological sequences.",
        "inputSchema": {
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer", "default": 5, "minimum": 1, "maximum": 20},
                "organism_id": {"type": "integer"},
                "reviewed_only": {"type": "boolean", "default": True},
                "offline": {"type": "boolean", "default": True},
                "fixture": {"type": "string"},
            },
        },
    },
    {
        "name": "proto_rhea_search",
        "description": "Search curated Rhea biochemical reactions and return reaction, ChEBI, EC, PubMed, and pathway cross-references.",
        "inputSchema": {
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer", "default": 5, "minimum": 1, "maximum": 20},
                "offline": {"type": "boolean", "default": True},
                "fixture": {"type": "string"},
            },
        },
    },
    {
        "name": "proto_run_analysis",
        "description": "Run a workspace-local Python analysis script only in an explicitly configured digest-pinned OCI sandbox; otherwise fail closed.",
        "inputSchema": {
            "type": "object",
            "required": ["script"],
            "properties": {
                "script": {"type": "string"},
                "args": {"type": "array", "items": {"type": "string"}, "default": []},
                "out_dir": {"type": "string", "default": str(DEFAULT_ANALYSIS_OUT_DIR)},
                "timeout": {"type": "integer", "default": 60},
            },
        },
    },
    {
        "name": "proto_run_notebook",
        "description": "Execute bounded notebook code cells only in an explicitly configured digest-pinned OCI sandbox; otherwise fail closed.",
        "inputSchema": {
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": {"type": "string"},
                "out_dir": {"type": "string", "default": str(DEFAULT_NOTEBOOK_OUT_DIR)},
                "timeout": {"type": "integer", "default": 120},
            },
        },
    },
    {
        "name": "proto_r_status",
        "description": "Check whether Rscript is available on this machine.",
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "proto_run_r",
        "description": "Run a workspace-local R script only in an explicitly configured digest-pinned OCI sandbox; otherwise fail closed.",
        "inputSchema": {
            "type": "object",
            "required": ["script"],
            "properties": {
                "script": {"type": "string"},
                "args": {"type": "array", "items": {"type": "string"}, "default": []},
                "out_dir": {"type": "string", "default": str(DEFAULT_R_OUT_DIR)},
                "timeout": {"type": "integer", "default": 120},
            },
        },
    },
    {
        "name": "proto_connectors_check",
        "description": "Inspect the declared local/planned connector registry.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "registry": {"type": "string", "default": "connectors/proto_workbench.json"}
            },
        },
    },
    {
        "name": "proto_skills_list",
        "description": "List and resolve bounded vendor-neutral project Skill adapters without executing them.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "root": {"type": "string", "default": str(DEFAULT_SKILLS_ROOT)},
                "registry": {"type": "string", "default": "connectors/proto_workbench.json"},
            },
        },
    },
    {
        "name": "proto_skills_resolve",
        "description": "Resolve one bounded project Skill adapter against declared CLI, MCP, and HTTP interfaces without invoking it.",
        "inputSchema": {
            "type": "object",
            "required": ["skill_id"],
            "properties": {
                "skill_id": {"type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,63}$", "maxLength": 64},
                "root": {"type": "string", "default": str(DEFAULT_SKILLS_ROOT)},
                "registry": {"type": "string", "default": "connectors/proto_workbench.json"},
            },
        },
    },
]

for _tool in TOOLS:
    _secure_tool_schema(_tool["inputSchema"])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="proto-agent-mcp")
    parser.add_argument("--once", help="Handle one JSON-RPC request passed as a JSON string, useful for tests.")
    parser.add_argument("--once-file", help="Handle one JSON-RPC request loaded from a file.")
    args = parser.parse_args(argv)

    server = McpServer()
    if args.once or args.once_file:
        if args.once:
            request_text = args.once
        else:
            request_path = server.paths.workspace_file(
                args.once_file,
                extensions={".json"},
                max_bytes=MAX_REQUEST_BYTES,
            )
            request_text = read_text_bounded(request_path, MAX_REQUEST_BYTES)
        try:
            request = strict_json_loads(request_text, max_bytes=MAX_REQUEST_BYTES)
            response = server.handle_message(request)
        except (JsonValidationError, SecurityBoundaryError, UnicodeError) as exc:
            response = _error_response(None, -32700, f"Invalid JSON-RPC message: {exc}")
        if response is not None:
            print(server.serialize_response(response))
        return 0

    return server.serve()


class McpServer:
    def __init__(self, workspace_root: str | Path | None = None) -> None:
        self.paths = WorkspacePaths.create(workspace_root)
        self.execution_broker = ExecutionBroker.from_environment(caller="mcp")
        self._network_capability_key = _network_capability_key_from_environment()
        self._consumed_network_nonces: dict[str, int] = {}
        self._network_nonce_lock = threading.Lock()
        self._request_context = threading.local()
        self._active_requests: dict[str | int, tuple[threading.Thread, threading.Event]] = {}
        self._active_lock = threading.Lock()
        self._output_lock = threading.Lock()
        self._tool_handlers: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
            "proto_check": self._tool_check,
            "proto_compile": self._tool_compile,
            "proto_protein_compile": self._tool_protein_compile,
            "proto_export": self._tool_export,
            "proto_validate_sbol": self._tool_validate_sbol,
            "proto_score": self._tool_score,
            "proto_validate_sequences": self._tool_validate_sequences,
            "proto_optimize_sequences": self._tool_optimize_sequences,
            "proto_search_parts": self._tool_search_parts,
            "proto_materials_search": self._tool_materials_search,
            "proto_materials_get": self._tool_materials_get,
            "proto_materials_facets": self._tool_materials_facets,
            "proto_materials_materialize": self._tool_materials_materialize,
            "proto_materials_materialize_proteins": self._tool_materials_materialize_proteins,
            "proto_workflow_run": self._tool_workflow_run,
            "proto_review_packet": self._tool_review_packet,
            "proto_provenance_verify": self._tool_provenance_verify,
            "proto_literature_search": self._tool_literature_search,
            "proto_pubmed_search": self._tool_pubmed_search,
            "proto_europe_pmc_search": self._tool_europe_pmc_search,
            "proto_crossref_search": self._tool_crossref_search,
            "proto_uniprot_search": self._tool_uniprot_search,
            "proto_rhea_search": self._tool_rhea_search,
            "proto_run_analysis": self._tool_run_analysis,
            "proto_run_notebook": self._tool_run_notebook,
            "proto_r_status": self._tool_r_status,
            "proto_run_r": self._tool_run_r,
            "proto_connectors_check": self._tool_connectors_check,
            "proto_skills_list": self._tool_skills_list,
            "proto_skills_resolve": self._tool_skills_resolve,
        }

    def serve(self) -> int:
        stream = sys.stdin.buffer
        while True:
            raw = stream.readline(MAX_REQUEST_BYTES + 1)
            if not raw:
                break
            if len(raw) > MAX_REQUEST_BYTES:
                response = _error_response(None, -32600, "JSON-RPC request exceeds the byte limit; closing the sidecar.")
                self._emit_response(response)
                self._cancel_and_join_active_requests()
                return 1
            try:
                line = raw.decode("utf-8").strip()
                if not line:
                    continue
                message = strict_json_loads(line, max_bytes=MAX_REQUEST_BYTES)
            except (UnicodeDecodeError, JsonValidationError) as exc:
                self._emit_response(_error_response(None, -32700, f"Invalid JSON-RPC message: {exc}"))
                continue
            try:
                _validate_rpc_message(message)
            except JsonValidationError as exc:
                request_id = _safe_request_id(message)
                self._emit_response(_error_response(request_id, -32600, str(exc)))
                continue

            method = message.get("method")
            if method == "notifications/cancelled":
                self._cancel_request(message["params"]["requestId"])
                continue
            if method == "tools/call" and "id" in message:
                self._start_tool_request(message)
                continue
            response = self.handle_message(message)
            if response is not None:
                self._emit_response(response)
        self._cancel_and_join_active_requests()
        return 0

    def _emit_response(self, response: dict[str, Any]) -> None:
        serialized = self.serialize_response(response)
        with self._output_lock:
            print(serialized, flush=True)

    def _start_tool_request(self, message: dict[str, Any]) -> None:
        request_id = message["id"]
        with self._active_lock:
            if request_id in self._active_requests:
                response = _error_response(request_id, -32600, "Duplicate active JSON-RPC request id.")
            elif len(self._active_requests) >= MAX_ACTIVE_REQUESTS:
                response = _error_response(request_id, -32000, "Too many active tool requests.")
            else:
                cancel_event = threading.Event()
                worker = threading.Thread(
                    target=self._tool_request_worker,
                    args=(message, request_id, cancel_event),
                    daemon=True,
                    name=f"proto-mcp-request-{request_id}",
                )
                self._active_requests[request_id] = (worker, cancel_event)
                worker.start()
                return
        self._emit_response(response)

    def _tool_request_worker(
        self,
        message: dict[str, Any],
        request_id: str | int,
        cancel_event: threading.Event,
    ) -> None:
        try:
            response = self.handle_message(message, cancel_event=cancel_event)
            if response is not None and not cancel_event.is_set():
                self._emit_response(response)
        finally:
            with self._active_lock:
                self._active_requests.pop(request_id, None)

    def _cancel_request(self, request_id: str | int) -> None:
        with self._active_lock:
            active = self._active_requests.get(request_id)
            if active is not None:
                active[1].set()

    def _cancel_and_join_active_requests(self) -> None:
        with self._active_lock:
            active = list(self._active_requests.values())
        for _worker, cancel_event in active:
            cancel_event.set()
        deadline = time.monotonic() + 5
        for worker, _cancel_event in active:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            worker.join(timeout=remaining)

    def serialize_response(self, response: dict[str, Any]) -> str:
        try:
            serialized = json.dumps(response, separators=(",", ":"), ensure_ascii=True, allow_nan=False)
        except (TypeError, ValueError, OverflowError, RecursionError):
            response = _error_response(_safe_request_id(response), -32603, "JSON-RPC response could not be serialized safely.")
            serialized = json.dumps(response, separators=(",", ":"), ensure_ascii=True, allow_nan=False)
        if len(serialized.encode("utf-8")) <= MAX_RESPONSE_BYTES:
            return serialized
        fallback = _error_response(response.get("id"), -32603, "JSON-RPC response exceeds the byte limit.")
        return json.dumps(fallback, separators=(",", ":"), ensure_ascii=True, allow_nan=False)

    def handle_message(
        self,
        message: Any,
        *,
        cancel_event: threading.Event | None = None,
    ) -> dict[str, Any] | None:
        try:
            _validate_rpc_message(message)
        except JsonValidationError as exc:
            request_id = _safe_request_id(message)
            return _error_response(request_id, -32600, str(exc))
        method = message.get("method")
        request_id = message.get("id")

        if method is None:
            return _error_response(request_id, -32600, "Missing JSON-RPC method.")

        if method in {"notifications/initialized", "notifications/cancelled"}:
            return None

        if method == "initialize":
            return _success_response(
                request_id,
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {
                        "tools": {},
                        "experimental": {
                            "protoSecurity": {
                                "workspaceRoot": self.paths.workspace.as_uri(),
                                "buildRoot": self.paths.build.as_uri(),
                                "cacheRoot": self.paths.cache.as_uri(),
                                "hostExecution": False,
                                "networkEnabled": False,
                                "networkAuthorization": "per-call-hmac-capability",
                                "sandbox": self.execution_broker.status(),
                            }
                        },
                    },
                    "serverInfo": {
                        "name": "proto-agent",
                        "version": "0.1.0",
                    },
                },
            )

        if method == "tools/list":
            return _success_response(request_id, {"tools": TOOLS})

        if method == "proto/roots":
            return _success_response(
                request_id,
                {
                    "roots": [
                        {"uri": self.paths.workspace.as_uri(), "name": "workspace"},
                        {"uri": self.paths.build.as_uri(), "name": "build"},
                        {"uri": self.paths.cache.as_uri(), "name": "cache"},
                    ]
                },
            )

        if method == "proto/capabilities":
            return _success_response(
                request_id,
                {
                    "workspace": self.paths.workspace.as_uri(),
                    "execution": self.execution_broker.status(),
                    "networkPaths": {
                        "fixtures": "workspace regular files only",
                        "cache": self.paths.cache.as_uri(),
                        "ca": "custom CA selection is disabled for MCP requests",
                    },
                    "networkEnabled": False,
                    "networkAuthorization": "per-call-hmac-capability",
                    "filesystemSafety": {
                        "relativePathsOnly": True,
                        "reparsePointsAllowed": False,
                        "atomicReplace": True,
                        "windowsResidualSameUserRenameRace": True,
                    },
                },
            )

        if method == "tools/call":
            params = message.get("params", {})
            tool_name = params.get("name")
            arguments = params.get("arguments") or {}
            capability = params.get("capability")
            handler = self._tool_handlers.get(tool_name)
            if handler is None:
                return _error_response(request_id, -32601, f"Unknown tool: {tool_name}")
            try:
                tool = next(item for item in TOOLS if item["name"] == tool_name)
                validate_json_schema(arguments, tool["inputSchema"], path="$.params.arguments")
                self._request_context.cancel_event = cancel_event
                self._request_context.network_capability = capability
                payload = handler(arguments)
                payload = public_workspace_payload(payload, self.paths.workspace)
            except (JsonValidationError, SecurityBoundaryError, ExecutionDenied, ValueError, KeyError) as exc:
                payload = {
                    "ok": False,
                    "diagnostics": [
                        {
                            "severity": "error",
                            "file": "",
                            "line": 0,
                            "code": getattr(exc, "code", "INVALID_TOOL_ARGUMENTS"),
                            "message": str(exc),
                        }
                    ],
                }
            except OSError:
                payload = _internal_tool_error("A local file or runtime operation failed safely.")
            except Exception:
                payload = _internal_tool_error("The tool failed without exposing internal details.")
            finally:
                self._request_context.cancel_event = None
                self._request_context.network_capability = None
            return _success_response(request_id, _tool_result(payload))

        return _error_response(request_id, -32601, f"Unknown method: {method}")

    def _tool_check(self, arguments: dict[str, Any]) -> dict[str, Any]:
        path = self.paths.workspace_file(_required_string(arguments, "path"), extensions={".proto"}, max_bytes=MAX_TEXT_FILE_BYTES)
        parts_path = self.paths.workspace_file(arguments.get("parts_path", str(DEFAULT_PARTS_PATH)), extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
        design, parse_diagnostics = parse_design(path)
        diagnostics = validate_design(design, parse_diagnostics, parts_path)
        ok = not any(item.severity == "error" for item in diagnostics)
        return _diagnostics_payload(ok, diagnostics, [])

    def _tool_compile(self, arguments: dict[str, Any]) -> dict[str, Any]:
        path = self.paths.workspace_file(_required_string(arguments, "path"), extensions={".proto"}, max_bytes=MAX_TEXT_FILE_BYTES)
        parts_path = self.paths.workspace_file(arguments.get("parts_path", str(DEFAULT_PARTS_PATH)), extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
        out = arguments.get("out") or str(Path("build") / "mcp" / f"{path.stem}.ir.json")
        ir, diagnostics = compile_design(path, parts_path)
        if ir is None:
            return _diagnostics_payload(False, diagnostics, [])
        ir = public_workspace_payload(ir, self.paths.workspace)
        output_path = self.paths.build_file(out, extensions={".json"})
        write_text_bounded(output_path, json.dumps(ir, indent=2) + "\n", boundary=self.paths.build)
        payload = _diagnostics_payload(
            True,
            diagnostics,
            [output_path.relative_to(self.paths.workspace).as_posix()],
        )
        payload["ir"] = ir
        return payload

    def _tool_protein_compile(self, arguments: dict[str, Any]) -> dict[str, Any]:
        path = self.paths.workspace_file(_required_string(arguments, "path"), extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
        out = arguments.get("out") or str(Path("build") / "mcp" / f"{path.stem}.protein.ir.json")
        ir, diagnostics = compile_protein_selection(path)
        if ir is None:
            return _diagnostics_payload(False, diagnostics, [])
        output_path = self.paths.build_file(out, extensions={".json"})
        write_text_bounded(output_path, json.dumps(ir, indent=2) + "\n", boundary=self.paths.build)
        proteins = ir.get("proteins", [])
        return {
            "ok": True,
            "diagnostics": [item.to_dict() for item in diagnostics],
            "artifacts": [output_path.relative_to(self.paths.workspace).as_posix()],
            "domain": "protein",
            "design_id": ir.get("design_id"),
            "protein_count": len(proteins) if isinstance(proteins, list) else 0,
            "residue_count": sum(len(str(item.get("sequence", ""))) for item in proteins if isinstance(item, dict)) if isinstance(proteins, list) else 0,
            "selection_digest": ir.get("provenance", {}).get("selection_digest"),
        }

    def _tool_export(self, arguments: dict[str, Any]) -> dict[str, Any]:
        ir_path = self.paths.workspace_file(_required_string(arguments, "ir_path"), extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
        output_format = _required_string(arguments, "format")
        out = _required_string(arguments, "out")
        ir = load_ir(ir_path)
        extension = {"sbol": ".ttl", "genbank": ".gb", "fasta": ".fasta"}[output_format]
        output_path = self.paths.build_file(out, extensions={extension})
        write_text_bounded(output_path, export_ir(ir, output_format), boundary=self.paths.build)
        return {
            "ok": True,
            "diagnostics": [],
            "artifacts": [output_path.relative_to(self.paths.workspace).as_posix()],
        }

    def _tool_validate_sbol(self, arguments: dict[str, Any]) -> dict[str, Any]:
        path = self.paths.workspace_file(_required_string(arguments, "path"), extensions={".ttl"}, max_bytes=MAX_TEXT_FILE_BYTES)
        return validate_sbol_turtle(path)

    def _tool_score(self, arguments: dict[str, Any]) -> dict[str, Any]:
        path = self.paths.workspace_file(_required_string(arguments, "path"), extensions={".proto"}, max_bytes=MAX_TEXT_FILE_BYTES)
        parts_path = self.paths.workspace_file(arguments.get("parts_path", str(DEFAULT_PARTS_PATH)), extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
        score, diagnostics = score_design(path, parts_path)
        return {**score, "diagnostics": [item.to_dict() for item in diagnostics]}

    def _tool_validate_sequences(self, arguments: dict[str, Any]) -> dict[str, Any]:
        path = self.paths.workspace_file(_required_string(arguments, "path"), extensions={".proto"}, max_bytes=MAX_TEXT_FILE_BYTES)
        parts_path = self.paths.workspace_file(arguments.get("parts_path", str(DEFAULT_PARTS_PATH)), extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
        report, diagnostics = validate_sequences(path, parts_path)
        return {**report, "diagnostics": [item.to_dict() for item in diagnostics]}

    def _tool_optimize_sequences(self, arguments: dict[str, Any]) -> dict[str, Any]:
        path = self.paths.workspace_file(_required_string(arguments, "path"), extensions={".proto"}, max_bytes=MAX_TEXT_FILE_BYTES)
        parts_path = self.paths.workspace_file(arguments.get("parts_path", str(DEFAULT_PARTS_PATH)), extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
        backend = arguments.get("backend", "auto")
        payload, _code = optimize_design(path, parts_path, backend)
        return payload

    def _tool_search_parts(self, arguments: dict[str, Any]) -> dict[str, Any]:
        query = _required_string(arguments, "query")
        chassis = arguments.get("chassis")
        parts_path = self.paths.workspace_file(arguments.get("parts_path", str(DEFAULT_PARTS_PATH)), extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
        return {"ok": True, "matches": search_parts(query, chassis, parts_path)}

    def _materials_store(self) -> MaterialsStore:
        # MaterialsStore resolves the project-sibling external root from the
        # active workspace. MCP never accepts an arbitrary materials path.
        return MaterialsStore(workspace=self.paths.workspace)

    def _active_materials_store(self, arguments: dict[str, Any]) -> tuple[MaterialsStore, str]:
        """Resolve the model-visible store without permitting snapshot bypasses.

        MCP callers may optionally repeat the active snapshot ID as a
        reproducibility assertion, but they cannot select an inactive or
        historical snapshot.  Activation is the human-controlled visibility
        boundary; accepting an arbitrary snapshot here would make that
        boundary ineffective for every model-facing materials tool.
        """

        store = self._materials_store()
        active_snapshot = store._active_id()
        if not active_snapshot:
            raise MaterialsError("NO_ACTIVE_SNAPSHOT", "No materials snapshot is active.")
        requested_snapshot = arguments.get("snapshot")
        if requested_snapshot is not None:
            if not isinstance(requested_snapshot, str) or requested_snapshot != active_snapshot:
                raise MaterialsError(
                    "MATERIALS_SNAPSHOT_NOT_ACTIVE",
                    "Model-facing materials tools may only access the currently active snapshot.",
                )
        manifest = store.manifest(active_snapshot)
        store._verify_snapshot(active_snapshot, manifest)
        if store._active_id() != active_snapshot:
            raise MaterialsError(
                "ACTIVE_POINTER_CHANGED",
                "The active materials snapshot changed while its contents were being verified.",
            )
        return store, active_snapshot

    def _tool_materials_search(self, arguments: dict[str, Any]) -> dict[str, Any]:
        limit = min(int(arguments.get("limit", 20)), MAX_MCP_RESULT_LIMIT)
        store, active_snapshot = self._active_materials_store(arguments)
        payload = store.search(
            str(arguments.get("query", "")),
            kind=arguments.get("kind"),
            organism=arguments.get("organism"),
            role=arguments.get("role"),
            source=arguments.get("source"),
            license_id=arguments.get("license_id"),
            status="DESIGN_ELIGIBLE",
            limit=limit,
            cursor=arguments.get("cursor"),
            snapshot_id=active_snapshot,
            auto_initialize=False,
        )
        # Metadata is source-derived and untrusted.  Keep the model-facing
        # search contract to bounded catalogue fields so an upstream record
        # cannot smuggle a sequence, prompt, or protocol through an opaque
        # metadata field.
        for match in payload.get("matches", []):
            if isinstance(match, dict):
                match.pop("metadata", None)
        return payload

    def _tool_materials_get(self, arguments: dict[str, Any]) -> dict[str, Any]:
        resource_id = _required_string(arguments, "resource_id")
        store, active_snapshot = self._active_materials_store(arguments)
        payload = store.get(
            resource_id,
            include_sequence=bool(arguments.get("include_sequence", False)),
            snapshot_id=active_snapshot,
            auto_initialize=False,
        )
        resource = payload.get("resource")
        if not isinstance(resource, dict) or resource.get("review_status") != "DESIGN_ELIGIBLE" or not resource.get("design_eligibility"):
            raise MaterialsError("MATERIAL_NOT_MODEL_VISIBLE", "Only DESIGN_ELIGIBLE materials are available through MCP.")
        if isinstance(resource, dict):
            # Template slot metadata is consumed by the local renderer, not
            # needed by the model-facing record view.  This also keeps opaque
            # source metadata out of MCP responses.
            resource.pop("metadata", None)
        return payload

    def _tool_materials_facets(self, arguments: dict[str, Any]) -> dict[str, Any]:
        store, active_snapshot = self._active_materials_store(arguments)
        return store.facets(snapshot_id=active_snapshot, status="DESIGN_ELIGIBLE", auto_initialize=False)

    def _tool_materials_materialize(self, arguments: dict[str, Any]) -> dict[str, Any]:
        resource_ids = arguments.get("resource_ids")
        if not isinstance(resource_ids, list) or not resource_ids or len(resource_ids) > MAX_MATERIALIZED_PARTS or not all(isinstance(item, str) for item in resource_ids):
            raise MaterialsError("INVALID_SELECTION", f"MCP materialization accepts 1-{MAX_MATERIALIZED_PARTS} resource IDs.")
        store, active_snapshot = self._active_materials_store(arguments)
        return store.materialize_parts(
            list(resource_ids),
            _required_string(arguments, "chassis"),
            output=arguments.get("out"),
            snapshot_id=active_snapshot,
            auto_initialize=False,
            require_active=True,
        )

    def _tool_materials_materialize_proteins(self, arguments: dict[str, Any]) -> dict[str, Any]:
        resource_ids = arguments.get("resource_ids")
        if not isinstance(resource_ids, list) or not resource_ids or len(resource_ids) > 50 or not all(isinstance(item, str) for item in resource_ids):
            raise MaterialsError("INVALID_SELECTION", "MCP protein materialization accepts 1-50 resource IDs.")
        store, active_snapshot = self._active_materials_store(arguments)
        return store.materialize_proteins(
            list(resource_ids),
            design_id=arguments.get("design_id"),
            output=arguments.get("out"),
            snapshot_id=active_snapshot,
            auto_initialize=False,
            require_active=True,
        )

    def _tool_workflow_run(self, arguments: dict[str, Any]) -> dict[str, Any]:
        path = self.paths.workspace_file(_required_string(arguments, "path"), extensions={".proto"}, max_bytes=MAX_TEXT_FILE_BYTES)
        parts_path = self.paths.workspace_file(arguments.get("parts_path", str(DEFAULT_PARTS_PATH)), extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
        workflow_path = self.paths.workspace_file(arguments.get("workflow_path", str(DEFAULT_WORKFLOW_PATH)), extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
        out_dir_value = arguments.get("out_dir", str(Path("build") / "runs"))
        self.paths.build_directory(out_dir_value)
        manifest, _code = run_design_review(
            path.relative_to(self.paths.workspace),
            parts_path.relative_to(self.paths.workspace),
            workflow_path.relative_to(self.paths.workspace),
            out_dir=out_dir_value,
            workspace_root=self.paths.workspace,
        )
        return {
            "ok": manifest["ok"],
            "run_id": manifest["run_id"],
            "manifest_path": manifest["manifest_path"],
            "provenance_path": manifest["provenance_path"],
            "review_status": manifest["review_status"],
            "summary": manifest["summary"],
            "artifacts": manifest["artifacts"],
            "diagnostics": manifest["diagnostics"],
            "metrics": manifest["metrics"],
        }

    def _tool_review_packet(self, arguments: dict[str, Any]) -> dict[str, Any]:
        path = self.paths.workspace_file(_required_string(arguments, "path"), extensions={".proto"}, max_bytes=MAX_TEXT_FILE_BYTES)
        parts_path = self.paths.workspace_file(arguments.get("parts_path", str(DEFAULT_PARTS_PATH)), extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
        workflow_path = self.paths.workspace_file(arguments.get("workflow_path", str(DEFAULT_WORKFLOW_PATH)), extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
        out_dir_value = arguments.get("out_dir", str(DEFAULT_REVIEW_OUT_DIR))
        self.paths.build_directory(out_dir_value)
        manifest_path = self.paths.build_file(arguments["manifest_path"], extensions={".json"}, must_exist=True) if arguments.get("manifest_path") else None
        literature_registry = self.paths.workspace_file(str(DEFAULT_LITERATURE_PATH), extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
        literature_query = arguments.get("literature_query")
        packet, _code = build_review_packet(
            path.relative_to(self.paths.workspace),
            parts_path=parts_path.relative_to(self.paths.workspace),
            workflow_path=workflow_path.relative_to(self.paths.workspace),
            out_dir=out_dir_value,
            manifest_path=manifest_path.relative_to(self.paths.workspace) if manifest_path else None,
            literature_query=literature_query,
            literature_registry=literature_registry.relative_to(self.paths.workspace),
            workspace_root=self.paths.workspace,
        )
        return packet

    def _tool_provenance_verify(self, arguments: dict[str, Any]) -> dict[str, Any]:
        source = self.paths.build_file(
            _required_string(arguments, "path"),
            extensions={".json"},
            must_exist=True,
        )
        result = verify_provenance(
            source,
            workspace_root=self.paths.workspace,
            build_root=self.paths.build,
        )
        result["provenance_path"] = source.relative_to(self.paths.workspace).as_posix()
        return result

    def _tool_connectors_check(self, arguments: dict[str, Any]) -> dict[str, Any]:
        registry = self.paths.workspace_file(arguments.get("registry", "connectors/proto_workbench.json"), extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
        return connector_summary(
            registry.relative_to(self.paths.workspace),
            workspace_root=self.paths.workspace,
        )

    def _tool_skills_list(self, arguments: dict[str, Any]) -> dict[str, Any]:
        return list_skill_adapters(
            arguments.get("root", str(DEFAULT_SKILLS_ROOT)),
            arguments.get("registry", "connectors/proto_workbench.json"),
            workspace_root=self.paths.workspace,
        )

    def _tool_skills_resolve(self, arguments: dict[str, Any]) -> dict[str, Any]:
        return resolve_skill_adapter(
            _required_string(arguments, "skill_id"),
            arguments.get("root", str(DEFAULT_SKILLS_ROOT)),
            arguments.get("registry", "connectors/proto_workbench.json"),
            workspace_root=self.paths.workspace,
        )

    def _tool_literature_search(self, arguments: dict[str, Any]) -> dict[str, Any]:
        query = _required_string(arguments, "query")
        registry = self.paths.workspace_file(arguments.get("registry", str(DEFAULT_LITERATURE_PATH)), extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
        limit = int(arguments.get("limit", 10))
        return public_workspace_payload(
            search_literature(query, registry, limit),
            self.paths.workspace,
        )

    def _tool_pubmed_search(self, arguments: dict[str, Any]) -> dict[str, Any]:
        query = _required_string(arguments, "query")
        retmax = int(arguments.get("retmax", 5))
        cache_dir = self.paths.cache_directory(str(DEFAULT_PUBMED_CACHE_DIR))
        offline = bool(arguments.get("offline", True))
        fixture = self.paths.fixture_file(arguments["fixture"], extensions={".json"}) if arguments.get("fixture") else None
        cafile = ""
        network_allowed = self._network_allowed("proto_pubmed_search", arguments, offline, fixture)
        return public_workspace_payload(
            search_pubmed(query, retmax, cache_dir, network_allowed, fixture, cafile),
            self.paths.workspace,
        )

    def _tool_europe_pmc_search(self, arguments: dict[str, Any]) -> dict[str, Any]:
        query, limit, cache_dir, offline, fixture, cafile = self._external_search_arguments(arguments, {".json"})
        network_allowed = self._network_allowed("proto_europe_pmc_search", arguments, offline, fixture)
        return public_workspace_payload(
            search_europe_pmc(query, limit, cache_dir, network_allowed, fixture, cafile),
            self.paths.workspace,
        )

    def _tool_crossref_search(self, arguments: dict[str, Any]) -> dict[str, Any]:
        query, limit, cache_dir, offline, fixture, cafile = self._external_search_arguments(arguments, {".json"})
        network_allowed = self._network_allowed("proto_crossref_search", arguments, offline, fixture)
        return public_workspace_payload(
            search_crossref(query, limit, cache_dir, network_allowed, fixture, cafile),
            self.paths.workspace,
        )

    def _tool_uniprot_search(self, arguments: dict[str, Any]) -> dict[str, Any]:
        query, limit, cache_dir, offline, fixture, cafile = self._external_search_arguments(arguments, {".json"})
        organism_id = arguments.get("organism_id")
        network_allowed = self._network_allowed("proto_uniprot_search", arguments, offline, fixture)
        return public_workspace_payload(
            search_uniprot(
                query,
                limit,
                int(organism_id) if organism_id is not None else None,
                bool(arguments.get("reviewed_only", True)),
                cache_dir,
                network_allowed,
                fixture,
                cafile,
            ),
            self.paths.workspace,
        )

    def _tool_rhea_search(self, arguments: dict[str, Any]) -> dict[str, Any]:
        query, limit, cache_dir, offline, fixture, cafile = self._external_search_arguments(arguments, {".tsv"})
        network_allowed = self._network_allowed("proto_rhea_search", arguments, offline, fixture)
        return public_workspace_payload(
            search_rhea(query, limit, cache_dir, network_allowed, fixture, cafile),
            self.paths.workspace,
        )

    def _tool_run_analysis(self, arguments: dict[str, Any]) -> dict[str, Any]:
        script = _required_string(arguments, "script")
        args = arguments.get("args") or []
        if not isinstance(args, list) or not all(isinstance(item, str) for item in args):
            raise ValueError("Analysis args must be a list of strings.")
        out_dir = arguments.get("out_dir", str(DEFAULT_ANALYSIS_OUT_DIR))
        timeout = int(arguments.get("timeout", 60))
        manifest, _code = run_python_analysis(
            script,
            args,
            out_dir,
            timeout,
            broker=self.execution_broker,
            workspace_root=self.paths.workspace,
            cancel_event=getattr(self._request_context, "cancel_event", None),
        )
        return manifest

    def _tool_run_notebook(self, arguments: dict[str, Any]) -> dict[str, Any]:
        path = _required_string(arguments, "path")
        out_dir = arguments.get("out_dir", str(DEFAULT_NOTEBOOK_OUT_DIR))
        timeout = int(arguments.get("timeout", 120))
        manifest, _code = run_notebook(
            path,
            out_dir,
            timeout,
            broker=self.execution_broker,
            workspace_root=self.paths.workspace,
            cancel_event=getattr(self._request_context, "cancel_event", None),
        )
        return manifest

    def _tool_r_status(self, arguments: dict[str, Any]) -> dict[str, Any]:
        return r_status()

    def _tool_run_r(self, arguments: dict[str, Any]) -> dict[str, Any]:
        script = _required_string(arguments, "script")
        args = arguments.get("args") or []
        if not isinstance(args, list) or not all(isinstance(item, str) for item in args):
            raise ValueError("R args must be a list of strings.")
        out_dir = arguments.get("out_dir", str(DEFAULT_R_OUT_DIR))
        timeout = int(arguments.get("timeout", 120))
        manifest, _code = run_r_script(
            script,
            args,
            out_dir,
            timeout,
            broker=self.execution_broker,
            workspace_root=self.paths.workspace,
            cancel_event=getattr(self._request_context, "cancel_event", None),
        )
        return manifest

    def _external_search_arguments(
        self,
        arguments: dict[str, Any],
        fixture_extensions: set[str],
    ) -> tuple[str, int, Path, bool, Path | None, Path | str]:
        fixture = self.paths.fixture_file(arguments["fixture"], extensions=fixture_extensions) if arguments.get("fixture") else None
        cafile: Path | str = ""
        return (
            _required_string(arguments, "query"),
            int(arguments.get("limit", 5)),
            self.paths.cache_directory(str(DEFAULT_EVIDENCE_CACHE_DIR)),
            bool(arguments.get("offline", True)),
            fixture,
            cafile,
        )

    def _network_allowed(
        self,
        tool: str,
        arguments: dict[str, Any],
        offline: bool,
        fixture: Path | None,
    ) -> bool:
        if offline or fixture is not None:
            return False
        self._consume_network_capability(
            tool,
            arguments,
            getattr(self._request_context, "network_capability", None),
        )
        return True

    def _consume_network_capability(
        self,
        tool: str,
        arguments: dict[str, Any],
        capability: Any,
    ) -> None:
        if tool not in NETWORK_TOOLS or self._network_capability_key is None:
            raise NetworkCapabilityError("Live MCP network access requires a host-issued per-call capability.")
        if not isinstance(capability, dict):
            raise NetworkCapabilityError("Live MCP network access requires a host-issued per-call capability.")

        required = {
            "version",
            "tool",
            "argumentsSha256",
            "runId",
            "approvalId",
            "issuedAtMs",
            "expiresAtMs",
            "nonce",
            "mac",
        }
        if set(capability) != required:
            raise NetworkCapabilityError("Network capability fields are invalid.")
        unsigned = {key: capability[key] for key in required if key != "mac"}
        now_ms = int(time.time() * 1000)
        issued_at = capability.get("issuedAtMs")
        expires_at = capability.get("expiresAtMs")
        if (
            capability.get("version") != NETWORK_CAPABILITY_VERSION
            or capability.get("tool") != tool
            or isinstance(issued_at, bool)
            or not isinstance(issued_at, int)
            or isinstance(expires_at, bool)
            or not isinstance(expires_at, int)
            or issued_at > now_ms + NETWORK_CAPABILITY_CLOCK_SKEW_MS
            or expires_at <= now_ms
            or expires_at - issued_at > NETWORK_CAPABILITY_MAX_TTL_MS
            or expires_at <= issued_at
        ):
            raise NetworkCapabilityError("Network capability is expired or not bound to this tool.")
        for field in ("runId", "approvalId"):
            value = capability.get(field)
            if not isinstance(value, str) or not 1 <= len(value) <= 128:
                raise NetworkCapabilityError("Network capability approval binding is invalid.")
        nonce = capability.get("nonce")
        mac = capability.get("mac")
        argument_digest = capability.get("argumentsSha256")
        if (
            not isinstance(nonce, str)
            or len(nonce) != 32
            or any(character not in "0123456789abcdefABCDEF" for character in nonce)
            or not isinstance(mac, str)
            or len(mac) != 64
            or not isinstance(argument_digest, str)
            or len(argument_digest) != 64
        ):
            raise NetworkCapabilityError("Network capability cryptographic fields are invalid.")

        expected_argument_digest = hashlib.sha256(_stable_json_bytes(arguments)).hexdigest()
        expected_mac = hmac.new(
            self._network_capability_key,
            _stable_json_bytes(unsigned),
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(argument_digest, expected_argument_digest) or not hmac.compare_digest(mac, expected_mac):
            raise NetworkCapabilityError("Network capability does not match the approved arguments.")

        with self._network_nonce_lock:
            expired = [value for value, expiry in self._consumed_network_nonces.items() if expiry <= now_ms]
            for value in expired:
                self._consumed_network_nonces.pop(value, None)
            if nonce in self._consumed_network_nonces:
                raise NetworkCapabilityError("Network capability has already been consumed.")
            if len(self._consumed_network_nonces) >= MAX_CONSUMED_NETWORK_NONCES:
                raise NetworkCapabilityError("Network capability replay cache is full.")
            self._consumed_network_nonces[nonce] = expires_at


def _validate_rpc_message(message: Any) -> None:
    validate_json_shape(message)
    if not isinstance(message, dict):
        raise JsonValidationError("JSON-RPC request must be an object.")
    unknown = set(message) - {"jsonrpc", "id", "method", "params"}
    if unknown:
        raise JsonValidationError(f"JSON-RPC request contains unknown fields: {', '.join(sorted(unknown))}.")
    if message.get("jsonrpc") != "2.0":
        raise JsonValidationError("jsonrpc must be exactly '2.0'.")
    method = message.get("method")
    if not isinstance(method, str) or not 1 <= len(method) <= 128 or "\x00" in method:
        raise JsonValidationError("JSON-RPC method must be a non-empty string of at most 128 characters.")
    if "id" in message:
        request_id = message["id"]
        if isinstance(request_id, bool) or not isinstance(request_id, (str, int)):
            raise JsonValidationError("JSON-RPC id must be a string or 64-bit integer.")
        if isinstance(request_id, str) and (not request_id or len(request_id) > 128):
            raise JsonValidationError("JSON-RPC string id must contain 1 to 128 characters.")
        if isinstance(request_id, int) and not -(2**63) <= request_id <= 2**63 - 1:
            raise JsonValidationError("JSON-RPC integer id exceeds the 64-bit range.")
    is_notification = method.startswith("notifications/")
    if is_notification and "id" in message:
        raise JsonValidationError("JSON-RPC notifications must not contain an id.")
    if not is_notification and "id" not in message:
        raise JsonValidationError("JSON-RPC requests must contain an id.")

    params = message.get("params", {})
    if not isinstance(params, dict):
        raise JsonValidationError("JSON-RPC params must be an object.")
    if method == "initialize":
        validate_json_schema(params, _INITIALIZE_PARAMS_SCHEMA, path="$.params")
    elif method == "tools/list":
        validate_json_schema(params, _TOOLS_LIST_PARAMS_SCHEMA, path="$.params")
    elif method == "tools/call":
        validate_json_schema(params, _TOOLS_CALL_PARAMS_SCHEMA, path="$.params")
    elif method in {"notifications/initialized", "proto/roots", "proto/capabilities"}:
        validate_json_schema(params, _EMPTY_PARAMS_SCHEMA, path="$.params")
    elif method == "notifications/cancelled":
        validate_json_schema(params, _CANCEL_PARAMS_SCHEMA, path="$.params")
        cancelled_id = params["requestId"]
        if isinstance(cancelled_id, bool) or not isinstance(cancelled_id, (str, int)):
            raise JsonValidationError("$.params.requestId must be a string or 64-bit integer.")
        if isinstance(cancelled_id, str) and (not cancelled_id or len(cancelled_id) > 128):
            raise JsonValidationError("$.params.requestId string length is invalid.")
        if isinstance(cancelled_id, int) and not -(2**63) <= cancelled_id <= 2**63 - 1:
            raise JsonValidationError("$.params.requestId exceeds the 64-bit range.")


def _safe_request_id(message: Any) -> str | int | None:
    if not isinstance(message, dict):
        return None
    request_id = message.get("id")
    if isinstance(request_id, bool) or not isinstance(request_id, (str, int)):
        return None
    if isinstance(request_id, str) and (not request_id or len(request_id) > 128):
        return None
    if isinstance(request_id, int) and not -(2**63) <= request_id <= 2**63 - 1:
        return None
    return request_id


_EMPTY_PARAMS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {},
    "additionalProperties": False,
    "maxProperties": 0,
}

_INITIALIZE_PARAMS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "protocolVersion": {"type": "string", "minLength": 1, "maxLength": 32},
        "capabilities": {
            "type": "object",
            "properties": {
                "roots": {
                    "type": "object",
                    "properties": {"listChanged": {"type": "boolean"}},
                    "additionalProperties": False,
                    "maxProperties": 1,
                },
                "sampling": {"type": "object", "properties": {}, "additionalProperties": False, "maxProperties": 0},
                "elicitation": {"type": "object", "properties": {}, "additionalProperties": False, "maxProperties": 0},
                "experimental": {"type": "object", "properties": {}, "additionalProperties": False, "maxProperties": 0},
            },
            "additionalProperties": False,
            "maxProperties": 4,
        },
        "clientInfo": {
            "type": "object",
            "required": ["name", "version"],
            "properties": {
                "name": {"type": "string", "minLength": 1, "maxLength": 128},
                "version": {"type": "string", "minLength": 1, "maxLength": 64},
            },
            "additionalProperties": False,
            "maxProperties": 2,
        },
    },
    "additionalProperties": False,
    "maxProperties": 3,
}

_TOOLS_LIST_PARAMS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"cursor": {"type": "string", "minLength": 1, "maxLength": 256}},
    "additionalProperties": False,
    "maxProperties": 1,
}

_TOOLS_CALL_PARAMS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["name"],
    "properties": {
        "name": {"type": "string", "minLength": 1, "maxLength": 128},
        "arguments": {"type": "object", "properties": {}, "additionalProperties": True, "maxProperties": 64},
        "capability": {
            "type": "object",
            "required": [
                "version", "tool", "argumentsSha256", "runId", "approvalId",
                "issuedAtMs", "expiresAtMs", "nonce", "mac",
            ],
            "properties": {
                "version": {"type": "string", "minLength": 1, "maxLength": 64},
                "tool": {"type": "string", "minLength": 1, "maxLength": 128},
                "argumentsSha256": {"type": "string", "minLength": 64, "maxLength": 64},
                "runId": {"type": "string", "minLength": 1, "maxLength": 128},
                "approvalId": {"type": "string", "minLength": 1, "maxLength": 128},
                "issuedAtMs": {"type": "integer"},
                "expiresAtMs": {"type": "integer"},
                "nonce": {"type": "string", "minLength": 32, "maxLength": 32},
                "mac": {"type": "string", "minLength": 64, "maxLength": 64},
            },
            "additionalProperties": False,
            "maxProperties": 9,
        },
    },
    "additionalProperties": False,
    "maxProperties": 3,
}

_CANCEL_PARAMS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["requestId"],
    "properties": {
        "requestId": {},
        "reason": {"type": "string", "maxLength": 512},
    },
    "additionalProperties": False,
    "maxProperties": 2,
}


def _required_string(arguments: dict[str, Any], key: str) -> str:
    value = arguments.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"Missing required string argument: {key}")
    return value


def _network_capability_key_from_environment() -> bytes | None:
    encoded = os.environ.get("PROTO_WORKBENCH_WORKSPACE_CAPABILITY", "").strip()
    if len(encoded) != 64:
        return None
    try:
        key = bytes.fromhex(encoded)
    except ValueError:
        return None
    return key if len(key) == 32 else None


def _stable_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def _diagnostics_payload(ok: bool, diagnostics: list[Diagnostic], artifacts: list[str]) -> dict[str, Any]:
    return {
        "ok": ok,
        "diagnostics": [item.to_dict() for item in diagnostics],
        "artifacts": artifacts,
    }


def _tool_result(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        payload = _internal_tool_error("The tool returned an invalid payload type.")
    try:
        compact_payload = json.dumps(payload, separators=(",", ":"), ensure_ascii=True, allow_nan=False)
    except (TypeError, ValueError, OverflowError, RecursionError):
        payload = _internal_tool_error("The tool returned a value that cannot be serialized safely.")
        compact_payload = json.dumps(payload, separators=(",", ":"), ensure_ascii=True, allow_nan=False)
    candidate = {
        "content": [
            {
                "type": "text",
                "text": compact_payload,
            }
        ],
        "structuredContent": payload,
        "isError": not bool(payload.get("ok", True)),
    }
    if len(json.dumps(candidate, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("utf-8")) <= MAX_TOOL_RESPONSE_BYTES:
        return candidate
    limited = _internal_tool_error("Tool response exceeded the configured byte limit.", code="TOOL_RESPONSE_TOO_LARGE")
    return {
        "content": [{"type": "text", "text": json.dumps(limited, separators=(",", ":"), ensure_ascii=True, allow_nan=False)}],
        "structuredContent": limited,
        "isError": True,
    }


def _internal_tool_error(message: str, *, code: str = "INTERNAL_TOOL_ERROR") -> dict[str, Any]:
    return {
        "ok": False,
        "diagnostics": [
            {
                "severity": "error",
                "file": "",
                "line": 0,
                "code": code,
                "message": message[:MAX_ERROR_MESSAGE_CHARS],
            }
        ],
    }


def _success_response(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _error_response(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {
            "code": code,
            "message": str(message)[:MAX_ERROR_MESSAGE_CHARS],
        },
    }


if __name__ == "__main__":
    raise SystemExit(main())
