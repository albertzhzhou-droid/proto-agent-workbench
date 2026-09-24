# Saved research projects

Research projects organize existing Proto Compute runs under a user-authored
name and research question. They reuse the existing computation engine and its
saved artifacts. Project metadata does not execute a method, grant scientific
approval or change a biological design's eligibility.

## Working with a project

In **Compute**, open **Research projects**. Create a project with a name and an
optional research question, then associate saved runs with it. A run can belong
to more than one project. Removing an association keeps the original run files
and the project's prior association history. Current results can also be added
from the normal analysis desk.

Opening a saved run reopens its actual input, result, manifest and provenance
files. It does not replay a model response or rerun a calculation. A saved result
uses its original method, runtime and assessment metadata. An older run without
a maturity assessment stays explicitly unassessed; today's catalogue is not a
historical assessment.

Projects are specific to the selected workspace. Their metadata is stored under
`build/compute-studies/studies.sqlite`. The normal `build/compute/<run ID>/`
directories remain the source of computation artifacts. Keep both when moving
or backing up a project. The project database does not contain copies of all
data files or results.

## Integrity and current source files

Associating a run records the SHA-256 hashes of its manifest, provenance,
request snapshot and result. These bindings are not silently updated when the
files change. A later reopen checks the internal bundle and, when opened through
a project, the recorded association. Damaged or missing runs keep their project
association and show a diagnostic; their previous inline result is not used as
a substitute.

The interface reports two different observations:

- **Saved artifact integrity** checks that the internal files and declared
  hashes agree, including the input bytes claimed by the manifest and provenance.
- **Current source freshness** checks the original request and external input
  paths. A source may have changed or disappeared while the saved input snapshot
  and result remain intact.

The existing Compute writer preserves the request text, but external file inputs
are recorded by path and hash rather than copied into each run. An intact saved
result therefore does not promise that all original files remain available for
reproduction. The manifests and provenance are unsigned local artifacts; matching
their hashes does not independently prove execution, authorship or scientific
correctness.

## Comparing runs

Select two saved runs to inspect their recorded parameters and result values
side by side. Comparison reopens both runs and keeps their identities visible.
Input and result differences use exact JSON field locations. Missing, null,
numeric and textual values remain distinct. Different tools and parameters may
represent different quantities; matching field names do not establish common
units or a shared statistical interpretation. No automatic unit conversion,
significance judgment or scientific ranking is inferred.

## Persistence and bounds

Project changes use an expected revision. A stale edit must reload the saved
project; it does not overwrite another writer's changes. Association history is
retained. The current contract allows 200 projects per workspace, 64 associated
runs per project and 128 recorded history events. A limit rejects a further edit
instead of silently discarding old associations or history. Saved-run discovery
and project lists are bounded and paged; a discovery bound must remain visible
rather than implying a complete workspace census.

Discovery indexes at most 1,000 runs from 2,048 directory entries, reading at most
30 manifest headers per request. These labels are unchecked until the bundle is
opened. Refresh continues pending header indexing. Input claims may include up to
1,024 provenance records, while current-source checks read at most 64 files and
64 MiB total (32 MiB per file); remaining sources stay explicitly not checked.
Results larger than 4 MiB cannot be opened by this surface. Opening an unknown,
missing run cannot grow the index, and a full index does not remove project links.

The IPC and browser request accept project/run identities and metadata, not
arbitrary database paths or caller-supplied results. A host-only development
override, `PROTO_COMPUTE_STUDIES_DB`, can select a separate `.sqlite` file under
the same workspace's `build/` directory for acceptance. Links, junctions and paths
outside that boundary are rejected. Static recorded-example previews cannot
create a saved research project.

## Acceptance scope

The finite independent acceptance plan and all attempt records live under
`build/research-studies-20260922/`. Its generated numerical and image inputs are
synthetic software fixtures. Source tests, actual CPU calculations, browser
interactions, desktop bundling and scientific validation are separate claims.
The independent host acceptance reports 10/10 passing cases at
`build/research-studies-20260922/acceptance-rerun-2026-09-22T21-30-52-064Z-1a1266ec/independent-acceptance.json`.
Its three baseline runs were actual small CPU calculations; format/tamper variants
are explicitly synthetic fixtures. Two earlier failed reports are retained: a QA
object-prototype assumption, followed by a real historical upstream-function
metadata compatibility defect that was corrected before acceptance.

Browser acceptance artifacts are retained under
`build/research-studies-20260922/ui-acceptance-20260922T2133/`. They include project
creation, two real statistical runs, exact field comparison, original-source
change, damaged-result rejection, host restart/reopening, and a retained protein
comparison. The first editor revision-race failure is retained separately from
its repair/retest. `build/research-studies-20260922/increment-acceptance.json`
records the final checks, source bindings and remaining boundaries. The overall
research upgrade programme remains in progress.
