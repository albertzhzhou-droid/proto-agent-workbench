# CI validation profiles

CI installs the committed `uv.lock` with `uv==0.12.3` and `uv sync --locked`.
It never assumes the developer's populated virtual environment, sibling Chem
checkout, or installed WSL engines exist. The declared Python minimum remains
3.10; basic CLI coverage runs on 3.10 and 3.12. Scientific lanes currently target
3.12, which is a tested deployment target rather than a claim that every optional
engine supports every Python version.

| Profile | Automatic environment | Installed extras | Scope |
| --- | --- | --- | --- |
| `base` | Windows, Python 3.10 and 3.12 | None | CLI, compiler, provenance, materials, security, mocked runtime adapters, dependency-free compute contracts, test-profile selector |
| `compute` | Windows, Python 3.12 | `compute`, `compute-research` (including JSON Schema validation) | NumPy/SciPy calculations, statistical inference, Biopython-based protein properties, protein comparison/study tests |
| `figures` | Ubuntu and Windows, Python 3.12 | `research-figures` | Bounded figure rendering and export contracts |
| `heavy` | Windows, Python 3.12, CPU | `compute`, `compute-models`, `compute-vision`, `compute-medical`, `compute-chem`, `compute-genomics` | Real model, image, SBML, population-genetics and cheminformatics tests using bounded fixtures |
| `linux-worker` | Ubuntu, Python 3.12 | None | Actual Linux process cleanup, cancellation and file-integrity behavior with controlled subprocesses; does not install or validate scientific engines |
| `xdl` | Explicit local invocation only | Existing isolated XDL environment | Real XDL parser/roundtrip tests; no device execution |

The Workbench job also creates the root `.venv` using `compute`,
`compute-research`, `compute-vision`, `compute-chem`, `chem-workbench`,
`research-figures` and `workbench`. Its Chem Python override
points at that environment. This is required by the existing Node integration
tests which spawn Python and execute RDKit, NumPy, SciPy, OpenCV and SymPy operators.
Electron bundle compilation is not an installer, GPU or live-model acceptance.
The job explicitly builds and checks the required Proto sidecars before desktop
resource-manifest generation; their executables are generated CI outputs, not
source-controlled prerequisites. CI uses the public typography profile.

The Workbench job checks the existing toy `designs/toggle_switch.proto` with
`proto-agent check --json` and compiles it to `build/toggle_switch.ir.json` only
after that check succeeds. This supplies the visualization regression fixture;
it does not replace the toy parts with a reviewed biological library. After the
mandatory and managed-study suites, CI builds the sidecars, then the desktop
bundles, then runs the offline baseline. That order supplies the renderer assets,
generated Chem UI overlay and runtime resources inspected by the offline tests.

The offline verifier runs `package-builder.test.mjs` and
`packaged-process-ownership.test.mjs` first with file concurrency 1. These suites
start the actual npm collector and PowerShell/.NET; isolating them avoids
competing with the wider suite's Python and compiler workers. The remaining
discovered test files run with concurrency 4, followed by the pinned local
TypeScript compiler. Every discovered file runs exactly once, and the existing
process deadlines and assertions remain in place. This ordering does not itself
establish a passing hosted run.

Git attributes preserve the exact bytes of digest-bound fixtures and copied
upstream licenses, including the Molstar and LM Studio notices. Newline conversion
must not be repaired by changing an expected digest or weakening byte comparisons.
For an attribute correction, verify the staged Git blob as well as the local file;
a correct working copy can coexist with an older normalized blob in the index.

Windows jobs canonicalize their existing temporary directory before tests.
Hosted runners can otherwise expose an 8.3 alias such as `RUNNER~1`, while strict
workspace APIs require the resolved path. Newly owned Node test fixtures also
resolve their temporary roots. Production checks continue to reject supplied
linked or noncanonical paths; an alias regression exercises that rejection.

Before the offline baseline or desktop build, that job runs `pnpm typecheck`,
checks the generated Python tool-contract snapshot, and runs named Node suites
for contracts, authorization, execution journal/kernel, IPC drift, turn completion,
owned-process termination, Chat abstention and receipt evidence. Any failure stops
the job. These mandatory suites are a bounded regression gate; they do not replace
the complete `node --test` suite or live-runtime acceptance. The Windows process
test first runs a direct-child-only negative control. Where the descendant survives
that control, it binds the spawned descendant to its parent and retains native
process handles before termination, then requires both handles to signal before
fixture cleanup. Hosts whose containment also kills the control descendant record
an explicit skip for this guarantee, because they cannot detect that mutation.

