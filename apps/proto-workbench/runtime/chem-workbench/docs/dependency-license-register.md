> Current September 5 addendum: the owner selected MIT. The generated
> [installed-component manifest](../third_party/manifest.json) and adjacent
> notice files supersede the compiler-only inventory below. The build backend
> is pinned to Hatchling 1.32.0. The desktop stage retains Electron/Chromium
> licenses; scientific runtimes and model weights are not redistributed.
> Historical counts and undecided-license statements below describe the earlier alpha.

# Dependency and license register

> The 2026-09-02 tables below describe the original compiler environment.
> The optional chemistry extra and isolated Psi4 environment added on 2026-09-05
> are documented in [chemistry-environment.md](chemistry-environment.md), with
> separate installed-version and license-metadata reports; the XDL inspection
> environment is documented in [xdl-environment.md](xdl-environment.md). The
> M0 evidence trail is in the
> [2026-09-05 backend acceptance spike](compatibility-spikes/2026-09-05-m0-backend-acceptance.md)
> and [ADR 0006](decisions/0006-m0-backend-pinning-and-execution-route.md).
> These additions do not change the earlier redistribution decisions.

**Register date:** 2026-09-02  
**Project version:** `chem-workbench 0.1.0a2`  
**Status:** Alpha inventory; not a redistribution approval

## Scope and evidence

This register is limited to evidence available in the repository and its local
development environment:

- direct requirements and version ranges in `pyproject.toml`;
- exact resolutions and dependency edges in `uv.lock`; and
- installed distribution metadata and license files under `.venv`.

No package index, upstream repository, or external legal source was consulted.
License identifiers below are transcribed from installed `License-Expression`,
legacy `License`, or license classifier metadata. Where those fields are
incomplete, the installed license-file text is described separately. This is an
engineering inventory, not legal advice or a conclusion that redistribution is
permitted.

Status meanings:

- `RECORDED`: the installed distribution reports a specific license expression
  or other unambiguous local metadata, and its declared license file is present.
- `REVIEW_REQUIRED`: local metadata is missing, ambiguous, or presents multiple
  licensing surfaces that need an owner review before redistribution.

## Project and build-system status

| Component | Declared or locked version | Local license evidence | Status |
| --- | --- | --- | --- |
| `chem-workbench` | `0.1.0a2` | No project `license` field, license classifier, `License-Expression`, `License`, or `License-File`; the repository has no `LICENSE` file. | `REVIEW_REQUIRED` — project license is **PENDING**. Repository access and local installation do not grant redistribution permission. |
| `hatchling` | Declared build requirement `>=1.27`; current wheel records generator `hatchling 1.32.0`; no exact entry in `uv.lock` | The isolated build environment is not retained in `.venv`, so no installed license file was available for this register. | `REVIEW_REQUIRED` — pin and inspect the build backend before a release or redistributed build. The recorded generator identifies this alpha build but does not close the future range. |

The build-system requirement is outside the runtime/development resolution
recorded by the current lockfile. It is therefore not included in the lock
consistency pass below.

## Runtime dependency closure

`jsonschema>=4.23,<5` is the only direct runtime dependency. The remaining rows
are its locked transitive closure. `typing-extensions` is a runtime dependency
of `referencing` only when `python_full_version < '3.13'`; it is nevertheless
present in the development environment through `mypy`.

| Package | Relationship | Exact lock/install version | Locally reported license evidence | Status |
| --- | --- | --- | --- | --- |
| `jsonschema` | Direct runtime; also listed in the `dev` group | `4.26.0` | `License-Expression: MIT`; installed `COPYING` | `RECORDED` |
| `attrs` | Transitive via `jsonschema` and `referencing` | `26.1.0` | `License-Expression: MIT`; installed `LICENSE` | `RECORDED` |
| `jsonschema-specifications` | Transitive via `jsonschema` | `2025.9.1` | `License-Expression: MIT`; installed `COPYING` | `RECORDED` |
| `referencing` | Transitive via `jsonschema` and `jsonschema-specifications` | `0.37.0` | `License-Expression: MIT`; installed `COPYING` | `RECORDED` |
| `rpds-py` | Transitive via `jsonschema` and `referencing` | `2026.6.3` | `License-Expression: MIT`; installed `LICENSE` | `RECORDED` |
| `typing-extensions` | Conditional runtime transitive via `referencing` on Python `<3.13`; also development transitive via `mypy` | `4.16.0` | `License-Expression: PSF-2.0`; installed `LICENSE` | `RECORDED` |

No optional `jsonschema` format extras are declared by this project, so their
extra-only dependencies are not part of the locked runtime closure.

## Development-only dependency closure

These packages are required only by the `dev` group or are transitive
dependencies of that group. They are not declared runtime dependencies.

