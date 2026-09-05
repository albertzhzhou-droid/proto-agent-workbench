import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const designsPageUrl = new URL("../src/renderer/DesignsPage.tsx", import.meta.url);
const cgviewMapUrl = new URL("../src/renderer/CgviewMap.tsx", import.meta.url);
const sequenceNavigatorUrl = new URL("../src/renderer/SequenceNavigator.tsx", import.meta.url);
const proteinSequenceViewUrl = new URL("../src/renderer/ProteinSequenceView.tsx", import.meta.url);
const proteinSequenceToolsUrl = new URL("../src/renderer/protein-sequence.ts", import.meta.url);
const appUrl = new URL("../src/renderer/App.tsx", import.meta.url);

test("Design Explorer discloses unknown topology and blocks mismatched-artifact exports", async () => {
  const source = await readFile(designsPageUrl, "utf8");
  const provenanceLoader = source.slice(source.indexOf("const loadProvenance"), source.indexOf("void mapWithConcurrency"));

  assert.match(source, /const topologyDisclosure = construct\.topology === "unknown" \? "unknown · circular view is a projection"/);
  assert.match(source, /Source topology:\s*<strong>\{topologyDisclosure\}<\/strong>/);
  assert.doesNotMatch(source, /linear \/ not explicitly declared/);
  assert.match(source, /const artifactIntegrityBlocked = selectedDocument\?\.digestBinding\?\.status === "mismatch"/);
  assert.match(source, /exportDisabled=\{Boolean\(exportingFormat\) \|\| viewerMode === "linear" \|\| governanceBlocked \|\| artifactIntegrityBlocked \|\| provenanceInventoryBlocked \|\| interactiveVisualizationBlocked \|\| scientificExportBlocked\}/);
  assert.match(source, /Map export is blocked because the artifact does not match its recorded digest\./g);
  assert.match(source, /interactiveVisualizationBlocked/);
  assert.match(source, /Bounded summary mode/);
  assert.match(source, /Map export is unavailable while this construct is in bounded summary mode\./g);
  assert.doesNotMatch(source, /\.slice\(0, 100\)/);
  assert.match(source, /mapWithConcurrency<InventoryCandidate, LoadedInventoryCandidate>\(inventoryCandidates, 8/);
  assert.match(source, /const isCurrentGeneration = \(\) => generation === loadGeneration\.current/);
  assert.doesNotMatch(source, /Promise\.all\(\[\s*mapWithConcurrency\(manifestCandidates/);
  assert.match(provenanceLoader, /Promise<DesignProvenanceInventoryCandidate>/);
  assert.match(provenanceLoader, /error: parsed\.error/);
  assert.match(provenanceLoader, /The provenance statement could not be read\./);
  assert.doesNotMatch(provenanceLoader, /return undefined/);
  assert.match(source, /summarizeDesignProvenanceInventory\(provenanceResults\)/);
  assert.match(source, /const provenanceInventoryBlocked = provenanceInventory\.status !== "complete"/);
  assert.match(source, /exportDisabled=\{Boolean\(exportingFormat\) \|\| viewerMode === "linear" \|\| governanceBlocked \|\| artifactIntegrityBlocked \|\| provenanceInventoryBlocked \|\| interactiveVisualizationBlocked \|\| scientificExportBlocked\}/);
  assert.match(source, /DNA_PART_GOVERNANCE_UNVERIFIED/);
  assert.match(source, /Governance unverified · export blocked/);
  assert.match(source, /PROVENANCE_INVENTORY_INCOMPLETE/);
  assert.equal((source.match(/Map export is blocked because the provenance inventory contains unreadable or invalid statements\./g) ?? []).length, 1);
  assert.match(source, /await workbenchApi\(\)\.visualization\.exportMap\(payload\)/);
  assert.match(source, /export failed closed/);
  assert.match(source, /independently reopened/);
});

test("constraints remain declared requirements rather than rendered validation successes", async () => {
  const source = await readFile(designsPageUrl, "utf8");
  const constraintRow = source.slice(source.indexOf("function ConstraintRow"), source.indexOf("function restrictionEnzymes"));

  assert.match(constraintRow, /<CircleAlert/);
  assert.match(constraintRow, /Declared requirement/);
  assert.doesNotMatch(constraintRow, /<CheckCircle2/);
});

test("CGView reports render failures and links arbitrary valid sequence ranges", async () => {
  const source = await readFile(cgviewMapUrl, "utf8");

  assert.match(source, /selectedRanges\?:/);
  assert.match(source, /for \(const selectedRange of selectedRanges \?\? \[\]\)/);
  assert.match(source, /toCgviewFeatureCoordinates\(\{ \.\.\.selectedRange, direction: 0 \}, construct\.length\)/);
  assert.match(source, /viewer\.canvas\.drawElement\(/);
  assert.match(source, /role="alert"/);
  assert.match(source, /keyboard-accessible ordered list and selection controls/);
  assert.match(source, /boundedMapLabel\(feature\.id\)/);
  assert.match(source, /showAnnotations && labelDensity !== "hidden"/);
  assert.match(source, /hiddenFeatureIndexes\?\.has\(index\)/);
  assert.match(source, /priorityMax: labelDensity === "dense" \? 160 : 48/);
  assert.match(source, /async exportSvg[\s\S]*catch \{[\s\S]*return undefined/);
  assert.match(source, /async exportPng[\s\S]*captureViewerPng\(viewer, filename\)[\s\S]*catch \{[\s\S]*return undefined/);
  assert.match(source, /viewer\.io\.download = \(data, _downloadFilename, mediaType\)/);
});

test("SeqViz failures expose a stable local diagnostic without rendering exception text", async () => {
  const source = await readFile(designsPageUrl, "utf8");
  assert.match(source, /SEQVIZ_RENDER_FAILED/);
  assert.match(source, /VisualizationErrorBoundary/);
});

test("the feature table preserves row semantics and a real keyboard-operable button", async () => {
  const source = await readFile(designsPageUrl, "utf8");

  assert.doesNotMatch(source, /<button[^>]+role="row"/);
  assert.match(source, /<div className=\{`parts-table-row[\s\S]*role="row"/);
  assert.match(source, /className="part-row-select"[\s\S]*aria-pressed=/);
  assert.match(source, /<VisualizationErrorBoundary[\s\S]*Sequence view unavailable/);
  assert.match(source, /aria-live="polite" aria-atomic="true">\{selectionAnnouncement\}/);
  assert.match(source, /aria-label="Feature inventory pages"/);
  assert.match(source, /visibleFeatureEntries\.map\(\(\{ feature, featureIndex, hidden \}\)/);
  assert.match(source, /useScientificComputation\("inventory", artifactIdentity, inventoryInput\)/);
  assert.match(source, /aria-label="Filter feature type"/);
  assert.match(source, /className="feature-row-visibility"/);
});

test("feature visibility, label density, and per-artifact preferences remain explicit and bounded", async () => {
  const [pageSource, mapSource, navigatorSource] = await Promise.all([
    readFile(designsPageUrl, "utf8"),
    readFile(cgviewMapUrl, "utf8"),
    readFile(sequenceNavigatorUrl, "utf8"),
  ]);

  assert.match(pageSource, /readDesignViewPreferences\(window\.localStorage, artifactSha256\)/);
  assert.match(pageSource, /writeDesignViewPreferences\(window\.localStorage, preferenceArtifactKey, preferences\)/);
  assert.match(pageSource, /Feature label density/);
  assert.match(pageSource, /Hide filtered/);
  assert.match(pageSource, /Show filtered/);
  assert.match(pageSource, /hidden && selectedFeatureIndex === featureIndex[\s\S]*setRangeSelection\(undefined\)/);
  assert.match(pageSource, /featureLabelDensity: effectiveLabelDensity/);
  assert.match(pageSource, /hiddenFeatureCount/);
  assert.match(pageSource, /const hiddenFeatureIndexes = useMemo\(/);
  assert.doesNotMatch(pageSource, /const hiddenFeatureIndexes = new Set/);
  assert.match(mapSource, /labelPlacement: labelDensity === "dense" \? "angled" : "default"/);
  assert.match(navigatorSource, /hiddenFeatureIndexes\?\.has\(featureIndex\)/);
});

test("primer and ORF layers remain explicit, direction-aware, and independently toggleable", async () => {
  const [pageSource, mapSource, navigatorSource] = await Promise.all([
    readFile(designsPageUrl, "utf8"),
    readFile(cgviewMapUrl, "utf8"),
    readFile(sequenceNavigatorUrl, "utf8"),
  ]);

  assert.match(pageSource, /feature\.type\.toLocaleLowerCase\(\) === "primer"/);
  assert.match(pageSource, /feature\.type\.toLocaleLowerCase\(\) === "orf"/);
  assert.match(pageSource, /Primer bindings/);
  assert.match(pageSource, /CDS \/ ORF translation/);
  assert.match(pageSource, /PRIMER_DIRECTION_UNKNOWN/);
  assert.match(pageSource, /ORF_DIRECTION_UNKNOWN/);
  assert.match(pageSource, /primers=\{primers\}/);
  assert.match(pageSource, /primerBindings: layers\.primers/);
  assert.match(pageSource, /exportReceipt\.renderedMapLayers\.primerBindings/);
  assert.match(mapSource, /showPrimers/);
  assert.match(navigatorSource, /showPrimers/);
  assert.doesNotMatch(pageSource, /primers=\{\[\]\}/);
});

test("protein visualization is integrity-bound, bounded, keyboard-readable, and supports range and overlapping motif processing", async () => {
  const [pageSource, proteinViewSource, proteinToolsSource] = await Promise.all([
    readFile(designsPageUrl, "utf8"),
    readFile(proteinSequenceViewUrl, "utf8"),
    readFile(proteinSequenceToolsUrl, "utf8"),
  ]);

  assert.match(pageSource, /recomputed sequence SHA-256 digests and enforced the governed identity, source, rights, eligibility, safety, evidence, organism, role, and derived-metric fields/);
  assert.match(proteinViewSource, /Search protein ID, name, source record, or sequence motif/);
  assert.match(proteinViewSource, /summaryMode \? "Collection overview" : "Full sequence available"/);
  assert.match(proteinViewSource, /aria-keyshortcuts="Home End PageUp PageDown"/);
  assert.match(proteinViewSource, /Validate and apply/);
  assert.match(proteinViewSource, /Selected sequence extract/);
  assert.match(proteinViewSource, /software-derived/);
  assert.match(proteinToolsSource, /\["source_record", protein\.source\.record_id/);
  assert.match(proteinToolsSource, /protein\.sequence\.indexOf\(sequenceNeedle, start \+ 1\)/);
  assert.match(proteinToolsSource, /maxRenderedResidues: 1_200/);
  assert.match(proteinToolsSource, /maxSearchMatches: 500/);
});

test("automatic ORF discovery stays bounded, optional, and visibly software-derived", async () => {
  const pageSource = await readFile(designsPageUrl, "utf8");
  const workerSource = await readFile(new URL("../src/renderer/design-scientific.ts", import.meta.url), "utf8");

  assert.match(pageSource, /Software ORF discovery/);
  assert.match(pageSource, /six frames · ATG to standard stop · software only/);
  assert.match(pageSource, /minimumAminoAcids: orfMinimumAminoAcids/);
  assert.match(workerSource, /maximumFeatures: available/);
  assert.match(workerSource, /VISUALIZATION_INTERACTIVE_LIMITS.maxFeatures - construct.features.length/);
  assert.match(pageSource, /source === "software"/);
  assert.match(pageSource, /uniqueTranslatableFeatures/);
  assert.match(pageSource, /overlapping source entr/);
  assert.match(pageSource, /Software-derived view feature/);
  assert.match(pageSource, /ORF_DISCOVERY_TRUNCATED/);
  assert.doesNotMatch(pageSource, /experimentally validated ORF/i);
});

test("circular view origin is explicitly non-mutating and preserves source coordinates", async () => {
  const [pageSource, mapSource, navigatorSource] = await Promise.all([
    readFile(designsPageUrl, "utf8"),
    readFile(cgviewMapUrl, "utf8"),
    readFile(sequenceNavigatorUrl, "utf8"),
  ]);

  assert.match(pageSource, /useScientificComputation\("view", artifactIdentity, viewInput\)/);
  assert.match(pageSource, /Circular view origin/);
  assert.match(pageSource, /Source base at \+1/);
  assert.match(pageSource, /View \+1 now maps to source base/);
  assert.match(pageSource, /display-only transform/);
  assert.match(pageSource, /mutatesSource: false/);
  assert.match(pageSource, /viewIntervalToSourceSegments/);
  assert.match(pageSource, /Source interval/);
  assert.match(pageSource, /normalizeSegmentedSequenceSelection/);
  assert.match(pageSource, /hit\.viewSegments\?\.length/);
  assert.match(pageSource, /selectedRanges=\{selectionSegments\}/);
  assert.doesNotMatch(pageSource, /const firstViewSegment = hit\.viewSegments\?\.\[0\]/);
  assert.match(mapSource, /View \+1 = source/);
  assert.match(navigatorSource, /source artifact is unchanged/);
  assert.doesNotMatch(pageSource, /files\.applyApprovedPatch[\s\S]*applyViewOrigin/);
});

test("GC skew is configurable, derived, export-traceable, and independently toggleable", async () => {
  const [pageSource, mapSource] = await Promise.all([
    readFile(designsPageUrl, "utf8"),
    readFile(cgviewMapUrl, "utf8"),
  ]);

  assert.match(pageSource, /GC skew plot/);
  assert.match(pageSource, /\(G-C\)\/\(G\+C\)/);
  assert.match(pageSource, /Sequence metric window/);
  assert.match(pageSource, /gcSkewPlot: layers\.gcSkew/);
  assert.match(pageSource, /gcWindowSize: effectiveGcWindowSize/);
  assert.match(mapSource, /const series = sequenceTracks\.gcSkew/);
  assert.doesNotMatch(mapSource, /calculateGc(?:Content|Skew)Series\(/);
  assert.match(mapSource, /source: "proto-gc-skew"/);
  assert.match(mapSource, /formula: "\(G-C\)\/\(G\+C\)"/);
  assert.match(mapSource, /G-rich GC skew/);
  assert.match(mapSource, /C-rich GC skew/);
});

test("DiffEditor uses stable retained models so route changes do not race model disposal", async () => {
  const source = await readFile(appUrl, "utf8");

  assert.match(source, /originalModelPath="inmemory:\/\/proto-workbench\/patch\/original\.proto"/);
  assert.match(source, /modifiedModelPath="inmemory:\/\/proto-workbench\/patch\/modified\.proto"/);
  assert.match(source, /keepCurrentOriginalModel/);
  assert.match(source, /keepCurrentModifiedModel/);
});
