# Chem shared workspaces and Design integration

Chem now uses the same application shell and Chat / Design / Compute switch as
Proto. Chat is leftmost. The edition selector, sidebar width, collapse behavior,
model settings and Anthropic typography come from the same shared components.
Structure is an inspector workflow inside Design, not a fourth top-level mode.

## Design

The central 3D canvas stays alongside contextual Source, Geometry, Calculate,
Refine, Evidence and Plan panels. Source compilation, molecule import, coordinate
revisions, comparison, candidate libraries, interface studies, project history
and XDL remain available. Switching panels within the same structure preserves
the camera, selected atoms and orbit state. Evidence preserves the active domain:
the original Design study record or the compiled-source ChemIR and review.

Design candidates and compiled-source structures retain their original data
identities. Opening Source or Geometry selects the compiled-source/Lab context;
it does not silently convert a selected Design candidate into a new source file.
The canvas names the object and retains its coordinate provenance.

## Computation and Chat

Twenty-one real local scientific operators include calibration, spectra, PCA,
analytical statistics, molecular datasets, substructure search, clustering,
formula properties, equation balancing and solution calculations. The original
ten operators support reaction networks, temperature
scans, rate fitting, molecular descriptors and comparison, supplied reaction
mapping, XYZ trajectories, organic candidates, ordered oxides and interface
models. Both Chat editions and Computation use the same canonical tool registry
and saved input/result/manifest artifacts. Chat-created runs can be reopened in
Computation. See [operators and scientific assumptions](chem-science-operators.md)
and [tool contracts and source attribution](chem-science-tools.md).
The Analysis, Statistics and Chemical Data sections are documented in
[Chem computation analysis](chem-computation-analysis.md).

The reaction viewer uses calculated concentration samples for its displayed
molecular populations and synchronized kinetics charts. Rate equations do not
produce atomistic trajectories; supplied multi-frame XYZ files have a separate
coordinate player. Simulation parameters and example mechanisms remain explicit.

## Local acceptance evidence

Evidence is retained under `build/chem-next-qa/` and `build/chem-science-qa/`:

- Exact live LM Studio selection, explicit load, completion and owned unload of
  `unsloth/qwen3.8-27b` / `Q4_K_M`: `model-baseline.json`.
- Real Qwen Chat schema discovery, reaction-tool execution and artifact readback:
  `chat-chemistry.json`. This validates integration, not model promotion or
  scientific answer accuracy. The retained response incorrectly labels one
  concentration rate as `s^-1`; the numerical tool receipt and charts use
  `mol L^-1 s^-1` and are the authoritative quantities.
- Ten-operator execution and readback: `bridge-acceptance.json`.
- Numerical analytic comparisons, equilibrium, recoverable rate fits and an
  unidentifiable parallel-rate counterexample: `numerical-acceptance.json`.
- Exact model status and missing/unloaded/wrong-quantization boundaries:
  `model-binding-live.json` and `test_chem_model_binding.py`.
- Desktop build and module hashes: `module-integrity.json`.

Browser acceptance covers both themes, Structure import and revision comparison,
domain-specific evidence, preserved 3D orbit, reaction timeline/chart alignment,
temperature curves and shared Chat-result history. The consolidated receipt is
`build/chem-next-qa/acceptance.json`.

The imported Chem scientific snapshot remains hash-identical. Its advanced
refinement workflow still requires recorded backend observations and an optimizer
binding; this upgrade does not make those absent prerequisites available. All
existing preparation, approval and calculation restrictions remain enforced.
