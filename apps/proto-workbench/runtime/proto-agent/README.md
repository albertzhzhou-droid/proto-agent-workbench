# Proto agent sidecar

Packaged builds expect `proto-workbench-sidecar/proto-workbench-sidecar.exe`,
`proto-agent-mcp/proto-agent-mcp.exe`, and the bounded admin CLI
`proto-agent/proto-agent.exe` in this directory. Build all three from this repository with
`scripts/build-proto-sidecar.ps1` after installing the root Python project with
the `workbench` optional dependencies.

Both sidecars use PyInstaller's directory layout instead of temporary one-file
extraction. This keeps startup latency predictable and avoids writing executable
payloads into the user's temporary directory on every launch.

The sidecar exposes only structured model-catalog operations. Proto workflow
tools continue to use the repository's JSON-RPC MCP process and remain behind the
desktop permission policy.
