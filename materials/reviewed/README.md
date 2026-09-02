# Reviewed materials seed

`igem_design_eligible_2026-08.json` is a small, auditable eligibility seed containing ten published iGEM Registry genetic parts. It includes the original promoter/RBS/CDS/terminator set plus the BBa_B0030–BBa_B0033 RBS series and BBa_J23100 promoter. Each record keeps its iGEM record URL, raw-response SHA-256, revision timestamp, declared per-record license, and evidence references.

The ten records were accepted only for the software `ecoli_k12` chassis label after checking that they are supported Proto DSL part types, contain valid DNA symbols, carry a redistributable declared license, and have no hard safety flag. The `ecoli_k12` value is a local compatibility annotation because the upstream API returned empty chassis fields; it is not an upstream characterization claim. The low-information upstream descriptions for BBa_J23119 and BBa_J23100 are retained in metadata and explicitly not expanded into functional claims.

The file contains no experimental protocol. Source rows remain immutable in the external snapshot; later wording changes must be recorded as versioned review overlays. Importing this file creates an inactive snapshot. Activation is an explicit human action.

The source-by-source promotion decision and blocker counts are recorded in [`promotion_audit_2026-09.md`](promotion_audit_2026-09.md).
