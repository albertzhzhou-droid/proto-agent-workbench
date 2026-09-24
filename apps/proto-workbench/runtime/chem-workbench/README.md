# Chem Workbench

Chem Workbench is a local, pre-alpha workspace for compound design, conditional
interface models, and inspectable molecular calculations. Design Studio generates
organic candidates and ordered multication oxides, displays real 3D geometry,
and runs electrode/electrolyte, catalyst/reactant, and solid/liquid response
models. It can compare supplied candidate-bound scenarios under matched
conditions and export the complete raw study for verified reopening.

Structure Studio provides source editing, imports, coordinate revisions, and
approved calculations for admitted complex organic molecules. The `.chem`
compiler records declarations and calculation intent; compilation itself does
not run those numerical workflows.

## Open the Workbench UI

From this repository on Windows:

```powershell
.\scripts\start-workbench.ps1
```

Open <http://127.0.0.1:8765>. Keep the terminal running; use Ctrl+C to stop.
Use `-m chem_workbench.web --port 8766` with the project Python if the default
port is occupied. A configured Windows Electron preview is also built by `scripts/package_desktop.py`;
see [desktop usage](docs/desktop-preview.md).

In **Design Studio**, choose **Run direct workflow** to use the study settings
without a model, or **Design from prompt** to let the configured local model
select a registered workflow. Organic design uses catalog or supplied mapped
scaffolds and MW/logP/TPSA screening. Inorganic design builds charge-neutral,
ordered 40-atom A2BB'O6 cells and ranks their tolerance-factor distance. Inspect
candidate geometry, numerical tables, module traces, and interface curves.

Interface runs use an explicitly illustrative scenario or exact supplied
parameters. **Compare supplied interface scenarios** requires saved candidate
pairs, a comparison objective, and two to four supplied scenarios. Common
parameters can produce tied responses; these calculations do not establish
measured activity or intrinsic material performance. Use **Export study** to
save the raw inputs, candidate identities, parameters, results and evidence
hashes, then **Open study** to verify and reopen that file.

The all-English **Structure Studio** supports example selection, local `.chem` text import,
source editing, compilation, source-linked diagnostics, ChemIR/review downloads,
and a real interactive 3D coordinate viewport. Crystals use the admitted CIF
import with supplied attachment bytes; molecules use explicitly labeled RDKit
ETKDGv3 conformers. Missing or unconstructed coordinates remain unavailable.
Rotate, zoom, pick atoms, measure Cartesian distances, toggle representations
and cell edges, preview candidate scales, or export geometry/PNG. Example
structures are visibly labeled fixtures. PNGs are also saved under
`build/ui-exports/` by content hash for reliable local reopening.

For a real molecular calculation, open the aspirin or caffeine example, compile,
and choose **Organic molecule · Psi4 HF / STO-3G**. Review the generated conformer,
prepare the exact plan, approve it, and run. The admitted profile handles bounded
neutral singlet organic molecules with complete stereochemistry and performs
HF/STO-3G single-point energy calculations. Water HF/STO-3G and copper ASE/EMT
remain separate installation/regression profiles. Cancellation, retained job
history, numerical results, and evidence export are available.

In Structure Studio, Ctrl+Enter compiles. Editing invalidates previous geometry, proposals and
outputs immediately. Failed compilation disables downloads. Editor changes
are saved as immutable project revisions with **Save revision**. Unsaved replacements
and window closure require an explicit discard decision. CIF attachments are
explicit text inputs; the service does not resolve arbitrary host paths. The
service binds only to 127.0.0.1 with exact Host and same-origin checks. Source
and attachment text each have a 200 KB limit; ordinary API requests have a
512 KiB limit. Explicit PNG exports accept at most 2 MB decoded image data.

The configured Electron preview uses existing installed Python/scientific
runtimes. It does not establish clean-machine installation or relocation;
see the [portable Windows plan](docs/portable-windows-plan.md).
Current implementation and evidence are tracked in the
[Design and interface stage](docs/design-and-interface-stage.md),
[implementation status](docs/implementation-status.md), and
[next steps](docs/NEXT_STEPS.md). September 5 acceptance reports describe earlier
increments and do not establish current model promotion.

## Local model selection

Model requests use LM Studio exclusively at `http://127.0.0.1:1234`.
**Gemma 4 E4B is the experimental configured default.** Load the selected key
in LM Studio and refresh model status. Set `CHEM_MODEL_KEY` before starting the
Workbench to choose another explicit allowlisted model; there is no silent
fallback and direct workflows remain available without the provider.

| Model key | Current role |
| --- | --- |
| `google/gemma-4-e4b` | Experimental configured default |
| `google/gemma-4-e2b` | Explicit preserved baseline selection |
| `google/gemma-4-26b-a4b` | Allowlisted evaluation candidate |
| `qwen3.8-27b@q4_k_m` | Allowlisted evaluation candidate |

