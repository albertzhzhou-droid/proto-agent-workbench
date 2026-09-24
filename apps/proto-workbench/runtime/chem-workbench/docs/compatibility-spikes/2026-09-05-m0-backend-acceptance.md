# M0 backend acceptance spike — 2026-09-05

This spike closes the M0 gate in `Chem_Workbench_Tool_First_Implementation_Plan.md`
(Section 17) and the former "Immediate next gate" in
`implementation-status.md`: real read-only chemistry tooling was exercised
locally, versions and licenses were recorded, an execution route was chosen,
and two acceptance backends were pinned. Nothing here activates a Workbench
compute adapter, claims scientific accuracy, or grants redistribution.

## Environments

| Environment | Interpreter | Route | Inventory |
| --- | --- | --- | --- |
| Project `chemistry` extra | CPython 3.13.3 (`.venv`) | Windows native, `uv` locked | `build/chemistry-environment/python.json` |
| Quantum acceptance | CPython 3.12.14 (`.chem-backends/psi4`, conda-forge, Git-ignored) | Windows native, micromamba | `build/chemistry-environment/psi4.json`, `docs/psi4-win-64.explicit.txt` |
| XDL inspection | CPython 3.13.3 (`.chem-backends/xdl`, Git-ignored) | Windows native, `uv` locked | `build/xdl-environment/report.json` |

Pinned tool versions: ASE 3.29.0, QCEngine 0.51.0 (both environments),
QCElemental 0.51.1 / 0.51.0, RDKit 2026.3.6, pymatgen 2026.5.4,
Basis Set Exchange 0.12, NumPy 2.5.2, SciPy 1.18.1, spglib 2.7.0,
Psi4 1.11, XDL 2.1.0 (commit `6d60e8d`). Reproduction commands are in
[chemistry-environment.md](../chemistry-environment.md) and
[xdl-environment.md](../xdl-environment.md).

## Exercised checks (re-executed and reproduced on 2026-09-05)

| Check | Tool | Reproduced result | Evidence |
| --- | --- | --- | --- |
| FCC Cu (a=3.6) single point | ASE 3.29 / EMT | `-0.006688768685791047` eV/atom; max force `5.28e-15` eV/Å | `build/chemistry-environment/python.json` |
| Bundled `fcc-copper.cif` (a=3.6149) | ASE 3.29 / EMT | `-0.004952520525836501` eV/atom (4 sites, Cu only); max force `< 1e-14` | generated this session; pinned in `tests/test_chemistry_acceptance.py` |
| Bundled CIF fixtures parsed externally | pymatgen 2026.5.4 | Cu: 4 sites, a=3.6149; Si: 8 sites, a=5.431 | same |
| CIF / SDF round trips | pymatgen / RDKit 2026.3.6 | composition- and identity-preserving; water InChI `InChI=1S/H2O/h1H2` | `build/chemistry-environment/python.cif`, `python.sdf` |
| QCSchema construction | QCElemental 0.51.1 | water `AtomicInput` model builds; geometry shape (3, 3) | `python.json` |
| Local STO-3G data (H, O) | Basis Set Exchange 0.12 | both elements resolved locally, no network | `python.json` |
| Water HF/STO-3G single point | QCEngine 0.51 + Psi4 1.11 | `-74.96292824697167` hartree, `success: true`; acceptance window −75.1 … −74.8 | `build/chemistry-environment/psi4.input.json`, `psi4.result.json` |
| XDL read/export/re-read | XDL 2.1.0 (isolated env) | one-step `Wait` fixture survives XML and JSON round trips, uncompiled | `build/xdl-environment/` |

The numerical values are installation smoke references generated with the
pinned backends. They are not accuracy benchmarks, validated physics, or a
claim that any other method, element, or boundary condition is supported.

## Decisions recorded from this spike

[ADR 0006](../decisions/0006-m0-backend-pinning-and-execution-route.md) pins
the execution route and the two acceptance-backend candidates for the plan's
first two method profiles:

- `ase.emt.cu.scan.v1` candidate — ASE 3.29.0 EMT, Windows native, project
  `chemistry` extra (classical; copper-only admission unchanged).
- `qcengine.psi4.hf_sto3g.smoke.v1` candidate — QCEngine 0.51 + Psi4 1.11,
  isolated conda-forge environment, one core, 1 GiB requested, launcher-scoped
  DLL paths and scratch.

## Continuous enforcement

`tests/test_chemistry_acceptance.py` re-runs the light checks (RDKit identity
round trips, external parsing of the bundled CIF fixtures, the pinned EMT
reference for the bundled copper fixture, QCSchema construction, the full
Psi4 water calculation, and XDL isolation) whenever the environments are
present, and reports clean skips when they are not. In an environment that
claims backend support, a failure there is a failed acceptance gate.

## Explicitly unresolved

- The project license is still **pending**; no redistribution decision was made.
- XDL remains license-review-blocked for any linking or distribution (M10);
  the isolated environment is an inspection tool only.
- Large materials databases, licensed pseudopotentials, model weights, and
  device controllers were not installed and are not implied by this spike.
- QCEngine inside the project environment lists only `rdkit` as an available
  program; quantum execution happens exclusively through the isolated Psi4
  environment.
