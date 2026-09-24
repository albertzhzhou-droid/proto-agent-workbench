# Research and engineering upgrade programme

This plan implements the academic, product and engineering improvements accepted
in the current task. It describes the full scope; a completed foundation does not
mean the programme is complete. Existing uncommitted changes are retained.

Implementation is paused at the user's request after the F4 local acceptance
increment on 2026-09-22. Remaining requirements stay open. The separately requested
open-source ecosystem brainstorm is research documentation, not another
implementation increment or a claim that this programme is complete.

## Acceptance ledger

| ID | Requirement | Status | Evidence required |
| --- | --- | --- | --- |
| A1 | Correct protein correspondence, model/chain identity and insertion codes | In progress | Independent multi-chain, insertion, missing-residue and renumbering cases; mapping coverage and diagnostic output |
| A2 | Bind scientific answer quantities, units, identities and citations to evidence | In progress | Retained erroneous-label/unit cases rejected or marked unverified; unsupported prose never gains scientific verification |
| A3 | Scientific maturity and applicability per computation | Inventory implemented; domain assessment pending | Catalogue, run manifest and UI labels; explicit demonstration methods; test definitions distinguished from live acceptance |
| A4 | Statistical intervals, effect sizes and research design | In progress | Independent numerical references, degenerate-input cases, sample/paired/batch contracts |
| A5 | Persistent claim-to-source review | Implemented; bounded local acceptance passed | Exact source location, partial reading scope, support/contradiction, explicit review and persistent source invalidation checked through service and real browser UI; native release and scientific interpretation remain separate |
| A6 | Independent scientific and model benchmarks | Pending | Frozen public datasets/references, task families, repetitions, baseline/ablation and distinct outcome denominators |
| E1 | Shared reliable tool execution for Chat and Harness | Pending | Durable intent/effect receipts; interruption at effect boundaries; no duplicate writes |
| E2 | Durable research state, paged storage and migrations | In progress | State, indexed summary paging, bounded lazy loads and explicit ownership recovery accepted locally; normalized messages, transcript paging and recovery-notice paging pending |
| E3 | Dependency-complete clean-environment CI profiles | Implemented; hosted and WSL execution pending | Explicit base/numeric/heavy profiles, real execution counts, lock consistency and WSL gate boundary |
| E4 | Unique build identity and clean-machine delivery | In progress | Source/dependency hashes, final artifact binding, dependency-missing paths, native/installation gates |
| E5 | Domain service boundaries and current evidence dashboard | Pending | Shared contracts, small domain interfaces, per-artifact acceptance states and timestamps |
| F1 | Protein comparative research workspace | In progress | Named alignment import, conservation/tree/structure linked coordinates, real saved runs, invalid cases and UI inspection |
| F2 | Local structure-prediction results and job management | In progress | Result import, confidence/PAE UI and saved-result hash verification delivered; local input/runtime binding, owned queue/cancellation, recovery and inference pending |
| F3 | RNA-seq study workspace | Implemented; bounded local runtime, reference and UI acceptance passed | Raw counts/sample QC, fixed design/contrast, DESeq2/PCA/plots, supplied-set enrichment and saved-project reopening checked; native delivery and scientific interpretation remain separate |
| F4 | Editable reusable workflow and selective reruns | Implemented; bounded local host, runtime and UI acceptance passed | Typed DAG, immutable versions, input/parameter/runtime-aware reuse, forced descendants, retained failure/cancellation and explicit recovery; native delivery and E1 effects remain separate; see [the implementation contract](research-workflows.md) |
| F5 | Bayesian calibration and global sensitivity | Pending | Joint posterior/diagnostics/predictive checks and Sobol/Morris reference cases on bounded models |
| F6 | Data-bound figure panels and methods report | Implemented; local artifact/UI checks passed; browser download and native delivery pending | Multi-panel composition, source/version bindings, stale-panel state, independently reopened SVG/PDF and generated methods; retain separate download evidence |

