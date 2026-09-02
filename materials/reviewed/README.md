# Reviewed materials seed

`igem_design_eligible_2026-09.json` is a small, auditable eligibility seed containing fifteen published iGEM Registry genetic parts. It adds BBa_B0010, BBa_B0012, BBa_B0013, BBa_J23101, and BBa_J23102 to the prior ten-record set. Each record keeps its official record URL, separate raw-response and sequence SHA-256 digests, revision timestamp, declared per-record license, and locked evidence references. `protein_design_eligible_2026-09.json` carries the three reviewed UniProt proteins with the same response/sequence hash separation.

The fifteen iGEM records were accepted only for the software `ecoli_k12` chassis label after three deterministic audit rounds covering provenance/rights, sequence/ontology/safety, and duplicate/round-trip/model visibility. The `ecoli_k12` value is a local compatibility annotation because the upstream API returned empty chassis fields; it is not an upstream characterization claim.

The file contains no experimental protocol. Source rows remain immutable in the external snapshot; later wording changes must be recorded as versioned review overlays. Importing this file creates an inactive snapshot. Activation is an explicit human action.

Per-candidate decisions and reason codes are in `promotion_audit_2026-09.json`; counts and blockers are summarized in [`promotion_audit_2026-09.md`](promotion_audit_2026-09.md). Reproduce the locked review with `python tools/review_materials_promotion.py --check`.
