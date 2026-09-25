# Source layout and publication scope

Proto CLI, Chem CLI, the scientific operators, repository Skills and Harness are
published together in this repository. No separate download of a private source
module is required. Optional scientific runtimes, model weights, private user
data and local fonts remain separate from the published source.

| Area | Implementation and contracts | Supporting material |
|---|---|---|
| Proto CLI and scientific operators | [Python package](../src/proto_agent/), including every `compute*.py` module; [canonical tool contracts](../apps/proto-workbench/src/shared/tool-contracts.ts) and [generated Python contracts](../src/proto_agent/data/tool-contracts.json) | [Python tests](../tests/), [computing guide](biomni-compute.md) |
| Chem CLI and original web interface | [Complete Python project](../apps/proto-workbench/runtime/chem-workbench/), including tests, schemas, examples and pinned dependencies | [Chem source guide](../CHEM_CLI.md), [upstream development manifest](../apps/proto-workbench/runtime/chem-workbench/development-manifest.json) |
| Integrated chemistry operators | [All integration modules](../apps/proto-workbench/runtime/chem-integration/), [operator contracts](../apps/proto-workbench/src/shared/chem-science.ts), [shared research registry](../apps/proto-workbench/src/shared/research-tool-registry.ts) | [Method inventory](chem-science-operators.md), [integration tests](../apps/proto-workbench/tests/) |
| All seven repository Skills | [Editable Skills](../.codex/skills/), [packaged workspace copies](../apps/proto-workbench/runtime/workspace-template/.codex/skills/), [Skill SDK](../src/proto_agent/skill_sdk.py) | [Skill adaptation and attribution](academicforge_skill_adaptation.md), each Skill's `SKILL.md`, `proto-skill.json` and references |
| Harness and execution | [Controller](../apps/proto-workbench/src/main/services/harness-controller.ts), [iteration](../apps/proto-workbench/src/main/services/harness-iteration.ts), [context](../apps/proto-workbench/src/main/services/harness-context.ts), [store](../apps/proto-workbench/src/main/services/harness-store.ts), [workspace](../apps/proto-workbench/src/main/services/harness-workspace.ts), [execution kernel](../apps/proto-workbench/src/main/services/execution-kernel.ts), and the other `harness-*.ts` services | [Harness design](reliable-harness.md), [iteration implementation](HARNESS_ITERATION_IMPLEMENTATION_2026-09-23.md), [evaluation scope](harness_iteration_evaluation.md) |
| Managed research studies | [Plan compiler](../apps/proto-workbench/src/main/services/research-plan-compiler.ts), [project store](../apps/proto-workbench/src/main/services/research-project-store.ts), [runtime](../apps/proto-workbench/src/main/services/managed-research-runtime.ts), [evidence](../apps/proto-workbench/src/main/services/managed-research-evidence.ts), UI and shared contracts | [Implementation report](NEXT_ARCHITECTURE_IMPLEMENTATION_2026-09-24.md), [capability ledger](NEXT_ARCHITECTURE_CAPABILITIES.md), [architecture decision](adr/0006-managed-study-plan-and-project-objects.md) |

The repository Skills are `evidence-first-literature-review`,
`governed-materials-review`, `lm-studio-model-endpoint`, `proto-science-workflow`,
`research-provenance`, `scientific-sequence-visualization` and
`sequence-resource-analysis`. These are the project's authored/adapted Skills;
third-party plugins installed in a developer's personal agent environment are
not repository source. License and attribution files remain with the applicable
components.

## Publication checks

`node scripts/verify-chem-source-publication.mjs` checks source manifests,
required modules and Skills, Git tracking and ignore rules. It rejects source
that has become ignored even if it was previously committed, and rejects local
artifacts already tracked under Chem. The dedicated
[Chem source workflow](../.github/workflows/chem-source.yml) runs that guard and
core compiler checks; the [main CI workflow](../.github/workflows/ci.yml) includes
Harness, contract and managed-study checks.

Chem resource packaging and build-input hashing apply the same local-artifact
exclusions, independently of Git. A regression checks the actual electron-builder
matcher against resource enumeration, including pruning excluded environments
before directory traversal. Source, tests and lockfiles stay included. Native
sidecar binaries still require the separate build step in the
[development setup](getting-started.md#development).

The source includes implementation and architecture documents, scientific method
references, test fixtures, scripts, licenses and configured CI. Local execution
logs, mutable studies, acceptance run directories and installed runtimes stay in
ignored locations. Published reports identify their original check scope and
limitations; including them does not turn historical results into current hosted
CI or scientific acceptance.

The Chem developer supplement contains explicitly transformed software fixtures:
historical host paths and a large machine inventory were replaced with synthetic
test provenance, and dependent hashes were rebound. Original hashes and published
hashes are distinguished in its development manifest. These public fixtures are
not the original retained execution evidence, and the 254 sealed scientific
source/resource files remain unchanged.
