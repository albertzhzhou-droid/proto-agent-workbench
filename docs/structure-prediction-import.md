# Local ColabFold result import

`compute_structure_prediction.import_colabfold_result(arguments, files)` imports
existing local result bytes. Its one tool ID is `import_colabfold_result`; the
module exports exactly one `TOOLS` entry and one `HANDLERS` entry and needs only
the Python standard library. Import is not prediction-job submission, inference,
GPU validation, upload, job recovery or proof of prediction completion.

## Accepted producer format

Supply a single-model ColabFold PDB and its per-model `scores` JSON object, using
`structure_path` and `scores_path`. `expected_chains` optionally supplies ordered
`{chain, sequence}` entries for an exact identity/sequence check after ASCII
uppercasing. No sequence alignment, chain reassignment or residue renumbering is
performed. Multiple chains are accepted only in their contiguous PDB file order.

The current [ColabFold writer](https://github.com/sokrypton/ColabFold/blob/main/colabfold/batch.py)
stores per-residue pLDDT in both the PDB B-factor column and `scores.plddt`. The
JSON writer rounds pLDDT and PAE entries to two decimal places; `max_pae` is the
maximum of the unrounded PAE matrix, not the theoretical PAE ceiling. Optional
`ptm` and `iptm` are imported when present. The importer accepts a B-factor/pLDDT
difference of at most `0.0100001` points and a matrix-maximum/`max_pae` difference
of at most `0.0050001` angstrom. Larger disagreements are errors with the affected
index/identity and tolerance reported. This contract was checked against the
official writer on 2026-09-22; no upstream prediction code is copied or executed.

This is a narrow ColabFold import profile, **not general PDB support**. It requires
canonical amino acids, positive and consecutive numbering within each chain, one
CA per residue, balanced model delimiters and an `END` record. It rejects alternate
locations, insertion codes, HETATM components, missing CA atoms, duplicate atom or
residue identities, interleaved chains and multiple models. All supplied ATOM
coordinates, occupancy and B-factor fields are checked; only CA coordinates are
returned. It does not assess side-chain completeness or stereochemistry.

`TER` closes the preceding observed chain. A later ATOM record cannot reuse that
chain ID, including a continuation of the same residue; normal `A -> TER -> B`
ordering remains supported. Leading, duplicate or model-external TER records are
rejected. This check does not add validation of TER's identifying columns and
also recognizes a bare TER record. It is a chain-boundary guard, not a general
PDB record validator.

CA coordinates and residue identity objects reuse
`compute_structures._comparison_chain` and `_residue_identity`, which are already
used by protein structure comparison. Additional profile checks do not introduce
a second sequence correspondence algorithm.

## Numeric and size boundaries

- At most **384 residues total**, 62 chains, a 2 MiB PDB and a 4 MiB scores file.
  A complete JSON result must also fit the existing 4 MiB Compute result limit.
  Greater precision or extra structure detail may hit that limit earlier; no
  residues or PAE cells are silently truncated.
- pLDDT is required: one finite non-boolean number in `[0,100]` for every PDB
  residue. Missing pLDDT or a length mismatch is an error, not a B-factor fallback.
- Present PAE must be an exact `N x N` matrix of finite non-boolean values in
  `[0,1000]` angstrom. The upper limit is an operational bound, not a universal
  biological maximum. Both axes map to the returned residue indices; raw matrix
  orientation is preserved without transposition or symmetry enforcement.
- pTM and ipTM, if present, must be finite non-boolean values in `[0,1]`.
  Missing optional metrics are explicitly `unavailable` with `null` values and a
  reason. `max_pae` without a PAE matrix is inconsistent and rejected.
- JSON duplicate keys, NaN/Infinity, overflowing exponent numbers, wrong top-level
  formats and excessive nesting/item counts are rejected. Extra producer fields
  are named in `unimported_score_fields` and bound by the original source hash,
  but are not interpreted as imported scientific evidence.

## Return contract

The schema is `proto-agent.structure-prediction-import.v1`:

- `operation: "result-import"`, `prediction_execution: "not-performed"`, `scope`.
- `sources.structure_path` and `sources.scores_path`: supplied relative path,
  byte length and SHA-256 of the **complete original bytes**, including JSON
  whitespace or a BOM. Hashes are not based on a reserialized subset.
- `structure`: coordinate unit `angstrom`, model, chain/residue counts, ordered
  `chains` with sequence hashes and half-open index spans, and ordered `residues`
  with zero-based `index`, existing parser `identity`, `coordinates_angstrom`,
  pLDDT, PDB CA B-factor and `/plddt/<index>` source pointer.
- `confidence`: scores-file attribution; pLDDT values and descriptive summary;
  PAE availability, full matrix, dimensions and producer/matrix maximum fields;
  pTM/ipTM availability and values. Missing values are not fabricated zeros.
- `mapping`: explicit PDB encounter order, expected-sequence check status,
  B-factor consistency/tolerance and `same_prediction_provenance: "unestablished"`.
- `diagnostics`, `limitations`, `unimported_score_fields`.

Matching sequence lengths, B-factors and residue identities establish internal
content consistency. They do **not** prove that the JSON and PDB came from the
same prediction run. Independent predictor manifests or hashes would need a
separate verified provenance contract. Likewise, pLDDT and PAE are model confidence
outputs, not experimental validation or biological/clinical correctness; see the
[AlphaFold confidence documentation](https://alphafold.ebi.ac.uk/faq).

## Workspace reader integration

The handler performs no filesystem reads; `files` contains already guarded bytes.
It checks the supplied path text with the existing
`security._validate_relative_path_text`, but textual validation alone cannot prove
filesystem containment. The caller must use the normal Compute `file_inputs`
dispatch (`compute.py`):

```python
bound = paths.workspace_file(
    arguments[field], extensions=declaration["extensions"],
    max_bytes=declaration["max_bytes"],
)
data = read_bytes_bounded(bound, declaration["max_bytes"])
```

`WorkspacePaths.workspace_file` rejects absolute/traversing paths, symlink,
junction/reparse components, multiple hard links and nonregular files; the bounded
reader rechecks file identity and path components around the read. Do not replace
this with `Path(user_input).read_bytes()`. Pass these same bytes to the handler and
Compute provenance; re-reading separately would weaken the content binding.

## Verification evidence

`tests/test_structure_prediction_import.py` contains 20 focused tests, including
independent fixed-column fixtures, reused identity mapping, multichain order,
asymmetric PAE preservation, negative/NaN/bool/range failures, missing metrics,
rounding tolerances, raw-byte hash changes, expected-sequence mismatches, format
and size rejection, exact result-byte limits, no handler filesystem access,
TER chain-boundary cases, and the existing workspace-reader dispatch. The reparse
test simulates the guard's inspection result so it does not require Windows
symlink privileges; it is not a claim of a separate OS-level symlink campaign.

Run from the repository root:

```text
.venv\Scripts\python.exe -m unittest discover -s tests -p test_structure_prediction_import.py -v
```

The retained historical public 1CRN PDB/scores pair under
`build/structure-prediction-import-20260922/` also passed direct guarded-byte import:
46 residues, one chain and a 46 x 46 PAE matrix. Its mean pLDDT near 39 is a value
from the old predictor output, not a new inference result or evidence of accuracy.
The historical source provenance remains separate from the importer's consistency
claims. No GPU, model loading, database search or sequence upload is part of this
verification.

The TER follow-up passed all 20 importer tests; its log is
`build/structure-prediction-import-20260922/backend-ter-retest.log`. The historical
1CRN pair also passed another guarded import after that fix, with unchanged source
hashes, recorded in `backend-ter-historical-retest.log` in the same directory.
The earlier TER failure reproduction remains in `backend-ter-review.log`.

## Compute UI acceptance and remaining work

The current catalogue contains **126 tools in 18 groups**, including this import
tool. The actual Compute UI imported the retained historical 1CRN files and
displayed 46 residues and the 46 x 46 PAE matrix. Raw asymmetric values were
preserved: `PAE[0][1] = 1.33` and `PAE[1][0] = 1.55`. A mismatched expected sequence
was rejected; the earlier successful run remained visible and labelled. These
checks are recorded in `build/structure-prediction-import-20260922/ui-acceptance.json`.

The saved result was independently reopened, and its SHA-256 and both input byte
hashes matched their recorded values. **Browser JSON download has not passed
acceptance**: no download event or resulting Downloads file was observed. Saved
artifact verification does not substitute for that download check. The result
import and confidence view are delivered; prediction-job submission, runtime/input
binding, owned queue/cancellation, recovery and inference remain unfinished.

The separate final check in
`build/research-upgrade-20260922/final-check-20260922T020536.332278Z/` passed 47 selected
Python tests and 89 of 90 Node tests. Its sole Node failure was an outdated
17-group assertion after the catalogue gained its 18th group. That failed run is
retained unchanged. After updating the assertion, the six Compute presentation
tests passed, recorded in
`build/research-upgrade-20260922/compute-presentation-group-count-retest.log`.
This focused retest does not rewrite the original run as 90/90; the suites overlap
and are not independent scientific acceptance totals.
