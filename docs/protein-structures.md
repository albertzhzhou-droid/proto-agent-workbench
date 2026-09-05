# Protein structures and sequence landscapes

Select a compiled protein artifact in Designs, then choose a protein record.
The sequence workspace remains available before any structure is attached.
Sequence search, range navigation, composition, source identity, and review
status use the selected protein's sequence digest.

## Coordinate sources

The structure panel searches official PDB or AlphaFold metadata, downloads a
selected coordinate file, or imports a local PDB/mmCIF file through the native
file picker. Source bytes are stored independently under `build/` by content
digest. Each attachment records its provider, accession, URL, retrieval time,
license attribution, and experimental, predicted, or unknown classification.
Attachment or viewing does not promote a material into the eligible catalogue.

Mol* loads when a structure is opened. Cartoon, surface, and sticks, chain/model
selection, focus, reset, and image export use the same attachment. Sequence to
structure linkage retains author and label residue numbers, insertion codes,
chain, model, and missing positions. Exact mapping is automatic when unique.
An explicit placement is accepted only when the deposited sequence matches the
specified range. Ambiguous or mismatched coordinates remain viewable without
asserting a sequence mapping. No structure prediction is performed.

Sequence landscape tracks show sequence-derived hydrophobic and charged residue
fractions. Observed coverage uses the selected, validated mapping. Prediction
confidence is shown only when its source identifies it; experimental B factors
are not relabeled as pLDDT. Missing coverage and unavailable confidence remain
explicit. WebGL failure leaves the sequence and tracks usable, with a control to
reload the molecular view.

## Saved views and figures

Save a structure view to retain its source digests, model, chain, representation,
color, selected range, explicit placement, and camera. Restoring rechecks the
binding before applying it. A structure screenshot exports PNG. Export tracks
SVG or PNG is also available without a structure attachment.

The host reopens the protein artifact and optional coordinate attachment before
preparing a sequence landscape. It independently recomputes the mapping and
tracks, generates the SVG, and binds the selected range and algorithms to the
figure metadata. Exported files are reopened and decoded before a success
receipt is returned. Each receipt and metadata file lives beside its figure in
`build/`; original protein IR and coordinate bytes remain separate.

## Sequence metrics

New compilations use a versioned average-mass algorithm that subtracts water
once per peptide bond. Independent reference values test this calculation.
Unknown or ambiguous residue masses produce an unavailable result rather than
an arbitrary precise mass. Existing IR bytes are preserved and historical
metrics retain their algorithm label; recompilation creates a new artifact.

These are software inspection and export capabilities. They do not establish
experimental function, suitability, licensing clearance beyond recorded rights,
or scientific approval. Native visual, performance, and packaged checks are
reported independently in the candidate evidence under `build/upgrade-20260904/`.
