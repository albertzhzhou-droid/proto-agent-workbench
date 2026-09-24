# Proto Workbench documentation

**Explore a question. Inspect the calculation. Keep the evidence.**

[Project overview](../README.md) · [Current source showcase](source-showcase-2026-09.md) · [Screenshot gallery](assets/workbench-2026-09/README.md) · [Historical Windows preview](https://github.com/albertzhzhou-droid/proto-agent-workbench/releases/tag/v0.2.0-rc.1)

The current source includes shared Chat / Design / Compute workspaces, Chem,
saved research studies and Harness Slice B. The downloadable `0.2.0-rc.1`
preview is older. Source validation and historical package acceptance have
separate evidence records.

## Choose your starting point

| Goal | Guide |
|---|---|
| Tour the latest capabilities and their evidence | [September source showcase](source-showcase-2026-09.md) |
| Open the desktop, try the CLI, or build from source | [Getting started](getting-started.md) |
| Connect an MCP-compatible host | [MCP configuration and tools](mcp_usage.md) |
| Understand the complete command loop | [CLI and workflow guide](cli-guide.md) |
| Use source-backed biological records | [Materials library](materials_library.md) · [Public bundles](../materials/bundles/README.md) |

## Explore the workbench

- [Scientific Chat](chat-unified-workflow.md): local-model conversations, shared research tools, document context and persistent work.
- [Chemistry workspaces](chem-workbench-upgrade.md): shared navigation, molecular views, chemical analysis and recorded computation.
- [Reaction studies](chem-reaction-studies.md): supplied kinetic models, sensitivity and uncertainty, with explicit assumptions.
- [Reusable research workflows](research-workflows.md): artifact-bound steps, reuse and recorded execution.
- [Reliable Harness](reliable-harness.md): mission scope, deadlines, context budgets, complete results and recovery.
- [Harness iteration implementation](HARNESS_ITERATION_IMPLEMENTATION_2026-09-23.md): typed verification, persisted repairs, tool contracts, conflict handling and acceptance evidence.
- [Frozen Harness software evaluation](harness_iteration_evaluation.md): paired direct/Harness fixture campaigns, immutable attempts and separate outcome metrics.
- [Tool execution journal](../apps/proto-workbench/docs/tool-execution-journal.md): shared Chat, Harness, Compute and workflow effect receipts with unknown-write recovery boundaries.
- [DNA source editing](dna-source-editing.md): occurrences, orientation, annotations, validation and history.
- [Protein structures](protein-structures.md): official and local coordinates, explicit mappings, selection and export.
- [Protein comparative study](protein-comparative-study.md): named alignments, conservation, trees and exact source-coordinate linkage.
- [Saved research projects](research-projects.md): named studies, cross-session result reopening, fixed artifact bindings and recorded-run comparison.
- [Research figures and methods](research-figures.md): saved-data panel composition, vector exports, retained source bindings and method records.
- [RNA-seq studies](rnaseq-studies.md): raw-count/sample QC, fixed study designs, local DESeq2, PCA, complete gene tables and source-bound reopening.
- [Local structure prediction result import](structure-prediction-import.md): existing ColabFold PDB/scores, source hashes, pLDDT and PAE; no prediction job is launched.
- [Research state](research-session-state.md): user-confirmed source quotations, versioned sessions, conflict handling and context retention.
- [Conversation storage and recovery](research-chat-storage.md): paged summaries, lazy session loading, retained migration failures and execution ownership.
- [Receipt-bound research evidence](research-evidence.md): supported scientific fields, exact saved receipts and unverified interpretations.
- [Claim and source review](research-claims.md): exact quotations, source freshness, explicit review decisions and retained claim history.
- [Statistical inference](statistical-inference.md): supported intervals, signed effects, assumptions and unsupported cases.
- [Computation maturity](computation-maturity.md): scientific scope and evidence inventory, separate from dependency availability.
- [Scientific data contracts](scientific-data-contracts.md): dataset/reference hashes, entity identities, units, missing-value semantics, and explicit coordinate frames.
- [Model capability and evaluation evidence](model-capability-and-evaluation.md): exact-instance tool-call probes, immutable attempt records, and separate evaluation denominators.
- [Isolated desktop sessions](isolated-desktop-sessions.md): separate workspace and profile for owned testing.
- [Scientific workflow patterns](claude_science_patterns.md): connectors, source evidence and review packets.
- [Biomni scientific computing](biomni-compute.md): offline statistics, biological data calculations, and source-bound results.
- [Design and Compute workbench](workbench-paper-redesign.md): neutral visual design, public references, workspace navigation, and UI verification.
- [Typography profiles](typography.md): local Anthropic faces, bundled public serif/sans/mono alternatives and explicit distribution selection.
- [Chem CLI integration](chem-workbench-port.md): switch applications from the far-left selector, use the preserved chemistry workspaces, and inspect migration and execution evidence.
- [Repository Skills](academicforge_skill_adaptation.md): declared, auditable capability resolution.

## Verify and maintain

| Topic | Reference |
|---|---|
| Current source tests, publication checks and paired model campaign | [Source evidence](source-showcase-2026-09.md) · [Source manifest](release-evidence/source-2026-09-23.json) |
| Historical native preview demos and package tests | [0.2.0-rc.1 verification](upgrade-verification.md) · [Release manifest](release-evidence/0.2.0-rc.1.json) |
| Acceptance tasks and evidence criteria | [Harness acceptance protocol](harness-acceptance-protocol.md) |
| Durable Harness regression coverage | [Test migration](harness-test-migration.md) |
| Locked, immutable Windows builds | [Build transactions](build-transactions.md) |
| Development source and artifact identity | [Build content identity](build-content-identity.md) |
| Clean-environment dependency and test profiles | [CI validation](ci-validation.md) |
| Host and execution boundaries | [Security architecture](security_architecture.md) · [Bounded stress model](security_stress.md) |
| Public versus machine-local content | [Publication boundaries](repository-publication.md) |
| Propose changes or report a vulnerability | [Contributing](../CONTRIBUTING.md) · [Security reporting](../SECURITY.md) |

## History and next steps

[Changelog](../CHANGELOG.md) · [Architecture implementation](ARCHITECTURE_UPGRADE_2026-09-23.md) · [Visualization roadmap](visualization-product-roadmap.md) · [Current source evidence](source-showcase-2026-09.md)

The [research upgrade programme](research-upgrade-plan.md) tracks academic,
engineering and new-feature acceptance separately, including work still pending.

Historical roadmap proposals are distinct from delivered capabilities. Use the
versioned verification record for what was actually exercised.

## Chat and local bioinformatics

- [Unified Chat workflow](chat-unified-workflow.md): OpenScience, Biomni and DeepSeek Harness adaptations, canonical tools, and local acceptance evidence.
- [Chat execution deployment](chat-execution-deployment.md): isolated Python/R/Jupyter runtime, typed WSL tools, configuration and reproducible acceptance.
- [Chat document parsing](chat-document-parsing.md): PDF/DOCX/XLSX attachments, source-bound extractions and paginated reading.
- [Bioinformatics environments](bioinformatics-environment.md): installed WSL engines, exact package locks, smoke checks, and runtime boundaries.