Direct imports are declared explicitly: `compute-vision` includes `tifffile`,
`compute-medical` supplies `nibabel` and `SimpleITK`, `compute-research` supplies
Biopython without installing the entire genomics stack, and `chem-workbench`
supplies SymPy and the vendored Chem runtime's JSON Schema dependency. The lock records exact resolved versions and artifact hashes;
the package metadata retains supported lower bounds for optional installations.

## Run and read the evidence

From the repository root, use a clean/disposable environment when validating a
profile. `uv sync` reconciles the selected environment, so a separate project
environment should be used when preserving an existing developer installation.

```powershell
$env:UV_PROJECT_ENVIRONMENT = 'build/ci-local-compute-env'
uv sync --locked --python 3.12 --extra compute --extra compute-research
uv run --locked --no-sync python -B scripts/run-test-profile.py --profile compute --report build/ci/compute-results.json
```

To inspect classification without importing optional dependencies:

```text
python scripts/run-test-profile.py --profile heavy --list
python scripts/run-test-profile.py --profile heavy --preflight
```

`scripts/run-test-profile.py` assigns every `tests/test_*.py` module to exactly
one profile. Missing, duplicate or newly unclassified modules fail before tests
start. Add a new file to the explicit mapping; do not make absence of its
dependencies an automatic pass. `--module NAME` supports a local bounded check,
but the report says `selected-modules`, never `full-profile`.

Each report includes selected modules, all profile memberships, actual dependency
versions, Python/platform, input-file digests, and separate passed/failed/error/skipped counts with
skipped test IDs and reasons. Exit codes are 0 for successful execution/planning,
1 for test failures, and 2 for an invalid profile or unsupported environment.
`planned` and `ready-not-run` are never execution success. A missing optional
dependency yields `unsupported-environment` with zero passed tests. Numerical,
heavy and runtime lanes fail if any selected test skips. Base filesystem privilege
skips remain explicit as `passed-with-skips`; skipped checks are not covered claims.

CI preserves its plan and result JSON even on failure. If setup fails before a
result exists, the plan is not evidence of execution. Keep failed reports when
retesting a revision; write the retest to a new report path.

The Workbench artifact retains the environment summary and named-suite TAP
reports; the complete offline verifier output is in the hosted job log. Current
job outcomes belong to the exact commit shown on the pull request. Source
publication checks, bounded core Chem tests, desktop compilation and optional
scientific/runtime acceptance remain separate claims. See the
[source layout](source-layout.md) and [Chem source guide](../CHEM_CLI.md) for the
dedicated publication workflow and external runtime requirements.

## WSL and other separately provisioned runtimes

`test_execution_wsl.py` in `base` tests adapter contracts using mocks. The Linux
worker lane tests Linux subprocess behavior. Neither validates a user's installed
WSL distribution, Docker daemon, bioinformatics databases or live engines.

Live WSL acceptance is a separate, deliberately invoked lane on a provisioned
machine. Follow [the bioinformatics environment guide](bioinformatics-environment.md)
and [the execution deployment guide](chat-execution-deployment.md), preserve the
engine environment locks, and run the existing `scripts/verify-bioinformatics-*.py`
or packaged execution verifier appropriate to that environment. Report missing
engines as unavailable. Do not attach a privileged self-hosted WSL runner to
untrusted pull requests, or infer a live WSL pass from the hosted mock/worker jobs.

For XDL, set `CHEM_XDL_PYTHON` to the existing isolated parser's executable, then
run the `xdl` profile and save its report. The profile fails preflight when that
runtime is absent. No external runtime is installed automatically by the profile
runner, and successful parser tests do not authorize wet-lab or device operations.

## Earlier local validation record

The following results describe the original profile-configuration work, before
the September 25 publication and hosted CI fixes. They remain historical local
evidence; they do not report the status of the current pull request.

A separate Windows Python 3.12 environment under `build/ci-validation/base-env`
was synchronized from the lock with only `certifi` and this project installed.
The selected CLI/protein/adapter/profile suite passed 75 tests with zero skips;
the subsequent dependency-free compute/profile check passed 15 tests with zero
skips. The final profile/maturity selector check passed 16 tests with zero skips.
These are overlapping selected suites, not full-profile runs. Earlier
failed reports were retained, including the clean-environment `_plain` NumPy
import defect that was fixed before the compute retest.

The same environment correctly reports the compute profile as unavailable when
NumPy, SciPy and Biopython are absent. The existing development environment passed
heavy dependency preflight only (`ready-not-run`). Python AST parsing, TOML/lock
extra consistency and the workflow YAML matrix were checked locally. That
original profile change did not run hosted GitHub jobs, a heavy scientific suite,
GPU jobs, live models or live WSL engines. Subsequent hosted CI runs exposed the
temporary-path, prerequisite-order and byte-preservation issues addressed above.
Read the current pull request's checks for the latest commit's actual outcomes;
this document does not certify that all current jobs have passed.
