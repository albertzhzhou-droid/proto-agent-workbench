# Local capability probe — 2026-09-02

## Purpose

This read-only probe establishes what was actually available before selecting
the first chemistry adapters and compute backends. It is environment evidence,
not a compatibility or scientific-correctness claim.

## Probe result

The native Windows command environment exposed Python 3.11.15 and `uv`. The
project development environment created by `uv` uses CPython 3.13.3. The
following chemistry modules were not importable during the pre-install probe:

- RDKit
- QCEngine
- QCElemental
- ASE
- pymatgen

No `obabel`, `xtb`, `psi4`, `nwchem`, `orca`, or `dftb+` executable was found on
the active command path.

The project subsequently installed only its locked development tools. It did
not install a chemistry toolkit, calculator, quantum-chemistry program, or
scientific backend.

## Decision

No compute backend or adapter is approved by this probe. The repository remains
compiler-only. Selecting a backend requires a separate compatibility spike with
a real fixture, exact package and executable versions, license review, generated
input capture, output-unit checks, convergence evidence, expected value or
range, tolerance, and platform-variance policy.

The Windows native, WSL, and container routes also remain undecided. The trusted
runner described by RFC-0005 must not be enabled until its containment and
startup-revalidation gates are implemented and tested on the chosen route.

