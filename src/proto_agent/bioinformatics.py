"""Typed adapters for installed bioinformatics engines, separate from code execution.

Only reviewed operations are accepted. Inputs are immutable workspace snapshots;
the Linux worker receives an argument array and never executes caller-supplied code.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from .compute import _pairs, _reject_constant, _validate
from .security import WorkspacePaths, read_bytes_bounded, write_text_bounded

SCHEMA = "proto-agent.bioinformatics.v1"
MAX_INPUT_BYTES = 2 * 1024**3
MAX_TOTAL_BYTES = 4 * 1024**3
MAX_REQUEST_BYTES = 128 * 1024
MAX_RESULT_FILES = 1000
TIMEOUT_SECONDS = 1800


class BioinformaticsError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _string(description: str) -> dict:
    return {"type": "string", "minLength": 1, "maxLength": 512, "description": description}


def _operation(title: str, engine: str, environment: str, properties: dict,
               required: list[str], files: dict, example: dict, description: str) -> dict:
    return {"title": title, "engine": engine, "environment": environment,
            "description": description, "implementation": "trusted-wsl-adapter",
            "input_schema": {"type": "object", "additionalProperties": False,
                             "properties": properties, "required": required},
            "file_inputs": files, "example": example}


FASTA = [".fa", ".fasta", ".fna"]
OPERATIONS = {
    "gatk_mutect2": _operation("Somatic variant calling", "gatk", "variants", {
        "reference": _string("Workspace FASTA reference; indexes are created from its snapshot."),
        "tumor_bam": _string("Workspace coordinate-sorted BAM with read groups."),
        "normal_bam": _string("Optional matched normal BAM."),
        "normal_sample": _string("Normal sample identifier in the BAM read groups."),
        "intervals": _string("Optional workspace BED interval file.")}, ["reference", "tumor_bam"],
        {"reference": FASTA, "tumor_bam": [".bam"], "normal_bam": [".bam"], "intervals": [".bed"]},
        {"reference": "data/reference.fa", "tumor_bam": "data/tumor.bam"},
        "Run GATK Mutect2 on supplied BAM/reference data; outputs unfiltered candidate variants, not clinical conclusions."),
    "samtools_sort_index": _operation("Sort and index alignments", "samtools", "variants", {
        "alignment": _string("Workspace SAM or BAM alignment file.")}, ["alignment"],
        {"alignment": [".sam", ".bam"]}, {"alignment": "data/reads.sam"},
        "Create a coordinate-sorted BAM, index, and flagstat report."),
    "bcftools_stats": _operation("Variant file statistics", "bcftools", "variants", {
        "variants": _string("Workspace VCF, compressed VCF, or BCF.")}, ["variants"],
        {"variants": [".vcf", ".vcf.gz", ".bcf"]}, {"variants": "data/variants.vcf"},
        "Summarize an existing variant file with bcftools stats."),
    "snpeff_annotate": _operation("Variant consequence annotation", "snpeff", "variants", {
        "variants": _string("Workspace VCF or compressed VCF."),
        "reference": _string("Workspace FASTA reference for a local annotation database."),
        "genes": _string("Workspace GFF3 gene annotation matching that reference.")},
        ["variants", "reference", "genes"],
        {"variants": [".vcf", ".vcf.gz"], "reference": FASTA, "genes": [".gff", ".gff3"]},
        {"variants": "data/variants.vcf", "reference": "data/reference.fa", "genes": "data/genes.gff3"},
        "Build a run-local SnpEff database from supplied FASTA/GFF3, then annotate variants. No reference download or global database mutation."),
    "lumpy_bedpe": _operation("Structural variants from BEDPE", "lumpy", "lumpy", {
        "bedpe": _string("Workspace BEDPE supporting evidence, including LUMPY TYPE metadata."),
        "chromosomes": _string("Workspace two-column chromosome name/length file."),
        "minimum_weight": {"type": "integer", "minimum": 1, "maximum": 100000}},
        ["bedpe", "chromosomes"], {"bedpe": [".bedpe"], "chromosomes": [".txt", ".tsv", ".genome"]},
        {"bedpe": "data/evidence.bedpe", "chromosomes": "data/genome.tsv", "minimum_weight": 1},
        "Call structural variants from precomputed BEDPE evidence using LUMPY's fixed BEDPE adapter."),
    "cnvkit_call": _operation("Copy-number calls from segments", "cnvkit", "cnvkit", {
        "segments": _string("Workspace CNVkit CNS segment table."),
        "ploidy": {"type": "integer", "minimum": 1, "maximum": 16},
        "purity": {"type": "number", "exclusiveMinimum": 0, "maximum": 1}}, ["segments"],
        {"segments": [".cns"]}, {"segments": "data/segments.cns", "ploidy": 2},
        "Call integer copy numbers from an existing CNS segmentation using the clonal method."),
    "prokka_annotate": _operation("Prokaryotic contig annotation", "prokka", "prokka", {
        "contigs": _string("Workspace FASTA contigs."),
        "kingdom": {"type": "string", "enum": ["Bacteria", "Archaea"]},
        "minimum_contig_length": {"type": "integer", "minimum": 1, "maximum": 1000000}},
        ["contigs"], {"contigs": FASTA}, {"contigs": "data/contigs.fa", "kingdom": "Bacteria"},
        "Annotate supplied prokaryotic sequence data and retain GFF/GenBank/protein outputs and logs."),
    "deseq2_fit": _operation("Differential expression", "deseq2", "deseq2", {
        "counts": _string("CSV: first column unique gene ID; remaining columns named samples containing nonnegative integer raw counts."),
        "samples": _string("CSV: unique sample,condition columns, plus batch or subject for the selected design; one row per counts column."),
        "reference_level": _string("Condition used as the reference level."),
        "comparison_level": _string("Condition compared with the reference level."),
        "alpha": {"type": "number", "minimum": 0.001, "maximum": 0.5, "default": 0.05},
        "design": {"type": "string", "enum": ["condition", "batch_condition", "subject_condition"], "default": "condition"},
        "min_count": {"type": "integer", "minimum": 0, "maximum": 1000000, "default": 10},
        "min_samples": {"type": "integer", "minimum": 1, "maximum": 100, "default": 2},
        "pca_top_genes": {"type": "integer", "minimum": 2, "maximum": 5000, "default": 500},
        "size_factor_type": {"type": "string", "enum": ["ratio", "poscounts"], "default": "ratio"}},
        ["counts", "samples", "reference_level", "comparison_level"],
        {"counts": [".csv"], "samples": [".csv"]},
        {"counts": "data/counts.csv", "samples": "data/samples.csv", "reference_level": "control", "comparison_level": "treated"},
        "Fit one of three fixed DESeq2 designs from raw counts. Save the explicit filter and contrast, unshrunk estimates with NA status, normalized counts, VST PCA, size factors and R session metadata. Omitted options use documented defaults: condition, min_count=10, min_samples=2, pca_top_genes=500, ratio, alpha=0.05."),
    "nucmer_align": _operation("Pairwise genome alignment", "nucmer", "mummer", {
        "reference": _string("Workspace reference FASTA."), "query": _string("Workspace query FASTA."),
        "minimum_match": {"type": "integer", "minimum": 10, "maximum": 10000},
        "minimum_cluster": {"type": "integer", "minimum": 20, "maximum": 100000}},
        ["reference", "query"], {"reference": FASTA, "query": FASTA},
        {"reference": "data/reference.fa", "query": "data/query.fa"},
        "Run MUMmer nucmer and show-coords with preserved delta and coordinate output."),
}


def _configuration() -> dict[str, str]:
    distro = os.environ.get("PROTO_AGENT_BIO_WSL_DISTRO", "Ubuntu-24.04")
    root = os.environ.get("PROTO_AGENT_BIO_ROOT", "")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", distro):
        raise BioinformaticsError("BIO_CONFIG_INVALID", "Invalid WSL distribution name.")
    if root and (not re.fullmatch(r"/(?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+", root)
                 or any(part in {".", ".."} for part in root.split("/"))):
        raise BioinformaticsError("BIO_CONFIG_INVALID", "The bioinformatics installation root must be an absolute Linux path without traversal or spaces.")
    return {"distribution": distro, "installation_root": root or "~/.local/share/proto-bio"}


def _linux_path(path: Path, configuration: dict[str, str]) -> str:
    if os.name != "nt":
        return str(path)
    result = subprocess.run(["wsl.exe", "--distribution", configuration["distribution"], "--exec", "wslpath", "-a", "-u", str(path)],
                            capture_output=True, timeout=20, check=False, text=True, encoding="utf-8", errors="replace",
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    value = result.stdout.strip()
    if result.returncode or not value.startswith("/") or "\n" in value or "\x00" in value:
        raise BioinformaticsError("BIO_WSL_UNAVAILABLE", "The WSL distribution is unavailable or could not resolve the workspace path.")
    return value


def _worker_command(arguments: list[str], configuration: dict[str, str]) -> list[str]:
    helper_root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    helper = (helper_root / "proto_agent" / "bioinformatics_worker.py").resolve(strict=True)
    executable = ["/usr/bin/python3", _linux_path(helper, configuration), *arguments]
    if configuration["installation_root"] != "~/.local/share/proto-bio":
        executable.extend(["--root", configuration["installation_root"]])
    if os.name == "nt":
        return ["wsl.exe", "--distribution", configuration["distribution"], "--exec", *executable]
    return [sys.executable, *executable[1:]]


def _probe(configuration: dict[str, str], engine: str | None = None) -> dict:
    try:
        arguments = ["status"] + (["--engine", engine] if engine else [])
        result = subprocess.run(_worker_command(arguments, configuration), capture_output=True,
                                timeout=90, text=True, encoding="utf-8", errors="replace",
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if result.returncode:
            return {"checked": True, "available": False, "error": result.stderr[-2000:] or result.stdout[-2000:]}
        return json.loads(result.stdout)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        return {"checked": True, "available": False, "error": str(exc)[:2000]}


def bioinformatics_catalog(operation: str | None = None, *, probe: bool = False) -> dict[str, Any]:
    if operation is not None and operation not in OPERATIONS:
        raise BioinformaticsError("BIO_UNKNOWN_OPERATION", "Unknown operation; use bioinformatics catalog.")
    configuration = _configuration()
    runtime = _probe(configuration, OPERATIONS[operation]["engine"] if operation else None) if probe else {"checked": False, "available": None}
    entries = []
    for name, metadata in OPERATIONS.items():
        if operation is not None and operation != name:
            continue
        engine = runtime.get("engines", {}).get(metadata["engine"], {})
        entry = {"id": name, **metadata, "available": engine.get("available") if runtime.get("checked") else None,
                 "runtime": engine or {"checked": bool(runtime.get("checked")), "version": None,
                                       **({"error": runtime["error"]} if "error" in runtime else {})}}
        if runtime.get("checked") and not runtime.get("engines"):
            entry["available"] = False
        if operation is None:
            entry.pop("input_schema", None)
            entry.pop("example", None)
        entries.append(entry)
    return {"ok": True, "schema_version": SCHEMA, "operations": entries, "count": len(entries),
            "configuration": configuration, "runtime": runtime,
            "usage": "Get one operation for its typed schema. Save {operation, arguments} as workspace JSON; run that path. probe=true checks current engine execution and versions.",
            "limits": {"input_file_bytes": MAX_INPUT_BYTES, "total_input_bytes": MAX_TOTAL_BYTES, "timeout_seconds": TIMEOUT_SECONDS},
            "scope": "Trusted fixed scientific executables; separate from the general-code sandbox. Outputs require scientific review."}


def _digest(path: Path, cancel_event: Any = None) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            if cancel_event is not None and cancel_event.is_set():
                raise BioinformaticsError("BIO_CANCELLED", "Cancelled while verifying output artifacts.")
            digest.update(chunk)
    return digest.hexdigest()


def _copy_snapshot(source: Path, destination: Path, cancel_event: Any = None) -> tuple[str, int]:
    digest, size = hashlib.sha256(), 0
    with source.open("rb") as reader, destination.open("xb") as writer:
        for chunk in iter(lambda: reader.read(1024 * 1024), b""):
            if cancel_event is not None and cancel_event.is_set():
                raise BioinformaticsError("BIO_CANCELLED", "Cancelled while snapshotting inputs.")
            size += len(chunk)
            if size > MAX_INPUT_BYTES:
                raise BioinformaticsError("BIO_INPUT_TOO_LARGE", "An input grew beyond the allowed size while copying.")
            digest.update(chunk)
            writer.write(chunk)
    return digest.hexdigest(), size


def _invoke(command: list[str], run_root: Path, cancel_event: Any) -> int:
    """The marker cancels Linux process groups, not just the Windows WSL client."""
    deadline = time.monotonic() + TIMEOUT_SECONDS + 60
    cancellation_at = None
    with (run_root / "worker.log").open("xb") as log:
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        while process.poll() is None:
            if (cancel_event is not None and cancel_event.is_set()) or time.monotonic() >= deadline:
                if cancellation_at is None:
                    (run_root / "CANCEL").touch(exist_ok=True)
                    cancellation_at = time.monotonic()
                if time.monotonic() - cancellation_at > 12:
                    process.kill()
                    process.wait(timeout=5)
                    raise BioinformaticsError("BIO_CANCELLED" if cancel_event is not None and cancel_event.is_set() else "BIO_TIMEOUT",
                                              "Execution stopped; inspect the saved worker log and cancellation marker.")
            time.sleep(0.1)
        return int(process.returncode)


def run_bioinformatics(path: str, *, workspace_root: str | Path = ".", cancel_event: Any = None) -> dict[str, Any]:
    paths = WorkspacePaths.create(workspace_root)
    source = paths.workspace_file(path, extensions={".json"}, max_bytes=MAX_REQUEST_BYTES)
    raw = read_bytes_bounded(source, MAX_REQUEST_BYTES)
    try:
        request = json.loads(raw.decode("utf-8-sig"), object_pairs_hook=_pairs, parse_constant=_reject_constant)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise BioinformaticsError("BIO_INVALID_REQUEST", "The request must be finite, unique-key JSON.") from exc
    if not isinstance(request, dict) or set(request) != {"operation", "arguments"} or not isinstance(request["operation"], str):
        raise BioinformaticsError("BIO_INVALID_REQUEST", "A request must contain exactly operation and arguments.")
    name = request["operation"]
    if name not in OPERATIONS:
        raise BioinformaticsError("BIO_UNKNOWN_OPERATION", "Unknown operation; use bioinformatics catalog.")
    metadata = OPERATIONS[name]
    _validate(request["arguments"], metadata["input_schema"])
    for field in ("normal_sample", "reference_level", "comparison_level"):
        value = request["arguments"].get(field)
        if value is not None and (value.startswith("-") or any(ord(char) < 32 for char in value)):
            raise BioinformaticsError("BIO_INVALID_REQUEST", f"{field} must be a plain label, not an option or control sequence.")
    if name == "gatk_mutect2" and ("normal_bam" in request["arguments"]) != ("normal_sample" in request["arguments"]):
        raise BioinformaticsError("BIO_INVALID_REQUEST", "Matched normal BAM and normal_sample must be supplied together.")
    if cancel_event is not None and cancel_event.is_set():
        raise BioinformaticsError("BIO_CANCELLED", "Cancelled before execution.")
    configuration = _configuration()
    # Resolve every file before creating a run or starting an external process.
    sources, total = {}, 0
    for field, extensions in metadata["file_inputs"].items():
        if field not in request["arguments"]:
            continue
        supplied = request["arguments"][field]
        file = paths.workspace_file(supplied, max_bytes=MAX_INPUT_BYTES)
        if not any(file.name.lower().endswith(extension) for extension in extensions):
            raise BioinformaticsError("BIO_INVALID_EXTENSION", f"{field} requires one of {', '.join(extensions)}.")
        total += file.stat().st_size
        sources[field] = file
    if total > MAX_TOTAL_BYTES:
        raise BioinformaticsError("BIO_INPUT_TOO_LARGE", "The total input size exceeds the job limit.")
    run_id = uuid4().hex
    root = paths.run_directory("build/bioinformatics", run_id)
    inputs = paths.build_directory(f"build/bioinformatics/{run_id}/inputs")
    paths.build_directory(f"build/bioinformatics/{run_id}/outputs")
    relative = lambda item: item.relative_to(paths.workspace).as_posix()
    receipt = {"schema_version": SCHEMA, "run_id": run_id, "operation": name,
               "created_at": datetime.now(timezone.utc).isoformat(), "ok": False, "status": "failed",
               "source": {"path": relative(source), "sha256": hashlib.sha256(raw).hexdigest()},
               "configuration": configuration, "inputs": {}, "artifacts": [],
               "review_status": "human_review_required", "scope": "Software execution on supplied data; scientific and clinical validity are not implied."}
    manifest_path = root / "manifest.json"
    try:
        write_text_bounded(root / "request.json", raw.decode("utf-8"), max_bytes=MAX_REQUEST_BYTES, boundary=paths.build)
        files = {}
        copied_total = 0
        for field, file in sources.items():
            suffix = ".vcf.gz" if file.name.lower().endswith(".vcf.gz") else file.suffix.lower()
            snapshot = inputs / (field + suffix)
            digest, size = _copy_snapshot(file, snapshot, cancel_event)
            copied_total += size
            if copied_total > MAX_TOTAL_BYTES:
                raise BioinformaticsError("BIO_INPUT_TOO_LARGE", "Inputs grew beyond the combined size limit while copying.")
            files[field] = {"file": "inputs/" + snapshot.name, "sha256": digest, "bytes": size}
            receipt["inputs"][field] = {"path": relative(file), "snapshot": relative(snapshot), "sha256": digest, "bytes": size}
        worker_request = {"schema_version": SCHEMA, "operation": name, "arguments": request["arguments"], "files": files,
                          "timeout_seconds": TIMEOUT_SECONDS}
        worker_text = json.dumps(worker_request, indent=2)
        write_text_bounded(root / "worker-request.json", worker_text, max_bytes=MAX_REQUEST_BYTES, boundary=paths.build)
        request_sha256 = hashlib.sha256(worker_text.encode("utf-8")).hexdigest()
        command = _worker_command(["run", "--job", _linux_path(root, configuration), "--request-sha256", request_sha256], configuration)
        exit_code = _invoke(command, root, cancel_event)
        if not (root / "worker-result.json").is_file():
            raise BioinformaticsError("BIO_WORKER_FAILED", f"The Linux worker exited with code {exit_code} without a receipt; inspect {relative(root / 'worker.log')}.")
        result_path = paths.workspace_file(relative(root / "worker-result.json"), max_bytes=MAX_REQUEST_BYTES)
        result = json.loads(read_bytes_bounded(result_path, MAX_REQUEST_BYTES))
        receipt.update({"ok": exit_code == 0 and result.get("ok") is True, "status": result.get("status", "failed"),
                        "exit_code": exit_code, "runtime": result.get("runtime", {}), "steps": result.get("steps", []),
                        "error": result.get("error"), "seconds": result.get("seconds")})
        artifacts, total_output = [], 0
        for output in sorted((root / "outputs").rglob("*")):
            if len(artifacts) >= MAX_RESULT_FILES:
                raise BioinformaticsError("BIO_OUTPUT_LIMIT", "The result contains too many output files.")
            if output.is_dir():
                WorkspacePaths._reject_existing_symlink(output)
                continue
            bound = paths.workspace_file(relative(output), max_bytes=MAX_INPUT_BYTES)
            size = bound.stat().st_size
            total_output += size
            if total_output > MAX_TOTAL_BYTES:
                raise BioinformaticsError("BIO_OUTPUT_LIMIT", "Combined outputs exceed the result limit.")
            artifacts.append({"path": relative(bound), "sha256": _digest(bound, cancel_event), "bytes": size})
        receipt["artifacts"] = artifacts
        if cancel_event is not None and cancel_event.is_set():
            receipt.update({"ok": False, "status": "cancelled"})
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        receipt.update({"ok": False, "status": {"BIO_CANCELLED": "cancelled", "BIO_TIMEOUT": "timeout"}.get(getattr(exc, "code", ""), "failed"),
                        "error": {"code": getattr(exc, "code", "BIO_EXECUTION_FAILED"), "message": str(exc)[:4000]}})
    receipt["manifest_path"] = relative(manifest_path)
    if (root / "worker.log").is_file():
        receipt["worker_log"] = relative(root / "worker.log")
    write_text_bounded(manifest_path, json.dumps(receipt, indent=2, ensure_ascii=False) + "\n", max_bytes=2 * 1024 * 1024, boundary=paths.build)
    return receipt
