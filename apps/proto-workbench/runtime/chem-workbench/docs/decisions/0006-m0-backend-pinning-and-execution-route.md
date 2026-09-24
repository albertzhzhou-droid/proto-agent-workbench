# ADR 0006: M0 backend pinning and execution route

**Status:** Accepted for the unreleased alpha increment
**Date:** 2026-09-05
**Depends on:** [ADR 0004](0004-canonical-decimals-and-structure-import.md),
[ADR 0005](0005-resolved-structure-imports-in-compilation.md)
**Evidence:** [2026-09-05 M0 backend acceptance spike](../compatibility-spikes/2026-09-05-m0-backend-acceptance.md)

## Context

The plan's M0 gate requires real read-only compatibility results, exact
version and license records, an execution-route choice, and two pinned
scientific acceptance backends before any compute runner work begins. The
local environment now provides that evidence: a locked Windows-native
`chemistry` extra (ASE 3.29, QCEngine 0.51, QCElemental 0.51.1, RDKit
2026.3.6, pymatgen 2026.5.4, Basis Set Exchange 0.12), an isolated conda-forge
Psi4 1.11 environment, and an isolated XDL 2.1.0 inspection environment.

## Decision

**Execution route: Windows native.** The project environment runs chemistry
tooling directly on Windows; the quantum acceptance path runs in the separate
`.chem-backends/psi4` conda-forge environment through the launcher that scopes
DLL paths, scratch storage, one OpenMP thread, and restores the caller's
environment. WSL and containers are recorded alternatives, not equivalents,
and stay untested.

**Two acceptance-backend candidates are pinned for the plan's first two method
profiles:**

| Planned profile | Pinned candidate | Environment |
| --- | --- | --- |
| `ase.emt.cu.scan.v1` | ASE 3.29.0 EMT | project `chemistry` extra, Windows native |
| `qcengine.psi4.hf_sto3g.smoke.v1` | QCEngine 0.51.0 + Psi4 1.11 | `.chem-backends/psi4`, one core, 1 GiB requested |

Generated smoke references are recorded in the spike and enforced by
`tests/test_chemistry_acceptance.py`: Cu a=3.6 EMT
`-0.006688768685791047` eV/atom; the bundled `fcc-copper.cif` fixture
`-0.004952520525836501` eV/atom; water HF/STO-3G `-74.96292824697167` hartree
inside the −75.1…−74.8 installation window. These are installation checks,
not accuracy claims, and the copper-only EMT admission from RFC-0006 is
unchanged.

**Acceptance enforcement follows the plan's rule.** The acceptance tests run
for real whenever the environments are present and report clean skips when
they are not; an environment claiming backend support fails the gate on any
skip-turned-failure. The ordinary core gate (`scripts/verify.ps1`) is
unchanged and stays green without the chemistry extra.

**No compute capability is registered.** Pinning a backend for acceptance
does not create a `ComputeAdapter`, a runner, or an execution path. The
static registry still contains exactly the two CIF format capabilities. The
water and copper executions in this ADR were run by verification scripts, not
by the Workbench.

**XDL stays quarantined.** The isolated XDL 2.1.0 environment is an
inspection tool with no import path from the Workbench package. Its
AGPL-related and additional terms remain review-blocked for linking or
distribution (M10); the acceptance test asserts the Workbench environment
does not import it.

## Consequences

- The M0 exit criteria are met: version/license inventories exist
  (`build/chemistry-environment/*.json`, `build/xdl-environment/report.json`,
  the dependency register pointers), real compatibility results are recorded,
  the route is chosen, and both acceptance backends are pinned.
- The next construction gate becomes the plan's M2/M3 territory: a tool
  gateway with host-owned invocation context, policy and approval records,
  and a supervised runner — before any Workbench-authorized calculation runs.
- The project license decision and the XDL distribution review remain
  explicitly blocked items owned by the project owner.
