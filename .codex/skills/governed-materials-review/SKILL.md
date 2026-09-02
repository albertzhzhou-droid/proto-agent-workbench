---
name: governed-materials-review
description: Audit candidate biological resources through independent provenance-rights, sequence-semantics, and safety-consistency passes, then materialize only records that pass every gate. Use to increase DESIGN_ELIGIBLE coverage without weakening evidence or human activation boundaries.
---

# Governed Materials Review

Run three independent passes for every candidate and retain a machine-readable decision:

1. Provenance and rights: stable source identifier, retrievable revision, response and content digests, license URL, attribution, rights notes, and explicit redistributable status.
2. Sequence and semantics: supported domain and part ontology, permitted alphabet, bounded length, source sequence digest, and no cross-domain coercion.
3. Safety and consistency: derived and explicit safety agreement, duplicate and collision checks, normalized-record validation, catalogue round-trip, model visibility, and materialization.

Reject self-asserted eligibility, missing evidence, license ambiguity, safety overrides, or review identity ambiguity. Promotion creates a new immutable inactive snapshot; activation remains a separate human action. Report before and after counts and rejection reasons. `DESIGN_ELIGIBLE` remains a software policy state, not a real-world readiness claim.
