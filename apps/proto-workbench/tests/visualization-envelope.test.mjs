import assert from "node:assert/strict";
import test from "node:test";

import { classifyVisualizationEnvelope, VISUALIZATION_INTERACTIVE_LIMITS } from "../src/renderer/visualization-envelope.ts";

test("interactive envelope accepts its exact declared boundaries", () => {
  assert.deepEqual(classifyVisualizationEnvelope(
    VISUALIZATION_INTERACTIVE_LIMITS.maxBases,
    VISUALIZATION_INTERACTIVE_LIMITS.maxFeatures,
  ), { mode: "interactive", reasons: [] });
});

test("oversize and invalid constructs switch to an explicit summary mode", () => {
  const oversize = classifyVisualizationEnvelope(
    VISUALIZATION_INTERACTIVE_LIMITS.maxBases + 1,
    VISUALIZATION_INTERACTIVE_LIMITS.maxFeatures + 1,
  );
  assert.equal(oversize.mode, "summary");
  assert.equal(oversize.reasons.length, 2);
  assert.equal(classifyVisualizationEnvelope(Number.NaN, -1).mode, "summary");
});
