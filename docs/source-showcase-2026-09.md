# September 2026 source showcase

The September 23 source update brings research projects, saved computations,
reusable workflows, evidence-linked figures and bounded Harness recovery into
the existing Chat, Design and Compute workspaces. This walkthrough describes
source revision [`a3ff460`](https://github.com/albertzhzhou-droid/proto-agent-workbench/commit/a3ff460f6819626f346d61a6cfa12ccf2295d6fd)
and the separately scoped local checks below.

The downloadable **`0.2.0-rc.1` preview is an earlier binary release**. These
source additions have not been distributed as a new installer. Its historical
[native screenshots and package evidence](upgrade-verification.md) remain a
separate record.

[Current source gallery](assets/workbench-2026-09/README.md) ·
[Machine-readable source evidence](release-evidence/source-2026-09-23.json) ·
[Development setup](getting-started.md#development) ·
[Hosted CI](https://github.com/albertzhzhou-droid/proto-agent-workbench/actions/workflows/ci.yml)

## Explore the workspaces

| Start with | What the current source provides | Read more |
| --- | --- | --- |
| A research question | Named projects retain linked runs, original inputs, method metadata and revision history. Reopening distinguishes saved-file integrity from changes to the original sources. | [Research projects](research-projects.md) |
| An analysis | Compute exposes local methods and saved results. Protein studies inspect supplied alignments, conservation and identity-distance trees; RNA-seq studies use fixed designs and the existing local DESeq2 adapter. | [Protein studies](protein-comparative-study.md) · [RNA-seq studies](rnaseq-studies.md) |
| A repeatable sequence of analyses | Editable workflow graphs bind typed outputs to later inputs. Selective reuse checks inputs, runtime identity and saved results; failed and cancelled attempts remain in history. | [Research workflows](research-workflows.md) |
| A result to communicate | Figure boards bind panels to saved values and retain immutable revisions. The local renderer writes SVG, PDF, plotted data and methods records. Claims retain source locations and human review. | [Research figures](research-figures.md) · [Claim review](research-claims.md) |
| A chemistry task | The shared Chemistry catalog contains 56 fixed operators, including 35 Reaction Sim methods. Source, assumptions, input/result hashes and runtime requirements travel with the work. | [Chemistry integration](chem-workbench-port.md) · [Reaction methods](chem-network-reactors.md) |
| A longer model mission | Harness persists tool usage and repair allowances, classifies verification diagnostics, preserves negative results and supports explicit abstention or human review. Chat and Harness share canonical tool contracts and execution-journal checks. | [Harness iteration](HARNESS_ITERATION_IMPLEMENTATION_2026-09-23.md) · [Architecture upgrade](ARCHITECTURE_UPGRADE_2026-09-23.md) |

The [gallery](assets/workbench-2026-09/README.md) identifies each capture's
date, fixture and execution surface. Source-browser captures illustrate the
working interface; they do not establish installed Electron acceptance.

## Recorded software checks

These are retained local results with different source scopes. Counts are not
added together, and a passing local run does not establish hosted CI success.
The [evidence summary](release-evidence/source-2026-09-23.json) binds each retained
report by SHA-256 without publishing machine state, conversations or databases.

| Check | Recorded result | Scope |
| --- | --- | --- |
| Complete Workbench offline verifier | **1,405 passed, 1 skipped, 0 failed**; TypeScript passed | Final Slice B application implementation, including the terminal-notification fix; 200 test files. Recorded before publication normalization and local-asset exclusions. The owned-process containment skip does not prove whole-tree termination. |
| Python base profile | **355 passed, 4 skipped, 0 failed** | Earlier September 23 architecture snapshot, before the final Slice B increment. Skips require unavailable Windows symlink privileges. This is not a rerun of the complete Python profile at the published revision. |
| Publication source projection | **11 passed, 0 skipped, 0 failed** | Focused Chemistry bridge and frozen Harness evaluation checks on the exported publication files. This is a separate focused check, not another full-suite run. |
| Publication desktop source build | **Passed** | Built the publication source projection without excluded local font binaries. System fallback fonts apply; missing optional font URLs produced build warnings. This is not a clean-machine dependency installation or packaged runtime test. |
| Harness component acceptance | **Four synthetic states checked** | Production component inspected at desktop and 390 × 844 widths; both diagnostic JSON downloads reopened. This does not execute a real mission or certify native desktop delivery. |

The original logs remain local. Their hashes identify retained bytes; this public
summary alone cannot replay the checks, authenticate authorship or establish
scientific validity. Earlier failed attempts retain their original status.

## Hosted CI snapshot

[CI run 35948122466](https://github.com/albertzhzhou-droid/proto-agent-workbench/actions/runs/35948122466)
for source `a3ff460` concluded **failure**. The Linux worker, heavy Python and
both figure lanes passed. Workbench, both Windows base lanes and the compute
lane failed. Inspected failures include Windows temporary-path canonicalization,
link/provenance checks, a security-corpus checksum mismatch and missing
`libsbml` / `jsonschema` in the compute profile. Workbench typechecking and
canonical Python contract parity passed before its mandatory regression step
failed; its later offline and desktop build steps were skipped.

This is an exact-commit hosted result, separate from the local gates above and
from the later showcase/typography changes. See the workflow for newer runs.

## Observed local-model comparison

A frozen pack contains **30 software fixture tasks: 24 possible and 6 deliberately
impossible**. A direct tool loop and production Harness each attempted the same
pack, retaining all **60 planned attempts**. The model was
`unsloth/qwen3.8-27b`, Q4_K_M, with an actual 32,768-token context. Each attempt had
60 seconds, six rounds and an 8,192 generated-token budget.

| Dimension | Direct tool loop | Harness |
| --- | ---: | ---: |
| Completed and independently validated, all planned tasks | 24/30 | 23/30 |
| Completed among possible tasks | 24/24 | 23/24 |
| Correct abstention, impossible tasks | 5/6 | 6/6 |
| False abstention, possible tasks | 0/24 | 0/24 |
| Error / timeout | 1 / 0 | 0 / 1 |
| Requested tool calls / external host invocations | 109 / 80 | 95 / 63 |
| Observed total tokens | 146,964 across 30 attempts | 159,596 across 29 attempts; 1 unknown |
| Aggregate attempt wall time | 374,741 ms | 424,164 ms |

Harness made one more correct abstention and completed one fewer possible task.
This run **does not establish a completion or token-cost improvement**. The
timeout and error remain in the denominator; missing usage remains unknown.
Scientific-answer scoring was not run. No case exercised a host verification
diagnostic, so deterministic fault tests provide the evidence for those branches.

The measured controller snapshot predates the final terminal-notification fix.
That fix has separate deterministic test evidence; the campaign was not rewritten
or repeated to claim coverage of it. This is a small direct-versus-Harness
comparison, not an isolated historical Slice A/Slice B experiment or general
model reliability benchmark. See the [protocol](harness_iteration_evaluation.md)
and [complete interpretation](HARNESS_ITERATION_IMPLEMENTATION_2026-09-23.md#observed-live-campaign).

## Typography and presentation follow-up

The follow-up based on merged main `df376cd` adds independent local and public
font profiles. Both desktop source builds passed, with actual output font hashes
checked. The local build retains all 46 original Anthropic files; the public
build contains five original OFL WOFF2 assets and the three upstream licenses.
Concurrent source previews keep separate Chem UI resources.

The focused typography, Chemistry-boundary and packaging checks passed **14/14**,
and TypeScript passed separately. The full offline run recorded **1,413 passed,
1 failed and 1 skipped**. Its scientific-artifact directory-budget test reached
the scan time limit before the expected directory-count rejection while desktop
builds were also running. A subsequent isolated scan-suite check passed **6/6**;
it does not replace the failed full-suite result. Both logs are retained and
hash-bound in the [evidence summary](release-evidence/source-2026-09-23.json).

The [gallery](assets/workbench-2026-09/README.md) now includes public-font Chat,
Compute and Chemistry captures. The two retained research-study images keep
their original September 22 local-profile scope. The reversible Chemistry
example completed locally; its 3D view is an illustrative population schematic.

To create an offline presentation containing reviewed documentation, screenshots
and licensed public fonts, run `python scripts/build-showcase.py` from the source
checkout. It writes `build/showcase-2026-09.zip` and a SHA-256 receipt, reopens the
archive and verifies every member. Existing output is preserved, so use a fresh
checkout for a new bundle. This presentation contains no application runtime or
installer. Its bundled Markdown remains source text; repository reference links
outside the explicit presentation allowlist require the full checkout.

## Runtime and acceptance boundaries

Source inclusion does not install an execution environment. Local inference
requires LM Studio and an explicitly selected model. Compute and figure rendering
need their optional Python dependencies; Chemistry uses separately configured
Python and, for relevant features, external Psi4 or XDL installations. RNA-seq
fit mode and other bioinformatics tools require their configured local engines,
including the separately provisioned WSL environment. Large reference databases
and model weights are not included.

The source distribution excludes locally supplied fonts without redistribution
permission, generated runtime UI copies, private run databases, raw model output
and packaging artifacts. The subsequent [typography update](typography.md) bundles
Newsreader, Hanken Grotesk and Commit Mono for public builds while retaining
Anthropic faces for local self-use. The earlier fontless publication build in the
evidence table keeps its original scope. See [publication boundaries](repository-publication.md).

Research-figure vector files were independently reopened, while the recorded
browser download remains unaccepted. Structure-prediction result import does not
run prediction. Public scientific benchmarks, broader model acceptance and
disposable-Windows installation, upgrade and uninstallation remain separate
work. No new binary release, GPU acceptance or scientific validation is claimed
by this showcase.
