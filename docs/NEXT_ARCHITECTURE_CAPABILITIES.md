# Next architecture capability and evidence ledger

Reviewed source inventory: 2026-09-24.

Next-architecture implementation inventory; source/test references are not execution evidence. No phase is declared complete by this ledger.

Generated from [next-architecture-capabilities.json](next-architecture-capabilities.json). Run `node scripts/generate-architecture-capabilities.mjs --check` at the repository root to verify source references and document parity.

`scoped-implementation` means the described code exists. `partial` and `not-implemented` retain the listed gaps. `test-handles-only` points to checks that can be run; it does not assert their outcomes. Current test counts and environment-specific outcomes belong in the dated validation report.

The supplied plan reported CI run 35951587318 against bacc19c6917d3a7dfdae2dcbec65bfee01226c6f: Failure reported in the supplied plan; hosted status not refreshed by this ledger.

| Work item | Implementation | Software evidence | Science evidence | Model evidence | Delivery evidence |
|---|---|---|---|---|---|
| P01 CI baseline and path failures | partial | test-handles-only | not-applicable | not-applicable | not-run |
| P02 Capability and evidence ledger | scoped-implementation | test-handles-only | not-applicable | not-applicable | not-applicable |
| P03 Canonical contracts and version boundaries | partial | test-handles-only | not-assessed | not-run | not-run |
| P04 Production execution context | scoped-implementation | test-handles-only | not-applicable | not-applicable | not-run |
| P05 Project object store and legacy import | partial | test-handles-only | not-assessed | not-run | not-run |
| P06 Durable jobs and resource ownership | not-implemented | test-handles-only | not-assessed | not-run | not-run |
| P07 Bounded array and table artifacts | partial | test-handles-only | not-assessed | not-run | not-run |
| P08 Method semantics and Quantity outputs | partial | test-handles-only | unsupported | not-run | not-run |
| P09 StudySpec and ResearchPlanIR compilation | partial | test-handles-only | not-assessed | not-run | not-run |
| P10 Evidence graph and scientific diff | partial | test-handles-only | not-assessed | not-run | not-run |
| P11 Proof-obligation completion | partial | test-handles-only | not-assessed | not-run | not-run |
| P12 Protein Studio and managed prediction | not-implemented | test-handles-only | not-assessed | not-run | not-run |
| P13 Capsule, independent benchmark and release | partial | test-handles-only | not-assessed | not-run | not-run |
| P14 Chem inference and RNA robustness | not-implemented | test-handles-only | not-assessed | not-run | not-run |

## P01: CI baseline and path failures

Local focused regressions did not reproduce the planning document's reported hosted failures. CI now retains raw TAP and environment evidence even after failure.

Source: [.github/workflows/ci.yml](../.github/workflows/ci.yml), [apps/proto-workbench/src/main/services/workspace-execution-journal.ts](../apps/proto-workbench/src/main/services/workspace-execution-journal.ts).

Check definitions: [apps/proto-workbench/tests/architecture-followup.test.mjs](../apps/proto-workbench/tests/architecture-followup.test.mjs), [apps/proto-workbench/tests/architecture-storage.test.mjs](../apps/proto-workbench/tests/architecture-storage.test.mjs).

- software: **test-handles-only**. Listed test sources define checks; current run outcomes belong in the dated validation report.
- science: **not-applicable**. No new independent scientific task acceptance is claimed by this implementation ledger.
- model: **not-applicable**. No new local-model or paired model evaluation was run for this increment.
- delivery: **not-run**. No new installer, clean-machine, GPU or hosted-CI acceptance is claimed.

Remaining scope:

- Reproduce the reported clean-runner failure and obtain current required hosted checks.
- Keep path/junction guards and original failed evidence; this change does not establish that the hosted failure is fixed.

## P02: Capability and evidence ledger

Explicit P01-P14 implementation scope and separate evidence dimensions generate a deterministic document. The generator rejects missing, linked or external source/test references.

Source: [docs/next-architecture-capabilities.json](../docs/next-architecture-capabilities.json), [scripts/generate-architecture-capabilities.mjs](../scripts/generate-architecture-capabilities.mjs).

