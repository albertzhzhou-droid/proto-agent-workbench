# Materials promotion audit — 2026-09

This audit attempted to promote records from existing source snapshots into the `DESIGN_ELIGIBLE` domain. The result follows current Proto policy: only genetic parts that have verifiable provenance and licensing, carry no hard sensitive-content flags, contain DNA sequences, and belong to the Proto DSL's `promoter`, `rbs`, `cds`, or `terminator` categories can be retrieved by the model and materialized into the legacy `parts` schema.

## Results

| Source snapshot | Total | Previously design-eligible | Design-eligible after promotion | Review required | Reference only | Quarantined | Decision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| UniProtKB/Swiss-Prot | 100,003 | 0 | 0 | 0 | 98,259 | 1,744 | Protein sequences are not parts in the current DSL; hard-flagged records remain quarantined |
| Current Rhea release | 18,561 | 0 | 0 | 0 | 18,540 | 21 | Reaction information is for reference only and cannot masquerade as genetic parts |
| Current BioModels public index | 2,784 | 0 | 0 | 0 | 2,754 | 30 | Computational models are for reference only and cannot be materialized into `parts` |
| iGEM staging | 8 | 0 | 0 | 5 | 3 | 0 | Five records are `Engineered Region` entries and lack a supported `part_type` |
| Built-in Proto templates | 3 | 0 | 0 | 0 | 3 | 0 | Software slot templates remain `REFERENCE_ONLY` |
| Active snapshot with reviewed iGEM increment | 13 | 0 | **10** | 0 | 3 | 0 | Ten standard genetic parts added and explicitly activated |

The complete large snapshots remain in the external root; records were not misreported as "directly designable" merely because they were "indexed" or had "no hard flags." `DESIGN_ELIGIBLE` means only that the record passes local software, data, licensing, and safety-policy gates; it does not establish scientific validity, orderability, experimental readiness, or regulatory approval.

## Accepted iGEM increment

The new records are `BBa_B0030`, `BBa_B0031`, `BBa_B0032`, and `BBa_B0033` (RBS series), and `BBa_J23100` (promoter); the previously reviewed `BBa_B0034`, `BBa_J23119`, `BBa_B0015`, `BBa_25FAVHQY`, and `BBa_25RT9PC8` remain. Every record preserves the iGEM record URL, its individual raw-response SHA-256, revision, declared license, and evidence references.

The upstream descriptions of `BBa_J23119` and `BBa_J23100` are the low-information strings `Later` and `Replace later`, respectively. Their original text is preserved in `metadata.upstream_description`, and their display descriptions explicitly state that no additional function was inferred.

## Why no other sources were promoted

- UniProt records are `protein_sequence` entries; even with a CC BY license and a complete sequence, they are not DNA parts compilable by the Proto DSL. Of these records, 1,744 remain in the physically isolated quarantine.
- Rhea entries are `biochemical_reaction` records and BioModels entries are `computational_model` records; neither source has materializable DSL part semantics.
- The five iGEM staging records belong to `SO:0000804 Engineered Region`. Although they have DNA and CC-BY licensing, they do not have a supported part type, still require human determination, and cannot be forcibly marked as compilable parts.
- Templates are software design slots rather than sequences and remain `REFERENCE_ONLY` by design.

Source text is treated as untrusted data and receives no prompt or instruction authority; the quarantine is excluded from ordinary full-text search and cannot be unlocked or exported through the model-facing MCP.
