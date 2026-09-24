# Scientific data identity contracts

Compute requests may opt in to explicit dataset and reference identity by adding a `dataset_manifests` array beside `tool` and `arguments`:

```json
{
  "tool": "find_n_glycosylation_motifs",
  "arguments": { "sequence": "MNATNPTNVS" },
  "dataset_manifests": ["data/study.dataset.json"]
}
```

Each manifest uses `proto-agent.dataset-manifest.v1`. It binds workspace-relative files to their byte count and SHA-256, assigns file roles, binds optional index files to the exact data file they index, and records stable entity IDs, named references, quantities, and coordinate systems. Paths cannot escape the active workspace. Before execution, Proto checks every declared file against the manifest; a changed reference or index is rejected as `COMPUTE_DATASET_IDENTITY_CHANGED`. The same files and manifest bytes participate in the compute fingerprint, so a deliberately updated manifest creates a different execution identity.

Example manifest:

```json
{
  "schema_version": "proto-agent.dataset-manifest.v1",
  "dataset_id": "study:pilot-001",
  "display_name": "Pilot count matrix",
  "files": [
    {"id": "counts", "path": "data/counts.csv", "role": "measurement", "sha256": "<64 lowercase hex characters>", "bytes": 2048},
    {"id": "counts-index", "path": "data/counts.csv.idx", "role": "index", "indexed_file_id": "counts", "sha256": "<64 lowercase hex characters>", "bytes": 32},
    {"id": "annotation", "path": "data/features.gtf", "role": "annotation", "sha256": "<64 lowercase hex characters>", "bytes": 3072}
  ],
  "entities": [
    {"id": "sample:S01", "type": "sample", "namespace": "local-study", "identifier": "S01"}
  ],
  "references": [
    {"id": "annotation:v1", "type": "feature-annotation", "file_id": "annotation", "identifier": "annotation-set-1", "version": "1"}
  ],
  "quantities": [
    {"schema_version": "proto-agent.quantity.v1", "value": 0, "unit": "count", "quantity_kind": "value", "entity_id": "sample:S01"},
    {"schema_version": "proto-agent.quantity.v1", "value": null, "unit": "mol/L", "quantity_kind": "value", "entity_id": "sample:S01", "missing_reason": "not-measured"}
  ],
  "coordinate_systems": []
}
```

The first quantity is an observed zero. The second is missing and requires its own reason; it is never rewritten to zero. The reviewed unit table distinguishes absolute `kelvin`/`degree_Celsius` from interval `delta_kelvin`/`delta_degree_Celsius`; conversion across absolute and interval temperature is rejected. Supported coordinate frames record their origin, unit, and bound source file. Coordinates from different frames or source files are not treated as directly comparable.

This is a bounded first contract for existing local analysis. It does not infer biological entities from arbitrary labels, map identifiers, authorize external downloads, or establish scientific validity. Unknown units and coordinate frames remain unsupported until they receive explicit semantics and reference cases.

## Quantity-producing computations

Two reviewed adapters add `result.quantities` while retaining all existing numeric fields. Their runnable examples contain the same arguments as the runtime catalog, plus checked dataset manifests and explicit unit bindings:

- `examples/compute/quantity-statistics.json`: `descriptive_statistics` binds `quantity_bindings.values` to `{dataset_id, entity_id, unit, quantity_kind}`. The ordered dataset measurements must exactly equal the supplied values. Minimum and maximum retain the declared unit; continuous units also support mean, median and quartiles. Integer count/index units do not receive fractional summary quantities. Variance and spread remain unquantified because squared units and absolute-temperature intervals require their own reviewed semantics.
- `examples/compute/quantity-counts.json`: `normalize_gene_expression_counts` binds `quantity_bindings.libraries` by sample ID. Each declared dataset count must equal its count-matrix column total. The returned library totals carry the `count` unit. CPM/TPM/RPKM values remain unquantified; no normalization scale is disguised as a physical unit.

Missing bindings preserve ordinary results without assigning units. Invalid declared units, mismatched measurements and unknown entities fail before calculation. Bindings participate in the compute fingerprint. Generated quantities appear in `result_value_index` with `quantity.contract_validated: true`; `compute.value.read` returns the same quantity metadata against the saved result and manifest hashes.

`compute_quantities.QUANTITY_SUPPORTED` and the explicit per-tool `compute_quantity_exemptions.QUANTITY_EXEMPT` map partition the complete registry. The census test enumerates every catalog entry and executes only the two supported examples; it does not run external engines. An exemption records missing reviewed output semantics, not a claim that a method never needs units.

## Evidence standing

Compute receipts and manifests use `compute_maturity.maturity_for(...).method_stage` as their recorded `methodMaturity`. Reopening preserves the recorded axes; legacy records do not inherit a newer method assessment. Execution success does not grant scientific validation or human review.

Compute request files under `examples/` are fixture inputs. Other requests with verified dataset manifests or declared file inputs are imported; inline-only requests are synthetic. Design check, compile and export receipts derive standing from the bound parts library. Governed eligibility requires the existing locked-catalog verifier. Export rechecks the library digest and reconstructed design; unavailable, altered or legacy unbound source cannot establish eligibility from editable IR labels.
