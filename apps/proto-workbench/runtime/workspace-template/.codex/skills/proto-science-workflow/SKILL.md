---
name: proto-science-workflow
description: Run source-grounded, software-only Proto workflows for governed biological materials, DNA or protein visualization, literature evidence, and LM Studio-backed analysis. Use when auditing or materializing Proto resources, inspecting or processing sequence artifacts, or preparing workflow and review evidence; do not use for wet-lab execution instructions or readiness claims.
---

# Proto Science Workflow

Keep scientific claims, software validation, and human decisions visibly separate. Read [acceptance.md](references/acceptance.md) before changing model-provider, materials-eligibility, sequence-visualization, or review behavior.

## Route the work

1. Read `connectors/proto_workbench.json` and report unavailable or conditional connectors instead of inventing substitutes.
2. For inference, use the configured LM Studio provider at `http://127.0.0.1:1234`. Prove model discovery with the native model endpoint and prove generation with a real bounded response; a weight scan, process check, or health response is not generation evidence.
3. For DNA parts, search governed materials, materialize an eligible snapshot, and then search the materialized parts. Never invent part identifiers.
4. For proteins, use `materials materialize-proteins`, then `protein validate` and `protein compile`. Do not coerce protein records into DNA parts.
5. For design edits, follow the repository `AGENTS.md`: check, compile into `build/`, then prefer `workflow run` and `review run` for final evidence.

## Preserve the review boundary

- `DESIGN_ELIGIBLE` means the record passed the local provenance, rights, sequence, ontology, and safety-policy gates. It does not establish function, orderability, experimental readiness, biosafety, or regulatory approval.
- Keep source snapshots immutable and inactive until an explicit human activation. Quarantine stays physically isolated and unavailable to model-facing search.
- Do not provide wet-lab parameters or procedures. Summarize software-derived results, assumptions, evidence gaps, and the human review still required.

## Produce auditable evidence

Use structured JSON diagnostics for machine-facing failures. Bind every claim to a retrieved source or generated artifact, retain source/license/hash metadata, and record negative results instead of filling gaps with plausible text. A final handoff states which checks were run, which artifacts were produced, and what remains unverified.
