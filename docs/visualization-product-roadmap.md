# Visualization Product Roadmap

- Status: engineering roadmap, not a release-completion claim
- Research snapshot: 2026-08-31
- Applies to: `apps/proto-workbench` Design Explorer and `proto-agent.ir.v1`

## Purpose and bounded scope

Proto Workbench should make a compiled design understandable through a linked,
product-grade map, sequence view, feature inventory, and evidence context. The
current implementation already combines CGView.js for the circular overview and
SeqViz for the base-level linear view. This roadmap hardens that foundation and
defines the remaining behavior needed for a complete **visual review** workflow.

This roadmap does not add or describe wet-lab execution procedures. It does not
turn a visualization, software check, or exported image into evidence that a
biological design is safe, experimentally valid, or ready to execute. Bundled
part sequences remain development fixtures unless they are replaced by a
reviewed library, and every design remains human-review-required.

Absolute zero defects cannot be guaranteed for this or any non-trivial software
product. The defensible target is a declared support envelope, no known open P0
defects, passed release gates, bounded residual risk, and an explicit record of
known limitations. “Complete” in this document means complete against the
accepted product behavior matrix, not bug-free under every possible input,
device, renderer, dependency, or future operating-system change.

## Clean-room product boundary

SnapGene is a proprietary reference product. Proto may study public, observable
product behavior, but must not copy or reconstruct SnapGene internals.

Allowed inputs:

- Public SnapGene product pages, public user-guide articles, public screenshots,
  and behavior visible through ordinary licensed use.
- Public standards and openly licensed source code, documentation, demos, papers,
  and test fixtures.
- Independently designed interaction models, adapters, visual tokens, tests, and
  documentation derived from Proto's own requirements.

Prohibited inputs and actions:

- Decompiling, disassembling, instrumenting, or extracting code, private APIs,
  resources, assets, fonts, icons, databases, or protocol details from SnapGene.
- Bypassing licensing, access controls, telemetry controls, or technical
  protections.
- Pixel-for-pixel cloning of proprietary screens, copying proprietary copy or
  trade dress, or presenting Proto as SnapGene-compatible without a separately
  verified compatibility contract.
- Treating an imported `.dna` file, screenshot, or public demo as permission to
  reuse proprietary implementation material.

Every implemented behavior must be traceable either to a Proto requirement or
to an open-source component whose version and license are recorded. Public
SnapGene references below document only user-visible product behavior.

## Current implementation baseline

The following statements describe code that exists now; they are not roadmap
promises:

- `apps/proto-workbench/package.json` pins React 19.2.8, CGView.js 1.8.2,
  SeqViz 3.10.24, and SVGCanvas 2.6.0.
- `src/renderer/design-visualization.ts` parses `proto-agent.ir.v1` fail-closed,
  normalizes IUPAC DNA sequence data, enforces input ceilings, assembles
  construct-local and design-global intervals, and retains structured
  diagnostics. Optional construct annotations use a bounded logical-feature
  model with one to 64 canonical segments; invalid bounds, overlap, ordering,
  or a linear-origin wrap fail closed.
- Internal intervals are zero-based and end-exclusive. The current unit suite
  verifies contiguity and length derivation across parts and constructs.
- `CgviewMap.tsx` converts canonical segments to CGView's one-based inclusive
  multi-location geometry, renders a circular overview projection, links
  logical-feature clicks to the shared selection, renders a bounded
  sliding-window GC-content and GC-skew plots derived from the assembled
  sequence, and exposes SVG and PNG render methods. The shared odd-base window
  is reviewer-configurable and clamped to the construct length; GC skew uses
  `(G-C)/(G+C)`, treats windows without observed G/C as neutral, and remains
  explicitly software-derived.
