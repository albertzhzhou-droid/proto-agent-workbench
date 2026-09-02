# Proto Design Workflow

When editing Proto designs in this repository:

1. Never invent biological part IDs. Use `proto-agent materials search` first, materialize an eligible selection, then use `proto-agent parts search --parts <materialized snapshot>` for DNA parts. For protein work, use `materials materialize-proteins` followed by `protein validate`/`protein compile`; the legacy `parts/ecoli_k12_library.json` remains a toy fixture.
2. After every design edit, run `proto-agent check <file> --json`.
3. If checking succeeds, run `proto-agent compile <file> --out build/<name>.ir.json`.
4. Keep generated artifacts under `build/`.
5. Treat all bundled part sequences as toy development fixtures unless explicitly replaced by a reviewed library.
6. Do not provide wet-lab execution instructions. Summarize assumptions and validation status instead.
7. Prefer structured JSON diagnostics over prose when feeding errors back into Codex/GPT.
8. For end-to-end review, prefer `proto-agent workflow run <file>` so the run manifest captures provenance.
9. Before a final handoff, prefer `proto-agent review run <file>` so evidence cards and the human-review checklist capture what is supported or still needs review.
10. Check `connectors/proto_workbench.json` before assuming that an external system is available.
11. Use `proto-agent mcp` when a host needs structured tool access instead of shell command access.
12. The external materials root defaults to the project sibling `..\Proto CLI Materials` and can be overridden with `PROTO_AGENT_MATERIALS_ROOT`; never copy a large snapshot into the repository or installer. Model-facing MCP can only read `DESIGN_ELIGIBLE` records; quarantine is physically isolated and admin-only.

Recommended loop:

```text
user goal -> inspect connectors -> edit .proto -> workflow run -> review packet -> iterate
```

The Claude Science-inspired layer is documented in `docs/claude_science_patterns.md`. Use those patterns only as public product-level inspiration; do not copy proprietary implementation details or attempt to bypass any private system.