Check: generator reference validation and `--check` parity.

- software: **test-handles-only**. Listed test sources define checks; current run outcomes belong in the dated validation report.
- science: **not-applicable**. No new independent scientific task acceptance is claimed by this implementation ledger.
- model: **not-applicable**. No new local-model or paired model evaluation was run for this increment.
- delivery: **not-applicable**. No new installer, clean-machine, GPU or hosted-CI acceptance is claimed.

Remaining scope:

- Update this ledger with future increments; a generated document is not runtime or scientific acceptance.

## P03: Canonical contracts and version boundaries

Existing canonical registry and generated Python view remain authoritative. Study method contracts project the live Compute catalog and explicitly preserve unavailable output schema and scientific-validation gaps.

Source: [apps/proto-workbench/src/shared/tool-contracts.ts](../apps/proto-workbench/src/shared/tool-contracts.ts), [src/proto_agent/data/tool-contracts.json](../src/proto_agent/data/tool-contracts.json), [apps/proto-workbench/src/main/services/artifact-reader-registry.ts](../apps/proto-workbench/src/main/services/artifact-reader-registry.ts), [apps/proto-workbench/src/main/services/research-plan-compiler.ts](../apps/proto-workbench/src/main/services/research-plan-compiler.ts).

Check definitions: [apps/proto-workbench/tests/tool-contracts.test.mjs](../apps/proto-workbench/tests/tool-contracts.test.mjs), [apps/proto-workbench/tests/research-plan.test.mjs](../apps/proto-workbench/tests/research-plan.test.mjs).

- software: **test-handles-only**. Listed test sources define checks; current run outcomes belong in the dated validation report.
- science: **not-assessed**. No new independent scientific task acceptance is claimed by this implementation ledger.
- model: **not-run**. No new local-model or paired model evaluation was run for this increment.
- delivery: **not-run**. No new installer, clean-machine, GPU or hosted-CI acceptance is claimed.

Remaining scope:

- Physical contracts-package extraction is not performed.
- Typed output schemas and complete TS/Python/IPC scientific semantic parity remain incomplete.

## P04: Production execution context

MCP and Chem execution require opaque host-issued contexts with workspace identity, operation/scope binding, immutable invocation inputs, canonical method, policy and budget. Plain serialized grants/decisions cannot confer execution authority. Explicit ephemeral transport fixtures remain test-only.

Source: [apps/proto-workbench/src/main/services/execution-kernel.ts](../apps/proto-workbench/src/main/services/execution-kernel.ts), [apps/proto-workbench/src/main/services/permissions.ts](../apps/proto-workbench/src/main/services/permissions.ts), [apps/proto-workbench/src/main/services/mcp-client.ts](../apps/proto-workbench/src/main/services/mcp-client.ts), [apps/proto-workbench/src/main/services/chem-science.ts](../apps/proto-workbench/src/main/services/chem-science.ts).

Check definitions: [apps/proto-workbench/tests/production-kernel-context.test.mjs](../apps/proto-workbench/tests/production-kernel-context.test.mjs), [apps/proto-workbench/tests/execution-kernel.test.mjs](../apps/proto-workbench/tests/execution-kernel.test.mjs), [apps/proto-workbench/tests/harness-journal-authority.test.mjs](../apps/proto-workbench/tests/harness-journal-authority.test.mjs).

- software: **test-handles-only**. Listed test sources define checks; current run outcomes belong in the dated validation report.
- science: **not-applicable**. No new independent scientific task acceptance is claimed by this implementation ledger.
- model: **not-applicable**. No new local-model or paired model evaluation was run for this increment.
- delivery: **not-run**. No new installer, clean-machine, GPU or hosted-CI acceptance is claimed.

Remaining scope:

- The input snapshot binds invocation JSON; it does not assert complete source-file or scientific schema validation.
- This does not implement the later durable job scheduler or migrate independent Python CLI results into managed execution authority.

## P05: Project object store and legacy import

A managed project SQLite store and content-addressed objects support immutable versions, checked reopening, bounded legacy import and capsule storage.