- `DesignsPage.tsx` provides Map, Sequence, and Split modes; the user-facing map
  export provides SVG with embedded review metadata and PNG with a sibling JSON
  metadata record. Export metadata records only the CGView layers actually
  rendered into the map, explicitly records that the transient selection
  overlay is excluded, and excludes sequence-only layers. SeqViz provides the
  linear sequence, complement, coordinate index, logical annotations flattened
  into synchronized display segments, direction-known
  CDS translations, selected restriction sites, exact base search, and
  bidirectional drag selection. A CDS whose direction is unknown is withheld
  with `CDS_DIRECTION_UNKNOWN`; it is never coerced to a forward translation.
  A segmented CDS is currently withheld with
  `SEGMENTED_CDS_TRANSLATION_UNSUPPORTED` instead of being mistranslated as one
  contiguous interval.
- `SequenceNavigator.tsx` provides a compact, whole-construct linear CGView strip
  above SeqViz. Feature and non-feature clicks synchronize the logical feature or
  one-base selection respectively. A CGView 1.8.2 linear-initialization ordering
  bug is avoided by switching format only after Sequence and Backbone exist.
- The optional software ORF layer performs a bounded six-frame ATG-to-standard-
  stop scan on both strands, supports circular origin traversal, exposes a
  reviewer-controlled minimum amino-acid threshold, and never mutates the IR.
  Results are typed as software-derived view features; declared and inferred ORF
  identities remain distinct, while exactly overlapping translation intervals
  are rendered once to avoid duplicate SeqViz rows.
- Circular constructs expose an explicit source-base view-origin control. The
  transform rotates the displayed sequence and every logical-feature segment,
  preserves source coordinates beside view coordinates, remains reversible, and
  is exported as non-mutating view metadata. Linear, unknown-topology, and
  invalid-origin requests fail closed; the source IR, digest, and provenance are
  never rewritten.
- Map features, sequence selection, feature rows, and the inspector share
  selection state. Named multi-segment features highlight across all surfaces,
  while arbitrary valid
  sequence ranges render as a neutral map arc without fabricating an annotation.
- The feature inventory supports bounded name/type/source filtering, stable
  single-column sorting, individual and filtered-set visibility, and canonical
  feature identity after filtering or sorting. Hidden features are omitted from
  CGView, the sequence navigator, SeqViz annotations, primers, and translations,
  while the muted inventory row remains available as the accessible recovery
  path. Map exports record the active label density and hidden-feature count.
- A fail-closed, versioned local preference envelope persists viewer mode,
  construct, layers, label density, zoom, GC/ORF controls, view origin, feature
  visibility, and inventory state per exact artifact SHA-256. The store is
  bounded to 32 artifacts and 512 KiB, rejects malformed data, and never mutates
  the compiled artifact or run provenance.
- Global bounded search covers design metadata, constructs, part or annotation
  identity/type, and every exact sequence occurrence across whole constructs,
  including matches that cross part boundaries; previous/next can move
  the active construct while preserving local coordinates.
- The artifact inventory reads all candidates returned by the bounded workspace
  scanner with concurrency eight. It groups only byte-identical ready artifacts,
  preserves invalid and digest-mismatched entries, and shows the number of
  collapsed copies rather than allowing duplicate output folders to crowd out a
  distinct design.
- Manifest and provenance resolution share the same eight-task concurrency
  budget. A new inventory generation cancels further dispatch from a superseded
  generation, so repeated refreshes cannot build an unbounded queue of stale
  file reads.
- Provenance is fail-closed across the complete inventory: malformed or
  unreadable manifest candidates remain explicit diagnostics and block map
  export until the inventory is complete. A partial scan is never presented as
  a clean provenance result.
- The UI reads validated `build/*.ir.json` artifacts through the workspace-safe
  file bridge. It displays the artifact SHA-256 and links an artifact to a run
  only when a `proto-agent.run.v1` manifest explicitly inventories it.
- The surface is read-only and labels itself “Software-level view · review
  required.” Each normalized construct carries `linear | circular | unknown`;
  omitted topology becomes `unknown`, invalid declared values fail closed, and a
  circular rendering in the unknown state is disclosed as a projection rather
  than a topology assertion.
