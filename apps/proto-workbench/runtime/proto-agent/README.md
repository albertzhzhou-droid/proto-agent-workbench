# Proto agent sidecars

Packaged builds contain exactly `proto-agent-mcp/proto-agent-mcp.exe` and the
bounded admin CLI `proto-agent/proto-agent.exe` beneath this directory. Build
both from the repository's project-local `.venv` with
`scripts/build-proto-sidecar.ps1`. The legacy model-scanner sidecar is not part
of the product: model discovery and inference use LM Studio at the fixed
loopback endpoint.

Both executables use PyInstaller's directory layout instead of temporary
one-file extraction. The build is created in a same-volume staging directory,
checked for the exact layout, Skill catalogue, MCP tools, and executable hashes,
then published with rollback to the previous complete runtime on failure.

`proto-agent-mcp` exposes the structured JSON-RPC workflow tools used by the
desktop permission policy. The admin CLI is limited to local catalogue and
governance operations used by Workbench. Run `pnpm verify:sidecars` before any
packaging attempt; it executes both owned binaries in a disposable workspace and
rechecks that their complete file trees did not change.
