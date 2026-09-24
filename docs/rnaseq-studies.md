# RNA-seq studies

Open **Compute → Biological data → RNA-seq studies**. The study uses the normal
Compute execution receipt, research-project associations, saved-run reopening and
figure-board selectors. It does not create a separate project database or a second
differential-expression engine.

## Inputs and fixed designs

`analyze_rnaseq_study` accepts workspace CSV files:

- `counts_path`: first header `gene_id`, then unique sample IDs. Each count token
  is a nonnegative decimal integer at most 2,147,483,647. Fractional, negative,
  missing or nonfinite counts are rejected, never rounded or imputed.
- `samples_path`: initial headers `sample,condition`, optionally followed by
  `batch` and/or `subject`. Rows must identify exactly the count columns. Metadata
  reordering is explicit and recorded; gene and count-column order are preserved.
- Optional `gene_sets_path`: bounded JSON with `schema_version` equal to
  `proto-agent.rnaseq-gene-sets.v1`, declared `namespace` and `source`, and `sets`
  containing unique `name` and `genes` entries. There is no download or ID mapping.

The supported designs are `condition` (`~condition`), `batch_condition`
(`~batch+condition`) and `subject_condition` (`~subject+condition`). Reference and
comparison conditions must be distinct and have at least two samples each. The
design must have full column rank and positive residual degrees of freedom.
Other conditions and unused metadata remain explicit. These checks do not prove
biological independence or exclude unmeasured confounding.

Input bounds are 100,000 genes, 4–100 samples, two million count cells and 32 MiB
per file. Identifiers are unique printable labels of at most 100 characters.
Zero-library samples are rejected; all-zero gene rows are recorded. The declared
prefilter subsequently determines which genes enter the model.

## Validation and analysis

`analysis_mode: "validate"` checks the raw data, sample mapping, design and
declared count filter. It saves sample QC and exact input snapshots. It performs
no DESeq2 fit, normalization, PCA or enrichment.

`analysis_mode: "fit"` calls the existing typed `deseq2_fit` bioinformatics
adapter. The configured local DESeq2 runtime must exist; dependencies are never
installed automatically. The fixed engine receives immutable input copies and
retains its commands, logs, script, runtime versions and all output artifacts.
Cancellation uses its existing owned-process mechanism. A failed or incomplete
engine does not become a completed RNA study.

The initial explicit settings are:

| Setting | Default | Meaning |
| --- | --- | --- |
| `alpha` | 0.05 | DESeq2 independent-filtering target and significance threshold |
| `min_count` | 10 | Minimum raw count for a sample to count toward the gene filter |
| `min_samples` | 2 | Required samples meeting the count threshold |
| `pca_top_genes` | 500 | Highest-variance nonconstant transformed genes used for PCA |
| `size_factor_type` | `ratio` | DESeq2 ratio normalization; `poscounts` is an explicit alternative |

Differential testing uses DESeq2's Wald test and BH adjustment. Positive log2 fold
change means **comparison / reference**. No LFC shrinkage is applied. Missing raw
or adjusted p-values remain null with availability statuses; their absence does
not mean nonsignificance. The full filtering ledger and all modeled gene rows
remain in saved artifacts.

PCA uses `varianceStabilizingTransformation(blind=FALSE)` followed by centered,
unscaled PCA on the selected variable genes. The model's batch factor informs
dispersion fitting; neither normalized counts nor this PCA removes batch effects.
Plotting uses the returned coordinates and retains exact sample identities.

Optional enrichment reuses the existing one-sided hypergeometric ORA with BH
correction across all supplied sets. Its universe is genes with finite adjusted
p-values in this contrast; selected genes satisfy `padj < alpha`, combining both
directions. Empty selections, absent background and selection of the entire
universe produce explicit non-analysis states. There is no ranked GSEA or pathway
activation inference. At most 200 sets and 50,000 total memberships are accepted.

These choices follow the documented distinctions between raw counts, transformed
exploratory data, fixed designs and missing statistics in the
[official DESeq2 vignette](https://bioconductor.org/packages/release/bioc/vignettes/DESeq2/inst/doc/DESeq2.html).

## Results and provenance

The result presents sample QC, model/contrast, filtering denominators, PCA,
volcano/MA plots, a searchable paged gene table and optional enrichment. Zero
adjusted p-values cannot have finite negative-log coordinates: they remain in
the table and their plot exclusion count is shown, without a substituted floor.
Missing coordinates are also counted explicitly. Canvas plots retain all eligible
points rather than silently sampling them.

Input snapshots are kept under `build/rnaseq-inputs/<id>/`. The existing engine
keeps its outputs under `build/bioinformatics/<id>/`. The normal four-file Compute
bundle under `build/compute/<id>/` binds the request, projected results, method
metadata and source claims. Its result records the engine manifest hash and
artifact receipts. Current original-source checks remain separate from saved
result integrity when reopening a linked research run.

RNA result artifacts have a selective 32 MiB / two-million-JSON-node bound to
retain complete transcriptome tables. Other Compute results retain 4 MiB and
their existing node bound; general workspace text reads retain 2 MiB. Larger
results are refused rather than truncated. A generated receipt or matching hash
does not establish biological validity.

## Verification scope

Implementation and acceptance evidence is retained under
`build/rnaseq-studies-20260922/`. It separates parser/unit tests, synthetic
adapter fixtures, actual installed R computations, public pasilla reference
agreement, browser actions and development builds. Earlier failed attempts stay
unchanged. Public-data agreement with an independent invocation of the same
DESeq2 library is an integration/reference check, not an independent validation
of DESeq2's statistical model or a biological finding.

The retained public-data UI run is
`build/compute/afd5d63330884a44a80bc66747ac65dc/`: 14,599 input genes,
seven samples, 8,423 fitted genes, and 164 unavailable adjusted p-values.
Its nested runtime records R 4.5.3 and DESeq2 1.50.2. The project named
**RNA-seq — pasilla reference and synthetic ORA controls** retains this run in
the isolated acceptance database and was reopened after a real preview-host
restart. Its supplied enrichment sets deliberately select reference identifiers
for software verification; they must not be interpreted as curated pathways.

The increment receipt binds the separate Python/Node tests, direct-R reference
comparison, browser evidence and local build identity. The first UI attempt's
`BIO_WSL_UNAVAILABLE` failure remains recorded: the restricted preview process
could not access the installed WSL distribution. The subsequent local preview
ran with host access to that existing runtime. No dependency installation,
model inference, native packaged execution or browser download was accepted.
