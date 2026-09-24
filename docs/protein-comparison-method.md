# Protein structure comparison and exploratory phylogeny

`compare_protein_structures` method `pdb-ca-sequence-kabsch.v2` selects one
model and one chain from each local PDB input. An omitted model means the first
encountered MODEL serial, or implicit model 1 when MODEL records are absent.
`model_a` and `model_b` select exact positive PDB MODEL serials. Chains are
automatic only when the selected model contains exactly one chain; multiple
chains require `chain_a` or `chain_b`. An empty chain string selects the blank
PDB chain. Returned model and chain values are the actual selection.

Residue identity retains model, chain, author residue number, insertion code,
residue name and selected alternate location. Only polymer ATOM CA records are
used. Duplicate identities, malformed coordinates, mixed model syntax and
nonfinite values fail. Alternate CA conformers use the largest occupancy, then
blank, A and lexical alternate-location order; coordinates are never averaged.
Unknown or noncanonical amino acids are recorded but excluded from the fit.

`correspondence` defaults to `sequence`: global Needleman-Wunsch over observed
residue sequences, with match +2, mismatch or unknown -1, and linear gap -2.
Multiple optimal alignments are refused, including ambiguous repeat deletions.
The alignment has a 2,000,000-cell limit. `residue_id` instead pairs exact
author-number/insertion-code tuples and requires the user to review numbering.
Both modes require at least three canonical paired residues and a sequence
identity of at least `minimum_sequence_identity` (default 0.5). The threshold
is a configurable mapping guard, not a validated homology classifier.

Mapping metadata records aligned/fitted pair counts, identity and its
denominator, unknown exclusions, observed-CA coverage for each chain, model
and chain inventories, the algorithm and method version. Coverage does not
mean coverage of the full biological sequence: no SEQRES or missing coordinate
reconstruction is performed. Per-residue rows preserve both source identities.
RMSD uses all fitted pairs; at most 1,000 rows are returned with an explicit
truncation flag. Displacement cutoffs are geometric, not statistical tests.
Regions are consecutive observed residues in both mappings and can span
unobserved residues. Modified HETATM residues and mmCIF are not accepted by this
PDB-only computation; the existing visualization supports broader input.

## Compatibility

Existing paths, chain arguments, RMSD and summary keys remain. The former
default merged chain records and paired integer residue numbers; version 2
deliberately refuses ambiguous chains and defaults to sequence correspondence.
`residue_number` and `residue_name` remain aliases for the reference (A) side.
`significant_*` keys remain compatibility names for displacement-threshold
exceedances. Re-run old requests to produce new evidence; historical artifacts
are not rewritten.

## Exploratory sequence tree

`analyze_protein_phylogeny` method `identity-nj.v2` accepts unique named,
prealigned amino-acid sequences. Canonical matches divided by the full alignment
width define identity; gaps, stops and unknown or ambiguous residues never
count as matches. The tree is neighbor joining over these uncorrected identity
distances, with no substitution-model correction or bootstrap support.

The tree is represented internally as undirected edges and serialized by
splitting the final NJ edge. All tips and branch lengths are preserved under
this arbitrary serialization root, which is not an inferred ancestor. Negative
NJ lengths are recorded before clamping to zero; the policy and affected edges
are returned because clamping can alter fitted distances. Newick labels are
quoted, with embedded quotes escaped; names are never silently normalized.
`tree_graph` exposes the same undirected nodes and edges with original leaf
names, clamped edge lengths and the final edge used for display rooting, so the
Workbench can render the actual calculation without parsing Newick text.

Focused regressions in `tests/test_protein_comparison.py` cover multichain
refusal, insertion codes, model order, renumbered rigid transforms, missing
coordinates, unknowns, repeat ambiguity, alternate locations and five-tip NJ
distance agreement with Biopython. These establish software and numerical
behavior, not biological validity of a selected correspondence or phylogeny.