- The declared interactive envelope is currently at most 10,000 bp and 750
  features per construct. The keyboard-accessible feature inventory is paged at
  500 rows. Larger valid inputs enter a disclosed bounded summary mode in which
  search, provenance, diagnostics, and the paged inventory remain available,
  while the interactive canvases and map export stay disabled.

The parser safety ceilings of 2,000,000 sequence characters and 20,000 parts are
rejection limits, not interactive performance-support claims. The deliberately
smaller envelope above is the supported renderer boundary until a retained
packaged-Windows benchmark matrix proves a wider one.

## Open-source stack and license decisions

| Component | Decision | Product role | License and maintenance position | Integration condition |
| --- | --- | --- | --- | --- |
| [CGView.js 1.8.2](https://github.com/sciguy/cgview-js) | Adopted and pinned | Primary small-genome/plasmid map, tracks, labels, plots, linked selection, SVG/PNG scene export | Apache-2.0; active 2026 release and a 2026 [JOSS paper](https://doi.org/10.21105/joss.09930) | Keep behind a React lifecycle adapter; retain applicable upstream LICENSE and NOTICE material; test document-listener and resize cleanup. |
| [SeqViz 3.10.24](https://github.com/Lattice-Automation/seqviz) | Adopted and pinned | Base-level linear sequence, complement, annotations, translations, restriction sites, search, and selection | MIT; peer dependencies explicitly include React 19 | Keep as a read-only renderer; normalize all data before props cross the adapter; do not mistake it for a full editor. |
| [SVGCanvas 2.6.0](https://github.com/zenozeng/svgcanvas) | Adopted and pinned | Vector context used by the CGView export path | MIT | Package its license and verify exported SVG is deterministic and free of external font/network requirements. |
| [`@teselagen/ove`](https://github.com/TeselaGen/tg-oss/tree/master/packages/ove) | Deferred; not installed | Possible future sequence/annotation editor with circular, linear, and sequence panels | Repository is MIT, but the current package is pre-1.0, has a large dependency surface, directly depends on React/ReactDOM 18.3 rather than declaring them only as peers, and its published package requires an explicit license-provenance review | No production dependency until an isolated React 19/Electron spike, import/export round-trip suite, accessibility review, package-size budget, state-boundary design, and license review pass. Prefer a separately loaded route or iframe over sharing the root store. |
| [JBrowse 2](https://github.com/GMOD/jbrowse-components) | Deferred; not installed | Possible future genome-scale tracks, variants, synteny, or dotplot views | Actively maintained and React-19-capable, but pure-ESM/worker/plugin/MobX-State-Tree/MUI integration is substantially larger than the current need. The root repository is Apache-2.0 while current published React-package metadata reports MIT, so provenance must be clarified before distribution | Add only after a measured product requirement exceeds CGView/SeqViz limits. It must be lazy-loaded and pass worker packaging, offline, memory, accessibility, and license gates. |

`apps/proto-workbench/THIRD_PARTY_NOTICES.md`, packaged license files, the
lockfile, and the generated software inventory must agree before release. A
dependency being open source does not waive attribution, NOTICE, source-offer,
patent, trademark, or transitive-license obligations.

## Canonical coordinate and topology contract

One coordinate contract must sit above every renderer. No component may perform
ad-hoc coordinate arithmetic in event handlers or JSX.

### Canonical model

- `start` is a zero-based inclusive index.
- `end` is a zero-based exclusive index.
- A non-empty interval satisfies `0 <= start < end <= sequenceLength`.
- `length` is always `end - start`; stored lengths must be checked against that
  derivation.
- Human-facing coordinates are one-based and inclusive: display
  `[start + 1, end]` without mutating the canonical value.
- Strand/direction is `-1 | 0 | 1`; `0` means unknown or not declared, not
  forward.
- Topology is `linear | circular | unknown`. `unknown` must remain visibly
  disclosed and must never silently become a circular biological claim.
- A feature that crosses a circular origin is represented as an ordered set of
  canonical segments with a shared logical feature ID. Canonical data never
  encodes wrapping by setting `end < start`.
- Construct-local and design-global intervals remain distinct typed fields.
  Adapters must state which coordinate space they accept and return.
- Changing the displayed origin is a view transform. It must not rewrite the
  sequence, feature identity, artifact hash, or provenance unless the user
  performs a separate, explicitly reviewed data operation.

### Adapter contracts

| Boundary | Forward conversion | Reverse conversion and validation |
| --- | --- | --- |
| Canonical → SeqViz | Pass `[start, end)` unchanged | Clamp only after rejecting non-integers and out-of-bounds values; preserve SeqViz's viewer origin in selection metadata. |
| Canonical → CGView | For a non-empty segment, `start = canonical.start + 1`, `stop = canonical.end` | `canonical.start = start - 1`, `canonical.end = stop`; reject zero, negative, reversed, non-finite, or out-of-bounds coordinates. |
| Canonical → OVE, if approved later | OVE uses zero-based inclusive ends, so `start = canonical.start`, `end = canonical.end - 1` | Add one to the OVE end and validate the result before it re-enters canonical state; empty intervals are not serializable as annotations. |
| Canonical → JBrowse, if approved later | Use the selected adapter/file format's documented convention; do not infer one convention for every track type | Parse through a format-specific adapter and prove round-trip behavior with fixed fixtures before enabling editing or export. |

The CGView conversions now live in named, unit-tested adapter functions. Current
tests cover one-base and boundary coordinates, local-versus-global coordinates,
reverse/unknown strand, multi-location and circular-origin traversal, invalid
segments, and fail-closed whole-feature rejection. Remaining P0 coordinate work
is a full bounded property suite, explicit reverse conversion, and retained
cross-renderer round-trip fixtures proving
`fromRenderer(toRenderer(interval)) === interval`.

## Public SnapGene behavior matrix

This matrix compares only public product behavior. It is a prioritization aid,
not evidence of internal similarity or a promise to implement every SnapGene
function.

| Public reference behavior | Current Proto behavior | Target and phase |
| --- | --- | --- |
| Map and Sequence views show the same file, with a circular or linear graphical map and inline sequence annotations ([public introduction](https://www.snapgene.com/guides/introduction-to-snapgene)) | Split/Map/Sequence modes exist. CGView and SeqViz consume the same normalized construct; named feature selection and normalized forward/reverse range selection are linked. | **P0:** retain stable focus and selection through every mode, document, and construct transition in native interaction tests. |
| Features, enzyme sites, primers, ORFs, and translations can be displayed as layers in map or sequence views ([public features page](https://www.snapgene.com/features)) | Logical annotations, selected restriction enzymes, complement, coordinate index, and direction-known CDS/ORF translations are present. Declared `primer` annotations render through SeqViz's primer layer and remain separately toggleable on map, navigator, and sequence. A bounded optional six-frame ORF scan adds visibly software-derived view features with a minimum-length control and circular-origin support. Unknown primer/ORF direction and segmented translation states are withheld with explicit diagnostics. Configurable non-standard starts/codes and arbitrary translation frames remain absent. | **P1:** add a reviewed configurable-translation contract, richer primer qualifiers, layer filters, legends, and test fixtures without converting inferred ORFs into IR annotations. |
| Feature, enzyme, and primer searches report match counts and navigate previous/next matches in both views ([public search guide](https://support.snapgene.com/hc/en-us/articles/10384006344852-Search-for-an-Enzyme-Feature-or-Primer)) | Bounded global search covers design/source/chassis, constructs, part identity/type, and exact sequence occurrences across constructs; exact nucleotide search is also forwarded to the active SeqViz pane. | **P1:** index qualifiers, observed enzyme sites, primers, translations, and ambiguous-IUPAC base queries while keeping a bounded result count. |
| Display controls expose annotation visibility, labels, coordinates, minimap, sequence formatting, translations, and origin/layout choices ([public display-options index](https://support.snapgene.com/hc/en-us/sections/10383749553044-Display-Options-for-DNA-Sequences)) | Annotation, complement, index, restriction, direction-known translation, bounded GC-content and GC-skew, sequence zoom, layout, label density, and feature-visibility controls exist. GC metrics share a configurable odd-base window, expose separate legends and accessible formula/summary text, and are recorded in export metadata. Construct topology is typed and disclosed. Segmented/wrapping geometry, a compact whole-construct navigator, responsive map-label density, and a reversible source-base view-origin transform are implemented. View state is persisted per exact artifact SHA-256 in a bounded fail-closed store; export metadata records label density, hidden-feature count, and the non-mutating view-origin transform. | **P1 residual:** add direct label-position editing only if a reviewed interaction contract justifies it. A persistent source-origin change remains a separate reviewed data operation, not a display action. |
| A selected annotation can be inspected and annotations can be listed, hidden, or shown ([public introduction](https://www.snapgene.com/guides/introduction-to-snapgene)) | Keyboard-operable paged feature rows, selected-feature inspector, live selection announcement, constraints, diagnostics, source hash, and run provenance exist. The inventory supports name/type/source filtering, stable single-key coordinate/name/type/length sorting, individual show/hide, filtered-set show/hide, and a muted accessible recovery row for hidden features. | **P0 residual:** complete native keyboard, screen-reader, 200%-zoom, and Windows text-scaling evidence. **P1 residual:** richer qualifier/evidence inspection and compound multi-column sorting. |
| Map exports include bitmap and vector formats such as PNG, PDF, and SVG ([public export guide](https://support.snapgene.com/hc/en-us/articles/10384281303700-Export-a-DNA-RNA-or-Protein-Map-as-an-Image)) | SVG and PNG are exposed. SVG embeds review metadata; PNG emits a sibling metadata JSON file. Metadata lists rendered map layers and accurately records that the transient selection overlay and sequence-only layers are excluded. Digest mismatch and summary mode block export. | **P0:** independently reopen and visually verify SVG/PNG plus metadata. **P1:** add print/PDF only after font, pagination, accessibility, and packaged-Electron checks pass. |
| The full product supports sequence/annotation editing and comprehensive undo/history, while its free viewer has a deliberately smaller editing envelope ([public Viewer comparison](https://www.snapgene.com/snapgene-viewer)) | Proto's visualization is deliberately read-only. Run provenance is shown, but it is not a sequence-edit history. | **P2, conditional:** native reviewed edit transactions or an isolated OVE experiment. Never blur read-only review with mutation; every write remains separately approved and auditable. |
| Graphical history connects a product with prior changes ([public features page](https://www.snapgene.com/features)) | A linked run manifest exposes run ID, steps, artifacts, summary, and `human_review_required`; unlinked artifacts remain visibly unproven. | **P1:** product history timeline derived only from signed/hashed local events and explicit artifact relationships, with no inferred lineage. |
| Alignment and trace views provide visual comparison and verification surfaces ([public feature overview](https://www.snapgene.com/features)) | No alignment or chromatogram renderer is claimed. | **P2, conditional:** add only after accepted file contracts, provenance, algorithms, performance envelope, and review semantics exist. It is not required for P0/P1 visual review closure. |
| The product advertises chromosome-size browsing ([public feature overview](https://www.snapgene.com/features)) | Parser ceilings reach 2 million sequence characters and 20,000 parts, but the declared interactive envelope is intentionally 10 kbp/750 features; larger valid constructs switch to explicit summary mode. A native 10 kbp/723-feature fixture rendered successfully, but a complete latency/memory/lifecycle matrix has not yet been retained. | **P0:** retain packaged benchmark evidence for the declared envelope before expanding it. **P2:** consider lazy JBrowse only if a documented genome-scale requirement remains unmet. |

Simulation-specific workflows and operational laboratory instructions are outside
this roadmap even when a reference product advertises them.

## Roadmap

### P0 — trustworthy linked visualization

P0 closes correctness, disclosure, and release risks around the functionality
that already exists.

- Preserve the current CGView + SeqViz split, pinned versions, fail-closed IR
  parser, artifact SHA-256, run-manifest linkage, and read-only review badge.
- Preserve the explicit construct topology, typed canonical adapter module, and
  implemented segmented/wrapping feature geometry. Never encode wraps as
  reversed intervals, and keep unknown circular rendering labeled as a
  projection.
- Add adapter unit/property tests and end-to-end selection tests for map,
  sequence, part table, inspector, search, construct switching, and reset.
- Represent arbitrary sequence ranges on the map without fabricating an
  annotation or biological identity.
- Preserve SVG/PNG export failure diagnostics and the current renderer version,
  artifact hash, topology, coordinate display convention, visible-layer, and
  review metadata. Add independent reopen and visual-equivalence tests for both
  formats and the PNG sidecar.
- Provide a keyboard-operable, screen-reader-readable alternative for every
  canvas interaction; add visible focus, non-color selection cues, and an
  announced selection summary.
- Establish packaged-Windows performance and memory benchmarks. Treat parser
  ceilings as rejection limits until they are inside the measured envelope.
- Verify renderer cleanup across repeated mount/unmount and document changes:
  no leaked document listeners, ResizeObservers, object URLs, or selection
  callbacks.
- Make third-party license/NOTICE checks and offline asset/font checks packaging
  gates.

### P1 — complete read-only product review

P1 expands viewing and evidence depth without introducing sequence mutation.

- Extend the implemented declared-primer, declared-ORF, bounded software-ORF,
  configurable GC-content/GC-skew visualization, label-density control, and
  per-feature visibility with configurable translation codes/starts, enzyme
  filtering, richer primer qualifiers, and additional legends from reviewed
  data contracts. Preserve the implemented compact navigator and reversible
  view-origin transform, extending them only from reviewed view-state contracts.
- Preserve the implemented bounded feature filters, stable single-key sorting,
  individual and filtered-set visibility, and per-artifact view-state store.
  Add qualifier/evidence search, richer feature inspection, compound multi-key
  sorting, and bookmarks without weakening canonical feature identity.
- Extend topology display controls without allowing a display preference to
  rewrite source topology. If persistent source-origin mutation is later added,
  implement it as a separate auditable edit transaction with explicit review.
- Add reviewed read-only import adapters for selected standard formats only when
  parsing, limits, provenance, coordinate conversion, and round-trip export are
  proven. Never invent a biological part ID for missing source metadata.
- Add graphical run/product provenance based on recorded manifests and event
  hashes; do not infer missing ancestry.
- Add PDF/print export and a review packet that pairs the rendered figure with
  artifact hash, source, diagnostics, visible layers, software versions, and
  review status.

### P2 — advanced conditional modules

P2 is research-gated and is not part of current release closure.

- Evaluate OVE only as an isolated advanced editor. The spike must prove React
  19/Electron stability, deterministic canonical round trips, write approvals,
  undo/redo provenance, accessibility, offline packaging, package budget, and
  licensing before any production adoption.
- Evaluate JBrowse only for an accepted genome-scale, variation, alignment,
  synteny, or dotplot requirement that the existing stack cannot meet. Load it
  on demand and keep its worker/config state outside the core design store.
- Evaluate alignment, chromatogram, and comparison views only with explicit data
  contracts and review semantics. Their presence must not be described as
  experimental verification.
- Add a stable renderer plugin API only after the canonical model and review
  gates have remained backward-compatible for a full release cycle.

## Product and review gates

No phase is complete because a demo looks polished. A release candidate must
pass every applicable gate with evidence retained under `build/` or the existing
QA evidence location.

| Gate | Required evidence | Release rule |
| --- | --- | --- |
| Clean-room and license | Source ledger, pinned versions, lockfile, dependency inventory, packaged LICENSE/NOTICE files, and no proprietary assets/code | Block on missing or contradictory provenance. OVE and JBrowse remain excluded until their package-license questions are resolved. |
| IR and provenance | Structured parser diagnostics, size-limit tests, malicious-label tests, artifact SHA-256, and explicit run-manifest inventory linkage | Invalid or unlinked data may be inspected only with visible warnings; it cannot be presented as workflow-verified. |
| Coordinate correctness | Adapter unit/property fixtures, wrap/origin fixtures, one-base/end-boundary cases, local/global coordinate tests, and cross-renderer round trips | Any off-by-one, strand, topology, or selection disagreement is P0. |
| Product behavior | Map/Sequence/Split, layers, search, selection, reset, construct switching, diagnostics, and export exercised against realistic reviewed fixtures | No silent control failure, stale selection, fabricated identity, or unsupported-state success message. |
| Visual QA | Native screenshots at supported desktop sizes, direct reference/implementation comparison where a public reference is used, dark/high-contrast checks if supported, and no console errors | Screenshots supplement interaction tests; they do not replace them. |
| Accessibility | Keyboard-only journey, focus order, accessible feature table/summary, contrast, non-color state, 200% zoom, Windows text scaling, high contrast, and reduced motion checks against [WCAG 2.2 AA](https://www.w3.org/TR/WCAG22/) goals | A canvas-only function without an equivalent accessible path is release-blocking. |
| Performance and lifecycle | Timed fixture matrix, pan/zoom and selection latency, export time, heap/listener/observer checks over repeated remounts, and packaged Electron measurements | Publish the measured envelope; inputs beyond it must degrade explicitly or fail closed rather than freeze. |
| Export | SVG/PNG/PDF visual checks as applicable, deterministic names, no external network/font dependency, embedded or sidecar provenance, and reopen checks in independent viewers | An export must match the active layers/topology and must not imply scientific approval. |
| Packaging and offline security | Typecheck/tests, production build, packaged Windows smoke, CSP/offline guard, renderer sandbox, module integrity, and third-party notice presence | A browser preview or fixture-only pass is not packaged release closure. |
| Human review | Review packet, unresolved diagnostics, known limitations, support envelope, reviewer checklist, and explicit `human_review_required` state | Software gates do not replace domain review; the status remains visible after export and reopen. |

Release triage uses the following severity contract:

- P0: corruption, incorrect coordinates/topology, fabricated provenance or
  identity, unsafe write, broken primary view, inaccessible primary function,
  license/security failure, or export that materially misrepresents the active
  design. Zero known P0 issues are permitted.
- P1: major supported-workflow failure without a safe practical workaround,
  severe performance regression inside the declared envelope, or missing review
  evidence. P1 issues in the changed visualization scope must be closed before
  release.
- P2: bounded secondary-function defect or deferred enhancement with a safe,
  documented workaround. Open P2 items require owner, scope, and target phase.

## Accessibility goals

- Every map feature, sequence selection, layer toggle, search result, and export
  action is reachable and operable by keyboard.
- Canvas content has a synchronized semantic alternative: construct summary,
  ordered feature table, selected interval, direction, type, and coordinates.
- Focus and selection use text/icon/outline cues in addition to color. Feature
  palettes meet contrast requirements against the active background or receive
  an outline/pattern fallback.
- Screen readers receive concise live announcements for document load, invalid
  artifact, search count, selected feature/range, export completion, and export
  failure; pointer hover is never the only route to information.
- The layout remains usable at browser zoom 200% and supported Windows text
  scales without clipped controls or horizontal traps in the primary journey.
- Animation and animated navigation respect reduced-motion preferences.

## Performance and lifecycle goals

The first retained benchmark pass must use a named packaged-Windows reference
machine and preserve raw measurements. A native development build has already
loaded and visibly rendered a generated 10,000 bp / 723-feature fixture, and the
artifact refresh reported 1,668 ms for that workspace state. That observation
proves bounded rendering viability, not a precise time-to-usable SLA: the
accessibility-state capture used during the run dominated the subsequent timing,
so no exact renderer-ready latency is claimed. The temporary fixture repeats only
IDs and toy sequences from `parts/ecoli_k12_library.json`; it is not a biological
reference dataset.

The enforced renderer envelope is currently 10,000 bp / 750 features. Inputs
beyond either limit enter summary mode. The following wider targets remain goals
to validate, not claims about the current build:

- Small fixture: up to 10 kbp and 750 features becomes usable within 1.5 seconds
  after artifact data is available on the named reference machine.
- Medium fixture: up to 100 kbp and 2,000 features becomes usable within 3
  seconds; selection/search feedback is at most 100 ms p95; continuous map
  interaction sustains at least 30 frames per second p95.
- Large fixture: up to 1 Mbp and 20,000 features must not freeze or crash the UI.
  It may switch to a disclosed summarized/virtualized mode until a stronger
  renderer is justified.
- SVG or PNG export for the medium fixture completes within 5 seconds or returns
  a bounded, actionable error without losing view state.
- After 20 document switches and map remounts, event-listener, observer, and
  object-URL counts return to baseline; controlled post-GC heap must show no
  monotonic renderer leak.

If measurements do not meet a target, the product must narrow the declared
support envelope, add virtualization/worker isolation, or defer the affected
feature. It must not hide the failure behind a loading spinner with no bound.

The 10 kbp/750-feature boundary may not be widened until packaged measurements
cover load, selection, search, pan/zoom, export, heap growth, listener/observer
cleanup, 200% zoom, and repeated document switches. The current native
observation is supporting evidence only and is not release-performance closure.

## Export goals

- P0 formats: SVG and PNG map exports from the active CGView scene.
- P1 format: PDF/print review artifact after packaged font and pagination checks.
- Exported output reflects current topology disclosure, feature visibility,
  labels, selection policy, and color mode. A hidden layer must stay hidden.
- Prefer vector text and shapes; embed or package required fonts and avoid remote
  fetches. Bitmap exports declare dimensions and scale.
- Use stable sanitized filenames and attach artifact SHA-256, renderer/version,
  coordinate convention, visible layers, topology, export time, and review
  status through embedded metadata or a sibling JSON record.
- Export remains read-only. It does not modify the source `.proto`, compiled IR,
  run manifest, or review status.
- All output includes the required open-source attribution in the distribution;
  no SnapGene name, logo, watermark, or proprietary asset appears in Proto output.

## Primary public sources

- [SnapGene product features](https://www.snapgene.com/features)
- [SnapGene public introduction and Map/Sequence behavior](https://www.snapgene.com/guides/introduction-to-snapgene)
- [SnapGene public DNA display options](https://support.snapgene.com/hc/en-us/sections/10383749553044-Display-Options-for-DNA-Sequences)
- [SnapGene public search behavior](https://support.snapgene.com/hc/en-us/articles/10384006344852-Search-for-an-Enzyme-Feature-or-Primer)
- [SnapGene public map export behavior](https://support.snapgene.com/hc/en-us/articles/10384281303700-Export-a-DNA-RNA-or-Protein-Map-as-an-Image)
- [SnapGene public Viewer/full-product comparison](https://www.snapgene.com/snapgene-viewer)
- [CGView.js repository](https://github.com/sciguy/cgview-js) and [documentation](https://js.cgview.ca/docs.html)
- [SeqViz repository and API overview](https://github.com/Lattice-Automation/seqviz)
- [TeselaGen open-source monorepo](https://github.com/TeselaGen/tg-oss)
- [JBrowse 2 repository](https://github.com/GMOD/jbrowse-components) and [embedded-component documentation](https://jbrowse.org/jb2/docs/embedded_components/)
