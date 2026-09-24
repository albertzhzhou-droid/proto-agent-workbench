# Protein comparative study

The comparative study combines an explicitly supplied alignment, conservation,
an identity-distance neighbor-joining tree and source coordinates in one saved
Compute run. It is available as **Protein comparative study** in Compute and as
**Compare this collection** within a multi-protein Design artifact.

## Input and coordinate contract

- Supply 2–50 uniquely named protein sequences already aligned to equal lengths.
  Each row contains 10–2,000 canonical amino acids or `-` gaps, with at most
  10,000 alignment characters across the study. Two rows produce conservation
  and coordinates without a tree.
- Compute accepts a JSON array of `name` and `sequence` objects. Design accepts
  named FASTA. The **Insert source sequences** action copies the current source
  records; it does not perform alignment or establish homology.
- Design requires each name and ungapped sequence to match exactly one current
  artifact record. Source identity, sequence digest and coordinate maps are
  checked before residue selection. Alignment columns display from 1; internal
  sequence offsets begin at 0. A gap maps to `null` and selects no residue.
- Structure selection uses the existing validated structure mapping. A sequence
  offset is never treated as a PDB residue number. The corresponding chain,
  model and insertion-code behavior is described in
  [protein-comparison-method.md](protein-comparison-method.md).

## Saved results and UI

The canonical `analyze_protein_comparison` registry entry is shared by Compute,
Design and tool access. Inputs, result JSON and the execution manifest are saved
under `build/compute/<run-id>/`. The renderer reopens the complete result and
checks its SHA-256 against the receipt, including results too large for the
inline tool preview. Tool identity and the ordered submitted sequences must
match the displayed study.

The view shows 50 alignment columns at a time, conservation with numerical
descriptions, and the complete tree. Tip controls select the same active
alignment column. Tree rooting is arbitrary for display; branch distances are
used when positive and topology-only spacing is explicitly identified when all
lengths are zero. The JSON export contains the displayed study; the separate
run record retains execution provenance.

Changed input drafts leave the prior result explicitly marked as the last run.
Changing the bound Design artifact clears its comparison. Invalid input cannot
silently pad sequences or reuse a different artifact's coordinates.

## Scientific and delivery scope

These are supplied-alignment calculations. Automatic multiple alignment,
substitution-model selection, bootstrap support, validation of homology and
biological-function inference are not implemented by this study. An exact
sequence match is a coordinate-binding condition, not material eligibility.

The browser development server executes the local Python runtime. A static
browser build only replays its visibly identified recorded examples. Browser
UI checks and synthetic numerical fixtures do not establish native installer
acceptance or validation on a biological reference dataset.

Saved runs can now be associated with named [research projects](research-projects.md)
and reopened across sessions. Reopening verifies the input, result, manifest and
provenance against the project's saved hashes before displaying the alignment.
The retained three-sequence software fixture was reopened through the real UI,
including its gap coordinate and tree. This does not establish native multi-protein
structure acceptance or biological reference-dataset validation; those remain in
[research-upgrade-plan.md](research-upgrade-plan.md).
