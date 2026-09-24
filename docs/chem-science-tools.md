# Chemistry tools in the shared scientific workflow

Chem Computation, Chem Chat and Proto Chat use one `ChemScienceService`. The
service dispatches fixed JSON operators to `runtime/chem-integration/chem_science.py`
with the existing local Chem Python environment. The original Chem scientific
snapshot is imported through `PYTHONPATH`; its source is not rewritten.

## Operators and discovery

`science_catalog` searches the canonical registry. `science_run` accepts one of
the discovered `chemistry.*` names and its exact schema. The registry contains:

- `chemistry.catalog`: current operator schemas, examples and dependency versions.
- `chemistry.simulate_reaction_network`: deterministic mass-action integration.
- `chemistry.scan_reaction_temperature`: explicit Arrhenius parameter sweeps.
- `chemistry.fit_reaction_rates`: fit declared rates to supplied observations.
- `chemistry.analyze_molecule`: sanitized identity, descriptors and conformers.
- `chemistry.compare_molecules`: fingerprint, scaffold and descriptor comparison.
- `chemistry.inspect_reaction_smiles`: mapped reaction and balance inspection.
- `chemistry.parse_xyz_trajectory`: parse supplied coordinate trajectories.
- `chemistry.organic_candidates`, `chemistry.inorganic_candidates` and
  `chemistry.simulate_interface`: the original Chem design and interface engines.
- `chemistry.history`, `chemistry.read`: shared saved run evidence.
- `chemistry.guidance`: the concrete chemical research procedure described below.

Aliases such as `chem.catalog`, `rdkit.analyze` and `openscience.chemistry` resolve
to the same canonical implementation and repeated-call signature. They do not
create additional tools. Chemistry availability is separate from the generic
Python/R code sandbox: a working fixed operator does not imply arbitrary-code
execution is configured.

## User-selected model baseline

The development preference is **Qwen 3.8 27B Q4_K_M**, with the exact live LM
Studio provider key `unsloth/qwen3.8-27b` and quantization `Q4_K_M`. Chat preserves
an explicit current selection; otherwise it selects that precise discovered
model. It never substitutes the Q8 or obliterated variants, and never invents
an inventory or loaded instance from this preference. Loading and connection
continue through the existing LM Studio provider at `http://127.0.0.1:1234`.

The legacy Chem Design controller uses the same exact baseline through the
separate `runtime/chem-integration/model_binding.py` launcher adapter. It reads
the native inventory on every status request and forwards the real loaded
instance ID to the original strict-JSON controller. Missing models, unloaded
instances, wrong quantization, ambiguous entries and server failures remain
unavailable. The launcher records the adapter hash and configured preference;
it does not persist an online claim or modify the imported controller source.

## OpenScience adaptations

Public source was reviewed at OpenScience commit
`ef6156f8fe5a1e40bd7889707e7abdba9ea1da80`:

- [SMILES validation](https://github.com/synthetic-sciences/openscience/blob/ef6156f8fe5a1e40bd7889707e7abdba9ea1da80/backend/cli/skills/chemistry/smiles-validation/scripts/validate.py): sanitize before interpretation, retain failure diagnostics, compare actual molecular identities.
- [Molecular properties](https://github.com/synthetic-sciences/openscience/blob/ef6156f8fe5a1e40bd7889707e7abdba9ea1da80/backend/cli/skills/chemistry/rdkit/scripts/molecular_properties.py): retain canonical identity alongside descriptors and state the meaning of filtering thresholds.
- [Molecular visualization](https://github.com/synthetic-sciences/openscience/blob/ef6156f8fe5a1e40bd7889707e7abdba9ea1da80/backend/cli/skills/chemistry/molecule-visualization/SKILL.md): construct and identify coordinates before rendering and expose the representation used.

The callable `chemistry.guidance` adapts these steps to the local fixed operators,
then adds explicit kinetic assumptions, conservation checks, residual inspection,
and artifact citations. Source links and the pinned revision are returned with
the guidance. Numerical integration and fitting use the worker's declared
scientific dependencies; they are not described as OpenScience numerical solvers.
Per-component source and license details belong in `apps/proto-workbench/THIRD_PARTY_NOTICES.md`.

Population playback visualizes the solved concentrations. It is not an atomistic
reaction pathway or a transition-state calculation. Uploaded XYZ coordinates are
identified as supplied trajectories. Existing quantum workflow approvals remain
in Chem Design; no tool in this new bridge can approve or execute a laboratory
procedure.

## Desktop and source-preview API

Desktop: `window.workbench.chemScience.request(request)`.
Source preview: `POST /__proto/chem-science`, JSON body, exact loopback same origin.

```json
{"action":"run","operator":"simulate_reaction_network","input":{"example":"reversible","points":121},"runId":"a client-generated UUID","timeoutMs":120000}
```

Other actions are `catalog`, `history` (optional `limit`), `read` and `cancel`
(both require `runId`). `runId` may be omitted when cancellation is managed through
Chat's signal. Responses contain `ok`, optional `data`, and structured `error`.
Execution errors and cancellation retain a failed run receipt where execution
had begun. History returns metadata with `summary:true`; `read` returns the
complete input and result.

The host enforces a 2 MiB request limit, 32 MiB worker output limit, at most three
active runs and a maximum 120-second per-run deadline. Cancellation terminates
only the owned worker process tree. Operator names and request actions are
strictly validated; arbitrary shell commands, paths and approval dispatch are
not admitted.

## Reproducible evidence

Each run uses `build/chem-science/<UUID>/input.json`, `result.json` and
`manifest.json`. Receipts record status, timestamps, input and result SHA-256
hashes, worker source identity and dependency provenance. Existing UUIDs cannot
overwrite a prior run. Readback checks file type, workspace containment and
hashes. A receipt left running after its host exits is reported as interrupted.

Chat receives a bounded summary containing the run ID, scalar evidence,
array counts/endpoints and full artifact references. `chemistry.read` locates a
saved run; `workspace_read` with offset/limit retrieves exact complete JSON fields.
The visual Computation workspace reads the same complete results for playback,
charts and export.

## Validation

`tests/chem-science-bridge.test.mjs` runs the actual Python worker and covers
operator discovery, kinetic conservation, immutable readback, hash corruption,
invalid SMILES, timeouts, cancellation, argument boundaries, canonical aliases,
artifact summaries and exact model preference. The existing
`tests/research-tools.test.mjs` additionally runs the real Proto computation
backend and checks frozen module selection. These tests do not constitute
scientific validation of supplied mechanisms or a clean-machine installer test.

`tests/test_chem_model_binding.py` covers exact Qwen selection, Q8/other-provider
rejection, unloading, malformed inventory and an unreachable server. The
ten-operator live bridge sweep, including full readback, is recorded in
`build/chem-science-qa/bridge-acceptance.json`. Worker numerical methods and their
separate scientific tests are documented in [Chemistry operators](chem-science-operators.md).
