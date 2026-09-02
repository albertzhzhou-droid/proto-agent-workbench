import assert from "node:assert/strict";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { embedSvgMetadata } from "../src/renderer/map-export.ts";
import {
  exportVerifiedMap,
  validatedMapCaptureScale,
  validateMapExportRequest,
} from "../src/main/services/map-export.ts";

const metadata = {
  schema: "proto-workbench.map-export.v1",
  exportedAt: "2026-08-31T12:00:00.000Z",
  format: "svg",
  designId: "toggle-switch",
  construct: "construct-a",
  artifactPath: "build/design.ir.json",
  artifactSha256: "a".repeat(64),
  digestStatus: "match",
  renderer: { name: "CGView.js", version: "1.8.2" },
  topology: { source: "circular", rendered: "circular", projection: false },
  viewOrigin: { applied: false, sourceBaseOneBased: 1, mutatesSource: false },
  coordinates: "internal 0-based end-exclusive; display 1-based inclusive",
  renderedMapLayers: {
    partAnnotations: true,
    softwareOrfDiscovery: false,
    softwareOrfMinimumAminoAcids: null,
    coordinateRuler: true,
    gcContentPlot: true,
    gcSkewPlot: false,
    gcWindowSize: 51,
    featureLabelDensity: "balanced",
    hiddenFeatureCount: 0,
    selectionOverlay: false,
  },
  excludedUiOverlays: ["selection"],
  excludedSequenceLayers: ["complement", "restriction_sites", "translations"],
  reviewStatus: "human_review_required",
  dataMode: "desktop",
};

test("verified SVG export is independently reopened, hashed, and published under build", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "proto-map-export-"));
  try {
    const svg = embedSvgMetadata('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="96"><rect width="128" height="96" fill="#fff"/><circle cx="64" cy="48" r="24" fill="#188977"/></svg>', metadata);
    assert.ok(svg);
    const request = {
      format: "svg",
      filename: "toggle-switch-map.svg",
      bytes: new TextEncoder().encode(svg),
      width: 128,
      height: 96,
      metadata,
    };
    let reopenedBytes;
    const receipt = await exportVerifiedMap(workspace, request, async (format, bytes, expected) => {
      reopenedBytes = Buffer.from(bytes);
      assert.equal(format, "svg");
      assert.deepEqual(expected, { width: 128, height: 96 });
      return {
        decoder: "chromium-isolated-image",
        width: 128,
        height: 96,
        pixelSha256: "b".repeat(64),
        sampledColorCount: 4,
      };
    }, {
      now: () => new Date("2026-08-31T12:01:02.003Z"),
      id: () => "abcdef123456",
    });

    assert.equal(receipt.status, "passed");
    assert.equal(receipt.decoder, "chromium-isolated-image");
    assert.match(receipt.relativePath, /^build\/visualization-exports\/toggle-switch-map-20260831T120102003Z-abcdef123456\.svg$/);
    assert.match(receipt.metadataRelativePath, /\.metadata\.json$/);
    assert.match(receipt.verificationRelativePath, /\.verification\.json$/);
    assert.deepEqual(reopenedBytes, Buffer.from(request.bytes));
    assert.deepEqual(await readFile(join(workspace, receipt.relativePath)), Buffer.from(request.bytes));
    const savedMetadata = JSON.parse(await readFile(join(workspace, receipt.metadataRelativePath), "utf8"));
    assert.deepEqual(savedMetadata, metadata);
    const savedReceipt = JSON.parse(await readFile(join(workspace, receipt.verificationRelativePath), "utf8"));
    assert.deepEqual(savedReceipt, receipt);
  } finally {
    assert.ok(resolve(workspace).startsWith(resolve(tmpdir())));
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SVG validation rejects external resources and metadata drift", () => {
  const withExternalReference = embedSvgMetadata('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="96"><image href="https://example.invalid/map.png"/></svg>', metadata);
  assert.ok(withExternalReference);
  assert.throws(() => validateMapExportRequest({
    format: "svg",
    filename: "map.svg",
    bytes: new TextEncoder().encode(withExternalReference),
    width: 128,
    height: 96,
    metadata,
  }), /non-fragment resource reference/);

  const validSvg = embedSvgMetadata('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="96"><path d="M0 0L10 10"/></svg>', metadata);
  assert.ok(validSvg);
  assert.throws(() => validateMapExportRequest({
    format: "svg",
    filename: "map.svg",
    bytes: new TextEncoder().encode(validSvg),
    width: 128,
    height: 96,
    metadata: { ...metadata, construct: "changed-after-render" },
  }), /does not match/);
});

test("PNG validation binds the declared dimensions before decoding", () => {
  const png = minimalPngHeader(128, 96);
  const pngMetadata = { ...metadata, format: "png" };
  assert.doesNotThrow(() => validateMapExportRequest({
    format: "png",
    filename: "map.png",
    bytes: png,
    width: 128,
    height: 96,
    metadata: pngMetadata,
  }));
  assert.throws(() => validateMapExportRequest({
    format: "png",
    filename: "map.png",
    bytes: png,
    width: 127,
    height: 96,
    metadata: pngMetadata,
  }), /declares 128x96/);
});

test("SVG capture verification normalizes only bounded uniform device scale factors", () => {
  assert.equal(validatedMapCaptureScale({ width: 303, height: 280 }, { width: 303, height: 280 }), 1);
  assert.equal(validatedMapCaptureScale({ width: 606, height: 560 }, { width: 303, height: 280 }), 2);
  assert.ok(Math.abs(validatedMapCaptureScale({ width: 379, height: 350 }, { width: 303, height: 280 }) - 1.25) < 0.01);
  assert.throws(
    () => validatedMapCaptureScale({ width: 606, height: 300 }, { width: 303, height: 280 }),
    /logical pixels/,
  );
  assert.throws(
    () => validatedMapCaptureScale({ width: 1_516, height: 1_400 }, { width: 303, height: 280 }),
    /logical pixels/,
  );
});

function minimalPngHeader(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}
