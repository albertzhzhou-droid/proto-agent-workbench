import assert from "node:assert/strict";
import test from "node:test";
import { embedSvgMetadata, metadataSidecarFilename } from "../src/renderer/map-export.ts";

const metadata = {
  schema: "proto-workbench.map-export.v1",
  exportedAt: "2026-08-30T00:00:00.000Z",
  format: "svg",
  designId: "<unsafe>&design",
  construct: "construct_a",
  artifactPath: "build/design.ir.json",
  artifactSha256: "a".repeat(64),
  digestStatus: "match",
  renderer: { name: "CGView.js", version: "1.8.2" },
  topology: { source: "unknown", rendered: "circular", projection: true },
  viewOrigin: { applied: true, sourceBaseOneBased: 11, mutatesSource: false },
  coordinates: "internal 0-based end-exclusive; display 1-based inclusive",
  renderedMapLayers: {
    partAnnotations: true,
    softwareOrfDiscovery: false,
    softwareOrfMinimumAminoAcids: null,
    coordinateRuler: false,
    gcContentPlot: true,
    gcSkewPlot: true,
    gcWindowSize: 51,
    featureLabelDensity: "balanced",
    hiddenFeatureCount: 1,
    selectionOverlay: false,
  },
  excludedUiOverlays: ["selection"],
  excludedSequenceLayers: ["complement", "restriction_sites", "translations"],
  reviewStatus: "human_review_required",
  dataMode: "desktop",
};

test("SVG export embeds escaped, machine-readable review metadata", () => {
  const exported = embedSvgMetadata('<svg xmlns="http://www.w3.org/2000/svg"><path /></svg>', metadata);

  assert.ok(exported);
  assert.match(exported, /<metadata id="proto-workbench-map-export">/);
  assert.match(exported, /&lt;unsafe&gt;&amp;design/);
  assert.doesNotMatch(exported, /<unsafe>/);
  assert.match(exported, /human_review_required/);
  assert.match(exported, /"projection":true/);
  assert.match(exported, /"viewOrigin":\{"applied":true,"sourceBaseOneBased":11,"mutatesSource":false\}/);
  assert.match(exported, /"coordinateRuler":false/);
  assert.match(exported, /"gcContentPlot":true/);
  assert.match(exported, /"gcSkewPlot":true/);
  assert.match(exported, /"gcWindowSize":51/);
  assert.match(exported, /"featureLabelDensity":"balanced"/);
  assert.match(exported, /"hiddenFeatureCount":1/);
  assert.match(exported, /"selectionOverlay":false/);
  assert.match(exported, /"excludedUiOverlays":\["selection"\]/);
  assert.match(exported, /"excludedSequenceLayers":\["complement","restriction_sites","translations"\]/);
});

test("SVG metadata injection fails closed without an SVG root", () => {
  assert.equal(embedSvgMetadata("not an svg", metadata), undefined);
});

test("PNG sidecar naming is stable", () => {
  assert.equal(metadataSidecarFilename("design-map.png"), "design-map.metadata.json");
  assert.equal(metadataSidecarFilename("design-map"), "design-map.metadata.json");
});
