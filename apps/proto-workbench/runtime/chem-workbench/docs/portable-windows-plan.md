# Portable Windows distribution plan

Status: planned, not implemented or accepted. Prepared on 2026-09-10 and reviewed
against the September 11 local preview for
[NEXT_STEPS priority 2](NEXT_STEPS.md). This document does not change the current
model-stage acceptance result or authorize signing, publication, or installation
on another person's computer.

The deliverable is a self-contained Windows x64 ZIP that opens the English
Workbench, renders structures, and runs the existing direct workflows, including
the three existing calculator profiles and the Design Studio modules,
without a repository checkout, system Python, Conda, a developer package cache,
or a network connection. Model proposals continue to use a separately installed
LM Studio instance at `127.0.0.1:1234`; direct work remains available while that
provider is absent. Model weights are outside this package.

## Baseline and first decisions

The current [desktop preview](desktop-preview.md) stages Electron and source
files but writes absolute development Python and Psi4 paths into `runtime.json`.
It also keeps projects, approvals, exports, and Electron state inside the staged
workspace. Copying that preview or its `.venv` does not meet this plan.

The September 11 preview also demonstrates Design Studio interaction through
an in-app browser connected to the packaged backend. Its native Electron process
launched, but native-container pixels were not inspected. Retain that precise
scope: clean-host native-window interaction, bundled runtime independence, and
relocation remain portable-stage deliverables. This plan adds no gate to the
current model-promotion assessment.

The current calculator registrations have different acceptance roles. Preserve
their existing input limits and numerical reference contracts; packaging does
not expand the admitted chemistry or methods.

| Existing profile ID | Role in portable acceptance |
|---|---|
| `qcengine.psi4.hf_sto3g.organic.v1` | Real calculations on the accepted complex Structure molecular fixtures from Priority 1 provide the decisive molecular calculator evidence. |
| `qcengine.psi4.hf_sto3g.smoke.v1` | The water calculation remains a Psi4 installation and regression diagnostic; it earns no complex-chemistry acceptance credit. |
| `ase.emt.cu.scan.v1` | The copper scan remains an ASE/EMT installation and regression diagnostic; it earns no complex-chemistry acceptance credit. |

Use the tested Windows architecture as the compatibility baseline: a CPython
3.13 application/scientific environment and a separate CPython 3.12 environment
for Psi4. The September 5 recorded versions are 3.13.3, 3.12.14, Psi4 1.11, and
Electron 43.4.0; these are starting points for the packaging spike, not a claim
that they are current release recommendations. Freeze the selected exact build,
ABI, platform tags, artifact URLs, and SHA-256 values in a new distribution lock.
Any version change requires the same profile and desktop acceptance gates.
The existing `uv.lock` and [Psi4 explicit environment](psi4-win-64.explicit.txt)
are reconstruction inputs; augment the Conda artifact checksums with SHA-256.

