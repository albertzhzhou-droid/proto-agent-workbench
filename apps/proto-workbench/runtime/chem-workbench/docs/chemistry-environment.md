# Local chemistry environment

## September 13 analytic dispersion extension

The isolated Psi4 prefix now includes the Python API required by Psi4 1.11's
`s-dftd3` bridge. The exact conda-forge additions were:

| Package | Version | Build |
| --- | --- | --- |
| dftd3-python | 1.6.0 | py312h8939941_0 |
| simple-dftd3 | 1.6.0 | gfortran_h888ad9d_0 |
| toml-f | 0.5.2 | gfortran_hee28707_0 |
| jonquil | 0.3.2 | gfortran_hee28707_0 |
| mctc-lib | 0.5.2 | gfortran_hee28707_0 |
| pycparser | 3.0 | pyhcf101f3_0 |
| cffi | 2.1.1 | py312he06e257_3 |

The installation used the existing micromamba, `--freeze-installed` and
`--no-allow-uninstall` after reviewing its dry-run plan. All 74 pre-existing
Conda JSON records remained unchanged; the isolated `pip check` passed. The
solver/install records and package SHA-256 values are retained locally as
`build/refinement-d3bj-dependency-dry-run-20260913.json` and
`build/refinement-d3bj-dependency-install-20260913.json`.

The new [candidate refinement stage](molecular-refinement-stage.md) has its own
source/runtime and method bindings. Native option/derivative preparation passed
on a retained 34-atom candidate; installation alone does not validate a full
electronic gradient, optimized geometry or scientific accuracy. This extension
does not alter the lightweight compiler's required Python dependencies.

## Original compatibility environment

This environment supports the chemistry compatibility work described in the
tool-first implementation plan. Installing a library does not implement or
approve a Workbench adapter. The compiler's normal runtime stays lightweight.

The separately requested chemical XDL installation is documented in
[xdl-environment.md](xdl-environment.md). It uses its own environment and lockfile.

## Python chemistry tools

The `chemistry` extra in `pyproject.toml` and exact resolutions in `uv.lock`
provide ASE (including EMT and atomic data), QCEngine, QCElemental, RDKit
(including InChI), pymatgen, and Basis Set Exchange (local basis-set data).
Their required numerical, structure, symmetry, plotting, and schema libraries
are resolved transitively. No account or API key is needed for these local tools.

Verified installed on 2026-09-05 in the project Python 3.13.3 environment:

| Package | Version |
| --- | --- |
| ASE | 3.29.0 |
| QCEngine | 0.51.0 |
| QCElemental | 0.51.1 |
| RDKit | 2026.3.6 |
| pymatgen / pymatgen-core | 2026.5.4 / 2026.8.30 |
| Basis Set Exchange | 0.12 |
| NumPy / SciPy | 2.5.2 / 1.18.1 |
| spglib | 2.7.0 |

All 76 installed Python distributions passed `uv pip check`. The real copper
EMT check returned `-0.006688768685791047` eV/atom, with maximum force
`5.2831452388335705e-15` eV/angstrom. CIF and SDF round trips, SMILES/InChI,
QCSchema, and local hydrogen/oxygen STO-3G retrieval passed. The full installed
distribution inventory and results are in `build/chemistry-environment/python.json`.
After installation, `uv sync --locked --offline --extra chemistry` succeeded.
The final `scripts/verify.ps1` run passed formatting, lint, strict type checking,
and all 219 project tests. These project checks are separate from the chemistry
installation checks above.

From the repository root in PowerShell:

```powershell
uv sync --locked --extra chemistry --cache-dir build\uv-cache
.\.venv\Scripts\python.exe scripts\verify_chemistry_environment.py --output build\chemistry-environment\python.json
```

Keep `--extra chemistry` when syncing; a plain `uv sync` may remove optional
chemistry packages. Once artifacts are cached, add `--offline` to restore them
without network access.

## Psi4 backend

Psi4 uses a separate native Windows conda-forge environment at
`.chem-backends/psi4` with Python 3.12. It is not installed into the Python 3.13
project virtual environment. The environment is ignored by Git.

The local micromamba executable is downloaded using the
[official Windows instructions](https://mamba.readthedocs.io/en/latest/installation/micromamba-installation.html#windows).
Psi4's [binary distribution documentation](https://psi4.github.io/psi4docs/master/conda.html)
identifies conda-forge as its primary channel.

```powershell
$env:MAMBA_USE_SHARDED_REPODATA = 'false'
.\build\micromamba\Library\bin\micromamba.exe --no-rc create -y -r "$PWD\build\mamba-root" -p "$PWD\.chem-backends\psi4" -c conda-forge python=3.12 psi4 qcengine --strict-channel-priority
.\scripts\run_psi4_python.ps1 scripts\verify_chemistry_environment.py --psi4 --output build\chemistry-environment\psi4.json
```

For an exact reconstruction, replace the package specifications in the create
command with `--file docs\psi4-win-64.explicit.txt`. The explicit file records
the installed win-64 package URLs and checksums, avoiding a fresh solve.

Verified on 2026-09-05: Psi4 1.11, Python 3.12.14, QCEngine 0.51.0, and
QCElemental 0.51.0 completed the water HF/STO-3G check with energy
`-74.96292824697167` hartree and `success: true`. Raw evidence is in
`build/chemistry-environment/psi4.input.json`, `psi4.result.json`, and `psi4.json`.

The launcher sets DLL paths and scratch storage only for the command and restores
the caller's environment afterward. It defaults OpenMP to one thread.

## Verification scope and additional assets

The verification script checks a single FCC copper cell with ASE/EMT, a CIF
round trip, RDKit SMILES/InChI/MolBlock/SDF conversion, QCSchema construction, and
local STO-3G basis data for hydrogen and oxygen. The separate Psi4 check runs
fixed-geometry neutral singlet water at HF/STO-3G through QCEngine, using one
core, 1 GiB of requested memory, and a broad installation acceptance window
of -75.1 to -74.8 hartree. This is an installation smoke check, not an accuracy
benchmark or validation of general chemistry support.

JSON reports include installed distribution versions and available license
metadata. Psi4 input and output are saved alongside its report. Package license
metadata is an inventory, not a redistribution decision.

Large remote materials databases, licensed pseudopotentials (such as VASP
POTCAR), model weights, optional laboratory/workflow services, and unrelated
quantum engines are not required by these two initial calculation profiles.
They need a concrete adapter/profile and, where applicable, user credentials
before selecting assets. Basis Set Exchange and the installed toolkits provide
the local chemistry data needed for these checks.
