import assert from "node:assert/strict";
import test from "node:test";
import {
  DESIGN_VIEW_PREFERENCES_STORAGE_KEY,
  MAX_SAVED_DESIGN_VIEW_PREFERENCES,
  readDesignViewPreferences,
  writeDesignViewPreferences,
} from "../src/renderer/design-view-preferences.ts";

const sha = (digit) => digit.repeat(64);

test("design view preferences round trip by artifact digest without source mutation state", () => {
  const storage = memoryStorage();
  const preferences = validPreferences();
  assert.equal(writeDesignViewPreferences(storage, sha("a"), preferences, new Date("2026-08-31T20:00:00Z")), true);
  assert.deepEqual(readDesignViewPreferences(storage, sha("a")), preferences);
  assert.equal("selection" in preferences, false);
  assert.equal("sourceSequence" in preferences, false);
});

test("malformed, oversized, and ambiguous preference records fail closed", () => {
  const storage = memoryStorage();
  storage.setItem(DESIGN_VIEW_PREFERENCES_STORAGE_KEY, "{bad json");
  assert.equal(readDesignViewPreferences(storage, sha("b")), undefined);
  assert.equal(writeDesignViewPreferences(storage, "not-a-digest", validPreferences()), false);
  assert.equal(writeDesignViewPreferences(storage, sha("b"), { ...validPreferences(), gcWindowSize: 12 }), false);

  storage.setItem(DESIGN_VIEW_PREFERENCES_STORAGE_KEY, JSON.stringify({
    schema: DESIGN_VIEW_PREFERENCES_STORAGE_KEY,
    entries: [{ artifactSha256: sha("b"), savedAt: new Date().toISOString(), preferences: { ...validPreferences(), viewOrigins: { 0: -1 } } }],
  }));
  assert.equal(readDesignViewPreferences(storage, sha("b")), undefined);
});

test("preference storage is bounded and replaces the newest artifact entry", () => {
  const storage = memoryStorage();
  const digests = "abcdef0123456789".repeat(3).split("");
  for (let index = 0; index < MAX_SAVED_DESIGN_VIEW_PREFERENCES + 4; index += 1) {
    const digest = `${index.toString(16).padStart(64, "0")}`;
    assert.equal(writeDesignViewPreferences(storage, digest, { ...validPreferences(), linearZoom: 20 + (index % 41) * 2 }), true);
  }
  const envelope = JSON.parse(storage.getItem(DESIGN_VIEW_PREFERENCES_STORAGE_KEY));
  assert.equal(envelope.entries.length, MAX_SAVED_DESIGN_VIEW_PREFERENCES);
  assert.equal(envelope.entries[0].artifactSha256, (MAX_SAVED_DESIGN_VIEW_PREFERENCES + 3).toString(16).padStart(64, "0"));
  assert.equal(digests.length > 0, true);
});

function validPreferences() {
  return {
    viewerMode: "both",
    selectedConstructIndex: 0,
    layers: {
      annotations: true,
      complement: true,
      discoveredOrfs: false,
      gcContent: true,
      gcSkew: false,
      index: true,
      primers: true,
      restrictionSites: true,
      translations: true,
    },
    labelDensity: "auto",
    linearZoom: 62,
    gcWindowSize: 21,
    orfMinimumAminoAcids: 30,
    viewOrigins: { 0: 4 },
    hiddenFeatureIndexesByConstruct: { 0: [1, 2] },
    inventory: {
      query: "promoter",
      type: "all",
      source: "all",
      sortKey: "coordinate",
      sortDirection: "asc",
    },
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}
