# Materials promotion audit — 2026-09

The machine-readable `promotion_audit_2026-09.json` evaluates every candidate
in three fixed rounds: (1) provenance and rights, (2) sequence, ontology, and
safety, and (3) duplicates plus normalization, inactive-catalog, retrieval, and
materialization round trips. Every candidate records a `PASS` or `FAIL` with
stable reason codes per round.

## Verified catalogue state

| Population | Count | Status |
| --- | ---: | --- |
| iGEM Registry DNA parts | **1,046** | `DESIGN_ELIGIBLE` |
| UniProt protein references | **5** | `DESIGN_ELIGIBLE` |
| Complete reviewed public bundle | **1,051** | `DESIGN_ELIGIBLE` |
| Staged iGEM Engineered Region records | **5** | `REVIEW_REQUIRED` |
| Metadata-only quarantine records | **1,795** | isolated; model visibility denied |

The controlled audit passes 1,051/1,051 candidates and fails 0. The iGEM
population contains 230 promoters, 265 ribosome entry sites, 287 CDSs, and 264
terminators. Every included DNA sequence has a unique resource ID and sequence
digest, contains only unambiguous DNA bases, and is between 10 and 4,946 bases
long. The public bundle declares 1,044 records under CC BY 4.0 and seven under
CC0 1.0.

At the time of verification, the external catalogue's existing active pointer
selected `public-reviewed-2026.09`. Verification did not activate or replace a
snapshot; activation remains an explicit human action and is not itself proof
of scientific validity.

## Visualization and reproducibility gates

- Exact upstream response bytes and the retrieval receipt are retained under
  `source_responses/2026-09/`.
- `../bundles/source-lock.json` pins the reviewed seeds, audit, receipt, and
  every captured response by SHA-256.
- `python tools/review_materials_promotion.py --check` reproduces the complete
  1,051-candidate audit without network access.
- `proto-agent materials bundle-verify <bundle> --profile <profile>` verifies
  the public catalogue and metadata-only quarantine bundle manifests, hashes,
  SQLite catalogue, JSONL index, and compressed sequence blobs.
- Workbench's `igem-materials-visualization-corpus.test.mjs` decompresses and
  hashes every one of the 1,046 iGEM sequences, builds governed DNA IR, parses
  it through the production visualization adapter, and checks coordinates,
  search, interactivity, and stable role colours.
- A four-role materialized selection also passes the real `.proto` validation,
  compilation, workflow, and review-packet path. Scientific human review
  remains required.
- The general workspace scanner excludes Materials-managed blob buckets and
  captured source-response trees, preventing the enlarged catalogue from
  exhausting its fail-closed directory budget while retaining reviewable
  policy, seed, and IR files.

The materialization path canonicalizes selected IDs and rejects duplicates, so
the same logical selection has one stable digest and byte-identical output.
Promotion batches use the entire review population as their uniqueness scope,
so a duplicate split across the 1,000-record batch boundary still fails closed.

## Records that remain blocked

- Five staged iGEM `Engineered Region` records use the unsupported
  `SO:0000804` role. They remain `REVIEW_REQUIRED` and are not compiler-visible.
- The 1,795 quarantine rows (UniProt 1,744; Rhea 21; BioModels 30) remain
  physically isolated. The public quarantine bundle is metadata-only and
  contains no sequences.
- Rhea reactions and BioModels models remain reference-only because they are
  not compiler-domain sequence parts.
- Built-in software templates remain `REFERENCE_ONLY` because they are slot
  templates rather than biological sequences.

`DESIGN_ELIGIBLE` means software-catalogue eligibility only. It is not a
wet-lab, orderability, biosafety, patent, clinical, regulatory, or scientific
validity claim.
