# September 5 roadmap acceptance

## Delivery

The bounded Structure Studio Next 1–5 queue is implemented in the local
`0.1.0a2` checkout. The owner selected MIT. The English UI now connects a real
coordinate viewer, LM Studio proposals, explicit approval, supervised numerical
calculation, persistent projects and evidence export through the shared Python
service. [Next-cycle work](NEXT_STEPS.md) separates broader promotion and
distribution gates from the completed product increment.

The original M0–M9 architecture is not a blanket release certification: M7
requires a larger independent model-promotion suite and platform evidence;
M8 here is a configured local Windows preview. M10/M11 remain optional outside
the MVP. The repository's existing untracked baseline has not been committed
or published by this acceptance run.

## Debug and implementation findings

- Added a statically registered first-party ComputeAdapter. Resolved plans bind
  prepared input before approval, worker/policy/interpreter/lock hashes and
  installed result-relevant package/data fingerprints. Changed inputs or
  environment reject stale authorization.
- Added host-owner/workspace approval binding, cancellation, interruption
  recovery without replay, CPU/memory ceilings and owned scratch cleanup.
  Windows workers enter a Job Object while suspended. The file store trusts
  the local OS user; this is not hostile-user or network/filesystem isolation.
- Workflow identity now includes source and attachments in addition to the
  resolved plan. Identical water geometry under changed source cannot inherit
  the old workflow's approval. Stored result tampering is rejected on reopen.
- The frontend prepares, approves, executes and plots actual results; history
  survives reopening. Explicit edits invalidate dependent UI authorization.
  Corrupt project records return a JSON error instead of disconnecting HTTP.
- RDKit imports bounded SMILES/SDF, retains isomeric identity and supplied SDF
  coordinates, and labels generated conformers. Geometry edits preserve atom
  identity and create immutable revisions. ASE constructs bounded Cu(111)
  slabs/adatoms from the supplied FCC parent. Comparisons report displacement
  only for matching atom composition and mapping.
- Improved model object-ID grammar and tool selection after a failed initial
  evaluation. One mechanical schema repair is separately budgeted within five
  model turns. Neither repair nor model text can grant execution authority.
- Native evidence export now permits only same-origin Blob resources and saves
  them under the preview workspace with unique sanitized filenames; foreign
  resources remain blocked.
- Two stale regression expectations were corrected: the registry now has two
  adapters, and a nonzero-temperature declaration is rejected by the compiler
  before workflow preparation. Native tests were updated to handle their own
  unsaved replacement prompt and retained successful calculation history.

## Evidence

| Gate | Result | Local artifact |
|---|---|---|
| Full regression | 325 passed in 258.53 s; Ruff formatting/lint and strict mypy pass; one upstream ASE/NumPy deprecation warning | `scripts/verify.ps1` |
| Development model set | 4/10 before controller changes; failures retained | `build/model-evaluation-2026-09-05.json` |
| Independent local held-out set | 12/12; seven admitted tasks, five correct abstentions, zero schema repairs; p50 3.5 s, p95 10.71 s | `build/model-evaluation-heldout-2026-09-05.json` |
| Fresh model-to-execution parity | 2/2 real workflows; equivalent direct/model logical and resolved plans; host harness separately authorizes each | `build/model-execution-acceptance.json` |
| Water HF/STO-3G | −74.96292824697167 hartree; explicit installation geometry and isolated Psi4 | Same parity artifact and per-run raw files |
| Copper ASE/EMT | Lowest tested scale 1.00, −0.0049525205258378335 eV/atom; also evaluated 0.98 and 1.02 | Same parity artifact; no stability claim |
| Model identity | LM Studio Gemma 4 E2B Q8_0, 8192 context, GGUF/projector/template hashes and loaded configuration | `build/model-identity-2026-09-05.json` |
| Offline installation | Fresh CPython 3.13.3 environment, cached wheel/dependencies only; installed-package compilation and supervised non-scientific mock pass | `build/offline-release-acceptance.json` |
| Native interaction | PASS, zero page errors: copper curve, approvals, revision reopen, chiral import, editing/comparison, slab, water and export reopen | `build/desktop-acceptance.json` |
| Packaging | Locked unique stage, copy-time source stability, file manifest verification; MIT and actual dependency notices | `build/desktop-latest.json`, stage `release-manifest.json`, `third_party/manifest.json` |

Cache population used PyPI before the explicitly offline installation test.
Two successive final wheel builds produced identical SHA-256 hashes; a fresh
offline installation of that artifact also passed source checking. See
`build/wheel-reproducibility.json`.
Source/wheel contents were inspected: no scientific environment, model weights
or cache was included (the source archive contains only `build/.gitkeep`). The
build backend is pinned to Hatchling 1.32.0. The native preview references
existing Python/Psi4 paths; it is not a portable backend installer.

Native GPU launch failed inside the restricted execution environment. Running
the identical Electron configuration under normal Windows permissions resolved
it; renderer sandbox and context isolation remained enabled, Node integration
disabled. No pressure test, WSL acceptance, full accessibility certification,
external experimental validation, remote release or device operation is claimed.

## Reproduction

Run `scripts/verify.ps1`; use `scripts/evaluate_local_model.py` for a new labeled
evaluation, preserving prior artifacts. `scripts/verify_model_execution.py`
performs two explicitly authorized installation calculations through LM Studio
proposals and direct-plan comparisons. The native package procedure is in
[desktop-preview.md](desktop-preview.md). Its test harness is
`scripts/verify_desktop.cjs` and requires an installed Playwright Electron client.

Primary toolkit provenance is recorded in the installed dependency manifest,
[viewer record](viewer-dependency.md), and [backend decision](decisions/0006-m0-backend-pinning-and-execution-route.md).
