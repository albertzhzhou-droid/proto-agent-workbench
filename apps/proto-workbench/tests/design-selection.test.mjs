import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSegmentedSequenceSelection, normalizeSequenceSelection } from "../src/renderer/design-selection.ts";

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

test("preserves both view and canonical source segments for a circular-origin search hit", () => {
  assert.deepEqual(
    normalizeSegmentedSequenceSelection(
      [{ start: 50, end: 52 }, { start: 0, end: 4 }],
      52,
      [{ start: 8, end: 14 }],
    ),
    {
      start: 50,
      end: 52,
      segments: [{ start: 50, end: 52 }, { start: 0, end: 4 }],
      sourceSegments: [{ start: 8, end: 14 }],
    },
  );
  assert.equal(normalizeSegmentedSequenceSelection([{ start: 50, end: 53 }], 52), undefined);
  assert.equal(normalizeSegmentedSequenceSelection([{ start: 50, end: 52 }, { start: 0, end: 4 }], 52, [{ start: 8, end: 13 }]), undefined);
});
