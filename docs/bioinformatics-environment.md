# Bioinformatics environment

Installed and verified on 2026-09-19 in **Ubuntu-24.04 (WSL2)**, user `openclaw`.
The isolated installation is `/home/openclaw/.local/share/proto-bio`; the system
Python and R are unchanged. The environment manager is the official micromamba
distribution; packages come from conda-forge and Bioconda with strict priority.

| Requested engine | Installed package version | Environment | Actual smoke calculation |
| --- | --- | --- | --- |
| GATK Mutect2 | GATK 4.6.2.0 | variants | Synthetic BAM to VCF |
| samtools | 1.24 | variants | Sort, BAM index, FASTA index |
| bcftools | 1.24 | variants | Read/query synthetic VCF |
| SnpEff | 5.4.0c | variants | Build toy annotation database and annotate VCF |
| LUMPY | lumpy-sv 0.3.1 | lumpy | Synthetic BEDPE deletion call |
| CNVkit | 0.9.14 | cnvkit | Segment calls produce copy numbers 2, 1 and 4 |
| Prokka | 1.15.6 | prokka | Complete toy-contig annotation and output generation |
| DESeq2 | 1.50.2; R 4.5.3 | deseq2 | Fit 100 genes in 6 samples; finite size factors |
| nucmer | MUMmer4 4.0.1 | mummer | Recover the expected 2,000 bp alignment |

The LUMPY package metadata is 0.3.1; its executable retains an older 0.2.13
version string. The exact package builds and dependency URLs are preserved in
`build/bioinformatics-qa/final/environment-locks/`.

All **27** consolidated checks passed. The machine-readable report is
`build/bioinformatics-qa/final/summary.json`, with logs, inputs and outputs beside
it. Earlier failed fixture attempts remain in the parent QA directory as history;
the final directory contains the corrected, passing suite. MUMmer tests run in a
Linux path without spaces because its delta format embeds unquoted input paths.
LUMPY's BEDPE fixture includes chromosome order and `TYPE:DELETION` metadata.

These checks use synthetic development fixtures. They establish installation and
software execution, not accuracy on real biological samples. Prokka completed on
random toy contigs; this is not a validated annotation result. SnpEff's toy model
can report transcript warnings. No large organism-specific reference databases
were downloaded; those remain explicit inputs to real analyses.

## Local use and reproduction

