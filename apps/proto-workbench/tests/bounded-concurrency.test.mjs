import assert from "node:assert/strict";
import test from "node:test";

import {
  BoundedConcurrencyCancelledError,
  mapWithConcurrency,
} from "../src/renderer/bounded-concurrency.ts";

test("bounded mapping preserves order and never exceeds the shared concurrency ceiling", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency(Array.from({ length: 24 }, (_, index) => index), 8, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, value % 3));
    active -= 1;
    return value * 2;
  });

  assert.ok(peak <= 8);
  assert.deepEqual(results, Array.from({ length: 24 }, (_, index) => index * 2));
});

test("cooperative cancellation lets active work finish without dispatching the remaining queue", async () => {
  let continueDispatch = true;
  let started = 0;
  let completed = 0;
  const pending = mapWithConcurrency(Array.from({ length: 40 }, (_, index) => index), 4, async (value) => {
    started += 1;
    if (started === 4) continueDispatch = false;
    await Promise.resolve();
    completed += 1;
    return value;
  }, () => continueDispatch);

  await assert.rejects(pending, BoundedConcurrencyCancelledError);
  assert.equal(started, 4);
  assert.equal(completed, 4);
});

test("empty work remains a successful bounded operation", async () => {
  assert.deepEqual(await mapWithConcurrency([], 8, async (value) => value), []);
});
