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

# Retained source fixtures for product refinement contracts

These are byte-exact data copies. They are not new scientific observations or product acceptance evidence.

- `design-record.original.json`: the actual Qwen r1 saved Design record at `build/design-precision-final-20260913/qwen-r1/workspace/designs/73400285dd71e0c244504cd0d5818cff0a67f61bea9a6b250f57e2bad9831c68.json`, raw SHA-256 `01cbb4531ed64109c692216ad33d190def6b46961ac9faebd5831180c4eae9f3`. The tests select `/organic/candidates/2`, a 34-atom / 19-heavy-atom neutral organic candidate.
- `candidate-source.original.chem`: exact UTF-8 snapshot of that retained candidate's embedded source, raw SHA-256 `d4c2d79fd6020a5e8feea875b8d70318ce42754ae00cb8f132d340fba5f3298e`. Its original snapshot was retained in `build/refinement-subject-staged-20260913/fixtures/candidate-source.chem`.
- `mass-bound-input.original.json`: the prepared D3BJ gradient request from `build/refinement-d3bj-complex-gradient-20260913/input.json`, raw SHA-256 `a80480c324f41f43feb3dcea93a3b820aff5d1ec1ac851db60c412745155f577`. This is input data only. Runtime/basis/observation references are historical metadata; tests do not load scientific runtimes or claim their current availability.

Product replay tests retain temporary copies, rebind their artifact paths, run the actual product host graph/source verifier, and build new explicitly test-owned admission pins. Geometry, stable atom identity, original coordinate number tokens, electronic state and original default mass rows are preserved. No energies or gradients are added to these files. Planning tests separately create explicitly labelled synthetic energies/gradients solely to test acceptance and rejection logic; none are retained scientific results.

These fixtures are portable. Product modules and migrated tests do not import implementation code from `build` or adjust `sys.path`.