From the repository in PowerShell, a convenience launcher forwards an argument
array to the selected WSL environment:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-bioinformatics.ps1 -Tool samtools --version
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-bioinformatics.ps1 -Tool gatk --version
```

File arguments passed to Linux tools use Linux/WSL paths. For analyses whose
formats contain embedded absolute paths, use a Linux work directory without
spaces. The launcher preserves the real engine exit code.

The installation script is `scripts/install-bioinformatics-wsl.sh`. The full
verification entrypoint is `scripts/verify-bioinformatics-suite-wsl.py`, executed
with WSL's Python and a destination under the repository's `build/` directory.
It runs the actual engines and copies the environment locks into the report.

## Unified Chat tools

The installed engines now have one typed catalogue and one execution interface:
`proto_bioinformatics_catalog` and `proto_bioinformatics_run`. Chat discovers these
through the shared science registry; the existing scientific-computation module
controls whether they are enabled. Each engine has a reviewed operation rather
than a second generic shell or code-execution interface.

| Operation | Required workspace inputs | Principal outputs |
| --- | --- | --- |
| `gatk_mutect2` | Reference FASTA and coordinate-sorted tumor BAM; optional matched normal and BED intervals | Unfiltered candidate VCF, index, statistics and logs |
| `samtools_sort_index` | SAM or BAM | Sorted BAM, BAM index and flagstat report |
| `bcftools_stats` | VCF, compressed VCF or BCF | Variant statistics |
| `snpeff_annotate` | VCF, reference FASTA and matching GFF3 | Run-local annotation database and annotated VCF |
| `lumpy_bedpe` | BEDPE with LUMPY TYPE metadata and chromosome lengths | Structural-variant VCF |
| `cnvkit_call` | CNVkit CNS segmentation | Integer copy-number calls |
| `prokka_annotate` | Prokaryotic FASTA contigs | GFF, GenBank, sequence files and annotation report |
| `deseq2_fit` | Raw integer count CSV and sample-condition CSV; explicit reference/comparison levels | Differential-expression table, normalized counts, size factors and R session metadata |
| `nucmer_align` | Reference and query FASTA | Delta alignment and coordinates |

The RNA-seq increment extends `deseq2_fit` with fixed condition, batch-condition
and subject-condition designs, explicit prefilter and size-factor choices, VST
PCA, full gene-filter status and method metadata. Optional sample annotations
remain in PCA output even when excluded from the selected formula. Missing test
statistics are retained as NA in CSV. See [RNA-seq studies](rnaseq-studies.md) for
the integrated Compute surface and its stricter count-matrix bounds.

Call the catalogue with an `operation` to obtain its complete JSON schema and
example. `probe: true` checks the actual executable and reports its current output
and installed package version separately; without a probe, availability is unknown,
not assumed connected. Every execution also probes its required engines.

Save a request in the workspace, then pass its relative path to the run tool:

```json
{
  "operation": "nucmer_align",
  "arguments": {
    "reference": "data/reference.fa",
    "query": "data/query.fa"
  }
}
```

The result contains `ok`, `status`, actual engine versions, exit codes, per-step
arguments, and artifact paths with SHA-256 hashes. Full logs, immutable input
snapshots and a manifest are saved under `build/bioinformatics/<run-id>/`.
Failures and cancelled jobs retain their diagnostic manifest and partial logs.

The adapter accepts workspace-relative regular files, rejects traversal and
symlinks, and snapshots inputs before invoking WSL. The worker verifies both the
validated request hash and each input hash, uses a fresh Linux directory without
spaces, and invokes fixed argument arrays without a shell. It does not accept an
arbitrary command, script, formula, or additional CLI flags. DESeq2 uses a fixed
`~condition` design; labels are passed as data. SnpEff builds only from the supplied
FASTA/GFF3 and does not download reference databases. Its build omits comparisons
to separate CDS/protein reference files because those files are not supplied;
annotation warnings remain in the logs.

Each job permits at most 2 GiB per file, 4 GiB combined inputs or outputs, 1,000
output files and 30 minutes. Cancellation stops the Linux process group, including
children, and removes only the newly created scratch directory. The Chat turn
budget can stop a job earlier. GATK candidates still require appropriate downstream
filtering and scientific review; these adapters do not assert biological or clinical
validity.

The default distribution is `Ubuntu-24.04`, using its configured default user and
`~/.local/share/proto-bio`. An administrator can set
`PROTO_AGENT_BIO_WSL_DISTRO` and `PROTO_AGENT_BIO_ROOT` in the Workbench environment;
these settings are not model-supplied arguments. The worker source is included in
the packaged sidecar at `proto_agent/bioinformatics_worker.py`.

## Adapter acceptance

`scripts/verify-bioinformatics-adapter.py` runs all nine operations through the same
adapter used by Chat and validates meaningful outputs: the expected 30 alignments,
one VCF record, variant annotations, a BEDPE deletion, copy numbers 2/1/4, annotation
files, 100 DESeq2 result rows, and the expected 2,000 bp alignment. It also performs
a live cancellation check. The ten checks and their fresh receipts are recorded in
`build/bioinformatics-adapter-qa/summary.json`.

Thirteen host tests cover schemas, path boundaries, snapshots, artifact hashes,
configuration, cancellation state, packaging and honest failures. Four tests run
inside WSL additionally verify changed-request and changed-input rejection,
symlink rejection, actual parent/child process cancellation and scratch cleanup.
The original 27 installation checks remain available independently.

These trusted fixed-engine adapters are separate from the OCI sandbox used for
general model-authored Python/R and Notebook execution. Enabling one does not
weaken the other's execution policy.