## Delivery sequence

1. Repair scientific identities and statistical inference; make CI dependencies
   reproducible; expose a real protein comparison workflow using existing tools.
2. Complete scientific maturity/claim checks, persistent study state and the
   figure/report surface. Reuse the existing workbench visual system and services.
3. Add structure-prediction result/job integration and RNA-seq studies; use the
   existing local engines rather than duplicate their implementations.
4. Add reusable workflows and advanced inference; validate representative public
   datasets and the complete model/release matrix.

Run focused tests and single-concurrency functional checks during development.
Stress campaigns, external publication and release installation are separate
operations; no prior passing report automatically certifies the current tree.
Generated inputs, results, screenshots and acceptance receipts stay under build/.

The UI continues the existing Chat / Design / Compute surfaces, neutral theme,
scientific colour encoding and source-bound inspection. No fourth workspace mode
or replacement implementation of the scientific engines is introduced.

## First implementation increment

- A1: structure correspondence preserves model, chain and insertion-code
  identities, rejects ambiguity and reports coverage. Neighbor-joining output
  preserves all tips and reports branch-length limitations. The independent
  cases are synthetic software/numerical references, not a biological benchmark.
- A3/A4: all 125 methods receive conservative maturity metadata; selected demos,
  heuristics and numerical-reference definitions have explicit assessments.
  Supported group comparisons and Pearson correlation expose intervals, signed
  effects and assumptions. Batch/research-design support remains outstanding.
- F1: named supplied alignments now produce a saved comparison with conservation,
  tree and source coordinates. Compute has a working interactive view and
  independently verified JSON export; Design has exact-source linkage and a
  single-record guard. Cross-session study reopening was added in the later
  research-project increment below; native multi-protein structure acceptance
  remains outstanding.
- E3: dependency/test profiles and clean-base checks are recorded in
  `build/ci-validation/`. Tests with absent scientific dependencies report an
  unsupported environment rather than a passing result. Hosted CI, heavy CPU
  and WSL engine acceptance have not run in this increment.

Focused evidence is retained in `build/research-upgrade-20260922/`. The initial
foundation report contains 81 Python and 26 renderer tests, all passing; later
name/Unicode boundary repairs have separate six-test Python and 18-test renderer
retest logs. These suites overlap and must not be added as independent totals.
The downloaded study JSON was reopened and matched the saved result semantically;
its exact download hash and the run-result hash are both recorded. No earlier
failure, model campaign or scientific acceptance record is replaced by these
checks.

## Research state and evidence increment

- A2: known acid-base and qPCR fields are projected from reopened, hash-checked
  receipts. Unsupported model interpretation remains unreviewed. Normal,
  tampered and digest-less legacy fixtures have been inspected in the UI.
  Citation entailment and general prose fact checking remain outstanding.
- E2: the actual Chat service now migrates versioned payloads per row, retains
  rejected records, uses atomic SQLite compare-and-swap, and protects the state
  projection from context eviction. The user-facing editor selects attributed
  quotations; explicit confirmation, restart recovery and invalid-source
  rejection have been inspected. At this increment, session loading/paging and
  execution ownership remained outstanding; see the later storage increment.
  This is not automatic tool replay.
- E4: ordinary desktop builds now capture a content identity and bind their
  final output files. A build/checker result is separate from installation and
  clean-machine acceptance.

E2 service/codec/related regression evidence is in
`build/e2-research-state-20260922T014337Z-6e151c3a/` (61 passing tests). Renderer
freshness guards have a separate 10-test suite. These counts overlap earlier
related suites and are not independent scientific acceptance totals.

## Local structure-result import increment

- F2: the existing Compute surface now imports local ColabFold PDB/scores files,
  preserves residue/chain identity and raw asymmetric PAE order, displays source
  hashes and confidence, and rejects incompatible expected sequences. The current
  catalogue has 126 tools in 18 groups. This delivers result import and review;
  local input/runtime binding, prediction-job submission, an owned queue,
  cancellation/recovery and inference are still unfinished.
