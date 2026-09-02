from __future__ import annotations

import argparse
import importlib.util
import json
import platform
import re
import sys
from pathlib import Path
from typing import Any

from .analysis import DEFAULT_ANALYSIS_OUT_DIR, run_python_analysis
from .compiler import compile_design, validate_design
from .connectors import DEFAULT_CONNECTORS_PATH, connector_summary
from .exporters import export_ir, load_ir
from .literature import DEFAULT_LITERATURE_PATH, DEFAULT_PUBMED_CACHE_DIR, search_literature, search_pubmed
from .materials import MAX_RESULT_LIMIT, MaterialsStore
from .models import Diagnostic
from .notebook import DEFAULT_NOTEBOOK_OUT_DIR, run_notebook
from .optimization import optimize_design
from .parser import parse_design
from .parts import DEFAULT_PARTS_PATH, search_parts
from .protein import compile_protein_selection
from .provenance import compare_provenance, create_provenance, verify_provenance
from .r_runtime import DEFAULT_R_OUT_DIR, r_status, run_r_script
from .review import DEFAULT_REVIEW_OUT_DIR, build_review_packet
from .scoring import score_design
from .sequence import validate_sequences
from .sbol import validate_sbol_turtle
from .stress import DEFAULT_SEED, run_stress
from .workflow import DEFAULT_WORKFLOW_PATH, run_design_review
from .mcp_server import TOOLS, main as mcp_main
from .execution import ExecutionBroker, ExecutionDenied
from .security import (
    MAX_JSON_FILE_BYTES,
    MAX_TEXT_FILE_BYTES,
    SecurityBoundaryError,
    WorkspacePaths,
    public_workspace_payload,
    read_json_bounded,
    write_text_bounded,
)


