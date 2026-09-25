# Published software test fixtures

This directory contains explicitly transformed publication copies. Historical
host paths were replaced with a synthetic fixture root, and the runtime file
inventory was reduced to the bound basis entry and an inert synthetic placeholder.
Dependent digest references, canonical bindings, fixture inventories and test pins
were recomputed. Geometry and coordinate number tokens were preserved.

These copies are software test inputs, not byte-exact historical observations,
execution approvals, installed-runtime inventories, or scientific acceptance
evidence. The upstream originals remain unchanged outside this repository.
`../../../development-manifest.json` records each original `sourceSha256` and
`sourceBytes` separately from the published digest, size and transformation.
Files retaining `.original` in their names identify the test loader role; any
transformation is recorded in that manifest rather than concealed by the name.

The historical upstream documentation follows for context. Its original path and
checksum descriptions refer to the upstream source bytes, not transformed copies.

---

# Refinement evidence fixtures

These frozen bytes make the product's pure tests independent of local build
directories and installed chemistry runtimes. `manifest.json` records every
original path, raw SHA-256 and size. The molecular fixture has 34 atoms with
stable atom IDs and explicitly bound isotope masses.

- `input.json` is the historical mass-bound D3BJ profile spec, retained as test
  input. It does not authorize a calculation.
- `artifacts/` contains the five exact directly referenced spec artifacts.
  Historical paths remain provenance strings; the test loader resolves them
  through the fixture manifest or copies them into a temporary test root.
- `parity/` retains historical installed D3 QCSchema shapes. These bytes do not
  constitute an observed energy-plus-gradient trace for a new run.
- `past_run/` contains an explicitly synthetic old 34-atom trajectory and mock
  native call records from the earlier pure integration tests. Tests ensure
  these historical records cannot acquire new-run coverage by being copied.

Fresh pipeline tests inject synthetic energies, gradients, native APIs and
authority observations. No fixture proves electronic method availability,
scientific accuracy, geometry optimization or a minimum. No native computation
is required to use this directory.
