# Proto Workbench 0.2.0-rc.1: demo and verification scope

The September 2026 upgrade adds persistent mission execution, loaded-context
accounting, typed tool results, source-bound DNA edits, authentic protein
structure inspection and immutable candidate packaging. The public
[evidence manifest](release-evidence/0.2.0-rc.1.json) records the exact screenshot,
source-report and candidate hashes without publishing local machine state.

## Actual native demo captures

| Capture | What was exercised | Scope |
|---|---|---|
| [Harness](assets/workbench-0.2.0/harness-execution.png) | Real completed model mission, saved results, operation dependencies and review evidence reopened after app exit | Earlier native development Electron run; separate from the final fifteen samples and final package tests |
| [DNA](assets/workbench-0.2.0/dna-workbench.png) | Governed 896 bp QA construct, linked CGView/SeqViz selection, source preview/check/compile, committed undo/redo and independent SVG/PNG reopen | Final actual Portable; a software QA construct, not a biological validation claim |
| [Protein](assets/workbench-0.2.0/protein-structure.png) | Native local mmCIF import, 449 mapped residues, bidirectional selection and independently reopened 1920 x 1080 3D PNG | Exact final installer payload extracted for isolated execution; not a host installation |
| [Launchpad](assets/workbench-0.2.0/launchpad.png) | Actual module integrity and provider readiness with zero loaded instances | Final actual Portable; dark/light contrast checks both passed |

Every published PNG is byte-identical to its retained capture. No visual content
was generated, retouched or substituted. The screenshots show only the owned
Workbench surface; the public manifest omits the machine-specific fields of the
original native reports. Hashes bind those retained reports, but a public summary
alone cannot reproduce their original execution.

The protein test imported exact bytes previously retrieved from official PDB
entry 1B8J: coordinate SHA-256
`aefa239d8153b694718b8a00fefa764aa07fad12469da772234e5873119fcef9`.
Its explicit partial mapping covers chain A, 449 observed residues at protein
positions 23–471. Local import correctly retains `unknown` source classification;
the test evidence separately records the official download identity. Viewing a
structure does not promote its material eligibility or run structure prediction.

## Fifteen-task local-model debug campaign

The user reduced the planned sixty-case acceptance run to fifteen task samples.
Each sample can use several generation/tool rounds. The Harness screenshot's
15/128 counter describes a different single mission, not this campaign score.

| Task family | Direct success | After bounded retry or repair | Passed |
|---|---:|---:|---:|
| File synthesis | 5 | 0 | 5/5 |
| Paginated governed materials | 1 | 4 | 5/5 |
| Governed DNA creation | 1 | 4 | 5/5 |

Model: `qwen3.8-27b@q4_k_m`; actual loaded context: **32,768 tokens**.
Totals: **15/15 passed**, 7 direct, 8 after repair, zero host recovery, incomplete
or false completion. Across these tasks: 175 generation rounds, 170,133 generated
tokens and 5,225,736 ms of active time. All owned MCP sessions cleaned up. The run
stopped between tasks after sample fifteen, started no sixteenth sample and
verified owned model unload. No extra model campaign was run for publication.

This development/debug result covers three families. It does not meet or replace
the original sixty-case/all-family acceptance gate. Earlier protein, literature,
structure and restart probes have separate inputs and are excluded from this score.

## Other completed checks

- JavaScript: 809 passed, no failures or skips. TypeScript passed.
- Python/CLI: 242 passed, four Windows platform skips, no failures.
- Final candidate: complete locked build, unchanged original/private inputs,
  packaged module/runtime verification and both independently extracted
  distribution payloads matching the unpacked bytes.
- Actual Portable and exact extracted installer payload: **8/8 native checks
  each**, with clean owned shutdown, zero page/console errors and no model load.
  Checks include both themes, DNA history, real bundled MCP, sequence PNG,
  actual 3D mapping, export reopen and artifact/material digest preservation.
- Prior native development performance: 100 kbp / 2,000 features loaded in
  1,443.2192 ms; selection p95 17.3 ms. A 1 Mbp window and 20 document switches
  were checked. Separate quiet medium exports measured 1,062.45 ms SVG and
  1,449.64 ms PNG. These are scoped observations, not universal performance claims.
- Both public material bundle profiles passed verification, including catalog
  integrity, rights, sequence digests and quarantine isolation. The independent
  public rebuild matched the checked bundles byte for byte.

## Remaining work and limits

Candidates are **unsigned**. No disposable Windows environment was available for
installation, upgrade or uninstallation; extracted-payload checks do not cover
registry or shortcuts. Windows reputation and SmartScreen acceptance are untested.
No GitHub Release or candidate binary upload accompanies this source push.

Further work includes all twelve model task families, additional live-model
faults, final packaged-model validation, more tolerant semantic report-format
checks, structured invalid material-query diagnostics and output-budget tuning.
Original failed runs remain retained locally, separately from passing evidence.
Biological eligibility and software test success do not replace scientific or
experimental review.
