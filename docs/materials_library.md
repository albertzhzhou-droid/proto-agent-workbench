# Proto Biological Materials Library v1

Proto's materials library is an external, versioned data root located alongside the project:

```text
<workspace-parent>\Proto CLI Materials\
  active.json
  snapshots/<snapshot-id>/{catalog.sqlite,quarantine.sqlite,blobs/,quarantine/blobs/,manifest.json,provenance.json,LICENSES.md}
  staging/<snapshot-id>-<nonce>/
```

Set `PROTO_AGENT_MATERIALS_ROOT` to use a different absolute location. The
default is a sibling of the checked-out workspace, so no username or drive is
embedded in the repository.

Large dynamic snapshots are neither committed to Git nor copied into the installer. The source repository does contain two narrowly scoped, generator-produced public bundles under `materials/bundles/`: an installable 13-record reviewed catalog and a non-installable 1,795-record quarantine metadata index. Neither bundle includes `active.json`, overlays, staging state, absolute paths, operator identity, logs, or cache data. The quarantine bundle additionally omits every sequence and sequence object; it retains only the original public length/hash as explicitly redacted-source metadata.

The public catalog is verified before installation and remains inactive unless a human explicitly passes `--activate`. The quarantine bundle declares `activation_policy: DENY`, is rejected by the public installer, is stored outside the normal snapshot tree in the repository, and is not an MCP/model data source.

```powershell
proto-agent materials bundle-verify --profile PUBLIC_CATALOG
proto-agent materials bundle-verify --profile PUBLIC_QUARANTINE
proto-agent materials bundle-install-public
proto-agent materials bundle-install-public --activate  # optional human decision
```

For normal synchronized data, a snapshot can be activated manually only after downloading, normalization, hashing, license checks, and safety routing have completed in `staging`. `active.json` is replaced atomically, so a failed synchronization does not change the currently verified snapshot; `rollback` only switches to an existing snapshot that has passed integrity verification.

## Records and statuses

Each record has a namespaced `resource_id`; bilingual descriptions; organism/chassis; role; sequence type and SHA-256; source record and revision/release; source-response hash; license, attribution, and rights notes; evidence references; review status; and safety status. English descriptions are taken from upstream facts whenever possible; missing fields are completed with deterministic templates, and Chinese descriptions are generated from structured fields.

Status meanings:

- `DESIGN_ELIGIBLE`: Passes local data, licensing, and safety gates and can be searched and retrieved by the model; this does not mean it can be ordered or experimented on, or that it is risk-free.
- `REVIEW_REQUIRED`: Indexed but requires human review.
- `REFERENCE_ONLY`: For reference only (for example, protein, reaction, and model information, or conditionally licensed records).
- `QUARANTINED`: Matches a hard sensitive-content flag or has been manually isolated. These records are stored in a separate `quarantine.sqlite` database and object directory and cannot be read by the ordinary CLI or MCP; administrators can only access them through explicit quarantine queries.

The current Proto DSL directly compiles only `promoter`, `rbs`, `cds`, and `terminator`. Other materials can still be searched and retained as evidence, but they cannot masquerade as compilable parts. After generating a template draft, run `check --json`, `compile`, `workflow run`, and `review run` in that order; all scientific outputs remain marked `human_review_required`.

## Protein-sequence compilation domain

Protein sequences use a separate `proto-agent.protein-selection.v1` input and
`proto-agent.ir.v1` output with `domain: "protein"`; they are not forcibly converted into DNA
parts or inserted into the legacy `construct.parts` array. A record can be materialized only
when it is explicitly `kind=protein_sequence` and `sequence_kind=PROTEIN`, and concurrently
passes source-hash, amino-acid alphabet, licensing, `DESIGN_ELIGIBLE`, `NO_FLAG`, and
redistributability checks. For each record, the compiler preserves source, license, and evidence
fields and calculates length, approximate molecular weight, composition, hydrophobic fraction,
and charged fraction; these are software-derived metrics, not scientific conclusions.

