import assert from "node:assert/strict";
import test from "node:test";

import { calculateGcContentSeries, calculateGcSkewSeries } from "../src/renderer/sequence-metrics.ts";

test("GC content series is bounded, one-based, and preserves the global baseline", () => {
  const result = calculateGcContentSeries("GGCCAAAA", false, 4);

  assert.equal(result.positions[0], 1);
  assert.equal(result.positions.at(-1), 8);
  assert.ok(result.positions.length <= 4);
  assert.equal(result.positions.length, result.scores.length);
  assert.equal(result.baseline, 0.5);
  assert.ok(result.scores.every((score) => score >= 0 && score <= 1));
});

test("downsampling includes a freshly calculated terminal window without exceeding maxPoints", () => {
  const result = calculateGcContentSeries("AAAAAAGG", false, 4);

  assert.deepEqual(result.positions, [1, 3, 6, 8]);
  assert.equal(result.positions.length, 4);
  assert.equal(result.scores.at(-1), 1);
});

test("circular windows wrap across the origin while linear windows clamp", () => {
  const linear = calculateGcContentSeries("GAAAAG", false, 6);
  const circular = calculateGcContentSeries("GAAAAG", true, 6);

  assert.ok(circular.scores[0] > linear.scores[0]);
  assert.equal(circular.windowSize, linear.windowSize);
});

test("empty input is explicit and invalid point budgets fail closed", () => {
  assert.deepEqual(calculateGcContentSeries("", false), { positions: [], scores: [], baseline: 0, windowSize: 0 });
  assert.throws(() => calculateGcContentSeries("ATGC", false, 1), /maxPoints/);
});

test("GC skew distinguishes G-rich, C-rich, and neutral windows", () => {
  const result = calculateGcSkewSeries("GGGAAACCC", false, 9, 3);

  assert.equal(result.positions[0], 1);
  assert.equal(result.positions.at(-1), 9);
  assert.equal(result.windowSize, 3);
  assert.equal(result.baseline, 0);
  assert.equal(result.overallSkew, 0);
  assert.ok(result.scores[0] > 0);
  assert.equal(result.scores[4], 0);
  assert.ok(result.scores.at(-1) < 0);
  assert.ok(result.scores.every((score) => score >= -1 && score <= 1));
});

test("GC metric windows are configurable, bounded, and reject ambiguous sizes", () => {
  const content = calculateGcContentSeries("GGGGCCCCAA", false, 10, 101);
  const skew = calculateGcSkewSeries("GGGGCCCCAA", false, 10, 101);

  assert.equal(content.windowSize, 9);
  assert.equal(skew.windowSize, 9);
  assert.deepEqual(content.positions, skew.positions);
  assert.deepEqual(calculateGcSkewSeries("", false), { positions: [], scores: [], baseline: 0, overallSkew: 0, windowSize: 0 });
  assert.throws(() => calculateGcSkewSeries("ATGC", false, 1), /maxPoints/);
  assert.throws(() => calculateGcSkewSeries("ATGC", false, 96, 10), /positive odd integer/);
});
