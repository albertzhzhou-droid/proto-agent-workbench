---
name: scientific-sequence-visualization
description: Read, inspect, search, select, and export DNA maps or protein sequence views with schema validation, digest checking or explicit unverified status, canonical coordinates, bounded rendering, accessible encoding, and render-then-verify QA. Use whenever sequence visualization or export behavior changes.
---

# Scientific Sequence Visualization

Treat data fidelity as a correctness requirement. Reject malformed DNA or protein schemas. For protein IR, recompute each record's sequence digest and enforce its governed source, rights, eligibility, and safety fields. For DNA artifacts, compute the current file digest and show whether a matching provenance claim is present, mismatched, or unverified. Missing provenance remains a visible gap rather than proof of integrity; a known mismatch or an invalid provenance inventory blocks export.

Keep source coordinates canonical and immutable. Rotation, strand direction, circular-origin crossing, selections, annotations, primers, motifs, ORFs, and exported intervals must round-trip to the same source span. Search DNA or protein by identifiers, labels, metadata, or sequence while bounding results and derived work. Large inputs use windowed or summary rendering.

Use colorblind-safe redundant encodings, stable colors for the same entity, legible labels, keyboard-operable controls, and explicit labels for derived data. Export metadata records the current artifact digest status, enumerates map layers included in the export, and explicitly lists UI or sequence layers excluded from it. For release QA, render representative linear DNA, circular DNA, large-sequence, malformed-artifact, and protein cases and inspect the result perceptually when a GUI runtime is available.
