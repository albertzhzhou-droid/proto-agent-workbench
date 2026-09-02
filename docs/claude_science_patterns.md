# Claude Science-Inspired Workflow Patterns

This note summarizes public, product-level observations about Claude Science and maps them into this Proto Agent Toolchain. It is not a reverse engineering of private code, protocols, accounts, traffic, or proprietary implementation details.

## Public Signals Used

- Claude Science has been described as a public beta research workbench for life sciences and scientific computing.
- Its core positioning is workflow consolidation: literature review, hypothesis development, data analysis, visual generation, manuscript drafting, and publication support inside one environment.
- Public coverage mentions connections to tools scientists already use, including PubMed, Jupyter, and R.
- It reportedly runs on a lab's own infrastructure so sensitive datasets stay local, with only required context sent to the model.
- Auditability is a first-class feature: outputs include source code, message history, and plain-language explanations.
- Adjacent Claude product lines emphasize connectors, MCP-style tool access, and domain-specific workflow packages.

Sources checked on 2026-07-08:

- [TechRadar, "Anthropic launches AI workbench for scientists using Claude"](https://www.techradar.com/pro/anthropic-launches-ai-workbench-for-scientists-using-claude), 2026-07-04.
- [Times of India, "Anthropic launches Claude Science AI research workbench for scientific research"](https://timesofindia.indiatimes.com/technology/tech-news/anthropic-launches-claude-science-ai-research-workbench-for-scientific-research/articleshow/132115850.cms), 2026-07-01.
- [The Verge, "Anthropic launches research tool and Google Workspace integration"](https://www.theverge.com/ai-artificial-intelligence/648595/anthropic-claude-research-google-workplace), 2025-04-15.
- [The Verge, "Anthropic launches tool to connect AI systems directly to datasets"](https://www.theverge.com/2024/11/25/24305774/anthropic-model-context-protocol-data-sources), 2024-11-25.

## Patterns Worth Copying

1. Workbench, not chatbot
   - A useful scientific assistant wraps the whole work loop: context gathering, design, execution, validation, artifact production, and review.

2. Local-first execution
   - Sensitive datasets and design files should stay in the project workspace.
   - External model calls should receive only scoped context and structured diagnostics.

3. Connector registry
   - Each external system should be represented as a declared connector with a purpose, status, command/API surface, and safety notes.
   - Missing integrations should be explicit rather than hidden behind natural language.

4. Reproducible run ledger
   - Every workflow run should write a machine-readable manifest with inputs, commands, outputs, diagnostics, and review status.

5. Human review gates
   - Biological design workflows need an explicit review state before any real-world use.
   - The tool should be able to say "validated as a software artifact" without implying "ready for wet lab".

6. Evidence-centered handoff
   - Scientific work benefits when claims, artifacts, diagnostics, and reviewer actions are separated into reviewable evidence units.
   - The assistant should be able to hand a design to another person or AI agent with clear supported, failed, and needs-review states.

7. Small tool surface
   - The assistant should call focused tools like `check`, `compile`, `export`, `score`, and `parts search`, not a large ambiguous interface.

## Mapping Into This Repository

| Claude Science-like pattern | Proto Agent implementation |
| --- | --- |
| Unified scientific workbench | `proto-agent workflow run` |
| PubMed/Jupyter/R-style integrations | `connectors/proto_workbench.json`, `proto-agent connectors`, and `proto-agent literature pubmed` |
| Literature review seed layer | `proto-agent literature search` and `proto_literature_search` |
| MCP-style agent connectors | `proto-agent mcp` / `proto-agent-mcp` |
| Local infrastructure | Execution is local and writes under `build/`; individually approved literature connectors may call fixed external services |
| Auditability | Workflow manifests under `build/runs/` |
| Evidence-centered handoff | `proto-agent review run`, `proto_review_packet`, and evidence cards under `build/reviews/` |
| Code + explanation | Manifest captures command plan, diagnostics, artifacts, and plain-language summary |
| Safety gate | Manifest records `review_status: human_review_required` |
| Deterministic validation | `proto-agent sequence validate` and `proto_validate_sequences` |
| Reviewable optimization | `proto-agent sequence optimize` and `proto_optimize_sequences` |
| Local analysis runtime | `proto-agent analysis run` and `proto_run_analysis` |
| Notebook workflow | `proto-agent notebook run` and `proto_run_notebook` |
| Optional R runtime | `proto-agent r status`, `proto-agent r run`, `proto_r_status`, and `proto_run_r` |
| Exchange-format bridge | `proto-agent export --format sbol`, `proto-agent sbol validate`, and `proto_validate_sbol` |

## Explicit Non-Goals

- Do not bypass Claude Science access controls or inspect non-public binaries, network calls, or private APIs.
- Do not copy proprietary UI, code, schemas, or internal prompts.
- Do not claim biological readiness from toy fixtures.
