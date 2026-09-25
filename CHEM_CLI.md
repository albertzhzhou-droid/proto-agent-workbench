# Chem CLI

Chem CLI is open-source software in this repository alongside Proto CLI, under
the [MIT license](apps/proto-workbench/runtime/chem-workbench/LICENSE). Its Python
package is named `chem-workbench`, its import package is `chem_workbench`, and its
command is `chem`. The directory name `runtime` describes how the desktop bundles
the source; it does not mean the directory contains only compiled binaries.

## Source map

| Component | Source |
|---|---|
| Python CLI, compiler, ChemIR, validation and original web interface | [chem_workbench](apps/proto-workbench/runtime/chem-workbench/src/chem_workbench/) |
| Python dependencies and pinned versions | [pyproject.toml](apps/proto-workbench/runtime/chem-workbench/pyproject.toml), [uv.lock](apps/proto-workbench/runtime/chem-workbench/uv.lock) |
| Schema contracts and illustrative inputs | [schemas](apps/proto-workbench/runtime/chem-workbench/schemas/), [examples](apps/proto-workbench/runtime/chem-workbench/examples/) |
| Python regression tests and fixtures | [tests](apps/proto-workbench/runtime/chem-workbench/tests/) |
| Development scripts and original desktop wrapper | [scripts](apps/proto-workbench/runtime/chem-workbench/scripts/), [desktop](apps/proto-workbench/runtime/chem-workbench/desktop/) |
| Integrated scientific operators and process bridge | [chem-integration](apps/proto-workbench/runtime/chem-integration/) |
| Shared desktop chemistry interface | [ChemWorkspace.tsx](apps/proto-workbench/src/renderer/ChemWorkspace.tsx), [ChemComputationWorkspace.tsx](apps/proto-workbench/src/renderer/ChemComputationWorkspace.tsx), [UI overlays](apps/proto-workbench/src/chem-ui/) |
| Host integration and shared tool contracts | [Chem host service](apps/proto-workbench/src/main/services/chem-workbench.ts), [scientific service](apps/proto-workbench/src/main/services/chem-science.ts), [operator contracts](apps/proto-workbench/src/shared/chem-science.ts) |
| Architecture, third-party notices and upstream history | [docs](apps/proto-workbench/runtime/chem-workbench/docs/), [third_party](apps/proto-workbench/runtime/chem-workbench/third_party/), [CHANGELOG](apps/proto-workbench/runtime/chem-workbench/CHANGELOG.md) |

The React/Electron interface uses Proto's shared host, navigation and execution
services. Use the [Workbench development setup](docs/getting-started.md#development)
for that interface. The Python project below also runs independently of Electron.

## Install and check the Python CLI

From this repository's root, with Python 3.11 or later and `uv` installed:

```powershell
cd apps/proto-workbench/runtime/chem-workbench
uv sync --locked
uv run --no-sync chem --help
uv run --no-sync chem check examples/molecules/aspirin.chem
uv run --no-sync python -m pytest -q tests/test_parser_and_compiler.py tests/test_json_schemas.py
```

The example checks a software declaration and can retain a human-review
diagnostic. It is not a synthesis procedure or an experimental validation.
`uv sync --locked` installs the core package and development dependencies;
scientific extras, Psi4 and isolated XDL have separate setup requirements.
See the [upstream README](apps/proto-workbench/runtime/chem-workbench/README.md)
and [chemistry environment notes](apps/proto-workbench/runtime/chem-workbench/docs/chemistry-environment.md).
Optional backend tests require their declared dependencies. Including their test
source does not mean those environments have been installed or accepted.

## Source identity and contribution checks

The original 254 scientific source/resource files remain byte-identical to
[snapshot-manifest.json](apps/proto-workbench/runtime/chem-workbench/snapshot-manifest.json).
The separately added developer files have their own
[development-manifest.json](apps/proto-workbench/runtime/chem-workbench/development-manifest.json).
They restore the tests and development context that the original runtime-only
copy omitted. These manifests bind file identity; they do not establish scientific
accuracy or a passing full backend suite.

From the repository root, with Node.js 24:

```powershell
node scripts/verify-chem-source-publication.mjs
node --test scripts/tests/verify-chem-source-publication.test.mjs
```

The publication check verifies hashes, Git tracking, and ignore rules. Keep
compiler/source changes separate from integration-layer changes, following
[the integration guide](docs/chem-workbench-port.md). Refreshing the immutable
scientific snapshot remains an explicit maintenance operation; ordinary desktop
builds do not import changes from a sibling checkout.

## What belongs in Git

Track Chem's source, tests, fixtures, schemas, examples, dependency lockfile,
development scripts and license notices just as for Proto. The root
[.gitignore](.gitignore) excludes virtual environments, installed `.chem-backends`,
Python/Node caches, generated `build`/`dist` directories, calculation scratch,
`timer.dat`, secrets, model weights and generated UI overlays. Authored UI overlays
remain tracked under `src/chem-ui`; public typography uses the licensed font set.

Do not ignore the whole `runtime` or `chem-workbench` directory or use broad
`*.json`, `*.chem`, `*.cif` or `*.csv` exclusions: those extensions also contain
source contracts and regression fixtures. An ignore rule does not remove an
already tracked file; the publication check also rejects tracked local artifacts.
