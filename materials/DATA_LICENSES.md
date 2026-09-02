# Materials data licenses

The root [MIT License](../LICENSE) covers Proto Agent software. It does not
relicense third-party biological records. Every distributed row retains its own
license ID, license URL, attribution, rights notes, public source URL, and
redistribution status in SQLite and `records.jsonl`.

The checked public bundles use these source policies:

- **UniProtKB/Swiss-Prot** — [CC BY 4.0](https://www.uniprot.org/help/license/),
  with attribution to the UniProt Consortium. UniProt states that patents or
  other third-party rights can still apply.
- **Rhea** — [CC BY 4.0](https://www.rhea-db.org/help/license-disclaimer), with
  attribution to Rhea.
- **BioModels** — [CC0 1.0](https://www.ebi.ac.uk/biomodels/faq). The public
  quarantine export retains model metadata only and removes personal
  contributor fields.
- **iGEM Registry** — the declared license is evaluated per record using its
  public license endpoint. The checked public catalog has nine CC BY 4.0 rows
  and one CC0 1.0 row.

`REDISTRIBUTABLE` is a data-packaging gate, not a scientific, patent,
freedom-to-operate, orderability, wet-lab, biosafety, clinical, or regulatory
conclusion. Refer to each record and the upstream source before reuse.
