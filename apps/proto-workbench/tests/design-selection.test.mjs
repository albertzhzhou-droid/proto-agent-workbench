import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSequenceSelection } from "../src/renderer/design-selection.ts";

test("normalizes forward and reverse drags to the same canonical interval", () => {
  assert.deepEqual(normalizeSequenceSelection({ start: 4, end: 12, viewer: "LINEAR" }, 20), { start: 4, end: 12, viewer: "LINEAR" });
  assert.deepEqual(normalizeSequenceSelection({ start: 12, end: 4, viewer: "LINEAR" }, 20), { start: 4, end: 12, viewer: "LINEAR" });
});

test("rejects empty, non-integer, and out-of-bounds selections", () => {
  assert.equal(normalizeSequenceSelection({ start: 4, end: 4 }, 20), undefined);
  assert.equal(normalizeSequenceSelection({ start: 1.5, end: 4 }, 20), undefined);
  assert.equal(normalizeSequenceSelection({ start: -1, end: 4 }, 20), undefined);
  assert.equal(normalizeSequenceSelection({ start: 1, end: 21 }, 20), undefined);
});
