# Data-bound research figures

Open **Compute → Research projects**, select a saved project and choose **New
figure board**. Add panels from its linked runs, choose saved input or result
fields, and save the board to inspect its exact selected values. Supported plots
are line, scatter and bar, in one or two columns with at most six panels.

The host resolves fields against reopened Compute artifacts. Each panel retains
the run identity and SHA-256 digests of the original input, result, manifest and
provenance files. Editing a title does not refresh these bindings. Explicit
rebinding creates a new figure revision and leaves earlier revisions intact.
Project and figure revisions protect concurrent edits.

## Data and rendering semantics

- A numeric scalar is one point. Arrays retain their order. Object-array columns
  use a strict JSON Pointer and an optional relative field pointer.
- Missing, mixed or non-finite selections are rejected; no rows are dropped,
  imputed, aggregated or converted. X and Y must have equal lengths.
- An omitted X selection uses the one-based observation index. Line and scatter
  X selections must be numeric. Bars use separate positions in recorded order
  with the original numeric or categorical X labels, including duplicates.
- Labels, units and captions are user-authored annotations. A line connects
  recorded points; it does not infer a fitted model. Error bars, fitting and
  statistical inference are outside this first figure surface.
- Series discovery is bounded to 256 candidates, depth 8 and 20,000 visited
  nodes. A panel supports 5,000 points and a board 20,000. The browser explicitly
  limits its preview to 2,000 points per panel and its table to 100 rows; exports
  retain all selected points.

## Source checks and exports

An altered original source file is distinct from altered saved result bytes.
Valid saved snapshots whose original sources changed or could not be checked
require explicit acknowledgment before export. Their current source status is
retained in the methods and visible export footer. A missing association, changed
binding, damaged saved artifact or invalid selection blocks current export.

The local Matplotlib renderer creates a new immutable directory under
`build/research-figures/exports/<export-id>/` containing:

- `figure.svg` and `figure.pdf`: vector figures with fixed rendering options.
- `plotted-values.csv`: every plotted point in panel and row order. X and Y cells
  use JSON literals to preserve numbers, categorical strings and escaping.
- `figure-data.json`: exact render request and renderer/font metadata.
- `methods.md` and `methods.json`: original saved method metadata, full input
  parameters, selections, run bindings, source observations and authored labels.
- `manifest.json`: written last, binding the raw request-file bytes and each of
  the six artifacts by SHA-256 and byte count.

The host reopens the generated files and rechecks the project, figure and source
observations before registering an export. Concurrent changes leave files
unregistered as retained evidence. Reopening a figure lists retained export
receipts, including clearly identified older revisions. Downloads recheck the
bundle on the host and the selected bytes in the browser. Export history is not
a claim that its original source files are still current.

After byte verification the UI also exposes a **Save verified** link for the
selected file. This offers a direct user gesture when an embedded browser does
not start the automatic download. The prepared link is revoked when its editor,
project, figure revision or export selection changes.

The optional Python extra is `research-figures`. Missing Matplotlib or unsupported
font glyphs produce explicit errors; no package is installed automatically. The
fixed renderer is also available through `proto-agent figure render <request.json>`
and MCP `proto_research_figure_render`. These direct interfaces render supplied
points and source claims; only the Workbench host resolves them against project
artifacts. They do not authenticate source assertions independently.

Metadata supports 32 figures per project, 64 revisions and 64 exports per figure.
Figure metadata is limited to 128 KiB, the prepared request to 16 MiB, each export
artifact to 16 MiB, and the aggregate six-file export to 48 MiB. Paths are fixed
inside the workspace and caller-supplied code, style and output paths are rejected.

## Validation scope

Evidence is retained under `build/research-figures-20260922/`. Host fixtures and
fake-renderer tests exercise persistence and failure boundaries; they are separate
from real Matplotlib, CLI/MCP, UI download and independent vector-file reopening
checks. Earlier failed attempts remain in that directory.

The final local check passed 83 related Node tests and TypeScript. The real Python
figures profile passed 22 tests with one explicitly reported Windows symlink
privilege skip. Real registered export files were reopened independently and
visually inspected. The in-app browser displayed verified bytes and the fallback
link, but no resulting downloaded file was observed; browser download remains
unaccepted. Open the generated workspace files directly when inspecting these
acceptance artifacts. The consolidated receipt distinguishes those outcomes.

This is a local research-output feature. Hash agreement, a generated methods
draft and a successful software check do not establish scientific validity or
native installer/release acceptance. Review methods, labels and interpretation
before using a figure in research.
