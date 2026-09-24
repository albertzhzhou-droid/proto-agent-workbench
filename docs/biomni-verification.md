# Biomni computing verification

Verified locally on Windows on 2026-09-18 (America/Toronto), using Python
3.12.14, NumPy 2.2.6, SciPy 1.15.3 and Node 24.20.0. This is local source,
desktop-build and sidecar evidence. No new installer, hosted CI result or
LM Studio model-driven acceptance run is claimed.

## Fourth port batch verification (2026-09-19)

The forty-seven remaining "feasible" deferrals from the prior accounting were
completed: thirty-nine new offline tools plus the reclassification of eight
items whose real blocker is model-weight download or an external executable
(five to a new `deferred_model_download` status, three to existing statuses).

| Check | Result |
| --- | --- |
| Catalog | 119 offline tools; all examples validate against their schemas and execute through run_compute with synthetic fixtures. |
| New modules | `compute_popgen.py` (msprime demographies, cooler enhancer-promoter/TADs, cobra mass-action perturbation, DDR network with Brandes betweenness, pure-Python affine-gap Cas9/CRISPR alignment), `compute_medical.py` (SimpleITK rigid/affine/BSpline registration with geometry-centered initialization, batch registration, similarity metrics, preprocessing, NIfTI modality split, marching-cubes face surface, per-voxel DWI ADC), `compute_histology.py` (frame tracking, calcium imaging, myofiber/cell/microbial segmentation, cytoskeleton order parameter, tissue optical flow, cell-cycle heuristics, motility clustering, mitochondrial skeleton, immune-cell flow behavior, CNS/IHC/thrombus/aorta/cornea/multiplex/microCT/amyloid/rhod2 quantification, gel ROI detection, FFT ciliary beat frequency, Pearson/Manders colocalization). |
| List file inputs | Frame sequences and batch registration consume per-field lists of workspace files with per-entry provenance claims (`file:<field>[i]`). |
| Upstream defects corrected | Corner-origin transform coupling in registration (geometry-centered init), channel-axis inversion in multiplex quantification, PIP-collapse disclosure in deep-VI (batch 3), NP-hard NaN guards in colocalization, NumPy scalar coercion before result serialization. |
| Python complete suite | 374 tests: 370 passed, 4 pre-existing dependency skips. |
| Node compute suites | 11/11 including real owned-process MCP transport and all 119 browser preview replays recorded from the real engine. |
| Node complete suite | 826/826 passed (the previously intermittent owned-process stdio test also passed this round). |
| TypeScript typecheck | Passed. |

## Third port batch verification (2026-09-18)

Heavy optional dependencies were actually installed and exercised (network to
PyPI was intermittently flaky; installs succeeded on retry): torch 2.13 CPU,
rdkit, python-libsbml, pykalman, scikit-learn, statsmodels, networkx, h5py,
scikit-image, opencv-python-headless, cobra, msprime, cooler, scanpy, nibabel,
SimpleITK, trackpy, Viennarna 2.7.2, and biopython. New optional dependency
groups (`compute-models`, `compute-vision`, `compute-chem`, `compute-genomics`)
are declared in pyproject.toml and the lockfile was regenerated.

| Check | Result |
| --- | --- |
| Catalog | 80 offline tools; all 80 examples validate against their schemas and execute through run_compute with real fixtures. |
| Binary file inputs | Nine file-backed tools read workspace-contained files (FCS/PDB/PNG/chain) with extension whitelists, size caps, and `file:` hash entries in the manifest; traversal paths are rejected by the existing path guards. |
| Python complete suite | 358 tests: 354 passed, 4 pre-existing dependency skips. |
| Batch-3 tests | 18 tests in `tests/test_compute_batch3.py`: FCS parser round-trip, four flow tools against a synthetic 7-channel FCS, PDB Kabsch RMSD/regions, chain liftover (forward/reverse/gap), NJ phylogeny clustering, SBML round-trip through libsbml, seeded torch fine-mapping, Kalman decoding metrics, image tools on synthetic PNGs, aspirin descriptors, ViennaRNA folding, connector gating/host-allowlist/program-whitelist/DDInter data-lake. |
| Node compute suites | 11/11 including real owned-process MCP transport and all 80 browser preview replays recorded from the real engine. |
| TypeScript typecheck | Passed. |
| Remote subsystem | 12 connector-gated tools; every connector disabled by default in `connectors/remote_apis.json`; `proto_remote_run` is network-classified (never auto-approved) and a write-effect tool; CLI `remote catalog/run` wired. |
| Known failure | The pre-existing intermittent `tests/owned-process.test.mjs:248` Windows stdio test remains the only Node failure; it also passed on an earlier run in this same session, confirming flakiness rather than regression. |

## Second port batch verification (2026-09-18)

Fifty additional offline tools were ported (five new Python modules:
`compute_sequence`, `compute_simulation`, `compute_assay`, `compute_clinical`,
`compute_omics`), growing the catalog from 15 to 65 tools.

