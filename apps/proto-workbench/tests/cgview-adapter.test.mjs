import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  CGVIEW_POPOVERS_ENABLED,
  toCgviewFeatureCoordinates,
  toCgviewFeatureGeometry,
} from "../src/renderer/cgview-adapter.ts";

test("converts zero-based end-exclusive intervals to one-based inclusive CGView coordinates", () => {
  assert.deepEqual(
    toCgviewFeatureCoordinates({ start: 0, end: 1, direction: 1 }, 24),
    { start: 1, stop: 1, strand: 1 },
  );
  assert.deepEqual(
    toCgviewFeatureCoordinates({ start: 12, end: 24, direction: -1 }, 24),
    { start: 13, stop: 24, strand: -1 },
  );
});

test("preserves logical multi-location features for CGView, including circular origin traversal", () => {
  assert.deepEqual(
    toCgviewFeatureGeometry([{ start: 18, end: 24 }, { start: 0, end: 4 }], -1, 24),
    { locations: [[19, 24], [1, 4]], strand: -1 },
  );
  assert.deepEqual(
    toCgviewFeatureGeometry([{ start: 2, end: 5 }, { start: 9, end: 12 }], 0, 24),
    { locations: [[3, 5], [10, 12]] },
  );
});

test("rejects an invalid segment instead of partially rendering a logical feature", () => {
  assert.equal(toCgviewFeatureGeometry([], 1, 24), undefined);
  assert.equal(toCgviewFeatureGeometry([{ start: 2, end: 5 }, { start: 12, end: 25 }], 1, 24), undefined);
  assert.equal(toCgviewFeatureGeometry([{ start: 2, end: 5 }], 2, 24), undefined);
});

test("uses construct-local coordinates rather than design-global offsets", () => {
  const partInSecondConstruct = {
    start: 0,
    end: 16,
    designStart: 52,
    designEnd: 68,
    direction: 1,
  };

  assert.deepEqual(
    toCgviewFeatureCoordinates(partInSecondConstruct, 56),
    { start: 1, stop: 16, strand: 1 },
  );
});

test("keeps unknown direction unknown and rejects invalid intervals", () => {
  assert.deepEqual(
    toCgviewFeatureCoordinates({ start: 4, end: 9, direction: 0 }, 20),
    { start: 5, stop: 9 },
  );
  assert.equal(toCgviewFeatureCoordinates({ start: -1, end: 2, direction: 1 }, 20), undefined);
  assert.equal(toCgviewFeatureCoordinates({ start: 2, end: 2, direction: 1 }, 20), undefined);
  assert.equal(toCgviewFeatureCoordinates({ start: 2, end: 21, direction: 1 }, 20), undefined);
});

test("CGView integration keeps popovers disabled and does not introduce an HTML sink", async () => {
  const [mapSource, navigatorSource, pageSource] = await Promise.all([
    readFile(resolve("src", "renderer", "CgviewMap.tsx"), "utf8"),
    readFile(resolve("src", "renderer", "SequenceNavigator.tsx"), "utf8"),
    readFile(resolve("src", "renderer", "DesignsPage.tsx"), "utf8"),
  ]);
  const popoverPolicyReferences = `${mapSource}\n${navigatorSource}`.match(/popovers:\s*CGVIEW_POPOVERS_ENABLED/g) ?? [];

  assert.equal(CGVIEW_POPOVERS_ENABLED, false);
  assert.equal(popoverPolicyReferences.length, 8);
  assert.doesNotMatch(`${mapSource}\n${navigatorSource}`, /popovers:\s*true/);
  assert.doesNotMatch(`${mapSource}\n${navigatorSource}\n${pageSource}`, /dangerouslySetInnerHTML/);
});

test("linear CGView renderers switch format only after sequence-backed initialization", async () => {
  const [mapSource, navigatorSource] = await Promise.all([
    readFile(resolve("src", "renderer", "CgviewMap.tsx"), "utf8"),
    readFile(resolve("src", "renderer", "SequenceNavigator.tsx"), "utf8"),
  ]);

  assert.match(mapSource, /format:\s*"circular"/);
  assert.match(mapSource, /if \(mapFormat === "linear"\).*\.format = "linear"/);
  assert.match(navigatorSource, /format:\s*"circular"/);
  assert.match(navigatorSource, /\.format = "linear"/);
  assert.doesNotMatch(`${mapSource}\n${navigatorSource}`, /format:\s*mapFormat/);
});

test("map export feedback keeps a stable layout before and after the first receipt", async () => {
  const [pageSource, styles] = await Promise.all([
    readFile(resolve("src", "renderer", "DesignsPage.tsx"), "utf8"),
    readFile(resolve("src", "renderer", "styles.css"), "utf8"),
  ]);

  assert.match(pageSource, /No map exported in this session/);
  assert.match(pageSource, /SVG and PNG receive a success receipt only after an independent reopen check\./);
  assert.match(pageSource, /exportReceipt\s*\?[\s\S]*?:\s*exportFailure\s*\?[\s\S]*?map-export-receipt is-idle/);
  assert.match(styles, /\.map-export-receipt\.is-idle/);
});
