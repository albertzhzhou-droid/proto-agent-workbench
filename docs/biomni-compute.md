# Biomni scientific computing in Proto Workbench

See [the chemistry and biology expansion](science-tool-expansion.md) for the nine newest methods and live source UI.

The historical [UI integration and acceptance report](compute-ui-integration.md)
documents the earlier 124-method catalog, shared forms, result views and desktop checks.

Proto provides 127 local calculations for statistical analysis and existing
biological data. One hundred nine adapt selected Biomni source functions; eighteen
are separately labelled Proto-native companion calculations. Batch-3 tools
read bounded binary workspace inputs (FCS flow-cytometry files, PDB structures,
images, UCSC chain files) and batch-4 tools extend this to frame sequences and
medical volumes (time-lapse microscopy stacks, micro-CT slices, NIfTI MRI and
DWI series, cooler Hi-C files, SBML metabolic models) through per-tool path
containment, extension whitelists, size caps, list-form multi-file inputs, and
input hashing in the run manifest. A separate connector subsystem exposes
network APIs, whitelisted external programs, and the DDInter data lake; every
connector ships disabled in `connectors/remote_apis.json` and remote tools are
never auto-approved. The [source audit](biomni-source-audit.md)
and [complete upstream inventory](biomni-upstream-inventory.json) document the
pinned source, license, changes, and unported capabilities.
See [local verification and remaining limits](biomni-verification.md) for tested
behavior, runtime evidence and the unrelated full-suite failure.

The RNA-seq study uses the same Compute request, saved-run and research-project
contracts. Its validation mode checks raw counts and a fixed sample design locally;
fit mode explicitly invokes the existing local DESeq2 bioinformatics adapter.
It does not replace that engine or accept arbitrary R formulas/code. See
[the RNA-seq study contract](rnaseq-studies.md) for data, inference and result limits.

## Run locally

Install the optional numerical dependencies into the project environment:

```powershell
.\.venv\Scripts\python.exe -m pip install -e ".[compute]"
```

The lock pins NumPy 2.2.6 and SciPy 1.15.3. Seventeen sequence- and
structure-counting tools work without them. Importing the CLI and listing the
catalog do not load NumPy, SciPy, the Biomni agent, or model weights.
For MCP on Windows, the first computation initializes the installed numerical
extensions on the reader thread before dispatching work. This avoids a native
extension import stall while that thread is waiting on standard input.

```powershell
proto-agent compute catalog
proto-agent compute catalog --tool compare_two_groups
proto-agent compute run examples/compute/two-groups.json
proto-agent compute run examples/compute/rna-features.json
proto-agent compute run examples/compute/enrichment.json
```

Every request is a UTF-8 JSON object with exactly two keys:

```json
{
  "tool": "compare_two_groups",
  "arguments": {
    "group_a": [1, 2, 3, 4, 5],
    "group_b": [2, 3, 4, 5, 6],
    "method": "welch_t"
  }
}
```

The checked-in examples and catalog examples are synthetic software fixtures.
Their identifiers are illustrative labels, not biological part records. A
catalog detail response contains the current `input_schema` and `example`
arguments for that computation. Unknown fields, nonfinite values, duplicate JSON
keys, excessive input sizes, and invalid statistical cases are rejected with
structured diagnostics. Missing dependencies are reported as
`COMPUTE_DEPENDENCY_MISSING`; they are never silently installed.

## Workbench access

In **Settings > Modules**, enable **Biomni scientific computing**, or choose the
**Full** module profile. This exposes two MCP tools to the existing Harness:

| Tool | Operation |
| --- | --- |
| `proto_compute_catalog` | List availability and attribution; supply `tool` to get its schema and example. |
| `proto_compute_run` | Supply `path` to an existing workspace request JSON. Run a fixed computation and publish its evidence. |

Example task: "Use the Biomni computing module to analyze
examples/compute/two-groups.json. Report the test, sample sizes, p-value, and
limitations, and link the result and provenance artifacts."

Use Act mode for result publication. The compute tool participates in the
workspace write queue and artifact receipt hashing. It runs a reviewed local
implementation; it has no parameter for arbitrary scripts or command lines.
Model selection and inference continue through the existing LM Studio provider.
The module is optional and is not implicitly enabled in an existing workspace.

Source checkouts need an updated sidecar and desktop build to expose the tools
in Electron. The existing released installer does not acquire new functions
until rebuilt. Desktop builders install `.[workbench,compute]` before running
the existing locked sidecar and desktop build scripts.

## Available calculations