- The actual Compute UI imported the retained historical public 1CRN result:
  46 residues, one chain and a 46 x 46 PAE matrix. Values `PAE[0][1] = 1.33` and
  `PAE[1][0] = 1.55` remained distinct. A mismatched expected sequence was rejected
  while the prior successful run stayed visible and labelled. The saved result
  and source bytes were independently reopened and hash-checked. Browser JSON
  download is **not accepted**: neither a download event nor a resulting Downloads
  file was observed. The UI record is
  `build/structure-prediction-import-20260922/ui-acceptance.json`.
- The bounded importer retains the 384-residue limit and passed 20 focused tests
  (17 original and three TER boundary tests). TER now prevents a terminated chain
  from resuming; normal multi-chain termination remains valid. It does not
  validate TER's identifying columns or become a general PDB validator. The
  original failure reproduction and the successful importer/historical-input
  retests remain separate under `build/structure-prediction-import-20260922/`.
  See [the import contract](structure-prediction-import.md) for the exact scope.

The final check retained at
`build/research-upgrade-20260922/final-check-20260922T020536.332278Z/` reports 47/47
selected Python tests and 89/90 Node tests, with unchanged source hashes during
that run. The only Node failure was the old 17-group assertion against the actual
18-group catalogue. Its failed summary and logs remain unchanged. The assertion
was corrected to 18, and all six Compute presentation tests passed in the separate
`build/research-upgrade-20260922/compute-presentation-group-count-retest.log`.
These are overlapping software checks, not a replacement 90/90 report, a new
prediction run, scientific-accuracy validation or clean-machine delivery evidence.

## Persistent claim and source review increment

- A5: Chat now has a working **Claims & sources** inspector with exact quoted
  passages, extracted locations, partial reading ranges, support/contradiction/
  context relations, explicit review and retained version history. Source checks
  bind original and preserved file bytes as well as extraction/text artifacts.
  Observed invalidation survives byte restoration and host restart; replacing a
  source requires a new explicit citation and review. See [the contract](research-claims.md).
- All 118 research-related Node tests and TypeScript passed. The 22 claim-service
  and 13 renderer tests are included subsets, not extra independent totals. Nine
  independent DOCX/SQLite service scenarios passed separately. Actual browser
  interactions checked save/review, contradictory sources, rejected quotations,
  drafts, document edits, restart recovery and light/dark/narrow layouts.
  Reopened SQLite records and eight source artifact hashes matched.
- Evidence is indexed in `build/research-claims-20260922/increment-acceptance.json`.
  The source-changing UI case retains its original quotation and review with a
  visible Source changed state. These are synthetic software acceptance cases,
  not citation-entailment validation or empirical scientific results.
- A desktop development build and content checker passed for content ID
  `20ec7e0d8d0c3892dcf5ea1a3372a71a21ae42e5cbd2225d308e601c774801dc`.
  Native packaged execution, installation and model acceptance remain separate.

E2 pagination has a read-only implementation audit in
`build/research-claims-20260922/e2-pagination-audit.md`. Indexed session summaries,
lazy full-session loading and ownership-aware recovery were outstanding at that
audit and are implemented in the following increment. A5 completion does not
complete the other ledger items or the overall upgrade programme.

## Conversation storage and ownership increment

- E2: Chat lists indexed SQLite summaries in stable cursor pages and loads full
  sessions only on demand. Legacy indexing, payload loading and cached sessions
  have explicit bounds. Rejected records retain their original bytes; older
  writers invalidate derived indexes and continuation generations. Payload CAS
  and summary updates share one transaction.
- Active requests and generations pin their cache entries. Persistent execution
  ownership prevents an observer from canceling or rewriting another live or
  unverifiable owner's work. Explicit recovery requires a current revision and,
  for unowned legacy records, confirmation. It preserves tool output, artifacts
  and existing times, records a separate interruption note and never replays a
  tool. The reliable-effect protocol in E1 remains unfinished.
