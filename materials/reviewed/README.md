# Reviewed materials seed

`igem_design_eligible_2026-09.json` contains 1,046 published iGEM Registry DNA
parts: 230 promoters, 265 ribosome entry sites, 287 CDSs, and 264 terminators.
Each record preserves the official record URL, separate upstream-response and
sequence SHA-256 digests, revision timestamp, declared per-record licence, and
locked evidence references. `protein_design_eligible_2026-09.json` contains
five reviewed UniProt protein references with the same response/sequence hash
separation.

The records were accepted for the software `ecoli_k12` compatibility label only
after deterministic audit rounds covering provenance and rights, sequence,
ontology and safety, global uniqueness, normalization, catalogue visibility,
and materialization round trips. Where the upstream iGEM chassis field was
empty, `ecoli_k12` is explicitly a controlled local software annotation rather
than an upstream characterization claim.

The files contain no experimental protocol. Source rows remain immutable in
the external snapshot; later wording changes must be recorded as versioned
review overlays. Importing a reviewed seed creates an inactive snapshot, and
activation is an explicit human action.

Per-candidate decisions and reason codes are in
`promotion_audit_2026-09.json`; counts, reproducibility gates, and blockers are
summarized in [`promotion_audit_2026-09.md`](promotion_audit_2026-09.md).
Reproduce the locked review with
`python tools/review_materials_promotion.py --check`. This rebuild check
requires the locally retained raw response bytes named by the published
receipt/digest ledger. Those upstream bodies and resumable crawler state are
Git-ignored because they can contain contributor identities; they are not
part of the public repository or the model-visible catalogue.