| Calculation | Important contract |
| --- | --- |
| Descriptive statistics | Sample variance/standard error, linear-interpolation quantiles. |
| Two-group comparison | Two-sided Welch, Student, paired t, or Mann-Whitney U; paired order is explicit. |
| Correlation | Pearson or Spearman; reports correlation without a causal claim. |
| Linear regression | One predictor, intercept, two-sided slope inference and residuals. |
| One-way ANOVA | Classical equal-variance independent-group assumptions. |
| P-value adjustment | BH, Holm, or Bonferroni across the supplied full test family. |
| PCA | Rows are observations; optional sample-standard-deviation scaling. |
| Contingency tests | Chi-square without Yates correction, or two-sided 2x2 Fisher exact. |
| RNA structure features | Supplied nested dot-bracket topology; no structure prediction or energy estimate. |
| N-glycosylation motifs | Canonical sequon positions; does not confirm glycosylation. |
| O-glycosylation hotspots | Explicitly unvalidated S/T-density heuristic. |
| Protein conservation | Prealigned equal-length canonical sequences only; gaps reduce coverage. |
| Gene-set over-representation | Explicit background and input sets; hypergeometric tail and BH across all sets. No online Enrichr or ranked GSEA. |
| Cosinor | User-specified period; harmonic fit with explicit phase convention. |
| Michaelis-Menten | Supplied substrate concentrations and measured velocities; fitted Vmax/Km, no generated observations or kcat. |

### Sequence and cloning

| Calculation | Important contract |
| --- | --- |
| Open reading frame annotation | Find ATG-to-stop ORFs across reading frames with an embedded standard codon table; not evidence of translation. |
| Primer-to-target alignment | Scan short sequences against a longer target on both strands allowing up to three substitutions per window. |
| PCR amplification simulation | Predict amplicons from a template and primer pair, including circular wrap-around products. |
| Restriction digest simulation | Compute digestion fragments from a curated enzyme table with explicit cut offsets; linear or circular topology. |
| Restriction site mapping | Report recognition sequences, cut offsets, overhang type, and top-strand cut indices per requested enzyme. |
| Common-enzyme site scan | Scan the curated common-enzyme table and list every enzyme with at least one cut site in the sequence. |
| Aligned-sequence mutation list | List substitutions between a query and reference as RefPosQuery labels; inputs must be prealigned. |
| Single primer designer | Choose the best-scoring primer in a window by GC content and Wallace-rule Tm. |
| Sanger verification primer plan | Cover a target region greedily with existing primers plus newly designed walkers using a fixed read length. |
| Golden Gate oligo designer | Derive insert oligos carrying the backbone's Type IIS overhangs for a supported enzyme. |
| Golden Gate assembly prediction | Chain fragment overhangs through two backbone Type IIS cuts and report the predicted construct sequence. |
| Codon usage optimization | Replace each codon with the highest-host-frequency synonym under the standard genetic code and return the optimized sequence. |
| sgRNA spacer scan | Find candidate 17-25 nt spacers upstream of a supplied PAM (default NGG) on both strands with GC bounds; no activity prediction. |

### Dynamical-systems simulation

| Calculation | Important contract |
| --- | --- |
| Whole-cell ODE simulation | Integrate upstream's fixed four-state mRNA/protein/metabolite/ATP model; no custom code execution. |
| Bacterial population ODE | Simulate logistic growth with clearance toward a niche capacity and report steady-state behavior. |
| Generalized Lotka-Volterra dynamics | Integrate multi-species gLV dynamics from a growth-rate vector and interaction matrix. |
| Gillespie population simulation | Seeded stochastic birth-death simulation with logistic growth and per-species carrying capacities. |
| Thyroid hormone PK simulation | Integrate the five-species T4/TBG transport, binding, and deiodination compartment model. |
| Renin-angiotensin cascade simulation | Integrate the six-species RAS ODE cascade with angiotensin-II feedback on renin release. |
| Dimerization equilibrium | Find equilibrium monomer and dimer concentrations for a mass-action network with k_off fixed at 1.0. |
| Signaling network logic model | Integrate a Hill-function activation/inhibition logic ODE network over declared proteins. |
| Gene circuit with growth feedback | Integrate Hill-regulated gene expression coupled to burden-limited cell-mass growth; dilution corrected. |
| Bifurcation regime classification | Classify parameter-swept time series into stable, periodic, and chaotic regimes with transition points. |
| Flux balance analysis | Maximize an objective flux subject to steady-state mass balance over a JSON reaction network (scipy HiGHS LP). |
| Anaerobic digestion surrogate optimization | Optimize upstream's toy quadratic surrogate for VFA or methane over HRT/OLR/I-F/temperature/pH ranges. |

### Assay and instrument data

