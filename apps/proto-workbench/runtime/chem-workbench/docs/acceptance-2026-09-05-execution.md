# Governed execution acceptance and debug review

Date: September 5, 2026. Scope: the newly implemented roadmap Next 1-3
source-checkout CLI slices. The checkout is untracked, so this review describes
observed files and behavior rather than attributing changes to a Git commit.

**Decision:** the corrected bounded CLI workflows pass acceptance. The general
M2 gateway and complete desktop/model design workflow are not closed.

## Findings fixed

| Finding | Correction and regression evidence |
| --- | --- |
| A stored plan could change acceptance, candidate coordinates or actions without detection. | Recompute the entire plan hash on save/load; recompute draft and candidate hashes; validate fixed profiles. The approval command also verifies the actual file being reviewed. |
| Approval used a historical worker hash without checking the current file. | Recheck current script, interpreter, lock and applicable launcher hashes at approval/submission and before execution. Existing plans with the old identity format require fresh resolution and approval. |
| The process began running before Job Object assignment. Assignment failure could leave it alive. | Create suspended and hidden, assign, then resume the initial thread; failure kills the suspended process. Tests prove no worker marker appears on assignment failure and a real descendant terminates on deadline. |
| Pipe capture was unlimited until after process exit; a missing output with exit code 0 could be successful. | Bound capture during reads, supervise result-file size, fail on limits or missing output, retain failure records. File-size polling is not a hard filesystem quota. |
| Real jobs were evidence-eligible before validation; false water success and foreign copper outcomes could pass. | Start ineligible; require strict water success and acceptance window, exact copper candidate coverage, unique identities, matching scales and units, and consistent total/per-atom energies. Rank with Decimal. Invalid results remain failed and ineligible. |
| Concurrent submissions could overspend the launch budget; store identifiers allowed path components. | OS byte-range submission lock, validated identifiers, unique temporary files, and fail-closed launch reservations. A bounded concurrency test checks the second submit is busy and spends no launch. |
| Resolution admitted malformed or unsupported input. | Bound deadlines/output, require neutral singlet H2O, and validate 2-9 pure-copper candidates with unchanged fractional sites and uniformly scaled cells. Malformed CLI JSON returns an error without a traceback. |
| Psi4 version was hardcoded and raw QCSchema JSON was silently truncated. | Read the installed Psi4 version and preserve complete raw records subject to the host result cap; use per-run scratch and a bounded environment allowlist. |

## Verification

- Baseline `scripts/verify.ps1`: 274 passed.
- Final `scripts/verify.ps1`: Ruff format/lint passed, strict mypy passed for
  35 source files, **304 tests passed in 78.71 seconds**. This adds 30 focused
  regressions; the governed execution module now has 40 tests.
- One upstream ASE/NumPy deprecation warning remains: assignment to array shape
  in `ase/atoms.py`. It does not affect these acceptance results.
- Browser interaction: selected and compiled `fcc-copper.chem`, prepared the
  model-free scan, and observed `DRAFT_PREPARED` with 0.98/1.00/1.02 preview
  controls and 32 display atoms. UI correctly continues to say no calculation
  was executed. No frontend source was changed in this review.

Machine-readable evidence with exact run paths and result hashes is in
[`build/execution-acceptance-2026-09-05.json`](../build/execution-acceptance-2026-09-05.json).
The full gate artifacts are in
`build/pytest-e08606bb54db42beb023d942b5fb2299`.

| Real calculation | Result |
| --- | --- |
| Water, QCEngine/Psi4 HF/STO-3G | -74.96292824697167 hartree; inside the installation window. Psi4 1.11, QCEngine/QCElemental 0.51.0, Python 3.12.14. |
| Copper, ASE/EMT, scale 0.98 | 0.0008491365033966858 eV/atom |
| Copper, ASE/EMT, scale 1.00 | -0.0049525205258378335 eV/atom; lowest among these three evaluated candidates |
| Copper, ASE/EMT, scale 1.02 | 0.02244780294570159 eV/atom |

Copper used ASE 3.29.0, NumPy 2.5.2, Python 3.13.3. There were no excluded
candidates in this real batch. These are installation/profile checks, not
experimental validation, phase stability or general materials-design evidence.

## Remaining gates and limits

- The implementation plan's general M2 contract still needs a registered compute
  gateway, owned-job cancellation and interruption recovery, workspace/actor
  authority integration, exact prepared artifacts before approval, complete
  relevant library/data/basis/potential/policy fingerprints, and resource and
  scratch lifecycle policy. Current script/interpreter/lock hashes are narrower.
- The store and checkout assume a trusted local OS user. JSON approvals are not
  signatures or protection against an owner rewriting local files. Job Objects
  supervise processes; they do not enforce a filesystem/network sandbox.
- The synchronous store lock rejects a competing submission with `EXECUTION_BUSY`;
  retry after completion. A crash after budget reservation can consume a launch
  without executing; no automatic retry or recovery is claimed.
- Frontend approval, execution, job status and computed-result plots are pending.
  The existing UI and Gemma 4 E2B orchestrator retain read/derive-only authority.
- No pressure tests, new model evaluation, packaging/native acceptance, broader
  chemistry profiles or Next 4 implementation were performed. No commit or push
  was made.

The roadmap and implementation status were corrected to reflect these limits.
