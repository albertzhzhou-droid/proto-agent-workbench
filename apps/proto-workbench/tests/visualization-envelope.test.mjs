import assert from "node:assert/strict";
import test from "node:test";

import { classifyVisualizationEnvelope, VISUALIZATION_INTERACTIVE_LIMITS } from "../src/renderer/visualization-envelope.ts";

test("interactive envelope accepts its exact declared boundaries", () => {
  assert.deepEqual(classifyVisualizationEnvelope(
    VISUALIZATION_INTERACTIVE_LIMITS.maxBases,
    VISUALIZATION_INTERACTIVE_LIMITS.maxFeatures,
  ), { mode: "interactive", reasons: [] });
});

test("larger constructs use bounded windows and invalid constructs stay in summary mode", () => {
  const oversize = classifyVisualizationEnvelope(
    VISUALIZATION_INTERACTIVE_LIMITS.maxBases + 1,
    VISUALIZATION_INTERACTIVE_LIMITS.maxFeatures + 1,
  );
  assert.equal(oversize.mode, "windowed");
  assert.equal(oversize.reasons.length, 2);
  assert.equal(classifyVisualizationEnvelope(Number.NaN, -1).mode, "summary");
  assert.equal(classifyVisualizationEnvelope(1_000_000, 20_000).mode, "windowed");
  assert.equal(classifyVisualizationEnvelope(1_000_001, 20_000).mode, "summary");
});
