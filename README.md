<div align="center">

# Proto Workbench

### Local AI. Traceable designs. Real molecular views.

From a design brief to checked source, inspectable evidence, and linked DNA and protein visualization.

[![Preview version](https://img.shields.io/badge/preview-0.2.0--rc.1-169c88?style=flat-square)](https://github.com/albertzhzhou-droid/proto-agent-workbench/releases/tag/v0.2.0-rc.1) [![Desktop platform](https://img.shields.io/badge/desktop-Windows_x64-294b46?style=flat-square)](docs/getting-started.md#desktop) [![Local inference](https://img.shields.io/badge/local_AI-LM_Studio-294b46?style=flat-square)](docs/reliable-harness.md) [![Software license](https://img.shields.io/badge/software-MIT-294b46?style=flat-square)](LICENSE)

**[Download preview](https://github.com/albertzhzhou-droid/proto-agent-workbench/releases/tag/v0.2.0-rc.1)** · **[Get started](docs/getting-started.md)** · **[Explore the docs](docs/README.md)** · **[See validation](docs/upgrade-verification.md)**

</div>

<a href="docs/assets/workbench-0.2.0/protein-structure.png"><img src="docs/assets/workbench-0.2.0/protein-structure.png" alt="Proto Workbench in native Windows Electron: a real protein structure, linked residue selection, source mapping and verified export." width="100%"></a>

<p align="center"><sub>Real native application capture · PDB 1B8J coordinates · 449 mapped residues · independently reopened 3D export</sub></p>

## One workspace, three connected views

| Reliable autonomous Harness | Source-based DNA design | Real protein structures |
|---|---|---|
| Give a mission a goal, workspace and budget. Inspect its tool results, dependency graph, checkpoints and verified deliverables. | Move from circular map to feature to base. Stage occurrence edits, inspect the diff, then check, compile, undo or redo. | Explore sequence tracks alongside authentic PDB/AlphaFold or local coordinates. Select a residue in either view and follow its mapping. |
| [Execution and recovery →](docs/reliable-harness.md) | [DNA editing →](docs/dna-source-editing.md) | [Structure inspection →](docs/protein-structures.md) |

<table>
<tr>
<td width="50%"><a href="docs/assets/workbench-0.2.0/harness-execution.png"><img src="docs/assets/workbench-0.2.0/harness-execution.png" alt="A real completed Harness mission, with saved tool results, explicit execution dependencies and review evidence."></a></td>
<td width="50%"><a href="docs/assets/workbench-0.2.0/dna-workbench.png"><img src="docs/assets/workbench-0.2.0/dna-workbench.png" alt="A governed QA construct in synchronized CGView and SeqViz views, with feature selection and map export evidence."></a></td>
</tr>
<tr>
<td><strong>Follow the work.</strong> A completed local-model mission reopened in native development Electron.</td>
<td><strong>Inspect the design.</strong> The final Portable showing a governed 896 bp software QA construct.</td>
</tr>
</table>

All demo images are unchanged captures from actual validation. The Harness image
comes from an earlier native run; DNA and protein images come from final package
checks. Local structure import retains its source-unknown label, while the test
record separately binds the bytes to an official download.
[Capture provenance and scope →](docs/upgrade-verification.md)

<details>
<summary><strong>See the Launchpad: live readiness before a mission</strong></summary>

![Native Launchpad showing verified modules, workspace readiness and an unloaded local model](docs/assets/workbench-0.2.0/launchpad.png)

Model discovery, actual instance connection and readiness are separate states.
The captured model is unloaded. Both light and dark themes were checked.

</details>

## From intent to evidence

```mermaid
flowchart LR
    A[Goal + scope] --> B[Materials + sources]
    B --> C[Design source]
    C --> D[Check + compile]
    D --> E[Review evidence]
    E --> F[Visualize + export]
    D -->|diagnostics| C
```

- **Keep the thread of a long task.** Durable checkpoints retain budgets, material bindings and complete tool-result references. Recovery verifies prior effects before continuing.
- **Make completion inspectable.** Deliverables and acceptance evidence determine success; interrupted or unverified work stays visibly incomplete.
- **Use your local model.** LM Studio supplies inference, with budgeting against the actual loaded context. Qwen Q4 was exercised at 32,768 tokens.
- **Carry source identity into the view.** DNA edits bind source and material digests; protein mappings retain chains, residue numbers and missing positions.
- **Export something you can reopen.** DNA and 2D tracks support SVG/PNG; real structures support PNG with source and view metadata.

## Start where you work

| I want to… | Start here |
|---|---|
| Use the Windows application | [Download the preview](https://github.com/albertzhzhou-droid/proto-agent-workbench/releases/tag/v0.2.0-rc.1) · [Desktop setup](docs/getting-started.md#desktop) |
| Try the deterministic CLI loop | [Install and run the toy example](docs/getting-started.md#cli) |
| Connect an AI host | [MCP tools and configuration](docs/mcp_usage.md) |
| Build or improve the application | [Development setup](docs/getting-started.md#development) · [Contributing](CONTRIBUTING.md) |

The Windows preview provides **Portable** and **Setup** downloads with SHA-256
checksums. Both are unsigned. Native Portable and extracted Setup-payload checks
passed; installation, upgrade and uninstallation remain untested.

### Try the CLI

From a source checkout, using Python 3.10 or later:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e .
proto-agent check designs\toggle_switch.proto --json
proto-agent workflow run designs\toggle_switch.proto
proto-agent review run designs\toggle_switch.proto
```

This example uses the bundled **toy fixture**. Outputs go under `build/`.
Source-backed designs start with an eligible material search and materialized
selection. [Full setup and workflow guide →](docs/getting-started.md)

## Biological materials, with provenance

| Public collection | Included | Boundary |
|---|---:|---|
| iGEM DNA parts | **1,046** | Reviewed source records, sequence digests and per-record rights |
| UniProt proteins | **20** | Reviewed sequence records with source and license evidence |
| Quarantine metadata | **1,795** | Separate index; no sequence objects; activation denied; never model-visible |

The checked-in public distribution contains SQLite catalogs, content-addressed
sequence objects, license records and reproducible checksum inventories. The live
external catalog, activation state and crawl caches remain local. Installing a
public catalog does not activate it.

[Browse the bundles](materials/bundles/README.md) · [Understand the data licenses](materials/DATA_LICENSES.md) · [Material workflow](docs/materials_library.md)

## What has been verified

**Recorded local results for `0.2.0-rc.1` — not a live CI badge.**

| Check | Result | Scope |
|---|---|---|
| Local Qwen debug campaign | **15/15 tasks** | 7 direct, 8 after bounded repair; three task families; actual 32K context |
| JavaScript + TypeScript | **809 tests passed** · typecheck passed | Recorded source gates |
| Python CLI | **242 passed** · 4 platform skips | Recorded local gate |
| Packaged scientific UI | **8/8 + 8/8** | Actual Portable and exact extracted installer payload; clean owned exit |
| Public materials | **1,083 files matched** | Independent rebuild and staged Git-byte comparison |

The model campaign recorded zero host recovery, incomplete or false-completion
outcomes and unloaded the owned model after sample fifteen. It is a debug sample,
not the original sixty-task/all-family acceptance run. Earlier native missions
and final package checks are reported separately.

[Verification detail](docs/upgrade-verification.md) · [Machine-readable evidence](docs/release-evidence/0.2.0-rc.1.json) · [Current CI](https://github.com/albertzhzhou-droid/proto-agent-workbench/actions/workflows/ci.yml)

## Explore, build, contribute

| Understand the system | Work with the project |
|---|---|
| [Harness contracts and recovery](docs/reliable-harness.md) | [Documentation hub](docs/README.md) |
| [DNA placement and IR v2](docs/dna-source-editing.md) | [CLI and workflow reference](docs/cli-guide.md) |
| [Protein coordinates and exports](docs/protein-structures.md) | [Changelog](CHANGELOG.md) |
| [Security architecture](docs/security_architecture.md) | [Contribution guide](CONTRIBUTING.md) |
| [Immutable packaging](docs/build-transactions.md) | [Report an issue](https://github.com/albertzhzhou-droid/proto-agent-workbench/issues) |

Next priorities include broader model-family acceptance, fault recovery under
live inference, report-format resilience, and disposable-Windows installer
verification. [Scope and remaining work →](docs/upgrade-verification.md#remaining-work-and-limits)

---

**Experimental research software.** The Workbench (`0.2.0-rc.1`) and Python CLI
(`0.1.0`) are versioned independently. Software checks and policy eligibility do
not establish experimental readiness; scientific results require human review.
This project does not provide wet-lab execution instructions.

Software: [MIT](LICENSE). Biological records retain their upstream licenses;
MIT does not relicense them. Built with Electron, React, LM Studio, CGView,
SeqViz and Mol*. [Third-party notices](apps/proto-workbench/THIRD_PARTY_NOTICES.md).