- The existing sidebar supports 30-entry pages and 200-entry windows, retains a
  selected conversation outside the visible page, and exposes the same list in a
  narrow-screen dialog. A changed generation keeps the visible list and offers
  an explicit refresh. See [storage and recovery](research-chat-storage.md).
- All 148 research-related Node tests and TypeScript passed with stable source
  hashes. A separate 15-case independent synthetic service acceptance passed.
  These counts are distinct; the focused backend and renderer suites overlap
  the 148 tests. Actual UI actions covered paging, old state, recovery, retained
  partial output, light/dark/narrow layouts and host-restart persistence.
- The desktop development bundle and content checker passed for content ID
  `5b7fd45c36c2047cace52a22f60ac4d7758998a4e6f6169eebddd7f83de7a80b`.
  Evidence is indexed in `build/research-paging-20260922/increment-acceptance.json`.
  Original failures and earlier receipts remain separate and unchanged. Native
  release, installation, model and scientific acceptance are not established.

E2 stays in progress: opening a conversation still decodes the complete transcript;
normalized message storage, transcript pagination and recovery-notice pagination
remain unfinished. Cache byte accounting estimates serialized storage rather than
actual process memory. The other programme ledger items retain their own scope.

## Persistent research-project increment

- F1/E2: Compute now has named research projects with a research question,
  revision-checked edits and persistent run associations. Reopening checks the
  actual four-file bundle against immutable association hashes, preserves saved
  method metadata and distinguishes current source freshness from artifact
  integrity. Association history survives unlinking. This adds cross-session
  reopening to the protein comparison surface and other existing Compute tools.
- F6 foundation: two saved runs can be reopened and compared by their exact JSON
  input/result fields. This is a bounded inspection view, not multi-panel figure
  composition, automated statistical comparison, unit conversion or a methods
  report. F6 remained pending at that increment; the later figure increment follows.
- Independent host acceptance passed 10 finite cases using three retained real
  CPU runs plus explicitly synthetic format/tamper variants. Browser acceptance
  exercised two new synthetic-data statistics runs, source-change reporting,
  damaged-result refusal, an actual host restart, historical provenance and the
  existing supplied-alignment protein view. These checks establish bounded local
  software behavior, not scientific validation or native installation acceptance.
- Initial failures remain in `build/research-studies-20260922/`: QA assumptions
  about JSON object prototypes, a real upstream-function metadata mismatch and
  a real editor revision acknowledgement race. The final consolidated receipt
  is `build/research-studies-20260922/increment-acceptance.json`; it binds the
  accepted source/test/build records and distinguishes earlier attempts.
- The final frozen-source run passed 92/92 related Node tests and TypeScript.
  These overlap the 12 backend and 19 frontend focused checks and must not be
  added together. The local Desktop build and content checker passed with ID
  `7cc6ffe47cf272f39e7a3bf5dd08277d1fe6e7801c3f24e6a760f9da77bd9841`.

This completes the persistent-project foundation only. E2 transcript storage and
paging, F1 native multi-protein structure validation, F6 figure/report generation
and the other open ledger requirements remain unfinished. See
[the research-project contract](research-projects.md) for persistence/read limits.

## Data-bound figure and methods increment

- F6: saved research projects now support one- or two-column figure boards with
  up to six line, scatter or bar panels selected from linked run inputs/results.
  Immutable run bindings, figure revisions, explicit rebinding, exact values and
  generated methods are retained. Original-source freshness is separate from
  saved-artifact integrity. Source changes require acknowledgment; damaged saved
  data blocks export. See [the figure contract](research-figures.md).
- Real UI actions created three panels from two retained CPU statistics runs,
  rejected mismatched X/Y lengths, retained a draft across Design/Compute,
  reopened saved state after a host restart, saved a second revision and opened
  an explicitly historical export. A documented whitespace edit to a synthetic
  original source triggered export acknowledgment while preserving all values.
  Light, dark and 920-pixel layouts were visually inspected.