def _add_execution_flags(command_parser: argparse.ArgumentParser) -> None:
    command_parser.add_argument(
        "--unsafe-host-execution",
        action="store_true",
        help="Explicitly run this one CLI workload on the host without a sandbox.",
    )
    command_parser.add_argument("--sandbox-provider", choices=["docker", "podman"])
    command_parser.add_argument("--sandbox-image", help="Digest-pinned OCI image (name@sha256:<digest>).")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="proto-agent")
    parser.add_argument("--parts", default=str(DEFAULT_PARTS_PATH), help="Path to JSON parts library.")
    parser.add_argument("--materials-root", help="External materials catalog root (defaults to the project sibling).")
    subparsers = parser.add_subparsers(dest="command", required=True)

    check_parser = subparsers.add_parser("check", help="Validate a Proto-like design file.")
    check_parser.add_argument("path")
    check_parser.add_argument("--json", action="store_true", dest="as_json")

    compile_parser = subparsers.add_parser("compile", help="Compile a design file to JSON IR.")
    compile_parser.add_argument("path")
    compile_parser.add_argument("--out", required=True)

    protein_parser = subparsers.add_parser("protein", help="Protein sequence design-domain commands.")
    protein_subparsers = protein_parser.add_subparsers(dest="protein_command", required=True)
    protein_compile = protein_subparsers.add_parser("compile", help="Compile a materialized protein selection to JSON IR.")
    protein_compile.add_argument("path")
    protein_compile.add_argument("--out", required=True)
    protein_validate = protein_subparsers.add_parser("validate", help="Validate a materialized protein selection without writing IR.")
    protein_validate.add_argument("path")
    protein_validate.add_argument("--json", action="store_true", dest="as_json")

    export_parser = subparsers.add_parser("export", help="Export JSON IR to an exchange artifact.")
    export_parser.add_argument("ir_path")
    export_parser.add_argument("--format", choices=["sbol", "genbank", "fasta"], required=True)
    export_parser.add_argument("--out", required=True)

    score_parser = subparsers.add_parser("score", help="Score a design with toy local checks.")
    score_parser.add_argument("path")
    score_parser.add_argument("--json", action="store_true", dest="as_json")

    sequence_parser = subparsers.add_parser("sequence", help="Sequence-level validation commands.")
    sequence_subparsers = sequence_parser.add_subparsers(dest="sequence_command", required=True)
    sequence_validate = sequence_subparsers.add_parser("validate", help="Validate assembled construct sequences against constraints.")
    sequence_validate.add_argument("path")
    sequence_validate.add_argument("--json", action="store_true", dest="as_json")
    sequence_optimize = sequence_subparsers.add_parser("optimize", help="Generate reviewable sequence optimization suggestions.")
    sequence_optimize.add_argument("path")
    sequence_optimize.add_argument("--backend", default="auto", choices=["auto", "local", "dnachisel"])

    sbol_parser = subparsers.add_parser("sbol", help="SBOL exchange-format commands.")
    sbol_subparsers = sbol_parser.add_subparsers(dest="sbol_command", required=True)
    sbol_validate = sbol_subparsers.add_parser("validate", help="Validate a local minimal SBOL Turtle export.")
    sbol_validate.add_argument("path")

    explain_parser = subparsers.add_parser("explain", help="Explain diagnostics JSON.")
    explain_parser.add_argument("diagnostics_path")

    parts_parser = subparsers.add_parser("parts", help="Part library commands.")
    parts_subparsers = parts_parser.add_subparsers(dest="parts_command", required=True)
    search_parser = parts_subparsers.add_parser("search", help="Search the local parts library.")
    search_parser.add_argument("query")
    search_parser.add_argument("--chassis")
    # Keep the legacy explicit-file form ergonomic when it appears after the
    # subcommand (``parts search --parts build/.../parts.json``), while the
    # global ``--parts`` option remains backwards compatible for all commands.
    search_parser.add_argument("--parts", dest="parts_override")

    materials_parser = subparsers.add_parser("materials", help="Versioned biological materials catalog commands.")
    materials_subparsers = materials_parser.add_subparsers(dest="materials_command", required=True)
    materials_status = materials_subparsers.add_parser("status", help="Show external catalog and active snapshot status.")
    materials_status.add_argument("--json", action="store_true", dest="as_json")
    materials_init = materials_subparsers.add_parser("init", help="Create the small built-in seed snapshot.")
    materials_init.add_argument("--no-activate", action="store_true")
    materials_search = materials_subparsers.add_parser("search", help="Search the active materials catalog.")
    materials_search.add_argument("query", nargs="?", default="")
    materials_search.add_argument("--kind")
    materials_search.add_argument("--organism")
    materials_search.add_argument("--role")
    materials_search.add_argument("--source")
    materials_search.add_argument("--license-id")
    materials_search.add_argument("--status", default="DESIGN_ELIGIBLE")
    materials_search.add_argument("--limit", type=int, default=20)
    materials_search.add_argument("--cursor")
    materials_search.add_argument("--include-quarantine", action="store_true")
    materials_search.add_argument("--snapshot")
    materials_get = materials_subparsers.add_parser("get", aliases=["show"], help="Get one material record with provenance and license metadata.")
    materials_get.add_argument("resource_id")
    materials_get.add_argument("--include-sequence", action="store_true")
    materials_get.add_argument("--include-quarantine", action="store_true")
    materials_get.add_argument("--snapshot")
    materials_facets = materials_subparsers.add_parser("facets", help="List bounded catalog facet counts.")
    materials_facets.add_argument("--include-quarantine", action="store_true")
    materials_facets.add_argument("--status", default="ALL")
    materials_facets.add_argument("--snapshot")
    materials_diff = materials_subparsers.add_parser("diff", help="Compare two immutable snapshots.")
    materials_diff.add_argument("left")
    materials_diff.add_argument("right")
    materials_activate = materials_subparsers.add_parser("activate", help="Activate a verified immutable snapshot.")
    materials_activate.add_argument("snapshot_id")
    materials_rollback = materials_subparsers.add_parser("rollback", help="Roll back to a previously verified snapshot.")
    materials_rollback.add_argument("snapshot_id")
    materials_import = materials_subparsers.add_parser("import", help="Stage a local JSON, FASTA, SBOL Turtle, or GenBank resource file.")
    materials_import.add_argument("path")
    materials_import.add_argument("--activate", action="store_true")
    materials_sync = materials_subparsers.add_parser("sync", help="Fetch a pinned source into a new staging snapshot.")
    materials_sync.add_argument("source", choices=["uniprot", "igem", "rhea", "biomodels"])
    materials_sync.add_argument("--max-records", type=int, default=100_000)
    materials_sync.add_argument("--page-size", type=int, default=500)
    materials_sync.add_argument("--activate", action="store_true")
    materials_materialize = materials_subparsers.add_parser("materialize", help="Materialize eligible genetic parts into a bounded parts snapshot.")
    materials_materialize.add_argument("chassis")
    materials_materialize.add_argument("resource_ids", nargs="+")
    materials_materialize.add_argument("--out")
    materials_materialize.add_argument("--snapshot")
    materials_materialize_proteins = materials_subparsers.add_parser("materialize-proteins", help="Materialize explicitly design-eligible protein sequences into a bounded protein selection.")
    materials_materialize_proteins.add_argument("resource_ids", nargs="+")
    materials_materialize_proteins.add_argument("--design-id")
    materials_materialize_proteins.add_argument("--out")
    materials_materialize_proteins.add_argument("--snapshot")
    materials_template = materials_subparsers.add_parser("render-template", help="Render a software-only design template into build/.")
    materials_template.add_argument("template_id")
    materials_template.add_argument("--chassis", required=True, help="Explicit software chassis label for the generated draft.")
    materials_template.add_argument("--bind", action="append", default=[], help="Bind slotN=resource_id; repeat for each slot.")
    materials_template.add_argument("--out")
    materials_template.add_argument("--snapshot")
    materials_review = materials_subparsers.add_parser("review", help="Save a versioned human description-review overlay without changing source rows.")
    materials_review.add_argument("resource_id")
    materials_review.add_argument("--decision", choices=["accept", "reject", "hold"], required=True)
    materials_review.add_argument("--description-en")
    materials_review.add_argument("--description-zh")
    materials_review.add_argument("--reviewer", default="human")
    materials_review.add_argument("--snapshot")
    materials_review.add_argument("--include-quarantine", action="store_true")

    literature_parser = subparsers.add_parser("literature", help="Local literature/source registry commands.")
    literature_parser.add_argument("--registry", default=str(DEFAULT_LITERATURE_PATH))
    literature_subparsers = literature_parser.add_subparsers(dest="literature_command", required=True)
    literature_search = literature_subparsers.add_parser("search", help="Search local source notes.")
    literature_search.add_argument("query")
    literature_search.add_argument("--limit", type=int, default=10)
    pubmed_search = literature_subparsers.add_parser("pubmed", help="Search PubMed through NCBI E-utilities with local cache.")
    pubmed_search.add_argument("query")
    pubmed_search.add_argument("--retmax", type=int, default=5)
    pubmed_search.add_argument("--cache-dir", default=str(DEFAULT_PUBMED_CACHE_DIR))
    pubmed_search.add_argument("--offline", action="store_true", help="Use cache/fixture only; do not call NCBI.")
    pubmed_search.add_argument("--fixture", help="Load a normalized PubMed fixture payload, useful for tests.")
    pubmed_search.add_argument("--cafile", help="Workspace-relative .pem/.crt/.cer CA bundle for this CLI request.")

    doctor_parser = subparsers.add_parser("doctor", help="Report local security/runtime configuration without executing workloads.")
    doctor_parser.add_argument("--json", action="store_true", dest="as_json")

    capabilities_parser = subparsers.add_parser("capabilities", help="Report bounded local capabilities.")
    capabilities_parser.add_argument("--json", action="store_true", dest="as_json")

    sandbox_parser = subparsers.add_parser("sandbox", help="Inspect execution sandbox configuration.")
    sandbox_subparsers = sandbox_parser.add_subparsers(dest="sandbox_command", required=True)
    sandbox_status = sandbox_subparsers.add_parser("status", help="Report configured and visible sandbox providers.")
    sandbox_status.add_argument("--json", action="store_true", dest="as_json")
    sandbox_status.add_argument("--provider", choices=["docker", "podman"])
    sandbox_status.add_argument("--image")
    sandbox_status.add_argument("--unsafe-host-execution", action="store_true")

    provenance_parser = subparsers.add_parser("provenance", help="Create, verify, and compare bounded provenance statements.")
    provenance_subparsers = provenance_parser.add_subparsers(dest="provenance_command", required=True)
    provenance_create = provenance_subparsers.add_parser("create", help="Attest one build manifest and its declared files.")
    provenance_create.add_argument("manifest")
    provenance_create.add_argument("--out")
    provenance_verify = provenance_subparsers.add_parser("verify", help="Recompute every digest in a provenance statement.")
    provenance_verify.add_argument("path")
    provenance_compare = provenance_subparsers.add_parser("compare", help="Compare two provenance statements without executing workloads.")
    provenance_compare.add_argument("left")
    provenance_compare.add_argument("right")

    security_parser = subparsers.add_parser("security", help="Bounded, offline security verification commands.")
    security_subparsers = security_parser.add_subparsers(dest="security_command", required=True)
    security_stress = security_subparsers.add_parser("stress", help="Run the in-process offline parser/path/schema stress harness.")
    security_stress.add_argument("--corpus-dir", default="tests/security_corpus")
    security_stress.add_argument("--report", help="Optional .json path relative to workspace build/.")
    security_stress.add_argument("--seed", type=int, default=DEFAULT_SEED)
    security_stress.add_argument("--max-cases", type=int, default=64)
    security_stress.add_argument("--max-total-seconds", type=float, default=5.0)
    security_stress.add_argument("--max-case-seconds", type=float, default=0.25)
    security_stress.add_argument("--max-input-bytes", type=int, default=64 * 1024)
    security_stress.add_argument("--max-report-bytes", type=int, default=2 * 1024 * 1024)

    connectors_parser = subparsers.add_parser("connectors", help="Workbench connector registry commands.")
    connectors_parser.add_argument("--registry", default=str(DEFAULT_CONNECTORS_PATH))
    connectors_subparsers = connectors_parser.add_subparsers(dest="connectors_command", required=True)
    connectors_subparsers.add_parser("list", help="List declared local and planned connectors.")
    connectors_subparsers.add_parser("check", help="Check connector registry structure and availability summary.")

    analysis_parser = subparsers.add_parser("analysis", help="Run local analysis scripts with an audit manifest.")
    analysis_subparsers = analysis_parser.add_subparsers(dest="analysis_command", required=True)
    analysis_run = analysis_subparsers.add_parser("run", help="Run a Python analysis script in the workspace.")
    analysis_run.add_argument("--out-dir", default=str(DEFAULT_ANALYSIS_OUT_DIR))
    analysis_run.add_argument("--timeout", type=int, default=60)
    _add_execution_flags(analysis_run)
    analysis_run.add_argument("script")
    analysis_run.add_argument("script_args", nargs=argparse.REMAINDER)

    notebook_parser = subparsers.add_parser("notebook", help="Run lightweight local notebook workflows.")
    notebook_subparsers = notebook_parser.add_subparsers(dest="notebook_command", required=True)
    notebook_run = notebook_subparsers.add_parser("run", help="Execute Python code cells from a workspace .ipynb file.")
    notebook_run.add_argument("--out-dir", default=str(DEFAULT_NOTEBOOK_OUT_DIR))
    notebook_run.add_argument("--timeout", type=int, default=120)
    _add_execution_flags(notebook_run)
    notebook_run.add_argument("path")

    r_parser = subparsers.add_parser("r", help="Run optional R runtime workflows.")
    r_subparsers = r_parser.add_subparsers(dest="r_command", required=True)
    r_subparsers.add_parser("status", help="Check whether Rscript is available.")
    r_run = r_subparsers.add_parser("run", help="Run a workspace-local R script if Rscript is available.")
    r_run.add_argument("--out-dir", default=str(DEFAULT_R_OUT_DIR))
    r_run.add_argument("--timeout", type=int, default=120)
    _add_execution_flags(r_run)
    r_run.add_argument("script")
    r_run.add_argument("script_args", nargs=argparse.REMAINDER)

    workflow_parser = subparsers.add_parser("workflow", help="Run local-first scientific design workflows.")
    workflow_parser.add_argument("--workflow", default=str(DEFAULT_WORKFLOW_PATH))
    workflow_parser.add_argument("--out-dir", default=str(Path("build") / "runs"))
    workflow_subparsers = workflow_parser.add_subparsers(dest="workflow_command", required=True)
    run_parser = workflow_subparsers.add_parser("run", help="Run a design review workflow.")
    run_parser.add_argument("path")

    review_parser = subparsers.add_parser("review", help="Build communication-ready design review packets.")
    review_subparsers = review_parser.add_subparsers(dest="review_command", required=True)
    review_run = review_subparsers.add_parser("run", help="Build evidence cards and a review packet for a design.")
    review_run.add_argument("--out-dir", default=str(DEFAULT_REVIEW_OUT_DIR))
    review_run.add_argument("--workflow", default=str(DEFAULT_WORKFLOW_PATH))
    review_run.add_argument("--manifest")
    review_run.add_argument("--literature-query")
    review_run.add_argument("path")

    mcp_parser = subparsers.add_parser("mcp", help="Run the Proto Agent MCP stdio server.")
    mcp_parser.add_argument("--once", help="Handle one JSON-RPC request passed as JSON.")
    mcp_parser.add_argument("--once-file", help="Handle one JSON-RPC request loaded from a file.")

    args = parser.parse_args(argv)

    try:
        return _dispatch(args, parser)
    except (SecurityBoundaryError, ExecutionDenied, ValueError, KeyError, OSError) as exc:
        _print_json(
            {
                "ok": False,
                "diagnostics": [
                    {
                        "severity": "error",
                        "file": "",
                        "line": 0,
                        "code": getattr(exc, "code", "INVALID_INPUT"),
                        "message": str(exc),
                    }
                ],
                "artifacts": [],
            },
            stderr=True,
        )
        return 2
    except Exception:
        _print_json(
            {
                "ok": False,
                "diagnostics": [
                    {
                        "severity": "error",
                        "file": "",
                        "line": 0,
                        "code": "INTERNAL_ERROR",
                        "message": "The command failed without exposing internal details.",
                    }
                ],
                "artifacts": [],
            },
            stderr=True,
        )
        return 2