| Calculation | Important contract |
| --- | --- |
| Circular dichroism analysis | Classify CD spectra by wavelength-band sign counting and estimate a midpoint Tm from thermal melts; qualitative. |
| ITC one-site binding fit | Fit Kd, stoichiometry, and enthalpy from differential ITC heats with a corrected one-site quadratic isotherm. |
| Logistic growth curve fit | Fit carrying capacity, rate, doubling time, and an approximate lag from OD600 time series. |
| Gompertz growth rate fit | Fit Zwietering Gompertz parameters with a corrected specific-rate doubling time from OD600 data. |
| Cell-cycle phase estimation | Fit G1/S/G2-M durations and death rate to dual-nucleoside pulse-labeling percentages with upstream's simplified model. |
| ELISA titer quantification | Quantify antibody titers from sample ODs against per-antibody linear standard curves with group summaries. |
| Arsenic speciation quantification | Assign HPLC-ICP-MS peaks to arsenic species by retention window and quantify with calibration factors. |
| Serial-dilution CFU planning | Simulate expected spot-count outcomes for a dilution series with seeded Poisson counts (planning aid, not a measurement). |
| Biofilm biomass quantification | Control-subtracted crystal violet OD statistics with replicate-aware one-sample t-tests. |
| ATP luminescence quantification | Convert luminescence to ATP concentration via a linear standard curve with optional cell-count or protein normalization. |
| Drug release kinetics | Fit zero-order, first-order, Higuchi, and Korsmeyer-Peppas models to cumulative release data and pick the best by R-squared. |
| Accelerated stability screening | Rule-of-thumb accelerated stability screening (rate doubling per 10C) across formulations and conditions. |
| ABR wave-I metrics | Extract the P1 (wave I) amplitude and latency from an auditory brainstem response waveform. |
| Endo-lysosomal calcium dynamics | Baseline-normalized luminescence traces, detect calcium peaks, and quantify response kinetics and excess AUC. |
| GC fatty acid composition | Aggregate gas-chromatography peaks into reference retention windows and report area-percent composition. |
| Hemodynamic parameter extraction | Bandpass-filter arterial pressure and derive SBP, DBP, MAP, and heart rate from beat detection. |
| Barcode sequencing analysis | Extract barcodes from supplied reads by flanking sequences, quantify abundances, and cluster lineages by corrected Hamming linkage. |

### Clinical and pharmacometric analysis

| Calculation | Important contract |
| --- | --- |
| VCOG-CTCAE adverse event grading | Grade veterinary adverse events (v1.1) from numeric bands with severity fallback; supports review, not clinical decisions. |
| Radiolabeled antibody biodistribution | Fit per-tissue bi-exponential pharmacokinetics and tumor-to-normal ratios from time-activity data. |
| Alpha-particle MIRD dosimetry | Estimate organ absorbed doses from decay-corrected cumulated activities and S-factors under the MIRD schema. |
| MWAS metabolizer association | Test each methylation row for association with CYP2C19 metabolizer status by multiple regression with Bonferroni correction. |
| Xenograft TGI analysis | Summarize tumor growth curves with TGI, per-subject growth slopes, two-way ANOVA, and final-day Tukey HSD. |

### Genomics matrices

| Calculation | Important contract |
| --- | --- |
| Genomic region overlap | Pairwise overlap statistics between named interval sets with merged half-open interval algebra and union base counts. |
| GBLUP genomic prediction | Fit additive (optionally additive+dominance) genomic relationship models and report heritability and in-sample accuracy. |
| Gene expression NMF | Extract metagenes from a nonnegative expression matrix with seeded multiplicative-update NMF. |

## Evidence and interpretation

Each successful run creates a unique `build/compute/<run-id>/` directory:

- `input.json`: the exact request snapshot used, including UTF-8 BOM if present.
- `result.json`: finite, structured numerical results and tool-specific limitations.
- `manifest.json`: original path/hash, upstream function mapping, implementation
  version, runtime package versions, result hash, and `human_review_required`.
- `provenance.json`: an unsigned content-addressed statement binding the manifest,
  request snapshot, and result; verify it with `proto-agent provenance verify`.

The manifest records the original source hash at execution. Provenance verifies
the captured snapshot, so editing the original request afterward does not
rewrite earlier evidence. Modifying captured artifacts causes verification to
fail. Large results remain in the artifact; the MCP response omits previews above
24,000 characters.

The software validates data shape, numerical conditions and file provenance.
Users must assess study design, independence, distributional assumptions, units,
multiple-testing families, alignment quality and biological interpretation.
Successful computation grants no design eligibility or clinical validity.

## Deferred capabilities

The remaining Biomni inventory is documented rather than advertised as installed.
Single-cell model pipelines, online reference databases, genome aligners,
GPU inference, imaging workflows and external executables require separate
dependency, data-license and numerical acceptance work. Biomni's general code
agent, datalake and lab automation are outside this computational port.
