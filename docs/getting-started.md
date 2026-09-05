# Getting started

[Overview](../README.md) · [Documentation](README.md) · [Verification scope](upgrade-verification.md)

## Desktop

Download the Windows x64 **Portable** or **Setup** from the
[0.2.0-rc.1 preview release](https://github.com/albertzhzhou-droid/proto-agent-workbench/releases/tag/v0.2.0-rc.1).
Use `SHA256SUMS.txt` from the same release to check the file:

```powershell
Get-FileHash '.\Proto Workbench-0.2.0-rc.1-x64-portable.exe' -Algorithm SHA256
```

The preview is unsigned. The actual Portable and exact extracted installer
payload passed native scientific checks. Setup installation, upgrade and
uninstallation have not been verified in a disposable Windows environment.

1. Open the Portable, or use Setup if you choose to install the preview.
2. Check Launchpad readiness and select the workspace you want to use.
3. For AI missions, start LM Studio's local server at `http://127.0.0.1:1234`.
   In Workbench, explicitly load or attach to the intended model instance.
   Discovery alone does not connect it. The tested Qwen Q4 configuration uses
   **32,768 context tokens**.
4. Inspect a design artifact in **Designs**, or create a scoped mission and
   follow its results in **Runs**. Review material provenance before designing
   with source-backed records.

Protein viewing requires existing coordinates from a supported official source
or local PDB/mmCIF. This version does not run structure prediction. Sequence
inspection remains available without a structure.

For separate testing profiles and workspaces, see [isolated sessions](isolated-desktop-sessions.md).

## CLI

Prerequisite: Python **3.10+**. From a repository checkout in PowerShell:

```powershell
git clone https://github.com/albertzhzhou-droid/proto-agent-workbench.git
Set-Location proto-agent-workbench
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e .
```

Try the deterministic **toy fixture**:

```powershell
proto-agent check designs\toggle_switch.proto --json
proto-agent workflow run designs\toggle_switch.proto
proto-agent review run designs\toggle_switch.proto
```

`workflow run` checks and compiles the design, exports development artifacts,
and writes a run manifest. `review run` verifies provenance and creates evidence
cards and a human-review checklist. Outputs stay under `build/`.

The bundled `parts/ecoli_k12_library.json` is a toy library. For source-backed
designs, search eligible materials, materialize a selection, then search the
resulting parts snapshot. Never invent part identifiers.

## Public materials

```powershell
proto-agent materials bundle-verify --profile PUBLIC_CATALOG
proto-agent materials bundle-verify --profile PUBLIC_QUARANTINE
proto-agent materials bundle-install-public
```

Installation verifies and copies the public catalog into the external materials
root; it does **not** activate it. The default root is a sibling directory named
`Proto CLI Materials`; set `PROTO_AGENT_MATERIALS_ROOT` to choose another location.
Activation is a separate human action described in the
[bundle guide](../materials/bundles/README.md). Quarantine metadata cannot be
installed or activated and is not exposed to model-facing tools.

## MCP

After installing the CLI, the stdio entrypoint is:

```powershell
proto-agent mcp
```

Configure your host with the executable and workspace from your own checkout.
See [MCP usage](mcp_usage.md) for host configuration, tool contracts and bounded
smoke requests. Live network calls and code-execution adapters have their own
explicit boundaries.

## Development

The Windows desktop toolchain uses **Node.js 24** and **pnpm 11.19.0**. From the
repository root, with the Python environment prepared:

```powershell
Set-Location apps\proto-workbench
pnpm install --frozen-lockfile
node scripts\verify-offline.mjs
pnpm dev:desktop
```

The verifier runs the repository's offline baseline; it is not an OS-level
network-isolation claim. Native application, model and packaging checks are
separate gates. See [Contributing](../CONTRIBUTING.md) and
[build transactions](build-transactions.md) before packaging.
