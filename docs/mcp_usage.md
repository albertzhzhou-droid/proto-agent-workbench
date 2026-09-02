# MCP Usage

`proto-agent` includes a small stdio MCP server so agent hosts can call the same local tools that the CLI uses.

## Tools

- `proto_check`
- `proto_compile`
- `proto_export`
- `proto_validate_sbol`
- `proto_score`
- `proto_validate_sequences`
- `proto_optimize_sequences`
- `proto_search_parts`
- `proto_protein_compile`
- `proto_materials_search`
- `proto_materials_get`
- `proto_materials_facets`
- `proto_materials_materialize_proteins`
- `proto_workflow_run`
- `proto_review_packet`
- `proto_provenance_verify`
- `proto_literature_search`
- `proto_pubmed_search`
- `proto_run_analysis`
- `proto_run_notebook`
- `proto_r_status`
- `proto_run_r`
- `proto_connectors_check`

Protein materialization and compilation stay bounded and explicit. A host first
calls `proto_materials_search` with `status: "DESIGN_ELIGIBLE"`, then calls
`proto_materials_materialize_proteins` with the selected IDs and finally calls
`proto_protein_compile` on the returned workspace-relative selection. The
compile response contains counts, diagnostics, and an artifact path—not the
full sequence payload—while the artifact retains its source, license, and
selection digest for the local Workbench view.

## Local Smoke Test

```powershell
.\.venv\Scripts\proto-agent.exe mcp --once-file examples\mcp\tools_list.request.json
```

For a tool call:

```powershell
.\.venv\Scripts\proto-agent.exe mcp --once-file examples\mcp\proto_check.request.json
```

For local source notes:

```powershell
.\.venv\Scripts\proto-agent.exe mcp --once-file examples\mcp\literature_search.request.json
```

For PubMed metadata through the same tool surface:

```powershell
.\.venv\Scripts\proto-agent.exe mcp --once-file examples\mcp\pubmed_search.request.json
```

For sequence constraints:

```powershell
.\.venv\Scripts\proto-agent.exe mcp --once-file examples\mcp\sequence_validate.request.json
```

For sequence optimization suggestions:

```powershell
.\.venv\Scripts\proto-agent.exe mcp --once-file examples\mcp\sequence_optimize.request.json
```

For SBOL export validation:

```powershell
.\.venv\Scripts\proto-agent.exe mcp --once-file examples\mcp\sbol_validate.request.json
```

For a local analysis run:

```powershell
.\.venv\Scripts\proto-agent.exe mcp --once-file examples\mcp\run_analysis.request.json
```

Execution requests fail closed unless the MCP sidecar was explicitly started with
`PROTO_AGENT_SANDBOX_PROVIDER=docker|podman` and a digest-pinned
`PROTO_AGENT_SANDBOX_IMAGE`. MCP cannot enable unsafe host execution. The OCI
provider remains network-disabled, read-only, non-root, capability-dropped, and
resource-bounded; provider discovery alone is reported as `smoke_verified: false`.

For a lightweight notebook run:

```powershell
.\.venv\Scripts\proto-agent.exe mcp --once-file examples\mcp\run_notebook.request.json
```

For R runtime detection:

```powershell
.\.venv\Scripts\proto-agent.exe mcp --once-file examples\mcp\r_status.request.json
```

For a communication-ready review packet:

```powershell
.\.venv\Scripts\proto-agent.exe mcp --once-file examples\mcp\review_packet.request.json
```

## Claude Desktop / MCP Host Shape

Use the installed script when available:

```json
{
  "mcpServers": {
    "proto-agent": {
      "command": "C:\\path\\to\\proto-agent-toolchain\\.venv\\Scripts\\proto-agent-mcp.exe",
      "args": [],
      "cwd": "C:\\path\\to\\proto-agent-toolchain"
    }
  }
}
```

Or run through the main CLI:

```json
{
  "mcpServers": {
    "proto-agent": {
      "command": "C:\\path\\to\\proto-agent-toolchain\\.venv\\Scripts\\proto-agent.exe",
      "args": ["mcp"],
      "cwd": "C:\\path\\to\\proto-agent-toolchain"
    }
  }
}
```

## Design Notes

- The MCP server is a thin domain adapter. It does not duplicate compiler logic.
- Filesystem tools accept workspace-relative paths only and write artifacts under `build/`; reparse points, traversal, absolute paths, and device paths are rejected.
- Network tools use fixed provider endpoints and policy-owned cache paths. MCP defaults to offline/cache-only operation. A live cache miss requires a short-lived, argument-bound, one-time HMAC capability issued by the Electron main process after that exact call is approved; a sidecar-wide environment switch cannot enable live network access.
- Tool results include a text block for generic hosts and `structuredContent` for hosts that can preserve typed results.
- The workflow tool always returns `review_status`; successful software validation does not imply wet-lab readiness.
- The workflow tool also returns workspace-relative manifest/provenance paths and bounded run metrics.
- The review packet tool verifies workflow provenance first, then turns manifests into evidence cards, a Markdown packet, a human-review checklist, and a separately attested handoff.
- `proto_provenance_verify` is read-only and recomputes every declared digest; the offline stress harness is intentionally CLI-only because its cooperative process-global environment/tracemalloc isolation is not suitable for concurrent MCP requests.