Source: [apps/proto-workbench/src/main/services/research-project-store.ts](../apps/proto-workbench/src/main/services/research-project-store.ts), [apps/proto-workbench/src/shared/research-project.ts](../apps/proto-workbench/src/shared/research-project.ts).

Check definitions: [apps/proto-workbench/tests/research-project-store.test.mjs](../apps/proto-workbench/tests/research-project-store.test.mjs).

- software: **test-handles-only**. Listed test sources define checks; current run outcomes belong in the dated validation report.
- science: **not-assessed**. No new independent scientific task acceptance is claimed by this implementation ledger.
- model: **not-run**. No new local-model or paired model evaluation was run for this increment.
- delivery: **not-run**. No new installer, clean-machine, GPU or hosted-CI acceptance is claimed.

Remaining scope:

- Existing Compute, Chat and execution-journal stores remain; there is no complete old-writer cutover.
- Full legacy inventory/parity and supported-entrypoint migration are not established.

## P06: Durable jobs and resource ownership

Existing per-operation journal, owned-process cleanup and workspace queues are retained as prerequisites.

Source: [apps/proto-workbench/src/main/services/tool-execution-journal.ts](../apps/proto-workbench/src/main/services/tool-execution-journal.ts), [apps/proto-workbench/src/main/services/workspace-execution-queue.ts](../apps/proto-workbench/src/main/services/workspace-execution-queue.ts), [apps/proto-workbench/src/main/services/process-security.ts](../apps/proto-workbench/src/main/services/process-security.ts).

Check definitions: [apps/proto-workbench/tests/owned-process.test.mjs](../apps/proto-workbench/tests/owned-process.test.mjs), [apps/proto-workbench/tests/tool-execution-journal.test.mjs](../apps/proto-workbench/tests/tool-execution-journal.test.mjs).

- software: **test-handles-only**. Listed test sources define checks; current run outcomes belong in the dated validation report.
- science: **not-assessed**. No new independent scientific task acceptance is claimed by this implementation ledger.
- model: **not-run**. No new local-model or paired model evaluation was run for this increment.
- delivery: **not-run**. No new installer, clean-machine, GPU or hosted-CI acceptance is claimed.

Remaining scope:

- New outbox, resource scheduling, staging publication, fencing tokens and old-owner fault matrix are not implemented.
- Existing process cancellation is not evidence of managed external/GPU job recovery.

## P07: Bounded array and table artifacts

Existing data-access paging is retained, with bounded managed object reads added by the project store.

Source: [src/proto_agent/data_access.py](../src/proto_agent/data_access.py), [apps/proto-workbench/src/main/services/research-project-store.ts](../apps/proto-workbench/src/main/services/research-project-store.ts), [docs/adr/0002-bounded-research-data-access.md](../docs/adr/0002-bounded-research-data-access.md).

Check definitions: [apps/proto-workbench/tests/research-project-store.test.mjs](../apps/proto-workbench/tests/research-project-store.test.mjs).

- software: **test-handles-only**. Listed test sources define checks; current run outcomes belong in the dated validation report.
- science: **not-assessed**. No new independent scientific task acceptance is claimed by this implementation ledger.
- model: **not-run**. No new local-model or paired model evaluation was run for this increment.
- delivery: **not-run**. No new installer, clean-machine, GPU or hosted-CI acceptance is claimed.

Remaining scope:

- No new chunked table/array backend or large-study performance acceptance is established.
- Whole-object identity checks do not independently establish matrix axes or scientific coordinate identity.

## P08: Method semantics and Quantity outputs

Method projections expose input schemas, assumptions, runtime fingerprints and explicit semantic gaps. Generated unit metadata reuses the Python source; existing reviewed quantity adapters remain bounded.

Source: [apps/proto-workbench/src/main/services/research-plan-compiler.ts](../apps/proto-workbench/src/main/services/research-plan-compiler.ts), [apps/proto-workbench/src/shared/scientific-units.generated.json](../apps/proto-workbench/src/shared/scientific-units.generated.json), [src/proto_agent/compute_quantities.py](../src/proto_agent/compute_quantities.py), [docs/scientific-data-contracts.md](../docs/scientific-data-contracts.md).

