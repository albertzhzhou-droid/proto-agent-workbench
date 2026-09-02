import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultVramBudget,
  expiredWarmModels,
  GIB,
  initialContext,
  retryContext,
  selectEvictions,
} from "../src/main/services/residency.ts";

const model = (id, estimatedVramBytes, pinned = false) => ({ id, estimatedVramBytes, pinned });
const instance = (modelId, state, lastUsedAt) => ({
  modelId,
  state,
  contextLength: 32768,
  gpuLayers: 999,
  lastUsedAt,
});

test("default VRAM budget leaves both percentage and fixed headroom", () => {
  assert.equal(defaultVramBudget(24 * GIB), 21.6 * GIB);
  assert.equal(defaultVramBudget(8 * GIB), 6 * GIB);
});

test("auto-evict chooses warm least-recently-used models before active ones", () => {
  const policy = {
    mode: "auto-evict",
    budgetBytes: 20 * GIB,
    warmTtlMinutes: 30,
    pinnedModelIds: [],
  };
  const models = [model("active", 10 * GIB), model("warm-old", 6 * GIB), model("warm-new", 5 * GIB)];
  const instances = [
    instance("active", "active", "2026-07-12T10:00:00Z"),
    instance("warm-old", "warm", "2026-07-12T08:00:00Z"),
    instance("warm-new", "warm", "2026-07-12T09:00:00Z"),
  ];
  assert.deepEqual(selectEvictions(models, instances, policy, 7 * GIB, "target"), ["warm-old", "warm-new"]);
});

test("pinned models are never selected for eviction", () => {
  const policy = {
    mode: "auto-evict",
    budgetBytes: 12 * GIB,
    warmTtlMinutes: 30,
    pinnedModelIds: ["active", "warm"],
  };
  const models = [model("active", 8 * GIB), model("warm", 6 * GIB, true)];
  const instances = [instance("active", "active", "2026-07-12T10:00:00Z"), instance("warm", "warm", "2026-07-12T08:00:00Z")];
  assert.deepEqual(selectEvictions(models, instances, policy, 4 * GIB, "target"), []);
});

test("an oversized target still evicts every eligible resident", () => {
  const policy = {
    mode: "auto-evict",
    budgetBytes: 12 * GIB,
    warmTtlMinutes: 30,
    pinnedModelIds: [],
  };
  const models = [model("warm", 4 * GIB)];
  const instances = [instance("warm", "warm", "2026-07-12T08:00:00Z")];
  assert.deepEqual(selectEvictions(models, instances, policy, 16 * GIB, "target"), ["warm"]);
});

test("warm TTL and OOM context retry are bounded", () => {
  const policy = { mode: "auto-evict", budgetBytes: 20 * GIB, warmTtlMinutes: 30, pinnedModelIds: [] };
  const now = Date.parse("2026-07-12T10:00:00Z");
  assert.deepEqual(
    expiredWarmModels(
      [
        instance("expired", "warm", "2026-07-12T09:20:00Z"),
        instance("fresh", "warm", "2026-07-12T09:45:00Z"),
      ],
      policy,
      now,
    ),
    ["expired"],
  );
  assert.equal(retryContext(131072), 65536);
  assert.equal(retryContext(2048), 2048);
  assert.equal(initialContext(1_048_576), 32_768);
  assert.equal(initialContext(16_384), 16_384);
});
