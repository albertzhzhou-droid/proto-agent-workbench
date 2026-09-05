import test from "node:test";
import assert from "node:assert/strict";
import {withWorkspaceWrite, withReadSlot} from "../src/main/services/workspace-execution-queue.ts";
const deferred = () => {let resolve; const promise = new Promise(r => resolve = r); return {promise, resolve};};

test("workspace writes remain serialized through validation and queued cancellation releases no foreign work", async () => {
  const gate = deferred(), started = deferred(), order = [], abort = new AbortController();
  const first = withWorkspaceWrite("controlled-queue-workspace", undefined, async () => {order.push("first-start"); started.resolve(); await gate.promise; order.push("first-validated");});
  await started.promise;
  const cancelled = withWorkspaceWrite("controlled-queue-workspace", abort.signal, async () => order.push("unexpected-write"));
  const cancelledResult = assert.rejects(cancelled, /cancelled/);
  const second = withWorkspaceWrite("controlled-queue-workspace", undefined, async () => order.push("second"));
  abort.abort(new Error("cancelled"));
  await cancelledResult;
  assert.deepEqual(order, ["first-start"]);
  gate.resolve(); await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-validated", "second"]);
});

test("different workspaces progress independently and read concurrency is capped at three", async () => {
  const gate = deferred(), started = deferred(); let active = 0, maximum = 0, count = 0;
  const operations = Array.from({length: 7}, () => withReadSlot(undefined, async () => {active++; maximum = Math.max(maximum, active); if (++count === 3) started.resolve(); await gate.promise; active--;}));
  await started.promise; assert.equal(maximum, 3); assert.equal(count, 3);
  let independent = false;
  await withWorkspaceWrite("different-workspace", undefined, async () => {independent = true;});
  assert.equal(independent, true); gate.resolve(); await Promise.all(operations); assert.equal(maximum, 3);
});
