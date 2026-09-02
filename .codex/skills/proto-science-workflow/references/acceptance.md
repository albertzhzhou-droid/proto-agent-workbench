# Acceptance contracts

## LM Studio provider

- Treat `GET /api/v1/models` as the authoritative rich catalog and retain the exact model key, capabilities, maximum context, quantization, size, and loaded-instance state.
- Require explicit model loading before chat. Reconcile loaded instances immediately before a request so an external LM Studio change cannot be mistaken for Workbench state.
- Send chat through the loopback OpenAI-compatible API, bound to the selected exact model key. An optional API token is read only from the configured environment variable and is never persisted or logged.
- Unload only an instance created and tracked by Workbench. Never eject an instance merely observed in LM Studio.
- Verify discovery, explicit load, one bounded response, and owned unload independently.

## Materials promotion audit

Run at least three independent passes and retain a machine-readable decision for every candidate.

1. Provenance and rights: stable namespaced ID; retrievable source record and revision; response/content SHA-256; license URL, attribution, rights notes, and explicit redistributable status.
2. Sequence and scientific semantics: supported domain and part ontology; permitted alphabet and bounded length; source sequence hash; no unsupported conversion between DNA, protein, reaction, or computational-model records.
3. Safety and consistency: no hard safety flag; duplicate and collision checks; normalized-record validation; catalog round-trip; model-visibility and materialization checks.

Promote only records passing every pass. Report counts before and after, rejection reasons, exact source snapshot, and whether the new snapshot remains inactive.

## DNA and protein visualization

- Validate the artifact schema and recompute sequence digests before rendering a success state. Missing provenance, rights, eligibility, or safety metadata remains visible as a failure or gap.
- Keep source coordinates canonical and non-mutating. Coordinate transforms, circular-origin rotation, selections, annotations, primers, ORFs, motifs, and exports must round-trip to the same source interval.
- Bound rendering, search results, selections, and derived analyses. Large inputs enter an explicit summary or windowed mode rather than freezing the renderer.
- Make each visible glyph identifiable without relying on red/green contrast. Use stable entity colors, legible labels, keyboard-operable controls, and explicit derived-data labels.
- Export metadata must enumerate every active rendered layer and bind the exact artifact digest, dimensions, and software-derived settings.
- Render and inspect representative linear DNA, circular DNA, large-sequence, malformed-artifact, and protein cases after automated tests pass.

## Public inspiration and license boundary

This project-specific contract was informed by the public AcademicForge catalogue and its Apache-2.0 Claude Science entries `figure-style`, `managed-model-endpoints`, and `using-model-endpoint`. It adapts only product-level workflow principles to Proto's existing local architecture; it does not copy Claude-specific host SDK behavior or imply those external tools are installed.
