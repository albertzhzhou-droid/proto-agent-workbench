# Materials promotion audit — 2026-09

The machine-readable `promotion_audit_2026-09.json` evaluates every candidate
in three fixed rounds: (1) provenance and rights, (2) sequence, ontology, and
safety, and (3) duplicates plus normalization, inactive-catalog, retrieval, and
materialization round trips. Every candidate records a `PASS` or `FAIL` plus
stable reason codes per round.

## Before and after

| State | DESIGN_ELIGIBLE | Genetic parts | Protein sequences | Active? |
| --- | ---: | ---: | ---: | --- |
| External active snapshot before audit | 10 | 10 | 0 | Yes; unchanged |
| Previous checked public bundle | 13 | 10 | 3 | No |
| New locked public snapshot/bundle | **18** | **15** | **3** | **No** |

The controlled audit passed 18/18 candidates and failed 0. The five additions
are three terminators (`BBa_B0010`, `BBa_B0012`, `BBa_B0013`) and two promoters
(`BBa_J23101`, `BBa_J23102`). Each was freshly retrieved from its supplied iGEM
UUID endpoint, remained `published`, matched its expected Sequence Ontology
role and length, used the reviewed CC BY 4.0 license UUID, had no duplicate
sequence, and passed all three rounds.

The external snapshot `public-reviewed-2026.09` was installed with 18 records
but not activated. The SHA-256 of the existing `active.json` remained
`0c7c49ac5217ce36302878144e5b6101434525ceb01c6f142b697082df2563ea`;
it still points to `import-1788221961-a591490846c9`.

## Evidence and reproducibility

- Exact upstream bytes and the retrieval receipt are under
  `source_responses/2026-09/`.
- `../bundles/source-lock.json` pins both reviewed seeds, the audit, receipt,
  and every source and license response by SHA-256.
- `python tools/review_materials_promotion.py --check` reproduces all decisions
  without network access; `--fetch` performs a fresh bounded refetch.
- Round three creates a temporary, inactive snapshot and verifies every passing
  record through the same bounded `search`, `get`, and DNA/protein
  materialization paths used by the product. It neither mutates the active
  pointer nor substitutes for a human activation decision.
- Redirects, non-200 responses, unexpected identity/role/sequence, unknown
  licenses, incomplete evidence, and failed rounds fail closed.

## Records that remain blocked

- 98,256 UniProt reference records lack per-record controlled promotion
  attestations and locked response/license evidence.
- 1,795 hard-flagged records remain physically isolated (UniProt 1,744; Rhea
  21; BioModels 30); the public quarantine bundle contains no sequences.
- 18,540 Rhea reactions and 2,754 BioModels models remain reference-only because
  they are not compiler-domain sequence parts.
- Five staged iGEM `Engineered Region` records remain `REVIEW_REQUIRED` because
  the current DSL has no unambiguous supported part type for them.
- Three built-in software templates remain `REFERENCE_ONLY` because they are
  slot templates, not biological sequences.

`DESIGN_ELIGIBLE` means software-catalog eligibility only. It is not a wet-lab,
orderability, biosafety, patent, clinical, regulatory, or scientific validity
claim.