For example, select the preserved baseline for this Workbench process:

```powershell
$env:CHEM_MODEL_KEY = "google/gemma-4-e2b"
.\scripts\start-workbench.ps1
```

As of September 12, formal Qwen acceptance remains open. The first Design run
passed all 40 positive workflows, then ended after 47/130 attempted cases when
the user interrupted the model service. Its 45 completed rows, two errors and
83 unrun rows remain retained. The next full run,
`build/qwen-design-formal-20260912a-r1`, completed with 130/130 valid first-attempt
schemas, 40/40 completed positive workflows and 90/90 independently correct
negative responses. Its 20 separate runtime fault cases and identity bracket
also passed. This result binds the earlier frozen source `921019a9...`; the
[visual upgrade](docs/visual-workbench-stage.md) is now integrated, with scoped
actual browser evidence for interface results, exact exports, full-study
reopening and geometry revision binding. Its full regression rerun passed all
809 tests in 574.48 seconds. New computation result UI and final source/package
acceptance remain open.
Qwen has not been promoted.
Context, decoding, retries, and model identity belong to each frozen evaluation
record. See the [current stage record](docs/design-and-interface-stage.md) for
the evidence and remaining gates. The
[September 10 evaluation](docs/model-stage-2026-09-10.md) and
[September 5 comparison](docs/model-evaluation-2026-09-05.md) are historical
observations, not current acceptance claims.

The model can select registered design modules, inspect structures, derive
display geometry, or propose supported calculations. The host validates scope,
exact arguments and source bindings, records actual tool results, and stops
within its bounded workflow. A model answer grants no execution authority.
Structure calculations require explicit plan approval; Design Studio runs use
the user's explicit bounded Run action. Registered contracts reject missing or
unsupported required inputs. Model interpretation of the requested scope remains
unverified and is tested separately from host enforcement.

## Current CLI scope

| Command | Current behavior |
| --- | --- |
| `chem check` | Parse and validate supported declarations |
| `chem compile` | Emit deterministic ChemIR; optional `--resolve-imports` for bounded CIF references |
| `chem review-compile` | Build an unsigned self-consistency review packet |
| `chem inspect` | Validate and summarize supported local artifacts |
| `chem capabilities` | Inspect the package-owned static registry |
| `chem probe` | Perform bounded read-only CIF probing |
| `chem convert` | Import the supported explicit-P1 CIF subset with a loss report |
| `chem propose-cu`, `propose-water`, `resolve`, `prepare` | Prepare bounded plans and review contexts; the named proposal/prepare CLI wrappers cover water and copper |
| `chem approve`, `run --intent` | Explicit local approval and supervised execution of an admitted plan |
| `chem compute`, `fetch` | Unavailable generic commands |

The checkout has advanced beyond the original descriptor-only 0.1.0a2 slice.
Its registry is no longer empty. Surface/interface declarations in `.chem`
remain representation-only; separate Design Studio records drive the implemented
candidate generation and conditional numerical interface modules. Complex
molecular calculation and Design workflows are exposed in the UI and local API;
there is no generic `chem compute` gateway. See [implementation status](docs/implementation-status.md),
[the implementation plan](Chem_Workbench_Tool_First_Implementation_Plan.md), and
[the current design stage](docs/design-and-interface-stage.md).

## Development

Python 3.11 or later is required. Package names: distribution `chem-workbench`,
import `chem_workbench`, command `chem`.

```powershell
uv sync --locked --extra chemistry
.\scripts\verify.ps1
```

The gate runs Ruff formatting/lint, strict mypy, and the complete pytest suite.
Optional backend tests skip if their environments are missing; a skip must not
be presented as proof of backend support. Environment setup is described in
[chemistry environment](docs/chemistry-environment.md) and
[XDL environment](docs/xdl-environment.md).

```powershell
chem check examples\molecules\aspirin.chem
chem compile examples\molecules\aspirin.chem --emit chemir
chem capabilities --format text
```

## Evidence and trust

ChemIR and review artifacts use closed, versioned schemas and typed hashes.
An unsigned review packet proves only checked internal bindings. It does not
establish origin, scientific correctness, approval, safety, or permission to
publish. Capability validity is separate from package-owned registration and
activation. Conversion loss eligibility does not grant publication authority.

See [security and trust](docs/security-and-trust.md),
[conformance profiles](docs/conformance-profiles.md), and the
[dependency and license register](docs/dependency-license-register.md).

## License

This project's original code is licensed under the [MIT License](LICENSE), selected
by the owner on September 5, 2026. Third-party tools, scientific data, model
weights and runtimes retain their own licenses; see the dependency register.
