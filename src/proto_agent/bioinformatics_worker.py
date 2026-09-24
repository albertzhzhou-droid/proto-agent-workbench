"""Standalone stdlib-only Linux worker for reviewed scientific operations.

This file is invoked using /usr/bin/python3 from the packaged adapter. It accepts
no caller-supplied command or source code. All engine outputs live in a disposable
Linux directory, then are copied into the validated job's outputs directory.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

try:
    import resource
except ImportError:  # Command templates remain testable on the Windows host.
    resource = None

MAX_FILE = 2 * 1024**3
MAX_TOTAL = 4 * 1024**3
MAX_FILES = 1000
ENGINES = {
    "gatk": ("variants", "gatk4", ["gatk", "--version"], (0,)),
    "samtools": ("variants", "samtools", ["samtools", "--version"], (0,)),
    "bcftools": ("variants", "bcftools", ["bcftools", "--version"], (0,)),
    "snpeff": ("variants", "snpeff", ["snpEff", "-version"], (0,)),
    "lumpy": ("lumpy", "lumpy-sv", ["lumpy", "-h"], (1,)),
    "cnvkit": ("cnvkit", "cnvkit", ["cnvkit.py", "version"], (0,)),
    "prokka": ("prokka", "prokka", ["prokka", "--version"], (0,)),
    "deseq2": ("deseq2", "bioconductor-deseq2", ["Rscript", "--vanilla", "-e", 'cat(as.character(packageVersion("DESeq2")))'], (0,)),
    "nucmer": ("mummer", "mummer4", ["nucmer", "--version"], (0,)),
}
OPERATION_ENGINES = dict(zip(
    ["gatk_mutect2", "samtools_sort_index", "bcftools_stats", "snpeff_annotate", "lumpy_bedpe", "cnvkit_call", "prokka_annotate", "deseq2_fit", "nucmer_align"], ENGINES))

R_IDENTITY_SOURCE = r'''p <- installed.packages()
runtime <- data.frame(kind="runtime", name=c("R", "DESeq2", "platform", "arch"),
  version=c(R.version.string, as.character(packageVersion("DESeq2")), R.version$platform, R.version$arch), location="", stringsAsFactors=FALSE)
packages <- data.frame(kind="package", name=p[,"Package"], version=p[,"Version"], location=p[,"LibPath"], stringsAsFactors=FALSE)
packages <- packages[order(packages$name, packages$version, packages$location, method="radix"),,drop=FALSE]
write.table(rbind(runtime, packages), stdout(), sep="\t", row.names=FALSE, quote=TRUE, na="")
'''

DESEQ2_SOURCE = r'''suppressPackageStartupMessages(library(DESeq2))
args <- commandArgs(trailingOnly=TRUE)
if (length(args) != 10L) stop("Expected the ten fixed adapter arguments")
read_strict_csv <- function(path) {
  fields <- count.fields(path, sep=",", quote='"', comment.char="", blank.lines.skip=FALSE)
  if (length(fields) < 2L || anyNA(fields) || any(fields != fields[1L])) stop("CSV rows must have the same number of fields; embedded newlines are not supported")
  value <- read.csv(path, check.names=FALSE, stringsAsFactors=FALSE, colClasses="character",
                    na.strings=NULL, strip.white=FALSE, blank.lines.skip=FALSE, fill=FALSE, comment.char="")
  if (any(!nzchar(names(value))) || anyDuplicated(names(value)) || any(names(value) != trimws(names(value)))) stop("CSV headers must be unique, nonempty and unpadded")
  value
}
plain_labels <- function(value) {
  !anyNA(value) && all(nzchar(value)) && all(value == trimws(value)) && !any(grepl("[[:cntrl:]]", value))
}
counts_table <- read_strict_csv(args[1])
samples <- read_strict_csv(args[2])
if (!names(counts_table)[1L] %in% c("gene_id", "gene")) stop("Counts CSV first header must be gene_id (or legacy gene)")
if (!all(c("sample", "condition") %in% names(samples))) stop("samples CSV requires sample and condition columns")
gene_ids <- counts_table[[1L]]
sample_ids <- names(counts_table)[-1L]
if (!plain_labels(gene_ids) || !plain_labels(sample_ids) || !plain_labels(samples$sample)) stop("Gene and sample identifiers must be nonempty and unpadded without control characters")
if (anyDuplicated(samples$sample) || anyDuplicated(sample_ids) || anyDuplicated(gene_ids)) stop("Gene and sample identifiers must be unique")
if (nrow(counts_table) < 2L || nrow(counts_table) > 200000L || length(sample_ids) < 4L || length(sample_ids) > 1000L) stop("Count matrix must have 2..200000 genes and 4..1000 samples")
raw_counts <- as.matrix(counts_table[-1L])
if (any(!grepl("^[0-9]+$", raw_counts))) stop("Raw counts must be nonnegative integer tokens, without missing or normalized values")
matrix_counts <- matrix(as.numeric(raw_counts), nrow=nrow(raw_counts), dimnames=list(gene_ids, sample_ids))
if (any(!is.finite(matrix_counts)) || any(matrix_counts > .Machine$integer.max)) stop("Counts must be finite nonnegative 32-bit integers")
storage.mode(matrix_counts) <- "integer"
if (!setequal(samples$sample, sample_ids)) stop("Metadata samples must exactly match count columns")
samples <- samples[match(sample_ids, samples$sample),,drop=FALSE]
rownames(samples) <- samples$sample
if (!plain_labels(samples$condition)) stop("Condition labels must be nonempty and unpadded without control characters")
if (!all(args[3:4] %in% samples$condition) || args[3] == args[4]) stop("Both distinct comparison conditions must exist")
if (any(table(samples$condition)[args[3:4]] < 2)) stop("Both comparison groups require at least two samples")
design_mode <- args[6]
if (!design_mode %in% c("condition", "batch_condition", "subject_condition")) stop("Unsupported fixed design")
size_factor_type <- args[10]
if (!size_factor_type %in% c("ratio", "poscounts")) stop("Unsupported size-factor type")
alpha <- as.numeric(args[5])
min_count <- as.integer(args[7])
min_samples <- as.integer(args[8])
pca_top_genes <- as.integer(args[9])
if (!is.finite(alpha) || alpha < 0.001 || alpha > 0.5 || is.na(min_count) || min_count < 0L || min_count > 1000000L || is.na(min_samples) || min_samples < 1L || min_samples > min(100L, length(sample_ids)) || is.na(pca_top_genes) || pca_top_genes < 2L || pca_top_genes > 5000L) stop("Invalid fixed analysis thresholds")
condition_levels <- c(args[3], sort(setdiff(unique(samples$condition), args[3]), method="radix"))
samples$condition <- factor(samples$condition, levels=condition_levels)
design_formula <- ~condition
covariate <- if (design_mode == "batch_condition") "batch" else if (design_mode == "subject_condition") "subject" else NULL
if (!is.null(covariate)) {
  if (!covariate %in% names(samples) || !plain_labels(samples[[covariate]])) stop("Selected design requires complete batch or subject metadata")
  samples[[covariate]] <- factor(samples[[covariate]], levels=unique(samples[[covariate]]))
  if (nlevels(samples[[covariate]]) < 2L) stop("Selected design covariate must have at least two levels")
  design_formula <- if (design_mode == "batch_condition") ~batch+condition else ~subject+condition
}
model_matrix <- model.matrix(design_formula, samples)
if (qr(model_matrix)$rank != ncol(model_matrix)) stop("Design matrix is not full rank; check confounded batch, subject and condition labels")
if (nrow(model_matrix) <= ncol(model_matrix)) stop("Design requires positive residual degrees of freedom")
keep <- rowSums(matrix_counts >= min_count) >= min_samples
write.csv(data.frame(gene_id=gene_ids, kept=keep, reason=ifelse(keep, "kept", "below_min_count_in_min_samples")), "filter-status.csv", row.names=FALSE, na="NA")
if (sum(keep) < 2L) stop("At least two genes must pass the explicit count filter")
filtered_counts <- matrix_counts[keep,,drop=FALSE]
if (sum(apply(filtered_counts, 1L, function(row) length(unique(row)) > 1L)) < 2L) stop("At least two retained genes must have nonconstant counts")
dds <- DESeqDataSetFromMatrix(filtered_counts, samples, design_formula)
dds <- DESeq(dds, quiet=TRUE, sfType=size_factor_type)
results_table <- results(dds, contrast=c("condition", args[4], args[3]), alpha=alpha)
de <- as.data.frame(results_table)
de$status <- ifelse(de$baseMean == 0, "all_zero", ifelse(is.na(de$pvalue), "p_value_unavailable", ifelse(is.na(de$padj), "adjusted_p_value_unavailable", "available")))
cooks <- assays(dds)[["cooks"]]
de$max_cooks <- if (is.null(cooks)) rep(NA_real_, nrow(de)) else apply(cooks, 1L, function(row) if (all(is.na(row))) NA_real_ else max(row, na.rm=TRUE))
write.csv(data.frame(gene_id=rownames(de), de, check.names=FALSE), "differential-expression.csv", row.names=FALSE, na="NA")
normalized_counts <- counts(dds, normalized=TRUE)
write.csv(data.frame(gene_id=rownames(normalized_counts), normalized_counts, check.names=FALSE), "normalized-counts.csv", row.names=FALSE, na="NA")
write.csv(data.frame(sample=colnames(dds), size_factor=sizeFactors(dds)), "size-factors.csv", row.names=FALSE)
vsd <- varianceStabilizingTransformation(dds, blind=FALSE)
transformed <- assay(vsd)
feature_variance <- apply(transformed, 1L, var)
if (any(!is.finite(transformed)) || any(!is.finite(feature_variance))) stop("VST produced nonfinite values")
eligible <- which(feature_variance > 0)
if (length(eligible) < 2L) stop("PCA requires at least two nonconstant transformed features")
ordered <- eligible[order(-feature_variance[eligible], rownames(transformed)[eligible], method="radix")]
selected <- head(ordered, pca_top_genes)
pca <- prcomp(t(transformed[selected,,drop=FALSE]), center=TRUE, scale.=FALSE)
if (ncol(pca$x) < 2L || any(!is.finite(pca$x)) || sum(pca$sdev^2) <= 0) stop("PCA requires two finite components and positive total variance")
# The sign of an SVD vector is arbitrary; pin it to its largest absolute loading.
for (column in seq_len(ncol(pca$x))) {
  anchor <- which.max(abs(pca$rotation[,column]))
  if (pca$rotation[anchor,column] < 0) pca$x[,column] <- -pca$x[,column]
}
score_metadata <- samples[,c("sample", "condition", intersect(c("batch", "subject"), names(samples))),drop=FALSE]
write.csv(data.frame(score_metadata, PC1=pca$x[,1L], PC2=pca$x[,2L], check.names=FALSE), "pca-scores.csv", row.names=FALSE, na="NA")
write.csv(data.frame(component=paste0("PC", seq_along(pca$sdev)), variance_fraction=pca$sdev^2/sum(pca$sdev^2)), "pca-variance.csv", row.names=FALSE, na="NA")
write.csv(data.frame(gene_id=rownames(transformed)[selected]), "pca-features.csv", row.names=FALSE)
metadata <- c(schema="proto-agent.deseq2-analysis.v1", design=design_mode, formula=paste(deparse(design_formula), collapse=""),
  contrast_factor="condition", reference_level=args[3], comparison_level=args[4], alpha=args[5],
  min_count=args[7], min_samples=args[8], pca_top_genes=args[9], size_factor_type=size_factor_type,
  pca_transform="varianceStabilizingTransformation", pca_blind="FALSE", pca_center="TRUE", pca_scale="FALSE",
  pca_sign="largest_absolute_loading_positive", pca_feature_ties="gene_id_radix", pca_features_used=as.character(length(selected)),
  input_genes=as.character(nrow(matrix_counts)), retained_genes=as.character(sum(keep)), samples=as.character(ncol(matrix_counts)),
  model_rank=as.character(qr(model_matrix)$rank), residual_df=as.character(nrow(model_matrix)-ncol(model_matrix)),
  lfc_shrinkage="none", test="Wald", independent_filtering="TRUE", p_adjust_method="BH", cooks_cutoff="DESeq2_default",
  min_replicates_for_replace="DESeq2_default_7", counts_normalization="size_factor_scaled; not batch-corrected",
  defaults="design=condition;min_count=10;min_samples=2;pca_top_genes=500;size_factor_type=ratio;alpha=0.05",
  DESeq2_version=as.character(packageVersion("DESeq2")), R_version=R.version.string)
for (index in seq_along(condition_levels)) metadata[paste0("condition_level_", index)] <- condition_levels[index]
if (!is.null(covariate)) for (index in seq_along(levels(samples[[covariate]]))) metadata[paste0(covariate, "_level_", index)] <- levels(samples[[covariate]])[index]
write.csv(data.frame(key=names(metadata), value=unname(metadata)), "analysis-metadata.csv", row.names=FALSE, na="NA")
capture.output(sessionInfo(), file="R-session-info.txt")
writeLines(paste("Comparison:", args[4], "versus", args[3], "alpha:", args[5]), "comparison.txt")
'''


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def regular(path: Path) -> None:
    if not stat.S_ISREG(path.lstat().st_mode) or path.is_symlink():
        raise ValueError("Only regular files are allowed")


def probe(root: Path, names: list[str], cancel: Path | None = None) -> dict:
    manager = root / "bin/micromamba"
    engines = {}
    for name in names:
        environment, package, argv, allowed = ENGINES[name]
        prefix = root / "envs" / environment
        metadata = None
        for file in (prefix / "conda-meta").glob(package + "-*.json"):
            candidate = json.loads(file.read_text())
            if candidate.get("name") == package:
                metadata = {key: candidate.get(key) for key in ("name", "version", "build")}
                break
        start = time.monotonic()
        try:
            value = subprocess.Popen([str(manager), "run", "-p", str(prefix), *argv],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                     errors="replace", start_new_session=True)
            try:
                while True:
                    if cancel is not None and cancel.exists():
                        raise InterruptedError("Runtime probing cancelled")
                    if time.monotonic() - start > 30:
                        raise TimeoutError("Engine version probe exceeded 30 seconds")
                    try:
                        stdout, stderr = value.communicate(timeout=0.1)
                        break
                    except subprocess.TimeoutExpired:
                        pass
            except BaseException:
                stop_group(value)
                raise
            version_text = (stdout + stderr).strip()[:2000]
            engines[name] = {"checked": True, "available": value.returncode in allowed,
                             "exit_code": value.returncode, "version": version_text,
                             "package": metadata, "environment": environment,
                             "seconds": round(time.monotonic() - start, 3)}
        except (OSError, subprocess.SubprocessError) as exc:
            engines[name] = {"checked": True, "available": False, "version": None,
                             "package": metadata, "environment": environment, "error": str(exc)[:2000]}
    return {"checked": True, "available": all(item["available"] for item in engines.values()),
            "installation_root": str(root), "engines": engines}


def r_environment_identity(root: Path) -> dict:
    """Fixed read-only version/package query with an owned bounded process group."""
    command = [str(root / "bin/micromamba"), "run", "-p", str(root / "envs/deseq2"),
               "Rscript", "--vanilla", "-e", R_IDENTITY_SOURCE]
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, errors="replace", start_new_session=True)
        try:
            stdout, stderr = process.communicate(timeout=35)
        except BaseException:
            stop_group(process)
            raise
        if process.returncode or len(stdout.encode("utf-8")) > 1024 * 1024:
            return {"checked": True, "available": False, "exit_code": process.returncode,
                    "error": stderr[-2000:] or "R identity query exceeded its output bound"}
        reader = csv.DictReader(io.StringIO(stdout), delimiter="\t")
        if reader.fieldnames != ["kind", "name", "version", "location"]:
            raise ValueError("Unexpected R identity columns")
        rows = list(reader)
        if not 5 <= len(rows) <= 10000 or any(set(row) != set(reader.fieldnames) or any(not isinstance(value, str) or len(value) > 4096 for value in row.values()) for row in rows):
            raise ValueError("R identity exceeds structural limits")
        runtime = {row["name"]: row["version"] for row in rows if row["kind"] == "runtime"}
        if set(runtime) != {"R", "DESeq2", "platform", "arch"} or sum(row["kind"] == "runtime" for row in rows) != 4:
            raise ValueError("R identity lacks required runtime fields")
        packages = [{key: row[key] for key in ("name", "version", "location")} for row in rows if row["kind"] == "package"]
        if len(packages) != len(rows) - 4 or not any(row["name"] == "DESeq2" and row["version"] == runtime["DESeq2"] for row in packages):
            raise ValueError("R installed package inventory does not match DESeq2")
        packages.sort(key=lambda row: (row["name"], row["version"], row["location"]))
        encoded = json.dumps(packages, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        return {"checked": True, "available": True, "identity": {**runtime, "package_count": len(packages),
                "packages_sha256": hashlib.sha256(encoded).hexdigest(), "query_sha256": hashlib.sha256(R_IDENTITY_SOURCE.encode()).hexdigest(),
                "scope": "Installed R package versions and library locations; not binary attestation or a fitted result"}}
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        return {"checked": True, "available": False, "error": str(exc)[:2000]}


def plan(operation: str, arguments: dict, inputs: dict[str, str], output: Path) -> list[tuple[list[str], str | None]]:
    """Construct only fixed argv templates; caller values never become source code."""
    if operation == "samtools_sort_index":
        return [(["samtools", "sort", "-@", "2", "-o", "sorted.bam", inputs["alignment"]], None),
                (["samtools", "index", "sorted.bam"], None), (["samtools", "flagstat", "sorted.bam"], "flagstat.txt")]
    if operation == "bcftools_stats":
        return [(["bcftools", "stats", inputs["variants"]], "variant-statistics.txt")]
    if operation == "gatk_mutect2":
        # Index only run-local copies, never original input files.
        reference = output / "reference.fa"
        shutil.copyfile(inputs["reference"], reference)
        steps = [(["samtools", "faidx", "reference.fa"], None),
                 (["gatk", "--java-options", "-Xmx4g", "CreateSequenceDictionary", "-R", "reference.fa", "-O", "reference.dict"], None)]
        command = ["gatk", "--java-options", "-Xmx4g", "Mutect2", "-R", "reference.fa", "-I", "tumor.bam", "-O", "unfiltered-variants.vcf.gz"]
        for field, filename in (("tumor_bam", "tumor.bam"), ("normal_bam", "normal.bam")):
            if field in inputs:
                shutil.copyfile(inputs[field], output / filename)
                steps.append((["samtools", "index", filename], None))
        if "normal_bam" in inputs:
            command.extend(["-I", "normal.bam", "-normal", arguments["normal_sample"]])
        if "intervals" in inputs:
            command.extend(["-L", inputs["intervals"]])
        steps.append((command, None))
        return steps
    if operation == "snpeff_annotate":
        database = output / "snpeff-data" / "proto_local"
        database.mkdir(parents=True)
        shutil.copyfile(inputs["reference"], database / "sequences.fa")
        shutil.copyfile(inputs["genes"], database / "genes.gff")
        (output / "snpeff.config").write_text("proto_local.genome : Supplied local reference\n")
        shared = ["-c", "snpeff.config", "-dataDir", str(output / "snpeff-data")]
        return [(["snpEff", "build", "-gff3", "-noCheckCds", "-noCheckProtein", *shared, "proto_local"], None),
                (["snpEff", "-noStats", "-noDownload", *shared, "proto_local", inputs["variants"]], "annotated-variants.vcf")]
    if operation == "lumpy_bedpe":
        return [(["lumpy", "-g", inputs["chromosomes"], "-mw", str(arguments.get("minimum_weight", 1)), "-msw", "1",
                  "-bedpe", "bedpe_file:" + inputs["bedpe"] + ",id:sample,weight:1"], "structural-variants.vcf")]
    if operation == "cnvkit_call":
        argv = ["cnvkit.py", "call", inputs["segments"], "-m", "clonal", "--ploidy", str(arguments.get("ploidy", 2)), "-o", "called.cns"]
        if "purity" in arguments:
            argv.extend(["--purity", str(arguments["purity"])])
        return [(argv, None)]
    if operation == "prokka_annotate":
        return [(["prokka", "--outdir", "annotation", "--prefix", "annotation", "--locustag", "PROTO", "--cpus", "2",
                  "--kingdom", arguments.get("kingdom", "Bacteria"), "--mincontiglen", str(arguments.get("minimum_contig_length", 200)), inputs["contigs"]], None)]
    if operation == "deseq2_fit":
        (output / "analysis.R").write_text(DESEQ2_SOURCE)
        return [(["Rscript", "--vanilla", "analysis.R", inputs["counts"], inputs["samples"], arguments["reference_level"],
                  arguments["comparison_level"], str(arguments.get("alpha", 0.05)), arguments.get("design", "condition"),
                  str(arguments.get("min_count", 10)), str(arguments.get("min_samples", 2)),
                  str(arguments.get("pca_top_genes", 500)), arguments.get("size_factor_type", "ratio")], None)]
    if operation == "nucmer_align":
        return [(["nucmer", "--threads", "2", "--minmatch", str(arguments.get("minimum_match", 20)), "--mincluster", str(arguments.get("minimum_cluster", 65)),
                  "--prefix", "alignment", inputs["reference"], inputs["query"]], None),
                (["show-coords", "-rcl", "alignment.delta"], "alignment-coordinates.txt")]
    raise ValueError("Unknown operation")


def limits() -> None:
    if resource is None:
        raise RuntimeError("The trusted bioinformatics worker requires Linux")
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_FILE, MAX_FILE))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (512, 512))


def stop_group(process: subprocess.Popen) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=3)


def output_files(output: Path) -> list[Path]:
    items, total = [], 0
    for file in output.rglob("*"):
        if file.is_symlink():
            raise ValueError("Engine produced a symlink")
        if file.is_dir():
            continue
        regular(file)
        size = file.stat().st_size
        total += size
        if size > MAX_FILE or total > MAX_TOTAL or len(items) >= MAX_FILES:
            raise ValueError("Engine outputs exceed file or byte limits")
        items.append(file)
    return items


def run(root: Path, job: Path, request_sha256: str) -> dict:
    if job.is_symlink() or not job.is_dir():
        raise ValueError("Job must be a regular directory")
    job = job.resolve(strict=True)
    request_path = job / "worker-request.json"
    regular(request_path)
    if request_path.stat().st_size > 128 * 1024:
        raise ValueError("Job request exceeds limit")
    request_bytes = request_path.read_bytes()
    if hashlib.sha256(request_bytes).hexdigest() != request_sha256:
        raise ValueError("Worker request changed after host validation")
    request = json.loads(request_bytes.decode("utf-8"))
    operation = request["operation"]
    if operation not in OPERATION_ENGINES:
        raise ValueError("Unknown operation")
    engine = OPERATION_ENGINES[operation]
    required = [engine, "samtools"] if engine == "gatk" else [engine]
    start = time.monotonic()
    deadline = start + min(1800, max(1, int(request.get("timeout_seconds", 1800))))
    cancel = job / "CANCEL"
    receipt = {"ok": False, "status": "failed", "steps": [], "runtime": {}, "error": None}
    parent = root / "runs"
    parent.mkdir(parents=True, exist_ok=True)
    if parent.is_symlink() or any(char.isspace() for char in str(parent)):
        raise ValueError("Linux execution root must be a regular path without spaces")
    work = Path(tempfile.mkdtemp(prefix="job-", dir=parent))
    output = work / "outputs"
    output.mkdir()
    try:
        if cancel.exists():
            raise InterruptedError("Cancelled before execution")
        receipt["runtime"] = probe(root, required, cancel)
        if cancel.exists():
            raise InterruptedError("Runtime probing cancelled")
        if not receipt["runtime"]["available"]:
            raise RuntimeError("A required engine is unavailable; inspect runtime status")
        files, total = {}, 0
        inputs = work / "inputs"
        inputs.mkdir()
        for field, descriptor in request["files"].items():
            relative = Path(descriptor["file"])
            if relative.is_absolute() or len(relative.parts) != 2 or relative.parts[0] != "inputs" or any(part in {".", ".."} for part in relative.parts):
                raise ValueError("Invalid input snapshot path")
            source = job / relative
            if source.parent.is_symlink():
                raise ValueError("Symlink input directory")
            regular(source)
            total += source.stat().st_size
            if source.stat().st_size > MAX_FILE or total > MAX_TOTAL:
                raise ValueError("Input size limit exceeded")
            target = inputs / source.name
            with source.open("rb") as reader, target.open("xb") as writer:
                for chunk in iter(lambda: reader.read(1024 * 1024), b""):
                    if cancel.exists():
                        raise InterruptedError("Input staging cancelled")
                    if time.monotonic() > deadline:
                        raise TimeoutError("Input staging deadline exceeded")
                    writer.write(chunk)
            if digest(target) != descriptor["sha256"]:
                raise ValueError("Input changed after snapshot; hash does not match")
            files[field] = str(target)
        steps = plan(operation, request["arguments"], files, output)
        for index, (argv, capture) in enumerate(steps):
            if cancel.exists():
                raise InterruptedError("Cancelled before the next engine step")
            if time.monotonic() > deadline:
                raise TimeoutError("Execution deadline exceeded")
            environment = ENGINES[engine][0]
            command = [str(root / "bin/micromamba"), "run", "-p", str(root / "envs" / environment), *argv]
            step = {"argv": argv, "environment": environment, "exit_code": None}
            receipt["steps"].append(step)
            with (output / f"step-{index + 1}.log").open("wb") as log:
                captured = (output / capture).open("wb") if capture else None
                try:
                    process = subprocess.Popen(command, cwd=output, stdout=captured or log, stderr=log,
                                               start_new_session=True, preexec_fn=limits,
                                               env={**os.environ, "OMP_NUM_THREADS": "2", "OPENBLAS_NUM_THREADS": "2"})
                    try:
                        while process.poll() is None:
                            if cancel.exists():
                                raise InterruptedError("Execution cancelled; process group stopped")
                            if time.monotonic() > deadline:
                                raise TimeoutError("Execution deadline exceeded; process group stopped")
                            output_files(output)
                            time.sleep(0.1)
                    except BaseException:
                        stop_group(process)
                        raise
                    step["exit_code"] = process.returncode
                    if process.returncode:
                        raise RuntimeError(f"{argv[0]} exited with code {process.returncode}; inspect step-{index + 1}.log")
                finally:
                    if captured:
                        captured.close()
        receipt.update({"ok": True, "status": "completed"})
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        receipt.update({"ok": False, "status": "cancelled" if isinstance(exc, InterruptedError) else "timeout" if isinstance(exc, TimeoutError) else "failed", "error": str(exc)[:4000]})
    finally:
        try:
            destination = job / "outputs"
            if destination.is_symlink() or not destination.is_dir():
                raise ValueError("Output destination is not a regular directory")
            for file in output_files(output):
                target = destination / file.relative_to(output)
                target.parent.mkdir(parents=True, exist_ok=True)
                current = target.parent
                while current != destination:
                    if current.is_symlink():
                        raise ValueError("Output destination contains a symlink")
                    current = current.parent
                with file.open("rb") as reader, target.open("xb") as writer:
                    shutil.copyfileobj(reader, writer, 1024 * 1024)
        except (OSError, ValueError) as exc:
            receipt.update({"ok": False, "status": "failed", "error": str(exc)[:4000]})
        receipt["seconds"] = round(time.monotonic() - start, 3)
        (job / "worker-result.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
        # Only this newly created Linux scratch directory can be removed.
        if work.resolve().parent == parent.resolve() and work.name.startswith("job-") and not work.is_symlink():
            shutil.rmtree(work)
    return receipt


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["status", "identity", "run"])
    parser.add_argument("--root", default=str(Path.home() / ".local/share/proto-bio"))
    parser.add_argument("--engine", choices=list(ENGINES))
    parser.add_argument("--job")
    parser.add_argument("--request-sha256")
    args = parser.parse_args()
    root = Path(args.root).expanduser().resolve(strict=True)
    if args.action == "status":
        print(json.dumps(probe(root, [args.engine] if args.engine else list(ENGINES))))
        return 0
    if args.action == "identity":
        if args.engine != "deseq2":
            parser.error("identity currently requires --engine deseq2")
        identity = r_environment_identity(root)
        print(json.dumps(identity))
        return 0 if identity["available"] else 1
    if not args.job or not args.request_sha256:
        parser.error("run requires --job and --request-sha256")
    result = run(root, Path(args.job), args.request_sha256)
    print(json.dumps({"ok": result["ok"], "status": result["status"]}))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