| Package | Relationship | Exact lock/install version | Locally reported license evidence | Status |
| --- | --- | --- | --- | --- |
| `mypy` | Direct development dependency | `1.20.2` | `License-Expression: MIT`; installed top-level `LICENSE` states MIT; a second installed `mypy/typeshed/LICENSE` states Apache License 2.0 for bundled typeshed content | `REVIEW_REQUIRED` — retain and review both license surfaces for redistribution. |
| `mypy-extensions` | Transitive via `mypy` | `1.1.0` | `License-Expression: MIT`; installed `LICENSE` | `RECORDED` |
| `pathspec` | Transitive via `mypy` | `1.1.1` | No `License-Expression` or legacy `License`; classifier reports `Mozilla Public License 2.0 (MPL 2.0)` and installed `LICENSE` begins “Mozilla Public License Version 2.0” | `RECORDED` from classifier and installed file |
| `librt` | Conditional transitive via `mypy` when the implementation is not PyPy | `0.15.0` | `License-Expression: MIT`; installed `LICENSE` | `RECORDED` |
| `pytest` | Direct development dependency | `9.1.1` | `License-Expression: MIT`; installed `LICENSE` | `RECORDED` |
| `colorama` | Conditional transitive via `pytest` on Windows | `0.4.6` | No `License-Expression` or legacy `License`; classifier reports only `BSD License`; installed `LICENSE.txt` contains a three-clause BSD-style grant | `REVIEW_REQUIRED` — exact SPDX mapping is not reported by installed metadata. |
| `iniconfig` | Transitive via `pytest` | `2.3.0` | `License-Expression: MIT`; installed `LICENSE` | `RECORDED` |
| `packaging` | Transitive via `pytest` | `26.3` | `License-Expression: Apache-2.0 OR BSD-2-Clause`; installed `LICENSE`, `LICENSE.APACHE`, and `LICENSE.BSD` | `RECORDED` |
| `pluggy` | Transitive via `pytest` | `1.6.0` | Legacy `License: MIT`; MIT classifier; installed `LICENSE` | `RECORDED` |
| `pygments` | Transitive via `pytest` | `2.21.0` | `License-Expression: BSD-2-Clause`; installed `LICENSE` and `AUTHORS` | `RECORDED` |
| `ruff` | Direct development dependency | `0.16.5` | `License-Expression: MIT`; installed `LICENSE` | `RECORDED` |

The development group repeats `jsonschema` directly, but that does not create a
second resolved package; it uses the same locked runtime version recorded above.

## Lock and installed-environment consistency check

A local read-only check normalized distribution names, compared every
`uv.lock` package/version pair with installed distribution metadata, and tested
each declared runtime and development requirement against its locked version.

| Check | Result |
| --- | --- |
| Lock format | version `1`, revision `3`, Python requirement `>=3.11` |
| Locked distributions | `18` total: the editable project plus `17` third-party packages |
| Installed distributions in `.venv` | `18` |
| Locked but not installed | `0` |
| Installed but not locked | `0` |
| Lock/install version mismatches | `0` |
| Declared runtime/dev requirements missing from lock or outside their specifier | `0` |
| Overall result | **PASS** |

This result establishes consistency for the current local runtime/development
environment. It does not validate unselected extras, other platform branches,
future lock resolutions, or build-isolation dependencies such as Hatchling.

## Dependencies not yet selected

No chemistry parser or toolkit, computational chemistry backend, workflow
engine, structure database client, licensed chemistry dataset, or bundled
scientific reference data has been selected or declared. In particular, this
register does not authorize or imply use of RDKit, Open Babel, QCEngine,
QCElemental, ASE, pymatgen, xTB, Psi4, NWChem, ORCA, DFTB+, or any data source.

Before adding any such component, record its exact version or data snapshot,
source, license and notice files, redistribution constraints, optional-feature
boundary, and whether it executes locally or calls a network service. Scientific
acceptance and provenance checks remain separate from license review.

## Release gate

Before any public or third-party redistribution:

1. obtain an owner-approved project license and add authoritative project
   metadata and license text;
2. pin and inspect the build backend used for the release artifact;
3. resolve every `REVIEW_REQUIRED` row and assemble required third-party
   notices from the actual distributed artifacts; and
4. regenerate this register from the final lockfile and release environment.

## September 5 Structure Studio viewer

The local UI now vendors 3Dmol.js 2.5.5 (BSD-3-Clause). Unlike the older
compiler-only inventory above, this increment consulted the official npm
registry and upstream API documentation. The archive was integrity-checked;
license copies, exact asset hash and source URL are in
[viewer-dependency.md](viewer-dependency.md). No project redistribution
permission or model-weight redistribution approval is inferred.
