# DNA source editing and placement semantics

DNA editing operates on `.proto` source and the exact materialized parts library. Resource IDs come from governed material search, materialization, and parts search. Local occurrence IDs identify repeated placements of a resource; they are not biological identifiers.

```text
cds <materialized-resource-id> instance=slot_03 orientation=reverse
annotation note_01 {"name":"Review region","type":"misc_feature","anchors":[{"instance_id":"slot_03","start":0,"end":30,"direction":0}],"origin":"user"}
```

This syntax example is a placeholder, not an executable biological design. Annotation bounds must fit the selected source sequence. Anchors use zero-based, half-open coordinates on the original part reference. The compiler transforms these coordinates after placement and reordering. Multiple non-overlapping source spans are supported; their declared ordering is preserved.

`orientation=reverse` applies the versioned `iupac-dna.v1` reverse-complement transform. It does not establish biological strand or functional validity. Unknown source direction stays zero; an explicitly declared source or annotation direction transforms independently. IR v2 records original and transformed sequence hashes, placement, canonical source anchors, resolved locations, source-file hash, and parts-file hash. Legacy designs retain IR v1 and its existing grammar/export behavior.

The typed editor prepares commands for occurrence reordering, orientation, and annotation upsert/deletion. Preparation returns candidate source, a unified diff, diagnostics, and source/library digests without writing. Applying a candidate uses the host's source-and-library compare-and-swap boundary and runs validation/compilation. Stale sources or libraries require a fresh preview; the renderer does not modify IR directly. Review recompile checks bind IR v2 artifacts back to the exact source and library.

After an edit, undo, or redo, the viewer selects the output named in the commit
receipt only when its source digest, parts digest and construct also match.
Byte-identical inventory entries retain their individual output paths when
grouped under a stronger provenance representative. Invalid or digest-mismatched
entries cannot contribute aliases. If the committed output cannot be selected,
the previous view remains open with a diagnostic; the viewer does not silently
switch to another DNA or protein document.

DNA views support a configured full-map envelope of 100,000 bases and 2,000 features, plus an 8,000-base sequence window. Larger supported inputs use windowed inspection up to 1,000,000 bases and 20,000 features; map export remains disabled outside the full-map envelope. These are implemented bounds. Focused parser timings do not certify native frame rate, accessibility, export fidelity, or release performance; those require the native QA gate.

`build/upgrade-20260904/dna/placement-toy.proto` is a clearly labelled development fixture. It passed check, compile, workflow, and review software gates. It provides no scientific or wet-lab validation.