Check definitions: [apps/proto-workbench/tests/research-plan.test.mjs](../apps/proto-workbench/tests/research-plan.test.mjs).

- software: **test-handles-only**. Listed test sources define checks; current run outcomes belong in the dated validation report.
- science: **unsupported**. No new independent scientific task acceptance is claimed by this implementation ledger.
- model: **not-run**. No new local-model or paired model evaluation was run for this increment.
- delivery: **not-run**. No new installer, clean-machine, GPU or hosted-CI acceptance is claimed.

Remaining scope:

- Generic output quantity-to-artifact bindings are unsupported; requested quantity proof obligations must remain unsatisfied.
- No new independent numerical reference coverage or complete method-family output coverage is claimed.

## P09: StudySpec and ResearchPlanIR compilation

Bounded Study specifications freeze data and method identities and compile into the existing Workflow DAG through host commands.

Source: [apps/proto-workbench/src/shared/research-plan.ts](../apps/proto-workbench/src/shared/research-plan.ts), [apps/proto-workbench/src/main/services/research-plan-compiler.ts](../apps/proto-workbench/src/main/services/research-plan-compiler.ts), [apps/proto-workbench/src/main/services/research-study-commands.ts](../apps/proto-workbench/src/main/services/research-study-commands.ts), [apps/proto-workbench/src/main/services/managed-research-runtime.ts](../apps/proto-workbench/src/main/services/managed-research-runtime.ts).

Check definitions: [apps/proto-workbench/tests/research-plan.test.mjs](../apps/proto-workbench/tests/research-plan.test.mjs).

- software: **test-handles-only**. Listed test sources define checks; current run outcomes belong in the dated validation report.
- science: **not-assessed**. No new independent scientific task acceptance is claimed by this implementation ledger.
- model: **not-run**. No new local-model or paired model evaluation was run for this increment.
- delivery: **not-run**. No new installer, clean-machine, GPU or hosted-CI acceptance is claimed.

Remaining scope:

- The compiler does not infer missing units, reference versions or runtime availability.
- Only the exposed fixed Compute catalog is supported; cross-domain plans and managed job scheduling are not complete.

## P10: Evidence graph and scientific diff

Typed evidence graph validation separates freshness from historical integrity and reports downstream invalidation; scientific diff describes changes without causal attribution.

Source: [apps/proto-workbench/src/shared/research-evidence-graph.ts](../apps/proto-workbench/src/shared/research-evidence-graph.ts), [apps/proto-workbench/src/main/services/research-study-commands.ts](../apps/proto-workbench/src/main/services/research-study-commands.ts).

Check definitions: [apps/proto-workbench/tests/research-plan.test.mjs](../apps/proto-workbench/tests/research-plan.test.mjs).

- software: **test-handles-only**. Listed test sources define checks; current run outcomes belong in the dated validation report.
- science: **not-assessed**. No new independent scientific task acceptance is claimed by this implementation ledger.
- model: **not-run**. No new local-model or paired model evaluation was run for this increment.
- delivery: **not-run**. No new installer, clean-machine, GPU or hosted-CI acceptance is claimed.

Remaining scope:

- Full automatic source-calculation-quantity-figure-claim linkage is incomplete.
- Declared graph nodes are not independently authenticated scientific facts; host verification is still required.

## P11: Proof-obligation completion

Deterministic research completion distinguishes required and optional steps, preserves failures and blocks any unknown effect. Managed commands project retained runtime evidence into the gate.

Source: [apps/proto-workbench/src/shared/research-evidence-graph.ts](../apps/proto-workbench/src/shared/research-evidence-graph.ts), [apps/proto-workbench/src/main/services/research-study-commands.ts](../apps/proto-workbench/src/main/services/research-study-commands.ts), [apps/proto-workbench/src/main/services/turn-engine.ts](../apps/proto-workbench/src/main/services/turn-engine.ts).

Check definitions: [apps/proto-workbench/tests/research-plan.test.mjs](../apps/proto-workbench/tests/research-plan.test.mjs), [apps/proto-workbench/tests/harness-journal-authority.test.mjs](../apps/proto-workbench/tests/harness-journal-authority.test.mjs).