Choose an app-private CPython embeddable distribution for the main process.
Vendor reviewed wheels into its `Lib/site-packages` at build time, including the
application wheel. Keep an explicit relative module search path and test all
native extension loads. Do not depend on an end-user `pip` command or copy a
virtual environment's interpreter shim. Python documents the embeddable package
as an application component and recommends application-managed dependencies.
[Python Windows embedding documentation](https://docs.python.org/3.13/using/windows.html#the-embeddable-package)

Package the native Psi4 environment as a separate, immutable Windows runtime
archive reconstructed from the frozen explicit package set. The first spike
should evaluate `conda-pack` with its complete source package cache preserved.
An extracted environment may need prefix repair; an already repaired environment
cannot simply be moved again. Therefore retain the original archive and create
a fresh runtime instance whenever the installation prefix changes. A successful
import on the builder is insufficient proof of relocation.
[Conda-pack usage and relocation caveats](https://conda.github.io/conda-pack/)

If the frozen Psi4 build cannot pass fresh-prefix installation and DLL/data
resolution tests, keep that backend marked unavailable in the portable candidate
and leave the full distribution gate open. Do not substitute the developer's
environment or label a core-only build as a completed release covering the
declared calculator workflows.

## Package and writable-state layout

The initial supported location is a writable local NTFS folder for the current
Windows user. Record supported OS builds and CPU instruction requirements from
actual acceptance hosts before declaring a compatibility floor. ARM64,
network shares, FAT volumes, and system-wide installation remain outside this
first distribution increment.

```text
ChemWorkbench/
  Start-ChemWorkbench.exe          Product launcher; no system Python lookup
  releases/<release-id>/
    desktop/                      Electron executable, resources, notices
    python/                       Private CPython and vendored application wheel
    runtime.json                  Relative paths and component content IDs
    release-manifest.json          Immutable files, hashes, sizes, components
    runtime-lock.json              Exact CPython, wheel and Conda artifact identities
    third_party/                  Notices and component-to-file inventory
    licenses/                     Project MIT and applicable shipped license texts
  runtime-packs/<archive-sha256>/  Immutable Psi4 archive and installation recipe
  data/
    active-release.json           Versioned active/previous release selection
    runtime-instances/            Extracted Psi4 instances bound to final prefix
    workspaces/<workspace-id>/     Projects, workflow records, evidence and exports
    desktop-user-data/            Electron preferences and local browser state
    logs/                         Launcher, service and worker diagnostics
    migrations/                   Migration journal and verified backups
    staging/                      Owned, incomplete installations only
```

Release payload and runtime archives are immutable after manifest generation.
Validate the archive in an owned staging directory, then extract into a new
owned runtime-instance directory at its final chosen prefix. Keep that instance
unavailable while prefix repair and installed-file verification run. Record the
final prefix, original archive hash, and resulting installed runtime manifest;
prefix repair can legitimately change installed bytes. Publish readiness only
after those checks, without renaming or moving the repaired environment. If
extraction itself uses a temporary directory, move it to the final prefix before
repair. Restart must identify incomplete staging or instances and recover them
without running their workers.

The launcher resolves package paths relative to its own verified location.
Workspace and scratch paths are separate host-owned configuration. Refactor
`paths.py`, the web service, execution service, and desktop download locations
to honor this separation; no resource directory may double as the writable
workspace. Set interpreter, DLL search, temporary directories, and worker paths
only for owned child processes. Ignore inherited `PYTHONPATH`, `PYTHONHOME`,
Conda activation, and unrelated development environment settings. Never change
the user's global `PATH`, file associations, or Python installation.

Moving the complete folder to another writable location triggers fresh-prefix
runtime verification or reconstruction from the shipped archive. Existing
projects and completed evidence remain readable. Paths are part of current
runtime and approval identity. For the existing approved calculator jobs, a
moved, upgraded, or rolled-back runtime requires a new resolved plan and approval
before execution. Design Studio retains its existing explicit Run action and
bounded study authority. Retain old records as historical evidence; do not
rewrite their original identities.

## Inventory and notices

Build from explicit artifact inputs into a fresh, locked staging directory.
Inventory every shipped regular file, including `.exe`, `.dll`, `.pyd`, model
independent chemistry data, basis files, fonts, translations, and license texts.
Reject unexplained files, external links/reparse points, package-cache leakage,
credentials, and embedded developer-path dependencies. Current partial notices
in `third_party/manifest.json` must be reconciled against the actual shipped
payload rather than copied as a completeness claim.

Each component entry records its upstream name/version/build, source URL,
download SHA-256, package format, license expression where verified, notice
paths, files it owns, dependency edges, applicable source/material delivery
requirements, and reviewer disposition. Include Python and its runtime
prerequisites, Electron/Chromium notices, 3Dmol, RDKit/InChI, pymatgen and its
structure/radius data, ASE, NumPy/SciPy and
their numerical libraries, plus every package and data asset included with
Psi4/QCEngine. Remove unused optional development/research packages only through
an explicit manifest change followed by dependency and feature tests.

MIT applies to the project's own code; it does not replace third-party terms.
Resolve each shipped component's notices and any required accompanying material
before distribution. Unknown origin or unresolved requirements block that
component's distribution decision. Do not assume a Conda or wheel license field
alone establishes completeness. Handle Microsoft runtime prerequisites through
the verified app-local or supported OS arrangement selected in the spike;
reusing DLLs discovered elsewhere on the builder is not an artifact source.

## Ordered implementation and acceptance work

| Step | Concrete implementation | Evidence required to close the step |
|---|---|---|
| P1: freeze inputs | Select exact private CPython, Electron, wheel and Conda artifacts; make application/desktop version identifiers consistent; define the minimal supported package set and an offline build recipe consuming only those inputs. | `runtime-lock.json`, artifact hashes, dependency inventory, notices checklist, recorded builder OS/architecture, and the build recipe. Inventory the transitive main-runtime dependencies used by both Structure and Design Studio. No unresolved shipped component. |
| P2: make the application relocatable | Install the application wheel into private Python; implement relative resource lookup, separate data root, launcher preflight, and confined DLL/module resolution. | Start, compile, 3D preview, save/reopen and export on a host with no developer tools. Assert loaded modules/executables resolve only to the candidate and supported OS components. |
| P3: package the existing scientific workflows | Vendor the main scientific wheel closure; build and install the Psi4 archive using an explicit offline prefix-repair recipe at its final prefix; bind installed identities to resolved plans. | Accepted complex Structure molecular calculations from Priority 1 pass their existing input, result, convergence and provenance checks through the packaged organic HF/STO-3G profile. Complex organic/inorganic Design generation, all three conditional interface profiles, and supplied-pair response screening also pass direct packaged checks. Water HF/STO-3G and Cu EMT remain installation/regression diagnostics without complex-chemistry acceptance credit. Record input/result hashes, runtime files, process/log evidence, and required notices. No backend-support tests skipped. |
| P4: make upgrades recoverable | Add an application-level update lock, side-by-side releases, atomic active-release selection, workspace schema compatibility checks, and backup/journal handling. | Upgrade and rollback matrix below passes with unchanged prior payload hashes, preserved evidence, and fresh execution approval requirements. |
| P5: verify clean-machine portability | Run the complete packaged acceptance sequence below on fresh VM snapshots and one separate physical Windows host. | Host inventory, screenshots, page/launcher/worker logs, loaded-module paths, network observations, retained failures, and final artifact hashes. A second user account on the development machine alone is insufficient. |
| P6: prepare an owner-signed release candidate | Produce the complete reviewable unsigned candidate; verify identity/manifest; the owner selects the authorized signing identity and release destination. | Owner-authorized signing, final signature verification and manifest regeneration where bytes changed, then final-artifact smoke acceptance. Local unsigned acceptance does not imply publication approval. |

These are bounded functional checks. No pressure testing or broader chemistry
profile is part of this increment. Existing scientific tolerances and approval
rules remain unchanged.

The packaging work starts with three concrete prerequisites: a frozen Priority 1
source and feature baseline, available artifact inputs for the selected native
runtime closure, and access to the clean VM snapshots and separate physical host
used in P5. Record unavailable inputs or hosts as open distribution work; an
existing-runtime preview cannot substitute for them. Optional model integration
uses the separately accepted model identity from Priority 1 and does not choose
or promote a model during packaging.

Before the portable run, retain a manifest of the accepted Priority 1 complex
Structure molecular inputs and reference results, plus the complex Design and
interface cases to replay. Reuse their actual source identities, admitted
constraints, numerical tolerances and evidence checks. Missing accepted complex
fixtures leave portable chemistry acceptance open; water or copper diagnostics
cannot replace them. This is packaged execution of the existing methods, not a
new model evaluation or an expanded scientific profile.

## Clean-machine test sequence

1. Freeze the candidate archive hash and restore a fresh Windows x64 VM with
   no Python, Conda, Node.js, Git, scientific tools, LM Studio, or project caches.
   Record OS build, CPU/GPU, system runtime prerequisites, and VM snapshot ID.
   Run as a standard user with external networking disabled.
2. Extract into a path containing spaces and a non-ASCII user-selected folder
   name. Launch by the product entry point. Verify a clear startup diagnostic
   for unsupported permissions/prerequisites instead of silently using another
   runtime. Record first-launch extraction time and disk footprint.
3. Open and compile the accepted complex Structure molecular inputs. Interact
   with the actual native Electron window and retain its screenshots and logs;
   a browser connected to the same backend alone does not verify native-container
   presentation. Keep bundled water and copper examples available for diagnostics.
   Exercise the English UI, 3D
   rotation/selection, molecular import, coordinate revision and comparison,
   Cu(111) construction, keyboard preparation/approval, and numerical tables.
4. Run the accepted complex Structure molecular calculations from Priority 1
   through `qcengine.psi4.hf_sto3g.organic.v1` with fresh explicit approvals and
   real calculator execution. Check the frozen source and imported-coordinate
   identities, independently parsed result bytes, numerical reference and
   convergence criteria, resource limits, cancellation, clean worker exit, and
   interrupted-job recovery without automatic replay. These complex calculations
   provide the decisive calculator evidence. Run water HF/STO-3G and Cu EMT as
   separate installation/regression diagnostics, without adding them to the
   complex-chemistry acceptance count.
   Also run the already admitted complex organic and 40-atom ordered oxide
   generation, each of the three conditional interface profiles, and one
   supplied-pair response comparison per profile through Design Studio. Inspect
   the native geometry/curve views and independently reopen the exported design
   records. Retain a missing-input rejection and common-parameter response ties;
   do not turn descriptor or conditional-response results into measured activity
   claims. These checks preserve shipped functionality and introduce no new
   scientific profile or model score.
5. Save a project, restart, reopen it, independently parse exported evidence,
   and reopen a viewport PNG. Verify incomplete and tampered artifacts fail
   visibly. Confirm writes are confined to documented app data, owned scratch,
   and user-selected exports; immutable release files keep their hashes.
6. Close all owned processes, move the full folder to a different drive/prefix,
   make the old location inaccessible, and repeat the direct calculator and
   Design Studio checks. Validate
   fresh runtime instance identity and stale-approval rejection. Do not repair
   the copied, already-unpacked Conda environment in place.
7. Restore another clean snapshot; repeat with deliberately conflicting system
   Python/Conda environment variables and a decoy module in the working
   directory. The candidate must use its verified private runtime or fail
   closed. Do not modify those external installations.
8. In a separate optional-provider scenario, use an explicitly configured
   LM Studio installation with the exact separately accepted model identity
   recorded for the release. Verify connected status, one bounded
   proposal, source/plan provenance, and unchanged direct/model plan semantics.
   Stop the provider and confirm direct workflows remain usable. Record model
   identity separately; this is integration acceptance, not a new promotion
   score or an offline model-bundling claim.
9. Repeat the same packaged checks on a separate physical Windows host,
   including native GPU rendering. Report any unsupported host or skipped
   feature explicitly and retain the failing artifacts.

Observe network activity for the Workbench process tree: the direct workflow
must need no external service; the optional model scenario uses only the
configured loopback provider. The existing Job Object is process/resource
supervision, not a claimed network or hostile-filesystem sandbox.

## Upgrade, rollback, and recovery matrix

| Scenario | Required result |
|---|---|
| Verified A to verified B, unchanged workspace schema | Stage B separately, verify its full manifest and readiness, then atomically select it. Project revisions and evidence reopen; A remains unchanged and available. |
| New workspace schema | Produce and verify a workspace backup before migration; journal the schema transition; preserve the original evidence bytes. B must reject unsupported input schema with a useful error. |
| Failed extraction, missing DLL, bad hash, or unavailable disk space | A stays active. The failed B stage cannot launch a worker. Cleanup targets only the verified owned stage and preserves diagnostic evidence. |
| Two simultaneous upgrades or an active calculation | Only one updater owns the update lock. An active run prevents runtime switching; no unrelated process is terminated and no run is silently replayed. |
| Process termination at each installation/migration checkpoint | Restart chooses a verified complete release; the journal identifies unfinished work. Neither partial runtime nor partial workspace migration becomes active. |
| B to A with a compatible schema | Switch to verified A, reopen projects/evidence, reject any stale execution approval, then resolve and explicitly approve a new acceptance calculation. |
| B to A after an incompatible schema migration | Preserve the complete current B workspace. Restore the verified pre-migration backup into a separate workspace for A and identify its recovery point. Never overwrite later B work or pretend it survived a schema downgrade. |
| Cleanup or uninstall | List owned release/runtime instances and associated manifests first. Remove only selected verified app-owned paths. Project/evidence deletion is a separate explicit user action. |

## Signing and closure

Finish unsigned packaging and acceptance before requesting signing. The owner
must control the signing identity and authorize its use; no borrowed certificate,
generated publisher identity, remote release, or automatic update feed is
introduced by this plan. Record the signer identity, certificate chain,
timestamp policy, and signature verification outcome for the exact final
artifact. Preserve upstream signatures on third-party files where present.

Generate final manifests after any signing operation that changes file bytes.
Keep an external digest/signature for the manifest so its content does not
recursively include itself. Distinguish reproducibility of the unsigned payload
from timestamped signed artifacts. Reopen the final archive independently and
repeat native launch, accepted complex Structure molecular calculations, and
representative complex Design/interface checks after signing. Retain water and
copper diagnostics as separate backend checks with no complex-chemistry credit;
earlier unsigned results are not evidence for different final bytes.

Close the stage only when P1-P6 evidence is available for the claimed release
status. If owner signing or public distribution is not requested, deliver the
accepted unsigned local candidate with those release gates explicitly pending.
The handoff report must identify supported hosts, exact bundled runtimes,
artifact hashes, notices disposition, clean-machine results, upgrade/rollback
results, data-recovery behavior, remaining limits, and the owner-controlled
publication decision. Until then, the existing configured preview keeps its
current scope label.