```powershell
# Search first, then retrieve only eligible records; the selection file belongs under build/ and can be bound to a snapshot digest
proto-agent materials search "fluorescent" --kind protein_sequence --status DESIGN_ELIGIBLE --snapshot <verified-protein-snapshot-id> --limit 20
proto-agent materials materialize-proteins uniprot:P42212 uniprot:Q9U6Y8 `
  --snapshot <verified-protein-snapshot-id> --design-id fluorescent-protein-panel --out build\materials\fluorescent-proteins.json

# Validate and compile to a protein-domain IR; failures fail closed and produce no partial result
proto-agent protein validate build\materials\fluorescent-proteins.json --json
proto-agent protein compile build\materials\fluorescent-proteins.json --out build\fluorescent-proteins.ir.json
proto-agent export build\fluorescent-proteins.ir.json --format fasta --out build\fluorescent-proteins.fasta
```

Replace `<verified-protein-snapshot-id>` with the ID of a snapshot that has completed validation
in `materials status --json`; specifying it explicitly enables protein design without changing the
current active snapshot. Activation and rollback remain separate manual administrative actions.

Workbench's Design Explorer automatically switches to Protein view according to the IR's `domain`:
it displays bilingual descriptions, source/license information, sequence hash, length, and composition
metrics, and presents the sequence in a bounded residue grid. The view provides no wet-lab actions and
cannot unlock quarantined records; the header and IR warnings always preserve the boundary requiring
human scientific review.

## Common commands

```powershell
# Initialize a small seed library with open licenses (does not overwrite existing snapshots)
proto-agent materials init

# By default, the model sees only DESIGN_ELIGIBLE records; results do not include full sequences
proto-agent materials search "lac" --kind genetic_part --limit 20
proto-agent materials facets --status DESIGN_ELIGIBLE

# Inspect a record (the quarantine requires an explicit administrator argument)
proto-agent materials get proto:template/expression-cassette

# A local import first creates a pending-review snapshot; JSON, FASTA, SBOL Turtle, and GenBank are supported
proto-agent materials import imports\library.fasta

# Synchronize the official UniProtKB/Swiss-Prot release to a new staging snapshot; separate manual activation is required
proto-agent materials sync uniprot --max-records 100000
proto-agent materials diff seed-2026.08 <new-snapshot-id>
proto-agent materials activate <new-snapshot-id>
proto-agent materials rollback seed-2026.08

# Only eligible genetic_part records can be materialized into the legacy parts schema
proto-agent materials materialize ecoli_k12 proto:part/example --out build\materials\parts.json

# Software templates must specify a chassis and still undergo the complete design-validation chain
proto-agent materials render-template proto:template/expression-cassette --chassis ecoli_k12 `
  --bind slot1=proto:part/promoter --bind slot2=proto:part/rbs `
  --bind slot3=proto:part/cds --bind slot4=proto:part/terminator
```

### Description-review overlay

Source rows and sequence objects are always immutable. When a human reviewer accepts, rejects, or
defers a description, the decision is written to versioned JSON under `overlays/` in the external
root; this operation does not change licensing, safety status, or `DESIGN_ELIGIBLE`:

```text
proto-agent materials review fixture:promoter/pLac --decision accept --reviewer alice `
  --description-en "Reviewed software fixture promoter." --description-zh "已审核的软件启动子占位资源。"
```

`proto_materials_search/get/facets/materialize` and
`proto_materials_materialize_proteins` are read-only MCP tools for retrieving eligible records;
`proto_protein_compile` accepts only a materialized, workspace-relative selection and writes a
restricted summary under `build/`. These tools do not synchronize, activate, or read the quarantine;
pagination is limited to 50 records per page, and responses are constrained to 512 KiB. Source text
is untrusted data and receives no prompt or instruction authority.

Workbench's Materials page provides snapshot counts, eligible-record search, bilingual details, source/license/safety fields, synchronization to staging, diff previews, manual activation/rollback, imports, and description-review overlays and audit history that do not modify source records.

The first-version source adapters observe their respective rights boundaries: UniProtKB and Rhea require CC BY 4.0 attribution, BioModels uses CC0, iGEM licenses are read record by record, NCBI preserves accession.version and third-party rights notices, and Addgene retains only `LINK_ONLY` links by default without fetching or packaging content. Records that lack a complete license, source hash, sequence alphabet, or safety information fail closed.