- software: **test-handles-only**. Listed test sources define checks; current run outcomes belong in the dated validation report.
- science: **not-assessed**. No new independent scientific task acceptance is claimed by this implementation ledger.
- model: **not-run**. No new local-model or paired model evaluation was run for this increment.
- delivery: **not-run**. No new installer, clean-machine, GPU or hosted-CI acceptance is claimed.

Remaining scope:

- Chat and Harness orchestration are not fully replaced by one research scheduler.
- Quantity-bound obligations and unsupported evidence cannot be marked satisfied.

## P12: Protein Studio and managed prediction

Existing protein comparison and bounded structure-prediction import remain available as prerequisites. The new generic Study surface is not a complete Protein Studio.

Source: [src/proto_agent/compute_protein_study.py](../src/proto_agent/compute_protein_study.py), [src/proto_agent/compute_structure_prediction.py](../src/proto_agent/compute_structure_prediction.py), [docs/structure-prediction-import.md](../docs/structure-prediction-import.md).

Check definitions: [apps/proto-workbench/tests/structure-prediction.test.mjs](../apps/proto-workbench/tests/structure-prediction.test.mjs).

- software: **test-handles-only**. Listed test sources define checks; current run outcomes belong in the dated validation report.
- science: **not-assessed**. No new independent scientific task acceptance is claimed by this implementation ledger.
- model: **not-run**. No new local-model or paired model evaluation was run for this increment.
- delivery: **not-run**. No new installer, clean-machine, GPU or hosted-CI acceptance is claimed.

Remaining scope:

- No new local prediction worker, MSA egress agreement, GPU profile or full residue-linked study UI is delivered.
- Imported ColabFold results remain imports; no new local inference or functional validation is claimed.

## P13: Capsule, independent benchmark and release

The project store provides bounded manifest-only and embedded-object capsule import/export with identity verification.

Source: [apps/proto-workbench/src/main/services/research-project-store.ts](../apps/proto-workbench/src/main/services/research-project-store.ts), [apps/proto-workbench/src/shared/research-project.ts](../apps/proto-workbench/src/shared/research-project.ts), [docs/HARNESS_ITERATION_IMPLEMENTATION_2026-09-23.md](../docs/HARNESS_ITERATION_IMPLEMENTATION_2026-09-23.md).

Check definitions: [apps/proto-workbench/tests/research-project-store.test.mjs](../apps/proto-workbench/tests/research-project-store.test.mjs).

- software: **test-handles-only**. Listed test sources define checks; current run outcomes belong in the dated validation report.
- science: **not-assessed**. No new independent scientific task acceptance is claimed by this implementation ledger.
- model: **not-run**. No new local-model or paired model evaluation was run for this increment.
- delivery: **not-run**. No new installer, clean-machine, GPU or hosted-CI acceptance is claimed.

Remaining scope:

- Full Workflow Run RO-Crate interoperability, independent scientific benchmarks and native release acceptance are not complete.
- Reopening retained objects is distinct from recomputation; dependencies and numerical tolerances are not supplied by a capsule hash.

## P14: Chem inference and RNA robustness

Existing forward/sensitivity Chem methods and RNA-seq analyses are preserved. They are not relabeled as new inverse inference or robust study-design capabilities.

Source: [src/proto_agent/compute_rnaseq.py](../src/proto_agent/compute_rnaseq.py), [docs/chem-reaction-studies.md](../docs/chem-reaction-studies.md).

Check definitions: [apps/proto-workbench/tests/rnaseq-study.test.mjs](../apps/proto-workbench/tests/rnaseq-study.test.mjs).

- software: **test-handles-only**. Listed test sources define checks; current run outcomes belong in the dated validation report.
- science: **not-assessed**. No new independent scientific task acceptance is claimed by this implementation ledger.
- model: **not-run**. No new local-model or paired model evaluation was run for this increment.
- delivery: **not-run**. No new installer, clean-machine, GPU or hosted-CI acceptance is claimed.

Remaining scope:

- Joint calibration/posterior inference, identifiability and competing-model evaluation are not newly implemented.
- Paired/batch/covariate design extensions and robustness comparison need separate independently validated work.
