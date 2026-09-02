# Public materials distribution bundles

These directories are the only biological-material databases intentionally
tracked in Git. They are rebuilt from locked, reviewed public inputs; they are
not copies of the local sibling `Proto CLI Materials` root.

## Profiles

| Profile | Path | Records | Sequence content | Runtime policy |
| --- | --- | ---: | --- | --- |
| `PUBLIC_CATALOG` | `public/public-reviewed-2026.09/` | 13 | 10 reviewed iGEM DNA parts and 3 reviewed UniProt proteins in content-addressed gzip objects | Installable after verification; inactive by default; explicit human activation only |
| `PUBLIC_QUARANTINE` | `quarantine/public-quarantine-metadata-2026.09/` | 1,795 | None | Activation denied; not installable; never model/MCP-visible |

The quarantine index contains 1,744 UniProt, 21 Rhea, and 30 BioModels rows.
Each row remains `QUARANTINED`, `HARD_FLAG`, and
`design_eligibility = 0`. Its source sequence, if any, is omitted; only the
public source length and SHA-256 are retained under
`metadata.public_quarantine_export` to make the redaction auditable.

## Rights

The repository's MIT license applies to project software, not third-party
records. Every row retains its source URL, license URL, attribution, rights
notes, and redistribution status.

- Public catalog: 12 CC BY 4.0 rows and 1 CC0 1.0 row.
- Quarantine metadata: 1,765 CC BY 4.0 rows and 30 CC0 1.0 rows.
- UniProt's CC BY 4.0 notice also warns that patents or other third-party rights
  may apply. Public redistribution is not a scientific-use or freedom-to-
  operate conclusion.

See each bundle's `LICENSES.md`, `licenses/catalog.json`, `records.jsonl`, and
`manifest.json` for record-level details, and see
[`../DATA_LICENSES.md`](../DATA_LICENSES.md) for the source-level policy.

## Verify and install

```powershell
proto-agent materials bundle-verify --profile PUBLIC_CATALOG
proto-agent materials bundle-verify --profile PUBLIC_QUARANTINE
proto-agent materials bundle-install-public
```

Installation copies the checked public catalog into the external materials
root only after checksums, SQLite integrity, source/rights gates, object hashes,
and privacy invariants pass. It does not create or change `active.json`.
Activation is a separate optional human action:

```powershell
proto-agent materials bundle-install-public --activate
```

There is intentionally no quarantine install command.

## Rebuild

`source-lock.json` pins the reviewed JSON files and the three source quarantine
SQLite digests without recording local snapshot paths. With the matching
read-only external source root available:

```powershell
python tools\export_public_materials.py
```

The exporter:

1. selects only reviewed, redistributable main records;
2. reconstructs quarantine rows from a strict provider-specific metadata
   allowlist;
3. removes local paths, active state, personal identity fields, administrative
   logs, and all quarantine sequences;
4. writes deterministic SQLite/FTS and `mtime = 0` gzip objects;
5. vacuums SQLite so `freelist_count = 0`; and
6. emits full-tree SHA-256 inventories.

It fails if an output directory already exists; replacement must be deliberate
and followed by a complete bundle verification and review.
