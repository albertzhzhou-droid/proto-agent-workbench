# Getting started

[Overview](../README.md) · [Documentation](README.md) · [Current source evidence](HARNESS_ITERATION_IMPLEMENTATION_2026-09-23.md)

## Desktop

Choose the version you want to try:

| Entry point | What it contains |
| --- | --- |
| [Build the current source](#development) | Chat / Design / Compute, integrated Chemistry, research projects and evidence, and the September 23 architecture and Harness updates. |
| [Download the historical Windows preview](https://github.com/albertzhzhou-droid/proto-agent-workbench/releases/tag/v0.2.0-rc.1) | The published `0.2.0-rc.1` preview and its recorded native-package checks. This download does not represent the later source upgrades. |

### Historical packaged preview

Download the Windows x64 **Portable** or **Setup** from the
[0.2.0-rc.1 preview release](https://github.com/albertzhzhou-droid/proto-agent-workbench/releases/tag/v0.2.0-rc.1).
Use `SHA256SUMS.txt` from the same release to check the file:

```powershell
Get-FileHash '.\Proto.Workbench-0.2.0-rc.1-x64-portable.exe' -Algorithm SHA256
```

The preview is unsigned. The actual Portable and exact extracted installer
payload passed the [recorded native checks](upgrade-verification.md). Those
results belong to that package. Setup installation, upgrade and uninstallation
have not been verified in a disposable Windows environment.

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

### Current source workflow

After [starting a source build](#development), use **Chat / Design / Compute**
to move between scientific conversation, design artifacts and computations.
The application selector switches between **Proto CLI** and **Chem CLI**.

1. Select a workspace. For local-model work, start LM Studio at
   `http://127.0.0.1:1234` and explicitly load or attach to an exact model
   instance. Discovery alone does not connect it.
2. In Chat, choose the modules and skills for the next message. Read source-bound
   documents, inspect tool receipts, and save working documents or research
   project artifacts. Model prose remains distinct from checked evidence.
3. In Design, inspect source, material provenance and real structure coordinates.
   In Compute, open a supported operation, protein comparison or RNA-seq study
   and inspect its input requirements and available runtime.
4. Use the topbar **Workspace execution journal** to inspect tool outcomes and
   effects requiring review. Harness runs retain verification diagnostics,
   consumed repair budgets and a per-run diagnostic JSON export.

See [the unified Chat workflow](chat-unified-workflow.md),
[research projects](research-projects.md), [Chem integration](chem-workbench-port.md)
and [Harness implementation](HARNESS_ITERATION_IMPLEMENTATION_2026-09-23.md).
These are source capabilities; a source build is not a newly accepted installer.

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

The Windows desktop toolchain uses **Node.js 24**, **pnpm 11.19.0** and an
installed **Python 3.12** for the scientific development profile below. The
dependency-light CLI above still supports Python 3.10+. From the repository root:

```powershell
python -m pip install uv==0.12.3
uv sync --locked --python 3.12 --no-managed-python --extra compute --extra compute-research --extra compute-vision --extra compute-chem --extra chem-workbench --extra research-figures
$env:PROTO_AGENT_PYTHON = (Resolve-Path .\.venv\Scripts\python.exe).Path
$env:PROTO_CHEM_PYTHON = $env:PROTO_AGENT_PYTHON
Set-Location apps\proto-workbench
pnpm install --frozen-lockfile
node scripts\verify-offline.mjs
pnpm dev:desktop
```

This matches the Python extras used by the Workbench CI job. It does not install
every optional scientific engine. To produce the desktop source bundle without
launching it, run `pnpm build:desktop`. `pnpm build` followed by `pnpm preview`
provides a static browser preview. Use `pnpm dev` for the browser development
server's local Chat, Chemistry and model service routes. Neither browser mode
establishes native desktop or installer acceptance.

Public checkouts bundle **Newsreader**, **Hanken Grotesk** and **Commit Mono**
under their upstream Open Font Licenses. Local self-use builds continue to use
the supplied Anthropic families when available; those original font files remain
Git-ignored. See [typography profiles](typography.md) for explicit public/local
build selection, role mapping and license provenance.

The verifier runs the repository's offline baseline; it is not an OS-level
network-isolation claim. Native application, model and packaging checks are
separate gates. See [Contributing](../CONTRIBUTING.md) and
[build transactions](build-transactions.md) before packaging.

### Optional scientific runtimes

| Capability | Additional requirement |
| --- | --- |
| Local AI | Separately installed LM Studio, a running local server and an explicitly connected loaded model. No model weights are bundled. |
| Python, R and Jupyter execution | A configured rootless OCI provider and digest-pinned image. The machine-local sandbox profile is ignored by Git. See [execution deployment](chat-execution-deployment.md). |
| WSL bioinformatics and RNA-seq fitting | Separately deployed engines, including DESeq2 for fitting. A saved configuration does not establish availability; tools probe the configured environment. See [bioinformatics](bioinformatics-environment.md) and [RNA-seq studies](rnaseq-studies.md). |
| Chemistry | The checked-in source snapshot and UI still need a configured Python environment. Psi4 calculations and XDL inspection require their respective external environments; see [runtime configuration](chem-workbench-port.md#source-runtime-and-data). |
| Other Compute methods | Method-specific Python extras and declared local inputs. See [the computation library](biomni-compute.md). |

Do not infer runtime availability from a visible module or installed UI. Recorded
local checks use their documented environments and fixtures; scientific review
and new-machine deployment remain separate steps.