| Check | Result |
| --- | --- |
| Python complete suite | 340 tests: 336 passed, 4 skipped (same pre-existing dependency skips). |
| New batch tests | 35 test methods in `tests/test_compute_ports.py` covering registry contracts, dependency hygiene, fail-closed arguments, and analytic answers for the corrected upstream defects. |
| Every catalog example | All 65 registry examples validate against their schemas and execute with finite JSON-serializable results. |
| Node compute suites | `compute-integration`, `compute-workspace`, `compute-mcp`: 11 tests passed including real owned-process MCP execution and all 65 browser preview replays. |
| Node complete suite | 826 tests: 825 passed, the same pre-existing Windows process-test failure described below. |
| Browser preview fixtures | `compute-preview.json` regenerated by recording the real engine output for every tool example (no hand-written results). |
| Count-sensitive wiring | CLI/MCP description, `modules.ts`, connector purposes, and test expectations updated from 15 to 65 tools. |

Batch-specific analytic checks include: EcoRI blunt/sticky overhang polarity and
the upstream-derived Type IIS cut table; PCR circular wrap-around products;
Golden Gate designer output assembling through the assembler (fixed upstream
inconsistency); codon optimization synonym replacement; logistic-with-clearance
equilibrium; FBA objective on a bounded exchange network; gene-circuit growth
dilution active (upstream ordering bug fixed); seeded Gillespie determinism;
ITC recovery of known Kd/n from a synthetic thermogram; Gompertz specific-rate
doubling time; corrected barcode Hamming linkage; hemodynamic SBP/DBP/HR after
DC restoration; VCOG numeric-band grades; MWAS true-null separation; xenograft
TGI against its definition; region-overlap union base counts; seeded NMF
determinism.

The first-batch evidence below predates the second batch.

## First batch verification (2026-09-18)

| Check | Result |
| --- | --- |
| Python complete suite | 305 tests: 301 passed, 4 skipped. |
| New computation tests | 59 tests passed within the complete suite: 9 integration, 23 statistics, 27 biological calculations. |
| TypeScript typecheck | Passed. |
| Node complete suite | 816 tests: 815 passed, 1 pre-existing Windows process-test failure described below. |
| Real Workbench MCP transport, source Python | 5 tests passed, no skips. |
| Real Workbench MCP transport, rebuilt packaged sidecar | Same 5 tests passed, no skips. |
| All 15 computations through the rebuilt CLI executable | Every catalog example completed with finite JSON and independently verified provenance. |
| Sidecar build | Both CLI and MCP executables built and published through the existing locked staging procedure. |
| Desktop build | Passed; regenerated manifest contains 16 modules including `analysis.biomni`. |
| Browser preview module controls | Confirmed the Biomni card is visible, can be checked, and saves successfully in the explicitly labelled fixture preview. This is UI-only evidence, separate from real MCP execution. |
| Workspace template | 17 managed files match the governed source hashes. |
| Dependency consistency | `pip check` and `uv lock --check` passed. |
| Whole-product offline gate | Not passed: the same existing process-test failure stops it. |

The new tests cover independent numerical answers, multiple-testing correction,
degenerate samples, Unicode sequence rejection, RNA loop topology, aligned
conservation, enrichment background handling, narrow-phase cosinor uncertainty,
measured-data kinetics, exact input snapshots, path containment, missing
dependencies, invalid JSON, cancellation before publication, and result tampering.

The MCP tests use the actual Workbench client and a real owned process, with
network and arbitrary execution disabled. They run numerical and RNA requests,
verify result and request hashes, verify provenance through MCP, and reject
unreviewed operations and paths outside the workspace. They exposed a Windows
NumPy extension first-import stall in a worker while the reader waited on stdin.
The production transport now initializes installed numerical extensions on the
reader thread only when a compute request arrives. Source and frozen-runtime
tests both pass after that change.

All fixture inputs are synthetic software examples. Upstream parity was checked
for canonical N-sequon scanning, both overlap modes, and O-hotspot positions and
fractions. The other adaptations intentionally change contracts and correct
specific upstream behavior; they are not full Biomni API parity claims.

## Existing failure retained

`tests/owned-process.test.mjs:248`, "owned termination joins inherited stdio
after the direct child has exited", fails at line 268 because `child.stderr.closed`
is already true where the fixture expects false. It reproduces in a standalone
run, both inside and outside the task sandbox. The test and
`scripts/owned-process.mjs` are byte-for-byte unchanged in Git relative to the
starting commit. This finding remains outside the compute change; it prevents a
claim that the full Node or offline gate is green.

## Reproduce focused checks

From the repository root:

```powershell
$env:PYTHONPATH = 'src'
.\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_compute*.py' -v
```

From `apps/proto-workbench`:

```powershell
node node_modules/typescript/bin/tsc --noEmit
node --experimental-strip-types --test tests/compute-integration.test.mjs tests/compute-mcp.test.mjs
$env:PROTO_COMPUTE_PACKAGED_RESOURCES = (Get-Location).Path
node --experimental-strip-types --test tests/compute-mcp.test.mjs
Remove-Item Env:PROTO_COMPUTE_PACKAGED_RESOURCES
```

The last command group requires the rebuilt sidecars. Selecting an unavailable
packaged runtime fails instead of skipping the test. Local logs and the
all-tool smoke receipts are retained under `build/biomni-research/`; generated
calculation artifacts remain under `build/compute/` and are not source assets.

The desktop build also synchronized two existing core module descriptors that
had lagged their already-implemented source tool lists. This synchronizes
packaging metadata; it introduces no additional scientific operations.
