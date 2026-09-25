# ADR 0006: Managed Study plans and project objects

Date: 2026-09-24. Status: accepted for the scoped source implementation.

## Context

The next-architecture proposal makes a Study the research unit shared by Chat,
Design and Compute. Existing workflow execution, scientific methods, permissions
and saved results already have production implementations. Replacing them while
moving all historical storage would make behavior and data migration difficult
to review together.

## Decision

Use logical module boundaries within the existing application. Electron and the
loopback development host expose the same typed research commands. The renderer
holds selection and draft state only. Shared StudySpec, ResearchPlanIR and graph
contracts do not import Electron, React, SQLite or workers. The host compiler
projects the current canonical method catalog and lowers to the existing workflow
DAG. Execution continues through production policy, journal and owned workers.

Store new immutable specifications, plans, source snapshots and retained evidence
under `.proto/project.sqlite` and `.proto/objects/sha256`. Each version identifies
its attached source objects. Existing Study/workflow/run stores remain explicit
compatibility authorities. An additive legacy importer snapshots closed inputs
and reports byte parity; it does not imply old-writer cutover or semantic parity.

Inspecting a frozen plan and its historical evidence is separate from generating
a fresh execution preview. A changed live source can leave historical integrity
verified while blocking current completion and new execution. Imported capsules
remain unverified for execution and human review even after their bytes verify.

MCP presentation blocks are transport metadata. The workflow fingerprint adapter
removes only that field before validating the strict structured fingerprint;
unknown scientific fields still fail the existing contract.

## Consequences

This yields an independently testable vertical path without a second scientific
engine. Cross-store publication is additive, not a new global transaction or an
exactly-once guarantee. A failed compile/publication may retain an unexecuted
workflow; the host never labels that as a completed plan.

Physical package extraction, full storage cutover, durable job scheduling,
large-array layouts, complete Quantity output semantics and managed prediction
remain separate implementation work. See the
[capability ledger](../NEXT_ARCHITECTURE_CAPABILITIES.md) and
[dated implementation report](../NEXT_ARCHITECTURE_IMPLEMENTATION_2026-09-24.md).
