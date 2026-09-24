# ADR 0002: Bounded Research Data Access

- Status: accepted for the first host-side read path
- Date: 2026-09-22
- Scope: U04 in `OPEN_SOURCE_RESEARCH_BRAINSTORM_2026-09-22.md`

## Decision

Expose one fixed `proto_data_read` capability through the existing MCP host. It reads a bounded row page from a local Parquet file or one chunk from a local Zarr v3 array. Input paths must resolve inside the configured workspace. The operation is read-only and does not accept SQL, code, or output paths.

Parquet pages use row-group metadata to select only row groups intersecting the requested row range and selected top-level columns. The reader verifies Parquet page checksums when present, applies per-page decoded-size and response-size limits, returns schema and row-range metadata, and requires the returned `source_version` on subsequent pages. A canonical JSON hash binds each returned page. Large integers and decimals are encoded without conversion to JavaScript floating point; nulls remain null. Unsupported nested fields and missing columns fail explicitly.

Array reads support local, root-level, regular-grid, unsharded Zarr v3 arrays. A request selects exactly one chunk. Missing chunk keys produce `status: missing_chunk`; the reader does not substitute Zarr's fill value. A present chunk is read only after path validation, bounded by raw and decoded byte/element limits, and returned with metadata, raw-chunk, and canonical-value hashes. Chunk decoding failures remain explicit unreadable ranges.

The reader uses optional dependencies: PyArrow 25.0.1; Zarr 3.3.0 on Python 3.12 or later. The baseline install stays small. No external dataset, DuckDB query engine, worker pool, or remote object store is enabled by this decision.

## Limits and follow-up acceptance

This implements the first host read path, not the full U04 acceptance target. It does not yet provide renderer pagination, typed dataset manifests, DuckDB parameterized analysis plans, Zarr v2/sharded/rectilinear/remote stores, sub-chunk reads, two frozen data-size tiers, or measured memory/latency budgets. The Parquet `source_version` is a size/mtime/inode identity rather than a whole-file content hash; `page_sha256` binds the returned page. Follow-up work must add source-bound UI paging, persistent data manifests, representative size tiers, memory/latency measurements, exact ID and null tests, and missing/corrupt-range fixtures before marking U04 complete.

## Consequences

- Model-facing access returns bounded values and source ranges through a registered host tool.
- Unsupported format/layout/size cases are surfaced as diagnostics instead of being flattened, filled, or silently truncated.
- Optional formats can be enabled without increasing the default dependency footprint.
- Scientific meaning, provenance of the original source, and suitability for a particular analysis remain subject to human review.
