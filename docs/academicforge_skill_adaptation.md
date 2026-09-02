# AcademicForge Skill Adaptation

Proto uses a deliberately small, project-scoped subset of the public
[AcademicForge](https://github.com/HughYau/AcademicForge) catalogue. The inventory in this
document is pinned to commit
[`01b6d90c5b50ba0aa48b6564e45ee4a0ade9487c`](https://github.com/HughYau/AcademicForge/tree/01b6d90c5b50ba0aa48b6564e45ee4a0ade9487c/skills/claude-science),
not to a moving branch. In the matrix below, an upstream name maps to
`skills/claude-science/<name>` at that commit.

Each Proto adapter lives under `.codex/skills/<id>/`:

- `SKILL.md` is the agent-readable workflow and safety contract.
- `proto-skill.json` is the vendor-neutral, machine-readable interface manifest.

The generic SDK in `proto_agent.skill_sdk` parses bounded manifests and resolves each declared
operation against `connectors/proto_workbench.json`. Resolution is read-only: it never executes
Skill text, shell commands, Python snippets, network requests, model calls, or lifecycle actions.
CLI, MCP, and HTTP entries are capability declarations; the corresponding Proto interface must
still be invoked and must produce its own evidence.

## Selection states

- `adapted`: product-level ideas from the pinned upstream Skill are represented by a current
  declarative Proto adapter and routed to a real, bounded project interface.
- `existing-equivalent`: an already available generic Codex or project capability covers the
  purpose, so copying another adapter would add overlap rather than workflow value.
- `irrelevant`: the Skill's stated purpose does not match this repository's governed materials,
  sequence, literature, visualization, or review workflow.
- `deferred-risk`: the Skill could become relevant, but enabling it now would add a model,
  dependency, remote account, execution authority, generation surface, or scientific-validation
  claim that has not been separately reviewed.

`adapted` means a bounded policy/interface adaptation, not that the upstream implementation or
its dependencies were installed. `existing-equivalent` likewise means capability overlap, not
bit-for-bit equivalence.

## Pinned 32-Skill decision matrix

| Theme | Upstream Skill | State | Proto decision |
| --- | --- | --- | --- |
| Structure prediction and docking | `alphafold2` | `deferred-risk` | Requires a separately pinned folding runtime, compute policy, model/data licenses, and output validation. |
| Structure prediction and docking | `openfold3` | `deferred-risk` | Adds a heavyweight external model/runtime and unvalidated structure-prediction claims. |
| Structure prediction and docking | `boltz` | `deferred-risk` | Complex and affinity prediction are outside the validated sequence-only contract. |
| Structure prediction and docking | `chai1` | `deferred-risk` | Antibody/ligand structure prediction needs a separate model, compute, data, and scientific review. |
| Structure prediction and docking | `esmfold2` | `deferred-risk` | All-atom co-folding is not implemented or validated by the current protein IR. |
| Structure prediction and docking | `diffdock` | `deferred-risk` | Small-molecule pose prediction would add chemistry inputs, model execution, and result-validation risk. |
| Protein design and embeddings | `proteinmpnn` | `deferred-risk` | Sequence generation from a backbone would expand Proto from inspection into protein generation. |
| Protein design and embeddings | `ligandmpnn` | `deferred-risk` | Ligand/nucleic-acid/metal-conditioned generation lacks a governed input and validation contract here. |
| Protein design and embeddings | `solublempnn` | `deferred-risk` | Generated protein claims need a separately reviewed model, dataset, and evaluation gate. |
| Protein design and embeddings | `fair-esm2` | `deferred-risk` | Embeddings require a pinned model/runtime and an explicit evidence contract before use. |
| Genomics and single-cell | `borzoi` | `deferred-risk` | Genome-track prediction adds a large model and output semantics not covered by DNA-map validation. |
| Genomics and single-cell | `evo2` | `deferred-risk` | DNA scoring, embeddings, and generation would expand both model and biological-generation scope. |
| Genomics and single-cell | `scgpt` | `irrelevant` | Proto has no governed single-cell dataset or annotation workflow. |
| Genomics and single-cell | `scvi-tools` | `irrelevant` | Probabilistic scRNA-seq analysis is outside the current sequence-resource domain. |
| Figures and visualization | `figure-composer` | `adapted` | `scientific-sequence-visualization` applies composition, bounded rendering, canonical-coordinate, export, and render-then-verify rules to DNA/protein views. |
| Figures and visualization | `figure-style` | `adapted` | `scientific-sequence-visualization` applies legibility, accessible redundant encoding, stable color, and explicit derived-data labeling. |
| Figures and visualization | `algorithmic-art` | `irrelevant` | Generative art does not contribute to scientific sequence fidelity or review evidence. |
| Figures and visualization | `web-artifacts-builder` | `irrelevant` | Its general HTML-artifact purpose is not a substitute for the existing typed Electron sequence renderer. |
| Literature and writing | `literature-review` | `adapted` | `evidence-first-literature-review`, `governed-materials-review`, and `proto-science-workflow` route bounded discovery, identity checks, evidence gaps, and review handoff. |
| Literature and writing | `paper-narrative` | `irrelevant` | The project produces evidence packets, not manuscript story or figure-order editing. |
| Literature and writing | `indication-dossier` | `irrelevant` | Therapeutic indication dossiers are outside the software-only materials and sequence scope. |
| Literature and writing | `pdf-explore` | `existing-equivalent` | The installed generic PDF capability already supports bounded PDF reading and inspection; it is not wired into the Proto execution contract. |
| Compute and workflow | `compute-env-setup` | `deferred-risk` | Remote environment provisioning needs a separate authorization, image, credential, and containment policy. |
| Compute and workflow | `remote-compute-modal` | `deferred-risk` | Modal account use, remote GPU execution, data transfer, and cost authority are not in scope. |
| Compute and workflow | `remote-compute-ssh` | `deferred-risk` | SSH/SLURM submission would add remote credentials and effects beyond the local sandbox contract. |
| Compute and workflow | `managed-model-endpoints` | `adapted` | `lm-studio-model-endpoint` replaces the Claude lifecycle SDK with fixed-loopback LM Studio REST discovery and explicit instance ownership. |
| Compute and workflow | `using-model-endpoint` | `adapted` | `lm-studio-model-endpoint` maps generation to bounded OpenAI-compatible chat after live native-state reconciliation. |
| Compute and workflow | `self-awareness` | `irrelevant` | Claude Science session-database/SDK introspection is host-specific and is not a scientific project operation. |
| Compute and workflow | `skill-creator` | `existing-equivalent` | Codex already provides a generic Skill authoring workflow; Proto's SDK only validates/resolves project manifests. |
| Compute and workflow | `customize` | `deferred-risk` | Porting profile/agent control-plane mutation would exceed the current read-only declarative SDK and needs its own authority model. |
| Compute and workflow | `learn` | `irrelevant` | General tutoring behavior is not part of the deterministic project workflow. |
| Compute and workflow | `product-self-knowledge` | `irrelevant` | Anthropic-product fact checking is unrelated to Proto runtime or scientific evidence. |

This accounts for all 32 pinned entries: 5 `adapted`, 2 `existing-equivalent`, 9
`irrelevant`, and 16 `deferred-risk`. No deferred entry should be treated as available merely
because its upstream directory exists.

## Current project adapters

The seven local adapters are broader than the five directly adapted entries in the matrix: two
also draw on pinned public K-Dense and Orchestra sources recorded in their own manifests.

| Adapter | Pinned inspiration | Proto application |
| --- | --- | --- |
| `lm-studio-model-endpoint` | AcademicForge `managed-model-endpoints`, `using-model-endpoint` | LM Studio native lifecycle and OpenAI-compatible chat over fixed loopback |
| `evidence-first-literature-review` | AcademicForge `literature-review` | Local sources plus capability-gated PubMed, Europe PMC, and Crossref evidence |
| `scientific-sequence-visualization` | AcademicForge `figure-style`, `figure-composer` | DNA/protein digest, coordinate, accessibility, export, and render QA |
| `governed-materials-review` | AcademicForge `literature-review`; K-Dense `biopython` | Three-pass provenance, rights, semantics, safety, consistency, and materialization audit |
| `research-provenance` | Orchestra `research-manager` | Verified workflow manifests, evidence cards, and human-review packets |
| `sequence-resource-analysis` | K-Dense `biopython` | Governed DNA/protein materialization, validation, and bounded analysis |
| `proto-science-workflow` | AcademicForge literature, figure, and endpoint workflow patterns | Project routing and final review boundary |

## Operation-to-evidence mapping

The rows below distinguish a resolved Skill operation from the actual project step that can
produce evidence.

| Area | Adapter operations | Actual project step | Evidence produced or retained |
| --- | --- | --- | --- |
| Generic Skill routing | Resolve declared CLI/MCP/HTTP interfaces | Run `proto-agent skills list`, `skills resolve`, or `skills audit`; a workflow then re-resolves its fixed bindings against `connectors/proto_workbench.json` | Structured resolution/audit JSON; workflow `skill_catalog_sha256`, `connector_registry_sha256`, and exact `skill_bindings`. Resolution alone is not execution evidence. |
| Model | `discover-models` → `load-model` → `generate-chat` → `unload-owned-model` | Workbench reads `GET /api/v1/models`, explicitly loads one exact key, reconciles the exact instance, consumes bounded `/v1/chat/completions` SSE, then unloads only its owned instance | Live catalogue/load/chat/unload observations, exact model and instance identifiers, completed SSE `[DONE]`, and post-action reconciliation. These are not a standalone `build/` artifact unless a run/review explicitly binds them. |
| Materials | `search-candidates`, `inspect-evidence`, `audit-promotion`, `materialize-dna`, `materialize-protein` | Search/get exact governed IDs; run `proto-agent materials promotion-audit`; import a locked passing set as an inactive snapshot; materialize only explicit eligible records | Default `build/materials/promotion-audit.json`; locked reviewed audit/source files; bundle `manifest.json`/`provenance.json`; content-addressed snapshot metadata; bounded DNA or protein selection JSON. Activation remains a separate human action. |
| DNA | `materialize-dna`, `search-materialized-parts`, `validate-dna`, `read-dna-artifact`, `render-and-verify` | Materialize eligible DNA → search that parts snapshot → `check --json` → `compile` → `sequence validate` → Workbench read/search/select/export and perceptual QA | Materialized parts JSON; compiled `build/<name>.ir.json`; workflow inputs/artifacts plus `manifest.json` and `provenance.json` under `build/runs/<run-id>/`; exported files carry digest/layer metadata and an explicit provenance state. |
| Protein | `materialize-protein`, `compile-protein`, `read-protein-artifact`, `render-and-verify` | `materials materialize-proteins` → `protein validate --json` → `protein compile` → optional FASTA export → Workbench bounded residue view and QA | `build/materials/<selection>.json`, protein-domain IR, optional FASTA, and retained accession/revision, license, source/sequence digests, exact length, and software-derived metrics. |
| Literature | `search-local-sources`, `search-biomedical-literature`, `verify-publication-identity`, `bind-review-evidence` | Search the local registry first; use separately approved PubMed/Europe PMC only when needed; corroborate DOI metadata with Crossref; retain support, contradiction, and missing evidence | Structured search results; reproducible caches under `build/cache/pubmed/` and `build/cache/evidence/`; claim-level identifiers and gaps carried into `evidence.cards.json`. Bibliographic identity alone is not scientific support. |
| Review and provenance | `capture-workflow`, `capture-human-review`, `verify-provenance`, `run-design-review`, `build-review-packet` | `proto-agent workflow run <design.proto>` snapshots inputs and runs the fixed validation/export plan; `proto-agent review run` verifies workflow provenance before assembling the human handoff | `build/runs/<run-id>/{inputs/,manifest.json,provenance.json,...}` and `build/reviews/<run-id>/{evidence.cards.json,human_review_checklist.md,review_packet.json,review_packet.md,provenance.json}` with `human_review_required` preserved. |

## Source, license, and private-implementation boundary

AcademicForge identifies the pinned Claude Science collection as Anthropic-authored and
Apache-2.0 licensed. The outer AcademicForge forge/site code may use a different license; each
upstream Skill retains its own authorship and license. For every directly adapted entry, the
local `proto-skill.json` records the exact upstream URL, commit, declared license, and content
SHA-256. Those records preserve attribution but do not relicense upstream work.

The local Skill audit validates bounded schema, allowed content types, vendor neutrality, and
connector resolution. It does **not** fetch the upstream repository or independently attest every
unadapted directory. A future change to any `deferred-risk` item must re-read that exact pinned
Skill and its license, pin all new dependencies/models, define an execution and evidence contract,
and pass a separate safety and scientific review before its state can change.

Only public product-level workflow principles are adapted. Proto does not copy private Claude
Science code, prompts, protocols, session databases, accounts, traffic, or proprietary SDK
behavior; it does not bypass access controls; and it does not imply that an upstream service,
package, model, or runtime is installed. No Skill, software check, visualization, or
`DESIGN_ELIGIBLE` state certifies wet-lab readiness, orderability, biosafety, or regulatory
approval.