- The final frozen-source check passed TypeScript and 83/83 related Node tests.
  The Python figures profile passed 22 tests with one explicit Windows symlink
  privilege skip; the existing MCP recovery suite passed 9/9 and profile-selector
  tests passed 8/8. These are separate software checks with overlapping earlier
  runs, not a combined scientific acceptance count. The optional dependency lock
  check passed; hosted CI and fresh installation were not run.
- Real Matplotlib generated SVG, PDF, CSV, data JSON and Markdown/JSON methods.
  Registered exports were independently reopened and hash-checked; PDF/SVG
  renderings were visually inspected. Browser byte validation and a visible
  verified-file link worked, but no download event or resulting Downloads file
  was observed in the in-app browser. Browser download is therefore not accepted;
  the generated local files are available directly.
- The first UI export timed out during a cold Windows stdio runtime import.
  That failed attempt and its unregistered output remain unchanged. Preparing the
  plotting runtime on the MCP reader thread resolved the reproduced import stall:
  the cold persistent request completed in 1.625 seconds without a wake-up ping;
  subsequent real UI exports completed in 2.436 and 1.358 seconds. No timeout
  increase was used to claim recovery.
- The Desktop development build and content checker passed with content ID
  `49d21e931c046db59975028bb660f6aea18083ab7f10245b87171ce675eb4edf`.
  Evidence is indexed in `build/research-figures-20260922/increment-acceptance.json`.
  Native packaged execution, installer delivery, scientific interpretation,
  browser download and the other open programme requirements remain separate.

## RNA-seq study increment

- F3: **Compute → Biological data → RNA-seq studies** now accepts source-bound
  raw count and sample CSV files. Validation-only and fitted analysis remain
  distinct. The existing local DESeq2 adapter supplies fixed condition, batch or
  paired-subject designs, explicit filtering, size factors, variance-stabilized
  PCA and the complete differential-expression table. Optional local gene sets
  reuse the existing ORA method with recorded background and selection rules.
  See [the RNA-seq contract](rnaseq-studies.md) for bounds and interpretation.
- The actual UI run analyzed the public pasilla reference: 14,599 genes and
  seven samples, retaining 8,423 modeled genes. All six differential statistics
  per retained gene, 58,961 normalized counts, seven size factors and all 500
  PCA feature identities match a separate direct-R invocation. PCA scores match
  after accounting for arbitrary axis signs. All 164 unavailable adjusted
  p-values remain null. This verifies the integration with the same DESeq2
  library; it does not independently validate its statistical model.
- Three deliberately synthetic gene sets use actual reference gene identifiers
  and conspicuous software-control provenance. Memberships and denominators
  match independent combinatorial expectations; probabilities agree within the
  predefined machine-precision tolerance. They are not biological pathways or
  independent enrichment evidence.
- Browser checks exercised validation mode, a real fit, provenance, null-value
  search, paging, invalid subject design, project association and complete saved
  results after an actual host restart. Light, dark and 920-pixel layouts were
  inspected. Source freshness and saved-artifact integrity remain separate.
- The consolidated regression passed 109 Python and 116 Node tests plus
  TypeScript. Subsequent parser-wording, preview and numeric-display changes
  passed focused 38-, 11- and 20-test checks, with TypeScript repeated for the
  formatter change. These are overlapping checks, not additive totals. A real
  display defect that rounded a small nonzero probability to zero was corrected
  without altering saved values. Earlier WSL access, stale test-count and other
  failed attempts remain preserved.
- Evidence is indexed in `build/rnaseq-studies-20260922/increment-acceptance.json`.
  Local development build identity, actual CPU execution and UI checks have
  separate receipts. Native packaged execution, clean-machine installation,
  model-driven research, general biological validity and browser file download
  are not established by this increment. Other open ledger items remain open.