def _dispatch(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:

    if args.command == "check":
        return _check(args.path, args.parts, args.as_json)
    if args.command == "compile":
        return _compile(args.path, args.parts, args.out)
    if args.command == "protein" and args.protein_command == "compile":
        return _protein_compile(args.path, args.out)
    if args.command == "protein" and args.protein_command == "validate":
        return _protein_validate(args.path, args.as_json)
    if args.command == "export":
        return _export(args.ir_path, args.format, args.out)
    if args.command == "score":
        return _score(args.path, args.parts, args.as_json)
    if args.command == "sequence" and args.sequence_command == "validate":
        return _sequence_validate(args.path, args.parts, args.as_json)
    if args.command == "sequence" and args.sequence_command == "optimize":
        return _sequence_optimize(args.path, args.parts, args.backend)
    if args.command == "sbol" and args.sbol_command == "validate":
        return _sbol_validate(args.path)
    if args.command == "explain":
        return _explain(args.diagnostics_path)
    if args.command == "parts" and args.parts_command == "search":
        return _parts_search(args.query, args.chassis, args.parts_override or args.parts)
    if args.command == "materials":
        return _materials(args)
    if args.command == "literature" and args.literature_command == "search":
        return _literature_search(args.query, args.registry, args.limit)
    if args.command == "literature" and args.literature_command == "pubmed":
        return _pubmed_search(args.query, args.retmax, args.cache_dir, not args.offline, args.fixture, args.cafile)
    if args.command == "doctor":
        return _doctor(args.as_json)
    if args.command == "capabilities":
        return _capabilities(args.as_json)
    if args.command == "sandbox" and args.sandbox_command == "status":
        return _sandbox_status(args.as_json, args.provider, args.image, args.unsafe_host_execution)
    if args.command == "provenance" and args.provenance_command == "create":
        return _provenance_create(args.manifest, args.out)
    if args.command == "provenance" and args.provenance_command == "verify":
        return _provenance_verify(args.path)
    if args.command == "provenance" and args.provenance_command == "compare":
        return _provenance_compare(args.left, args.right)
    if args.command == "security" and args.security_command == "stress":
        return _security_stress(args)
    if args.command == "connectors":
        return _connectors(args.connectors_command, args.registry)
    if args.command == "analysis" and args.analysis_command == "run":
        return _analysis_run(args.script, args.script_args, args.out_dir, args.timeout, _execution_broker(args))
    if args.command == "notebook" and args.notebook_command == "run":
        return _notebook_run(args.path, args.out_dir, args.timeout, _execution_broker(args))
    if args.command == "r" and args.r_command == "status":
        return _r_status()
    if args.command == "r" and args.r_command == "run":
        return _r_run(args.script, args.script_args, args.out_dir, args.timeout, _execution_broker(args))
    if args.command == "workflow" and args.workflow_command == "run":
        return _workflow_run(args.path, args.parts, args.workflow, args.out_dir)
    if args.command == "review" and args.review_command == "run":
        return _review_run(
            args.path,
            args.parts,
            args.workflow,
            args.out_dir,
            args.manifest,
            args.literature_query,
        )
    if args.command == "mcp":
        mcp_args = []
        if args.once:
            mcp_args.extend(["--once", args.once])
        if args.once_file:
            mcp_args.extend(["--once-file", args.once_file])
        return mcp_main(mcp_args)

    parser.error("Unknown command")
    return 2


def _check(path: str, parts_path: str, as_json: bool) -> int:
    paths = WorkspacePaths.create()
    design_path = paths.workspace_file(path, extensions={".proto"}, max_bytes=MAX_TEXT_FILE_BYTES)
    parts_source = paths.workspace_file(parts_path, extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
    design, parse_diagnostics = parse_design(design_path)
    diagnostics = validate_design(design, parse_diagnostics, parts_source)
    ok = not any(item.severity == "error" for item in diagnostics)
    payload = public_workspace_payload(
        _diagnostics_payload(ok, diagnostics, []),
        paths.workspace,
    )
    if as_json:
        _print_json(payload)
    else:
        _print_human_diagnostics(payload)
    return 0 if ok else 1


def _compile(path: str, parts_path: str, out: str) -> int:
    paths = WorkspacePaths.create()
    design_path = paths.workspace_file(path, extensions={".proto"}, max_bytes=MAX_TEXT_FILE_BYTES)
    parts_source = paths.workspace_file(parts_path, extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
    output_path = paths.build_file(out, extensions={".json"})
    ir, diagnostics = compile_design(design_path, parts_source)
    if ir is None:
        _print_json(
            public_workspace_payload(
                _diagnostics_payload(False, diagnostics, []),
                paths.workspace,
            ),
            stderr=True,
        )
        return 1
    ir = public_workspace_payload(ir, paths.workspace)
    write_text_bounded(output_path, json.dumps(ir, indent=2) + "\n", boundary=paths.build)
    _print_json(
        public_workspace_payload(
            _diagnostics_payload(
                True,
                diagnostics,
                [output_path.relative_to(paths.workspace).as_posix()],
            ),
            paths.workspace,
        )
    )
    return 0


def _protein_compile(path: str, out: str) -> int:
    paths = WorkspacePaths.create()
    selection_path = paths.workspace_file(path, extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
    output_path = paths.build_file(out, extensions={".json"})
    ir, diagnostics = compile_protein_selection(selection_path)
    if ir is None:
        _print_json(
            public_workspace_payload(
                _diagnostics_payload(False, diagnostics, []),
                paths.workspace,
            ),
            stderr=True,
        )
        return 1
    ir = public_workspace_payload(ir, paths.workspace)
    write_text_bounded(output_path, json.dumps(ir, indent=2) + "\n", boundary=paths.build)
    _print_json(
        public_workspace_payload(
            _diagnostics_payload(
                True,
                diagnostics,
                [output_path.relative_to(paths.workspace).as_posix()],
            ),
            paths.workspace,
        )
    )
    return 0


def _protein_validate(path: str, as_json: bool) -> int:
    paths = WorkspacePaths.create()
    selection_path = paths.workspace_file(path, extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
    ir, diagnostics = compile_protein_selection(selection_path)
    payload = public_workspace_payload(
        _diagnostics_payload(ir is not None and not any(item.severity == "error" for item in diagnostics), diagnostics, []),
        paths.workspace,
    )
    if as_json:
        _print_json(payload)
    else:
        _print_human_diagnostics(payload)
    return 0 if payload["ok"] else 1


def _export(ir_path: str, output_format: str, out: str) -> int:
    paths = WorkspacePaths.create()
    input_path = paths.workspace_file(ir_path, extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
    ir = load_ir(input_path)
    output = export_ir(ir, output_format)
    extension = {"sbol": ".ttl", "genbank": ".gb", "fasta": ".fasta"}[output_format]
    output_path = paths.build_file(out, extensions={extension})
    write_text_bounded(output_path, output, boundary=paths.build)
    _print_json({"ok": True, "diagnostics": [], "artifacts": [output_path.relative_to(paths.workspace).as_posix()]})
    return 0


def _score(path: str, parts_path: str, as_json: bool) -> int:
    paths = WorkspacePaths.create()
    design_path = paths.workspace_file(path, extensions={".proto"}, max_bytes=MAX_TEXT_FILE_BYTES)
    parts_source = paths.workspace_file(parts_path, extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
    score, diagnostics = score_design(design_path, parts_source)
    ok = score["ok"] and not any(item.severity == "error" for item in diagnostics)
    payload = public_workspace_payload(
        {**score, "diagnostics": [item.to_dict() for item in diagnostics]},
        paths.workspace,
    )
    if as_json:
        _print_json(payload)
    else:
        print(score["summary"])
    return 0 if ok else 1


def _sequence_validate(path: str, parts_path: str, as_json: bool) -> int:
    paths = WorkspacePaths.create()
    design_path = paths.workspace_file(path, extensions={".proto"}, max_bytes=MAX_TEXT_FILE_BYTES)
    parts_source = paths.workspace_file(parts_path, extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
    report, diagnostics = validate_sequences(design_path, parts_source)
    payload = public_workspace_payload(
        {**report, "diagnostics": [item.to_dict() for item in diagnostics]},
        paths.workspace,
    )
    if as_json:
        _print_json(payload)
    else:
        print(report["summary"])
    return 0 if report["ok"] else 1


def _sequence_optimize(path: str, parts_path: str, backend: str) -> int:
    paths = WorkspacePaths.create()
    design_path = paths.workspace_file(path, extensions={".proto"}, max_bytes=MAX_TEXT_FILE_BYTES)
    parts_source = paths.workspace_file(parts_path, extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
    payload, code = optimize_design(design_path, parts_source, backend)
    payload = public_workspace_payload(payload, paths.workspace)
    _print_json(payload)
    return code


def _sbol_validate(path: str) -> int:
    paths = WorkspacePaths.create()
    source = paths.workspace_file(path, extensions={".ttl"}, max_bytes=MAX_TEXT_FILE_BYTES)
    payload = validate_sbol_turtle(source)
    payload = public_workspace_payload(payload, paths.workspace)
    _print_json(payload)
    return 0 if payload["ok"] else 1


def _explain(diagnostics_path: str) -> int:
    paths = WorkspacePaths.create()
    source = paths.workspace_file(diagnostics_path, extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
    payload = read_json_bounded(source, MAX_JSON_FILE_BYTES)
    if not isinstance(payload, dict):
        raise ValueError("Diagnostics file must contain a JSON object.")
    diagnostics = payload.get("diagnostics", [])
    if not diagnostics:
        print("No diagnostics found.")
        return 0
    for item in diagnostics:
        location = f"{item.get('file', '<unknown>')}:{item.get('line', 0)}"
        print(f"[{item.get('severity', 'info')}] {location} {item.get('code', 'UNKNOWN')}")
        print(f"  {item.get('message', '')}")
        if item.get("suggestion"):
            print(f"  suggestion: {item['suggestion']}")
    return 0


def _parts_search(query: str, chassis: str | None, parts_path: str) -> int:
    if not query or len(query) > 512 or "\x00" in query:
        raise ValueError("Part search query must contain 1 to 512 characters and no NUL.")
    paths = WorkspacePaths.create()
    parts_source = paths.workspace_file(parts_path, extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
    _print_json({"ok": True, "matches": search_parts(query, chassis, parts_source)})
    return 0


def _materials(args: argparse.Namespace) -> int:
    store = MaterialsStore(root=args.materials_root)
    command = args.materials_command
    if command == "status":
        _print_json(store.status())
        return 0
    if command == "init":
        _print_json(store.initialize_seed(activate=not args.no_activate))
        return 0
    if command == "search":
        _bounded_number("limit", args.limit, minimum=1, maximum=MAX_RESULT_LIMIT)
        _print_json(store.search(
            args.query,
            kind=args.kind,
            organism=args.organism,
            role=args.role,
            source=args.source,
            license_id=args.license_id,
            status=args.status,
            limit=args.limit,
            cursor=args.cursor,
            include_quarantine=args.include_quarantine,
            snapshot_id=args.snapshot,
        ))
        return 0
    if command in {"get", "show"}:
        _print_json(store.get(args.resource_id, include_sequence=args.include_sequence, include_quarantine=args.include_quarantine, snapshot_id=args.snapshot))
        return 0
    if command == "facets":
        _print_json(store.facets(snapshot_id=args.snapshot, include_quarantine=args.include_quarantine, status=args.status))
        return 0
    if command in {"activate", "rollback"}:
        _print_json(store.activate(args.snapshot_id))
        return 0
    if command == "diff":
        _print_json(store.diff(args.left, args.right))
        return 0
    if command == "import":
        paths = WorkspacePaths.create()
        source = paths.workspace_file(args.path, extensions={".json", ".fasta", ".fa", ".fas", ".ttl", ".rdf", ".gb", ".gbk", ".genbank"}, max_bytes=64 * 1024 * 1024)
        _print_json(store.import_file(source, activate=args.activate))
        return 0
    if command == "sync":
        _bounded_number("max_records", args.max_records, minimum=1, maximum=2_000_000)
        _bounded_number("page_size", args.page_size, minimum=1, maximum=500)
        if args.source == "uniprot":
            _print_json(store.sync_uniprot(max_records=args.max_records, page_size=args.page_size, activate=args.activate))
            return 0
        if args.source == "igem":
            _print_json(store.sync_igem(max_records=args.max_records, page_size=args.page_size, activate=args.activate))
            return 0
        if args.source == "rhea":
            _print_json(store.sync_rhea(max_records=args.max_records, activate=args.activate))
            return 0
        if args.source == "biomodels":
            _print_json(store.sync_biomodels(max_records=args.max_records, activate=args.activate))
            return 0
    if command == "materialize":
        _print_json(store.materialize_parts(args.resource_ids, args.chassis, output=args.out, snapshot_id=args.snapshot))
        return 0
    if command == "materialize-proteins":
        _print_json(store.materialize_proteins(args.resource_ids, design_id=args.design_id, output=args.out, snapshot_id=args.snapshot))
        return 0
    if command == "render-template":
        bindings: dict[str, str] = {}
        for binding in args.bind:
            if "=" not in binding:
                raise ValueError("--bind values must use slotN=resource_id syntax.")
            key, value = binding.split("=", 1)
            if not re.fullmatch(r"slot[1-9][0-9]*", key) or not value:
                raise ValueError("--bind values must use slotN=resource_id syntax.")
            bindings[key] = value
        _print_json(store.render_template(args.template_id, bindings, chassis=args.chassis, output=args.out, snapshot_id=args.snapshot))
        return 0
    if command == "review":
        _print_json(store.review_overlay(
            args.resource_id,
            decision=args.decision,
            description_en=args.description_en,
            description_zh=args.description_zh,
            reviewer=args.reviewer,
            snapshot_id=args.snapshot,
            include_quarantine=args.include_quarantine,
        ))
        return 0
    raise ValueError(f"Unsupported materials command: {command}")


def _literature_search(query: str, registry_path: str, limit: int) -> int:
    paths = WorkspacePaths.create()
    registry = paths.workspace_file(registry_path, extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
    _print_json(public_workspace_payload(search_literature(query, registry, limit), paths.workspace))
    return 0


def _pubmed_search(query: str, retmax: int, cache_dir: str, allow_network: bool, fixture_path: str | None, cafile: str | None) -> int:
    paths = WorkspacePaths.create()
    cache = paths.cache_directory(cache_dir)
    fixture = paths.fixture_file(fixture_path, extensions={".json"}) if fixture_path else None
    ca_source: str | Path = paths.ca_file(cafile) if cafile else ""
    payload = search_pubmed(query, retmax, cache, allow_network, fixture, ca_source)
    payload = public_workspace_payload(payload, paths.workspace)
    _print_json(payload)
    return 0 if payload["ok"] else 1


def _connectors(command: str, registry_path: str) -> int:
    paths = WorkspacePaths.create()
    registry = paths.workspace_file(registry_path, extensions={".json"}, max_bytes=MAX_JSON_FILE_BYTES)
    summary = connector_summary(
        registry.relative_to(paths.workspace),
        workspace_root=paths.workspace,
    )
    if command == "list":
        _print_json(summary)
        return 0
    if command == "check":
        required_ids = {"proto_dsl", "parts_library"}
        present_ids = {connector.get("id") for connector in summary.get("connectors", [])}
        missing = sorted(required_ids - present_ids)
        summary["ok"] = summary["ok"] and not missing
        summary["missing_required_connectors"] = missing
        _print_json(summary)
        return 0 if summary["ok"] else 1
    return 2


def _analysis_run(script: str, script_args: list[str], out_dir: str, timeout: int, broker: ExecutionBroker) -> int:
    manifest, code = run_python_analysis(script, script_args, out_dir, timeout, broker=broker)
    _print_json(manifest)
    return code


def _notebook_run(path: str, out_dir: str, timeout: int, broker: ExecutionBroker) -> int:
    manifest, code = run_notebook(path, out_dir, timeout, broker=broker)
    _print_json(manifest)
    return code


def _r_status() -> int:
    _print_json(r_status())
    return 0


def _doctor(as_json: bool) -> int:
    paths = WorkspacePaths.create()
    sandbox = ExecutionBroker.from_environment(caller="cli").status()
    required_files: dict[str, tuple[str, set[str]]] = {
        "parts_library": (str(DEFAULT_PARTS_PATH), {".json"}),
        "connector_registry": (str(DEFAULT_CONNECTORS_PATH), {".json"}),
        "literature_registry": (str(DEFAULT_LITERATURE_PATH), {".json"}),
        "workflow": (str(DEFAULT_WORKFLOW_PATH), {".json"}),
    }
    file_checks: dict[str, dict[str, Any]] = {}
    for name, (value, extensions) in required_files.items():
        try:
            resolved = paths.workspace_file(value, extensions=extensions, max_bytes=MAX_JSON_FILE_BYTES)
            file_checks[name] = {"ok": True, "path": resolved.relative_to(paths.workspace).as_posix()}
        except SecurityBoundaryError as exc:
            file_checks[name] = {"ok": False, "code": exc.code, "message": str(exc)}
    files_ok = all(check["ok"] for check in file_checks.values())
    payload = {
        "ok": files_ok,
        "workspace": str(paths.workspace),
        "build": str(paths.build),
        "cache": str(paths.cache),
        "python": {
            "executable": sys.executable,
            "version": platform.python_version(),
            "isolated_flag_for_host_execution": "-I -B",
        },
        "sandbox": sandbox,
        "dependencies": {
            "certifi": importlib.util.find_spec("certifi") is not None,
            "rscript_host": r_status()["available"],
        },
        "required_files": file_checks,
        "checks": {
            "path_boundary_initialized": True,
            "required_files_ready": files_ok,
            "execution_default": "disabled" if sandbox["mode"] == "disabled" else "configured",
            "provider_visible": sandbox["provider_visible"],
            "smoke_verified": sandbox["smoke_verified"],
        },
    }
    if as_json:
        _print_json(payload)
    else:
        print(f"Workspace: {paths.workspace}")
        print(f"Execution mode: {sandbox['mode']} ({sandbox['reason']})")
        print("Sandbox smoke verified: no")
    return 0 if payload["ok"] else 1


def _capabilities(as_json: bool) -> int:
    paths = WorkspacePaths.create()
    sandbox = ExecutionBroker.from_environment(caller="cli").status()
    execution_tools = {"proto_run_analysis", "proto_run_notebook", "proto_run_r"}
    network_tools = {
        "proto_pubmed_search",
        "proto_europe_pmc_search",
        "proto_crossref_search",
        "proto_uniprot_search",
        "proto_rhea_search",
    }
    tool_capabilities = []
    for tool in TOOLS:
        name = tool["name"]
        status = (
            "oci_configured" if name in execution_tools and sandbox["mode"] == "oci" else
            "sandbox_required" if name in execution_tools else
            "offline_cache_fixture_available" if name in network_tools else
            "available"
        )
        tool_capabilities.append({"name": name, "status": status})
    payload = {
        "ok": True,
        "workspace": str(paths.workspace),
        "roots": {
            "workspace": str(paths.workspace),
            "build": str(paths.build),
            "cache": str(paths.cache),
        },
        "mcp_tools": [tool["name"] for tool in TOOLS],
        "mcp_tool_capabilities": tool_capabilities,
        "execution": {
            "default": "disabled",
            "oci_providers": ["docker", "podman"],
            "digest_pinned_image_required": True,
            "unsafe_host_execution": "CLI explicit flag only",
            "mcp_host_execution": False,
        },
        "filesystem": {
            "relative_paths_only": True,
            "reparse_points_allowed": False,
            "atomic_replace": True,
            "posix_directory_handle_writes": True,
            "windows_residual_same_user_rename_race": True,
        },
        "network": {
            "cache_root": str(paths.cache),
            "fixtures": "workspace regular files only",
            "custom_ca": "CLI workspace .pem/.crt/.cer only",
            "mcp_custom_ca": False,
            "mcp_live_network": "requires a host-issued, argument-bound, one-time per-call capability",
            "max_results": 20,
        },
    }
    if as_json:
        _print_json(payload)
    else:
        print(f"{len(payload['mcp_tools'])} MCP tools; execution is disabled by default.")
        print(f"Workspace: {paths.workspace}")
    return 0


def _sandbox_status(as_json: bool, provider: str | None, image: str | None, unsafe_host: bool) -> int:
    if unsafe_host and (provider or image):
        raise ValueError("Unsafe host status cannot be combined with OCI sandbox options.")
    broker = ExecutionBroker.unsafe_host_for_cli() if unsafe_host else ExecutionBroker.from_environment(provider=provider, image=image, caller="cli")
    payload = broker.status()
    if as_json:
        _print_json(payload)
    else:
        print(f"Mode: {payload['mode']}")
        print(f"Configured: {payload['configured']}; provider visible: {payload['provider_visible']}; smoke verified: {payload['smoke_verified']}")
        print(str(payload["reason"]))
    return 0


def _provenance_create(manifest: str, output: str | None) -> int:
    paths = WorkspacePaths.create()
    manifest_path = paths.build_file(manifest, extensions={".json"}, must_exist=True)
    output_path = paths.build_file(output, extensions={".json"}) if output else None
    statement = create_provenance(
        manifest_path,
        workspace_root=paths.workspace,
        build_root=paths.build,
        output_path=output_path,
    )
    statement["provenance_path"] = Path(statement["provenance_path"]).relative_to(paths.workspace).as_posix()
    _print_json(statement)
    return 0


def _provenance_verify(path: str) -> int:
    paths = WorkspacePaths.create()
    provenance_path = paths.build_file(path, extensions={".json"}, must_exist=True)
    result = verify_provenance(
        provenance_path,
        workspace_root=paths.workspace,
        build_root=paths.build,
    )
    result["provenance_path"] = provenance_path.relative_to(paths.workspace).as_posix()
    _print_json(result)
    return 0 if result["ok"] else 1


def _provenance_compare(left: str, right: str) -> int:
    paths = WorkspacePaths.create()
    left_path = paths.build_file(left, extensions={".json"}, must_exist=True)
    right_path = paths.build_file(right, extensions={".json"}, must_exist=True)
    comparison = compare_provenance(
            left_path,
            right_path,
            workspace_root=paths.workspace,
            build_root=paths.build,
    )
    comparison["left"]["path"] = left_path.relative_to(paths.workspace).as_posix()
    comparison["right"]["path"] = right_path.relative_to(paths.workspace).as_posix()
    _print_json(comparison)
    return 0


def _security_stress(args: argparse.Namespace) -> int:
    _bounded_number("seed", args.seed, minimum=0, maximum=(1 << 64) - 1)
    _bounded_number("max_cases", args.max_cases, minimum=1, maximum=256)
    _bounded_number("max_total_seconds", args.max_total_seconds, minimum=0.1, maximum=30.0)
    _bounded_number("max_case_seconds", args.max_case_seconds, minimum=0.01, maximum=2.0)
    _bounded_number("max_input_bytes", args.max_input_bytes, minimum=1, maximum=1024 * 1024)
    _bounded_number("max_report_bytes", args.max_report_bytes, minimum=1024, maximum=8 * 1024 * 1024)
    if args.max_case_seconds > args.max_total_seconds:
        raise ValueError("max_case_seconds must not exceed max_total_seconds")

    paths = WorkspacePaths.create()
    corpus = paths.workspace_entry(args.corpus_dir)
    if not corpus.is_dir():
        raise ValueError("corpus_dir must be a workspace directory")
    report = run_stress(
        corpus_dir=corpus,
        workspace_root=paths.workspace,
        build_dir=paths.build,
        report_path=args.report,
        seed=args.seed,
        max_cases=args.max_cases,
        max_total_seconds=args.max_total_seconds,
        max_case_seconds=args.max_case_seconds,
        max_input_bytes=args.max_input_bytes,
        max_report_bytes=args.max_report_bytes,
    )
    _print_json(report)
    return 0 if report["ok"] else 1


def _bounded_number(name: str, value: int | float, *, minimum: int | float, maximum: int | float) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")


def _execution_broker(args: argparse.Namespace) -> ExecutionBroker:
    unsafe_host = bool(getattr(args, "unsafe_host_execution", False))
    provider = getattr(args, "sandbox_provider", None)
    image = getattr(args, "sandbox_image", None)
    if unsafe_host:
        if provider or image:
            raise ValueError("--unsafe-host-execution cannot be combined with OCI sandbox options.")
        return ExecutionBroker.unsafe_host_for_cli()
    return ExecutionBroker.from_environment(provider=provider, image=image, caller="cli")


def _r_run(script: str, script_args: list[str], out_dir: str, timeout: int, broker: ExecutionBroker) -> int:
    manifest, code = run_r_script(script, script_args, out_dir, timeout, broker=broker)
    _print_json(manifest)
    return code


def _workflow_run(path: str, parts_path: str, workflow_path: str, out_dir: str) -> int:
    paths = WorkspacePaths.create()
    manifest, code = run_design_review(
        path,
        parts_path,
        workflow_path,
        out_dir,
        workspace_root=paths.workspace,
    )
    _print_json(
        {
            "ok": manifest["ok"],
            "run_id": manifest["run_id"],
            "manifest_path": manifest["manifest_path"],
            "provenance_path": manifest["provenance_path"],
            "review_status": manifest["review_status"],
            "summary": manifest["summary"],
            "artifacts": manifest["artifacts"],
            "diagnostics": manifest["diagnostics"],
        }
    )
    return code


def _review_run(
    path: str,
    parts_path: str,
    workflow_path: str,
    out_dir: str,
    manifest_path: str | None,
    literature_query: str | None,
) -> int:
    paths = WorkspacePaths.create()
    packet, code = build_review_packet(
        path,
        parts_path=parts_path,
        workflow_path=workflow_path,
        out_dir=out_dir,
        manifest_path=manifest_path,
        literature_query=literature_query,
        workspace_root=paths.workspace,
    )
    _print_json(
        {
            "ok": packet["ok"],
            "run_id": packet["run_id"],
            "packet_path": packet["packet_path"],
            "markdown_path": packet["markdown_path"],
            "provenance_path": packet["provenance_path"],
            "manifest_path": packet["manifest_path"],
            "review_status": packet["review_status"],
            "evidence_summary": packet["evidence_summary"],
            "artifacts": packet["artifacts"],
            "review_gates": packet["review_gates"],
            "next_actions": packet["next_actions"],
            "safety_boundary": packet["safety_boundary"],
        }
    )
    return code


def _diagnostics_payload(ok: bool, diagnostics: list[Diagnostic], artifacts: list[str]) -> dict[str, Any]:
    return {
        "ok": ok,
        "diagnostics": [item.to_dict() for item in diagnostics],
        "artifacts": artifacts,
    }


def _print_json(payload: dict[str, Any], stderr: bool = False) -> None:
    stream = sys.stderr if stderr else sys.stdout
    print(json.dumps(payload, indent=2, allow_nan=False), file=stream)


def _print_human_diagnostics(payload: dict[str, Any]) -> None:
    if payload["ok"]:
        print("OK")
        return
    for item in payload["diagnostics"]:
        print(f"{item['severity'].upper()} {item['file']}:{item['line']} {item['code']}: {item['message']}")


if __name__ == "__main__":
    raise SystemExit(main())
