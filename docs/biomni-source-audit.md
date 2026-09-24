# Biomni source audit and computational port

Proto's Biomni integration targets local statistical analysis and calculations on
user-supplied biological data. After the second port batch it consists of
fifty-five scoped Biomni adaptations and ten Proto-native companion tools. It
does not claim to reproduce all Biomni tools, the hosted Stanford service, or
the Biomni agent runtime.

## Source identity and reproducibility

- Official website: [Biomni at Stanford](https://biomni.stanford.edu/).
- Official repository: [snap-stanford/Biomni](https://github.com/snap-stanford/Biomni).
- Inspected commit: [`400c1f366b96a35ca253e13c9b06c5076af41d65`](https://github.com/snap-stanford/Biomni/commit/400c1f366b96a35ca253e13c9b06c5076af41d65).
- Commit timestamp: `2026-01-15T04:23:42Z`; source retrieved on `2026-09-18`.
- Audit method: read source and parse Python syntax trees. Upstream setup scripts,
  imports, agent execution, data downloads, and model downloads were not run.
- Machine-readable inventory: [biomni-upstream-inventory.json](biomni-upstream-inventory.json).

The inventory covers all 227 public top-level function definitions in
`biomni/tool/*.py` at the pinned commit: 24 modules, of which 22 contain such
functions. This is a source inventory, not a claim that all 227 are computational
or scientifically validated. It excludes private helpers, class methods, nested
functions, protocol documents, and functions supplied by external packages.

The upstream tool-description files list 224 entries. Of those, 223 match the
public implementations. `create_registration_visualization` is described but
has no matching top-level implementation; `clear_captured_plots`,
`get_captured_plots`, `get_hpo_names`, and `preprocess_image` are implemented but
not listed in those descriptors. The inventory records these differences rather
than treating metadata as evidence of runnable capability.

Module SHA-256 values below use the exact committed file bytes, unaffected by
Windows checkout line-ending conversion. The JSON records hashes for every
module, signatures, source line ranges, direct imports, port status, and pinned
source URLs.

| Source file | SHA-256 |
| --- | --- |
| `biomni/tool/biochemistry.py` | `9b8ea7ea1f712553025bdaf16f981d8bec62df6004efd0954ed90f33a394e018` |
| `biomni/tool/glycoengineering.py` | `ed3726d318f239e98183a359f18bcd341f4159ef2e400322c6141f77dcd2aff2` |
| `biomni/tool/genomics.py` | `74714f05594d4655e946107628114339452cab8eecbb4005feccea49be2906c5` |
| `biomni/tool/physiology.py` | `18a864d4b3c68e3290b105ac686cf2536d890c5d122779926c62dcce1ff30d55` |
| `LICENSE` | `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` |

## Computational scope

The upstream public functions generally return prose research logs and often
write files or invoke external software. Proto adapts selected calculations to
validated JSON inputs and structured, finite numerical results. The shared
capability names identify their source relationship; their input and output
contracts are deliberately scoped rather than API-compatible replacements.

| Proto capability | Upstream source | Scope and changes |
| --- | --- | --- |
| `analyze_rna_secondary_structure_features` | [biochemistry.py, lines 160-304](https://github.com/snap-stanford/Biomni/blob/400c1f366b96a35ca253e13c9b06c5076af41d65/biomni/tool/biochemistry.py#L160-L304) | Counts supplied structural base pairs, stems, and explicitly defined hairpins. Validates notation. Omits the upstream illustrative energy estimate. |
| `find_n_glycosylation_motifs` | [glycoengineering.py](https://github.com/snap-stanford/Biomni/blob/400c1f366b96a35ca253e13c9b06c5076af41d65/biomni/tool/glycoengineering.py) | Scans canonical N-X-S/T sequons with X other than proline. Reports motif positions; a motif is not evidence of actual glycosylation. |
| `predict_o_glycosylation_hotspots` | [glycoengineering.py](https://github.com/snap-stanford/Biomni/blob/400c1f366b96a35ca253e13c9b06c5076af41d65/biomni/tool/glycoengineering.py) | Preserves the explicitly heuristic local S/T-density idea. Validates parameters instead of silently replacing an invalid window. No trained predictor or external service is bundled. |
| `analyze_protein_conservation` | [biochemistry.py, lines 872-1026](https://github.com/snap-stanford/Biomni/blob/400c1f366b96a35ca253e13c9b06c5076af41d65/biomni/tool/biochemistry.py#L872-L1026) | Computes column conservation only for user-supplied prealigned sequences. No MUSCLE process, automatic alignment, padded fallback, or phylogenetic inference. |
| `gene_set_enrichment_analysis` | [genomics.py, lines 1021-1090](https://github.com/snap-stanford/Biomni/blob/400c1f366b96a35ca253e13c9b06c5076af41d65/biomni/tool/genomics.py#L1021-L1090) | Offline over-representation using explicit input gene sets and a supplied background universe. Adjusts across the full tested family before any display truncation. Does not reproduce Enrichr databases, z-scores, or combined scores. |
| `perform_cosinor_analysis` | [physiology.py, lines 516-610](https://github.com/snap-stanford/Biomni/blob/400c1f366b96a35ca253e13c9b06c5076af41d65/biomni/tool/physiology.py#L516-L610) | Fits a specified period with linear harmonic regression. Reports a nonnegative amplitude and explicit peak-phase convention, with fit diagnostics. |

The eight general statistical tools are Proto-native companions, not copied
Biomni functions: `descriptive_statistics`, `compare_two_groups`, `correlation`,
`linear_regression`, `one_way_anova`, `adjust_pvalues`,
`principal_component_analysis`, and `contingency_test`.

`fit_michaelis_menten` is a ninth Proto-native companion, inspired by the fitting
idea in upstream [protease and enzyme analysis](https://github.com/snap-stanford/Biomni/blob/400c1f366b96a35ca253e13c9b06c5076af41d65/biomni/tool/biochemistry.py#L307-L667).
It accepts measured substrate concentrations and measured reaction rates. It
does not fabricate assay measurements. Rate, substrate, and enzyme concentration
units must be compatible before interpreting a turnover rate; fluorescence units
alone do not establish a rate in concentration per time.

## Second port batch (2026-09-18): copy-and-adapt

Fifty further capabilities were ported by copying the pinned upstream algorithm
bodies and adapting only what the offline JSON contract requires. The module
files carry per-tool upstream mappings in `upstream_functions`; the machine
readable inventory records the per-function status change.

| Proto module | Upstream sources | Adaptation pattern |
| --- | --- | --- |
| `compute_sequence.py` (13 tools) | `molecular_biology.py`, `synthetic_biology.py` (codon optimization) | Pure-Python transcription. Biopython codon translation is replaced by the embedded standard genetic code; `Bio.Restriction` is replaced by a curated enzyme table whose Type IIS offsets are transcribed from upstream's own `TYPE_IIS_PROPERTIES` and whose Type II entries carry textbook recognition/cut patterns written out for auditability. |
| `compute_simulation.py` (12 tools) | `bioengineering.py`, `microbiology.py`, `physiology.py`, `synthetic_biology.py`, `systems_biology.py` | ODE right-hand sides, surrogate objectives, and the Gillespie loop are transcribed as-is. pandas/matplotlib artifacts are dropped, trajectories are downsampled, the stochastic simulation is seeded, and upstream's callable-injection ODE argument is excluded as arbitrary code execution (the fixed default model ships alone). Flux balance analysis uses scipy HiGHS linear programming on an explicit JSON network instead of cobra SBML loading. |
| `compute_assay.py` (17 tools) | `biochemistry.py`, `immunology.py`, `microbiology.py`, `pathology.py`, `bioengineering.py`, `pharmacology.py` (stability), `physiology.py`, `synthetic_biology.py` (barcodes) | Fitting objectives, band windows, calibration flows, and peak detection are transcribed. CSV/FASTQ inputs become JSON arrays; file and plot writes are dropped. Documented corrections are listed below. |
| `compute_clinical.py` (5 tools) | `pharmacology.py` | VCOG-CTCAE grading uses upstream's inline criteria table; statsmodels OLS/repeated-measures/Tukey procedures are reimplemented over numpy/scipy (least squares with t-distribution inference, classical two-way ANOVA, studentized-range HSD). |
| `compute_omics.py` (3 tools) | `genomics.py`, `genetics.py`, `cancer_biology.py` | Interval algebra replaces pybedtools; the GBLUP variance-component loop is transcribed with numpy; sklearn NMF is replaced by deterministic seeded Lee-Seung multiplicative updates. |

The sgRNA spacer scan (`design_sgrna_spacers`) is the tenth Proto-native
companion: upstream `design_knockout_sgrna` is a lookup into a precomputed
data-lake library, so the sequence-based PAM scan is a redesign rather than a
copy. Everything not listed here keeps its recorded deferral reason; in
particular image- and flow-cytometry tools require binary file inputs beyond
the JSON request contract, and wrapper functions over external databases,
executables, or model downloads cannot be copied without shipping those
dependencies.

These calculations analyze existing data. They do not authorize materials for
design, modify the governed materials catalog, produce experimental protocols,
or provide evidence of experimental success.

## Source issues that affect portability

These findings are from direct inspection of selected functions, not a claim of
a comprehensive correctness audit of the upstream project.

- **RNA loops and energies:** the upstream loop-size expression uses distances
  between stems and can miss the hairpin in `(((...)))`. The supplied per-pair
  energy table is expressly simplified and does not implement a calibrated
  nearest-neighbor free-energy model. An empty structure also reaches divisions
  by sequence length. Proto requires valid nonempty structures and limits the
  result to explicitly defined structural counts.
- **Protein alignment fallback:** when MUSCLE fails, upstream pads sequences on
  the right and continues conservation and tree analysis. Padding is not a
  biologically justified alignment. Proto requires prealigned input and reports
  conservation only.
- **Cosinor amplitude and phase:** unconstrained nonlinear fitting can return a
  negative amplitude. Converting the fitted phase directly to a peak time then
  gives the opposite extremum. The model also divides by total variation for
  constant data. Proto uses an identifiable harmonic design, normalizes
  amplitude/phase, and handles undefined fit quantities explicitly.
- **Generated enzyme data:** `analyze_enzyme_kinetics_assay` generates its own
  noisy observations and random inhibition parameters while producing assay
  narratives. That function is not ported as a data-analysis operation.
- **Protease turnover units:** `analyze_protease_kinetics` obtains fluorescence
  slopes in arbitrary units per second, divides by enzyme concentration, and
  labels the result per second. A fluorescence-to-concentration calibration is
  missing. The native measured-rate fit does not inherit this assumption.
- **Interval overlap accounting:** the now-ported
  [analyze_genomic_region_overlap](https://github.com/snap-stanford/Biomni/blob/400c1f366b96a35ca253e13c9b06c5076af41d65/biomni/tool/genomics.py#L1965-L2164)
  adds all pairwise overlap lengths. Internally overlapping input intervals can
  cause repeated bases and coverage percentages above 100%. The port merges
  each set first, uses half-open `[start, end)` semantics, and reports union
  base counts, so percentages cannot exceed 100.
- **Barcode distance semantics:** the now-ported
  [analyze_barcode_sequencing_data](https://github.com/snap-stanford/Biomni/blob/400c1f366b96a35ca253e13c9b06c5076af41d65/biomni/tool/synthetic_biology.py#L356-L512)
  applies `pdist` to a square matrix of already-computed Hamming distances. This
  clusters distance profiles rather than the intended sequence distances.
  The port feeds the condensed Hamming distances to the linkage directly.
  Sequence similarity alone also does not establish biological lineage.
- **Gompertz growth units:** the now-ported
  [analyze_bacterial_growth_rate](https://github.com/snap-stanford/Biomni/blob/400c1f366b96a35ca253e13c9b06c5076af41d65/biomni/tool/synthetic_biology.py#L225-L353)
  fits absolute optical density with a modified Gompertz expression. Its slope
  parameter therefore has optical-density-per-time units; the upstream report
  divides `ln(2)` by it directly. The port converts the tangent slope to a
  specific rate via `mu*e/A` before reporting doubling time.
- **ITC binding model:** `analyze_itc_binding_thermodynamics` evaluates a
  one-site expression that treats molar ratios as free ligand concentrations
  with mixed units (micromolar numerators, millimole bookkeeping), so its
  `Kd`, `n`, and `dH` are not physically calibrated. The port fits the standard
  one-site quadratic isotherm on total concentrations and differential heats;
  numbers are therefore not comparable with upstream's.
- **Golden Gate designer/assembler mismatch:** upstream
  `design_golden_gate_oligos` emits a reverse oligo beginning with the raw
  downstream overhang, while its own `golden_gate_assembly` expects the reverse
  complement there, so the designer's output cannot assemble. The port aligns
  the designer to the assembler's convention and records the change.
- **Gene-circuit dilution ordering:** `simulate_gene_circuit_with_growth_feedback`
  uses `dxdt[n_genes]/cell_mass` inside the gene loop, before the mass derivative
  is computed; growth dilution is therefore always zero. The port computes the
  specific growth rate first and is not bit-compatible with upstream.
- **Hemodynamic DC removal:** `analyze_hemodynamic_data` bandpass-filters the
  raw pressure (removing the DC level) and then reports the filtered extrema
  as systolic/diastolic pressures near zero. The port restores the raw mean
  level before reporting mmHg values.
- **Biofilm degenerate t-test:** `quantify_biofilm_biomass_crystal_violet`
  calls `ttest_1samp([single_value], 0)`, which yields undefined p-values. The
  port requires replicates per sample and tests the normalized replicates.
- **Cell-cycle model self-assessment:** upstream `estimate_cell_cycle_phase_durations`
  labels its own simulation a simplified demonstration model (including an
  unused G2/M term). The port transcribes the model as-is and keeps the
  demonstration-scope labeling rather than presenting it as a validated
  dual-pulse analyzer.

## Dependencies and runtime boundary

The upstream [package metadata](https://github.com/snap-stanford/Biomni/blob/400c1f366b96a35ca253e13c9b06c5076af41d65/pyproject.toml)
declares Python 3.11 or newer and a small agent dependency set, while individual
tools require many more numerical, biological, image-processing, R, executable,
GPU, model, or data dependencies. Installing that package alone does not establish
that its scientific tools work. Upstream also documents
[environment conflicts](https://github.com/snap-stanford/Biomni/blob/400c1f366b96a35ca253e13c9b06c5076af41d65/docs/known_conflicts.md).

The upstream [README](https://github.com/snap-stanford/Biomni/blob/400c1f366b96a35ca253e13c9b06c5076af41d65/README.md)
describes automatic datalake downloads of about 11 GB and warns that generated
agent code can access the host system. Proto's port operates through a fixed tool
catalog. It does not import the Biomni agent, execute user-authored Python,
download the datalake, call the hosted service, or install the upstream full
environment. Optional numerical dependencies are evaluated independently in
Proto's own compute environment.

The 227-function inventory assigns these mutually exclusive source statuses:

| Status | Count | Meaning |
| --- | ---: | --- |
| `adapted_scoped_subset` | 109 | Selected calculation with the narrowed contracts above (6 in batch 1, 49 in batch 2, 15 in batch 3 with bounded binary file inputs, 39 in batch 4 covering the remaining feasible frame-sequence, medical-registration, NIfTI, cooler, cobra, msprime, Cas9/CRISPR, and histology tools). |
| `inspiration_only` | 3 | Upstream enzyme/protease functions inform the native measured-data fit; the data-lake sgRNA library lookup informs the native spacer scan. |
| `connector_exposed` | 12 | Upstream wrappers reachable through the explicitly-enabled connector subsystem (network APIs, whitelisted executables, DDInter data lake). |
| `deferred_model_download` | 5 | Library wrappers whose scientific payload is a runtime model-weight download (cellpose/nnU-Net, ESM, IMA, DiffDock, TxGNN); blocked by the no-model-download constraint until a reviewed model-asset policy exists. |
| `deferred_scientific_tool` | 19 | Remaining wrappers that orchestrate external executables or R toolchains (GATK/LUMPY/CNVkit callers, DESeq2, Prokka, HOMER, panhumanpy, comparative-genomics pipelines). |
| `deferred_external_resource` | 59 | Data, model, literature, documentation, or service integrations requiring separate review. |
| `excluded_protocol_or_device_workflow` | 15 | Outside the requested local data-analysis scope. |
| `excluded_agent_or_runtime_support` | 5 | Upstream executor, runtime support, or downloader functionality. |

Deferred entries have structural inventory review only. The recorded import and
effect indicators are not exhaustive dependency resolution, runtime verification,
or safety certification. Future additions need an explicit scientific contract,
dependency/license review, deterministic fixtures or analytical checks, and
resource limits before being exposed as executable capabilities.

## Attribution and licensing

The pinned upstream project declares [Apache License 2.0](https://github.com/snap-stanford/Biomni/blob/400c1f366b96a35ca253e13c9b06c5076af41d65/LICENSE).
Credit for the source functions belongs to the Biomni Team and contributors.
The pinned tree has no separate upstream `NOTICE` file. Its license appendix
contains placeholder copyright fields, so no specific year or owner was invented.

Unmodified license bytes are included in:

- `src/proto_agent/data/licenses/Biomni-Apache-2.0.txt`
- `apps/proto-workbench/licenses/Biomni-Apache-2.0.txt`

The Workbench third-party notice identifies the source commit and the changes.
These notices document the adapted capabilities and the limited source
inspiration; they do not grant a license to Stanford branding or imply Stanford
endorsement. They do not change Proto's own project license status.

The upstream [data license overview](https://github.com/snap-stanford/Biomni/blob/400c1f366b96a35ca253e13c9b06c5076af41d65/license_info.md)
separately reports restrictions on several integrated datasets. Those statements
are upstream documentation, not a refreshed legal assessment of each provider.
This port redistributes none of those datasets, model weights, protocol
collections, or external executables. A future adapter must inspect the actual
component terms and preserve its own source and license metadata.
